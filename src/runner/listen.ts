import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { DockerOpencodeTaskRuntime } from "@firops/devbox/runner/docker-task-runtime";
import type { JsonValue } from "@firops/platform/protocol/json";
import { ClaudeCodeArtifactSchema } from "@firops/platform/protocol/task-runtime";
import { proxy } from "hono/proxy";
import { jwtVerify, SignJWT } from "jose";
import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";

import { CommandError, parseResponse, requestJson } from "../commands";

const taskSchema = Type.Object({
  id: Type.String(),
  executorId: Type.Union([Type.String(), Type.Null()]),
  containerId: Type.Union([Type.String(), Type.Null()]),
  image: Type.String(),
  platform: Type.Union([Type.Literal("linux/amd64"), Type.Literal("linux/arm64")]),
  daemon: Type.Object({ sha256: Type.String(), version: Type.String(), url: Type.String() }),
  claudeCode: Type.Union([ClaudeCodeArtifactSchema, Type.Null()]),
  traceparent: Type.String({ minLength: 1 }),
  status: Type.String(),
});
const assignmentSchema = Type.Object({
  id: Type.String(),
  executorId: Type.Union([Type.String(), Type.Null()]),
  containerId: Type.Union([Type.String(), Type.Null()]),
  status: Type.String(),
});
const assignmentsSchema = Type.Object({ tasks: Type.Array(assignmentSchema) });
const claimSchema = Type.Object({ task: Type.Union([taskSchema, Type.Null()]) });
const reconcileSchema = Type.Object({ status: Type.String() });
/** The relay's signing key and port, kept so that running executors outlast a listener restart. */
const relayStateSchema = Type.Object({
  key: Type.String({ minLength: 43 }),
  port: Type.Integer({ minimum: 1, maximum: 65_535 }),
});

/**
 * Runs the Runner. Each executor reaches only this listener's relay, with a token that only the
 * relay accepts. The relay forwards the executor's Task callbacks to the API with the Runner
 * credential and names the token's Task in `devboxes-task`.
 */
export const listen = async (options: {
  apiOrigin: string;
  tokenFile: string;
  stateDirectory: string;
  socketPath: string;
}) => {
  const tokenPath = resolve(options.tokenFile);
  const metadata = await stat(tokenPath).catch(() => null);
  if (!metadata?.isFile() || (metadata.mode & 0o077) !== 0)
    throw new CommandError(
      "INVALID_RUNNER_TOKEN_FILE",
      "The Runner token must be stored in a regular file with mode 0600.",
    );
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (!token)
    throw new CommandError("INVALID_RUNNER_TOKEN_FILE", "The Runner token file is empty.");
  const directory = resolve(options.stateDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const runtime = new DockerOpencodeTaskRuntime({
    socketPath: options.socketPath,
    stateDirectory: directory,
  });
  const engine = await runtime.docker.info();
  const rootless = engine.SecurityOptions.includes("name=rootless");
  let relayReachable = !rootless;
  let hostname = "127.0.0.1";
  if (!rootless && !["Docker Desktop", "OrbStack"].includes(engine.OperatingSystem)) {
    const gateway = (await runtime.docker.getNetwork("bridge").inspect()).IPAM?.Config?.[0]
      ?.Gateway;
    const gatewayIsLocal =
      gateway &&
      (await new Promise<boolean>((resolve) => {
        const socket = createSocket("udp4");
        socket.once("error", () => {
          socket.close();
          resolve(false);
        });
        socket.bind(0, gateway, () => {
          socket.close();
          resolve(true);
        });
      }));
    if (!gateway || !gatewayIsLocal)
      throw new CommandError(
        "DOCKER_ENGINE_UNSUPPORTED",
        `Task containers of the Docker engine "${engine.OperatingSystem}" cannot reach this host. Self-hosted Runners need Docker Desktop, OrbStack or a native Linux Docker Engine.`,
      );
    hostname = gateway;
  }
  const relayStatePath = join(directory, "relay.json");
  const relayState = await readFile(relayStatePath, "utf8").then(
    (text) => Value.Parse(relayStateSchema, JSON.parse(text)),
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  const relayKey = relayState ? Buffer.from(relayState.key, "base64url") : randomBytes(32);
  const relay = Bun.serve({
    hostname,
    port: relayState?.port ?? 0,
    idleTimeout: 0,
    development: false,
    async fetch(request) {
      const { pathname, search } = new URL(request.url);
      if (
        !pathname.startsWith("/api/internal/execution/tasks/") &&
        pathname !== "/api/commands/providers/runtime-read" &&
        pathname !== "/api/commands/providers/runtime-write"
      )
        return Response.json(
          { error: { code: "NOT_RELAYED", message: "The Runner relays only Task callbacks." } },
          { status: 404 },
        );
      const verified = await jwtVerify(
        request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
        relayKey,
        { algorithms: ["HS256"] },
      ).catch(() => null);
      if (!verified?.payload.sub)
        return Response.json(
          {
            error: {
              code: "RUN_TOKEN_INVALID",
              message: "The Run credential does not belong to this Runner.",
            },
          },
          { status: 401 },
        );
      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.set("authorization", `Bearer ${token}`);
      headers.set("devboxes-task", verified.payload.sub);
      return proxy(`${options.apiOrigin}${pathname}${search}`, {
        raw: new Request(request, { headers }),
        redirect: "manual",
      });
    },
  });
  if (!relayState)
    await writeFile(
      relayStatePath,
      JSON.stringify({ key: relayKey.toString("base64url"), port: relay.port }),
      { mode: 0o600 },
    );
  const apiBaseUrl = `http://host.docker.internal:${relay.port}/api`;
  const api = async <Schema extends TSchema>(
    operation: string,
    schema: Schema,
    body: JsonValue,
  ): Promise<Static<Schema>> => {
    const { data } = await requestJson(
      { origin: options.apiOrigin, token },
      `/api/internal/execution/runners/${operation}`,
      body,
    );
    return parseResponse(schema, data, operation);
  };
  let stopping = false;
  const interrupt = () => {
    stopping = true;
  };
  const startCreated = async (task: Static<typeof assignmentSchema>, containerId: string) => {
    const executorId = task.executorId ?? `devboxes-task-${task.id}`;
    const container = runtime.docker.getContainer(containerId);
    const result = await api("reconcile", reconcileSchema, {
      taskId: task.id,
      executorId,
      containerId,
      observation: "created",
    });
    if (result.status !== "running") await container.remove({ v: true });
    else if (!stopping) {
      if (!relayReachable) {
        if (!(await runtime.reaches(task.id, (await container.inspect()).Image, apiBaseUrl)))
          throw new CommandError(
            "DOCKER_ENGINE_UNSUPPORTED",
            'Task containers can\'t reach this Runner. Turn on host loopback for rootless Docker (DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false) and map host.docker.internal to the host loopback address (host-gateway-ips: ["10.0.2.2"] in daemon.json).',
          );
        relayReachable = true;
      }
      if (stopping) return;
      await container.start();
      console.info(`Started Task ${task.id} in ${executorId}.`);
    }
  };
  // Image pulls and executor downloads can outlast the API's heartbeat window, so
  // one start runs beside the poll loop and its failure surfaces on the next cycle.
  const starting = new Map<string, Promise<void>>();
  let startFailure: CommandError | null = null;
  const startClaimed = async (task: Static<typeof taskSchema>) => {
    const existing = await runtime.inspect(task.executorId ?? `devboxes-task-${task.id}`);
    if (!existing) {
      const container = await runtime.create({
        ...task,
        apiBaseUrl,
        token: await new SignJWT()
          .setProtectedHeader({ alg: "HS256" })
          .setSubject(task.id)
          .sign(relayKey),
      });
      await startCreated(task, container.id);
    } else if (existing.State.Status === "created") {
      await startCreated(task, existing.Id);
    }
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let connected = false;
  let failures = 0;
  const endsListener = ({ code, options: { status } }: CommandError) =>
    code === "DOCKER_ENGINE_UNSUPPORTED" ||
    status === 401 ||
    status === 403 ||
    (!connected && (status === 404 || status === 422));
  const poll = async () => {
    try {
      const assignments = await api("assignments", assignmentsSchema, {});
      connected = true;
      for (const task of assignments.tasks) {
        if (stopping) break;
        if (starting.has(task.id)) continue;
        const executorId = task.executorId ?? `devboxes-task-${task.id}`;
        const executor = await runtime.inspect(task.containerId ?? executorId);
        if (!executor) {
          if (
            task.status === "succeeded" ||
            task.status === "cancelled" ||
            task.status === "paused" ||
            task.status === "cancel_requested"
          )
            await rm(join(directory, task.id), { recursive: true, force: true });
          const result = await api("reconcile", reconcileSchema, {
            taskId: task.id,
            executorId: task.executorId,
            containerId: task.containerId,
            observation: "absent",
            observedAt: new Date().toISOString(),
          });
          console.info(`Task ${task.id} ended as ${result.status}; its executor is absent.`);
          continue;
        }
        if (executor.State.Status === "created") {
          await startCreated(task, executor.Id);
          continue;
        }
        const result = await api("reconcile", reconcileSchema, {
          taskId: task.id,
          executorId,
          containerId: executor.Id,
          ...(executor.State.Running
            ? { observation: "running", startedAt: executor.State.StartedAt }
            : {
                observation: "stopped",
                startedAt: executor.State.StartedAt,
                stoppedAt: executor.State.FinishedAt,
              }),
        });
        if (!executor.State.Running) {
          if (
            result.status === "succeeded" ||
            result.status === "cancelled" ||
            result.status === "paused"
          ) {
            await runtime.docker.getContainer(executor.Id).remove({ v: true });
            await rm(join(directory, task.id), { recursive: true, force: true });
          } else {
            console.error(`Retained failed executor ${executorId} for inspection.`);
            console.error(
              `Remove it when you no longer need it: docker rm --volumes ${executorId} && rm -rf '${join(directory, task.id).replaceAll("'", "'\\''")}'`,
            );
          }
          console.info(`Task ${task.id} ended as ${result.status}.`);
        }
      }
      if (stopping) return null;
      if (startFailure !== null) {
        const failure = startFailure;
        startFailure = null;
        throw failure;
      }
      if (starting.size === 0) {
        const { task } = await api("claim", claimSchema, {});
        if (task && !stopping && task.containerId === null)
          starting.set(
            task.id,
            startClaimed(task)
              .then(
                () => {
                  failures = 0;
                },
                (error) => {
                  startFailure = CommandError.from(error);
                },
              )
              .finally(() => {
                starting.delete(task.id);
              }),
          );
      }
      return null;
    } catch (error) {
      if (!(error instanceof CommandError && endsListener(error))) return CommandError.from(error);
      throw error;
    }
  };
  try {
    while (!stopping) {
      const failure = await poll();
      failures = failure ? failures + 1 : starting.size > 0 ? failures : 0;
      const delay = failure
        ? Math.min(60_000, 5_000 * 2 ** failures) * (0.5 + Math.random() / 2)
        : 5_000;
      if (failure)
        console.error(`Polling failed, retrying in ${Math.ceil(delay / 1_000)}s: ${failure}`);
      for (let waited = 0; waited < delay && !stopping; waited += 250) await Bun.sleep(250);
    }
  } finally {
    await Promise.all(starting.values());
    await relay.stop();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
};
