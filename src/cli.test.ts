import { afterAll, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonValue } from "@firops/platform/protocol/json";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { apiOrigin } from "./commands";

const runCli = async (
  args: string[],
  env: Record<string, string | undefined> = {},
  embeddedApiOrigin?: string,
  stdin?: string,
) => {
  const define =
    embeddedApiOrigin === undefined
      ? []
      : ["--define", `globalThis.DEVBOXES_DEFAULT_API_ORIGIN=${JSON.stringify(embeddedApiOrigin)}`];
  const child = Bun.spawn([process.execPath, ...define, "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, ...env },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const completed = await Promise.race([
    child.exited.then((exitCode) => ({ exitCode })),
    Bun.sleep(10_000).then(() => null),
  ]);
  if (!completed) {
    child.kill();
    await child.exited;
  }
  return { exitCode: completed?.exitCode, stdout: await stdout, stderr: await stderr };
};

const fixtureDirectory = await mkdtemp(join(tmpdir(), "devboxes-cli-"));
afterAll(() => rm(fixtureDirectory, { recursive: true, force: true }));
const sharedTokenFile = join(fixtureDirectory, "shared-token");
const emptyTokenFile = join(fixtureDirectory, "empty-token");
const malformedInput = join(fixtureDirectory, "malformed.json");
await writeFile(sharedTokenFile, "firops_runner_fixture\n");
await chmod(sharedTokenFile, 0o644);
await writeFile(emptyTokenFile, "\n");
await chmod(emptyTokenFile, 0o600);
await writeFile(malformedInput, "{ not json");
const privateTokenFile = join(fixtureDirectory, "private-token");
await writeFile(privateTokenFile, "firops_runner_fixture\n");
await chmod(privateTokenFile, 0o600);
const sharedStateDirectory = join(fixtureDirectory, "shared-state");
await mkdir(sharedStateDirectory);
await chmod(sharedStateDirectory, 0o777);
const sharedRelayKeyDirectory = join(fixtureDirectory, "shared-relay-key");
await mkdir(sharedRelayKeyDirectory, { mode: 0o700 });
await writeFile(
  join(sharedRelayKeyDirectory, "relay.json"),
  JSON.stringify({ key: "k".repeat(43), port: 9 }),
);
await chmod(join(sharedRelayKeyDirectory, "relay.json"), 0o644);
const linkedTokenFile = join(fixtureDirectory, "linked-token");
await symlink(privateTokenFile, linkedTokenFile);
const unreadableTokenFile = join(fixtureDirectory, "unreadable-token");
await writeFile(unreadableTokenFile, "firops_runner_fixture\n");
await chmod(unreadableTokenFile, 0o000);
const fifoTokenFile = join(fixtureDirectory, "fifo-token");
if (!Bun.spawnSync(["mkfifo", "-m", "600", fifoTokenFile]).success)
  throw new Error("mkfifo did not create the FIFO token file.");
const linkedRelayKeyDirectory = join(fixtureDirectory, "linked-relay-key");
await mkdir(linkedRelayKeyDirectory, { mode: 0o700 });
await writeFile(
  join(fixtureDirectory, "private-relay.json"),
  JSON.stringify({ key: "k".repeat(43), port: 9 }),
);
await chmod(join(fixtureDirectory, "private-relay.json"), 0o600);
await symlink(
  join(fixtureDirectory, "private-relay.json"),
  join(linkedRelayKeyDirectory, "relay.json"),
);
const scoped = { DEVBOXES_API_URL: "https://api.example.com", DEVBOXES_TOKEN: "scoped" };
const unusedOrigin = "http://127.0.0.1:9";
const listen = ["--json", "--api", "https://api.example.com", "runner", "listen"];
const localDocker = { DOCKER_HOST: undefined, DEVBOX_OPENCODE_DOCKER_SOCKET_PATH: undefined };

/**
 * Runs the CLI in a pseudo-terminal, with an `open` and an `xdg-open` on PATH that only record
 * their calls.
 */
const inTerminal = async (args: string[], env: Record<string, string>) => {
  const bin = await mkdtemp(join(fixtureDirectory, "bin-"));
  const opened = join(bin, "opened");
  for (const launcher of ["open", "xdg-open"]) {
    await writeFile(join(bin, launcher), `#!/bin/sh\necho "$@" >> ${opened}\n`);
    await chmod(join(bin, launcher), 0o755);
  }
  let screen = "";
  const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, ...env, PATH: `${bin}:${process.env.PATH}` },
    terminal: {
      cols: 120,
      rows: 40,
      data: (_terminal, data) => {
        screen += new TextDecoder().decode(data);
      },
    },
  });
  return {
    screen: () => screen,
    shows: async (text: string) => {
      for (let waited = 0; !screen.includes(text) && waited < 10_000; waited += 50)
        await Bun.sleep(50);
      return screen.includes(text);
    },
    type: (text: string) => child.terminal?.write(text),
    exited: (milliseconds = 10_000) =>
      Promise.race([child.exited, Bun.sleep(milliseconds).then(() => null)]),
    kill: () => child.kill(),
    opened: () => Bun.file(opened).exists(),
  };
};

describe("devboxes entrypoint", () => {
  it("prints help instead of listening when invoked without a subcommand", async () => {
    const result = await runCli([]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: devboxes");
    expect(result.stderr).toBe("");
  });

  it("keeps help available in JSON mode", async () => {
    const result = await runCli(["--json", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: devboxes");
  });

  it.each([
    ["a missing required argument", ["--json", "describe"]],
    ["a trailing JSON flag", ["describe", "--json"]],
    ["an unexpected argument", ["--json", "unknown-command"]],
  ])("writes %s as a structured error in JSON mode", async (_case, args) => {
    const result = await runCli(args);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: "INVALID_USAGE", message: expect.any(String) },
    });
  });

  it.skipIf(process.platform === "win32").each([
    [
      "a shared token file",
      [...listen, "--token-file", sharedTokenFile],
      localDocker,
      "INVALID_RUNNER_TOKEN_FILE",
    ],
    [
      "an empty token file",
      [...listen, "--token-file", emptyTokenFile],
      localDocker,
      "INVALID_RUNNER_TOKEN_FILE",
    ],
    [
      "a missing token file",
      [...listen, "--token-file", join(fixtureDirectory, "absent")],
      localDocker,
      "INVALID_RUNNER_TOKEN_FILE",
    ],
    [
      "a state directory other users can write",
      [...listen, "--token-file", privateTokenFile, "--state-directory", sharedStateDirectory],
      localDocker,
      "INVALID_RUNNER_STATE_DIRECTORY",
    ],
    [
      "a state directory other users can write, after a token file that links to a private file",
      [...listen, "--token-file", linkedTokenFile, "--state-directory", sharedStateDirectory],
      localDocker,
      "INVALID_RUNNER_STATE_DIRECTORY",
    ],
    [
      "a token file this user cannot read",
      [...listen, "--token-file", unreadableTokenFile],
      localDocker,
      "INVALID_RUNNER_TOKEN_FILE",
    ],
    [
      "a token file that is a FIFO",
      [...listen, "--token-file", fifoTokenFile],
      localDocker,
      "INVALID_RUNNER_TOKEN_FILE",
    ],
    [
      "a relay key that is a symbolic link",
      [...listen, "--token-file", privateTokenFile, "--state-directory", linkedRelayKeyDirectory],
      localDocker,
      "INVALID_RUNNER_STATE_DIRECTORY",
    ],
    [
      "a relay key other users can read",
      [...listen, "--token-file", privateTokenFile, "--state-directory", sharedRelayKeyDirectory],
      localDocker,
      "INVALID_RUNNER_STATE_DIRECTORY",
    ],
    [
      "a machine that was never added",
      listen,
      { ...localDocker, XDG_CONFIG_HOME: join(fixtureDirectory, "never-added") },
      "MACHINE_NOT_ADDED",
    ],
    [
      "an Organization missing outside a terminal",
      ["--json", "machine", "add", "--name", "Office Mac"],
      { ...scoped, XDG_CONFIG_HOME: join(fixtureDirectory, "never-added") },
      "ORGANIZATION_REQUIRED",
    ],
    [
      "a machine name missing outside a terminal",
      ["--json", "machine", "add", "--organization", "0198a0b0-0000-7000-8000-000000000001"],
      { ...scoped, XDG_CONFIG_HOME: join(fixtureDirectory, "never-added") },
      "NAME_REQUIRED",
    ],
    [
      "malformed command input",
      ["--json", "invoke", "organizations.create", "--input", `@${malformedInput}`],
      scoped,
      "INVALID_INPUT_JSON",
    ],
    [
      "a missing input file",
      [
        "--json",
        "invoke",
        "organizations.create",
        "--input",
        `@${join(fixtureDirectory, "absent.json")}`,
      ],
      scoped,
      "INPUT_FILE_NOT_FOUND",
    ],
    [
      "command input missing outside a terminal",
      ["--json", "invoke", "organizations.create"],
      scoped,
      "INPUT_REQUIRED",
    ],
    [
      "an Organization missing outside a terminal",
      ["--json", "connect", "openai", "--label", "OpenAI"],
      scoped,
      "ORGANIZATION_REQUIRED",
    ],
    [
      "a model account name missing outside a terminal",
      ["--json", "connect", "openai", "--organization", "0198a0b0-0000-7000-8000-000000000001"],
      scoped,
      "LABEL_REQUIRED",
    ],
    [
      "an unparseable API origin",
      ["--json", "commands"],
      { ...scoped, DEVBOXES_API_URL: "not a url" },
      "INVALID_API_URL",
    ],
    [
      "an empty delegation token",
      ["--json", "commands"],
      { DEVBOXES_API_URL: undefined, DEVBOXES_TOKEN: "" },
      "INVALID_DEVBOXES_TOKEN",
    ],
    [
      "a delegation token without an API origin in a source run",
      ["--json", "commands"],
      { DEVBOXES_API_URL: undefined, DEVBOXES_TOKEN: "scoped" },
      "API_URL_REQUIRED",
    ],
  ])("reports %s with its own error code", async (_case, args, env, code) => {
    const result = await runCli(
      ["--config", join(fixtureDirectory, "absent-config.json"), ...args],
      env,
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code } });
  });
});

describe("devboxes invoke", () => {
  const traceparents: (string | null)[] = [];
  const apiTraceresponse = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
  const authorizations: (string | null)[] = [];
  // About 150 KB of output, like the Production failure. Bun writes 256 KiB and more another way.
  // Each text starts with a C1 control sequence, which JSON.stringify leaves unescaped.
  const events = Array.from({ length: 600 }, (_, index) => ({
    index,
    text: `\u009b1m${"x".repeat(200)}`,
  }));
  let eventsServed = Promise.withResolvers<void>();
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      traceparents.push(request.headers.get("traceparent"));
      authorizations.push(request.headers.get("authorization"));
      if (pathname === "/api/openapi/json")
        return Response.json({
          openapi: "3.0.3",
          paths: {
            "/api/commands/sessions/dispatch": {
              post: {
                operationId: "sessions.dispatch",
                "x-devboxes": {
                  effect: "write",
                  roles: ["owner", "admin", "member", "reviewer", "viewer"],
                  authority: "Organization member",
                },
                responses: {},
              },
            },
            "/api/commands/sessions/list": {
              post: {
                operationId: "sessions.list",
                "x-devboxes": {
                  effect: "read",
                  roles: ["owner", "admin", "member", "reviewer", "viewer"],
                  authority: "Organization member",
                },
                responses: {},
              },
            },
            "/api/commands/delegations/create": {
              post: {
                operationId: "delegations.create",
                "x-devboxes": {
                  effect: "write",
                  roles: ["owner", "admin", "member", "reviewer", "viewer"],
                  authority: "Current account session",
                },
                responses: {},
              },
            },
            "/api/commands/sessions/events": {
              post: {
                operationId: "sessions.events",
                "x-devboxes": {
                  effect: "read",
                  roles: ["owner", "admin", "member", "reviewer", "viewer"],
                  authority: "Organization member",
                },
                responses: {},
              },
            },
            "/api/commands/sessions/inspect": {
              post: {
                operationId: "sessions.inspect",
                "x-devboxes": {
                  effect: "read",
                  roles: ["owner", "admin", "member", "reviewer", "viewer"],
                  authority: "Organization member",
                },
                responses: {},
              },
            },
          },
        });
      if (pathname === "/api/commands/sessions/inspect") {
        const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        return Response.json({
          output: [token, encodeURIComponent(token), Buffer.from(`:${token}`).toString("base64")],
        });
      }
      if (pathname === "/api/commands/sessions/events") {
        eventsServed.resolve();
        return Response.json(events, { headers: { "x-request-id": "request-events" } });
      }
      if (pathname === "/api/commands/sessions/list")
        return Response.json([], {
          headers: { "x-request-id": "request-list", traceresponse: apiTraceresponse },
        });
      if (pathname === "/api/commands/delegations/create")
        return Response.json(
          { delegation: { expiresAt: null }, token: "devboxes_delegate_ci", warning },
          { status: 201 },
        );
      return Response.json(
        {
          error: {
            code: "CONCURRENT_MODIFICATION",
            message: "The command conflicted with another change. Submit it again.",
          },
        },
        { status: 409 },
      );
    },
  });
  afterAll(() => api.stop(true));
  const dispatchInput = join(fixtureDirectory, "dispatch.json");
  const connection = { DEVBOXES_API_URL: api.url.origin, DEVBOXES_TOKEN: "scoped" };
  const dispatch = ["invoke", "sessions.dispatch", "--input", `@${dispatchInput}`];
  const warning = "This token never expires. Revoke it when you no longer need it.";

  it("connects with only DEVBOXES_TOKEN to --api or the embedded API origin", async () => {
    await writeFile(dispatchInput, "{}");
    const list = ["--json", "invoke", "sessions.list", "--input", `@${dispatchInput}`];
    const tokenOnly = { DEVBOXES_API_URL: undefined, DEVBOXES_TOKEN: "devboxes_delegate_ci" };
    authorizations.length = 0;
    const selected = await runCli(["--api", api.url.origin, ...list], tokenOnly);
    const embedded = await runCli(list, tokenOnly, api.url.origin);

    for (const result of [selected, embedded]) {
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 200, data: [] });
    }
    expect(new Set(authorizations)).toEqual(new Set(["Bearer devboxes_delegate_ci"]));
  });

  it("prints no form of its token that a result quotes", async () => {
    await writeFile(dispatchInput, "{}");
    const token = "devboxes_delegate_a+b/c=d?e";
    const result = await runCli(
      ["--json", "invoke", "sessions.inspect", "--input", `@${dispatchInput}`],
      { DEVBOXES_API_URL: api.url.origin, DEVBOXES_TOKEN: token },
    );

    expect(result.exitCode).toBe(0);
    const { output } = JSON.parse(result.stdout).data;
    expect(output).toHaveLength(3);
    for (const [index, read] of [
      (printed: string) => printed,
      decodeURIComponent,
      (printed: string) => Buffer.from(printed, "base64").toString("latin1"),
    ].entries()) {
      expect(output[index]).toContain("[redacted]");
      expect(read(output[index])).not.toContain(token);
    }
  });

  it("sends a delegation token to --api ahead of DEVBOXES_API_URL", async () => {
    await writeFile(dispatchInput, "{}");
    const result = await runCli(
      [
        "--json",
        "--api",
        api.url.origin,
        "invoke",
        "sessions.list",
        "--input",
        `@${dispatchInput}`,
      ],
      { DEVBOXES_API_URL: unusedOrigin, DEVBOXES_TOKEN: "devboxes_delegate_ci" },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 200, data: [] });
  });

  it("reports a concurrent modification as retryable", async () => {
    await writeFile(dispatchInput, "{}");
    const human = await runCli(dispatch, connection);
    const json = await runCli(["--json", ...dispatch], connection);

    expect(human.exitCode).toBe(1);
    expect(human.stderr).toStartWith("CONCURRENT_MODIFICATION (HTTP 409, retryable): ");
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.stderr)).toMatchObject({
      error: { code: "CONCURRENT_MODIFICATION", retryable: true },
      status: 409,
    });
  });

  it("prints the warning of a result on stderr and keeps it in the result", async () => {
    await writeFile(dispatchInput, "{}");
    const create = ["invoke", "delegations.create", "--input", `@${dispatchInput}`];
    const human = await runCli(create, connection);
    const json = await runCli(["--json", ...create], connection);

    expect(human.exitCode).toBe(0);
    expect(human.stderr).toBe(`Warning: ${warning}\n`);
    expect(JSON.parse(human.stdout).data.warning).toBe(warning);
    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout).data.warning).toBe(warning);
  });

  // Bun.spawn gives a child a socket pair, so the CLI writes into a shell pipe to cat instead. The
  // test reads cat a second after the API answered, so the CLI's write meets a full pipe.
  it("writes output larger than a pipe buffer exactly once to a reader that starts late", async () => {
    await writeFile(dispatchInput, "{}");
    const outputFile = join(fixtureDirectory, "events.json");
    const statusFile = join(fixtureDirectory, "events.status");
    const command = [
      process.execPath,
      "src/cli.ts",
      "invoke",
      "sessions.events",
      "--input",
      `@${dispatchInput}`,
    ];
    const options = {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        ...connection,
        TRACEPARENT: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
      stdin: "ignore",
      stderr: "ignore",
    } as const;
    const toFile = Bun.spawn(command, { ...options, stdout: Bun.file(outputFile) });
    expect(await toFile.exited).toBe(0);
    const expected = await Bun.file(outputFile).bytes();
    eventsServed = Promise.withResolvers<void>();
    const toPipe = Bun.spawn(
      [
        "sh",
        "-c",
        'status_file=$1; shift; { "$@"; echo $? > "$status_file"; } | cat',
        "sh",
        statusFile,
        ...command,
      ],
      { ...options, stdout: "pipe" },
    );
    await eventsServed.promise;
    await Bun.sleep(1_000);
    const received = await new Response(toPipe.stdout).bytes();

    await toPipe.exited;
    expect((await Bun.file(statusFile).text()).trim()).toBe("0");
    expect(expected.length).toBeGreaterThan(64 * 1024);
    expect(JSON.parse(new TextDecoder().decode(expected)).data).toEqual(events);
    expect(received.length).toBe(expected.length);
    expect(Buffer.from(received).equals(Buffer.from(expected))).toBe(true);
  });

  it("joins TRACEPARENT, sends no traceparent without one, and reports the trace the API names", async () => {
    await writeFile(dispatchInput, "{}");
    const list = ["--json", "invoke", "sessions.list", "--input", `@${dispatchInput}`];
    const callerTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    traceparents.length = 0;
    const joined = await runCli(list, { ...connection, TRACEPARENT: callerTraceparent });
    const joinedTraceparents = traceparents.splice(0);
    const unjoined = await runCli(list, { ...connection, TRACEPARENT: undefined });

    expect(joinedTraceparents.length).toBeGreaterThan(0);
    expect(new Set(joinedTraceparents)).toEqual(new Set([callerTraceparent]));
    expect(traceparents.length).toBeGreaterThan(0);
    expect(new Set(traceparents)).toEqual(new Set([null]));
    for (const result of [joined, unjoined])
      expect(JSON.parse(result.stdout)).toEqual({
        status: 200,
        data: [],
        traceId: "0af7651916cd43dd8448eb211c80319c",
        requestId: "request-list",
      });
  });
});

describe("devboxes commands", () => {
  type Contract = {
    effect: "write";
    elevated?: boolean;
    elevation?: string;
    roles?: string[];
    authority: string;
  };
  const document = (contract: Contract) => ({
    openapi: "3.0.3",
    paths: {
      "/api/commands/billing/portal": {
        post: { operationId: "billing.portal", "x-devboxes": contract, responses: {} },
      },
    },
  });
  const list = async (contract: Contract) => {
    using api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json(document(contract)),
    });
    return await runCli(["commands"], {
      DEVBOXES_API_URL: api.url.origin,
      DEVBOXES_TOKEN: "scoped",
    });
  };

  it("lists an elevated write, and one that leaves `elevated` out, ignoring fields a newer API adds", async () => {
    const contracts: Contract[] = [
      { effect: "write", elevated: true, elevation: "money", roles: ["owner"], authority: "Owner" },
      { effect: "write", roles: ["owner"], authority: "Organization owner" },
    ];
    for (const contract of contracts) {
      const listed = await list(contract);
      expect(listed.stdout).toBe("billing.portal\twrite\n");
      expect(listed.exitCode).toBe(0);
    }
  });

  it("refuses a document whose write serves `elevated` as anything but true, or no roles, as an older API's", async () => {
    const contracts: Contract[] = [
      { effect: "write", elevated: false, roles: ["owner"], authority: "Organization owner" },
      { effect: "write", authority: "Organization owner" },
    ];
    for (const contract of contracts) {
      const listed = await list(contract);
      expect(listed.stderr).toContain("This devboxes CLI needs a newer devboxes API.");
      expect(listed.exitCode).not.toBe(0);
    }
  });
});

describe("devboxes invoke in a terminal", () => {
  const organizations = [
    { id: "0198a0b0-0000-7000-8000-00000000000a", name: "Acme" },
    { id: "0198a0b0-0000-7000-8000-00000000000b", name: "Side project" },
  ];
  const projects = [
    { id: "0198a0b0-0000-7000-8000-0000000000c1", name: "Operations" },
    { id: "0198a0b0-0000-7000-8000-0000000000c2", name: "Website" },
  ];
  const uuid = { type: "string", pattern: "^[0-9a-f-]{36}$" };
  const operation = (operationId: string, schema: JsonValue) => ({
    post: {
      operationId,
      "x-devboxes": {
        effect: "write",
        roles: ["owner", "admin", "member", "reviewer", "viewer"],
        authority: "Organization member",
      },
      requestBody: { content: { "application/json": { schema } } },
      responses: {},
    },
  });
  const requests: { path: string; body: unknown }[] = [];
  let projectsRefused = false;
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/openapi/json")
        return Response.json({
          openapi: "3.0.3",
          paths: {
            "/api/commands/organizations/list": operation("organizations.list", {
              type: "object",
              properties: {},
            }),
            "/api/commands/projects/list": operation("projects.list", {
              type: "object",
              properties: { organizationId: uuid },
              required: ["organizationId"],
            }),
            "/api/commands/sessions/dispatch": operation("sessions.dispatch", {
              type: "object",
              properties: {
                organizationId: uuid,
                projectId: uuid,
                title: { type: "string", minLength: 1, maxLength: 300 },
                instruction: { type: "string", minLength: 1, maxLength: 100000 },
                blueprint: {
                  type: "string",
                  description:
                    "Name of the Blueprint that runs the work. Without it, the work uses the Project's Blueprint.",
                },
                awaitWorkspaceImage: { type: "boolean" },
              },
              required: ["organizationId", "projectId", "title", "instruction"],
            }),
            "/api/commands/connections/add": operation("connections.add", {
              type: "object",
              properties: {
                organizationId: uuid,
                label: { type: "string", minLength: 1 },
                limit: {
                  type: ["integer", "null"],
                  minimum: 1,
                  description: "The most tasks at once.",
                },
                auth: {
                  anyOf: [
                    {
                      type: "object",
                      properties: {
                        type: { const: "api" },
                        key: { type: "string", writeOnly: true },
                      },
                      required: ["type", "key"],
                    },
                    {
                      type: "object",
                      properties: { type: { const: "oauth" }, refresh: { type: "boolean" } },
                      required: ["type", "refresh"],
                    },
                  ],
                },
                scopes: { type: "array", items: { enum: ["read", "write"] } },
                tier: {
                  anyOf: [
                    { const: "standard", type: "string" },
                    { const: "priority", type: "string" },
                  ],
                },
              },
              required: ["organizationId", "label", "limit", "auth", "scopes", "tier"],
            }),
          },
        });
      const body = await request.json();
      requests.push({ path: pathname, body });
      if (pathname === "/api/commands/organizations/list") return Response.json({ organizations });
      if (pathname === "/api/commands/projects/list")
        return projectsRefused
          ? Response.json(
              { error: { code: "FORBIDDEN", message: "Only members can list Projects." } },
              { status: 403 },
            )
          : Response.json(projects);
      return Response.json({ sessionId: "session-1" });
    },
  });
  afterAll(() => api.stop(true));
  const connection = { DEVBOXES_API_URL: api.url.origin, DEVBOXES_TOKEN: "person" };

  it("asks for the input field by field, with pickers for listed IDs, and offers the optional fields", async () => {
    requests.length = 0;
    const cli = await inTerminal(["invoke", "sessions.dispatch"], connection);

    expect(await cli.shows("Side project")).toBe(true);
    cli.type("\r");
    expect(await cli.shows("Website")).toBe(true);
    cli.type("\x1b[B\r");
    expect(await cli.shows("title")).toBe(true);
    cli.type("Churn report\r");
    expect(await cli.shows("instruction")).toBe(true);
    cli.type("Write this week's churn report.\r\r");
    expect(await cli.shows("Also set")).toBe(true);
    cli.type(" \r");
    expect(await cli.shows("blueprint: Name of the Blueprint that runs the work.")).toBe(true);
    cli.type("Weekly churn report\r");
    const exitCode = await cli.exited();
    cli.kill();

    expect(exitCode).toBe(0);
    expect(cli.screen()).toContain('"sessionId": "session-1"');
    expect(requests).toEqual([
      { path: "/api/commands/organizations/list", body: {} },
      { path: "/api/commands/projects/list", body: { organizationId: organizations[0]?.id } },
      {
        path: "/api/commands/sessions/dispatch",
        body: {
          organizationId: organizations[0]?.id,
          projectId: projects[1]?.id,
          title: "Churn report",
          instruction: "Write this week's churn report.",
          blueprint: "Weekly churn report",
        },
      },
    ]);
  });

  it("asks for an ID by typing when its list refuses", async () => {
    requests.length = 0;
    projectsRefused = true;
    const cli = await inTerminal(["invoke", "sessions.dispatch"], connection);

    expect(await cli.shows("Side project")).toBe(true);
    cli.type("\r");
    expect(await cli.shows("projectId")).toBe(true);
    cli.type(`${projects[0]?.id}\r`);
    expect(await cli.shows("title")).toBe(true);
    cli.type("Churn report\r");
    expect(await cli.shows("instruction")).toBe(true);
    cli.type("Write this week's churn report.\r\r");
    expect(await cli.shows("Also set")).toBe(true);
    cli.type("\r");
    const exitCode = await cli.exited();
    cli.kill();
    projectsRefused = false;

    expect(exitCode).toBe(0);
    expect(requests.at(-1)).toEqual({
      path: "/api/commands/sessions/dispatch",
      body: {
        organizationId: organizations[0]?.id,
        projectId: projects[0]?.id,
        title: "Churn report",
        instruction: "Write this week's churn report.",
      },
    });
  });

  it("asks which kind a union is, whether to set a nullable field, and which values an enum list holds, and masks a secret", async () => {
    requests.length = 0;
    const key = `sk-test-${crypto.randomUUID()}`;
    const cli = await inTerminal(["invoke", "connections.add"], connection);

    expect(await cli.shows("Side project"), cli.screen()).toBe(true);
    cli.type("\x1b[B\r");
    expect(await cli.shows("label")).toBe(true);
    cli.type("Claude\r");
    expect(await cli.shows("Set limit")).toBe(true);
    cli.type("\r");
    expect(await cli.shows("limit: The most tasks at once.")).toBe(true);
    cli.type("5\r");
    expect(await cli.shows("type oauth")).toBe(true);
    cli.type("\r");
    expect(await cli.shows("auth.key")).toBe(true);
    cli.type(`${key}\r`);
    expect(await cli.shows("scopes")).toBe(true);
    cli.type("\x1b[B \r");
    expect(await cli.shows("priority")).toBe(true);
    cli.type("\x1b[B\r");
    const exitCode = await cli.exited();
    cli.kill();

    expect(exitCode).toBe(0);
    expect(cli.screen()).not.toContain(key);
    expect(requests.at(-1)).toEqual({
      path: "/api/commands/connections/add",
      body: {
        organizationId: organizations[1]?.id,
        label: "Claude",
        limit: 5,
        auth: { type: "api", key },
        scopes: ["write"],
        tier: "priority",
      },
    });
  });
});

describe("devboxes connect", () => {
  const organizationId = "0198a0b0-0000-7000-8000-000000000001";
  const code = `pasted-code-${crypto.randomUUID()}#state`;
  const key = `sk-ant-api03-${crypto.randomUUID()}`;
  const managersOnly = "Only an Organization owner or admin can connect a model account.";
  let manages = true;
  let completeAnswers: object[] = [];
  const starts: unknown[] = [];
  const completions: unknown[] = [];
  const accountWrites: { operation: string; body: unknown }[] = [];
  const operation = (operationId: string) => ({
    post: {
      operationId,
      "x-devboxes": {
        effect: "write",
        roles: ["owner", "admin"],
        authority: "Organization owner or admin",
      },
      responses: {},
    },
  });
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/openapi/json")
        return Response.json({
          openapi: "3.0.3",
          paths: Object.fromEntries(
            [
              "providers.list",
              "providers.connect-start",
              "providers.connect-complete",
              "connections.add",
              "connections.update",
              "organizations.list",
            ].map((operationId) => [
              `/api/commands/${operationId.replace(".", "/")}`,
              operation(operationId),
            ]),
          ),
        });
      if (pathname === "/api/commands/organizations/list")
        return Response.json({ organizations: [{ id: organizationId, name: "Acme" }] });
      if (pathname === "/api/commands/providers/list") {
        const unavailable = manages ? null : managersOnly;
        return Response.json([
          { id: "openai", name: "OpenAI", deviceFlow: true, apiKey: true, unavailable },
          {
            id: "claude-subscription",
            name: "Claude subscription",
            deviceFlow: true,
            apiKey: false,
            unavailable,
          },
          { id: "anthropic", name: "Anthropic", deviceFlow: false, apiKey: true, unavailable },
          { id: "xai", name: "xAI", deviceFlow: true, apiKey: true, unavailable: managersOnly },
          { id: "local", name: "Local", deviceFlow: false, apiKey: false, unavailable },
          { id: "handler", name: "Handler", deviceFlow: true, apiKey: false, unavailable },
        ]);
      }
      if (pathname === "/api/commands/providers/connect-start") {
        const body = await request.json();
        starts.push(body);
        return Response.json({
          attemptId: "attempt-1",
          userCode: ["openai", "handler"].includes(body.providerId) ? "ABCD-1234" : null,
          verificationUrl:
            body.providerId === "handler"
              ? "file:///Applications/Calculator.app"
              : `https://sign-in.example/${body.providerId}?state=state`,
          intervalSeconds: 0,
          expiresAt: null,
        });
      }
      if (pathname === "/api/commands/providers/connect-complete") {
        completions.push(await request.json());
        return Response.json(
          completeAnswers.shift() ?? { status: "completed", accountId: "account-1" },
        );
      }
      accountWrites.push({ operation: pathname, body: await request.json() });
      return Response.json({
        id: "account-2",
        providerId: "anthropic",
        label: "Anthropic",
        authType: "api",
        accountLabel: null,
        version: 1,
      });
    },
  });
  afterAll(() => api.stop(true));
  const connectTo = (...args: string[]) => [
    "connect",
    ...args,
    "--organization",
    organizationId,
    "--label",
    "Claude",
  ];
  const connection = { DEVBOXES_API_URL: api.url.origin, DEVBOXES_TOKEN: "connect-token" };
  const reset = () => {
    manages = true;
    completeAnswers = [];
    starts.length = 0;
    completions.length = 0;
    accountWrites.length = 0;
  };
  it("shows the sign-in URL, sends the pasted code, and never prints the code", async () => {
    reset();
    const result = await runCli(
      connectTo("claude-subscription"),
      connection,
      undefined,
      `${code}\n`,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Open https://sign-in.example/claude-subscription?state=state");
    expect(result.stdout).toBe("Connected Claude as model account account-1.\n");
    expect(`${result.stdout}${result.stderr}`).not.toContain(code);
    expect(completions).toEqual([{ organizationId, attemptId: "attempt-1", code }]);
  });

  it("refuses a provider the person can't connect, with the reason, before it starts a sign-in or reads a key", async () => {
    reset();
    manages = false;
    const signIn = await runCli(
      connectTo("claude-subscription"),
      connection,
      undefined,
      `${code}\n`,
    );
    const apiKey = await runCli(connectTo("anthropic"), connection, undefined, `${key}\n`);

    for (const result of [signIn, apiKey]) {
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toStartWith(`PROVIDER_UNAVAILABLE: ${managersOnly}`);
      expect(result.stderr).not.toContain("Open ");
    }
    expect(starts).toEqual([]);
    expect(accountWrites).toEqual([]);
  });

  it("refuses a provider that takes neither a sign-in nor an API key, before it reads a key", async () => {
    reset();
    const result = await runCli(connectTo("local"), connection, undefined, `${key}\n`);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toStartWith("PROVIDER_NOT_CONNECTABLE");
    expect(accountWrites).toEqual([]);
  });

  it("refuses a sign-in URL that is not HTTP, before it shows or opens it", async () => {
    reset();
    const cli = await inTerminal(connectTo("handler"), connection);
    const exitCode = await cli.exited();
    cli.kill();

    expect(exitCode).toBe(1);
    expect(cli.screen()).toContain("INVALID_RESPONSE");
    expect(cli.screen()).not.toContain("file:");
    expect(await cli.opened()).toBe(false);
    expect(completions).toEqual([]);
  });

  it("polls a device sign-in until the provider approves it, and fails when the provider refuses", async () => {
    reset();
    completeAnswers = [
      { status: "pending", intervalSeconds: 0 },
      { status: "pending", intervalSeconds: 0 },
    ];
    const approved = await runCli(connectTo("openai"), connection);
    const approvals = completions.length;
    completeAnswers = [{ status: "pending", intervalSeconds: 0 }, { status: "failed" }];
    const refused = await runCli(connectTo("openai"), connection);

    expect(approved.exitCode).toBe(0);
    expect(approved.stderr).toContain("https://sign-in.example/openai?state=state");
    expect(approved.stderr).toContain("ABCD-1234");
    expect(approved.stdout).toBe("Connected Claude as model account account-1.\n");
    expect(approvals).toBe(3);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("CONNECTION_FAILED");
    expect(completions).toHaveLength(5);
  });

  it("connects an API key from stdin through connections.add, also to a provider with a sign-in, replaces one with --account, and never prints it", async () => {
    reset();
    const added = await runCli(connectTo("anthropic"), connection, undefined, `${key}\n`);
    const replaced = await runCli(
      [...connectTo("anthropic"), "--account", "account-2"],
      connection,
      undefined,
      `${key}\n`,
    );
    const instead = await runCli(
      [...connectTo("openai"), "--api-key"],
      connection,
      undefined,
      `${key}\n`,
    );
    const signInOnly = await runCli(
      [...connectTo("claude-subscription"), "--api-key"],
      connection,
      undefined,
      `${key}\n`,
    );

    expect(signInOnly.exitCode).toBe(1);
    expect(signInOnly.stderr).toStartWith("API_KEY_UNSUPPORTED");
    expect(signInOnly.stderr).toContain("devboxes connect claude-subscription");
    expect(starts).toEqual([]);
    for (const result of [added, replaced, instead]) {
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Connected Claude as model account account-2.\n");
      expect(`${result.stdout}${result.stderr}`).not.toContain(key);
    }
    expect(accountWrites).toEqual([
      {
        operation: "/api/commands/connections/add",
        body: {
          organizationId,
          providerId: "anthropic",
          label: "Claude",
          auth: { type: "api", key },
        },
      },
      {
        operation: "/api/commands/connections/update",
        body: {
          organizationId,
          accountId: "account-2",
          label: "Claude",
          auth: { type: "api", key },
        },
      },
      {
        operation: "/api/commands/connections/add",
        body: {
          organizationId,
          providerId: "openai",
          label: "Claude",
          auth: { type: "api", key },
        },
      },
    ]);
  });

  it("refuses to read a key or code from a terminal that shows what is typed", async () => {
    reset();
    const cli = await inTerminal([...connectTo("anthropic"), "--json"], connection);

    if ((await cli.exited(5_000)) === null) cli.type(`${key}\r\x04`);
    const exitCode = await cli.exited();
    cli.kill();

    expect(exitCode).toBe(1);
    expect(cli.screen()).toContain("INPUT_REQUIRED");
    expect(cli.screen()).not.toContain(key);
    expect(accountWrites).toEqual([]);
  });

  it("asks for a provider without a terminal to choose one in", async () => {
    reset();
    const result = await runCli(connectTo(), connection);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toStartWith("PROVIDER_REQUIRED");
  });

  it("lets a person choose every provider's sign-in or API key, greys out what they can't connect, and masks the key", async () => {
    reset();
    const cli = await inTerminal(connectTo(), connection);

    expect(await cli.shows("xAI API key")).toBe(true);
    cli.type("\x1b[B\r");
    expect(await cli.shows("Paste the OpenAI API key")).toBe(true);
    cli.type(`${key}\r`);
    const exitCode = await cli.exited();
    cli.kill();

    expect(exitCode).toBe(0);
    for (const option of [
      "OpenAI (browser sign-in)",
      "OpenAI API key",
      "Claude subscription (browser sign-in)",
      "Anthropic API key",
      "xAI (browser sign-in)",
      managersOnly,
    ])
      expect(cli.screen()).toContain(option);
    expect(cli.screen()).not.toContain("Claude subscription API key");
    expect(cli.screen()).toContain("Connected Claude as model account account-2.");
    expect(cli.screen()).not.toContain(key);
    expect(accountWrites).toEqual([
      {
        operation: "/api/commands/connections/add",
        body: {
          organizationId,
          providerId: "openai",
          label: "Claude",
          auth: { type: "api", key },
        },
      },
    ]);
    expect(await cli.opened()).toBe(false);
  });

  it("asks for the Organization and the model account's name when they are missing", async () => {
    reset();
    const cli = await inTerminal(["connect", "anthropic"], connection);

    expect(await cli.shows("Acme")).toBe(true);
    cli.type("\r");
    expect(await cli.shows("Name of the model account")).toBe(true);
    cli.type(" key\r");
    expect(await cli.shows("Paste the Anthropic API key")).toBe(true);
    cli.type(`${key}\r`);
    const exitCode = await cli.exited();
    cli.kill();

    expect(exitCode).toBe(0);
    expect(accountWrites).toEqual([
      {
        operation: "/api/commands/connections/add",
        body: {
          organizationId,
          providerId: "anthropic",
          label: "Anthropic key",
          auth: { type: "api", key },
        },
      },
    ]);
  });

  it("won't connect a greyed-out option that Enter chose", async () => {
    reset();
    manages = false;
    const cli = await inTerminal(connectTo(), connection);

    expect(await cli.shows("xAI (browser sign-in)")).toBe(true);
    cli.type("\r");
    const exitCode = await cli.exited();
    cli.kill();

    expect(exitCode).toBe(1);
    expect(cli.screen()).toContain(`PROVIDER_UNAVAILABLE: ${managersOnly}`);
    expect(cli.screen()).not.toContain("Open ");
    expect(starts).toEqual([]);
    expect(await cli.opened()).toBe(false);
  });
});

describe("devboxes machine add", () => {
  const organizations = [
    { id: "0198a0b0-0000-7000-8000-00000000000a", name: "Acme", role: "owner" },
    { id: "0198a0b0-0000-7000-8000-00000000000c", name: "Client workspace", role: "member" },
    { id: "0198a0b0-0000-7000-8000-00000000000b", name: "Side project", role: "admin" },
  ];
  const registrations: unknown[] = [];
  const refusedKeys = new Set<string>();
  let registerRoles = ["owner", "admin"];
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/openapi/json")
        return Response.json({
          openapi: "3.0.3",
          paths: Object.fromEntries(
            [
              {
                operationId: "organizations.list",
                effect: "read",
                roles: [],
                authority: "Current account session",
              },
              {
                operationId: "capacity.register",
                effect: "write",
                authority: "Organization owner or admin",
                roles: registerRoles,
              },
            ].map(({ operationId, ...contract }) => [
              `/api/commands/${operationId.replace(".", "/")}`,
              { post: { operationId, "x-devboxes": contract, responses: {} } },
            ]),
          ),
        });
      if (pathname === "/api/commands/organizations/list") return Response.json({ organizations });
      if (pathname === "/api/internal/execution/runners/assignments")
        return refusedKeys.has(request.headers.get("authorization")?.replace("Bearer ", "") ?? "")
          ? Response.json(
              { error: { code: "RUNNER_REVOKED", message: "The Runner is unavailable." } },
              { status: 401 },
            )
          : Response.json({ tasks: [] });
      const body = await request.json();
      registrations.push(body);
      return Response.json(
        {
          machine: { id: "machine-1", name: body.name },
          token: `firops_runner_${registrations.length}_${crypto.randomUUID()}`,
        },
        { status: 201 },
      );
    },
  });
  afterAll(() => api.stop(true));
  const platform = process.arch === "arm64" ? "linux/arm64" : "linux/amd64";
  const machineEnvironment = async () => {
    const config = await mkdtemp(join(fixtureDirectory, "machine-"));
    return {
      config,
      tokenFile: join(config, "devboxes", "runner", "token"),
      env: {
        DEVBOXES_API_URL: api.url.origin,
        DEVBOXES_TOKEN: "machine-add-session",
        XDG_CONFIG_HOME: config,
      },
    };
  };

  it("offers the Organizations whose role capacity.register's contract names, names the machine after the computer, saves its key for this user only, and leaves starting for later", async () => {
    registrations.length = 0;
    const { tokenFile, env } = await machineEnvironment();
    const cli = await inTerminal(["machine", "add"], env);

    expect(await cli.shows("Which Organization should run tasks on this machine?")).toBe(true);
    expect(await cli.shows("Side project")).toBe(true);
    cli.type("\x1b[B\r");
    expect(await cli.shows("Name this machine")).toBe(true);
    cli.type("\r");
    expect(await cli.shows("Start this machine now?")).toBe(true);
    cli.type("\x1b[C\r");
    const exitCode = await cli.exited();
    cli.kill();

    const token = (await Bun.file(tokenFile).text()).trim();
    expect(exitCode).toBe(0);
    expect(registrations).toEqual([
      { organizationId: organizations[2]?.id, name: hostname(), platform, cost: null },
    ]);
    expect(token).toStartWith("firops_runner_1_");
    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
    expect(cli.screen()).toContain(tokenFile);
    expect(cli.screen()).toContain("Start it later with: devboxes runner listen");
    expect(cli.screen()).not.toContain(token);
  });

  it("offers no Organization whose role capacity.register's served roles leave out", async () => {
    registerRoles = ["owner"];
    try {
      const { env } = await machineEnvironment();
      const cli = await inTerminal(["machine", "add"], env);
      expect(await cli.shows("Acme")).toBe(true);
      expect(cli.screen()).not.toContain("Side project");
      cli.kill();
    } finally {
      registerRoles = ["owner", "admin"];
    }
  });

  it("adds a machine from flags outside a terminal and refuses to add the same computer twice", async () => {
    registrations.length = 0;
    const { tokenFile, env } = await machineEnvironment();
    const add = [
      "--json",
      "machine",
      "add",
      "--organization",
      organizations[0]?.id ?? "",
      "--name",
      "Build server",
    ];

    const added = await runCli(add, env);
    const again = await runCli(add, env);

    expect(added.exitCode).toBe(0);
    expect(JSON.parse(added.stdout)).toEqual({
      machine: { id: "machine-1", name: "Build server" },
      tokenFile,
    });
    expect(again.exitCode).toBe(1);
    expect(JSON.parse(again.stderr)).toMatchObject({ error: { code: "MACHINE_ALREADY_ADDED" } });
    expect(registrations).toEqual([
      { organizationId: organizations[0]?.id, name: "Build server", platform, cost: null },
    ]);
  });

  it("adds the machine again and replaces the saved key when the API refuses it", async () => {
    registrations.length = 0;
    const { tokenFile, env } = await machineEnvironment();
    const add = [
      "--json",
      "machine",
      "add",
      "--organization",
      organizations[0]?.id ?? "",
      "--name",
      "Build server",
    ];

    await runCli(add, env);
    const removed = (await Bun.file(tokenFile).text()).trim();
    refusedKeys.add(removed);
    const again = await runCli(add, env);

    expect(again.exitCode).toBe(0);
    expect(registrations).toHaveLength(2);
    expect((await Bun.file(tokenFile).text()).trim()).toStartWith("firops_runner_2_");
    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
    expect(again.stderr).toContain(tokenFile);
    expect(again.stderr).not.toContain(removed);
  });
});

describe("devboxes runner listen", () => {
  const runnerTokenFile = join(fixtureDirectory, "runner-token");
  const engine = { name: "Test Engine", gateway: "127.0.0.1" };
  const docker = Bun.serve({
    unix: join(fixtureDirectory, "docker.sock"),
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname.endsWith("/info"))
        return Response.json({ OperatingSystem: engine.name, SecurityOptions: [] });
      if (pathname.endsWith("/networks/bridge"))
        return Response.json({ IPAM: { Config: [{ Gateway: engine.gateway }] } });
      return Response.json({ message: `Unexpected ${pathname}` }, { status: 500 });
    },
  });
  afterAll(() => docker.stop(true));
  const listenTo = async (origin: string) => [
    "--api",
    origin,
    "runner",
    "listen",
    "--token-file",
    runnerTokenFile,
    "--docker-socket",
    join(fixtureDirectory, "docker.sock"),
    "--state-directory",
    await mkdtemp(join(fixtureDirectory, "state-")),
  ];
  const until = async (condition: () => boolean) => {
    while (!condition()) await Bun.sleep(50);
  };
  const spawnListener = async (origin: string, env: Record<string, string | undefined> = {}) => {
    await writeFile(runnerTokenFile, "firops_runner_fixture\n", { mode: 0o600 });
    const listener = Bun.spawn([process.execPath, "src/cli.ts", ...(await listenTo(origin))], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, ...localDocker, ...env },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const output = { stderr: "" };
    const reading = listener.stderr.pipeThrough(new TextDecoderStream()).pipeTo(
      new WritableStream({
        write: (chunk) => {
          output.stderr += chunk;
        },
      }),
    );
    return {
      listener,
      output,
      [Symbol.asyncDispose]: async () => {
        listener.kill();
        await listener.exited;
        await reading;
      },
    };
  };

  it.skipIf(process.platform === "win32")(
    "retries a server error and a 404 after its first successful poll, names an invalid response, and stops without finishing its wait",
    async () => {
      const serve = (failure: {
        path: "assignments" | "claim";
        status: number;
        code: string;
        message: string;
      }) => {
        let failed = false;
        return Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: (request) => {
            const path = new URL(request.url).pathname.split("/").at(-1);
            if (path === failure.path && !failed) {
              failed = true;
              const { status, code, message } = failure;
              return Response.json({ error: { code, message } }, { status });
            }
            return path === "assignments"
              ? Response.json({ tasks: [] })
              : Response.json({ task: { id: "not-a-task" } });
          },
        });
      };
      const serverErrorApi = serve({
        path: "assignments",
        status: 503,
        code: "SERVICE_UNAVAILABLE",
        message: "The API is restarting.",
      });
      const lateNotFoundApi = serve({
        path: "claim",
        status: 404,
        code: "TASK_NOT_FOUND",
        message: "The Task is not assigned.",
      });
      try {
        await using serverError = await spawnListener(serverErrorApi.url.origin);
        await using lateNotFound = await spawnListener(lateNotFoundApi.url.origin);
        const runners = [serverError, lateNotFound];
        await until(() =>
          runners.every(
            (runner) =>
              runner.output.stderr.split("Polling failed").length > 2 ||
              runner.listener.exitCode !== null,
          ),
        );

        expect(serverError.output.stderr).toContain(
          "SERVICE_UNAVAILABLE (HTTP 503): The API is restarting.",
        );
        expect(lateNotFound.output.stderr).toContain(
          "TASK_NOT_FOUND (HTTP 404): The Task is not assigned.",
        );
        for (const runner of runners) {
          expect(runner.output.stderr).toMatch(/claim response .*\/task/);
          const stopping = performance.now();
          runner.listener.kill("SIGTERM");
          expect(await runner.listener.exited).toBe(0);
          expect(performance.now() - stopping).toBeLessThan(2_000);
        }
      } finally {
        await Promise.all([serverErrorApi.stop(true), lateNotFoundApi.stop(true)]);
      }
    },
    30_000,
  );

  it.skipIf(process.platform === "win32").each([
    [401, "RUNNER_TOKEN_REVOKED", "The Runner credential is unavailable."],
    [404, "NOT_FOUND", "The requested route does not exist."],
  ])("stops when its first poll is rejected with HTTP %i", async (status, code, message) => {
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ error: { code, message } }, { status }),
    });
    try {
      await writeFile(runnerTokenFile, "firops_runner_fixture\n", { mode: 0o600 });
      const human = await runCli(await listenTo(api.url.origin), localDocker);
      const json = await runCli(["--json", ...(await listenTo(api.url.origin))], localDocker);

      expect(human.exitCode).toBe(1);
      expect(human.stderr).toBe(`${code} (HTTP ${status}): ${message}\n`);
      expect(json.exitCode).toBe(1);
      expect(JSON.parse(json.stderr)).toMatchObject({ error: { code }, status });
    } finally {
      await api.stop(true);
    }
  });

  it.skipIf(process.platform === "win32")(
    "refuses a Docker engine whose Task containers cannot reach this host, and names it",
    async () => {
      engine.name = "Ubuntu 24.04.3 LTS";
      engine.gateway = "192.0.2.1";
      try {
        await writeFile(runnerTokenFile, "firops_runner_fixture\n", { mode: 0o600 });
        const refused = await runCli(["--json", ...(await listenTo(unusedOrigin))], localDocker);

        expect(refused.exitCode).toBe(1);
        expect(JSON.parse(refused.stderr)).toMatchObject({
          error: {
            code: "DOCKER_ENGINE_UNSUPPORTED",
            message: expect.stringContaining('"Ubuntu 24.04.3 LTS"'),
          },
        });
      } finally {
        engine.name = "Test Engine";
        engine.gateway = "127.0.0.1";
      }
    },
  );

  it.skipIf(process.platform !== "darwin").each([
    [undefined, "DO_NOT_TRACK=1"],
    ["0", "DO_NOT_TRACK=0"],
  ])(
    "polls with DO_NOT_TRACK %p as %s in its process environment, so Bun uploads a crash report only when asked",
    async (configured, polling) => {
      let polled = false;
      using api = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
          polled = true;
          return new URL(request.url).pathname.endsWith("/assignments")
            ? Response.json({ tasks: [] })
            : Response.json({ task: null });
        },
      });
      await using runner = await spawnListener(api.url.origin, { DO_NOT_TRACK: configured });
      await until(() => polled || runner.listener.exitCode !== null);
      const processes = Bun.spawnSync([
        "ps",
        "-E",
        "-ww",
        "-o",
        "command=",
        "-p",
        String(runner.listener.pid),
      ]);

      expect(processes.stdout.toString().split(/\s/)).toContain(polling);
    },
    30_000,
  );
});

describe("devboxes mcp", () => {
  it("invokes an operation the API starts advertising after the server's first discovery", async () => {
    const operation = (operationId: string) => ({
      post: {
        operationId,
        "x-devboxes": {
          effect: "read",
          roles: ["owner", "admin", "member", "reviewer", "viewer"],
          authority: "Organization member",
        },
        responses: {},
      },
    });
    const paths = new Map([["/api/commands/sessions/list", operation("sessions.list")]]);
    const invoked: string[] = [];
    using api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const { pathname } = new URL(request.url);
        if (pathname === "/api/openapi/json")
          return Response.json({ openapi: "3.0.3", paths: Object.fromEntries(paths) });
        invoked.push(pathname);
        return Response.json({ sessionId: "session-1" });
      },
    });
    const client = new Client({ name: "devboxes-cli-test", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["src/cli.ts", "mcp"],
        cwd: join(import.meta.dir, ".."),
        env: {
          PATH: process.env.PATH ?? "",
          DEVBOXES_API_URL: api.url.origin,
          DEVBOXES_TOKEN: "scoped",
        },
      }),
    );
    try {
      const listed = await client.callTool({ name: "devboxes_describe", arguments: {} });
      paths.set("/api/commands/sessions/inspect", operation("sessions.inspect"));
      const inspected = await client.callTool({
        name: "devboxes_invoke",
        arguments: { command: "sessions.inspect", input: {} },
      });

      expect(listed.structuredContent).toEqual({
        commands: [{ operationId: "sessions.list", effect: "read" }],
      });
      expect(inspected.isError).toBeUndefined();
      expect(inspected.structuredContent).toMatchObject({
        status: 200,
        data: { sessionId: "session-1" },
      });
      expect(invoked).toEqual(["/api/commands/sessions/inspect"]);
    } finally {
      await client.close();
    }
  });

  it("lists its tools, refuses invalid arguments with every problem, and rejects an unknown tool", async () => {
    const client = new Client({ name: "devboxes-cli-test", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["src/cli.ts", "mcp"],
        cwd: join(import.meta.dir, ".."),
        env: {
          PATH: process.env.PATH ?? "",
          DEVBOXES_API_URL: "http://127.0.0.1:9",
          DEVBOXES_TOKEN: "scoped",
        },
      }),
    );
    try {
      expect((await client.listTools()).tools).toEqual([
        {
          name: "devboxes_describe",
          description: expect.any(String),
          inputSchema: {
            type: "object",
            properties: { command: { type: "string", minLength: 1 } },
          },
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        {
          name: "devboxes_invoke",
          description: expect.any(String),
          inputSchema: {
            type: "object",
            required: ["command", "input"],
            properties: { command: { type: "string", minLength: 1 }, input: {} },
          },
          annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        },
      ]);
      expect(
        await client.callTool({ name: "devboxes_invoke", arguments: { command: "" } }),
      ).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: "INVALID_INPUT",
            message:
              "The devboxes_invoke input is invalid: / must have required properties input; /command must not have fewer than 1 characters.",
          },
        },
      });
      await expect(
        client.callTool({ name: "devboxes_unknown", arguments: {} }),
      ).rejects.toMatchObject({
        code: -32602,
      });
    } finally {
      await client.close();
    }
  });
});

describe("devboxes failure report", () => {
  it("names the cause of an unexpected failure", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const origin = closed.url.origin;
    await closed.stop(true);

    const result = await runCli(["--json", "commands"], {
      DEVBOXES_API_URL: origin,
      DEVBOXES_TOKEN: "scoped",
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: {
        code: "COMMAND_FAILED",
        message: expect.stringMatching(/^ECONNREFUSED: (?!ECONNREFUSED)/),
      },
    });
  });
});

describe("devboxes signup and login", () => {
  const github = { method: "github", flag: "--github" };
  const google = { method: "google", flag: "--google" };
  const emailCode = { method: "email", flag: "--email <email>" };
  const password = { method: "password", flag: "--email <email> --password-stdin" };
  it.each([
    ["signup", [github, google, password]],
    ["login", [github, google, emailCode, password]],
  ] as const)(
    "%s lists every sign-in method instead of prompting without a terminal",
    async (action, methods) => {
      const result = await runCli([
        "--json",
        "--config",
        join(fixtureDirectory, `${action}.json`),
        "--api",
        "https://api.example.com",
        action,
      ]);

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: {
          code: "SIGN_IN_METHOD_REQUIRED",
          details: { methods },
        },
      });
    },
  );

  it("starts a browser sign-in at the embedded API origin when no origin is selected", async () => {
    const requests: string[] = [];
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        requests.push(new URL(request.url).pathname);
        return Response.json(
          { error: "invalid_client", error_description: "Invalid client ID" },
          { status: 400 },
        );
      },
    });
    try {
      const result = await runCli(
        ["--json", "--config", join(fixtureDirectory, "default-origin.json"), "login", "--github"],
        { DEVBOXES_API_URL: undefined },
        api.url.origin,
      );

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: { code: "invalid_client" },
      });
      expect(requests).toEqual(["/api/auth/device/code"]);
    } finally {
      await api.stop(true);
    }
  });
  it("starts a browser sign-in at DEVBOXES_API_URL, and at --api ahead of it", async () => {
    const requests: string[] = [];
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        requests.push(new URL(request.url).pathname);
        return Response.json(
          { error: "invalid_client", error_description: "Invalid client ID" },
          { status: 400 },
        );
      },
    });
    try {
      const login = ["--json", "login", "--github"];
      const fromEnvironment = await runCli(
        ["--config", join(fixtureDirectory, "environment-origin.json"), ...login],
        { DEVBOXES_API_URL: api.url.origin, DEVBOXES_TOKEN: undefined },
      );
      const fromFlag = await runCli(
        ["--config", join(fixtureDirectory, "flag-origin.json"), "--api", api.url.origin, ...login],
        { DEVBOXES_API_URL: unusedOrigin, DEVBOXES_TOKEN: undefined },
      );

      for (const result of [fromEnvironment, fromFlag]) {
        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "invalid_client" } });
      }
      expect(requests).toEqual(["/api/auth/device/code", "/api/auth/device/code"]);
    } finally {
      await api.stop(true);
    }
  });
  it("keeps waiting for browser approval through a temporary server error", async () => {
    const tokenResponses = [
      Response.json(
        { error: "authorization_pending", error_description: "Authorization pending" },
        { status: 400 },
      ),
      new Response("Bad Gateway", { status: 502 }),
      Response.json({ access_token: "device-session", token_type: "Bearer" }),
    ];
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const { pathname } = new URL(request.url);
        if (pathname === "/api/auth/device/code")
          return Response.json({
            device_code: "device-code",
            user_code: "ABCDEFGH",
            verification_uri_complete: new URL("/device?user_code=ABCDEFGH", request.url).href,
            expires_in: 60,
            interval: 0,
          });
        if (pathname === "/api/auth/device/token")
          return tokenResponses.shift() ?? new Response(null, { status: 500 });
        return Response.json({
          session: {},
          user: { id: "user", email: "device@example.com", name: "Device", emailVerified: true },
        });
      },
    });
    try {
      const result = await runCli([
        "--json",
        "--config",
        join(fixtureDirectory, "device-retry.json"),
        "--api",
        api.url.origin,
        "login",
        "--github",
      ]);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        signedIn: true,
        user: { email: "device@example.com" },
      });
      expect(tokenResponses).toEqual([]);
    } finally {
      await api.stop(true);
    }
  });
  it("asks to check the code, in the page's two halves, and approve the sign-in", async () => {
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const { pathname } = new URL(request.url);
        if (pathname === "/api/auth/device/code")
          return Response.json({
            device_code: "device-code",
            user_code: "ABCDEFGH",
            verification_uri_complete: new URL("/device?user_code=ABCDEFGH", request.url).href,
            expires_in: 60,
            interval: 0,
          });
        if (pathname === "/api/auth/device/token")
          return Response.json({ access_token: "device-session", token_type: "Bearer" });
        return Response.json({
          session: {},
          user: { id: "user", email: "device@example.com", name: "Device", emailVerified: true },
        });
      },
    });
    try {
      const result = await runCli([
        "--config",
        join(fixtureDirectory, "device-text.json"),
        "--api",
        api.url.origin,
        "login",
        "--github",
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(
        `Open ${api.url.origin}/device?user_code=ABCDEFGH&provider=github, check that it shows code ABCD-EFGH, and approve the sign-in.`,
      );
    } finally {
      await api.stop(true);
    }
  });
  it.each([
    ["login", ""],
    ["signup", "&sign_up=true"],
  ] as const)(
    "runs %s --google through the browser approval page that starts Google",
    async (action, signUp) => {
      const api = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
          const { pathname } = new URL(request.url);
          if (pathname === "/api/auth/device/code")
            return Response.json({
              device_code: "device-code",
              user_code: "ABCDEFGH",
              verification_uri_complete: new URL("/device?user_code=ABCDEFGH", request.url).href,
              expires_in: 60,
              interval: 0,
            });
          if (pathname === "/api/auth/device/token")
            return Response.json({ access_token: "device-session", token_type: "Bearer" });
          return Response.json({
            session: {},
            user: { id: "user", email: "google@example.com", name: "Google", emailVerified: true },
          });
        },
      });
      try {
        const result = await runCli([
          "--json",
          "--config",
          join(fixtureDirectory, `device-google-${action}.json`),
          "--api",
          api.url.origin,
          action,
          "--google",
        ]);

        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stderr.trim().split("\n")[0] ?? "")).toEqual({
          verification: {
            url: `${api.url.origin}/device?user_code=ABCDEFGH&provider=google${signUp}`,
            userCode: "ABCDEFGH",
            expiresIn: 60,
          },
        });
        expect(JSON.parse(result.stdout)).toMatchObject({
          signedIn: true,
          user: { email: "google@example.com" },
        });
      } finally {
        await api.stop(true);
      }
    },
  );
  it("stops waiting for browser approval with the error of an unreadable token response", async () => {
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        if (new URL(request.url).pathname === "/api/auth/device/code")
          return Response.json({
            device_code: "device-code",
            user_code: "ABCDEFGH",
            verification_uri_complete: new URL("/device?user_code=ABCDEFGH", request.url).href,
            expires_in: 60,
            interval: 0,
          });
        return new Response("{ not json", { headers: { "content-type": "application/json" } });
      },
    });
    try {
      const result = await runCli([
        "--json",
        "--config",
        join(fixtureDirectory, "device-unreadable.json"),
        "--api",
        api.url.origin,
        "login",
        "--github",
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).not.toContain("expired_token");
    } finally {
      await api.stop(true);
    }
  });
  it.skipIf(process.platform === "win32")(
    "exits after an interactive browser sign-in while the browser opener still runs",
    async () => {
      const openerDirectory = join(fixtureDirectory, "opener");
      const openerPid = join(fixtureDirectory, "opener.pid");
      await mkdir(openerDirectory, { recursive: true });
      for (const name of ["open", "xdg-open"]) {
        await writeFile(
          join(openerDirectory, name),
          `#!/bin/sh\necho $$ > ${openerPid}.tmp\nmv ${openerPid}.tmp ${openerPid}\nexec sleep 30\n`,
          {
            mode: 0o755,
          },
        );
      }
      const api = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          const { pathname } = new URL(request.url);
          if (pathname === "/api/auth/device/code")
            return Response.json({
              device_code: "device-code",
              user_code: "ABCDEFGH",
              verification_uri_complete: new URL("/device?user_code=ABCDEFGH", request.url).href,
              expires_in: 60,
              interval: 0,
            });
          if (pathname === "/api/auth/device/token") {
            while (!(await Bun.file(openerPid).exists())) await Bun.sleep(50);
            return Response.json({ access_token: "device-session", token_type: "Bearer" });
          }
          return Response.json({
            session: {},
            user: { id: "user", email: "device@example.com", name: "Device", emailVerified: true },
          });
        },
      });
      const login = Bun.spawn(
        [
          process.execPath,
          "src/cli.ts",
          "--config",
          join(fixtureDirectory, "opener.json"),
          "--api",
          api.url.origin,
          "login",
          "--github",
        ],
        {
          cwd: join(import.meta.dir, ".."),
          env: { ...process.env, PATH: `${openerDirectory}:${process.env.PATH}` },
          terminal: {},
        },
      );
      try {
        const exited = await Promise.race([login.exited, Bun.sleep(10_000).then(() => null)]);

        expect(exited).toBe(0);
      } finally {
        login.kill();
        await api.stop(true);
        if (await Bun.file(openerPid).exists()) {
          Bun.spawnSync(["kill", await Bun.file(openerPid).text()]);
        }
      }
    },
    20_000,
  );
});

describe("devboxes after a refusal for an old sign-in", () => {
  const requests: string[] = [];
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/openapi/json")
        return Response.json({
          openapi: "3.0.3",
          paths: {
            "/api/commands/organizations/update": {
              post: {
                operationId: "organizations.update",
                "x-devboxes": {
                  effect: "write",
                  elevated: true,
                  roles: ["owner", "admin"],
                  authority: "Organization owner or admin",
                },
                requestBody: {
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          organizationId: { type: "string" },
                          name: { type: "string" },
                        },
                        required: ["organizationId", "name"],
                      },
                    },
                  },
                },
                responses: {},
              },
            },
          },
        });
      const authorization = request.headers.get("authorization");
      requests.push(`${pathname} ${authorization}`);
      if (pathname === "/api/auth/email-otp/send-verification-otp")
        return Response.json({ success: true });
      if (pathname === "/api/commands/account/inspect") {
        const id = authorization === "Bearer other-session" ? "other" : "owner";
        return Response.json({ account: { id, name: id, email: `${id}@example.com` } });
      }
      if (pathname === "/api/auth/sign-in/email-otp") {
        const { email } = (await request.json()) as { email: string };
        const id = email === "other@example.com" ? "other" : "owner";
        const token = id === "other" ? "other-session" : "fresh-session";
        return Response.json(
          { token, user: { id, email, name: id, emailVerified: true } },
          { headers: { "set-auth-token": token } },
        );
      }
      return authorization === "Bearer fresh-session"
        ? Response.json({ id: "organization" })
        : Response.json(
            {
              error: {
                code: "SESSION_NOT_FRESH",
                message:
                  "This change needs a sign-in from the last 10 minutes. Sign in again, then repeat it.",
              },
            },
            { status: 403 },
          );
    },
  });
  afterAll(() => api.stop(true));
  const rename = join(fixtureDirectory, "rename.json");
  /** A saved account config whose session devboxes signed in more than 10 minutes ago. */
  const staleAccount = async (name: string) => {
    const config = join(fixtureDirectory, name);
    await writeFile(
      config,
      JSON.stringify({ apiBaseUrl: `${api.url.origin}/api`, sessionToken: "stale-session" }),
    );
    await chmod(config, 0o600);
    await writeFile(rename, JSON.stringify({ organizationId: "organization", name: "Renamed" }));
    return config;
  };

  it("signs the person in again in a terminal and sends the change once more", async () => {
    requests.length = 0;
    const config = await staleAccount("stale-terminal.json");
    const cli = await inTerminal(
      ["--config", config, "invoke", "organizations.update", "--input", `@${rename}`],
      {},
    );

    expect(await cli.shows("This change needs a recent sign-in.")).toBe(true);
    expect(await cli.shows("Sign in with")).toBe(true);
    cli.type("\x1b[B\x1b[B\r");
    expect(await cli.shows("◇"), cli.screen()).toBe(true);
    cli.type("owner@example.com\r");
    expect(await cli.shows("Code sent to owner@example.com"), cli.screen()).toBe(true);
    cli.type("123456\r");
    const exitCode = await cli.exited();
    cli.kill();

    expect(exitCode).toBe(0);
    expect(cli.screen()).toContain('"id": "organization"');
    expect(requests.filter((sent) => sent.startsWith("/api/commands/"))).toEqual([
      "/api/commands/organizations/update Bearer stale-session",
      "/api/commands/account/inspect Bearer stale-session",
      "/api/commands/account/inspect Bearer fresh-session",
      "/api/commands/organizations/update Bearer fresh-session",
    ]);
  });

  it("doesn't send the change again when the person signs in as another account", async () => {
    requests.length = 0;
    const config = await staleAccount("stale-switch.json");
    const cli = await inTerminal(
      ["--config", config, "invoke", "organizations.update", "--input", `@${rename}`],
      {},
    );

    expect(await cli.shows("Sign in with")).toBe(true);
    cli.type("\x1b[B\x1b[B\r");
    expect(await cli.shows("◇"), cli.screen()).toBe(true);
    cli.type("other@example.com\r");
    expect(await cli.shows("Code sent to other@example.com"), cli.screen()).toBe(true);
    cli.type("123456\r");
    const exitCode = await cli.exited();
    cli.kill();

    expect(exitCode).toBe(1);
    expect(cli.screen()).toContain("ACCOUNT_CHANGED");
    expect(requests.filter((sent) => sent.includes("organizations/update"))).toEqual([
      "/api/commands/organizations/update Bearer stale-session",
    ]);
  });

  it("answers the refusal as it came without a terminal", async () => {
    requests.length = 0;
    const config = await staleAccount("stale-json.json");
    const result = await runCli([
      "--json",
      "--config",
      config,
      "invoke",
      "organizations.update",
      "--input",
      `@${rename}`,
    ]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "SESSION_NOT_FRESH" } });
    expect(requests).toEqual(["/api/commands/organizations/update Bearer stale-session"]);
  });

  it("serves an MCP call with the session a later devboxes login saved", async () => {
    requests.length = 0;
    const config = await staleAccount("stale-mcp.json");
    const client = new Client({ name: "devboxes-cli-test", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["src/cli.ts", "--config", config, "mcp"],
        cwd: join(import.meta.dir, ".."),
        env: { PATH: process.env.PATH ?? "" },
      }),
    );
    const update = () =>
      client.callTool({
        name: "devboxes_invoke",
        arguments: {
          command: "organizations.update",
          input: { organizationId: "organization", name: "Renamed" },
        },
      });
    try {
      const refused = await update();
      await writeFile(
        config,
        JSON.stringify({ apiBaseUrl: `${api.url.origin}/api`, sessionToken: "fresh-session" }),
      );
      const renamed = await update();

      expect(refused.structuredContent).toMatchObject({ error: { code: "SESSION_NOT_FRESH" } });
      expect(renamed.isError).toBeUndefined();
      expect(requests).toEqual([
        "/api/commands/organizations/update Bearer stale-session",
        "/api/commands/organizations/update Bearer fresh-session",
      ]);
    } finally {
      await client.close();
    }
  });
});

describe("CLI API origin", () => {
  it("allows HTTPS and local HTTP without accepting credential or URL escapes", () => {
    expect(apiOrigin("https://api.example.com/api")).toBe("https://api.example.com");
    for (const host of ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"]) {
      expect(apiOrigin(`http://${host}:3000/api`)).toBe(`http://${host}:3000`);
    }
    expect(() => apiOrigin("http://host.docker.internal:3000", "account")).toThrow();
    for (const api of [
      "not a url",
      "file:///srv/devboxes/api",
      "http://devboxes.internal/api",
      "https://user:secret@api.example.com/api",
      "https://api.example.com/api?tenant=1",
      "https://api.example.com/api#fragment",
      "https://api.example.com/other",
    ]) {
      expect(() => apiOrigin(api)).toThrow();
    }
  });
});
