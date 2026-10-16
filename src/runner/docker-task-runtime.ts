import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  type ClaudeCodeArtifact,
  containerAgentUid,
  containerClaudeCodeDir,
  containerClaudeCodeHome,
  containerClaudeCodeUid,
  containerDaemonExecutableDir,
  containerDaemonPrivateDir,
  containerDaemonUid,
  containerHome,
  containerSharedGid,
  containerWorkspace,
  executorDrainSeconds,
  executorEnvironment,
  opencodeMemoryHomeDirectories,
} from "../protocol/task-runtime";
import Docker from "dockerode";
import { extract } from "tar-stream";

import { claudeCodeArchive, stageExecutorArtifact } from "./executor-artifact";

export type NativeTaskLaunch = {
  id: string;
  /** The executor's API and its token: the Runner's relay and a token that only it accepts. */
  apiBaseUrl: string;
  token: string;
  image: string;
  platform: "linux/amd64" | "linux/arm64";
  daemon: { sha256: string; version: string; url: string };
  /** The Claude Code tarball a Claude subscription Run needs, or none. */
  claudeCode: ClaudeCodeArtifact | null;
  traceparent: string;
};

/** A volume mount's options that keep Docker from copying the image's content into the volume. */
const withoutImageContent = {
  NoCopy: true,
  Labels: {},
  DriverConfig: { Name: "local", Options: {} },
};

export class DockerOpencodeTaskRuntime {
  readonly docker: Docker;
  /** The Claude Code volumes this Runner is checking or filling, by name. */
  readonly #claudeCodeFills = new Map<string, Promise<string>>();

  constructor(readonly options: { socketPath: string; stateDirectory: string }) {
    this.docker = new Docker({ socketPath: options.socketPath });
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
      await filler.remove({ force: true });
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
      await probe.remove({ force: true });
    }
  }

  async create(task: NativeTaskLaunch) {
    const name = `devboxes-task-${task.id}`;
    const existing = await this.inspect(name);
    if (existing) return this.docker.getContainer(existing.Id);
    const directory = resolve(this.options.stateDirectory, task.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const binary = join(directory, "devboxes-executor");
    await stageExecutorArtifact(task.daemon, binary);
    const stream = await this.docker.pull(task.image, { platform: task.platform });
    await new Promise<void>((resolve, reject) =>
      this.docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve())),
    );
    const claudeCode =
      task.claudeCode && (await this.claudeCodeVolume(task.claudeCode, task.image, task.platform));
    const agentOwner = `uid=${containerAgentUid},gid=${containerSharedGid}`;
    const environment = {
      ...executorEnvironment({
        id: task.id,
        apiBaseUrl: task.apiBaseUrl,
        token: task.token,
        traceparent: task.traceparent,
      }),
      DEVBOX_EXECUTOR_ID: name,
    };
    return this.docker.createContainer({
      name,
      Image: task.image,
      platform: task.platform,
      User: `${containerDaemonUid}:${containerSharedGid}`,
      WorkingDir: containerWorkspace,
      Entrypoint: ["/usr/local/bin/devboxes-executor"],
      Cmd: [],
      Env: Object.entries(environment).map(([key, value]) => `${key}=${value}`),
      Labels: { "devboxes.task": task.id },
      StopTimeout: executorDrainSeconds,
      HostConfig: {
        AutoRemove: false,
        // Docker's init becomes PID 1 and reaps the processes the agent's tools and Git orphan,
        // which the executor never waits for.
        Init: true,
        CapDrop: ["ALL"],
        // KILL lets Docker's init, which stays root, forward a stop's SIGTERM to the executor after
        // the executor dropped to the agent's uid and with it every capability.
        CapAdd: ["DAC_OVERRIDE", "KILL", "SETGID", "SETUID"],
        SecurityOpt: ["no-new-privileges"],
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
        ],
        Tmpfs: {
          [containerDaemonPrivateDir]: `rw,noexec,nosuid,size=1g,mode=0700,${agentOwner}`,
          [containerDaemonExecutableDir]: `rw,exec,nosuid,size=64m,mode=0700,${agentOwner}`,
          ...Object.fromEntries(
            opencodeMemoryHomeDirectories.map((directory) => [
              `${containerHome}/${directory}`,
              `rw,noexec,nosuid,mode=0770,${agentOwner}`,
            ]),
          ),
          [containerClaudeCodeHome]: "ro,noexec,nosuid,size=4k,mode=0555",
        },
        ExtraHosts: ["host.docker.internal:host-gateway"],
      },
    });
  }
}
