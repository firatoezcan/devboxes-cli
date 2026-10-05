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
