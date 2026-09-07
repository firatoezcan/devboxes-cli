#!/usr/bin/env bun

import { Command, Option } from "commander";

import { addAccountCommands, cliVersion } from "./devboxes";
import { addRunnerCommands } from "./runner/runner";
import { addTelemetryCommands, captureCliTelemetryError } from "./telemetry";

export const createDevboxesCommand = () => {
  const program = new Command()
    .name("devboxes")
    .description("Sign in, run local agents, and dispatch Devboxes tasks")
    .version(cliVersion)
    .showHelpAfterError()
    .option("--config <path>", "Devboxes config file")
    .addOption(new Option("--api <url>", "Devboxes API base URL").hideHelp())
    .addOption(new Option("--auth <url>", "Devboxes auth base URL").hideHelp())
    .option("--organization <id>", "Devboxes organization id");

  addAccountCommands(program);
  addRunnerCommands(program);
  addTelemetryCommands(program);
  program.action(() => program.outputHelp());
  return program;
};

if (import.meta.main) {
  // Bun's util.styleText applies colors unconditionally, where Node validates
  // the target stream — so piped output would carry raw ANSI codes. Strip them
  // only at the process boundary. FORCE_COLOR opts back in for callers that
  // want colored captures; Buffer writes remain untouched.
  const forceColor = process.env.FORCE_COLOR;
  for (const stream of [process.stdout, process.stderr]) {
    if (stream.isTTY || (forceColor && forceColor !== "0" && forceColor !== "false")) continue;
    const write = stream.write.bind(stream);
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
      write(
        chunk instanceof Uint8Array ? chunk : Bun.stripANSI(chunk),
        ...(rest as []),
      )) as typeof stream.write;
  }

  try {
    await createDevboxesCommand().parseAsync(Bun.argv, { from: "node" });
  } catch (error) {
    await captureCliTelemetryError(error);
    // User-facing failures end as one readable line, not a stack trace.
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(process.exitCode && process.exitCode !== 0 ? Number(process.exitCode) : 1);
  }
}
