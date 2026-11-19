import Type, { type Static } from "typebox";

export const containerHome = "/home/workspace";
export const containerDaemonUid = 0;
export const containerAgentUid = 1001;
export const containerSharedGid = 1000;
/** The uid and gid of a Claude subscription Run's Claude Code, which the agent can't read or signal. */
export const containerClaudeCodeUid = 1002;
/** Where a Workspace Image keeps its trusted CA certificates, unless SSL_CERT_FILE names a file. */
export const containerCaBundle = "/etc/ssl/certs/ca-certificates.crt";
/** The same trusted CA certificates as a Java trust store, which a Workspace Image builds from them. */
export const containerJavaTrustStore = "/etc/ssl/certs/java/cacerts";
export const containerDaemonPrivateDir = "/run/devboxes/daemon";
export const containerDaemonExecutableDir = "/run/devboxes/exec";
export const containerWorkspace = "/workspace";
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
  ".local/share/pnpm/store",
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
 * The environment every Task executor receives, apart from its runtime's executor identity. It
 * carries no credential: a Runner writes the Run token to the executor's stdin, and a managed Task,
 * whose executor holds only the token's stand-in, names its egress proxy's files in
 * `DEVBOX_EGRESS_DIR`, which only a managed Task sets.
 */
export const executorEnvironment = (task: {
  id: string;
  apiBaseUrl: string;
  traceparent: string;
  /** The managed Task's egress proxy files; a Runner Task has none. */
  egressDir?: string;
}) => ({
  HOME: containerHome,
  WORKSPACE: containerWorkspace,
  DEVBOX_WORKSPACE_CAPABILITY: "agent-task",
  DEVBOX_WORKSPACE_CAPABILITY_ID: task.id,
  OPENCODE_WORKSPACE_ID: task.id,
  DEVBOX_BACKEND_BASE_URL: task.apiBaseUrl,
  DEVBOX_DAEMON_PRIVATE_DIR: containerDaemonPrivateDir,
  ...Object.fromEntries(
    Object.entries(xdgHomes).map(([variable, directory]) => [
      variable,
      `${containerHome}/${directory}`,
    ]),
  ),
  TRACEPARENT: task.traceparent,
  ...(task.egressDir && { DEVBOX_EGRESS_DIR: task.egressDir }),
});
