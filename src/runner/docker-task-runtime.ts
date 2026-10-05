import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  containerAgentUid,
  containerDaemonExecutableDir,
  containerDaemonPrivateDir,
  containerDaemonUid,
  containerHome,
  containerSharedGid,
} from "../protocol/task-runtime";
import Docker from "dockerode";

import { stageExecutorArtifact } from "./executor-artifact";

export type NativeTaskLaunch = {
  id: string;
  token: string;
  image: string;
  platform: "linux/amd64" | "linux/arm64";
  daemon: { sha256: string; version: string; url: string };
  traceparent: string;
};

export class DockerOpencodeTaskRuntime {
  readonly docker: Docker;

  constructor(
    readonly options: { socketPath: string; apiBaseUrl: string; stateDirectory: string },
  ) {
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
    const agentOwner = `uid=${containerAgentUid},gid=${containerSharedGid}`;
    const environment = {
      HOME: containerHome,
      WORKSPACE: "/workspace",
      DEVBOX_WORKSPACE: "/workspace",
      DEVBOX_WORKSPACE_CAPABILITY: "agent-task",
      DEVBOX_WORKSPACE_CAPABILITY_ID: task.id,
      DEVBOX_EXECUTOR_ID: name,
      OPENCODE_WORKSPACE_ID: task.id,
      DEVBOX_BACKEND_BASE_URL: this.options.apiBaseUrl,
      DEVBOX_BACKEND_TOKEN: task.token,
      DEVBOX_DAEMON_PRIVATE_DIR: containerDaemonPrivateDir,
      XDG_CONFIG_HOME: `${containerHome}/.config`,
      XDG_DATA_HOME: `${containerHome}/.local/share`,
      XDG_CACHE_HOME: `${containerHome}/.cache`,
      XDG_STATE_HOME: `${containerHome}/.local/state`,
      TRACEPARENT: task.traceparent,
    };
    return this.docker.createContainer({
      name,
      Image: task.image,
      platform: task.platform,
      User: `${containerDaemonUid}:${containerSharedGid}`,
      WorkingDir: "/workspace",
      Entrypoint: ["/usr/local/bin/devboxes-executor"],
      Cmd: [],
      Env: Object.entries(environment).map(([key, value]) => `${key}=${value}`),
      Labels: { "devboxes.task": task.id },
      HostConfig: {
        AutoRemove: false,
        CapDrop: ["ALL"],
        CapAdd: ["DAC_OVERRIDE", "SETGID", "SETUID"],
        SecurityOpt: ["no-new-privileges"],
        Mounts: [
          {
            Type: "bind",
            Source: binary,
            Target: "/usr/local/bin/devboxes-executor",
            ReadOnly: true,
          },
        ],
        Tmpfs: {
          [containerDaemonPrivateDir]: `rw,noexec,nosuid,size=1g,mode=0700,${agentOwner}`,
          [containerDaemonExecutableDir]: `rw,exec,nosuid,size=64m,mode=0700,${agentOwner}`,
          [`${containerHome}/.config`]: `rw,noexec,nosuid,size=512m,mode=0770,${agentOwner}`,
          [`${containerHome}/.local/share`]: `rw,noexec,nosuid,size=512m,mode=0770,${agentOwner}`,
        },
        ExtraHosts: ["host.docker.internal:host-gateway"],
      },
    });
  }
}
