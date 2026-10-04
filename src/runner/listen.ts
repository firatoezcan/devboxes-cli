import { readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createFetch } from "@better-fetch/fetch";
import { DockerOpencodeTaskRuntime } from "@firops/devbox/runner/docker-task-runtime";
import Type, { type Static } from "typebox";
import Value from "typebox/value";

const taskSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  executorId: Type.Union([Type.String(), Type.Null()]),
  containerId: Type.Union([Type.String(), Type.Null()]),
  token: Type.String(),
  image: Type.String(),
  platform: Type.Union([Type.Literal("linux/amd64"), Type.Literal("linux/arm64")]),
  daemon: Type.Object({ sha256: Type.String(), version: Type.String(), url: Type.String() }),
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
  apiBaseUrl: string;
  daemonApiBaseUrl: string;
  tokenFile: string;
  stateDirectory: string;
  socketPath: string;
}) => {
  const tokenPath = resolve(options.tokenFile);
  const metadata = await stat(tokenPath);
  if ((metadata.mode & 0o077) !== 0 || !metadata.isFile())
    throw new Error("The Runner token must be stored in a regular file with mode 0600.");
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (!token) throw new Error("The Runner token file is empty.");
  const directory = resolve(options.stateDirectory);
  const runtime = new DockerOpencodeTaskRuntime({
    socketPath: options.socketPath,
    apiBaseUrl: options.daemonApiBaseUrl,
    stateDirectory: directory,
  });
  const api = createFetch({
    baseURL: options.apiBaseUrl,
    method: "POST",
    auth: { type: "Bearer", token },
    redirect: "error",
    throw: true,
  });
  let stopped = false;
  const interrupt = () => {
    stopped = true;
  };
  const startCreated = async (task: Static<typeof assignmentSchema>, containerId: string) => {
    const executorId = task.executorId ?? `devboxes-task-${task.id}`;
    const container = runtime.docker.getContainer(containerId);
    let started = false;
    try {
      const result = Value.Parse(
        reconcileSchema,
        await api("/internal/execution/runners/reconcile", {
          body: { taskId: task.id, executorId, containerId, observation: "created" },
        }),
      );
      if (result.status === "running" && !stopped) {
        await container.start();
        started = true;
        console.info(`Started Task ${task.id} in ${executorId}.`);
      }
    } finally {
      if (!started) {
        const current = await runtime.inspect(containerId);
        if (current?.State.Status === "created") await container.remove();
      }
    }
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    while (!stopped) {
      const assignments = Value.Parse(
        assignmentsSchema,
        await api("/internal/execution/runners/assignments", { body: {} }),
      );
      for (const task of assignments.tasks) {
        if (stopped) break;
        const executorId = task.executorId ?? `devboxes-task-${task.id}`;
        const executor = await runtime.inspect(task.containerId ?? executorId);
        if (!executor) {
          if (
            task.status === "succeeded" ||
            task.status === "cancelled" ||
            task.status === "cancel_requested"
          )
            await rm(join(directory, task.id), { recursive: true, force: true });
          const result = Value.Parse(
            reconcileSchema,
            await api("/internal/execution/runners/reconcile", {
              body: {
                taskId: task.id,
                executorId: task.executorId,
                containerId: task.containerId,
                observation: "absent",
                observedAt: new Date().toISOString(),
              },
            }),
          );
          console.info(`Task ${task.id} ended as ${result.status}; its executor is absent.`);
          continue;
        }
        if (executor.State.Status === "created") {
          await startCreated(task, executor.Id);
          continue;
        }
        const result = Value.Parse(
          reconcileSchema,
          await api("/internal/execution/runners/reconcile", {
            body: {
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
            },
          }),
        );
        if (!executor.State.Running) {
          if (result.status === "succeeded" || result.status === "cancelled") {
            await runtime.docker.getContainer(executor.Id).remove();
            await rm(join(directory, task.id), { recursive: true, force: true });
          } else console.error(`Retained failed executor ${executorId} for inspection.`);
          console.info(`Task ${task.id} ended as ${result.status}.`);
        }
      }
      if (stopped) break;
      const { task } = Value.Parse(
        claimSchema,
        await api("/internal/execution/runners/claim", { body: {} }),
      );
      if (task && !stopped && task.containerId === null) {
        const executorId = task.executorId ?? `devboxes-task-${task.id}`;
        const existing = await runtime.inspect(executorId);
        if (!existing) {
          const container = await runtime.create(task);
          await startCreated(task, container.id);
        } else if (existing.State.Status === "created") {
          await startCreated(task, existing.Id);
        }
      }
      await Bun.sleep(5_000);
    }
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
};
