import Type, { type Static } from "typebox";

export const containerHome = "/home/workspace";
export const containerDaemonUid = 0;
export const containerAgentUid = 1001;
export const containerSharedGid = 1000;
/** The uid and gid of a Claude subscription Run's Claude Code, which the agent can't read or signal. */
export const containerClaudeCodeUid = 1002;
/** The uid and gid of a managed Task's egress proxy, apart from the agent's and Claude Code's. */
export const containerEgressUid = 1003;
/** Where the egress proxy writes its CA certificate and URL, which the executor mounts read-only. */
export const egressPublicDir = "/run/devboxes/egress";
/** The egress proxy's own state, the agent-vault database with its CA key, which only it mounts. */
export const egressPrivateDir = "/var/lib/devboxes-egress";
/** A managed Task's database Pod's PgBouncer configurations, auth files and certificate. */
export const databasePrivateDir = "/var/lib/devboxes-database";
/** The PgBouncer configuration of the database a Task's database Pod serves on `port`. */
export const databaseConfiguration = (port: number) =>
  `${databasePrivateDir}/${port}/pgbouncer.ini`;
/**
 * The memory, in MiB, that a managed Task's request leaves on its node for its database Pod, and
 * what the Pod's PgBouncers request: the first with the sandbox's own memory, each next one its
 * database's, as measured under gVisor.
 */
export const databasePodMemoryMi = { room: 512, first: 128, next: 96 };
/** The most databases a Run receives: as many as their PgBouncers fit the room for. */
export const databasesPerRunMax =
  1 + Math.floor((databasePodMemoryMi.room - databasePodMemoryMi.first) / databasePodMemoryMi.next);
/** Where a Workspace Image keeps its trusted CA certificates, unless SSL_CERT_FILE names a file. */
export const containerCaBundle = "/etc/ssl/certs/ca-certificates.crt";
/** The same trusted CA certificates as a Java trust store, which a Workspace Image builds from them. */
export const containerJavaTrustStore = "/etc/ssl/certs/java/cacerts";
export const containerDaemonPrivateDir = "/run/devboxes/daemon";
export const containerDaemonExecutableDir = "/run/devboxes/exec";
export const containerWorkspace = "/workspace";
/** Where the managed executor-bootstrap init container stages the executor for the Task container. */
export const managedExecutorDir = "/run/devboxes/executor";
export const managedExecutorPath = `${managedExecutorDir}/devboxes-executor`;
/**
 * The variables through which the API names, for each Kubernetes architecture the Task may run on,
 * the executor build that executor-bootstrap stages on a node of that architecture.
 */
export const managedExecutorVariables = {
  amd64: { url: "DEVBOX_EXECUTOR_AMD64_URL", sha256: "DEVBOX_EXECUTOR_AMD64_SHA256" },
  arm64: { url: "DEVBOX_EXECUTOR_ARM64_URL", sha256: "DEVBOX_EXECUTOR_ARM64_SHA256" },
} as const;
/**
 * The exit code of executor-bootstrap when the executor download stalled. Its termination message
 * then names the cause, which the Run's error quotes; every other failure exits 1 and writes none.
 */
export const executorDownloadStalledExitCode = 75;
/** Where executor-bootstrap prepares managedTmpSubPath, which the Task container mounts at /tmp. */
export const managedTmpVolumeDir = "/run/devboxes/tmp";
export const managedTmpSubPath = "tmp";
/** Where a Claude subscription Run's Task container finds the official Claude Code binary. */
export const containerClaudeCodeDir = "/run/devboxes/claude-code";
export const containerClaudeCodePath = `${containerClaudeCodeDir}/claude`;
/**
 * Claude Code's home, which is also where it reads policy settings on Linux, which no flag turns
 * off. Every Task container mounts an empty read-only directory there, so the Task image can't
 * configure Claude Code. The API image has none.
 */
export const containerClaudeCodeHome = "/etc/claude-code";
/**
 * The npm tarball of the Claude Code binary a Docker Runner stages, with the tarball's SHA-512
 * integrity and the hex SHA-512 of the `package/claude` it holds.
 */
export const ClaudeCodeArtifactSchema = Type.Object({
  url: Type.String(),
  integrity: Type.String({ pattern: "^sha512-[A-Za-z0-9+/]{86}==$" }),
  binarySha512: Type.String({ pattern: "^[0-9a-f]{128}$" }),
});
export type ClaudeCodeArtifact = Static<typeof ClaudeCodeArtifactSchema>;
/**
 * The home paths whose contents a new Project's work and fix Runs restore at their start and save at
 * their end, for the Project's later Runs. They are the dependency and toolchain caches that tools
 * download into, so a Run reuses what an earlier Run fetched.
 */
export const defaultToolCachePaths = [
  ".android",
  ".gradle/caches/modules-2",
  ".gradle/wrapper",
  ".m2/repository",
  ".npm",
  ".pub-cache",
  ".cache/pip",
  ".cache/go-build",
  "go/pkg/mod",
  ".cargo/registry",
  ".cargo/git",
  ".bun/install/cache",
  ".cache/ms-playwright",
];
/** The XDG base directories of the Task home, relative to it. */
const xdgHomes = {
  XDG_CONFIG_HOME: ".config",
  XDG_DATA_HOME: ".local/share",
  XDG_CACHE_HOME: ".cache",
  XDG_STATE_HOME: ".local/state",
};
/** OpenCode's own directories in the Task home, which a tool cache path may neither be nor hold. */
export const opencodeHomeDirectories = Object.values(xdgHomes).map(
  (directory) => `${directory}/opencode`,
);
/**
 * OpenCode's configuration and data directories in the Task home. They hold the connected Provider
 * Account credential and the Session database, which the Docker Runner keeps in memory so that a
 * failed executor it retains does not keep them on disk.
 */
export const opencodeMemoryHomeDirectories = [xdgHomes.XDG_CONFIG_HOME, xdgHomes.XDG_DATA_HOME].map(
  (directory) => `${directory}/opencode`,
);
/** How long the executor has after SIGTERM to drain a started Run and record its result. */
export const executorDrainSeconds = 120;
/**
 * How long the API keeps the Runs of a self-hosted Runner that stopped heartbeating. The listener
 * heartbeats on every poll and caps its retry backoff far below this window. An executor retries
 * each callback to an unavailable API for this long before it fails its Run, so a self-hosted Run
 * fails for an outage only when the API would also end it for the Runner's silence. Nothing in the
 * API reads a managed executor's silence; the API ends managed Runs from Sandbox state. For managed
 * Runs the bound is therefore a policy choice that covers a rollout or a node restart, and it
 * shares this constant so one executor build retries the same way under either kind of Runner.
 */
export const runnerHeartbeatExpiryMs = 10 * 60_000;

/** The environment every Task executor receives, apart from its runtime's executor identity. */
export const executorEnvironment = (task: {
  id: string;
  apiBaseUrl: string;
  token: string;
  traceparent: string;
}) => ({
  HOME: containerHome,
  WORKSPACE: containerWorkspace,
  DEVBOX_WORKSPACE: containerWorkspace,
  DEVBOX_WORKSPACE_CAPABILITY: "agent-task",
  DEVBOX_WORKSPACE_CAPABILITY_ID: task.id,
  OPENCODE_WORKSPACE_ID: task.id,
  DEVBOX_BACKEND_BASE_URL: task.apiBaseUrl,
  DEVBOX_BACKEND_TOKEN: task.token,
  DEVBOX_DAEMON_PRIVATE_DIR: containerDaemonPrivateDir,
  ...Object.fromEntries(
    Object.entries(xdgHomes).map(([variable, directory]) => [
      variable,
      `${containerHome}/${directory}`,
    ]),
  ),
  TRACEPARENT: task.traceparent,
});
