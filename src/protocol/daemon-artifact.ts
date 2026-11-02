export const opencodeDaemonBootstrapProtocol = "devboxes-daemon-bootstrap-v1";

export const opencodeDaemonPlatforms = ["linux/amd64", "linux/arm64"] as const;
export type OpencodeDaemonPlatform = (typeof opencodeDaemonPlatforms)[number];

export const defaultOpencodeDaemonPlatform: OpencodeDaemonPlatform = "linux/amd64";

export type OpencodeDaemonArtifact = {
  version: string;
  platform?: OpencodeDaemonPlatform;
  sha256: string;
  bootstrapProtocol: typeof opencodeDaemonBootstrapProtocol;
};
