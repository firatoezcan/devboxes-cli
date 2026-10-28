import { hostname } from "node:os";
import { join } from "node:path";

import { confirm, isCancel, select, text } from "@clack/prompts";
import { platformConfigHome } from "@firops/connections/local/config";
import { writeSecretFile } from "@firops/connections/local/secret-file";
import { dockerSocketPath } from "@firops/devbox/runner/docker-socket";
import type { Command } from "commander";
import Type from "typebox";

import {
  apiOrigin,
  asksInTerminal,
  type CommandConnection,
  CommandError,
  describeCommand,
  describeCommands,
  invokeCommand,
  parseResponse,
  requestJson,
  writeOutput,
} from "../commands";
import { loadAccountContext, loadCommandConnection } from "../connection";
import { listen } from "./listen";

const runnerDirectory = () => join(platformConfigHome(), "devboxes", "runner");
const savedTokenFile = () => join(runnerDirectory(), "token");

const organizationsSchema = Type.Object({
  organizations: Type.Array(
    Type.Object({ id: Type.String(), name: Type.String(), role: Type.String() }),
  ),
});
const registeredSchema = Type.Object({
  runner: Type.Object({ id: Type.String(), name: Type.String() }),
  token: Type.String({ minLength: 1 }),
});

/** Whether the API still accepts the Runner key in `tokenFile`, asked the way the Runner asks. */
const keyWorks = async (connection: CommandConnection, tokenFile: string) => {
  const token = (await Bun.file(tokenFile).text()).trim();
  try {
    await requestJson(
      { origin: connection.origin, token },
      "/api/internal/execution/runners/assignments",
      {},
    );
    return true;
  } catch (error) {
    if (error instanceof CommandError && [401, 403].includes(error.options.status ?? 0))
      return false;
    throw error;
  }
};

/**
 * Runs the Runner. Bun uploads its crash reports on macOS and Windows unless DO_NOT_TRACK is set
 * when the process starts, so there the CLI starts again as `devboxes <args>` with it.
 */
const runRunner = async (
  args: string[],
  options: {
    api?: string;
    config?: string;
    tokenFile: string;
    stateDirectory: string;
    dockerSocket?: string;
  },
) => {
  if (
    (process.platform === "darwin" || process.platform === "win32") &&
    process.env.DO_NOT_TRACK === undefined
  ) {
    const argv = [
      process.execPath,
      ...process.execArgv,
      ...(Bun.isStandaloneExecutable ? [] : process.argv.slice(1, 2)),
      ...args,
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
  await listen({
    apiOrigin: options.api
      ? apiOrigin(options.api)
      : apiOrigin((await loadAccountContext(options)).config.apiBaseUrl),
    tokenFile: options.tokenFile,
    stateDirectory: options.stateDirectory,
    socketPath: options.dockerSocket ?? dockerSocketPath(),
  });
};

export const addRunnerCommands = (program: Command) => {
  const runner = program
    .command("runner")
    .description("run this computer as a Runner of your Organization");
  const command = runner
    .command("listen")
    .description("launch assigned Tasks and observe their Docker executors")
    .option(
      "--token-file <path>",
      "Runner key file from devboxes runner add, owner-only (0600; on Windows, its access-control list decides); defaults to the one it saved",
    )
    .option(
      "--state-directory <path>",
      "Runner state with the relay's signing key, owner-only (0700; on Windows, its access-control list decides)",
      runnerDirectory(),
    )
    .option("--docker-socket <path>", "Docker socket path");
  command.action(async () => {
    const options = command.optsWithGlobals<{
      api?: string;
      config?: string;
      tokenFile?: string;
      stateDirectory: string;
      dockerSocket?: string;
    }>();
    const tokenFile = options.tokenFile ?? savedTokenFile();
    if (options.tokenFile === undefined && !(await Bun.file(tokenFile).exists()))
      throw new CommandError(
        "RUNNER_NOT_ADDED",
        "This computer isn't a Runner yet. Run devboxes runner add first.",
      );
    await runRunner(process.argv.slice(2), { ...options, tokenFile });
  });

  const add = runner
    .command("add")
    .description("add this computer as a Runner that runs your Organization's tasks")
    .option(
      "--organization <id>",
      "The Organization whose tasks the Runner runs. In a terminal, devboxes asks for it.",
    )
    .option("--name <name>", "The Runner's name. In a terminal, devboxes asks for it.");
  add.action(async () => {
    const options = add.optsWithGlobals<{
      api?: string;
      config?: string;
      json?: boolean;
      organization?: string;
      name?: string;
    }>();
    const tokenFile = savedTokenFile();
    const platform =
      process.arch === "x64" ? "linux/amd64" : process.arch === "arm64" ? "linux/arm64" : null;
    if (!platform)
      throw new CommandError(
        "PLATFORM_UNSUPPORTED",
        "devboxes runs tasks on 64-bit x86 and Arm machines.",
      );
    const interactive = asksInTerminal(options.json);
    if (!interactive && options.organization === undefined)
      throw new CommandError(
        "ORGANIZATION_REQUIRED",
        "Name the Organization with --organization <id>, or run the command in a terminal to choose one.",
      );
    if (!interactive && options.name === undefined)
      throw new CommandError(
        "NAME_REQUIRED",
        "Name the Runner with --name <name>, or run the command in a terminal to enter one.",
      );
    const connection = await loadCommandConnection(options);
    if (await Bun.file(tokenFile).exists()) {
      if (await keyWorks(connection, tokenFile))
        throw new CommandError(
          "RUNNER_ALREADY_ADDED",
          `This computer is already a devboxes Runner. Its key is in ${tokenFile}. Run devboxes runner listen to start it.`,
        );
      process.stderr.write(
        `The key saved in ${tokenFile} no longer works, so devboxes is adding this Runner again.\n`,
      );
    }
    const description = await describeCommands(connection);
    const { organizations } = parseResponse(
      organizationsSchema,
      (
        await invokeCommand(
          connection,
          { command: "organizations.list", input: {} },
          async () => description,
        )
      ).data,
      "organizations.list",
    );
    const { roles } = describeCommand(description, "runners.add").commands[0]["x-devboxes"];
    const managed = organizations.filter((entry) => roles.includes(entry.role));
    if (options.organization === undefined && managed.length === 0)
      throw new CommandError(
        "ORGANIZATION_NOT_FOUND",
        `devboxes can't find an Organization where you can add a Runner. Only an Organization's ${roles.join(" or ")} can add one.`,
      );
    const chosen =
      options.organization ??
      (await select({
        message: "Which Organization should run tasks on this Runner?",
        options: managed.map((entry) => ({ value: entry.id, label: entry.name })),
        output: process.stderr,
      }));
    if (isCancel(chosen)) throw new CommandError("CANCELLED", "Command cancelled.");
    const organization = organizations.find((entry) => entry.id === chosen);
    if (!organization)
      throw new CommandError(
        "ORGANIZATION_NOT_FOUND",
        `devboxes can't find an Organization with the ID ${chosen} that you belong to.`,
      );
    const named =
      options.name ??
      (await text({
        message: "Name this Runner",
        initialValue: hostname(),
        validate: (value) => (value?.trim() ? undefined : "Enter a name."),
        output: process.stderr,
      }));
    if (isCancel(named)) throw new CommandError("CANCELLED", "Command cancelled.");
    const { runner: added, token } = parseResponse(
      registeredSchema,
      (
        await invokeCommand(
          connection,
          {
            command: "runners.add",
            input: { organizationId: organization.id, name: named.trim(), platform, cost: null },
          },
          async () => description,
        )
      ).data,
      "runners.add",
    );
    await writeSecretFile({ path: tokenFile, contents: `${token}\n`, tmpPrefix: "token." });
    if (options.json) {
      await writeOutput(`${JSON.stringify({ runner: added, tokenFile })}\n`);
      return;
    }
    await writeOutput(
      `Added ${added.name} to ${organization.name}. The Runner's key is saved in ${tokenFile}, and only your user account can read it.\n`,
    );
    const start =
      interactive && (await confirm({ message: "Start this Runner now?", output: process.stderr }));
    if (start !== true) {
      await writeOutput("Start it later with: devboxes runner listen\n");
      return;
    }
    await runRunner(["--api", connection.origin, "runner", "listen"], {
      api: connection.origin,
      tokenFile,
      stateDirectory: runnerDirectory(),
    });
  });
};
