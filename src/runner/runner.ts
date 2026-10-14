import { join } from "node:path";

import { platformConfigHome } from "@firops/connections/local/config";
import { dockerSocketPath } from "@firops/devbox/runner/docker-socket";
import type { Command } from "commander";

import { apiOrigin } from "../commands";
import { loadAccountContext } from "../connection";
import { listen } from "./listen";

export const addRunnerCommands = (program: Command) => {
  const command = program
    .command("runner")
    .description("Run registered native execution capacity")
    .command("listen")
    .description("Launch assigned Tasks and observe their Docker executors")
    .requiredOption("--token-file <path>", "Mode-0600 credential file from capacity.register")
    .option(
      "--state-directory <path>",
      "Downloaded daemon binary cache",
      join(platformConfigHome(), "devboxes", "runner"),
    )
    .option("--docker-socket <path>", "Docker socket path")
    .option("--daemon-api <url>", "Container-reachable API origin when it differs from --api");
  command.action(async () => {
    // Bun uploads its crash reports on macOS and Windows unless DO_NOT_TRACK is set when the
    // process starts, so the listener starts again with it.
    if (
      (process.platform === "darwin" || process.platform === "win32") &&
      process.env.DO_NOT_TRACK === undefined
    ) {
      const argv = [
        process.execPath,
        ...process.execArgv,
        ...process.argv.slice(Bun.isStandaloneExecutable ? 2 : 1),
      ];
      const env = { ...process.env, DO_NOT_TRACK: "1" };
      if (process.platform === "darwin") {
        if (!process.execve) throw new Error("The Runner needs process.execve on macOS.");
        process.execve(process.execPath, argv, env);
      }
      // Windows has no execve. Its console sends Ctrl+C to the listener too, and a forwarded signal
      // would terminate the listener before it drains, so this process only outlives it.
      const listener = Bun.spawn(argv, { env, stdio: ["inherit", "inherit", "inherit"] });
      process.on("SIGINT", () => {});
      process.exit(await listener.exited);
    }
    const options = command.optsWithGlobals<{
      api?: string;
      config?: string;
      tokenFile: string;
      stateDirectory: string;
      dockerSocket?: string;
      daemonApi?: string;
    }>();
    const origin = options.api
      ? apiOrigin(options.api)
      : apiOrigin((await loadAccountContext(options)).config.apiBaseUrl);
    const socketPath = options.dockerSocket ?? dockerSocketPath();
    await listen({
      apiOrigin: origin,
      daemonApiBaseUrl: `${apiOrigin(options.daemonApi ?? origin)}/api`,
      tokenFile: options.tokenFile,
      stateDirectory: options.stateDirectory,
      socketPath,
    });
  });
};
