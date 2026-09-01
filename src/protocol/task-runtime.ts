import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { OpencodeLaunchSpec } from "./launch-spec";

export const containerHome = "/home/workspace";
export const containerDaemonUid = 0;
export const containerAgentUid = 1001;
export const containerSharedGid = 1000;
export const containerDaemonPrivateDir = "/run/devboxes/daemon";
export const containerDaemonExecutableDir = "/run/devboxes/exec";
export const containerDaemonNodeModulesDir = `${containerDaemonExecutableDir}/node_modules`;
export const containerDaemonDataDir = "/var/lib/devboxes";
export const containerOpencodeDatabasePath = `${containerDaemonDataDir}/opencode.sqlite`;
export const containerSecretsDir = "/run/devboxes/secrets";
export const containerBackendTokenFile = `${containerSecretsDir}/backend-token`;
export const containerOpencodeConfigJsonFile = `${containerSecretsDir}/opencode-config.json`;
export const daemonEntrypoint = "/entrypoint.sh";

export type OpencodeRunnerState = {
  Status: string;
  Running: boolean;
  OOMKilled: boolean;
  ExitCode: number;
  Error: string;
  FinishedAt: string;
};

export type OpencodeTaskLaunchInput = {
  organizationId: string;
  taskId: string;
  runId: string;
  apiKey: string;
  // Base URL the in-container daemon fetches provider auth from: the listener's
  // local credential broker for listener-launched tasks, or the dashboard's
  // internal API prefix for dashboard/Kubernetes-launched tasks. The spec's
  // providerAuthSource decided which; the runtime owns the URL value.
  providerAuthUrl: string;
  imageRef: string;
  // Server-authored at claim time: env, entrypoint, working dir, labels,
  // memory-backed paths. Runtimes execute it and add machine mechanics only.
  launchSpec: OpencodeLaunchSpec;
  containerId?: string | null;
};

export type OpencodeTaskStopInput = {
  taskId: string;
  organizationId: string;
  containerId: string | null;
};

export type OpencodeTaskInspectInput = {
  taskId: string;
  containerId: string | null;
  containerName: string;
};

export type OpencodeStartedTask = {
  containerId: string;
  containerName: string;
  image: string;
  taskId: string;
};

export type OpencodeStoppedTask = {
  containerId: string | null;
  containerName: string;
  stopped: boolean;
};

export type OpencodeLeftoverTask = {
  taskId: string;
  organizationId: string;
  containerId: string | null;
  containerName: string;
};

export const taskContainerName = (taskId: string) => {
  if (!taskId) throw new Error("Opencode task id is required for task container names.");
  const hash = createHash("sha256").update(taskId).digest("hex").slice(0, 12);
  return `firops-opencode-task-${hash}`;
};

// Frozen (see FROZEN.md): committed crash-recovery snapshots must stay
// recognizable to whichever listener build runs after an upgrade, or stopped
// tasks would leak their state images on the runner host forever.
export const taskStateImageRepo = "firops/opencode-task-state";

export const taskStateImage = (taskId: string) => {
  const tag = createHash("sha256").update(taskId).digest("hex").slice(0, 12);
  return { repo: taskStateImageRepo, tag, ref: `${taskStateImageRepo}:${tag}` };
};

const providerAuthProtocols = new Set(["http:", "https:"]);

// Provider-auth URLs are composed server-side from trusted configuration, but
// they cross the launch contract, land in container env, and get suffixed with
// the task route — so they must be clean absolute HTTP(S) base URLs.
export const validatedProviderAuthUrl = (value: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Opencode provider-auth URL must be an absolute HTTP(S) URL.");
  }
  if (!providerAuthProtocols.has(url.protocol)) {
    throw new Error("Opencode provider-auth URL must be an HTTP(S) URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "Opencode provider-auth URL must not contain credentials, query, or fragment data.",
    );
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
};

export const hostOpencodeConfigJsonBase64 = (opencodeConfigDir?: string) => {
  try {
    const opencodeConfigPath = join(
      opencodeConfigDir ?? join(homedir(), ".config", "opencode"),
      "opencode.json",
    );
    return Buffer.from(readFileSync(opencodeConfigPath, "utf8")).toString("base64");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
    return undefined;
  }
};
