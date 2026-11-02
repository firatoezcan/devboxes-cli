#!/usr/bin/env bun

import { Command } from "commander";

import { cliVersion, defaultApiOrigin } from "./api";
import { addAuthenticationCommands } from "./auth";
import { CommandError } from "./commands";
import type { LogIn } from "./connection";
import { addAccountCommands } from "./devboxes";
import { addRunnerCommands } from "./runner/runner";

/** Runs `devboxes login` again under the same --config and --api, for a change that needs it. */
const logInAgain: LogIn = async ({ config, api }) => {
  process.stderr.write("This change needs a recent sign-in. Sign in again to continue.\n");
  await createDevboxesCommand().parseAsync(
    [
      ...Bun.argv.slice(0, 2),
      ...(config === undefined ? [] : ["--config", config]),
      ...(api === undefined ? [] : ["--api", api]),
      "login",
    ],
    { from: "node" },
  );
};

export const createDevboxesCommand = () => {
  const program = new Command()
    .name("devboxes")
    .description(
      "The devboxes command-line tool. Use it to sign in, to find your Organization's application commands and run them from a terminal, and to run a computer as a Runner.",
    )
    .version(cliVersion, "-V, --version", "Print the version number and exit.")
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
    .option(
      "--config <path>",
      "Use a different saved account file. The file holds the API origin and your sign-in credential, but no default Organization. By default it's devboxes/config.json in your platform's config folder: $XDG_CONFIG_HOME when that's set, ~/Library/Application Support on macOS, %APPDATA% on Windows, and ~/.config everywhere else.",
    )
    .option(
      "--api <url>",
      defaultApiOrigin
        ? "The API origin to talk to. It takes precedence over DEVBOXES_API_URL, which takes precedence over the saved account's origin, which in turn takes precedence over this release's default origin. A saved credential belongs to a single origin, so pointing the same file at another origin is refused with API_ORIGIN_MISMATCH; use a separate --config file for each origin."
        : "API origin, also read from DEVBOXES_API_URL; required without a saved account",
    )
    .option("--json", "Write results and errors as machine-readable JSON.");

  addRunnerCommands(program);
  addAccountCommands(program, logInAgain);
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
    const failure = CommandError.from(error);
    console.error(
      program.opts<{ json?: boolean }>().json ? JSON.stringify(failure.toJSON()) : String(failure),
    );
    process.exit(1);
  }
}
