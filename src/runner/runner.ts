import { join } from "node:path";

import { platformConfigHome } from "../connections/config";
import { dockerSocketPath } from "./docker-socket";
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
