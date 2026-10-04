#!/usr/bin/env bun

import { Command } from "commander";

import { cliVersion } from "./api";
import { addAuthenticationCommands } from "./auth";
import { CommandError } from "./commands";
import { addAccountCommands } from "./devboxes";
import { addRunnerCommands } from "./runner/runner";

export const createDevboxesCommand = () => {
  const program = new Command()
    .name("devboxes")
    .description("Discover and invoke Devboxes application commands")
    .version(cliVersion)
    .showHelpAfterError()
    .configureOutput({
      writeErr: (text) => {
        if (!program.opts<{ json?: boolean }>().json) process.stderr.write(text);
      },
    })
    .exitOverride((error) => {
      if (error.exitCode !== 0 && program.opts<{ json?: boolean }>().json) {
        throw new CommandError("INVALID_USAGE", error.message.replace(/^error: /, ""));
      }
    })
    .option("--config <path>", "Path to the Devboxes configuration file")
    .option("--api <url>", "API origin; required for the first signup or login")
    .option("--json", "Write machine-readable results and errors");

  addRunnerCommands(program);
  addAccountCommands(program);
  addAuthenticationCommands(program);
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

  const program = createDevboxesCommand();
  try {
    await program.parseAsync(Bun.argv, { from: "node" });
  } catch (error) {
    const failure =
      error instanceof CommandError
        ? error
        : new CommandError("COMMAND_FAILED", "The command failed unexpectedly.");
    const qualifiers = [
      ...(failure.status === undefined ? [] : [`HTTP ${failure.status}`]),
      ...(failure.retryable ? ["retryable"] : []),
    ];
    console.error(
      program.opts<{ json?: boolean }>().json
        ? JSON.stringify(failure.toJSON())
        : `${failure.code}${qualifiers.length ? ` (${qualifiers.join(", ")})` : ""}: ${failure.message}`,
    );
    process.exit(1);
  }
}
