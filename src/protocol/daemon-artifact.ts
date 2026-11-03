export const opencodeDaemonBootstrapProtocol = "devboxes-daemon-bootstrap-v1";

export const opencodeDaemonPlatforms = ["linux/amd64", "linux/arm64"] as const;
export type OpencodeDaemonPlatform = (typeof opencodeDaemonPlatforms)[number];

export const defaultOpencodeDaemonPlatform: OpencodeDaemonPlatform = "linux/amd64";

/**
 * The platform of the Tasks a Docker engine runs, by the machine architecture its `/info` reports
 * as `Architecture`, which is uname's name for it. A Runner reports it with every claim.
 */
export const dockerArchitecturePlatforms: ReadonlyMap<string, OpencodeDaemonPlatform> = new Map([
  ["x86_64", "linux/amd64"],
  ["aarch64", "linux/arm64"],
]);

export type OpencodeDaemonArtifact = {
  version: string;
  platform?: OpencodeDaemonPlatform;
  sha256: string;
  bootstrapProtocol: typeof opencodeDaemonBootstrapProtocol;
};
