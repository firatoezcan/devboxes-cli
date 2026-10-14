import { isCancel, password, select } from "@clack/prompts";
import type { Command } from "commander";
import Type from "typebox";
import Value from "typebox/value";

import {
  CommandError,
  describeCommand,
  describeCommands,
  invokeCommand,
  openInBrowser,
  parseResponse,
  readCommandInput,
  writeOutput,
} from "./commands";
import { loadCommandConnection } from "./connection";
import { runDevboxesMcpServer } from "./mcp";

const connectStartSchema = Type.Object({
  attemptId: Type.String(),
  userCode: Type.Union([Type.String(), Type.Null()]),
  verificationUrl: Type.String(),
  intervalSeconds: Type.Number(),
});
const providersSchema = Type.Array(
  Type.Object({
    id: Type.String(),
    name: Type.String(),
    deviceFlow: Type.Boolean(),
    apiKey: Type.Boolean(),
    unavailable: Type.Union([Type.String(), Type.Null()]),
  }),
);
const accountSchema = Type.Object({ id: Type.String() });
const connectCompleteSchema = Type.Union([
  Type.Object({ status: Type.Literal("pending"), intervalSeconds: Type.Number() }),
  Type.Object({ status: Type.Literal("failed") }),
  Type.Object({ status: Type.Literal("completed"), accountId: Type.String() }),
]);

export const addAccountCommands = (program: Command) => {
  const commands = program
    .command("commands")
    .description("list every advertised application command");
  commands.action(async () => {
    const options = commands.optsWithGlobals<{ api?: string; config?: string; json?: boolean }>();
    const connection = await loadCommandConnection(options);
    const description = await describeCommands(connection);
    if (options.json) {
      await writeOutput(`${JSON.stringify(description)}\n`);
    } else {
      for (const operation of description.commands) {
        await writeOutput(
          `${[
            operation.operationId,
            operation["x-devboxes"].effect,
            ...(operation.summary ? [operation.summary] : []),
          ].join("\t")}\n`,
        );
      }
    }
  });

  const describe = program
    .command("describe")
    .description("show a command's input, response, and authority contract")
    .argument("<operationId>", "Discovered operation ID");
  describe.action(async (operationId: string) => {
    const options = describe.optsWithGlobals<{ api?: string; config?: string; json?: boolean }>();
    const connection = await loadCommandConnection(options);
    await writeOutput(
      `${JSON.stringify(
        describeCommand(await describeCommands(connection), operationId),
        null,
        options.json ? undefined : 2,
      )}\n`,
    );
  });

  const invoke = program
    .command("invoke")
    .description("invoke a discovered command with JSON input")
    .argument("<operationId>", "Discovered operation ID")
    .requiredOption(
      "--input <source>",
      "Read JSON from @file or - for stdin; input is never shell-evaluated",
    );
  invoke.action(async (operationId: string) => {
    const options = invoke.optsWithGlobals<{
      api?: string;
      config?: string;
      json?: boolean;
      input: string;
    }>();
    const connection = await loadCommandConnection(options);
    const input = await readCommandInput(options.input);
    const result = await invokeCommand(connection, {
      command: operationId,
      input,
    });
    await writeOutput(`${JSON.stringify(result, null, options.json ? undefined : 2)}\n`);
    if (!options.json && Value.Check(Type.Object({ warning: Type.String() }), result.data))
      process.stderr.write(`Warning: ${result.data.warning}\n`);
  });

  const connect = program
    .command("connect")
    .description("connect a Provider Account by signing in with the provider or with an API key")
    .argument("[providerId]", "Provider ID from providers.list; without it, choose one")
    .requiredOption("--organization <id>", "Organization that gets the Provider Account")
    .requiredOption("--label <label>", "Name of the Provider Account")
    .option("--account <id>", "Provider Account whose credential the connection replaces")
    .option("--api-key", "connect an API key instead of signing in");
  connect.action(async (providerId?: string) => {
    const options = connect.optsWithGlobals<{
      api?: string;
      config?: string;
      json?: boolean;
      organization: string;
      label: string;
      account?: string;
      apiKey?: boolean;
    }>();
    const connection = await loadCommandConnection(options);
    const organizationId = options.organization;
    const interactive = !options.json && process.stdin.isTTY && process.stderr.isTTY;
    const providers = parseResponse(
      providersSchema,
      (await invokeCommand(connection, { command: "providers.list", input: { organizationId } }))
        .data,
      "providers.list",
    );
    const choose = async () => {
      if (providerId !== undefined) {
        const provider = providers.find((entry) => entry.id === providerId);
        if (!provider)
          throw new CommandError(
            "PROVIDER_NOT_FOUND",
            `providers.list has no provider ${providerId}.`,
          );
        if (options.apiKey && !provider.apiKey)
          throw new CommandError(
            "API_KEY_UNSUPPORTED",
            `${provider.name} takes no API key: run devboxes connect ${provider.id} to sign in.`,
          );
        return { provider, signIn: provider.deviceFlow && !options.apiKey };
      }
      if (!interactive)
        throw new CommandError(
          "PROVIDER_REQUIRED",
          "Name the provider to connect: devboxes connect <providerId>.",
        );
      const selected = await select({
        message: "Connect",
        options: providers.flatMap((provider) =>
          [
            ...(provider.deviceFlow
              ? [{ signIn: true, label: `${provider.name} (browser sign-in)` }]
              : []),
            ...(provider.apiKey ? [{ signIn: false, label: `${provider.name} API key` }] : []),
          ].map(({ signIn, label }) => ({
            value: { provider, signIn },
            label,
            disabled: provider.unavailable !== null,
            hint: provider.unavailable ?? undefined,
          })),
        ),
        output: process.stderr,
      });
      if (isCancel(selected)) throw new CommandError("CANCELLED", "Connection cancelled.");
      return selected;
    };
    const { provider, signIn } = await choose();
    if (provider.unavailable !== null)
      throw new CommandError("PROVIDER_UNAVAILABLE", provider.unavailable);
    const pasted = async (message: string) => {
      if (!interactive && process.stdin.isTTY)
        throw new CommandError(
          "INPUT_REQUIRED",
          "Pipe the key or code to stdin, or run without --json and with stderr on the terminal for a masked prompt.",
        );
      const value = interactive
        ? await password({ message, output: process.stderr })
        : (await Bun.stdin.text()).trim();
      if (isCancel(value)) throw new CommandError("CANCELLED", "Connection cancelled.");
      return value;
    };
    let accountId: string;
    if (signIn) {
      const started = parseResponse(
        connectStartSchema,
        (
          await invokeCommand(connection, {
            command: "providers.connect-start",
            input: {
              organizationId,
              providerId: provider.id,
              label: options.label,
              ...(options.account && { accountId: options.account }),
            },
          })
        ).data,
        "providers.connect-start",
      );
      process.stderr.write(
        `Open ${started.verificationUrl} to sign in.${started.userCode === null ? "" : ` Confirm that the page shows code ${started.userCode}.`}\n`,
      );
      if (interactive) openInBrowser(started.verificationUrl);
      const complete = async (code?: string) =>
        parseResponse(
          connectCompleteSchema,
          (
            await invokeCommand(connection, {
              command: "providers.connect-complete",
              input: { organizationId, attemptId: started.attemptId, ...(code && { code }) },
            })
          ).data,
          "providers.connect-complete",
        );
      let result: Awaited<ReturnType<typeof complete>>;
      if (started.userCode === null) {
        result = await complete(await pasted("Paste the code the sign-in page shows"));
      } else {
        let intervalSeconds = started.intervalSeconds;
        do {
          await Bun.sleep(intervalSeconds * 1000);
          result = await complete();
          if (result.status === "pending") intervalSeconds = result.intervalSeconds;
        } while (result.status === "pending");
      }
      if (result.status !== "completed")
        throw new CommandError(
          "CONNECTION_FAILED",
          "The provider refused the sign-in. Connect again.",
        );
      accountId = result.accountId;
    } else {
      const auth = { type: "api", key: await pasted(`Paste the ${provider.name} API key`) };
      accountId = parseResponse(
        accountSchema,
        (
          await invokeCommand(
            connection,
            options.account
              ? {
                  command: "connections.update",
                  input: { organizationId, accountId: options.account, label: options.label, auth },
                }
              : {
                  command: "connections.add",
                  input: { organizationId, providerId: provider.id, label: options.label, auth },
                },
          )
        ).data,
        options.account ? "connections.update" : "connections.add",
      ).id;
    }
    await writeOutput(
      options.json
        ? `${JSON.stringify({ status: "completed", accountId })}\n`
        : `Connected ${options.label} as Provider Account ${accountId}.\n`,
    );
  });

  const mcp = program
    .command("mcp")
    .description("serve Devboxes describe and invoke tools over stdio");
  mcp.action(async () => {
    const connection = await loadCommandConnection(
      mcp.optsWithGlobals<{ api?: string; config?: string }>(),
    );
    await runDevboxesMcpServer(connection);
  });
};
