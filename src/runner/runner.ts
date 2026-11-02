import { hostname } from "node:os";
import { join } from "node:path";

import { confirm, isCancel, select, text } from "@clack/prompts";
import { platformConfigHome } from "@firops/connections/local/config";
import { writeSecretFile } from "@firops/connections/local/secret-file";
import { type Command, InvalidArgumentError } from "commander";
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
    cpus?: number;
    memory?: number;
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
    cpus: options.cpus,
    memoryGiB: options.memory,
  });
  // listen waits for every Task start; only a download of the next executor may still run.
  process.exit(0);
};

/** A command-line value that must be a number above 0. */
const positiveNumber = (value: string) => {
  const number = Number(value);
  if (!(number > 0)) throw new InvalidArgumentError("Give a number above 0.");
  return number;
};

export const addRunnerCommands = (program: Command) => {
  const runner = program
    .command("runner")
    .description(
      "Run this computer as a Runner, a machine of your own that runs your Organization's work instead of devboxes' managed machines. Register it first with devboxes runner add, then start it with devboxes runner listen.",
    );
  const command = runner
    .command("listen")
    .description(
      "Start this computer working as a Runner. It runs in the foreground until you stop it. Each piece of work the Runner claims runs in its own Docker container, and listen keeps telling devboxes how each one is doing: running, finished with its result, or gone.\n\nlisten doesn't restart a container that failed. It keeps the failed container so you can inspect it, and prints the command that removes it. Stopping listen doesn't stop the work: the containers keep running, and listen picks them up again the next time it starts.\n\nContainers send their callbacks to the relay, a local endpoint that listen runs. The relay forwards them to devboxes signed with the Runner's key, so the key never enters a container. For the same reason, listen won't start if the key file or the state files belong to another user, or if anyone else can read or write them.\n\nRegister the computer with devboxes runner add before you start it.",
    )
    .option(
      "--token-file <path>",
      "The Runner's key file. By default it's devboxes/runner/token in the config folder, where devboxes runner add saved it. It must belong to you and be readable by nobody else (mode 0600; on Windows, its access-control list decides).",
    )
    .option(
      "--state-directory <path>",
      "The Runner's state directory, which holds the relay's signing key. By default it's devboxes/runner in the config folder. It must belong to you and be accessible to nobody else (mode 0700; on Windows, its access-control list decides).",
      runnerDirectory(),
    )
    .option(
      "--cpus <count>",
      "The most CPUs devboxes may use on this machine. By default, it uses all the CPUs Docker reports.",
      positiveNumber,
    )
    .option(
      "--memory <GiB>",
      "The most memory, in GiB, that devboxes may use on this machine. By default, it uses all the memory Docker reports.",
      positiveNumber,
    );
  command.action(async () => {
    const options = command.optsWithGlobals<{
      api?: string;
      config?: string;
      tokenFile?: string;
      stateDirectory: string;
      cpus?: number;
      memory?: number;
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
    .description(
      "Register this computer as a Runner for an Organization's work. It saves the Runner's key as devboxes/runner/token in the config folder, where devboxes runner listen will find it. Because it calls runners.add, you need to be an owner or admin of the Organization and to have signed in within the last 5 minutes.",
    )
    .option(
      "--organization <id>",
      "The Organization whose work the Runner will run. In a terminal, devboxes asks for it if you leave it out.",
    )
    .option(
      "--name <name>",
      "A name for the Runner. In a terminal, devboxes asks for it if you leave it out.",
    );
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
        "devboxes runs work on 64-bit x86 and Arm machines.",
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
        message: "Which Organization should run work on this Runner?",
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
