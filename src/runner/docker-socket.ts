/**
 * The local socket of the Docker engine that the `docker` command on this machine talks to. The
 * Docker CLI answers, so DOCKER_HOST, DOCKER_CONTEXT, the current context of the Docker
 * configuration and the platform default apply exactly as they do for `docker`. A remote engine is
 * refused, because the Runner must share a machine with the daemon it drives.
 */
export const dockerSocketPath = () => {
  if (!Bun.which("docker"))
    throw new Error(
      "devboxes finds the Docker engine the way the docker command does, so docker must be on PATH.",
    );
  const inspected = Bun.spawnSync(
    ["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
    { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  if (inspected.exitCode !== 0)
    throw new Error(
      `docker context inspect failed, so devboxes cannot tell which Docker engine to use: ${inspected.stderr.toString().trim()}`,
    );
  const host = inspected.stdout.toString().trim();
  if (host.startsWith("unix://")) return host.slice("unix://".length);
  if (host.startsWith("npipe://")) return host.slice("npipe://".length);
  throw new Error(
    `The Docker CLI uses the engine at ${host}, but a Runner needs a local Docker socket, for example unix:///var/run/docker.sock.`,
  );
};
