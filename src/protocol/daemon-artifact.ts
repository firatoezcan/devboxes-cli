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

// What an enqueued task pins: the daemon version and the entrypoint contract.
// Platform and sha256 are deliberately absent until claim time, when the
// claiming machine's architecture resolves them (a requeue onto a
// different-arch machine re-resolves). The persisted row carries the resolved
// artifact afterwards.
export type OpencodeDaemonPin = {
  version: string;
  bootstrapProtocol: typeof opencodeDaemonBootstrapProtocol;
  platform?: OpencodeDaemonPlatform;
  sha256?: string;
};
