import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dockerSocketPath } from "./docker-socket";

describe("docker socket of the Docker CLI's configuration", () => {
  const originalEnv = {
    DOCKER_CONFIG: process.env.DOCKER_CONFIG,
    DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
    DOCKER_HOST: process.env.DOCKER_HOST,
  };
  let configDirectory = "";

  /** Creates the Docker context `name` for the engine at `host`, with the Docker CLI itself. */
  const createContext = (name: string, host: string) =>
    execFileSync("docker", ["context", "create", name, "--docker", `host=${host}`], {
      stdio: "ignore",
    });

  beforeEach(async () => {
    configDirectory = await mkdtemp(join(tmpdir(), "docker-config-"));
    process.env.DOCKER_CONFIG = configDirectory;
    delete process.env.DOCKER_CONTEXT;
    delete process.env.DOCKER_HOST;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(configDirectory, { recursive: true, force: true });
  });

  it("uses the current context when DOCKER_HOST is unset, as a rootless setup leaves it", () => {
    createContext("rootless", "unix:///run/user/1001/docker.sock");
    execFileSync("docker", ["context", "use", "rootless"], { stdio: "ignore" });

    expect(dockerSocketPath()).toBe("/run/user/1001/docker.sock");
  });

  it("uses DOCKER_CONTEXT over the current context", () => {
    createContext("rootless", "unix:///run/user/1001/docker.sock");
    createContext("orbstack", "unix:///var/run/orbstack.sock");
    execFileSync("docker", ["context", "use", "rootless"], { stdio: "ignore" });
    process.env.DOCKER_CONTEXT = "orbstack";

    expect(dockerSocketPath()).toBe("/var/run/orbstack.sock");
  });

  it("uses DOCKER_HOST over every context", () => {
    createContext("rootless", "unix:///run/user/1001/docker.sock");
    execFileSync("docker", ["context", "use", "rootless"], { stdio: "ignore" });
    process.env.DOCKER_HOST = "unix:///var/run/orbstack.sock";

    expect(dockerSocketPath()).toBe("/var/run/orbstack.sock");
  });

  it("refuses a remote engine: the Runner must never drive a daemon it does not share a machine with", () => {
    process.env.DOCKER_HOST = "tcp://10.0.0.5:2375";

    expect(() => dockerSocketPath()).toThrow(
      "The Docker CLI uses the engine at tcp://10.0.0.5:2375, but a Runner needs a local Docker socket",
    );
  });

  it("falls back to the platform's default socket", () => {
    expect(dockerSocketPath()).toBe(
      process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock",
    );
  });
});
