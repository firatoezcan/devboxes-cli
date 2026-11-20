import { createHash, randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { constants } from "node:fs";
import { mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  dockerArchitecturePlatforms,
  opencodeDaemonPlatforms,
} from "@devboxes/protocol/daemon-artifact";
import type { JsonValue } from "@devboxes/protocol/json";
import { machineSizeResources, machineSizes } from "@devboxes/protocol/project";
import { endedRunStatuses, runStatuses } from "@devboxes/protocol/run-statuses";
import {
  type RunnerAssignmentsSchema,
  type RunnerClaimSchema,
  runnerAnswers,
  runnerListenerHeader,
} from "@devboxes/protocol/runner-callbacks";
import { describeErrors } from "@devboxes/protocol/validation-errors";
import { dockerSocketPath } from "@firops/devbox/runner/docker-socket";
import {
  containerExecutorId,
  DockerOpencodeTaskRuntime,
} from "@firops/devbox/runner/docker-task-runtime";
import { stalledExecutorDownload } from "@firops/devbox/runner/executor-artifact";
import type Docker from "dockerode";
import { proxy } from "hono/proxy";
import { jwtVerify, SignJWT } from "jose";
import Type, { type Static } from "typebox";
import Value from "typebox/value";

import {
  CommandError,
  installCurrentCli,
  parseResponse,
  readServerEvents,
  requestJson,
  unreadableAnswer,
} from "../commands";

/**
 * What this CLI needs of a claimed Task to start it: a Run status, a machine size and a platform it
 * knows. It reports a Task with any other as a start failure (DEC-clients-fail-only-on-what-they-use).
 */
const runnableTaskSchema = Type.Object({
  status: Type.Enum(runStatuses),
  machineSize: Type.Enum(machineSizes),
  platform: Type.Enum(opencodeDaemonPlatforms),
});

/** A claim answer whose Task's ID reads, so the Runner can report that Task even if the rest doesn't. */
const claimedTaskSchema = Type.Object({ task: Type.Object({ id: Type.String({ minLength: 1 }) }) });

/** The relay's signing key and port, kept so that running executors outlast a listener restart. */
const relayStateSchema = Type.Object({
  key: Type.String({ minLength: 43 }),
  port: Type.Integer({ minimum: 1, maximum: 65_535 }),
});

/**
 * Runs the Runner. Each executor reaches only this listener's relay, with a token that only the
 * relay accepts. The relay forwards the executor's Task callbacks to the API with the Runner
 * credential and names the token's Task in `devboxes-task`.
 *
 * One listener holds a Runner (DEC-one-listener-holds-each-runner). This one names itself to the
 * API by a one-way digest, under its own label, of its Docker engine's ID and its relay key: the
 * same after a restart on this engine with this state directory, and another for a copy of the
 * state directory on another engine. It ends when another listener holds the Runner, and at an API
 * answer it can't read, which only the current CLI can. Stopped by a signal, it lets go of the
 * Runner unless a Task's container still runs on this machine.
 */
export const listen = async (options: {
  apiOrigin: string;
  tokenFile: string;
  stateDirectory: string;
  /** The most CPUs and GiB of memory its owner lets devboxes use; the whole machine when unset. */
  cpus?: number;
  memoryGiB?: number;
}) => {
  /**
   * Whether only this user can read or change a file. Windows synthesizes a stat's mode from file
   * attributes and reports no owner, so there the file's access-control list decides.
   */
  const ownedPrivately = (metadata: { uid: number; mode: number }) =>
    process.platform === "win32" ||
    (metadata.uid === process.getuid?.() && (metadata.mode & 0o077) === 0);
  /**
   * The text of file `path`, or null when it does not exist. It is read through the handle whose
   * owner and mode were checked, so what is checked is what is read, and opened without blocking,
   * so a FIFO cannot hang it. `flags` adds open flags, such as `O_NOFOLLOW` to refuse a symbolic
   * link. A file that is not private, or that this user cannot open, throws `refusal`.
   */
  const readPrivately = async (path: string, flags: number, refusal: CommandError) => {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | flags).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error.code === "ELOOP" || error.code === "EACCES" ? refusal : error;
      },
    );
    if (!handle) return null;
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || !ownedPrivately(metadata)) throw refusal;
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  };
  const tokenRefusal = new CommandError(
    "INVALID_RUNNER_TOKEN_FILE",
    "The Runner token must be stored in a regular file that you own, with mode 0600.",
  );
  const token = (await readPrivately(resolve(options.tokenFile), 0, tokenRefusal))?.trim();
  if (token === undefined) throw tokenRefusal;
  if (!token)
    throw new CommandError("INVALID_RUNNER_TOKEN_FILE", "The Runner token file is empty.");
  const directory = resolve(options.stateDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!ownedPrivately(await stat(directory)))
    throw new CommandError(
      "INVALID_RUNNER_STATE_DIRECTORY",
      `The Runner state directory ${directory} holds the relay's signing key, so it must be yours with mode 0700.`,
    );
  const relayStatePath = join(directory, "relay.json");
  const relayText = await readPrivately(
    relayStatePath,
    constants.O_NOFOLLOW,
    new CommandError(
      "INVALID_RUNNER_STATE_DIRECTORY",
      `${relayStatePath} holds the relay's signing key, so it must be a regular file of yours with mode 0600.`,
    ),
  );
  const relayState =
    relayText === null ? null : Value.Parse(relayStateSchema, JSON.parse(relayText));
  const runtime = new DockerOpencodeTaskRuntime({
    socketPath: dockerSocketPath(),
    stateDirectory: directory,
  });
  const engine = await runtime.docker.info();
  const platform = dockerArchitecturePlatforms.get(engine.Architecture);
  if (!platform)
    throw new CommandError(
      "PLATFORM_UNSUPPORTED",
      `devboxes runs Tasks on 64-bit x86 or Arm Docker engines, and this one reports ${engine.Architecture}.`,
    );
  const machine = {
    cpus: Math.min(options.cpus ?? engine.NCPU, engine.NCPU),
    memoryBytes: Math.floor(
      Math.min((options.memoryGiB ?? Number.POSITIVE_INFINITY) * 1024 ** 3, engine.MemTotal),
    ),
    platform,
  };
  const limits = Value.Parse(
    Type.Object({ MemoryLimit: Type.Boolean(), CpuCfsQuota: Type.Boolean() }),
    engine,
  );
  if (!limits.MemoryLimit || !limits.CpuCfsQuota)
    console.error(
      "This Docker engine can't limit a container's memory or CPUs, so Tasks run without their machine size's limits. On rootless Docker, delegate the cgroup controllers to your user, as Docker's rootless guide describes under Limiting resources.",
    );
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
        pathname !== "/api/commands/model-accounts/runtime-read"
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
      { mode: 0o600, flag: "wx" },
    );
  const apiBaseUrl = `http://host.docker.internal:${relay.port}/api`;
  const listener = createHash("sha256")
    .update("devboxes runner listener\0")
    .update(Value.Parse(Type.Object({ ID: Type.String({ minLength: 1 }) }), engine).ID)
    .update("\0")
    .update(relayKey)
    .digest("base64url");
  const request = async (operation: keyof typeof runnerAnswers, body: JsonValue) =>
    (
      await requestJson(
        { origin: options.apiOrigin, token, headers: { [runnerListenerHeader]: listener } },
        `/api/internal/execution/runners/${operation}`,
        body,
      )
    ).data;
  const api = async <Operation extends keyof typeof runnerAnswers>(
    operation: Operation,
    body: JsonValue,
  ): Promise<Static<(typeof runnerAnswers)[Operation]>> =>
    parseResponse(runnerAnswers[operation], await request(operation, body), operation);
  /** Each Task this CLI left alone, by what in it this CLI doesn't know, as it last logged it. */
  const leftAlone = new Map<string, string>();
  /** Leaves Task `taskId` and its executor as they are because of `unknown`, and logs it once. */
  const leaveAlone = (taskId: string, unknown: string) => {
    if (leftAlone.get(taskId) !== unknown)
      console.error(
        `Task ${taskId} has ${unknown}, which this devboxes CLI doesn't know, so it leaves the Task and its executor as they are. ${installCurrentCli}`,
      );
    leftAlone.set(taskId, unknown);
  };
  /** Whether `status` is a Run status this CLI knows; it leaves a Task in any other alone. */
  const knows = (taskId: string, status: string) => {
    if ((runStatuses as readonly string[]).includes(status)) return true;
    leaveAlone(taskId, `the Run status ${status}`);
    return false;
  };
  let stopping = false;
  /**
   * Whether something asked for the next look since the last one began: a `wake` event of the API's
   * events stream, which sends one as it opens, a Task container's start, stop or removal, a
   * reconnection to Docker's events, the moment the claim answered in `wakeAt`, a finished start, a
   * retry after a failed look, or a stop. Asks that arrive while a look runs merge into the next one.
   */
  let asked = false;
  let rouse: (() => void) | null = null;
  const wake = () => {
    asked = true;
    rouse?.();
    rouse = null;
  };
  const interrupt = () => {
    stopping = true;
    wake();
  };
  /**
   * The executor digest the Runner is downloading or downloaded ahead of its Tasks. A failed
   * download clears it, so a later claim tries again.
   */
  let prefetched: string | null = null;
  let identified: string | null = null;
  /**
   * This Runner's id (`/identify`), which labels the containers it creates. A look asks for it once,
   * so a failed call fails that look, which the loop retries.
   */
  const runnerId = async () => (identified ??= (await api("identify", {})).id);
  /** The relay's token for Task `taskId`, which its executor reads from stdin when it starts. */
  const relayToken = (taskId: string) =>
    new SignJWT().setProtectedHeader({ alg: "HS256" }).setSubject(taskId).sign(relayKey);
  const startCreated = async (
    task: Static<typeof RunnerAssignmentsSchema>["tasks"][number],
    created: Docker.ContainerInspectInfo,
  ) => {
    const container = runtime.docker.getContainer(created.Id);
    const result = await api("reconcile", {
      taskId: task.id,
      executorId: containerExecutorId(created),
      containerId: created.Id,
      observation: "created",
    });
    if (!knows(task.id, result.status)) return;
    if (result.status !== "queued" && result.status !== "running")
      await container.remove({ v: true });
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
      await runtime.start(container, await relayToken(task.id));
      console.info(`Started Task ${task.id} in ${created.Name.slice(1)}.`);
    }
  };
  /**
   * The Task starts in progress, by Task ID. An image pull or an executor download can outlast the
   * API's heartbeat window, so a start runs beside the looks, and its failure surfaces on the look
   * that its end asks for.
   */
  const starting = new Map<string, Promise<void>>();
  let startFailure: {
    taskId: string;
    reason: string;
    error: CommandError;
  } | null = null;
  const startClaimed = async (
    task: NonNullable<Static<typeof RunnerClaimSchema>["task"]> & Static<typeof runnableTaskSchema>,
  ) => {
    const existing = await runtime.taskContainer(task.id, await runnerId());
    if (!existing) {
      const size = machineSizeResources[task.machineSize];
      const container = await runtime.create(
        {
          ...task,
          resources: {
            cpus: Math.min(size.cpus, machine.cpus),
            memoryBytes: Math.min(size.memoryBytes, machine.memoryBytes),
          },
          apiBaseUrl,
        },
        await runnerId(),
      );
      await startCreated(task, await container.inspect());
    } else if (existing.State.Status === "created") {
      await startCreated(task, existing);
    }
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let connected = false;
  let failures = 0;
  const endsListener = ({ code, options: { status } }: CommandError) =>
    code === "DOCKER_ENGINE_UNSUPPORTED" ||
    code === "RUNNER_LISTENING_ELSEWHERE" ||
    status === 401 ||
    status === 403 ||
    (!connected && (status === 404 || status === 422));
  /**
   * Logs the API's refusal of a report about Task `taskId` and lets the look go on to the other
   * Tasks. A refusal that ends the listener, and a server error, fail the look.
   */
  const refusedReport = (taskId: string) => (refusal: Error) => {
    if (
      refusal instanceof CommandError &&
      !endsListener(refusal) &&
      (refusal.options.status ?? 500) < 500
    )
      return console.error(`The report about Task ${taskId} was refused: ${refusal}`);
    throw refusal;
  };
  /**
   * Reports that Task `taskId` could not start, for `reason`, which the person sees once its retries
   * are spent (DEC-runner-start-failures-retry).
   */
  const reportStartFailure = (taskId: string, reason: string) =>
    api("reconcile", { taskId, observation: "start-failed", reason }).catch(refusedReport(taskId));
  /** How many claims answered so far, so only the latest claim's `wakeAt` asks for a look. */
  let claims = 0;
  /**
   * One look: reports what this machine's containers of the Runner's Tasks show (`/assignments`,
   * `/reconcile`), removes the containers the Runner created for Tasks it no longer holds, as after
   * devboxes offered them to another Runner while this one was silent, then, while no start runs,
   * claims the next Task (`/claim`). It finds a Task's container by the labels the Runner gave it,
   * so another Runner's containers on the same engine are never its own. It judges what the Runner
   * holds by what was true when it read `/assignments`: a start that ran then may report its
   * container after the read, so its Task's container stays. A start begins only from a claim,
   * which a look makes after its cleanup, so none begins in between. It answers null, or the
   * failure the loop retries after a backoff.
   */
  const look = async () => {
    try {
      const startedBefore = new Set(starting.keys());
      const assignments = await api("assignments", {});
      connected = true;
      for (const task of assignments.tasks) {
        if (stopping) break;
        if (starting.has(task.id) || !knows(task.id, task.status)) continue;
        const executor = task.containerId
          ? await runtime.inspect(task.containerId)
          : await runtime.taskContainer(task.id, await runnerId());
        if (!executor) {
          await rm(join(directory, task.id), { recursive: true, force: true });
          const result = await api("reconcile", {
            taskId: task.id,
            executorId: task.executorId,
            containerId: task.containerId,
            observation: "absent",
            observedAt: new Date().toISOString(),
          }).catch(refusedReport(task.id));
          if (result && (endedRunStatuses as readonly string[]).includes(result.status))
            console.info(`Task ${task.id} ended as ${result.status}; its executor is absent.`);
          else if (result)
            console.info(
              `Task ${task.id}'s executor is absent; it starts again in a new container.`,
            );
          continue;
        }
        if (executor.State.Status === "created") {
          await startCreated(task, executor);
          continue;
        }
        const reason =
          !executor.State.Running && executor.State.ExitCode !== 0
            ? await runtime.lastErrorLine(executor.Id)
            : null;
        const result = await api("reconcile", {
          taskId: task.id,
          executorId: containerExecutorId(executor),
          containerId: executor.Id,
          ...(executor.State.Running
            ? { observation: "running", startedAt: executor.State.StartedAt }
            : {
                observation: "stopped",
                startedAt: executor.State.StartedAt,
                stoppedAt: executor.State.FinishedAt,
                ...(reason && { reason }),
              }),
        }).catch(refusedReport(task.id));
        if (!result || !knows(task.id, result.status)) continue;
        const container = runtime.docker.getContainer(executor.Id);
        if ((endedRunStatuses as readonly string[]).includes(result.status)) {
          if (executor.State.Running) continue;
          await container.remove({ v: true });
          await rm(join(directory, task.id), { recursive: true, force: true });
          console.info(`Task ${task.id} ended as ${result.status}.`);
        } else if (result.restart && !stopping) {
          if (executor.State.Running)
            await container.kill().catch((error: { statusCode?: number }) => {
              if (error.statusCode !== 409) throw error;
            });
          await container.wait();
          await runtime.start(container, await relayToken(task.id));
          console.info(`Started Task ${task.id}'s executor again in ${executor.Name.slice(1)}.`);
        }
      }
      const assigned = new Set(assignments.tasks.map(({ id }) => id));
      for (const left of await runtime.runnerContainers(await runnerId())) {
        if (stopping) break;
        if (assigned.has(left.taskId) || startedBefore.has(left.taskId)) continue;
        await runtime.docker.getContainer(left.id).remove({ v: true, force: true });
        await rm(join(directory, left.taskId), { recursive: true, force: true });
        console.info(
          `Removed Task ${left.taskId}'s container: the Task no longer runs on this Runner.`,
        );
      }
      if (stopping) return null;
      if (startFailure !== null) {
        const { taskId, reason, error } = startFailure;
        if (!(await runtime.taskContainer(taskId, await runnerId())))
          await reportStartFailure(taskId, reason);
        startFailure = null;
        throw error;
      }
      if (starting.size === 0) {
        const claim = await request("claim", machine);
        if (!Value.Check(runnerAnswers.claim, claim) && Value.Check(claimedTaskSchema, claim)) {
          const reason = unreadableAnswer(
            "the claim response",
            describeErrors(runnerAnswers.claim, claim),
          ).message;
          console.error(`Task ${claim.task.id}: ${reason}`);
          await reportStartFailure(claim.task.id, reason);
          return null;
        }
        const { task, executor, wakeAt } = parseResponse(runnerAnswers.claim, claim, "claim");
        const answered = ++claims;
        if (wakeAt)
          void Bun.sleep(new Date(wakeAt)).then(() => {
            if (answered === claims) wake();
          });
        if (executor && executor.sha256 !== prefetched) {
          prefetched = executor.sha256;
          runtime.stageExecutor(executor).catch((error: Error) => {
            prefetched = null;
            console.error(
              `Downloading executor ${executor.version} ahead of its Tasks failed: ${error.message}`,
            );
          });
        }
        if (task && !stopping && task.containerId === null) {
          if (!Value.Check(runnableTaskSchema, task)) {
            const unknown = [
              !(runStatuses as readonly string[]).includes(task.status) &&
                `the Run status ${task.status}`,
              !(machineSizes as readonly string[]).includes(task.machineSize) &&
                `the machine size ${task.machineSize}`,
              !(opencodeDaemonPlatforms as readonly string[]).includes(task.platform) &&
                `the platform ${task.platform}`,
            ].filter(Boolean);
            const reason = `This devboxes CLI can't start the Task, because it doesn't know ${unknown.join(" or ")}. ${installCurrentCli}`;
            console.error(`Task ${task.id}: ${reason}`);
            await reportStartFailure(task.id, reason);
          } else
            starting.set(
              task.id,
              startClaimed(task)
                .then(
                  () => {
                    failures = 0;
                  },
                  (error) => {
                    startFailure = {
                      taskId: task.id,
                      reason:
                        error instanceof Error
                          ? error.name === "TimeoutError"
                            ? stalledExecutorDownload(task.daemon.url, error.message)
                            : error.message || error.name
                          : CommandError.from(error).message,
                      error: CommandError.from(error),
                    };
                  },
                )
                .finally(() => {
                  starting.delete(task.id);
                  wake();
                }),
            );
        }
      }
      return null;
    } catch (error) {
      if (!(error instanceof CommandError && endsListener(error))) return CommandError.from(error);
      throw error;
    }
  };
  /** How long to wait before trying again after `failures` failures in a row. */
  const backoff = (failures: number) =>
    Math.min(60_000, 5_000 * 2 ** failures) * (0.5 + Math.random() / 2);
  /**
   * Reads the API's events stream for this listener once, asking for a look on each `wake` event,
   * the first of which the API sends as the stream opens, since a stream opened again may have
   * missed one. It answers whether the stream opened, once it ends; a refusal throws.
   */
  const readEvents = async () => {
    let opened = false;
    await readServerEvents(
      { origin: options.apiOrigin, token, headers: { [runnerListenerHeader]: listener } },
      "/api/internal/execution/runners/events",
      (event) => {
        opened = true;
        if (event === "wake") wake();
      },
    );
    return opened;
  };
  /** How many times the listener connected to Docker's events. */
  let dockerConnections = 0;
  /**
   * Follows Docker's events for the containers of Tasks once, asking for a look when a container
   * starts, dies or goes, and when it connects again, since it may have missed one meanwhile. It
   * answers whether it connected, once the events end or fail.
   */
  const readDockerEvents = async () => {
    const events = await runtime.docker.getEvents({
      filters: {
        type: ["container"],
        label: ["devboxes.task"],
        event: ["start", "die", "destroy"],
      },
    });
    if (dockerConnections++ > 0) wake();
    await new Promise((ended) => {
      events.on("data", wake);
      events.once("end", ended);
      events.once("error", ended);
    });
    return true;
  };
  /**
   * Runs `read` until the listener stops. When it ends or fails, it asks for a look, whose calls
   * report what failed, and runs again after a backoff that grows while it keeps failing.
   */
  const follow = async (read: () => Promise<boolean>) => {
    for (let failed = 1; !stopping;) {
      failed = (await read().catch(() => false)) ? 1 : failed + 1;
      if (stopping) return;
      wake();
      await Bun.sleep(backoff(failed));
    }
  };
  /**
   * The refusal of the last answer this CLI couldn't read, which it logged. It logs the same refusal
   * once, and keeps asking with backoff, so it carries on by itself once the answer reads again.
   */
  let unreadable: string | null = null;
  void follow(readEvents);
  void follow(readDockerEvents);
  try {
    while (!stopping) {
      if (!asked)
        await new Promise<void>((roused) => {
          rouse = roused;
        });
      asked = false;
      if (stopping) break;
      const failure = await look();
      failures = failure ? failures + 1 : starting.size > 0 ? failures : 0;
      const logged = unreadable;
      unreadable = failure?.code === "INVALID_RESPONSE" ? failure.message : null;
      if (!failure) continue;
      const delay = backoff(failures);
      if (failure.message !== logged)
        console.error(
          `Asking the API failed, retrying in ${Math.ceil(delay / 1_000)}s: ${failure}`,
        );
      void Bun.sleep(delay).then(wake);
    }
  } finally {
    await Promise.all(starting.values());
    await relay.stop();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    if (stopping) {
      const release = await api("release", {}).catch((error: Error) => {
        console.error(`Letting go of the Runner failed: ${CommandError.from(error)}`);
        return null;
      });
      if (release && !release.released)
        console.info(
          `Tasks still run on this machine, so the Runner stays held until ${release.heldUntil}. Run devboxes runner listen here again to finish them.`,
        );
    }
  }
};
