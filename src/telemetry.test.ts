import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { cliVersion } from "./devboxes";

type CliResult = {
  durationMs: number;
  exitCode: number;
  signalCode: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
};

type CliConfig = {
  apiBaseUrl?: string;
  authBaseUrl?: string;
  apiKey?: string;
  futureConfigKey?: {
    prompt: string;
    transcript: string;
  };
  telemetry?: {
    dsn: string;
    environment: string;
  };
};

const telemetryEnvelopeEventSchema = z
  .object({
    environment: z.string(),
    event_id: z.string(),
    level: z.string(),
    message: z.string(),
    platform: z.string(),
    release: z.string(),
    tags: z.record(z.string(), z.string()),
    timestamp: z.union([z.number(), z.string()]),
  })
  .strict();
const telemetryEnvelopeItemHeaderSchema = z.object({ type: z.string().optional() });

const packageRoot = join(import.meta.dir, "..");
const compiledCliPath =
  process.platform === "win32"
    ? join(packageRoot, "dist", "windows-amd64", "devboxes.exe")
    : join(packageRoot, "dist", "devboxes");
const temporaryDirectories: string[] = [];

const writeCliConfig = async (config: CliConfig) => {
  const directory = await mkdtemp(join(tmpdir(), "devboxes-cli-telemetry-"));
  temporaryDirectories.push(directory);
  const configPath = join(directory, "config.json");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return configPath;
};

const cliEnvironment = (overrides: Record<string, string> = {}) => {
  const inheritedEnvironment = { ...process.env };
  delete inheritedEnvironment.DEVBOX_API_BASE_URL;
  delete inheritedEnvironment.DEVBOX_AUTH_BASE_URL;
  delete inheritedEnvironment.DEVBOX_CLI_SESSION_TOKEN;
  delete inheritedEnvironment.DEVBOX_ORGANIZATION_ID;
  delete inheritedEnvironment.DEVBOX_RUNNER_API_KEY;
  delete inheritedEnvironment.DEVBOX_RUNNER_NAME;
  return {
    ...inheritedEnvironment,
    BROWSER: "none",
    DEVBOXES_TEST_PRIVATE_ENV: "environment-value-secret",
    SENTRY_NAME: "server-name-secret",
    ...overrides,
  };
};

const runCli = async (
  configPath: string,
  args: string[],
  envOverrides: Record<string, string> = {},
  timeoutMs = 5_000,
): Promise<CliResult> => {
  const startedAt = performance.now();
  const child = Bun.spawn([compiledCliPath, "--config", configPath, ...args], {
    cwd: packageRoot,
    env: cliEnvironment(envOverrides),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  const exitCode = await child.exited;
  clearTimeout(timeout);

  return {
    durationMs: performance.now() - startedAt,
    exitCode,
    signalCode: child.signalCode,
    stderr: await stderr,
    stdout: await stdout,
    timedOut,
  };
};

const runCliUntilSignal = async (
  configPath: string,
  args: string[],
  envOverrides: Record<string, string>,
): Promise<CliResult> => {
  const startedAt = performance.now();
  const child = Bun.spawn([compiledCliPath, "--config", configPath, ...args], {
    cwd: packageRoot,
    env: cliEnvironment(envOverrides),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  await Bun.sleep(250);
  child.kill("SIGTERM");
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 1_000);
  const exitCode = await child.exited;
  clearTimeout(timeout);

  return {
    durationMs: performance.now() - startedAt,
    exitCode,
    signalCode: child.signalCode,
    stderr: await stderr,
    stdout: await stdout,
    timedOut,
  };
};

const processBehavior = (result: CliResult) => ({
  exitCode: result.exitCode,
  signalCode: result.signalCode,
  stderr: result.stderr,
  stdout: result.stdout,
  timedOut: result.timedOut,
});

const baseConfig = {
  apiBaseUrl: "https://api.devboxes.ai/api",
  authBaseUrl: "https://api.devboxes.ai/api/auth",
  apiKey: "runner-api-key-secret",
  futureConfigKey: {
    prompt: "prompt-secret",
    transcript: "transcript-secret",
  },
};

const hostileSentryEnvironment = (dsn: string, spotlightUrl: string) => ({
  SENTRY_BAGGAGE: "environment-baggage-secret",
  SENTRY_DEBUG: "1",
  SENTRY_DSN: dsn,
  SENTRY_ENVIRONMENT: "implicit-environment-secret",
  SENTRY_RELEASE: "implicit-release-secret",
  SENTRY_SPOTLIGHT: spotlightUrl,
  SENTRY_TRACE: "0123456789abcdef0123456789abcdef-0123456789abcdef-1",
  SENTRY_TRACES_SAMPLE_RATE: "1",
  VERCEL: "1",
});

beforeAll(async () => {
  const build = Bun.spawn([process.execPath, "scripts/build-cli-binaries.ts"], {
    cwd: packageRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(build.stdout).text();
  const stderr = new Response(build.stderr).text();
  const exitCode = await build.exited;
  if (exitCode !== 0) {
    throw new Error(`Compiled CLI build failed.\n${await stdout}\n${await stderr}`);
  }
});

afterAll(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("opt-in CLI error telemetry", () => {
  it("keeps default and re-disabled compiled runs network-silent and changes only telemetry", async () => {
    const requests: string[] = [];
    const receiver = Bun.serve({
      port: 0,
      fetch: async (request) => {
        requests.push(await request.text());
        return new Response(null, { status: 200 });
      },
    });
    const storedConfig = {
      futureConfigKey: baseConfig.futureConfigKey,
    };
    const configPath = await writeCliConfig(storedConfig);
    const dsn = `http://public@127.0.0.1:${receiver.port}/1`;
    const hostileEnvironment = hostileSentryEnvironment(
      dsn,
      `http://127.0.0.1:${receiver.port}/stream`,
    );
    const persistenceEnvironment = {
      ...hostileEnvironment,
      DEVBOX_API_BASE_URL: "https://ambient-api-secret.invalid/api",
      DEVBOX_AUTH_BASE_URL: "https://ambient-auth-secret.invalid/auth",
      DEVBOX_CLI_SESSION_TOKEN: "ambient-session-secret",
      DEVBOX_ORGANIZATION_ID: "ambient-organization-secret",
      DEVBOX_RUNNER_API_KEY: "ambient-runner-secret",
      DEVBOX_RUNNER_NAME: "ambient-runner-name-secret",
    };

    try {
      const defaultFailure = await runCli(
        configPath,
        ["status", "prompt-secret"],
        hostileEnvironment,
      );
      expect(defaultFailure).toMatchObject({
        exitCode: 1,
        signalCode: null,
        stdout: "",
        timedOut: false,
      });
      expect(requests).toHaveLength(0);

      const globalOverrides = [
        "--api",
        "https://flag-api-secret.invalid/api",
        "--auth",
        "https://flag-auth-secret.invalid/auth",
        "--organization",
        "flag-organization-secret",
      ];
      const enabled = await runCli(
        configPath,
        [...globalOverrides, "telemetry", "enable", "--dsn", dsn, "--environment", "test"],
        persistenceEnvironment,
      );
      expect(enabled).toMatchObject({ exitCode: 0, timedOut: false });
      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
        ...storedConfig,
        telemetry: { dsn, environment: "test" },
      });

      const disabled = await runCli(
        configPath,
        [...globalOverrides, "telemetry", "disable"],
        persistenceEnvironment,
      );
      expect(disabled).toMatchObject({ exitCode: 0, timedOut: false });
      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(storedConfig);

      const reDisabledFailure = await runCli(
        configPath,
        ["status", "prompt-secret"],
        hostileEnvironment,
      );
      expect(processBehavior(reDisabledFailure)).toEqual(processBehavior(defaultFailure));
      expect(requests).toHaveLength(0);
    } finally {
      await receiver.stop(true);
    }
  });

  it("rejects a runtime-invalid DSN before persisting the opt-in", async () => {
    const storedConfig = {
      futureConfigKey: baseConfig.futureConfigKey,
    };
    const defaultConfigPath = await writeCliConfig(storedConfig);
    const configPath = await writeCliConfig(storedConfig);
    const invalidDsn = "https://public-key-secret@sentry.example/project-secret";

    const enabled = await runCli(configPath, [
      "telemetry",
      "enable",
      "--dsn",
      invalidDsn,
      "--environment",
      "test",
    ]);

    expect(enabled).toMatchObject({
      exitCode: 1,
      signalCode: null,
      stdout: "",
      timedOut: false,
    });
    expect(enabled.stderr).not.toContain(invalidDsn);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(storedConfig);

    const defaultFailure = await runCli(defaultConfigPath, ["status", "prompt-secret"]);
    const failureAfterRejectedEnable = await runCli(configPath, ["status", "prompt-secret"]);
    expect(processBehavior(failureAfterRejectedEnable)).toEqual(processBehavior(defaultFailure));
    expect(failureAfterRejectedEnable.stderr).not.toContain(invalidDsn);
  });

  it("sends one allowlisted compiled event to only the configured destination", async () => {
    const requests: string[] = [];
    const requestUrls: string[] = [];
    const receiver = Bun.serve({
      port: 0,
      fetch: async (request) => {
        requestUrls.push(request.url);
        requests.push(await request.text());
        return new Response(null, { status: 200 });
      },
    });
    const spotlightRequests: string[] = [];
    const spotlight = Bun.serve({
      port: 0,
      fetch: async (request) => {
        spotlightRequests.push(await request.text());
        return new Response(null, { status: 200 });
      },
    });
    const dsn = `http://public@127.0.0.1:${receiver.port}/1`;
    const hostileEnvironment = hostileSentryEnvironment(
      `http://ambient@127.0.0.1:${spotlight.port}/2`,
      `http://127.0.0.1:${spotlight.port}/stream`,
    );
    const defaultConfigPath = await writeCliConfig(baseConfig);
    const configPath = await writeCliConfig({
      ...baseConfig,
      telemetry: { dsn, environment: "test" },
    });

    try {
      const defaultFailure = await runCli(
        defaultConfigPath,
        ["status", "prompt-secret"],
        hostileEnvironment,
      );
      const failed = await runCli(configPath, ["status", "prompt-secret"], hostileEnvironment);
      expect(processBehavior(failed)).toEqual(processBehavior(defaultFailure));
      expect(requests).toHaveLength(1);
      expect(spotlightRequests).toHaveLength(0);
      const requestUrl = new URL(requestUrls[0]!);
      expect(requestUrl.pathname).toBe("/api/1/envelope/");
      expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
        sentry_version: "7",
        sentry_key: "public",
      });

      const envelopeLines = requests[0]!.trimEnd().split("\n");
      const eventHeaderIndex = envelopeLines.findIndex((line) => {
        try {
          const parsed = telemetryEnvelopeItemHeaderSchema.safeParse(JSON.parse(line));
          return parsed.success && parsed.data.type === "event";
        } catch {
          return false;
        }
      });
      expect(eventHeaderIndex).toBeGreaterThan(0);
      const event = telemetryEnvelopeEventSchema.parse(
        JSON.parse(envelopeLines[eventHeaderIndex + 1]!),
      );
      expect(event).toMatchObject({
        environment: "test",
        level: "error",
        message: "Devboxes CLI command failed.",
        platform: "javascript",
        release: cliVersion,
        tags: {
          runtime: "cli",
          "devboxes.version": cliVersion,
        },
      });
      expect(Object.keys(event).sort()).toEqual(
        [
          "environment",
          "event_id",
          "level",
          "message",
          "platform",
          "release",
          "tags",
          "timestamp",
        ].sort(),
      );
      for (const secret of [
        "environment-value-secret",
        "environment-baggage-secret",
        "implicit-environment-secret",
        "implicit-release-secret",
        "server-name-secret",
        "runner-api-key-secret",
        "prompt-secret",
        "transcript-secret",
      ]) {
        expect(requests[0]).not.toContain(secret);
      }
    } finally {
      await receiver.stop(true);
      await spotlight.stop(true);
    }
  });

  it("keeps telemetry outside compiled listen and mcp process boundaries", async () => {
    const requests: string[] = [];
    const receiver = Bun.serve({
      port: 0,
      fetch: async (request) => {
        requests.push(await request.text());
        return new Response(null, { status: 200 });
      },
    });
    const dsn = `http://public@127.0.0.1:${receiver.port}/1`;
    const hostileEnvironment = hostileSentryEnvironment(
      dsn,
      `http://127.0.0.1:${receiver.port}/stream`,
    );
    const defaultConfigPath = await writeCliConfig({
      apiBaseUrl: baseConfig.apiBaseUrl,
      authBaseUrl: baseConfig.authBaseUrl,
    });
    const optedInConfigPath = await writeCliConfig({
      apiBaseUrl: baseConfig.apiBaseUrl,
      authBaseUrl: baseConfig.authBaseUrl,
      telemetry: { dsn, environment: "test" },
    });

    try {
      const defaultListen = await runCli(defaultConfigPath, ["listen"], hostileEnvironment);
      const optedInListen = await runCli(optedInConfigPath, ["listen"], hostileEnvironment);
      expect(processBehavior(optedInListen)).toEqual(processBehavior(defaultListen));
      expect(requests).toHaveLength(0);

      const defaultMcp = await runCliUntilSignal(defaultConfigPath, ["mcp"], hostileEnvironment);
      const optedInMcp = await runCliUntilSignal(optedInConfigPath, ["mcp"], hostileEnvironment);
      expect(processBehavior(optedInMcp)).toEqual(processBehavior(defaultMcp));
      expect(defaultMcp).toMatchObject({ signalCode: "SIGTERM", timedOut: false });
      expect(requests).toHaveLength(0);
    } finally {
      await receiver.stop(true);
    }
  });

  it("keeps command behavior intact when telemetry initialization fails", async () => {
    const invalidDsn = "https://public-key-secret@sentry.example/1";
    const defaultConfigPath = await writeCliConfig(baseConfig);
    const brokenConfigPath = await writeCliConfig({
      ...baseConfig,
      telemetry: { dsn: invalidDsn, environment: "test" },
    });

    const defaultFailure = await runCli(defaultConfigPath, ["status", "prompt-secret"]);
    const failureWithBrokenInitialization = await runCli(brokenConfigPath, [
      "status",
      "prompt-secret",
    ]);

    expect(processBehavior(failureWithBrokenInitialization)).toEqual(
      processBehavior(defaultFailure),
    );
    const diagnostic = await readFile(`${brokenConfigPath}.telemetry.log`, "utf8");
    expect(diagnostic).toContain('"failure":"initialization_failed"');
    expect(diagnostic).not.toContain(invalidDsn);
    expect(diagnostic).not.toContain("prompt-secret");
  });

  it("keeps command behavior intact when telemetry transport fails", async () => {
    const receiver = Bun.serve({
      port: 0,
      fetch: () => new Response(null, { status: 503 }),
    });
    const defaultConfigPath = await writeCliConfig(baseConfig);
    const brokenConfigPath = await writeCliConfig({
      ...baseConfig,
      telemetry: {
        dsn: `http://public@127.0.0.1:${receiver.port}/1`,
        environment: "test",
      },
    });

    try {
      const defaultFailure = await runCli(defaultConfigPath, ["status", "prompt-secret"]);
      const failureWithBrokenTransport = await runCli(brokenConfigPath, [
        "status",
        "prompt-secret",
      ]);

      expect(processBehavior(failureWithBrokenTransport)).toEqual(processBehavior(defaultFailure));
      const diagnostic = await readFile(`${brokenConfigPath}.telemetry.log`, "utf8");
      expect(diagnostic).toContain('"failure":"transport_failed"');
      expect(diagnostic).not.toContain("prompt-secret");
    } finally {
      await receiver.stop(true);
    }
  });

  it("honors the one-second delivery bound when the transport and diagnostic sink stall", async () => {
    const receiver = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    const configPath = await writeCliConfig({
      ...baseConfig,
      telemetry: {
        dsn: `http://public@127.0.0.1:${receiver.port}/1`,
        environment: "test",
      },
    });
    const diagnosticPath = `${configPath}.telemetry.log`;
    const mkfifo = Bun.spawn(["mkfifo", diagnosticPath], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const mkfifoError = new Response(mkfifo.stderr).text();
    if ((await mkfifo.exited) !== 0) {
      throw new Error(`Could not create the diagnostic FIFO: ${await mkfifoError}`);
    }

    try {
      const failure = await runCli(configPath, ["status", "prompt-secret"], {}, 2_500);
      expect(failure).toMatchObject({ exitCode: 1, signalCode: null, timedOut: false });
      expect(failure.durationMs).toBeLessThan(2_000);
    } finally {
      await receiver.stop(true);
    }
  });
});
