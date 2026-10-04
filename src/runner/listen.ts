import { readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { DockerOpencodeTaskRuntime } from "@firops/devbox/runner/docker-task-runtime";
import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";
import type { z } from "zod";

import { CommandError, invocationTrace, requestJson } from "../commands";

const taskSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  executorId: Type.Union([Type.String(), Type.Null()]),
  containerId: Type.Union([Type.String(), Type.Null()]),
  token: Type.String(),
  image: Type.String(),
  platform: Type.Union([Type.Literal("linux/amd64"), Type.Literal("linux/arm64")]),
  daemon: Type.Object({ sha256: Type.String(), version: Type.String(), url: Type.String() }),
  traceparent: Type.String({ minLength: 1 }),
  status: Type.String(),
});
const assignmentSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  executorId: Type.Union([Type.String(), Type.Null()]),
  containerId: Type.Union([Type.String(), Type.Null()]),
  status: Type.String(),
});
const assignmentsSchema = Type.Object({ tasks: Type.Array(assignmentSchema) });
const claimSchema = Type.Object({ task: Type.Union([taskSchema, Type.Null()]) });
const reconcileSchema = Type.Object({ status: Type.String() });

export const listen = async (options: {
  apiOrigin: string;
  daemonApiBaseUrl: string;
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
  const runtime = new DockerOpencodeTaskRuntime({
    socketPath: options.socketPath,
    apiBaseUrl: options.daemonApiBaseUrl,
    stateDirectory: directory,
  });
  const api = async <Schema extends TSchema>(
    operation: string,
    schema: Schema,
    body: z.core.util.JSONType,
  ): Promise<Static<Schema>> => {
    const { data } = await requestJson(
      { origin: options.apiOrigin, token },
      `/api/internal/execution/runners/${operation}`,
      invocationTrace(),
      body,
    );
    if (Value.Check(schema, data)) return data;
    const [invalid] = Value.Errors(schema, data);
    throw new CommandError(
      "INVALID_RESPONSE",
      `The ${operation} response is invalid at ${invalid?.instancePath || "/"}: ${invalid?.message}.`,
    );
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
    if (result.status !== "running") await container.remove();
    else if (!stopping) {
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
      const container = await runtime.create(task);
      await startCreated(task, container.id);
    } else if (existing.State.Status === "created") {
      await startCreated(task, existing.Id);
    }
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let connected = false;
  let failures = 0;
  const endsListener = ({ options: { status } }: CommandError) =>
    status === 401 || status === 403 || (!connected && (status === 404 || status === 422));
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
          if (result.status === "succeeded" || result.status === "cancelled") {
            await runtime.docker.getContainer(executor.Id).remove();
            await rm(join(directory, task.id), { recursive: true, force: true });
          } else console.error(`Retained failed executor ${executorId} for inspection.`);
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
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
};
