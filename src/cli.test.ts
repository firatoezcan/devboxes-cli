import { afterAll, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apiOrigin } from "./commands";

const runCli = async (args: string[], env: Record<string, string | undefined> = {}) => {
  const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, BROWSER: "none", ...env },
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
  ])("reports %s with its own error code", async (_case, args, env, code) => {
    const result = await runCli(args, env);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code } });
  });
});

describe("devboxes invoke", () => {
  const traceparents: (string | null)[] = [];
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      traceparents.push(request.headers.get("traceparent"));
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
          },
        });
      if (pathname === "/api/commands/sessions/list")
        return Response.json([], { headers: { "x-request-id": "request-list" } });
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

  it("sends a traceparent that joins TRACEPARENT or starts a trace, and reports it", async () => {
    await writeFile(dispatchInput, "{}");
    const list = ["--json", "invoke", "sessions.list", "--input", `@${dispatchInput}`];
    const callerTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    traceparents.length = 0;
    const joined = await runCli(list, { ...connection, TRACEPARENT: callerTraceparent });
    const joinedTraceparents = traceparents.splice(0);
    const started = await runCli(list, { ...connection, TRACEPARENT: undefined });

    expect(joinedTraceparents.length).toBeGreaterThan(0);
    expect(new Set(joinedTraceparents)).toEqual(new Set([callerTraceparent]));
    expect(JSON.parse(joined.stdout)).toEqual({
      status: 200,
      data: [],
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      requestId: "request-list",
    });
    const { traceId } = JSON.parse(started.stdout);
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(traceId).not.toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(traceparents.length).toBeGreaterThan(0);
    for (const traceparent of traceparents)
      expect(traceparent).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-00$`));
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
