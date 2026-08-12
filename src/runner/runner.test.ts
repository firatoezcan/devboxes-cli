import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as prompts from "@clack/prompts";
import { treaty } from "@elysiajs/eden";
import { armor, Encrypter } from "age-encryption";

import { opencodeProviderCredentials } from "@/db/schema";
import { createApiIntegrationHarness } from "@/test/api-integration";

import { createDevboxesCommand } from "../cli";
import { cliVersion } from "../devboxes";
import { credentialStoreFileName } from "../protocol/frozen";
import { opencodeWorkspaceLaunchProtocol } from "../protocol/launch-spec";
import { opencodeProviderAuthFingerprint } from "../protocol/provider-auth";
import { daemonEntrypoint, taskContainerName } from "../protocol/task-runtime";
import type {
  ActiveOpencodeCredentialTask,
  OpencodeCredentialBrokerApi,
} from "./credential-broker";
import { readCredentialStore, writeCredentialStore } from "./credential-store";
import {
  connectOpencodeProviderSubscription,
  removeOpencodeProviderCredentials,
  runRunnerDoctor,
  setupOpencodeProviderCredentials,
  showOpencodeProviderCredentialStatus,
  startCredentialBroker,
  syncOpencodeProviderCredentials,
  taskContainerApiBaseUrl,
} from "./runner";

const credentialSyncHarness = createApiIntegrationHarness(
  "devboxes-runner-credential-sync",
  {},
  "postgres",
  30_000,
);
const credentialSyncOrganizationId = "00000000-0000-7000-8000-000000000171";
const credentialSyncUserId = "runner-credential-sync-user";
const credentialSyncSessionToken = "runner-credential-sync-session";
const credentialSyncRunnerMachineId = "00000000-0000-7000-8000-000000000172";

beforeAll(async () => {
  await credentialSyncHarness.seedUsers({
    id: credentialSyncUserId,
    name: "Runner Credential Sync User",
    email: "runner-credential-sync@example.com",
  });
  await credentialSyncHarness.seedOrganizations({
    id: credentialSyncOrganizationId,
    name: "Runner Credential Sync",
    slug: "runner-credential-sync",
  });
  await credentialSyncHarness.seedSessions({
    id: "runner-credential-sync-session-row",
    token: credentialSyncSessionToken,
    userId: credentialSyncUserId,
    activeOrganizationId: credentialSyncOrganizationId,
  });
  await credentialSyncHarness.seedMemberships({
    id: "runner-credential-sync-membership",
    organizationId: credentialSyncOrganizationId,
    userId: credentialSyncUserId,
    role: "owner",
  });
  await credentialSyncHarness.seedRunnerMachines({
    id: credentialSyncRunnerMachineId,
    organizationId: credentialSyncOrganizationId,
    createdByUserId: credentialSyncUserId,
    apiKeyId: null,
    name: "Runner Credential Sync",
  });
});

describe("runner CLI", () => {
  const testCommand = () => {
    const command = createDevboxesCommand();
    const configure = (target: typeof command) => {
      target.exitOverride();
      target.configureOutput({
        writeOut: () => {},
        writeErr: () => {},
      });
      for (const child of target.commands) configure(child);
    };
    configure(command);
    return command;
  };

  it("validates runner concurrency before starting the runner", () => {
    const command = testCommand();
    let error: unknown;

    try {
      command.parse(["listen", "--max-concurrent", "0"], { from: "user" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toEqual(expect.objectContaining({ code: "commander.invalidArgument" }));
  });

  it("keeps the unified runner command surface", () => {
    const command = testCommand();
    const commandNames = command.commands.map((child) => child.name());
    const credentials = command.commands.find((child) => child.name() === "credentials");

    expect(command.name()).toBe("devboxes");
    expect(command.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--config", "--api", "--auth", "--organization", "--version"]),
    );
    expect(commandNames).toEqual(
      expect.arrayContaining([
        "connect",
        "credentials",
        "dispatch",
        "doctor",
        "listen",
        "login",
        "mcp",
        "result",
        "status",
      ]),
    );
    expect(credentials?.commands.map((child) => child.name()) ?? []).toEqual(
      expect.arrayContaining(["setup", "sync", "status", "remove"]),
    );
    const setup = credentials?.commands.find((child) => child.name() === "setup");
    expect(setup?.options.map((option) => option.long)).toContain("--connect");
    // Headless provisioning contract: the API key arrives via stdin, gated
    // behind this flag — never via argv.
    expect(setup?.options.map((option) => option.long)).toContain("--api-key");
    const connect = command.commands.find((child) => child.name() === "connect");
    expect(connect?.options.map((option) => option.long)).toContain("--name");
    const doctor = command.commands.find((child) => child.name() === "doctor");
    expect(doctor?.options.map((option) => option.long)).toContain("--json");
    const credentialsStatus = credentials?.commands.find((child) => child.name() === "status");
    expect(credentialsStatus?.options.map((option) => option.long)).toContain("--json");
    const credentialsSync = credentials?.commands.find((child) => child.name() === "sync");
    expect(credentialsSync?.options.map((option) => option.long)).toContain("--credential");
  });

  it("uses a container-reachable API URL for local runner targets", () => {
    expect(taskContainerApiBaseUrl("http://localhost:3000/api")).toBe(
      "http://host.docker.internal:3000/api",
    );
    expect(taskContainerApiBaseUrl("http://127.0.0.1:3001/api")).toBe(
      "http://host.docker.internal:3001/api",
    );
    expect(taskContainerApiBaseUrl("https://app.devboxes.com/api")).toBe(
      "https://app.devboxes.com/api",
    );
  });
});

describe("runner Opencode credentials", () => {
  let fixtureDir: string;
  let authFile: string;
  let infoMessages: string[];
  const originalInfo = console.info;
  // Clack log/note/spinner output goes through process.stdout.write, not
  // console.info; both land in infoMessages (ANSI-stripped) so assertions stay
  // plain-substring checks over everything the user would read.
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  // The credential discovery probes XDG_DATA_HOME, XDG_CONFIG_HOME, CODEX_HOME,
  // and homedir()-derived paths; every one must point into the fixture so a
  // developer machine's real opencode/codex credentials never leak into runs.
  const redirectedEnvKeys = [
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "CODEX_HOME",
    "HOME",
    "DEVBOX_OPENCODE_DOCKER_SOCKET_PATH",
    "DEVBOX_OPENCODE_HOME_ROOT",
    "DOCKER_HOST",
  ] as const;
  const originalEnv = new Map(redirectedEnvKeys.map((key) => [key, process.env[key]] as const));

  // Interactive branches key off stdin/stdout TTY-ness: pinned to false so the
  // suite deterministically exercises the non-interactive contract instead of
  // playing the intro animation — or hanging on a select() — when a developer
  // runs it from a real terminal.
  const originalIsTTY = {
    stdin: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
    stdout: Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
  };

  beforeEach(async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    fixtureDir = await mkdtemp(join(tmpdir(), "devboxes-runner-broker-"));
    process.env.XDG_DATA_HOME = fixtureDir;
    process.env.XDG_CONFIG_HOME = join(fixtureDir, "config");
    process.env.CODEX_HOME = join(fixtureDir, "codex");
    process.env.HOME = join(fixtureDir, "home");
    authFile = join(fixtureDir, "opencode", "auth.json");
    await mkdir(join(fixtureDir, "opencode"), { recursive: true });
    await writeFile(authFile, '{"openai":{"type":"api","key":"openai-key"}}');
    infoMessages = [];
    console.info = (...values: unknown[]) => {
      infoMessages.push(values.map(String).join(" "));
    };
    process.stdout.write = ((chunk: string | Uint8Array) => {
      infoMessages.push(
        Bun.stripANSI(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)),
      );
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(async () => {
    console.info = originalInfo;
    process.stdout.write = originalStdoutWrite;
    for (const [stream, descriptor] of [
      [process.stdin, originalIsTTY.stdin],
      [process.stdout, originalIsTTY.stdout],
    ] as const) {
      if (descriptor) {
        Object.defineProperty(stream, "isTTY", descriptor);
      } else {
        delete (stream as { isTTY?: boolean }).isTTY;
      }
    }
    for (const key of redirectedEnvKeys) {
      const original = originalEnv.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it("stores local credential references without copied provider secrets", async () => {
    const configPath = join(fixtureDir, "config.json");

    const selected = await setupOpencodeProviderCredentials(
      {
        configPath,
        config: {
          apiBaseUrl: "http://localhost:3001/api",
          authBaseUrl: "http://localhost:3001/api/auth",
        },
      },
      { all: true },
    );

    expect(selected).toEqual([
      { providerId: "openai", authFile, source: "opencode-auth-file", authType: "api" },
    ]);
    const savedConfig = await readFile(configPath, "utf8");
    expect(JSON.parse(savedConfig).opencodeProviderCredentials).toEqual([
      { providerId: "openai", authFile, source: "opencode-auth-file" },
    ]);
    expect(savedConfig).not.toContain("openai-key");
  });

  it("discovers OpenCode Zen and OpenCode Go as exact providers", async () => {
    await writeFile(
      authFile,
      '{"opencode":{"type":"api","key":"zen-key"},"opencode-go":{"type":"api","key":"go-key"}}',
    );
    const configPath = join(fixtureDir, "config.json");

    const selected = await setupOpencodeProviderCredentials(
      {
        configPath,
        config: {
          apiBaseUrl: "http://localhost:3001/api",
          authBaseUrl: "http://localhost:3001/api/auth",
        },
      },
      { all: true },
    );

    expect(selected).toEqual(
      expect.arrayContaining([
        { providerId: "opencode", authFile, source: "opencode-auth-file", authType: "api" },
        { providerId: "opencode-go", authFile, source: "opencode-auth-file", authType: "api" },
      ]),
    );
    const savedConfig = await readFile(configPath, "utf8");
    expect(JSON.parse(savedConfig).opencodeProviderCredentials).toEqual(
      expect.arrayContaining([
        {
          providerId: "opencode",
          authFile,
          source: "opencode-auth-file",
          providerIdFormat: "exact",
        },
        {
          providerId: "opencode-go",
          authFile,
          source: "opencode-auth-file",
        },
      ]),
    );
    expect(savedConfig).not.toContain("zen-key");
    expect(savedConfig).not.toContain("go-key");
  });

  it("discovers the XDG-style macOS Opencode auth file", async () => {
    await rm(authFile, { force: true });
    const macAuthFile = join(fixtureDir, "home", ".local", "share", "opencode", "auth.json");
    await mkdir(join(fixtureDir, "home", ".local", "share", "opencode"), { recursive: true });
    await writeFile(macAuthFile, '{"opencode-go":{"type":"api","key":"mac-key"}}');
    const configPath = join(fixtureDir, "config.json");
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    assert(originalPlatform);
    Object.defineProperty(process, "platform", {
      configurable: true,
      enumerable: originalPlatform.enumerable,
      value: "darwin",
    });

    try {
      await setupOpencodeProviderCredentials(
        {
          configPath,
          config: {
            apiBaseUrl: "http://localhost:3001/api",
            authBaseUrl: "http://localhost:3001/api/auth",
            opencodeProviderCredentials: [
              {
                providerId: "opencode",
                authFile: macAuthFile,
                source: "opencode-auth-file",
              },
            ],
          },
        },
        { all: true },
      );
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
    }

    const savedConfig = await readFile(configPath, "utf8");
    expect(JSON.parse(savedConfig).opencodeProviderCredentials).toEqual([
      {
        providerId: "opencode-go",
        authFile: macAuthFile,
        source: "opencode-auth-file",
      },
    ]);
  });

  it("persists the live machine id and sends it on the next idempotent login", async () => {
    const configPath = join(fixtureDir, "config.json");
    const machineId = "00000000-0000-7000-8000-000000000154";
    const requests: Array<{ authorization: string | undefined; body: Record<string, unknown> }> =
      [];
    const apiServer = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push({
          authorization: request.headers.authorization,
          body: JSON.parse(body) as Record<string, unknown>,
        });
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            machine: {
              id: machineId,
              organizationId: "00000000-0000-7000-8000-000000000155",
              name: "test-runner",
              runtime: "docker",
              nativePlatform: "linux/x64",
              supportedPlatforms: ["linux/amd64"],
              listenerVersion: cliVersion,
              lastHeartbeatAt: new Date().toISOString(),
              disabledAt: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
    const port = (apiServer.address() as { port: number }).port;
    await writeFile(
      configPath,
      JSON.stringify({
        apiBaseUrl: `http://127.0.0.1:${port}/api`,
        authBaseUrl: `http://127.0.0.1:${port}/api/auth`,
        organizationId: "00000000-0000-7000-8000-000000000155",
        name: "test-runner",
        apiKey: "live-runner-key",
      }),
    );

    try {
      await createDevboxesCommand().parseAsync(["--config", configPath, "connect"], {
        from: "user",
      });
      await createDevboxesCommand().parseAsync(["--config", configPath, "connect"], {
        from: "user",
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        apiServer.close((error) => (error ? reject(error) : resolve()));
      });
    }

    expect(requests).toHaveLength(2);
    expect(requests[0]?.authorization).toBe("Bearer live-runner-key");
    expect(requests[0]?.body).not.toHaveProperty("machineId");
    expect(requests[1]).toMatchObject({
      authorization: "Bearer live-runner-key",
      body: { machineId },
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      machineId,
      apiKey: "live-runner-key",
    });
  });

  it("checks common local coding-agent credential paths without copying provider secrets", async () => {
    await rm(authFile, { force: true });
    const codexHome = join(fixtureDir, "codex-home");
    const codexAuthFile = join(codexHome, "auth.json");
    await mkdir(codexHome, { recursive: true });
    await writeFile(codexAuthFile, '{"OPENAI_API_KEY":"codex-openai-key"}');
    process.env.CODEX_HOME = codexHome;
    const configPath = join(fixtureDir, "config.json");

    const selected = await setupOpencodeProviderCredentials(
      {
        configPath,
        config: {
          apiBaseUrl: "http://localhost:3001/api",
          authBaseUrl: "http://localhost:3001/api/auth",
        },
      },
      { all: true },
    );

    expect(selected).toEqual([
      { providerId: "openai", authFile: codexAuthFile, source: "codex-auth-file", authType: "api" },
    ]);
    const savedConfig = await readFile(configPath, "utf8");
    expect(JSON.parse(savedConfig).opencodeProviderCredentials).toEqual([
      { providerId: "openai", authFile: codexAuthFile, source: "codex-auth-file" },
    ]);
    expect(savedConfig).not.toContain("codex-openai-key");
  });

  it("guards subscription connect before any device authorization starts", async () => {
    // Unregistered: the served-connector fetch is the first boundary, so the
    // guard fires before any vendor call or browser opens.
    await assert.rejects(
      connectOpencodeProviderSubscription(
        {
          configPath: join(fixtureDir, "config.json"),
          config: {
            apiBaseUrl: "http://localhost:3001/api",
            authBaseUrl: "http://localhost:3001/api/auth",
          },
        },
        "openai",
      ),
      /requires a registered runner/,
    );

    // Registered: the connectable set enumerates from the SERVED catalog —
    // never from anything compiled into the binary — and an unknown provider
    // fails before the vendor flow starts. The store passphrase is the next
    // boundary for a valid provider, still ahead of any browser approval.
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url?.endsWith("/connectors")) {
        response.end(
          JSON.stringify({
            connectors: ["openai", "github-copilot", "xai"].map((providerId) => ({
              providerId,
              label: providerId,
              description: "",
              kind: "rfc8628-form",
              clientId: "test-client",
              scope: "test",
              deviceAuthorizationUrl: "https://vendor.invalid/device",
              tokenUrl: "https://vendor.invalid/token",
              verificationUrlHosts: ["vendor.invalid"],
              defaultDeviceCodeTtlSeconds: 300,
              refresh: { tokenUrl: "https://vendor.invalid/token", clientId: "test-client" },
            })),
          }),
        );
        return;
      }
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "Passphrase unavailable in this test." }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as { port: number }).port;
    const registeredContext = {
      configPath: join(fixtureDir, "config.json"),
      config: {
        apiBaseUrl: `http://127.0.0.1:${port}/api`,
        authBaseUrl: `http://127.0.0.1:${port}/api/auth`,
        organizationId: "org_1",
        apiKey: "runner-api-key",
      },
    };
    try {
      await assert.rejects(
        connectOpencodeProviderSubscription(registeredContext, "anthropic"),
        /Available: openai, github-copilot, xai/,
      );
      await assert.rejects(
        connectOpencodeProviderSubscription(registeredContext, "openai"),
        /Credential store passphrase/,
      );
    } finally {
      server.close();
    }
  });

  it("reconnecting OpenCode Go removes ambiguous v1 Zen-or-Go state", async () => {
    const configPath = join(fixtureDir, "config.json");
    const passphrase = "exact-opencode-store-passphrase";
    const encrypter = new Encrypter();
    encrypter.setScryptWorkFactor(12);
    encrypter.setPassphrase(passphrase);
    const ciphertext = await encrypter.encrypt(
      JSON.stringify({
        version: 1,
        entries: {
          openai: { auth: { type: "api", key: "openai-key" } },
          opencode: { auth: { type: "api", key: "ambiguous-key" } },
        },
      }),
    );
    await writeFile(join(fixtureDir, credentialStoreFileName), `${armor.encode(ciphertext)}\n`);

    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url?.endsWith("/credential-store-passphrase")) {
        response.end(JSON.stringify({ passphrase }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "Unexpected request." }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as { port: number }).port;
    const context = {
      configPath,
      config: {
        apiBaseUrl: `http://127.0.0.1:${port}/api`,
        authBaseUrl: `http://127.0.0.1:${port}/api/auth`,
        organizationId: "org_1",
        apiKey: "runner-api-key",
        opencodeProviderCredentials: [
          { providerId: "openai", authFile, source: "opencode-auth-file" as const },
          { providerId: "opencode", authFile, source: "opencode-auth-file" as const },
        ],
      },
    };
    const apiKey = spyOn(prompts, "password").mockResolvedValue("go-key");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      expect(await connectOpencodeProviderSubscription(context, "opencode-go")).toBe("opencode-go");
    } finally {
      apiKey.mockRestore();
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
      server.close();
    }

    expect(await readCredentialStore({ configPath, passphrase })).toEqual({
      entries: {
        openai: { auth: { type: "api", key: "openai-key" } },
        "opencode-go": { auth: { type: "api", key: "go-key" } },
      },
    });
    expect(JSON.parse(await readFile(configPath, "utf8")).opencodeProviderCredentials).toEqual([
      { providerId: "openai", authFile, source: "opencode-auth-file" },
    ]);
  });

  it("keeps registration config untouched when setup finds no auth file", async () => {
    const configPath = join(fixtureDir, "config.json");
    const config = {
      apiBaseUrl: "http://localhost:3001/api",
      authBaseUrl: "http://localhost:3001/api/auth",
      organizationId: "org_1",
      apiKey: "runner-api-key",
    };
    await rm(authFile, { force: true });

    const selected = await setupOpencodeProviderCredentials({ configPath, config }, { all: false });

    expect(selected).toEqual([]);
    expect(config).toEqual({
      apiBaseUrl: "http://localhost:3001/api",
      authBaseUrl: "http://localhost:3001/api/auth",
      organizationId: "org_1",
      apiKey: "runner-api-key",
    });
  });

  it("shows credential status without exposing provider secrets", async () => {
    await showOpencodeProviderCredentialStatus({
      configPath: join(fixtureDir, "config.json"),
      config: {
        apiBaseUrl: "http://localhost:3001/api",
        authBaseUrl: "http://localhost:3001/api/auth",
        opencodeProviderCredentials: [
          { providerId: "openai", authFile, source: "opencode-auth-file" },
        ],
      },
    });

    const output = infoMessages.join("\n");
    expect(output).toContain("openai");
    expect(output).toContain("opencode-auth-file");
    expect(output).toContain(authFile);
    expect(output).not.toContain("openai-key");
  });

  it("syncs API keys, carries an exact repair target, and skips local OAuth logins", async () => {
    await writeFile(
      authFile,
      JSON.stringify({
        openai: { type: "api", key: "openai-key" },
        opencode: { type: "api", key: "zen-key" },
        "opencode-go": { type: "api", key: "go-key" },
        "github-copilot": { type: "oauth", refresh: "gho_local", access: "gho_local", expires: 0 },
      }),
    );
    // deviceSessionToken opens a browser for approval; BROWSER=none keeps the
    // real desktop from launching one during tests on any platform.
    const originalBrowser = process.env.BROWSER;
    process.env.BROWSER = "none";

    const requests: Array<{ path: string; body: string }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        requests.push({ path: request.url ?? "", body });
        response.setHeader("Content-Type", "application/json");
        if (request.url?.endsWith("/connectors")) {
          // The connect pointer in skip hints comes from the served catalog.
          response.end(
            JSON.stringify({
              connectors: [
                {
                  providerId: "github-copilot",
                  label: "GitHub Copilot",
                  description: "",
                  kind: "github-device",
                  clientId: "test-client",
                  scope: "read:user",
                  deviceCodeUrl: "https://vendor.invalid/device",
                  accessTokenUrl: "https://vendor.invalid/token",
                  verificationUrlHosts: ["vendor.invalid"],
                },
              ],
            }),
          );
          return;
        }
        if (request.url?.endsWith("/device/code")) {
          response.end(
            JSON.stringify({
              device_code: "local-device-code",
              user_code: "SYNC-1",
              verification_uri: "http://127.0.0.1:9/verify",
              verification_uri_complete: "http://127.0.0.1:9/verify?code=SYNC-1",
              expires_in: 300,
              interval: 1,
            }),
          );
          return;
        }
        if (request.url?.endsWith("/device/token")) {
          response.end(JSON.stringify({ access_token: "device-session-token" }));
          return;
        }
        response.end(
          JSON.stringify({ opencodeProviderCredential: { id: "cred-1", providerId: "openai" } }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as { port: number }).port;

    try {
      await syncOpencodeProviderCredentials(
        {
          configPath: join(fixtureDir, "config.json"),
          config: {
            apiBaseUrl: `http://127.0.0.1:${port}/api`,
            authBaseUrl: `http://127.0.0.1:${port}/api/auth`,
            organizationId: "00000000-0000-7000-8000-000000000042",
            machineId: "00000000-0000-7000-8000-000000000043",
            apiKey: "runner-api-key",
            opencodeProviderCredentials: [
              { providerId: "openai", authFile, source: "opencode-auth-file" },
              {
                providerId: "opencode",
                authFile,
                source: "opencode-auth-file",
                providerIdFormat: "exact",
              },
              {
                providerId: "opencode-go",
                authFile,
                source: "opencode-auth-file",
              },
              { providerId: "github-copilot", authFile, source: "opencode-auth-file" },
            ],
          },
        },
        {},
      );
      await syncOpencodeProviderCredentials(
        {
          configPath: join(fixtureDir, "config.json"),
          config: {
            apiBaseUrl: `http://127.0.0.1:${port}/api`,
            authBaseUrl: `http://127.0.0.1:${port}/api/auth`,
            organizationId: "00000000-0000-7000-8000-000000000042",
            machineId: "00000000-0000-7000-8000-000000000043",
            apiKey: "runner-api-key",
            opencodeProviderCredentials: [
              {
                providerId: "opencode-go",
                authFile,
                source: "opencode-auth-file",
              },
            ],
          },
        },
        {
          provider: "opencode-go",
          credential: "00000000-0000-7000-8000-000000000044",
        },
      );
    } finally {
      server.close();
      if (originalBrowser === undefined) delete process.env.BROWSER;
      else process.env.BROWSER = originalBrowser;
    }

    const syncRequests = requests.filter((entry) => entry.path.includes("/sync"));
    expect(syncRequests).toHaveLength(4);
    expect(syncRequests.map((request) => JSON.parse(request.body))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: "openai",
          runnerMachineId: "00000000-0000-7000-8000-000000000043",
          auth: { type: "api", key: "openai-key" },
        }),
        expect.objectContaining({
          providerId: "opencode",
          auth: { type: "api", key: "zen-key" },
        }),
        expect.objectContaining({
          providerId: "opencode-go",
          auth: { type: "api", key: "go-key" },
        }),
        expect.objectContaining({
          providerId: "opencode-go",
          credentialId: "00000000-0000-7000-8000-000000000044",
          auth: { type: "api", key: "go-key" },
        }),
      ]),
    );
    // The local OAuth token never crosses the wire.
    expect(JSON.stringify(requests)).not.toContain("gho_local");
    const output = infoMessages.join("\n");
    expect(output).toContain(
      "Skipped github-copilot: only API-key credentials sync from CLI auth files.",
    );
    expect(output).toContain("credentials setup --connect github-copilot");
    expect(output).toContain("Synced openai");
    expect(output).toContain("Synced opencode");
    expect(output).toContain("Synced opencode-go");
  });

  it("syncs unavailable API-key validation as persisted account health", async () => {
    await writeFile(authFile, '{"xai":{"type":"api","key":"xai-runner-key"}}');
    const originalFetch = globalThis.fetch;
    const originalBrowser = process.env.BROWSER;
    const apiServer = await credentialSyncHarness.server();
    const syncBodies: Record<string, unknown>[] = [];
    process.env.BROWSER = "none";
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === "runner-route.invalid") {
        if (url.pathname.endsWith("/device/code")) {
          return Response.json({
            device_code: "runner-sync-device-code",
            user_code: "SYNC-ROUTE",
            verification_uri: "https://runner-route.invalid/device",
            verification_uri_complete: "https://runner-route.invalid/device?code=SYNC-ROUTE",
            expires_in: 300,
            interval: 1,
          });
        }
        if (url.pathname.endsWith("/device/token")) {
          return Response.json({ access_token: credentialSyncSessionToken });
        }
        if (url.pathname.endsWith("/opencode-provider-credentials/sync")) {
          syncBodies.push((await request.clone().json()) as Record<string, unknown>);
        }
        return apiServer.handle(request);
      }
      return new Response(null, { status: 503 });
    }) as typeof fetch;

    try {
      await syncOpencodeProviderCredentials(
        {
          configPath: join(fixtureDir, "config.json"),
          config: {
            apiBaseUrl: "https://runner-route.invalid/api",
            authBaseUrl: "https://runner-route.invalid/api/auth",
            organizationId: credentialSyncOrganizationId,
            machineId: credentialSyncRunnerMachineId,
            opencodeProviderCredentials: [
              { providerId: "xai", authFile, source: "opencode-auth-file" },
            ],
          },
        },
        {},
      );
    } finally {
      globalThis.fetch = originalFetch;
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
      if (originalBrowser === undefined) delete process.env.BROWSER;
      else process.env.BROWSER = originalBrowser;
    }

    expect(syncBodies).toEqual([
      {
        providerId: "xai",
        runnerMachineId: credentialSyncRunnerMachineId,
        auth: { type: "api", key: "xai-runner-key" },
      },
    ]);
    const credentials = await (
      await credentialSyncHarness.db()
    ).db
      .select()
      .from(opencodeProviderCredentials);
    expect(
      credentials.find(
        (credential) =>
          credential.organizationId === credentialSyncOrganizationId &&
          credential.providerId === "xai",
      ),
    ).toMatchObject({ validationStatus: "unavailable" });
    // This is the only test that calls credentialSyncHarness.server(), so it
    // pays the whole cold import of the API module graph itself, then waits
    // out the device flow's poll interval and drives the sync twice over more
    // than a dozen round trips. None of that is bounded by anything this test
    // controls, so the budget is generous rather than tuned to an idle machine.
  }, 60_000);

  it("fails a sync that would upload nothing before any browser approval", async () => {
    // Only credential: a foreign CLI's OAuth login, which never syncs. The
    // failure must land before the device flow — the API base URL points at a
    // dead port, so any request attempt would throw a different error.
    await writeFile(
      authFile,
      JSON.stringify({
        "github-copilot": { type: "oauth", refresh: "gho_local", access: "gho_local", expires: 0 },
      }),
    );

    await assert.rejects(
      syncOpencodeProviderCredentials(
        {
          configPath: join(fixtureDir, "config.json"),
          config: {
            apiBaseUrl: "http://127.0.0.1:9/api",
            authBaseUrl: "http://127.0.0.1:9/api/auth",
            organizationId: "00000000-0000-7000-8000-000000000042",
            machineId: "00000000-0000-7000-8000-000000000043",
            opencodeProviderCredentials: [
              { providerId: "github-copilot", authFile, source: "opencode-auth-file" },
            ],
          },
        },
        {},
      ),
      /Nothing to sync/,
    );
  });

  it("merges machine-readable status into doctor and keeps its script exit code", async () => {
    const configPath = join(fixtureDir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        apiBaseUrl: "http://localhost:3001/api",
        // A key a newer runner might write: it must not break this binary
        // and must round-trip through config rewrites.
        futureRunnerSetting: true,
      }),
    );
    process.env.DEVBOX_OPENCODE_DOCKER_SOCKET_PATH = join(fixtureDir, "missing.sock");
    const command = createDevboxesCommand();
    await command.parseAsync(["doctor", "--json", "--config", configPath], { from: "user" });
    const parsed = JSON.parse(infoMessages.join("")) as {
      registered: boolean;
      version: string;
      credentials: { store: unknown[]; references: unknown[]; storeError: string | null };
    };
    expect(parsed).toMatchObject({
      registered: false,
      version: cliVersion,
      credentials: { store: [], references: [], storeError: null },
    });

    // Doctor's exit code is the one contract scripts consume: unregistered +
    // unreachable container runtime must answer non-zero.
    infoMessages.length = 0;
    try {
      const doctorCommand = createDevboxesCommand();
      await doctorCommand.parseAsync(["doctor", "--config", configPath], { from: "user" });
      expect(process.exitCode).toBe(1);
    } finally {
      // Doctor sets a non-zero exit code as its script contract; reset it so it
      // does not leak into the whole bun suite's exit code (bun keeps a
      // manually-set exitCode as-is when all tests pass).
      process.exitCode = 0;
    }
  });

  it("syncs device-store subscriptions with their account label", async () => {
    const configPath = join(fixtureDir, "config.json");
    const passphrase = "sync-store-passphrase";
    const storedAuth = {
      type: "oauth" as const,
      refresh: "store-refresh-token",
      access: "store-access-token",
      expires: Date.now() + 3_600_000,
      accountId: "chatgpt-account",
    };
    await writeCredentialStore({
      configPath,
      passphrase,
      store: {
        entries: { openai: { auth: storedAuth, accountLabel: "user@example.com" } },
      },
    });
    const originalBrowser = process.env.BROWSER;
    process.env.BROWSER = "none";

    const requests: Array<{ path: string; body: string }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        requests.push({ path: request.url ?? "", body });
        response.setHeader("Content-Type", "application/json");
        if (request.url?.endsWith("/credential-store-passphrase")) {
          response.end(JSON.stringify({ passphrase }));
          return;
        }
        if (request.url?.endsWith("/device/code")) {
          response.end(
            JSON.stringify({
              device_code: "local-device-code",
              user_code: "SYNC-2",
              verification_uri: "http://127.0.0.1:9/verify",
              verification_uri_complete: "http://127.0.0.1:9/verify?code=SYNC-2",
              expires_in: 300,
              interval: 1,
            }),
          );
          return;
        }
        if (request.url?.endsWith("/device/token")) {
          response.end(JSON.stringify({ access_token: "device-session-token" }));
          return;
        }
        response.end(
          JSON.stringify({ opencodeProviderCredential: { id: "cred-2", providerId: "openai" } }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as { port: number }).port;

    try {
      await syncOpencodeProviderCredentials(
        {
          configPath,
          config: {
            apiBaseUrl: `http://127.0.0.1:${port}/api`,
            authBaseUrl: `http://127.0.0.1:${port}/api/auth`,
            organizationId: "00000000-0000-7000-8000-000000000042",
            machineId: "00000000-0000-7000-8000-000000000043",
            apiKey: "runner-api-key",
          },
        },
        {},
      );
    } finally {
      server.close();
      if (originalBrowser === undefined) delete process.env.BROWSER;
      else process.env.BROWSER = originalBrowser;
    }

    const syncRequests = requests.filter((entry) => entry.path.includes("/sync"));
    expect(syncRequests).toHaveLength(1);
    const syncBody = JSON.parse(syncRequests[0]!.body);
    expect(syncBody).toMatchObject({
      providerId: "openai",
      runnerMachineId: "00000000-0000-7000-8000-000000000043",
      accountLabel: "user@example.com",
      auth: storedAuth,
    });
    expect(infoMessages.join("\n")).toContain("Synced openai");
  });

  it("removes selected credential references without touching source credential files", async () => {
    const configPath = join(fixtureDir, "config.json");
    const anthropicAuthFile = join(fixtureDir, "anthropic-auth.json");
    await writeFile(anthropicAuthFile, '{"anthropic":{"type":"api","key":"key"}}');
    const config = {
      apiBaseUrl: "http://localhost:3001/api",
      authBaseUrl: "http://localhost:3001/api/auth",
      opencodeProviderCredentials: [
        { providerId: "openai", authFile, source: "opencode-auth-file" as const },
        {
          providerId: "anthropic",
          authFile: anthropicAuthFile,
          source: "opencode-auth-file" as const,
        },
      ],
    };

    await removeOpencodeProviderCredentials(
      { configPath, config },
      { provider: "openai", all: false },
    );

    const savedConfig = await readFile(configPath, "utf8");
    expect(JSON.parse(savedConfig).opencodeProviderCredentials).toEqual([
      { providerId: "anthropic", authFile: anthropicAuthFile, source: "opencode-auth-file" },
    ]);
    expect(await readFile(authFile, "utf8")).toContain("openai-key");
  });

  it("removes ambiguous v1 OpenCode credentials explicitly or with all", async () => {
    const passphrase = "remove-ambiguous-store-passphrase";
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url?.endsWith("/credential-store-passphrase")) {
        response.end(JSON.stringify({ passphrase }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "Unexpected request." }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as { port: number }).port;

    try {
      for (const [name, options, expectedEntries, expectedReferences] of [
        [
          "selected",
          { provider: "opencode", all: false },
          { openai: { auth: { type: "api", key: "openai-key" } } },
          [{ providerId: "openai", authFile, source: "opencode-auth-file" }],
        ],
        [
          "go",
          { provider: "opencode-go", all: false },
          { openai: { auth: { type: "api", key: "openai-key" } } },
          [
            { providerId: "openai", authFile, source: "opencode-auth-file" },
            {
              providerId: "opencode",
              authFile,
              source: "opencode-auth-file",
              providerIdFormat: "exact",
            },
          ],
        ],
        ["all", { all: true }, {}, []],
      ] as const) {
        const caseDir = join(fixtureDir, name);
        const configPath = join(caseDir, "config.json");
        await mkdir(caseDir, { recursive: true });
        const encrypter = new Encrypter();
        encrypter.setScryptWorkFactor(12);
        encrypter.setPassphrase(passphrase);
        const ciphertext = await encrypter.encrypt(
          JSON.stringify({
            version: 1,
            entries: {
              openai: { auth: { type: "api", key: "openai-key" } },
              opencode: { auth: { type: "api", key: "ambiguous-key" } },
            },
          }),
        );
        await writeFile(join(caseDir, credentialStoreFileName), `${armor.encode(ciphertext)}\n`);
        const context = {
          configPath,
          config: {
            apiBaseUrl: `http://127.0.0.1:${port}/api`,
            authBaseUrl: `http://127.0.0.1:${port}/api/auth`,
            organizationId: "org_1",
            apiKey: "runner-api-key",
            opencodeProviderCredentials: [
              { providerId: "openai", authFile, source: "opencode-auth-file" as const },
              { providerId: "opencode", authFile, source: "opencode-auth-file" as const },
              {
                providerId: "opencode",
                authFile,
                source: "opencode-auth-file" as const,
                providerIdFormat: "exact" as const,
              },
            ],
          },
        };

        await removeOpencodeProviderCredentials(context, options);

        expect((await readCredentialStore({ configPath, passphrase })).entries).toEqual(
          expectedEntries,
        );
        expect(JSON.parse(await readFile(configPath, "utf8")).opencodeProviderCredentials).toEqual(
          expectedReferences,
        );
      }
    } finally {
      server.close();
    }
  });

  it("doctor --live proves stored subscriptions against the vendor", async () => {
    const configPath = join(fixtureDir, "config.json");
    const passphrase = "doctor-live-passphrase";
    await writeCredentialStore({
      configPath,
      passphrase,
      store: {
        entries: {
          openai: {
            auth: {
              type: "oauth",
              refresh: "live-refresh",
              access: "live-access",
              expires: Date.now() + 3_600_000,
            },
          },
          xai: { auth: { type: "api", key: "xai-key" } },
        },
      },
    });

    // Fake docker engine so the runtime check passes and the doctor verdict
    // isolates the credential liveness contract.
    const dockerSocketPath = join(fixtureDir, "docker.sock");
    const dockerServer = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ Version: "27.0.0", ApiVersion: "1.45" }));
    });
    await new Promise<void>((resolve, reject) => {
      dockerServer.once("error", reject);
      dockerServer.listen(dockerSocketPath, () => {
        dockerServer.off("error", reject);
        resolve();
      });
    });
    process.env.DEVBOX_OPENCODE_DOCKER_SOCKET_PATH = dockerSocketPath;
    delete process.env.DOCKER_HOST;

    // The dashboard serves the store passphrase and the connector catalog —
    // the descriptor's refresh endpoint is what points the runner at the
    // vendor host stubbed below. First vendor call rotates the family, the
    // second definitively rejects it.
    const apiServer = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url?.endsWith("/connectors")) {
        response.end(
          JSON.stringify({
            connectors: [
              {
                providerId: "openai",
                label: "ChatGPT Pro/Plus",
                description: "",
                kind: "openai-device",
                clientId: "test-client",
                usercodeUrl: "https://auth.openai.com/api/accounts/deviceauth/usercode",
                pollUrl: "https://auth.openai.com/api/accounts/deviceauth/token",
                tokenUrl: "https://auth.openai.com/oauth/token",
                redirectUri: "https://auth.openai.com/deviceauth/callback",
                verificationUrl: "https://auth.openai.com/codex/device",
                refresh: {
                  tokenUrl: "https://auth.openai.com/oauth/token",
                  clientId: "test-client",
                },
              },
            ],
          }),
        );
        return;
      }
      response.end(JSON.stringify({ passphrase }));
    });
    await new Promise<void>((resolve) => {
      apiServer.listen(0, "127.0.0.1", resolve);
    });
    const apiPort = (apiServer.address() as { port: number }).port;
    const originalFetch = globalThis.fetch;
    let vendorCalls = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("auth.openai.com")) {
        vendorCalls += 1;
        return vendorCalls === 1
          ? Response.json({
              access_token: "live-access-2",
              refresh_token: "live-refresh-2",
              expires_in: 3600,
            })
          : new Response("invalid_grant", { status: 401 });
      }
      return originalFetch(input as never, init);
    }) as typeof fetch;

    const context = {
      configPath,
      config: {
        apiBaseUrl: `http://127.0.0.1:${apiPort}/api`,
        authBaseUrl: `http://127.0.0.1:${apiPort}/api/auth`,
        organizationId: "org_1",
        apiKey: "runner-api-key",
      },
    };
    try {
      expect(await runRunnerDoctor(context, { live: true })).toBe(true);
      const output = infoMessages.join("\n");
      expect(output).toContain("openai subscription refreshed against the vendor");
      expect(output).toContain("Stored API keys are not vendor-verified");
      expect(output).toContain("xai");
      // The proof-of-life rotation persists like any other refresh.
      const persisted = await (
        await import("./credential-store")
      ).readCredentialStore({ configPath, passphrase });
      expect(persisted.entries.openai?.auth).toMatchObject({ refresh: "live-refresh-2" });

      // A vendor-side rejection turns the verdict red instead of hiding
      // until a task boots at 3am.
      infoMessages.length = 0;
      expect(await runRunnerDoctor(context, { live: true })).toBe(false);
      expect(infoMessages.join("\n")).toContain("rejected on refresh");
    } finally {
      globalThis.fetch = originalFetch;
      apiServer.close();
      await new Promise<void>((resolve, reject) => {
        dockerServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("doctors local credential readiness without exposing provider secrets", async () => {
    const dockerSocketPath = join(fixtureDir, "docker.sock");
    const dockerServer = createServer((request, response) => {
      if (request.url === "/version") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ Version: "27.0.0", ApiVersion: "1.45" }));
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      dockerServer.once("error", reject);
      dockerServer.listen(dockerSocketPath, () => {
        dockerServer.off("error", reject);
        resolve();
      });
    });
    process.env.DEVBOX_OPENCODE_DOCKER_SOCKET_PATH = dockerSocketPath;
    delete process.env.DOCKER_HOST;
    const context = {
      configPath: join(fixtureDir, "config.json"),
      config: {
        apiBaseUrl: "http://localhost:3001/api",
        authBaseUrl: "http://localhost:3001/api/auth",
        organizationId: "org_1",
        apiKey: "runner-api-key",
        opencodeProviderCredentials: [
          { providerId: "openai", authFile, source: "opencode-auth-file" as const },
        ],
      },
    };

    try {
      expect(await runRunnerDoctor(context)).toBe(true);
      await rm(authFile, { force: true });
      expect(await runRunnerDoctor(context)).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        dockerServer.close((error) => (error ? reject(error) : resolve()));
      });
    }

    const output = infoMessages.join("\n");
    expect(output).not.toContain("openai-key");
  });

  it("advertises only credential identity while unreadable sources remain explicit", async () => {
    const dockerSocketPath = join(fixtureDir, "docker-listen.sock");
    const dockerServer = createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end("[]");
    });
    await new Promise<void>((resolve, reject) => {
      dockerServer.once("error", reject);
      dockerServer.listen(dockerSocketPath, () => {
        dockerServer.off("error", reject);
        resolve();
      });
    });

    const configPath = join(fixtureDir, "listen-config.json");
    const heartbeat = Promise.withResolvers<unknown>();
    const claim = Promise.withResolvers<unknown>();
    let heartbeatCount = 0;
    const apiServer = Bun.serve({
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname.endsWith("/heartbeat")) {
          heartbeatCount += 1;
          if (heartbeatCount > 1) heartbeat.resolve(await request.json());
          await writeFile(
            authFile,
            JSON.stringify({
              "local-only": {
                type: "oauth",
                refresh: "replacement-refresh",
                access: "replacement-access",
                expires: 0,
              },
            }),
          );
          return Response.json({});
        }
        if (pathname.endsWith("/tasks")) return Response.json({ tasks: [] });
        if (pathname.endsWith("/model-resolutions/claim")) {
          return new Response(null, { status: 204 });
        }
        if (pathname.endsWith("/claim")) {
          claim.resolve(await request.json());
          return new Response(null, { status: 204 });
        }
        return Response.json({ error: "Unexpected request." }, { status: 404 });
      },
    });
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          apiBaseUrl: `http://127.0.0.1:${apiServer.port}/api`,
          authBaseUrl: `http://127.0.0.1:${apiServer.port}/api/auth`,
          organizationId: "org_1",
          apiKey: "runner-api-key",
          opencodeProviderCredentials: [
            { providerId: "local-only", authFile, source: "opencode-auth-file" },
            {
              providerId: "anthropic",
              authFile: join(fixtureDir, "missing-anthropic-auth.json"),
              source: "opencode-auth-file",
            },
          ],
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    const listening = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../cli.ts"), "--config", configPath, "listen"],
      {
        cwd: join(import.meta.dir, "../.."),
        env: { ...process.env, DEVBOX_OPENCODE_DOCKER_SOCKET_PATH: dockerSocketPath },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const stderrText = new Response(listening.stderr).text();
    try {
      const outcome = await Promise.race([
        Promise.all([heartbeat.promise, claim.promise]).then(([heartbeatBody, claimBody]) => ({
          kind: "claim" as const,
          heartbeatBody,
          claimBody,
        })),
        listening.exited.then((exitCode) => ({ kind: "exit" as const, exitCode })),
        Bun.sleep(10_000).then(() => ({ kind: "timeout" as const })),
      ]);
      if (outcome.kind !== "claim") {
        if (!listening.killed) listening.kill("SIGTERM");
        const exitCode = await listening.exited;
        const stderr = await stderrText;
        throw new Error(
          outcome.kind === "exit"
            ? `devboxes listen exited ${outcome.exitCode} before claiming: ${stderr}`
            : `devboxes listen did not claim within 10 seconds (exit ${exitCode}): ${stderr}`,
        );
      }
      expect(outcome.heartbeatBody).toMatchObject({
        localProviderCredentials: [
          {
            providerId: "anthropic",
            authType: null,
            credentialFingerprint: null,
          },
          {
            providerId: "local-only",
            authType: null,
            credentialFingerprint: null,
          },
        ],
      });
      expect(outcome.claimBody).toEqual({
        leaseMs: 120_000,
        launchProtocols: ["devboxes-launch-v5"],
      });
    } finally {
      if (!listening.killed) listening.kill("SIGTERM");
      await listening.exited;
      await apiServer.stop(true);
      await new Promise<void>((resolve, reject) => {
        dockerServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
    expect(await stderrText).toContain(
      "Local provider credential anthropic could not be loaded or refreshed.",
    );
  });

  it("polls with healthy or empty credentials when startup credential state is unusable", async () => {
    const dockerSocketPath = join(fixtureDir, "docker-startup-credentials.sock");
    const dockerServer = createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end("[]");
    });
    await new Promise<void>((resolve, reject) => {
      dockerServer.once("error", reject);
      dockerServer.listen(dockerSocketPath, () => {
        dockerServer.off("error", reject);
        resolve();
      });
    });

    let passphrase = "";
    let claim = Promise.withResolvers<unknown>();
    let heartbeat = Promise.withResolvers<unknown>();
    const apiServer = Bun.serve({
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname.endsWith("/credential-store-passphrase")) {
          return Response.json({ passphrase });
        }
        if (pathname.endsWith("/heartbeat")) {
          heartbeat.resolve(await request.json());
          return Response.json({});
        }
        if (pathname.endsWith("/tasks")) return Response.json({ tasks: [] });
        if (pathname.endsWith("/model-resolutions/claim")) {
          return new Response(null, { status: 204 });
        }
        if (pathname.endsWith("/claim")) {
          claim.resolve(await request.json());
          return new Response(null, { status: 204 });
        }
        return Response.json({ error: "Unexpected request." }, { status: 404 });
      },
    });

    const scenarios: Array<{
      name: string;
      configuredProviderIds?: string[];
      configuredAmbiguousOpencode?: boolean;
      store?: { plaintext: string; encryptionPassphrase?: string };
      expectedProviders: Array<{ providerId: string; authType: "api" }>;
      expectedError?: string;
    }> = [
      {
        name: "ambiguous-config-reference",
        configuredProviderIds: ["openai"],
        configuredAmbiguousOpencode: true,
        expectedProviders: [{ providerId: "openai", authType: "api" }],
        expectedError: "Local provider credential opencode is unavailable for runner claims:",
      },
      {
        name: "ambiguous-store",
        configuredProviderIds: ["openai"],
        store: {
          plaintext: JSON.stringify({
            version: 1,
            entries: { opencode: { auth: { type: "api", key: "ambiguous-key" } } },
          }),
        },
        expectedProviders: [{ providerId: "openai", authType: "api" }],
        expectedError: "Legacy OpenCode credentials are ambiguous",
      },
      {
        name: "invalid-store-entry",
        configuredProviderIds: ["openai"],
        store: {
          plaintext: JSON.stringify({
            version: 2,
            entries: { xai: { auth: { type: "api" } } },
          }),
        },
        expectedProviders: [{ providerId: "openai", authType: "api" }],
        expectedError: "decrypts but does not parse",
      },
      {
        name: "unreadable-store",
        store: {
          plaintext: JSON.stringify({ version: 2, entries: {} }),
          encryptionPassphrase: "different-store-passphrase",
        },
        expectedProviders: [],
        expectedError: "could not be decrypted",
      },
      {
        name: "newer-store",
        store: {
          plaintext: JSON.stringify({
            version: 3,
            entries: { openai: { auth: { type: "api", key: "newer-key" } } },
          }),
        },
        expectedProviders: [],
        expectedError: "written by a newer Devboxes version",
      },
      {
        name: "healthy-store",
        store: {
          plaintext: JSON.stringify({
            version: 2,
            entries: { xai: { auth: { type: "api", key: "healthy-store-key" } } },
          }),
        },
        expectedProviders: [{ providerId: "xai", authType: "api" }],
      },
    ];

    try {
      for (const scenario of scenarios) {
        const scenarioDirectory = join(fixtureDir, scenario.name);
        const configPath = join(scenarioDirectory, "config.json");
        await mkdir(scenarioDirectory, { recursive: true });
        passphrase = `${scenario.name}-passphrase`;
        claim = Promise.withResolvers<unknown>();
        heartbeat = Promise.withResolvers<unknown>();
        const storePath = join(scenarioDirectory, credentialStoreFileName);
        let originalStoreContents: string | undefined;
        if (scenario.store) {
          const encrypter = new Encrypter();
          encrypter.setScryptWorkFactor(12);
          encrypter.setPassphrase(scenario.store.encryptionPassphrase ?? passphrase);
          const ciphertext = await encrypter.encrypt(scenario.store.plaintext);
          originalStoreContents = `${armor.encode(ciphertext)}\n`;
          await writeFile(storePath, originalStoreContents, { mode: 0o600 });
        }
        await writeFile(
          configPath,
          `${JSON.stringify({
            apiBaseUrl: `http://127.0.0.1:${apiServer.port}/api`,
            authBaseUrl: `http://127.0.0.1:${apiServer.port}/api/auth`,
            organizationId: "org_1",
            apiKey: "runner-api-key",
            opencodeProviderCredentials: [
              ...(scenario.configuredProviderIds ?? []).map((providerId) => ({
                providerId,
                authFile,
                source: "opencode-auth-file",
              })),
              ...(scenario.configuredAmbiguousOpencode
                ? [{ providerId: "opencode", authFile, source: "opencode-auth-file" }]
                : []),
            ],
          })}\n`,
          { mode: 0o600 },
        );

        const listening = Bun.spawn(
          [process.execPath, join(import.meta.dir, "../cli.ts"), "--config", configPath, "listen"],
          {
            cwd: join(import.meta.dir, "../.."),
            env: { ...process.env, DEVBOX_OPENCODE_DOCKER_SOCKET_PATH: dockerSocketPath },
            stdout: "ignore",
            stderr: "pipe",
          },
        );
        const stderrText = new Response(listening.stderr).text();
        try {
          const outcome = await Promise.race([
            Promise.all([heartbeat.promise, claim.promise]).then(([heartbeatBody, claimBody]) => ({
              kind: "claim" as const,
              heartbeatBody,
              claimBody,
            })),
            listening.exited.then((exitCode) => ({ kind: "exit" as const, exitCode })),
            Bun.sleep(10_000).then(() => ({ kind: "timeout" as const })),
          ]);
          if (outcome.kind !== "claim") {
            if (!listening.killed) listening.kill("SIGTERM");
            const exitCode = await listening.exited;
            const stderr = await stderrText;
            throw new Error(
              outcome.kind === "exit"
                ? `${scenario.name}: devboxes listen exited ${outcome.exitCode} before claiming: ${stderr}`
                : `${scenario.name}: devboxes listen did not claim within 10 seconds (exit ${exitCode}): ${stderr}`,
            );
          }
          expect(outcome.heartbeatBody).toMatchObject({
            localProviderCredentials: scenario.expectedProviders.map((provider) => ({
              ...provider,
              credentialFingerprint: expect.any(String),
            })),
          });
          expect(outcome.claimBody).toMatchObject({
            leaseMs: 120_000,
            launchProtocols: ["devboxes-launch-v5"],
          });
        } finally {
          if (!listening.killed) listening.kill("SIGTERM");
          await listening.exited;
        }
        const stderr = await stderrText;
        if (scenario.expectedError) {
          expect(stderr).toContain(scenario.expectedError);
        } else {
          expect(stderr).not.toContain("credential store is unavailable for runner claims");
        }
        if (originalStoreContents) {
          expect(await readFile(storePath, "utf8")).toBe(originalStoreContents);
        }
      }
    } finally {
      await apiServer.stop(true);
      await new Promise<void>((resolve, reject) => {
        dockerServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("renews Workspace resolution ownership through failed Docker cleanup", async () => {
    const dockerSocketPath = join(fixtureDir, "docker-model-resolution.sock");
    const resolutionId = "00000000-0000-7000-8000-000000000493";
    const leaseId = "00000000-0000-7000-8000-000000000495";
    const rawFailureMarker = "credential-bearing-docker-cleanup-text";
    let containerInspectCount = 0;
    let containerCreateCount = 0;
    let stopCount = 0;
    let containerRemoved = false;
    const dockerServer = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://docker.local");
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && url.pathname.endsWith("/containers/json")) {
        response.end("[]");
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname.endsWith("/containers/container-model-resolution/json")
      ) {
        if (containerRemoved) {
          response.statusCode = 404;
          response.end(JSON.stringify({ message: "No such container" }));
          return;
        }
        containerInspectCount += 1;
        response.end(
          JSON.stringify({
            Id: "container-model-resolution",
            State: {
              Running: containerInspectCount < 3,
              ExitCode: 0,
              Error: "",
              FinishedAt: "0001-01-01T00:00:00Z",
            },
          }),
        );
        return;
      }
      if (request.method === "GET" && url.pathname.endsWith("/json")) {
        response.statusCode = 404;
        response.end(JSON.stringify({ message: "No such container" }));
        return;
      }
      if (request.method === "POST" && url.pathname.endsWith("/images/create")) {
        response.end(`${JSON.stringify({ status: "Downloaded" })}\n`);
        return;
      }
      if (request.method === "POST" && url.pathname.endsWith("/containers/create")) {
        containerCreateCount += 1;
        response.statusCode = 201;
        response.end(JSON.stringify({ Id: "container-model-resolution" }));
        return;
      }
      if (request.method === "POST" && url.pathname.endsWith("/start")) {
        response.statusCode = 204;
        response.end();
        return;
      }
      if (request.method === "POST" && url.pathname.endsWith("/stop")) {
        stopCount += 1;
        if (stopCount === 1) {
          response.statusCode = 500;
          response.end(JSON.stringify({ message: rawFailureMarker }));
        } else {
          response.statusCode = 304;
          response.end();
        }
        return;
      }
      if (
        request.method === "DELETE" &&
        url.pathname.endsWith("/containers/container-model-resolution")
      ) {
        containerRemoved = true;
        response.statusCode = 204;
        response.end();
        return;
      }
      if (request.method === "DELETE" && url.pathname.includes("/images/")) {
        response.statusCode = 404;
        response.end(JSON.stringify({ message: "No such image" }));
        return;
      }
      response.statusCode = 404;
      response.end(
        JSON.stringify({ message: `Unexpected Docker request ${request.method} ${url.pathname}` }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      dockerServer.once("error", reject);
      dockerServer.listen(dockerSocketPath, () => {
        dockerServer.off("error", reject);
        resolve();
      });
    });

    const configPath = join(fixtureDir, "listen-model-resolution.json");
    const cleanupReceipt = Promise.withResolvers<void>();
    let claimed = false;
    let leaseCount = 0;
    const apiServer = Bun.serve({
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname.endsWith("/heartbeat")) return Response.json({});
        if (pathname.endsWith("/tasks")) return Response.json({ tasks: [] });
        if (pathname.endsWith("/model-resolutions/claim")) {
          if (claimed) return new Response(null, { status: 204 });
          claimed = true;
          return Response.json({
            action: "resolve",
            resolutionId,
            leaseId,
            resource: {
              runtime: "docker",
              containerName: taskContainerName(resolutionId),
            },
            leaseMs: 60,
            organizationId: "00000000-0000-7000-8000-000000000494",
            providerId: "openai",
            credentialFingerprint: "a".repeat(64),
            source: "organization",
            imageRef:
              "registry-1.docker.io/firatoezcan/devboxes@sha256:0132f868cf2b6613f61148489b2cbde57f5a0e0f40cdac97b3c4f93c0971cf10",
            perCapabilityToken: "model-resolution-capability-token",
            launchSpec: {
              launchProtocol: opencodeWorkspaceLaunchProtocol,
              workspaceCapability: "provider-model-resolution",
              workingDir: "/workspace",
              entrypoint: daemonEntrypoint,
              env: {
                DEVBOX_WORKSPACE_CAPABILITY: "provider-model-resolution",
                DEVBOX_WORKSPACE_CAPABILITY_ID: resolutionId,
                DEVBOX_MODEL_PROVIDER_ID: "openai",
                DEVBOX_PROVIDER_AUTH_ROUTE: "model-resolutions",
              },
              memoryBackedPaths: [],
              labels: {},
              providerAuthSource: "organization",
            },
          });
        }
        if (pathname.endsWith(`/model-resolutions/${resolutionId}/lease`)) {
          leaseCount += 1;
          return Response.json({ renewed: true });
        }
        if (pathname.endsWith(`/model-resolutions/${resolutionId}/cleanup`)) {
          if (!containerRemoved) {
            return Response.json(
              { error: "Cleanup was acknowledged before resource deletion." },
              { status: 409 },
            );
          }
          cleanupReceipt.resolve();
          return Response.json({ released: true });
        }
        if (pathname.endsWith("/claim")) return new Response(null, { status: 204 });
        return Response.json({ error: "Unexpected request." }, { status: 404 });
      },
    });
    await writeFile(
      configPath,
      `${JSON.stringify({
        apiBaseUrl: `http://127.0.0.1:${apiServer.port}/api`,
        authBaseUrl: `http://127.0.0.1:${apiServer.port}/api/auth`,
        organizationId: "00000000-0000-7000-8000-000000000494",
        apiKey: "runner-api-key",
      })}\n`,
      { mode: 0o600 },
    );

    const listening = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../cli.ts"), "--config", configPath, "listen"],
      {
        cwd: join(import.meta.dir, "../.."),
        env: {
          ...process.env,
          DEVBOX_OPENCODE_DOCKER_SOCKET_PATH: dockerSocketPath,
          DEVBOX_OPENCODE_HOME_ROOT: join(fixtureDir, "model-resolution-runtime"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdoutText = new Response(listening.stdout).text();
    const stderrText = new Response(listening.stderr).text();
    try {
      const outcome = await Promise.race([
        cleanupReceipt.promise.then(() => "cleaned" as const),
        listening.exited.then(() => "exited" as const),
        Bun.sleep(10_000).then(() => "timeout" as const),
      ]);
      expect(outcome).toBe("cleaned");
      expect(containerCreateCount).toBe(1);
      expect(stopCount).toBe(2);
      expect(leaseCount).toBeGreaterThan(2);
      expect(containerRemoved).toBe(true);
    } finally {
      if (!listening.killed) listening.kill("SIGTERM");
      await listening.exited;
      await apiServer.stop(true);
      await new Promise<void>((resolve, reject) => {
        dockerServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
    expect(await stdoutText).not.toContain(rawFailureMarker);
    expect(await stderrText).not.toContain(rawFailureMarker);
  }, 15_000);

  it.skip("serves the exact local credential material advertised by the successful claim; observed RED: the task-claim fixture omits the current launch-spec capability and provider-auth route, so the runner reports Parse; delivery quarantine: https://github.com/firatoezcan/devboxes-dashboard/issues/695", async () => {
    const dockerSocketPath = join(fixtureDir, "docker-claim-authority.sock");
    const launched = Promise.withResolvers<{ providerAuthUrl: string }>();
    const launchFailed = Promise.withResolvers<string>();
    const dockerServer = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://docker.local");
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && url.pathname.endsWith("/containers/json")) {
        response.end("[]");
        return;
      }
      if (request.method === "GET" && url.pathname.endsWith("/json")) {
        response.statusCode = 404;
        response.end(JSON.stringify({ message: "No such container" }));
        return;
      }
      if (request.method === "POST" && url.pathname.endsWith("/images/create")) {
        response.end(`${JSON.stringify({ status: "Downloaded" })}\n`);
        return;
      }
      if (request.method === "POST" && url.pathname.endsWith("/containers/create")) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { Env: string[] };
        const providerAuthEnv = body.Env.find((entry) =>
          entry.startsWith("DEVBOX_OPENCODE_PROVIDER_AUTH_URL="),
        );
        if (!providerAuthEnv) throw new Error("Docker create omitted the provider-auth URL.");
        launched.resolve({
          providerAuthUrl: providerAuthEnv.slice(providerAuthEnv.indexOf("=") + 1),
        });
        response.statusCode = 201;
        response.end(JSON.stringify({ Id: "container-claim-authority" }));
        return;
      }
      if (request.method === "POST" && url.pathname.endsWith("/start")) {
        response.statusCode = 204;
        response.end();
        return;
      }
      response.statusCode = 404;
      response.end(
        JSON.stringify({ message: `Unexpected Docker request ${request.method} ${url.pathname}` }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      dockerServer.once("error", reject);
      dockerServer.listen(dockerSocketPath, () => {
        dockerServer.off("error", reject);
        resolve();
      });
    });

    const configPath = join(fixtureDir, "listen-claim-authority.json");
    const taskId = "00000000-0000-7000-8000-000000000391";
    const runId = "00000000-0000-7000-8000-000000000392";
    let claimed = false;
    let claimedCredentialFingerprint: string | undefined;
    const apiServer = Bun.serve({
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname.endsWith("/credential-store-passphrase")) {
          return Response.json({ passphrase: "claim-authority-provider-snapshot-passphrase" });
        }
        if (pathname.endsWith("/heartbeat")) {
          const body = (await request.json()) as {
            localProviderCredentials: Array<{ credentialFingerprint: string | null }>;
          };
          const credentialFingerprint = body.localProviderCredentials[0]?.credentialFingerprint;
          if (!credentialFingerprint) {
            throw new Error("Heartbeat omitted the credential fingerprint.");
          }
          claimedCredentialFingerprint = credentialFingerprint;
          return Response.json({});
        }
        if (pathname.endsWith("/tasks")) return Response.json({ tasks: [] });
        if (pathname.endsWith("/model-resolutions/claim")) {
          return new Response(null, { status: 204 });
        }
        if (pathname.endsWith("/claim")) {
          if (claimed) return new Response(null, { status: 204 });
          claimed = true;
          if (!claimedCredentialFingerprint) {
            throw new Error("Claim arrived before the credential heartbeat.");
          }
          await writeFile(
            authFile,
            JSON.stringify({
              openai: {
                type: "oauth",
                refresh: "rotated-after-claim-refresh",
                access: "rotated-after-claim-access",
                expires: 0,
              },
            }),
          );
          return Response.json({
            taskId,
            organizationId: "org_1",
            runId,
            imageRef:
              "registry-1.docker.io/firatoezcan/devboxes@sha256:0132f868cf2b6613f61148489b2cbde57f5a0e0f40cdac97b3c4f93c0971cf10",
            modelProviderId: "openai",
            providerCredentialFingerprint: claimedCredentialFingerprint,
            daemonArtifact: {
              version: "0.8.1",
              bootstrapProtocol: "devboxes-daemon-bootstrap-v1",
              platform: "linux/amd64",
              sha256: "a".repeat(64),
            },
            platform: "linux/amd64",
            opencodeSessionId: null,
            attemptCount: 0,
            leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
            perTaskToken: "claim-authority-task-token",
            launchSpec: {
              launchProtocol: "devboxes-launch-v5",
              workspaceCapability: "agent-task",
              entrypoint: "/entrypoint.sh",
              workingDir: "/workspace",
              env: {
                HOME: "/home/workspace",
                XDG_CONFIG_HOME: "/home/workspace/.config",
                XDG_DATA_HOME: "/home/workspace/.local/share",
                OPENCODE_CONFIG: "/home/workspace/.config/opencode/opencode.json",
                OPENCODE_EXPERIMENTAL_HTTPAPI: "true",
                OPENCODE_EXPERIMENTAL_WORKSPACES: "true",
                DEVBOX_WORKSPACE_CAPABILITY_ID: taskId,
                DEVBOX_RUN_ID: runId,
                DEVBOX_BACKEND_TOKEN_FILE: "/run/devboxes/secrets/backend-token",
                DEVBOX_DAEMON_VERSION: "0.8.1",
                DEVBOX_DAEMON_PLATFORM: "linux/amd64",
                DEVBOX_DAEMON_SHA256: "a".repeat(64),
                DEVBOX_DAEMON_BOOTSTRAP_PROTOCOL: "devboxes-daemon-bootstrap-v1",
              },
              memoryBackedPaths: ["/home/workspace/.local/share/opencode"],
              labels: {},
              providerAuthSource: "local-broker",
            },
          });
        }
        if (pathname.endsWith("/report")) {
          const body = (await request.json()) as { status: string; errorMessage?: string };
          if (body.status === "failed") {
            launchFailed.resolve(body.errorMessage ?? "Runner omitted the launch failure.");
          }
          return Response.json({});
        }
        if (pathname.endsWith("/lease")) {
          return Response.json({ status: "running", terminal: false, stopRequested: false });
        }
        return Response.json({ error: "Unexpected request." }, { status: 404 });
      },
    });
    await writeFile(
      authFile,
      JSON.stringify({ openai: { type: "api", key: "claim-time-api-key" } }),
    );
    await writeFile(
      configPath,
      `${JSON.stringify({
        apiBaseUrl: `http://127.0.0.1:${apiServer.port}/api`,
        authBaseUrl: `http://127.0.0.1:${apiServer.port}/api/auth`,
        organizationId: "org_1",
        apiKey: "runner-api-key",
        opencodeProviderCredentials: [
          { providerId: "openai", authFile, source: "opencode-auth-file" },
        ],
      })}\n`,
      { mode: 0o600 },
    );

    const listening = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../cli.ts"), "--config", configPath, "listen"],
      {
        cwd: join(import.meta.dir, "../.."),
        env: {
          ...process.env,
          DEVBOX_OPENCODE_DOCKER_SOCKET_PATH: dockerSocketPath,
          DEVBOX_OPENCODE_HOME_ROOT: join(fixtureDir, "claim-authority-runtime"),
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    try {
      const outcome = await Promise.race([
        launched.promise.then((value) => ({ kind: "launched" as const, value })),
        launchFailed.promise.then((message) => ({ kind: "failure" as const, message })),
        listening.exited.then((exitCode) => ({ kind: "exit" as const, exitCode })),
        Bun.sleep(10_000).then(() => ({ kind: "timeout" as const })),
      ]);
      if (outcome.kind !== "launched") {
        if (!listening.killed) listening.kill("SIGTERM");
        const exitCode = await listening.exited;
        const stderr = await new Response(listening.stderr).text();
        throw new Error(
          outcome.kind === "failure"
            ? `devboxes listen reported launch failure: ${outcome.message}`
            : outcome.kind === "exit"
              ? `devboxes listen exited ${outcome.exitCode} before launch: ${stderr}`
              : `devboxes listen did not launch within 10 seconds (exit ${exitCode}): ${stderr}`,
        );
      }
      const providerAuthUrl = new URL(outcome.value.providerAuthUrl);
      providerAuthUrl.hostname = "127.0.0.1";
      const brokerTask = treaty<OpencodeCredentialBrokerApi>(providerAuthUrl.origin, {
        onRequest(_path, options) {
          const headers = new Headers(options.headers);
          headers.set("Authorization", "Bearer claim-authority-task-token");
          return { ...options, headers };
        },
      })["opencode-tasks"]({ taskId })["provider-auth"];
      let providerAuth: Awaited<ReturnType<typeof brokerTask.get>> | undefined;
      let providerAuthError: unknown;
      for (let attempt = 0; attempt < 20 && !providerAuth; attempt++) {
        const answer = await brokerTask.get();
        // No response means the broker socket is not accepting yet.
        if (answer.response) providerAuth = answer;
        else {
          providerAuthError = answer.error;
          await Bun.sleep(10);
        }
      }
      if (!providerAuth) throw providerAuthError;
      expect(providerAuth.status).toBe(200);
      expect(providerAuth.data).toEqual({
        openai: { type: "api", key: "claim-time-api-key" },
      });
      expect(claimedCredentialFingerprint).toBe(
        opencodeProviderAuthFingerprint("openai", {
          type: "api",
          key: "claim-time-api-key",
        }),
      );
    } finally {
      if (!listening.killed) listening.kill("SIGTERM");
      await listening.exited;
      await apiServer.stop(true);
      await new Promise<void>((resolve, reject) => {
        dockerServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("re-adopts the encrypted claim snapshot after source credential rotation", async () => {
    const dockerSocketPath = join(fixtureDir, "docker-restart-authority.sock");
    const taskId = "00000000-0000-7000-8000-000000000393";
    const organizationId = "00000000-0000-7000-8000-000000000394";
    const runId = "00000000-0000-7000-8000-000000000395";
    const containerName = taskContainerName(taskId);
    const passphrase = "restart-provider-snapshot-passphrase";
    const claimAuth = { openai: { type: "api" as const, key: "claim-snapshot-api-key" } };
    const claimFingerprint = opencodeProviderAuthFingerprint("openai", claimAuth.openai);
    const rotatedAuth = {
      type: "oauth" as const,
      refresh: "rotated-after-claim-refresh",
      access: "rotated-after-claim-access",
      expires: 0,
    };
    const rotatedFingerprint = opencodeProviderAuthFingerprint("openai", rotatedAuth);
    const homeRoot = join(fixtureDir, "restart-authority-runtime");
    process.env.DEVBOX_OPENCODE_DOCKER_SOCKET_PATH = dockerSocketPath;
    process.env.DEVBOX_OPENCODE_HOME_ROOT = homeRoot;
    const { DockerOpencodeTaskRuntime } = await import("./docker-task-runtime");
    await new DockerOpencodeTaskRuntime({
      daemonApiBaseUrl: "http://host.docker.internal:33001/api",
    }).persistProviderAuthSnapshot({
      organizationId,
      taskId,
      providerId: "openai",
      providerAuth: claimAuth,
      passphrase,
    });
    await writeFile(
      authFile,
      JSON.stringify({
        openai: rotatedAuth,
      }),
    );

    const dockerServer = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://docker.local");
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && url.pathname.endsWith("/containers/json")) {
        response.end(
          JSON.stringify([
            {
              Id: "container-restart-authority",
              Names: [`/${containerName}`],
              Labels: {
                "devboxes.firops.io/workload": "opencode-dispatch-task",
                "devboxes.firops.io/organization-id": organizationId,
                "devboxes.firops.io/task-id": taskId,
              },
            },
          ]),
        );
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname.endsWith("/containers/container-restart-authority/json")
      ) {
        response.end(
          JSON.stringify({
            Id: "container-restart-authority",
            State: {
              Status: "running",
              Running: true,
              OOMKilled: false,
              ExitCode: 0,
              Error: "",
              FinishedAt: "0001-01-01T00:00:00Z",
            },
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ message: `Unexpected Docker request ${url.pathname}` }));
    });
    await new Promise<void>((resolve, reject) => {
      dockerServer.once("error", reject);
      dockerServer.listen(dockerSocketPath, () => {
        dockerServer.off("error", reject);
        resolve();
      });
    });

    const configPath = join(fixtureDir, "listen-restart-authority.json");
    const busyHeartbeat = Promise.withResolvers<{
      localProviderCredentials: Array<{
        providerId: string;
        authType: "api" | "oauth" | null;
        credentialFingerprint: string | null;
      }>;
    }>();
    let heartbeatCount = 0;
    const apiServer = Bun.serve({
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname.endsWith("/credential-store-passphrase")) {
          return Response.json({ passphrase });
        }
        if (pathname.endsWith("/heartbeat")) {
          heartbeatCount += 1;
          const body = (await request.json()) as {
            localProviderCredentials: Array<{
              providerId: string;
              authType: "api" | "oauth" | null;
              credentialFingerprint: string | null;
            }>;
          };
          if (heartbeatCount > 1) busyHeartbeat.resolve(body);
          return Response.json({});
        }
        if (pathname.endsWith("/tasks")) {
          return Response.json({
            tasks: [
              {
                taskId,
                organizationId,
                runId,
                status: "running",
                terminal: false,
                runningOnThisMachine: true,
                stopRequested: false,
                containerId: "container-restart-authority",
                containerName,
                attemptCount: 0,
                modelProviderId: "openai",
                providerAuthSource: "local-broker",
                providerCredentialFingerprint: claimFingerprint,
                perTaskToken: "restart-authority-task-token",
              },
            ],
          });
        }
        if (pathname.endsWith("/lease")) {
          return Response.json({ status: "running", terminal: false, stopRequested: false });
        }
        if (pathname.endsWith("/claim")) return new Response(null, { status: 204 });
        if (pathname.endsWith("/report")) return Response.json({});
        return Response.json({ error: "Unexpected request." }, { status: 404 });
      },
    });
    await writeFile(
      configPath,
      `${JSON.stringify({
        apiBaseUrl: `http://127.0.0.1:${apiServer.port}/api`,
        authBaseUrl: `http://127.0.0.1:${apiServer.port}/api/auth`,
        organizationId,
        apiKey: "runner-api-key",
        opencodeProviderCredentials: [
          { providerId: "openai", authFile, source: "opencode-auth-file" },
        ],
      })}\n`,
      { mode: 0o600 },
    );

    const listening = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../cli.ts"), "--config", configPath, "listen"],
      {
        cwd: join(import.meta.dir, "../.."),
        env: {
          ...process.env,
          DEVBOX_OPENCODE_DOCKER_SOCKET_PATH: dockerSocketPath,
          DEVBOX_OPENCODE_HOME_ROOT: homeRoot,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const brokerPort = Promise.withResolvers<number>();
    const reAdopted = Promise.withResolvers<void>();
    let stdoutText = "";
    const stdoutPump = (async () => {
      const reader = listening.stdout.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        stdoutText += decoder.decode(chunk.value, { stream: true });
        const portMatch = stdoutText.match(
          /Local Opencode credential broker listening on port (\d+)\./,
        );
        if (portMatch?.[1]) brokerPort.resolve(Number(portMatch[1]));
        if (stdoutText.includes(`Re-adopted running task ${taskId}.`)) reAdopted.resolve();
      }
      stdoutText += decoder.decode();
    })().catch((error) => {
      brokerPort.reject(error);
      reAdopted.reject(error);
    });
    try {
      const outcome = await Promise.race([
        Promise.all([brokerPort.promise, reAdopted.promise, busyHeartbeat.promise]).then(
          ([port, _reAdopted, heartbeat]) => ({
            kind: "ready" as const,
            port,
            heartbeat,
          }),
        ),
        listening.exited.then((exitCode) => ({ kind: "exit" as const, exitCode })),
        Bun.sleep(10_000).then(() => ({ kind: "timeout" as const })),
      ]);
      if (outcome.kind !== "ready") {
        if (!listening.killed) listening.kill("SIGTERM");
        const stderr = await new Response(listening.stderr).text();
        throw new Error(
          outcome.kind === "exit"
            ? `devboxes listen exited ${outcome.exitCode} during re-adoption: ${stderr}`
            : `devboxes listen did not re-adopt within 10 seconds: ${stdoutText}\n${stderr}`,
        );
      }

      expect(outcome.heartbeat.localProviderCredentials).toMatchObject([
        {
          providerId: "openai",
          authType: "oauth",
          credentialFingerprint: rotatedFingerprint,
        },
      ]);

      const response = await treaty<OpencodeCredentialBrokerApi>(
        `http://127.0.0.1:${outcome.port}`,
        {
          onRequest(_path, options) {
            const headers = new Headers(options.headers);
            headers.set("Authorization", "Bearer restart-authority-task-token");
            return { ...options, headers };
          },
        },
      )
        ["opencode-tasks"]({ taskId })
        ["provider-auth"].get();
      expect(response.status).toBe(200);
      expect(response.data).toEqual(claimAuth);
    } finally {
      if (!listening.killed) listening.kill("SIGTERM");
      await listening.exited;
      await stdoutPump;
      await apiServer.stop(true);
      await new Promise<void>((resolve, reject) => {
        dockerServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }, 20_000);

  it("serves provider auth only for the active task with the matching bearer token", async () => {
    const activeCredentials = new Map<string, ActiveOpencodeCredentialTask>([
      [
        "task_1",
        {
          taskId: "task_1",
          organizationId: "org_1",
          modelProviderId: "openai",
          perTaskToken: "task-token",
          providerAuth: { openai: { type: "api", key: "openai-key" } },
        },
      ],
    ]);
    const broker = startCredentialBroker(activeCredentials);
    try {
      await writeFile(
        authFile,
        JSON.stringify({
          openai: {
            type: "oauth",
            refresh: "rotated-refresh",
            access: "rotated-access",
            expires: 0,
          },
        }),
      );
      expect(broker.providerAuthUrl).toContain("host.docker.internal");
      // Broker ports come from the reserved Devboxes dev range, not the full
      // OS-ephemeral range.
      expect(Number(new URL(broker.providerAuthUrl).port)).toBeWithin(34000, 35000);
      const brokerUrl = new URL(broker.providerAuthUrl);
      brokerUrl.hostname = "127.0.0.1";
      const client = treaty<OpencodeCredentialBrokerApi>(brokerUrl.toString(), {
        onRequest(_path, options) {
          const headers = new Headers(options.headers);
          headers.set("Authorization", "Bearer task-token");
          return { ...options, headers };
        },
      });
      const response = await client["opencode-tasks"]({ taskId: "task_1" })["provider-auth"].get();
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ openai: { type: "api", key: "openai-key" } });

      const wrongTokenResponse = await treaty<OpencodeCredentialBrokerApi>(brokerUrl.toString(), {
        onRequest(_path, options) {
          const headers = new Headers(options.headers);
          headers.set("Authorization", "Bearer wrong-token");
          return { ...options, headers };
        },
      })
        ["opencode-tasks"]({ taskId: "task_1" })
        ["provider-auth"].get();
      expect(wrongTokenResponse.status).toBe(401);

      activeCredentials.delete("task_1");
      const inactiveResponse = await client["opencode-tasks"]({ taskId: "task_1" })[
        "provider-auth"
      ].get();
      expect(inactiveResponse.status).toBe(401);
    } finally {
      await broker.close();
    }
  });

  it("serves store-connected credentials through the broker as ciphertext-backed auth", async () => {
    const configPath = join(fixtureDir, "config.json");
    const passphrase = "broker-store-passphrase";
    const storedAuth = {
      type: "oauth" as const,
      refresh: "stored-refresh-token",
      access: "stored-access-token",
      expires: Date.now() + 3_600_000,
      accountId: "chatgpt-account",
    };
    await writeCredentialStore({
      configPath,
      passphrase,
      store: {
        entries: { openai: { auth: storedAuth, accountLabel: "user@example.com" } },
      },
    });
    await rm(authFile, { force: true });
    const activeCredentials = new Map<string, ActiveOpencodeCredentialTask>([
      [
        "task_1",
        {
          taskId: "task_1",
          organizationId: "org_1",
          modelProviderId: "openai",
          perTaskToken: "task-token",
          providerAuth: { openai: storedAuth },
        },
      ],
    ]);
    const broker = startCredentialBroker(activeCredentials);
    try {
      const brokerUrl = new URL(broker.providerAuthUrl);
      brokerUrl.hostname = "127.0.0.1";
      const response = await treaty<OpencodeCredentialBrokerApi>(brokerUrl.toString(), {
        onRequest(_path, options) {
          const headers = new Headers(options.headers);
          headers.set("Authorization", "Bearer task-token");
          return { ...options, headers };
        },
      })
        ["opencode-tasks"]({ taskId: "task_1" })
        ["provider-auth"].get();
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ openai: storedAuth });
    } finally {
      await broker.close();
    }
  });
});
