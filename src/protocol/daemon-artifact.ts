export const opencodeDaemonBootstrapProtocol = "devboxes-daemon-bootstrap-v1";

export const opencodeDaemonPlatforms = ["linux/amd64", "linux/arm64"] as const;
export type OpencodeDaemonPlatform = (typeof opencodeDaemonPlatforms)[number];

// The single owner of the daemon platform default for artifacts resolved with
// the implicit launch platform;
// apps/elysia-opencode/scripts/build-daemon-release.ts mirrors it.
export const defaultOpencodeDaemonPlatform: OpencodeDaemonPlatform = "linux/amd64";

export type OpencodeDaemonArtifact = {
  version: string;
  platform?: OpencodeDaemonPlatform;
  sha256: string;
  bootstrapProtocol: typeof opencodeDaemonBootstrapProtocol;
};

// Queued work carries the current release channel and the entrypoint contract.
// Claim resolves that channel to one immutable release id, platform, and
// sha256, then persists the exact artifact before launch.
export type OpencodeDaemonPin = {
  version: string;
  bootstrapProtocol: typeof opencodeDaemonBootstrapProtocol;
  platform?: OpencodeDaemonPlatform;
  sha256?: string;
};
