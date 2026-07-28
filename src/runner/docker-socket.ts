// Socket-path policy for the Docker engine the runner drives. The wire
// client is dockerode; what stays ours is WHICH socket is acceptable:
// explicit config first, DOCKER_HOST only when it points at a local
// unix/npipe socket, and remote TCP engines rejected — the runner must
// never drive a Docker daemon it does not share a machine with.
export const dockerSocketPath = () => {
  const configuredSocketPath = process.env.DEVBOX_OPENCODE_DOCKER_SOCKET_PATH;
  if (configuredSocketPath) return configuredSocketPath.replace(/^unix:\/\//, "");

  const dockerHost = process.env.DOCKER_HOST;
  if (dockerHost?.startsWith("unix://")) return dockerHost.replace(/^unix:\/\//, "");
  if (dockerHost?.startsWith("npipe:////./pipe/")) {
    return `//./pipe/${dockerHost.slice("npipe:////./pipe/".length)}`;
  }
  if (dockerHost?.startsWith("npipe://")) return dockerHost.replace(/^npipe:\/\//, "");
  if (dockerHost) {
    throw new Error(
      "DOCKER_HOST must point at a local Docker socket, for example unix:///var/run/docker.sock.",
    );
  }

  if (process.platform === "win32") return "//./pipe/docker_engine";
  return "/var/run/docker.sock";
};
