import { afterEach, describe, expect, it } from "bun:test";

import { dockerSocketPath } from "./docker-socket";

// The wire client is dockerode; what stays ours — and needs pinning — is the
// policy for WHICH socket the runner may drive.
describe("docker socket policy", () => {
  const originalEnv = {
    DEVBOX_OPENCODE_DOCKER_SOCKET_PATH: process.env.DEVBOX_OPENCODE_DOCKER_SOCKET_PATH,
    DOCKER_HOST: process.env.DOCKER_HOST,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("prefers the explicit config and strips the unix scheme", () => {
    process.env.DEVBOX_OPENCODE_DOCKER_SOCKET_PATH = "unix:///custom/docker.sock";
    process.env.DOCKER_HOST = "unix:///ignored/docker.sock";
    expect(dockerSocketPath()).toBe("/custom/docker.sock");
  });

  it("honors DOCKER_HOST only for local unix and npipe sockets", () => {
    delete process.env.DEVBOX_OPENCODE_DOCKER_SOCKET_PATH;
    process.env.DOCKER_HOST = "unix:///var/run/orbstack.sock";
    expect(dockerSocketPath()).toBe("/var/run/orbstack.sock");

    process.env.DOCKER_HOST = "npipe:////./pipe/docker_engine";
    expect(dockerSocketPath()).toBe("//./pipe/docker_engine");
  });

  it("rejects remote TCP engines: the runner must never drive a daemon it does not share a machine with", () => {
    delete process.env.DEVBOX_OPENCODE_DOCKER_SOCKET_PATH;
    process.env.DOCKER_HOST = "tcp://10.0.0.5:2375";
    expect(() => dockerSocketPath()).toThrow(/local Docker socket/);
  });

  it("falls back to the platform default socket", () => {
    delete process.env.DEVBOX_OPENCODE_DOCKER_SOCKET_PATH;
    delete process.env.DOCKER_HOST;
    expect(dockerSocketPath()).toBe(
      process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock",
    );
  });
});
