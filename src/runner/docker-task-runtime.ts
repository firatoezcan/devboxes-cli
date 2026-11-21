import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Duplex, Writable } from "node:stream";
import { finished } from "node:stream/promises";

import {
  type ClaudeCodeArtifact,
  containerAgentUid,
  containerClaudeCodeDir,
  containerClaudeCodeHome,
  containerClaudeCodeUid,
  containerDaemonExecutableDir,
  containerDaemonUid,
  containerHome,
  containerSharedGid,
  containerWorkspace,
  executorDrainSeconds,
  executorEnvironment,
} from "../protocol/task-runtime";
import Docker from "dockerode";
import { extract, pack } from "tar-stream";

import { claudeCodeArchive, stageExecutorArtifact } from "./executor-artifact";

type NativeTaskLaunch = {
  id: string;
  /** The executor's API: the Runner's relay. */
  apiBaseUrl: string;
  image: string;
  platform: "linux/amd64" | "linux/arm64";
  /** The CPUs and memory the Task's container may use. */
  resources: { cpus: number; memoryBytes: number };
  daemon: { sha256: string; version: string; url: string };
  /** The Claude Code tarball a Claude subscription Run needs, or none. */
  claudeCode: ClaudeCodeArtifact | null;
  /** The home paths kept in this machine's volumes for the Organization's Tasks. */
  toolCache: { organizationId: string; paths: string[] };
  traceparent: string;
};

/** A volume mount's options that keep Docker from copying the image's content into the volume. */
const withoutImageContent = {
  NoCopy: true,
  Labels: {},
  DriverConfig: { Name: "local", Options: {} },
};

/**
 * Waits for the build, pull or push `stream` of `operation` to end, and rejects with
 * `<operation> failed: <error>` when it reports an error. Docker reports a failed step or pull
 * inside the stream's output, not as a stream error, in words that differ between its engines.
 */
export const followDockerProgress = (
  docker: Docker,
  stream: NodeJS.ReadableStream,
  operation: string,
) =>
  new Promise<void>((resolve, reject) =>
    docker.modem.followProgress(stream, (error, output: { error?: string }[]) => {
      const reported = output.find((event) => event.error)?.error;
      if (error || reported)
        reject(new Error(`${operation} failed: ${error?.message ?? reported}`, { cause: error }));
      else resolve();
    }),
  );

/** The labels of the containers that Runner `runnerId` creates for Task `taskId`. */
const taskLabels = (taskId: string, runnerId: string) => ({
  "devboxes.task": taskId,
  "devboxes.runner": runnerId,
});

/** Docker's label filter for every container whose labels hold all of `labels`. */
const labelFilter = (labels: Record<string, string>) =>
  Object.entries(labels).map(([name, value]) => `${name}=${value}`);

/**
 * The executor ID of `container`, which its `DEVBOX_EXECUTOR_ID` holds: each container of a Task
 * has its own, so a new container restores the Task's checkpoint
 * (DEC-executor-restores-from-checkpoint).
 */
export const containerExecutorId = (container: Docker.ContainerInspectInfo) => {
  const variable = container.Config.Env.find((entry) => entry.startsWith("DEVBOX_EXECUTOR_ID="));
  if (!variable) throw new Error(`Container ${container.Name} has no executor ID.`);
  return variable.slice("DEVBOX_EXECUTOR_ID=".length);
};

/** The standard output and error of Docker's multiplexed `stream`, once it ends. */
export const demuxedText = async (docker: Docker, stream: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(chunk: Buffer, _encoding, written) {
      chunks.push(chunk);
      written();
    },
  });
  docker.modem.demuxStream(stream, output, output);
  await finished(stream);
  return Buffer.concat(chunks).toString();
};

export class DockerOpencodeTaskRuntime {
  readonly docker: Docker;
  /** The Claude Code volumes this Runner is checking or filling, by name. */
  readonly #claudeCodeFills = new Map<string, Promise<string>>();
  /**
   * The executor cache's last step: each `stageExecutor` runs after the one before it, so an
   * eviction never removes a file that another step still links.
   */
  #executorStaging: Promise<unknown> = Promise.resolve();

  constructor(readonly options: { socketPath: string; stateDirectory: string }) {
    this.docker = new Docker({ socketPath: options.socketPath });
  }

  /**
   * The last line that exited executor `containerId` wrote to its standard error, at most 4,000
   * characters of it, or null when it wrote none or Docker gives none, as with the `none` log driver
   * or a container removed meanwhile. Docker keeps an exited container's output until it is
   * removed. It reads Docker's last 20 entries, which Docker splits at 16 KiB, so at most 320 KiB.
   */
  async lastErrorLine(containerId: string) {
    try {
      const output = await this.docker
        .getContainer(containerId)
        .logs({ follow: true, stdout: false, stderr: true, tail: 20 });
      const lines = (await demuxedText(this.docker, output))
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      return lines.at(-1)?.slice(0, 4000) ?? null;
    } catch {
      return null;
    }
  }

  async inspect(executorId: string) {
    return new Promise<Docker.ContainerInspectInfo | null>((resolve, reject) => {
      this.docker.getContainer(executorId).inspect((error, container) => {
        if (error) {
          if (error.statusCode === 404) resolve(null);
          else reject(error);
        } else if (container) {
          resolve(container);
        } else {
          reject(new Error("Docker returned no container inspection."));
        }
      });
    });
  }

  /**
   * Runs `use` with a container from `image` that never starts and mounts the Claude Code volume
   * `name` at `/claude-code`, without the image's own content there.
   */
  async #withClaudeCodeFiller<Result>(
    name: string,
    image: string,
    platform: NativeTaskLaunch["platform"],
    use: (filler: Docker.Container) => Promise<Result>,
  ) {
    const filler = await this.docker.createContainer({
      Image: image,
      platform,
      Entrypoint: ["/claude-code/claude"],
      Cmd: [],
      HostConfig: {
        Mounts: [
          {
            Type: "volume",
            Source: name,
            Target: "/claude-code",
            VolumeOptions: withoutImageContent,
          },
        ],
      },
    });
    try {
      return await use(filler);
    } finally {
      await filler.remove({ force: true, v: true });
    }
  }

  /** Whether the Claude Code volume `name` holds the pinned binary, as the Claude Code uid's with mode 0500. */
  async #holdsClaudeCode(
    name: string,
    artifact: ClaudeCodeArtifact,
    image: string,
    platform: NativeTaskLaunch["platform"],
  ) {
    const exists = await this.docker
      .getVolume(name)
      .inspect()
      .then(
        () => true,
        (error: { statusCode?: number }) => {
          if (error.statusCode === 404) return false;
          throw error;
        },
      );
    if (!exists) return false;
    return this.#withClaudeCodeFiller(name, image, platform, async (filler) => {
      const archive = await filler
        .getArchive({ path: "/claude-code/claude" })
        .catch((error: { statusCode?: number }) => {
          if (error.statusCode === 404) return null;
          throw error;
        });
      if (!archive) return false;
      const entries = extract();
      archive.pipe(entries);
      let holds = false;
      for await (const entry of entries) {
        const hash = createHash("sha512");
        for await (const chunk of entry) hash.update(chunk);
        const { name: path, type, mode = 0, uid, gid } = entry.header;
        holds =
          path === "claude" &&
          type === "file" &&
          (mode & 0o7777) === 0o500 &&
          uid === containerClaudeCodeUid &&
          gid === containerClaudeCodeUid &&
          hash.digest("hex") === artifact.binarySha512;
      }
      return holds;
    });
  }

  /**
   * The Docker volume that holds `artifact`'s Claude Code binary for Tasks on this host. Each call
   * hashes the volume's binary against the pin, and verifies the tarball and fills the volume again
   * when it doesn't match. The binary lives in Docker, not in a host file, because Docker Desktop and
   * OrbStack run a shared host file only when its owner can read it.
   */
  claudeCodeVolume(
    artifact: ClaudeCodeArtifact,
    image: string,
    platform: NativeTaskLaunch["platform"],
  ) {
    const name = `devboxes-claude-code-${artifact.binarySha512.slice(0, 32)}`;
    const filling = this.#claudeCodeFills.get(name);
    if (filling) return filling;
    const filled = (async () => {
      if (await this.#holdsClaudeCode(name, artifact, image, platform)) return name;
      const archive = await claudeCodeArchive(artifact);
      await this.docker.createVolume({ Name: name });
      await this.#withClaudeCodeFiller(name, image, platform, (filler) =>
        filler.putArchive(archive, { path: "/claude-code" }),
      );
      return name;
    })().finally(() => this.#claudeCodeFills.delete(name));
    this.#claudeCodeFills.set(name, filled);
    return filled;
  }

  /**
   * Makes `daemon`'s executor the one in this Runner's cache, `<state directory>/executors/<sha256>`,
   * and hard-links it at `destination` when one is given. It hashes the cached file against the
   * digest and downloads it again when it doesn't match. A cached file that matches gets mode 0555
   * again, which an earlier Runner's umask could have narrowed so that no Task could run it. Then
   * it deletes everything else in the cache that it can: older digests, and the temporary folders
   * of downloads that a stopped Runner left. An entry it can't delete yet, such as a file a container holds open on Windows, stays for
   * a later call and never fails this one. A Task's own hard link keeps an evicted executor until the
   * Task's directory goes.
   */
  stageExecutor(daemon: { sha256: string; url: string }, destination?: string) {
    const staged = this.#executorStaging.then(async () => {
      const cache = resolve(this.options.stateDirectory, "executors");
      const path = join(cache, daemon.sha256);
      const cached = Bun.file(path);
      const present = await cached.exists();
      const hash = createHash("sha256");
      if (present) for await (const chunk of cached.stream()) hash.update(chunk);
      if (present && hash.digest("hex") === daemon.sha256) await chmod(path, 0o555);
      else {
        await mkdir(cache, { recursive: true, mode: 0o700 });
        await stageExecutorArtifact(daemon, path);
      }
      for (const entry of await readdir(cache))
        if (entry !== daemon.sha256)
          await rm(join(cache, entry), { recursive: true, force: true }).catch(() => undefined);
      if (destination) {
        await rm(destination, { force: true });
        await link(path, destination);
      }
    });
    this.#executorStaging = staged.catch(() => undefined);
    return staged;
  }

  /**
   * Whether a container of `image`, the image of the Task `taskId`, reaches `url` at
   * `host.docker.internal`. It runs the executor that `create` staged as plain Bun, the one HTTP
   * client that every Workspace Image runs.
   */
  async reaches(taskId: string, image: string, url: string) {
    const probe = await this.docker.createContainer({
      Image: image,
      User: `${containerAgentUid}:${containerSharedGid}`,
      Entrypoint: ["/usr/local/bin/devboxes-executor"],
      Cmd: [
        "--eval",
        "await fetch(process.env.PROBE_URL, { signal: AbortSignal.timeout(10_000) })",
      ],
      Env: ["BUN_BE_BUN=1", `PROBE_URL=${url}`],
      HostConfig: {
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        Mounts: [
          {
            Type: "bind",
            Source: join(resolve(this.options.stateDirectory, taskId), "devboxes-executor"),
            Target: "/usr/local/bin/devboxes-executor",
            ReadOnly: true,
          },
        ],
        ExtraHosts: ["host.docker.internal:host-gateway"],
      },
    });
    try {
      await probe.start();
      const { StatusCode } = await probe.wait();
      return StatusCode === 0;
    } finally {
      await probe.remove({ force: true, v: true });
    }
  }

  /**
   * Starts the executor of a Task that `create` set up, and writes `token`, the Run token that the
   * Runner's relay accepts, to its stdin, then closes it. The token so never enters an environment
   * block, an argument list or a file of the container.
   *
   * The attach request has an empty body: Docker hands what reaches the connection after it took
   * it over to the container's stdin, so a body that a socket proxy such as OrbStack's delivers
   * late, like the JSON options of dockerode's `attach`, would come before the token.
   */
  async start(container: Docker.Container, token: string) {
    const stdin = await new Promise<Duplex>((attached, refused) =>
      this.docker.modem.dial(
        {
          path: `/containers/${container.id}/attach?`,
          method: "POST",
          options: { _query: { stream: true, stdin: true } },
          file: Buffer.alloc(0),
          hijack: true,
          isStream: true,
          statusCodes: { 101: true, 200: true, 404: "no such container", 500: "server error" },
        },
        (error, stream) => {
          if (error) refused(error);
          else if (stream instanceof Duplex) attached(stream);
          else refused(new Error(`Docker attached no stream to container ${container.id}.`));
        },
      ),
    );
    await container.start();
    await new Promise<void>((resolve, reject) => {
      stdin.once("error", reject);
      stdin.end(token, resolve);
    });
  }

  /**
   * The container that Runner `runnerId` created for Task `taskId` on this engine, or null. Another
   * Runner on the same engine creates its own container for the Task, under its own labels.
   */
  async taskContainer(taskId: string, runnerId: string) {
    const [found] = await this.docker.listContainers({
      all: true,
      filters: { label: labelFilter(taskLabels(taskId, runnerId)) },
    });
    return found ? this.inspect(found.Id) : null;
  }

  /** The containers that Runner `runnerId` created on this engine, each with its Task's id. */
  async runnerContainers(runnerId: string) {
    return (
      await this.docker.listContainers({
        all: true,
        filters: { label: labelFilter({ "devboxes.runner": runnerId }) },
      })
    ).flatMap(({ Id, Labels }) => {
      const taskId = Labels["devboxes.task"];
      return taskId ? [{ id: Id, taskId }] : [];
    });
  }

  /**
   * Creates the container of Task `task` for Runner `runnerId`, or answers the one it already
   * created. Each container's name is its executor id, which no other container shares, so two
   * Runners on one engine never name the same container.
   */
  async create(task: NativeTaskLaunch, runnerId: string): Promise<Docker.Container> {
    const existing = await this.taskContainer(task.id, runnerId);
    if (existing) return this.docker.getContainer(existing.Id);
    const name = `devboxes-task-${task.id}-${randomUUID()}`;
    const directory = resolve(this.options.stateDirectory, task.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const binary = join(directory, "devboxes-executor");
    await this.stageExecutor(task.daemon, binary);
    await followDockerProgress(
      this.docker,
      await this.docker.pull(task.image, { platform: task.platform }),
      `Pulling ${task.image}`,
    );
    const claudeCode =
      task.claudeCode && (await this.claudeCodeVolume(task.claudeCode, task.image, task.platform));
    const environment = {
      ...executorEnvironment({
        id: task.id,
        apiBaseUrl: task.apiBaseUrl,
        traceparent: task.traceparent,
      }),
      DEVBOX_EXECUTOR_ID: name,
    };
    const toolCache = task.toolCache.paths.map((path) => ({
      path,
      volume: `devboxes-tool-cache-${task.toolCache.organizationId}-${task.platform.replace("/", "-")}-${createHash("sha256").update(path).digest("hex").slice(0, 16)}`,
    }));
    const container = await this.docker.createContainer({
      name,
      Image: task.image,
      platform: task.platform,
      User: `${containerDaemonUid}:${containerSharedGid}`,
      WorkingDir: containerWorkspace,
      Entrypoint: ["/usr/local/bin/devboxes-executor"],
      Cmd: [],
      // The executor reads its Run token from stdin, which closes once `start` wrote it.
      OpenStdin: true,
      StdinOnce: true,
      AttachStdin: true,
      Env: Object.entries(environment).map(([key, value]) => `${key}=${value}`),
      Labels: taskLabels(task.id, runnerId),
      StopTimeout: executorDrainSeconds,
      HostConfig: {
        AutoRemove: false,
        // Docker's init becomes PID 1 and reaps the processes the agent's tools and Git orphan,
        // which the executor never waits for.
        Init: true,
        CapDrop: ["ALL"],
        // KILL lets Docker's init, which stays root, forward a stop's SIGTERM to the executor after
        // the executor dropped to its own uid and with it every capability.
        CapAdd: ["DAC_OVERRIDE", "KILL", "SETGID", "SETUID"],
        SecurityOpt: ["no-new-privileges"],
        NanoCpus: Math.round(task.resources.cpus * 1e9),
        Memory: task.resources.memoryBytes,
        MemorySwap: task.resources.memoryBytes,
        Mounts: [
          {
            Type: "bind",
            Source: binary,
            Target: "/usr/local/bin/devboxes-executor",
            ReadOnly: true,
          },
          ...(claudeCode
            ? [
                {
                  Type: "volume" as const,
                  Source: claudeCode,
                  Target: containerClaudeCodeDir,
                  ReadOnly: true,
                  VolumeOptions: withoutImageContent,
                },
              ]
            : []),
          ...toolCache.map(({ path, volume }) => ({
            Type: "volume" as const,
            Source: volume,
            Target: `${containerHome}/${path}`,
            VolumeOptions: { ...withoutImageContent, Labels: { "devboxes.tool-cache": path } },
          })),
        ],
        Tmpfs: {
          [containerDaemonExecutableDir]: "rw,exec,nosuid,size=64m,mode=0755",
          [containerClaudeCodeHome]: "ro,noexec,nosuid,size=4k,mode=0555",
        },
        ExtraHosts: ["host.docker.internal:host-gateway"],
      },
    });
    if (toolCache.length > 0) {
      // Docker creates each volume, and any missing folder above its mount, owned by root. A
      // directory entry for each, extracted before the start, gives them all to the agent,
      // including each volume's own root folder.
      const owned = pack();
      const folders = new Set(
        toolCache.flatMap(({ path }) =>
          path.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/")),
        ),
      );
      for (const folder of folders)
        owned.entry({
          name: `${containerHome.slice(1)}/${folder}`,
          type: "directory",
          mode: 0o755,
          uid: containerAgentUid,
          gid: containerSharedGid,
        });
      owned.finalize();
      await container.putArchive(owned, { path: "/" });
    }
    return container;
  }
}
