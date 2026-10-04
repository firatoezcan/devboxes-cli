import { log } from "@clack/prompts";
import {
  loadContext,
  persistTelemetrySetting,
  type DevboxesCliOptions,
} from "@firops/connections/local/config";
import {
  initializeCliTelemetry,
  validatedTelemetryDsn,
  validatedTelemetryEnvironment,
} from "@firops/platform/observability/cli-telemetry";
import { type Command } from "commander";

import { cliVersion } from "./api";

export const addTelemetryCommands = (program: Command) => {
  const telemetryCommand = program
    .command("telemetry")
    .description("manage optional CLI error reporting");

  const enableCommand = telemetryCommand.command("enable");
  enableCommand
    .description("send CLI error reports to your self-hosted Sentry instance")
    .requiredOption("--dsn <dsn>", "self-hosted Sentry DSN")
    .requiredOption("--environment <name>", "Sentry environment name")
    .action(async () => {
      const options = enableCommand.opts<{ dsn: string; environment: string }>();
      const dsn = validatedTelemetryDsn(options.dsn);
      const configPath = await persistTelemetrySetting(
        enableCommand.optsWithGlobals<DevboxesCliOptions>(),
        {
          dsn,
          environment: validatedTelemetryEnvironment(options.environment),
        },
      );
      log.success(`CLI error telemetry enabled in ${configPath}.`);
    });

  const disableCommand = telemetryCommand.command("disable");
  disableCommand.description("stop sending CLI error reports").action(async () => {
    await persistTelemetrySetting(disableCommand.optsWithGlobals<DevboxesCliOptions>(), undefined);
    log.success("CLI error reporting is disabled.");
  });

  telemetryCommand.action(() => telemetryCommand.outputHelp());

  program.hook("preAction", async (_thisCommand, actionCommand) => {
    if (
      actionCommand === program ||
      actionCommand === telemetryCommand ||
      actionCommand.parent === telemetryCommand
    ) {
      return;
    }
    const context = await loadContext(actionCommand.optsWithGlobals<DevboxesCliOptions>());
    await initializeCliTelemetry({
      configPath: context.configPath,
      version: cliVersion,
      command: actionCommand.name(),
      telemetry: context.config.telemetry,
    });
  });
};
