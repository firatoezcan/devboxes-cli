import { afterAll, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { apiOrigin } from "./commands";

const runCli = async (
  args: string[],
  env: Record<string, string | undefined> = {},
  embeddedApiOrigin?: string,
) => {
  const define =
    embeddedApiOrigin === undefined
      ? []
      : ["--define", `globalThis.DEVBOXES_DEFAULT_API_ORIGIN=${JSON.stringify(embeddedApiOrigin)}`];
  const child = Bun.spawn([process.execPath, ...define, "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, ...env },
    stdin: "ignore",
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
const scoped = { DEVBOXES_API_URL: "https://api.example.com", DEVBOXES_TOKEN: "scoped" };
const unusedOrigin = "http://127.0.0.1:9";
const listen = ["--json", "--api", "https://api.example.com", "runner", "listen"];
const localDocker = { DOCKER_HOST: undefined, DEVBOX_OPENCODE_DOCKER_SOCKET_PATH: undefined };

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
    ["a missing required option", ["--json", "invoke", "sessions.list"]],
    ["a trailing JSON flag", ["invoke", "sessions.list", "--json"]],
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
  // About 150 KB of output, like the Production failure. Bun 1.4.2 writes 256 KiB and more another way.
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
                "x-devboxes": { effect: "write", authority: "Organization member" },
                responses: {},
              },
            },
            "/api/commands/sessions/list": {
              post: {
                operationId: "sessions.list",
                "x-devboxes": { effect: "read", authority: "Organization member" },
                responses: {},
              },
            },
            "/api/commands/delegations/create": {
              post: {
                operationId: "delegations.create",
                "x-devboxes": { effect: "write", authority: "Current account session" },
                responses: {},
              },
            },
            "/api/commands/sessions/events": {
              post: {
                operationId: "sessions.events",
                "x-devboxes": { effect: "read", authority: "Organization member" },
                responses: {},
              },
            },
          },
        });
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

describe("devboxes runner listen", () => {
  const runnerTokenFile = join(fixtureDirectory, "runner-token");
  const listenTo = (origin: string) => [
    "--api",
    origin,
    "runner",
    "listen",
    "--token-file",
    runnerTokenFile,
    "--docker-socket",
    join(fixtureDirectory, "docker.sock"),
  ];
  const until = async (condition: () => boolean) => {
    while (!condition()) await Bun.sleep(50);
  };
  const spawnListener = async (origin: string) => {
    await writeFile(runnerTokenFile, "firops_runner_fixture\n", { mode: 0o600 });
    const listener = Bun.spawn([process.execPath, "src/cli.ts", ...listenTo(origin)], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, ...localDocker },
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
      const human = await runCli(listenTo(api.url.origin), localDocker);
      const json = await runCli(["--json", ...listenTo(api.url.origin)], localDocker);

      expect(human.exitCode).toBe(1);
      expect(human.stderr).toBe(`${code} (HTTP ${status}): ${message}\n`);
      expect(json.exitCode).toBe(1);
      expect(JSON.parse(json.stderr)).toMatchObject({ error: { code }, status });
    } finally {
      await api.stop(true);
    }
  });
});

describe("devboxes mcp", () => {
  it("invokes an operation the API starts advertising after the server's first discovery", async () => {
    const operation = (operationId: string) => ({
      post: {
        operationId,
        "x-devboxes": { effect: "read", authority: "Organization member" },
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
      error: { code: "COMMAND_FAILED", message: expect.stringContaining("ConnectionRefused") },
    });
  });
});

describe("devboxes signup and login", () => {
  it.each(["signup", "login"])(
    "%s lists every sign-in method instead of prompting without a terminal",
    async (action) => {
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
          details: {
            methods: [
              { method: "github", flag: "--github" },
              { method: "email", flag: "--email <email>" },
            ],
          },
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
            verification_uri_complete: new URL("/api/device?user_code=ABCDEFGH", request.url).href,
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
  it("stops waiting for browser approval with the error of an unreadable token response", async () => {
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        if (new URL(request.url).pathname === "/api/auth/device/code")
          return Response.json({
            device_code: "device-code",
            user_code: "ABCDEFGH",
            verification_uri_complete: new URL("/api/device?user_code=ABCDEFGH", request.url).href,
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
              verification_uri_complete: new URL("/api/device?user_code=ABCDEFGH", request.url)
                .href,
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
