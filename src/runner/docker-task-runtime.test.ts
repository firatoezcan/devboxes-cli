import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Type from "typebox";
import Value from "typebox/value";

// The runtime is exercised against a real Docker Engine API server on a unix
// socket — the same wire dockerode speaks to a live dockerd — so these tests
// pin the actual HTTP contract (paths, queries, bodies) instead of a client
// library's call shapes.
const runnerRuntimeEnv = {
  opencodeConfigDir: undefined as string | undefined,
  opencodeHomeRoot: undefined as string | undefined,
  dockerSocketPath: "/var/run/docker.sock",
};
const daemonApiBaseUrl = "http://host.docker.internal:3001/api";
// A server-authored launch spec as the claim response serves it; this runtime
// executes it and overlays only the machine-local env keys.
const launchSpec = {
  launchProtocol: "devboxes-launch-v6" as const,
  workspaceCapability: "agent-task" as const,
  workingDir: "/workspace",
  entrypoint: "/entrypoint.sh",
  env: {
    HOME: "/home/workspace",
    XDG_CONFIG_HOME: "/home/workspace/.config",
    XDG_DATA_HOME: "/home/workspace/.local/share",
    OPENCODE_CONFIG: "/home/workspace/.config/opencode/opencode.json",
    OPENCODE_EXPERIMENTAL_WORKSPACES: "true",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "/workspace",
    DEVBOX_WORKSPACE_CAPABILITY: "agent-task" as const,
    DEVBOX_WORKSPACE_CAPABILITY_ID: "task_1",
    OPENCODE_WORKSPACE_ID: "wrk_task_1",
    DEVBOX_RUN_ID: "run_1",
    DEVBOX_BACKEND_TOKEN_FILE: "/run/devboxes/secrets/backend-token",
    DEVBOX_DAEMON_PRIVATE_DIR: "/run/devboxes/daemon",
    DEVBOX_DAEMON_VERSION: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    DEVBOX_DAEMON_PLATFORM: "linux/amd64",
    DEVBOX_DAEMON_SHA256: "a".repeat(64),
    DEVBOX_DAEMON_BOOTSTRAP_PROTOCOL: "devboxes-daemon-bootstrap-v1",
  },
  memoryBackedPaths: ["/home/workspace/.local/share"],
  labels: {
    "app.kubernetes.io/managed-by": "firops-control-plane",
    "devboxes.firops.io/daemon-version":
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "devboxes.firops.io/daemon-sha256": "a".repeat(64),
    "devboxes.firops.io/opencode-session-id": "ses_1",
  },
  providerAuthSource: "local-broker" as const,
};
const imageDigest = "d".repeat(64);
const imageRef = `registry-1.docker.io/firatoezcan/devboxes@sha256:${imageDigest}`;
const runningState = {
  Status: "running",
  Running: true,
  OOMKilled: false,
  ExitCode: 0,
  Error: "",
  FinishedAt: "0001-01-01T00:00:00Z",
};

await mock.module("./runtime-env", () => ({
  runnerRuntimeEnv,
}));

type EngineRequest = {
  method: string;
  pathname: string;
  query: Record<string, string>;
  body: unknown;
};

type EngineResponse = { status: number; body?: unknown };

// One request in, one JSON answer out — enough for every engine call the
// runtime makes; image pulls read the (single-chunk) progress stream to EOF.
const startEngineServer = async (
  socketPath: string,
  respond: (request: EngineRequest) => EngineResponse,
) => {
  const requests: EngineRequest[] = [];
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    incoming.on("end", () => {
      const url = new URL(incoming.url ?? "/", "http://docker.invalid");
      const text = Buffer.concat(chunks).toString("utf8");
      const request: EngineRequest = {
        method: incoming.method ?? "GET",
        pathname: decodeURIComponent(url.pathname),
        query: Object.fromEntries(url.searchParams),
        body: text ? JSON.parse(text) : undefined,
      };
      requests.push(request);
      const answered = respond(request);
      response.statusCode = answered.status;
      response.setHeader("Content-Type", "application/json");
      response.end(answered.body === undefined ? "" : JSON.stringify(answered.body));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};

describe("opencode Docker task runtime against the engine API", () => {
  let fixtureDir: string;
  let homeRoot: string;
  let socketPath: string;
  let opencodeConfigJsonBase64: string;
  const writeTaskBackendTokenFile = async () => {
    const secretDir = join(homeRoot, "secrets", "org_1", "task_1");
    await mkdir(secretDir, { recursive: true });
    await writeFile(join(secretDir, "backend-token"), "runner-api-key");
  };
  const expectTaskBackendTokenRemoved = async () => {
    expect(
      await Bun.file(join(homeRoot, "secrets", "org_1", "task_1", "backend-token")).exists(),
    ).toBe(false);
  };

  beforeEach(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "firops-opencode-container-test-"));
    homeRoot = join(fixtureDir, "homes");
    socketPath = join(fixtureDir, "docker.sock");
    const opencodeConfigDir = join(fixtureDir, "opencode-config");
    const opencodeConfigPath = join(opencodeConfigDir, "opencode.json");
    const opencodeConfig = { provider: { deepseek: { npm: "@ai-sdk/deepseek" } } };
    await mkdir(opencodeConfigDir, { recursive: true });
    await writeFile(opencodeConfigPath, JSON.stringify(opencodeConfig));
    opencodeConfigJsonBase64 = Buffer.from(JSON.stringify(opencodeConfig)).toString("base64");

    runnerRuntimeEnv.opencodeConfigDir = opencodeConfigDir;
    runnerRuntimeEnv.opencodeHomeRoot = homeRoot;
    runnerRuntimeEnv.dockerSocketPath = socketPath;
  });

  afterEach(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it("starts dispatch task containers with runner provider auth and no provider secret env", async () => {
    const engine = await startEngineServer(socketPath, (request) => {
      if (request.pathname === "/containers/firops-opencode-task-5f5d08238327/json") {
        return { status: 404, body: { message: "no such container" } };
      }
      if (request.pathname === "/images/create") return { status: 200, body: { status: "done" } };
      if (request.pathname === "/containers/create") {
        return { status: 201, body: { Id: "container_1", Warnings: [] } };
      }
      if (request.pathname === "/containers/container_1/start") return { status: 204 };
      return { status: 500, body: { message: `unexpected ${request.pathname}` } };
    });
    const { DockerOpencodeTaskRuntime } = await import("./docker-task-runtime");
    const runtime = new DockerOpencodeTaskRuntime({ daemonApiBaseUrl });
    await runtime.persistProviderAuthSnapshot({
      organizationId: "org_1",
      taskId: "task_1",
      providerId: "openai",
      providerAuth: { openai: { type: "api", key: "claim-captured-openai-key" } },
      passphrase: "machine-provider-snapshot-passphrase",
    });

    try {
      const container = await runtime.launchTask({
        organizationId: "org_1",
        taskId: "task_1",
        runId: "run_1",
        apiKey: "runner-api-key",
        providerAuthUrl: "http://host.docker.internal:43111",
        imageRef,
        launchSpec,
      });
      expect(container).toMatchObject({
        containerId: "container_1",
        containerName: "firops-opencode-task-5f5d08238327",
        taskId: "task_1",
      });

      const pull = engine.requests.find((request) => request.pathname === "/images/create");
      expect(pull?.query.fromImage).toBe("registry-1.docker.io/firatoezcan/devboxes");
      expect(pull?.query.tag).toBe(`sha256:${imageDigest}`);

      const create = engine.requests.find((request) => request.pathname === "/containers/create");
      assert(create, "Expected a container create request.");
      expect(create.query.name).toBe("firops-opencode-task-5f5d08238327");
      expect(create.body).toMatchObject({
        Image: imageRef,
        WorkingDir: "/workspace",
        Entrypoint: ["/entrypoint.sh"],
        User: "0:1000",
        Labels: {
          "app.kubernetes.io/managed-by": "firops-control-plane",
          "devboxes.firops.io/workload": "opencode-dispatch-task",
          "devboxes.firops.io/organization-id": "org_1",
          "devboxes.firops.io/task-id": "task_1",
          "devboxes.firops.io/daemon-version":
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "devboxes.firops.io/daemon-sha256": "a".repeat(64),
          "devboxes.firops.io/opencode-session-id": "ses_1",
        },
      });
      const createBody = Value.Parse(
        Type.Object(
          {
            Env: Type.Array(Type.String()),
            HostConfig: Type.Object(
              {
                AutoRemove: Type.Boolean(),
                CapDrop: Type.Array(Type.String()),
                CapAdd: Type.Array(Type.String()),
                SecurityOpt: Type.Array(Type.String()),
                ExtraHosts: Type.Array(Type.String()),
                Mounts: Type.Array(
                  Type.Object(
                    {
                      Type: Type.String(),
                      Source: Type.String(),
                      Target: Type.String(),
                      ReadOnly: Type.Boolean(),
                    },
                    { additionalProperties: true },
                  ),
                ),
                Tmpfs: Type.Record(Type.String(), Type.String()),
              },
              { additionalProperties: true },
            ),
          },
          { additionalProperties: true },
        ),
        create.body,
      );
      expect(createBody.HostConfig).toEqual({
        AutoRemove: false,
        CapDrop: ["ALL"],
        CapAdd: ["CHOWN", "DAC_OVERRIDE", "SETGID", "SETUID"],
        SecurityOpt: ["no-new-privileges"],
        Mounts: expect.arrayContaining([
          expect.objectContaining({
            Type: "bind",
            Source: expect.stringMatching(/backend-token$/),
            Target: "/run/devboxes/secrets/backend-token",
            ReadOnly: true,
          }),
          expect.objectContaining({
            Type: "bind",
            Source: expect.stringMatching(/opencode-config\.json$/),
            Target: "/run/devboxes/secrets/opencode-config.json",
            ReadOnly: true,
          }),
        ]),
        Tmpfs: {
          "/run/devboxes/daemon": "rw,noexec,nosuid,size=512m,mode=0700,uid=0,gid=1000",
          "/home/workspace/.local/share": "rw,noexec,nosuid,size=512m,mode=0770,uid=1001,gid=1000",
        },
        ExtraHosts: ["host.docker.internal:host-gateway"],
      });
      const tmpfs = createBody.HostConfig.Tmpfs;
      const repositoryExecutableDirectory = join(
        dirname(launchSpec.env.DEVBOX_DAEMON_PRIVATE_DIR),
        "exec",
      );
      expect(
        Object.entries(tmpfs).some(
          ([path, options]) =>
            options.split(",").includes("noexec") &&
            (repositoryExecutableDirectory === path ||
              repositoryExecutableDirectory.startsWith(`${path}/`)),
        ),
      ).toBe(false);
      expect(createBody.Env).toEqual(
        expect.arrayContaining([
          "DEVBOX_WORKSPACE_CAPABILITY_ID=task_1",
          "DEVBOX_RUN_ID=run_1",
          "DEVBOX_OPENCODE_PROVIDER_AUTH_URL=http://host.docker.internal:43111",
          "DEVBOX_OPENCODE_CONFIG_JSON_FILE=/run/devboxes/secrets/opencode-config.json",
          "DEVBOX_BACKEND_BASE_URL=http://host.docker.internal:3001/api",
          "OPENCODE_READY_MS=120000",
          "DEVBOX_BACKEND_TOKEN_FILE=/run/devboxes/secrets/backend-token",
          "DEVBOX_DAEMON_VERSION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "DEVBOX_DAEMON_PLATFORM=linux/amd64",
          `DEVBOX_DAEMON_SHA256=${"a".repeat(64)}`,
          "DEVBOX_DAEMON_BOOTSTRAP_PROTOCOL=devboxes-daemon-bootstrap-v1",
          "OPENCODE_CONFIG=/home/workspace/.config/opencode/opencode.json",
          "OPENCODE_EXPERIMENTAL_WORKSPACES=true",
          "GIT_CONFIG_COUNT=1",
          "GIT_CONFIG_KEY_0=safe.directory",
          "GIT_CONFIG_VALUE_0=/workspace",
        ]),
      );
      expect(createBody.Env).not.toContain("GIT_CONFIG_VALUE_0=*");
      // No provider key, backend token, or config payload ever rides env.
      const serializedEnv = createBody.Env.join("\n");
      for (const secret of ["runner-api-key", opencodeConfigJsonBase64, "deepseek-key"]) {
        expect(serializedEnv).not.toContain(secret);
      }
      const providerSnapshotPath = join(
        homeRoot,
        "secrets",
        "org_1",
        "task_1",
        "provider-auth.age",
      );
      const encryptedProviderSnapshot = await readFile(providerSnapshotPath, "utf8");
      expect(encryptedProviderSnapshot).not.toContain("claim-captured-openai-key");
      expect(
        await new DockerOpencodeTaskRuntime({ daemonApiBaseUrl }).readProviderAuthSnapshot({
          organizationId: "org_1",
          taskId: "task_1",
          providerId: "openai",
          passphrase: "machine-provider-snapshot-passphrase",
        }),
      ).toEqual({ openai: { type: "api", key: "claim-captured-openai-key" } });
      expect((await stat(providerSnapshotPath)).mode & 0o777).toBe(0o600);
      expect(engine.requests.at(-1)?.pathname).toBe("/containers/container_1/start");
    } finally {
      await engine.close();
    }
  });

  it("removes task secret files when Docker task startup fails", async () => {
    const engine = await startEngineServer(socketPath, (request) => {
      if (request.pathname.endsWith("/json")) {
        return { status: 404, body: { message: "no such container" } };
      }
      if (request.pathname === "/images/create") return { status: 200, body: { status: "done" } };
      return { status: 500, body: { message: "Docker create failed" } };
    });
    const { DockerOpencodeTaskRuntime } = await import("./docker-task-runtime");

    try {
      await assert.rejects(
        new DockerOpencodeTaskRuntime({ daemonApiBaseUrl }).launchTask({
          organizationId: "org_1",
          taskId: "task_1",
          runId: "run_1",
          apiKey: "runner-api-key",
          providerAuthUrl: "http://host.docker.internal:43111",
          imageRef,
          launchSpec,
        }),
        /Docker create failed/,
      );
      await expectTaskBackendTokenRemoved();
    } finally {
      await engine.close();
    }
  });

  it("removes a created container and secrets when Docker start fails", async () => {
    const engine = await startEngineServer(socketPath, (request) => {
      if (request.pathname.endsWith("/json")) {
        return { status: 404, body: { message: "no such container" } };
      }
      if (request.pathname === "/images/create") return { status: 200, body: { status: "done" } };
      if (request.pathname === "/containers/create") {
        return { status: 201, body: { Id: "container_1", Warnings: [] } };
      }
      if (request.pathname === "/containers/container_1/start") {
        return { status: 500, body: { message: "Docker start failed" } };
      }
      if (request.method === "DELETE" && request.pathname === "/containers/container_1") {
        return { status: 204 };
      }
      return { status: 500, body: { message: `unexpected ${request.pathname}` } };
    });
    const { DockerOpencodeTaskRuntime } = await import("./docker-task-runtime");

    try {
      await assert.rejects(
        new DockerOpencodeTaskRuntime({ daemonApiBaseUrl }).launchTask({
          organizationId: "org_1",
          taskId: "task_1",
          runId: "run_1",
          apiKey: "runner-api-key",
          providerAuthUrl: "http://host.docker.internal:43111",
          imageRef,
          launchSpec,
        }),
        /Docker start failed/,
      );
      const cleanup = engine.requests.at(-1);
      expect(cleanup?.method).toBe("DELETE");
      expect(cleanup?.pathname).toBe("/containers/container_1");
      expect(cleanup?.query.force).toBe("true");
      await expectTaskBackendTokenRemoved();
    } finally {
      await engine.close();
    }
  });

  it("recreates the DB-recorded task container with preserved state and current daemon code", async () => {
    const engine = await startEngineServer(socketPath, (request) => {
      if (request.pathname === "/containers/container_old/json") {
        return { status: 200, body: { Id: "container_old", State: runningState } };
      }
      if (request.pathname === "/commit") return { status: 201, body: { Id: "sha256:state" } };
      if (request.method === "DELETE" && request.pathname === "/containers/container_old") {
        return { status: 204 };
      }
      if (request.pathname === "/containers/create") {
        return { status: 201, body: { Id: "container_new", Warnings: [] } };
      }
      if (request.pathname === "/containers/container_new/start") return { status: 204 };
      return { status: 500, body: { message: `unexpected ${request.pathname}` } };
    });
    const { DockerOpencodeTaskRuntime } = await import("./docker-task-runtime");

    try {
      const container = await new DockerOpencodeTaskRuntime({ daemonApiBaseUrl }).launchTask({
        organizationId: "org_1",
        taskId: "task_1",
        runId: "run_1",
        apiKey: "runner-api-key",
        providerAuthUrl: "http://host.docker.internal:43111",
        imageRef,
        launchSpec,
        containerId: "container_old",
      });
      expect(container).toMatchObject({
        containerId: "container_new",
        containerName: "firops-opencode-task-5f5d08238327",
        taskId: "task_1",
      });
      expect(engine.requests.map((request) => request.pathname)).toEqual([
        "/containers/container_old/json",
        "/commit",
        "/containers/container_old",
        "/containers/create",
        "/containers/container_new/start",
      ]);
      const commit = engine.requests[1];
      expect(commit?.query).toMatchObject({
        container: "container_old",
        repo: "firops/opencode-task-state",
        tag: "5f5d08238327",
      });
      // No image pull: the relaunch runs from the committed state snapshot.
      const create = engine.requests[3];
      assert(create);
      expect(create.body).toMatchObject({
        Image: "firops/opencode-task-state:5f5d08238327",
        Entrypoint: ["/entrypoint.sh"],
      });
      expect((create.body as { Env: string[] }).Env).toEqual(
        expect.arrayContaining([
          "DEVBOX_RUN_ID=run_1",
          "DEVBOX_OPENCODE_PROVIDER_AUTH_URL=http://host.docker.internal:43111",
          "DEVBOX_DAEMON_VERSION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "DEVBOX_DAEMON_PLATFORM=linux/amd64",
          `DEVBOX_DAEMON_SHA256=${"a".repeat(64)}`,
        ]),
      );
    } finally {
      await engine.close();
    }
  });

  it("removes a committed state image when relaunch fails after commit", async () => {
    const engine = await startEngineServer(socketPath, (request) => {
      if (request.pathname === "/containers/container_old/json") {
        return { status: 200, body: { Id: "container_old", State: runningState } };
      }
      if (request.pathname === "/commit") return { status: 201, body: { Id: "sha256:state" } };
      if (request.method === "DELETE" && request.pathname === "/containers/container_old") {
        return { status: 204 };
      }
      if (request.pathname === "/containers/create") {
        return { status: 500, body: { message: "Docker create failed" } };
      }
      if (
        request.method === "DELETE" &&
        request.pathname === "/images/firops/opencode-task-state:5f5d08238327"
      ) {
        return { status: 200, body: [] };
      }
      return { status: 500, body: { message: `unexpected ${request.pathname}` } };
    });
    const { DockerOpencodeTaskRuntime } = await import("./docker-task-runtime");

    try {
      await assert.rejects(
        new DockerOpencodeTaskRuntime({ daemonApiBaseUrl }).launchTask({
          organizationId: "org_1",
          taskId: "task_1",
          runId: "run_1",
          apiKey: "runner-api-key",
          providerAuthUrl: "http://host.docker.internal:43111",
          imageRef,
          launchSpec,
          containerId: "container_old",
        }),
        /Docker create failed/,
      );
      const imageCleanup = engine.requests.at(-1);
      expect(imageCleanup?.method).toBe("DELETE");
      expect(imageCleanup?.pathname).toBe("/images/firops/opencode-task-state:5f5d08238327");
      await expectTaskBackendTokenRemoved();
    } finally {
      await engine.close();
    }
  });

  it.each([
    { name: "force stops and removes a task container by recorded id", stopStatus: 204 },
    {
      name: "removes a task container when Docker reports it was already stopped",
      stopStatus: 304,
    },
  ])("$name", async ({ stopStatus }) => {
    const engine = await startEngineServer(socketPath, (request) => {
      if (request.pathname === "/containers/container_old/stop") {
        return { status: stopStatus, body: stopStatus === 304 ? { message: "" } : undefined };
      }
      if (request.method === "DELETE" && request.pathname === "/containers/container_old") {
        return { status: 204 };
      }
      if (request.method === "GET" && request.pathname === "/containers/container_old/json") {
        return { status: 404, body: { message: "no such container" } };
      }
      if (
        request.method === "DELETE" &&
        request.pathname === "/images/firops/opencode-task-state:5f5d08238327"
      ) {
        return { status: 200, body: [] };
      }
      return { status: 500, body: { message: `unexpected ${request.pathname}` } };
    });
    const { DockerOpencodeTaskRuntime } = await import("./docker-task-runtime");
    await writeTaskBackendTokenFile();

    try {
      expect(
        await new DockerOpencodeTaskRuntime({ daemonApiBaseUrl }).stopTask({
          taskId: "task_1",
          containerId: "container_old",
          organizationId: "org_1",
        }),
      ).toEqual({
        containerId: "container_old",
        containerName: "firops-opencode-task-5f5d08238327",
        stopped: true,
      });
      // The committed crash-recovery snapshot dies with the task.
      expect(engine.requests.map((request) => `${request.method} ${request.pathname}`)).toEqual([
        "POST /containers/container_old/stop",
        "DELETE /containers/container_old",
        "GET /containers/container_old/json",
        "DELETE /images/firops/opencode-task-state:5f5d08238327",
      ]);
      await expectTaskBackendTokenRemoved();
    } finally {
      await engine.close();
    }
  });

  it("waits for a Docker container to be absent after remove is accepted", async () => {
    let removed = false;
    let postDeleteInspections = 0;
    const engine = await startEngineServer(socketPath, (request) => {
      if (request.pathname === "/containers/container_old/stop") {
        return { status: 204 };
      }
      if (request.method === "DELETE" && request.pathname === "/containers/container_old") {
        removed = true;
        return { status: 204 };
      }
      if (
        request.method === "GET" &&
        request.pathname === "/containers/container_old/json" &&
        removed
      ) {
        postDeleteInspections += 1;
        return postDeleteInspections === 1
          ? { status: 200, body: { Id: "container_old", State: { Running: true } } }
          : { status: 404, body: { message: "no such container" } };
      }
      if (
        request.method === "DELETE" &&
        request.pathname === "/images/firops/opencode-task-state:5f5d08238327"
      ) {
        return { status: 200, body: [] };
      }
      return { status: 500, body: { message: `unexpected ${request.pathname}` } };
    });
    const { DockerOpencodeTaskRuntime } = await import("./docker-task-runtime");
    await writeTaskBackendTokenFile();

    try {
      await new DockerOpencodeTaskRuntime({ daemonApiBaseUrl }).stopTask({
        taskId: "task_1",
        containerId: "container_old",
        organizationId: "org_1",
      });
      expect(postDeleteInspections).toBe(2);
      await expectTaskBackendTokenRemoved();
    } finally {
      await engine.close();
    }
  });

  it("removes task secret files when force stop finds no Docker container", async () => {
    const engine = await startEngineServer(socketPath, (request) => {
      if (request.pathname === "/containers/firops-opencode-task-5f5d08238327/json") {
        return { status: 404, body: { message: "no such container" } };
      }
      if (request.method === "DELETE" && request.pathname.startsWith("/images/")) {
        return { status: 404, body: { message: "no such image" } };
      }
      return { status: 500, body: { message: `unexpected ${request.pathname}` } };
    });
    const { DockerOpencodeTaskRuntime } = await import("./docker-task-runtime");
    await writeTaskBackendTokenFile();

    try {
      expect(
        await new DockerOpencodeTaskRuntime({ daemonApiBaseUrl }).stopTask({
          taskId: "task_1",
          containerId: null,
          organizationId: "org_1",
        }),
      ).toEqual({
        containerId: null,
        containerName: "firops-opencode-task-5f5d08238327",
        stopped: false,
      });
      await expectTaskBackendTokenRemoved();
    } finally {
      await engine.close();
    }
  });

  it("rewrites the mounted backend-token file in place on re-adoption", async () => {
    const { DockerOpencodeTaskRuntime } = await import("./docker-task-runtime");
    await writeTaskBackendTokenFile();
    const tokenFile = join(homeRoot, "secrets", "org_1", "task_1", "backend-token");

    await new DockerOpencodeTaskRuntime({ daemonApiBaseUrl }).refreshBackendToken({
      organizationId: "org_1",
      taskId: "task_1",
      backendToken: "reconciled-per-task-token",
    });

    expect(await Bun.file(tokenFile).text()).toBe("reconciled-per-task-token");
    const { mode } = await stat(tokenFile);
    expect(mode & 0o777).toBe(0o600);
  });
});
