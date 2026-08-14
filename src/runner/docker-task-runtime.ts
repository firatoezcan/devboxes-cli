import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { armor, Decrypter, Encrypter } from "age-encryption";
import Docker from "dockerode";
import Type, { type Static } from "typebox";
import Value from "typebox/value";

import { reconciliationLabels } from "../protocol/frozen";
import {
  validateOpencodeProviderAuth,
  type OpencodeProviderAuthJson,
} from "../protocol/provider-auth";
import {
  containerAgentUid,
  containerBackendTokenFile,
  containerDaemonPrivateDir,
  containerDaemonUid,
  containerOpencodeConfigJsonFile,
  containerSharedGid,
  hostOpencodeConfigJsonBase64,
  taskContainerName,
  taskStateImage,
  validatedProviderAuthUrl,
  type OpencodeLeftoverTask,
  type OpencodeRunnerState,
  type OpencodeTaskInspectInput,
  type OpencodeTaskLaunchInput,
  type OpencodeTaskStopInput,
} from "../protocol/task-runtime";
import { writeSecretFile } from "../secret-file";
import { runnerRuntimeEnv } from "./runtime-env";

type TaskSecretFiles = {
  backendTokenFile: string;
  secretDir: string;
  opencodeConfigJsonFile?: string;
};

const FileSystemErrorSchema = Type.Object({ code: Type.String() }, { additionalProperties: true });

const ProviderAuthSnapshotSchema = Type.Object(
  {
    providerId: Type.String(),
    auth: Type.Object({ type: Type.String({ minLength: 1 }) }, { additionalProperties: true }),
  },
  { additionalProperties: true },
);

// Control-plane calls (inspect, create, start, stop, remove, list) complete
// in milliseconds; a wedged dockerd must surface as an error instead of
// hanging the poll loop. Pulls and commits stream for as long as layers
// take, so they run on a client without a deadline.
const controlTimeoutMs = 120_000;

const defaultTaskSecretRoot = resolve(
  tmpdir(),
  "devboxes-dashboard-opencode",
  createHash("sha256").update(process.cwd()).digest("hex").slice(0, 12),
  "secrets",
);

const taskSecretRoot = () => {
  if (runnerRuntimeEnv.opencodeHomeRoot) {
    return resolve(runnerRuntimeEnv.opencodeHomeRoot, "secrets");
  }
  return defaultTaskSecretRoot;
};

const taskSecretDirectory = (organizationId: string, taskId: string) => {
  const secretRoot = taskSecretRoot();
  const secretDir = resolve(secretRoot, organizationId, taskId);
  if (!secretDir.startsWith(`${secretRoot}${sep}`)) {
    throw new Error("Opencode task secret path escaped the task secret root.");
  }
  return secretDir;
};

const prepareTaskSecretFiles = async (input: {
  organizationId: string;
  tokenScopeId: string;
  backendToken: string;
  opencodeConfigJsonBase64?: string;
}): Promise<TaskSecretFiles> => {
  const secretDir = taskSecretDirectory(input.organizationId, input.tokenScopeId);
  // Owner-only directories, matching writeSecretFile: the default root lives
  // under the world-writable tmpdir, and 0755 intermediate dirs would let any
  // local user enumerate live organization and task ids.
  await mkdir(secretDir, { recursive: true, mode: 0o700 });

  // writeFile only applies `mode` when it creates the file, so chmod
  // explicitly — re-adoption rewrites an existing token file in place.
  const backendTokenFile = join(secretDir, "backend-token");
  await writeFile(backendTokenFile, input.backendToken, { mode: 0o600 });
  await chmod(backendTokenFile, 0o600);

  let opencodeConfigJsonFile: string | undefined;
  if (input.opencodeConfigJsonBase64) {
    opencodeConfigJsonFile = join(secretDir, "opencode-config.json");
    await writeFile(opencodeConfigJsonFile, Buffer.from(input.opencodeConfigJsonBase64, "base64"), {
      mode: 0o600,
    });
    await chmod(opencodeConfigJsonFile, 0o600);
  }

  return {
    backendTokenFile,
    secretDir,
    opencodeConfigJsonFile,
  };
};

const removeOpencodeTaskDockerSecrets = async (input: {
  organizationId: string;
  taskId: string;
}) => {
  const taskSecretDir = taskSecretDirectory(input.organizationId, input.taskId);
  await rm(taskSecretDir, {
    recursive: true,
    force: true,
  });
};

const directoryEntries = async (path: string) => {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    let fileSystemError: Static<typeof FileSystemErrorSchema>;
    try {
      fileSystemError = Value.Parse(FileSystemErrorSchema, error);
    } catch {
      throw error;
    }
    if (fileSystemError.code === "ENOENT") {
      return [];
    }
    throw error;
  }
};

const removeStateImage = async (docker: Docker, stateImage: string) => {
  try {
    await docker.getImage(stateImage).remove({ force: true });
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return;
    throw error;
  }
};

export class DockerOpencodeTaskRuntime {
  constructor(private readonly options: { daemonApiBaseUrl: string }) {}

  async persistProviderAuthSnapshot(input: {
    organizationId: string;
    taskId: string;
    providerId: string;
    providerAuth: OpencodeProviderAuthJson;
    passphrase: string;
  }) {
    const auth = input.providerAuth[input.providerId];
    if (!auth) {
      throw new Error(`Claimed provider auth for ${input.providerId} is unavailable.`);
    }
    const validated = validateOpencodeProviderAuth(input.providerId, auth);
    const encrypter = new Encrypter();
    encrypter.setScryptWorkFactor(12);
    encrypter.setPassphrase(input.passphrase);
    const ciphertext = await encrypter.encrypt(
      JSON.stringify({ providerId: input.providerId, auth: validated }),
    );
    await writeSecretFile({
      path: join(taskSecretDirectory(input.organizationId, input.taskId), "provider-auth.age"),
      contents: `${armor.encode(ciphertext)}\n`,
      tmpPrefix: ".provider-auth.",
    });
  }

  async readProviderAuthSnapshot(input: {
    organizationId: string;
    taskId: string;
    providerId: string;
    passphrase: string;
  }): Promise<OpencodeProviderAuthJson> {
    try {
      const armored = await readFile(
        join(taskSecretDirectory(input.organizationId, input.taskId), "provider-auth.age"),
        "utf8",
      );
      const decrypter = new Decrypter();
      decrypter.addPassphrase(input.passphrase);
      const plaintext = await decrypter.decrypt(armor.decode(armored), "text");
      const snapshot = Value.Parse(ProviderAuthSnapshotSchema, JSON.parse(plaintext));
      if (snapshot.providerId !== input.providerId) {
        throw new Error("Provider auth snapshot identity does not match the task claim.");
      }
      return {
        [input.providerId]: validateOpencodeProviderAuth(input.providerId, snapshot.auth),
      };
    } catch (error) {
      throw new Error(
        `Claim-captured provider auth for ${input.providerId} is unavailable after runner restart.`,
        { cause: error },
      );
    }
  }

  // Surfaces every task container and per-task secret directory left on this host so
  // the runner can tear down the ones whose tasks already finished elsewhere.
  async listLeftoverTasks(): Promise<OpencodeLeftoverTask[]> {
    const socketPath = runnerRuntimeEnv.dockerSocketPath;
    if (!socketPath) {
      throw new Error("DEVBOX_OPENCODE_DOCKER_SOCKET_PATH is not configured.");
    }

    const docker = new Docker({ socketPath, timeout: controlTimeoutMs });
    const containers = await docker.listContainers({
      all: true,
      filters: {
        label: [`${reconciliationLabels.workload}=${reconciliationLabels.workloadValue}`],
      },
    });

    const leftovers = new Map<string, OpencodeLeftoverTask>();
    for (const container of containers) {
      const taskId = container.Labels?.[reconciliationLabels.taskId];
      const organizationId = container.Labels?.[reconciliationLabels.organizationId];
      if (!taskId || !organizationId) continue;
      leftovers.set(taskId, {
        taskId,
        organizationId,
        containerId: container.Id,
        containerName: container.Names?.[0]?.replace(/^\//, "") ?? taskContainerName(taskId),
      });
    }

    const secretRoot = taskSecretRoot();
    for (const organizationDir of await directoryEntries(secretRoot)) {
      if (!organizationDir.isDirectory()) continue;
      for (const taskDir of await directoryEntries(resolve(secretRoot, organizationDir.name))) {
        if (!taskDir.isDirectory() || leftovers.has(taskDir.name)) continue;
        leftovers.set(taskDir.name, {
          taskId: taskDir.name,
          organizationId: organizationDir.name,
          containerId: null,
          containerName: taskContainerName(taskDir.name),
        });
      }
    }

    return [...leftovers.values()];
  }

  // Re-adoption after a runner restart mints a fresh per-task token; the
  // running container's read-only bind mount must serve the same token the
  // broker now expects, so rewrite the host-side file in place (the inode is
  // preserved, so the mounted file reflects the new content).
  async refreshBackendToken(input: {
    organizationId: string;
    taskId: string;
    backendToken: string;
  }) {
    await prepareTaskSecretFiles({
      organizationId: input.organizationId,
      tokenScopeId: input.taskId,
      backendToken: input.backendToken,
    });
  }

  async launchTask(input: OpencodeTaskLaunchInput) {
    const socketPath = runnerRuntimeEnv.dockerSocketPath;
    if (!socketPath) {
      throw new Error("DEVBOX_OPENCODE_DOCKER_SOCKET_PATH is not configured.");
    }

    const docker = new Docker({ socketPath, timeout: controlTimeoutMs });
    const streamingDocker = new Docker({ socketPath });
    const name = taskContainerName(input.taskId);
    const opencodeConfigJsonBase64 = hostOpencodeConfigJsonBase64(
      runnerRuntimeEnv.opencodeConfigDir,
    );
    const secretFiles = await prepareTaskSecretFiles({
      organizationId: input.organizationId,
      tokenScopeId: input.taskId,
      backendToken: input.apiKey,
      opencodeConfigJsonBase64,
    });

    let createdContainerId: string | null = null;
    let committedStateImage: string | null = null;
    try {
      let existing = input.containerId
        ? await docker
            .getContainer(input.containerId)
            .inspect()
            .catch((error) => {
              if ((error as { statusCode?: number }).statusCode === 404) return null;
              throw error;
            })
        : null;

      if (!existing) {
        existing = await docker
          .getContainer(name)
          .inspect()
          .catch((error) => {
            if ((error as { statusCode?: number }).statusCode === 404) return null;
            throw error;
          });
      }

      // An existing container holds committed task state: snapshot it into an image
      // and relaunch from that snapshot instead of the original imageRef.
      let image = input.imageRef;
      if (existing) {
        const stateSnapshot = taskStateImage(input.taskId);
        image = stateSnapshot.ref;
        committedStateImage = image;
        await streamingDocker
          .getContainer(existing.Id)
          .commit({ repo: stateSnapshot.repo, tag: stateSnapshot.tag });
        await docker.getContainer(existing.Id).remove({ force: true });
      } else {
        // pull() resolves to the progress stream, not to completion; the
        // engine reports layer-by-layer and followProgress waits for the end.
        const pullStream = await streamingDocker.pull(input.imageRef);
        await new Promise<void>((resolvePull, rejectPull) => {
          streamingDocker.modem.followProgress(pullStream, (error) =>
            error ? rejectPull(error) : resolvePull(),
          );
        });
      }

      // The server-authored spec carries every product decision; this
      // runtime overlays only the client-owned env keys whose values live
      // on this machine (broker URL, docker-reachable API base, whether a
      // host opencode.json exists).
      const environment = {
        ...input.launchSpec.env,
        DEVBOX_BACKEND_BASE_URL: this.options.daemonApiBaseUrl,
        DEVBOX_OPENCODE_PROVIDER_AUTH_URL: validatedProviderAuthUrl(input.providerAuthUrl),
        // First engine boot after a cold runtime start exceeded 30s twice in prod E2E.
        OPENCODE_READY_MS: "120000",
        DEVBOX_OPENCODE_CONFIG_JSON_FILE: secretFiles.opencodeConfigJsonFile
          ? containerOpencodeConfigJsonFile
          : undefined,
      } satisfies Record<string, string | undefined>;

      const created = await docker.createContainer({
        name,
        Image: image,
        Env: Object.entries(environment).flatMap(([name, value]) =>
          value === undefined ? [] : [`${name}=${value}`],
        ),
        WorkingDir: input.launchSpec.workingDir,
        Entrypoint: [input.launchSpec.entrypoint],
        User: `${containerDaemonUid}:${containerSharedGid}`,
        Labels: {
          ...input.launchSpec.labels,
          // Reconciliation reads these back after restarts, so the reader
          // and writer must be the same binary: runtime-composed, and they
          // win over anything served.
          [reconciliationLabels.workload]: reconciliationLabels.workloadValue,
          [reconciliationLabels.organizationId]: input.organizationId,
          [reconciliationLabels.taskId]: input.taskId,
        },
        HostConfig: {
          AutoRemove: false,
          CapDrop: ["ALL"],
          CapAdd: ["CHOWN", "DAC_OVERRIDE", "SETGID", "SETUID"],
          SecurityOpt: ["no-new-privileges"],
          Mounts: [
            {
              Type: "bind" as const,
              Source: secretFiles.backendTokenFile,
              Target: containerBackendTokenFile,
              ReadOnly: true,
            },
            ...(secretFiles.opencodeConfigJsonFile
              ? [
                  {
                    Type: "bind" as const,
                    Source: secretFiles.opencodeConfigJsonFile,
                    Target: containerOpencodeConfigJsonFile,
                    ReadOnly: true,
                  },
                ]
              : []),
          ],
          // The spec names which container paths hold decrypted provider
          // keys; tmpfs keeps them out of the writable layer that the
          // crash-recovery `docker commit` snapshots into an image. The
          // option string is docker mechanics and stays runtime-owned.
          Tmpfs: Object.fromEntries([
            [
              containerDaemonPrivateDir,
              `rw,noexec,nosuid,size=512m,mode=0700,uid=${containerDaemonUid},gid=${containerSharedGid}`,
            ],
            ...input.launchSpec.memoryBackedPaths.map((path) => [
              path,
              // opencode's working SQLite database lives under the memory-backed
              // opencode data dir, so the size must fit a real session's DB and
              // WAL. The stable engine owns its runtime tree; the daemon retains
              // shared-group access.
              `rw,noexec,nosuid,size=512m,mode=0770,uid=${containerAgentUid},gid=${containerSharedGid}`,
            ]),
          ]),
          ExtraHosts: ["host.docker.internal:host-gateway"],
        },
      });
      createdContainerId = created.id;

      await created.start();

      return {
        containerId: created.id,
        containerName: name,
        image,
        taskId: input.taskId,
      };
    } catch (error) {
      await removeOpencodeTaskDockerSecrets({
        organizationId: input.organizationId,
        taskId: input.taskId,
      });
      if (createdContainerId) {
        await docker
          .getContainer(createdContainerId)
          .remove({ force: true })
          .catch((cleanupError) => {
            if ((cleanupError as { statusCode?: number }).statusCode === 404) return;
            throw cleanupError;
          });
      }
      if (committedStateImage) {
        await removeStateImage(docker, committedStateImage);
      }
      throw error;
    }
  }

  async stopTask(input: OpencodeTaskStopInput) {
    const organizationId = input.organizationId;
    const socketPath = runnerRuntimeEnv.dockerSocketPath;
    if (!socketPath) {
      throw new Error("DEVBOX_OPENCODE_DOCKER_SOCKET_PATH is not configured.");
    }

    const docker = new Docker({ socketPath, timeout: controlTimeoutMs });
    const name = taskContainerName(input.taskId);
    // The launch path commits crash-recovery snapshots under this tag; they
    // must not outlive the task on the runner host.
    const stateImage = taskStateImage(input.taskId).ref;
    const container =
      input.containerId ??
      (await docker
        .getContainer(name)
        .inspect()
        .then((inspected) => inspected.Id)
        .catch((error) => {
          if ((error as { statusCode?: number }).statusCode === 404) return null;
          throw error;
        }));

    if (!container) {
      await removeStateImage(docker, stateImage);
      await removeOpencodeTaskDockerSecrets({
        organizationId,
        taskId: input.taskId,
      });
      return { containerId: null, containerName: name, stopped: false };
    }

    await docker
      .getContainer(container)
      .stop({ t: 0 })
      .catch((error) => {
        const statusCode = (error as { statusCode?: number }).statusCode;
        // 304: already stopped; 404: already gone. Both are the desired state.
        if (statusCode === 304 || statusCode === 404) return;
        throw error;
      });
    await docker
      .getContainer(container)
      .remove({ force: true })
      .catch((error) => {
        if ((error as { statusCode?: number }).statusCode === 404) return;
        throw error;
      });
    const deletionDeadline = Date.now() + 10_000;
    for (;;) {
      const existing = await docker
        .getContainer(container)
        .inspect()
        .catch((error) => {
          if ((error as { statusCode?: number }).statusCode === 404) return null;
          throw error;
        });
      if (!existing) break;
      if (Date.now() >= deletionDeadline) {
        throw new Error("Docker task container still exists after removal was requested.");
      }
      await Bun.sleep(100);
    }
    await removeStateImage(docker, stateImage);
    await removeOpencodeTaskDockerSecrets({
      organizationId,
      taskId: input.taskId,
    });

    return { containerId: container, containerName: name, stopped: true };
  }

  async inspectTask(input: OpencodeTaskInspectInput) {
    const socketPath = runnerRuntimeEnv.dockerSocketPath;
    if (!socketPath) {
      throw new Error("DEVBOX_OPENCODE_DOCKER_SOCKET_PATH is not configured.");
    }

    const docker = new Docker({ socketPath, timeout: controlTimeoutMs });

    try {
      const container = await docker
        .getContainer(input.containerId ?? input.containerName)
        .inspect();
      return container.State satisfies OpencodeRunnerState;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return null;
      throw error;
    }
  }
}
