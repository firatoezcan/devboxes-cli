import { isCancel, password, select, text } from "@clack/prompts";
import type { JsonValue } from "./protocol/json";
import type { Command } from "commander";
import Type from "typebox";
import Value from "typebox/value";

import {
  asksInTerminal,
  CommandError,
  describeCommand,
  describeCommands,
  invokeCommand,
  httpUrl,
  openInBrowser,
  parseResponse,
  readCommandInput,
  writeOutput,
} from "./commands";
import { loadCommandConnection, type LogIn } from "./connection";
import { runDevboxesMcpServer } from "./mcp";
import { promptCommandInput, promptField } from "./prompt-input";

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

export const addAccountCommands = (program: Command, logIn: LogIn) => {
  const commands = program
    .command("commands")
    .description("list every advertised application command");
  commands.action(async () => {
    const options = commands.optsWithGlobals<{ api?: string; config?: string; json?: boolean }>();
    const connection = await loadCommandConnection(options, logIn);
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
    const connection = await loadCommandConnection(options, logIn);
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
    .description(
      "invoke a discovered command. In a terminal without --input, it asks for the input field by field, and then for the Blueprint inputs and the issue that the Session needs.",
    )
    .argument("<operationId>", "Discovered operation ID")
    .option(
      "--input <source>",
      "Read JSON from @file or - for stdin; input is never shell-evaluated",
    );
  invoke.action(async (operationId: string) => {
    const options = invoke.optsWithGlobals<{
      api?: string;
      config?: string;
      json?: boolean;
      input?: string;
    }>();
    const connection = await loadCommandConnection(options, logIn);
    let result: Awaited<ReturnType<typeof invokeCommand>>;
    if (options.input !== undefined) {
      result = await invokeCommand(connection, {
        command: operationId,
        input: await readCommandInput(options.input),
      });
    } else if (asksInTerminal(options.json)) {
      const description = await describeCommands(connection);
      const context = { connection, description };
      const input = await promptCommandInput(context, operationId);
      result = await invokeCommand(
        {
          ...connection,
          askInputs: async (unresolved) => {
            const values: Record<string, JsonValue> = {};
            for (const { name, source, type, description: about } of unresolved)
              values[name] = await promptField(
                context,
                source === "issue" ? "issue" : `inputs.${name}`,
                { type, description: about },
                {},
              );
            return values;
          },
        },
        { command: operationId, input },
        async () => description,
      );
    } else {
      throw new CommandError(
        "INPUT_REQUIRED",
        "Pass the input with --input @file or --input -, or run the command in a terminal to be asked for it.",
      );
    }
    await writeOutput(`${JSON.stringify(result, null, options.json ? undefined : 2)}\n`);
    if (!options.json && Value.Check(Type.Object({ warning: Type.String() }), result.data))
      process.stderr.write(`Warning: ${result.data.warning}\n`);
  });

  const connect = program
    .command("connect")
    .description("connect a model account by signing in with the provider or with an API key")
    .argument(
      "[providerId]",
      "The provider ID from model-accounts.providers. In a terminal, devboxes asks for it.",
    )
    .option(
      "--organization <id>",
      "The Organization that gets the model account. In a terminal, devboxes asks for it.",
    )
    .option("--label <label>", "The model account's name. In a terminal, devboxes asks for it.")
    .option("--account <id>", "The model account whose credential the sign-in or key replaces")
    .option("--api-key", "connect an API key instead of signing in");
  connect.action(async (providerId?: string) => {
    const options = connect.optsWithGlobals<{
      api?: string;
      config?: string;
      json?: boolean;
      organization?: string;
      label?: string;
      account?: string;
      apiKey?: boolean;
    }>();
    const connection = await loadCommandConnection(options, logIn);
    const interactive = asksInTerminal(options.json);
    if (!interactive && options.organization === undefined)
      throw new CommandError(
        "ORGANIZATION_REQUIRED",
        "Name the Organization with --organization <id>, or run the command in a terminal to choose one.",
      );
    if (!interactive && options.label === undefined)
      throw new CommandError(
        "LABEL_REQUIRED",
        "Name the model account with --label <label>, or run the command in a terminal to enter one.",
      );
    const organizationId =
      options.organization ??
      parseResponse(
        Type.String(),
        await promptField(
          { connection, description: await describeCommands(connection) },
          "organizationId",
          { type: "string", description: "The Organization that gets the model account." },
          {},
        ),
        "organizations.list",
      );
    const providers = parseResponse(
      providersSchema,
      (
        await invokeCommand(connection, {
          command: "model-accounts.providers",
          input: { organizationId },
        })
      ).data,
      "model-accounts.providers",
    );
    const choose = async () => {
      if (providerId !== undefined) {
        const provider = providers.find((entry) => entry.id === providerId);
        if (!provider)
          throw new CommandError(
            "PROVIDER_NOT_FOUND",
            `model-accounts.providers has no provider ${providerId}.`,
          );
        if (!provider.deviceFlow && !provider.apiKey)
          throw new CommandError(
            "PROVIDER_NOT_CONNECTABLE",
            `${provider.name} takes neither a sign-in nor an API key.`,
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
      if (isCancel(selected)) throw new CommandError("CANCELLED", "Command cancelled.");
      return selected;
    };
    const { provider, signIn } = await choose();
    if (provider.unavailable !== null)
      throw new CommandError("PROVIDER_UNAVAILABLE", provider.unavailable);
    const named =
      options.label ??
      (await text({
        message: "Name of the model account",
        initialValue: provider.name,
        validate: (value) => (value?.trim() ? undefined : "Enter a name."),
        output: process.stderr,
      }));
    if (isCancel(named)) throw new CommandError("CANCELLED", "Command cancelled.");
    const label = named.trim();
    const pasted = async (message: string) => {
      if (!interactive && process.stdin.isTTY)
        throw new CommandError(
          "INPUT_REQUIRED",
          "Pipe the key or code to stdin, or run the command in a terminal with no --json to get a masked prompt.",
        );
      const value = interactive
        ? await password({ message, output: process.stderr })
        : (await Bun.stdin.text()).trim();
      if (isCancel(value)) throw new CommandError("CANCELLED", "Command cancelled.");
      return value;
    };
    let accountId: string;
    if (signIn) {
      const started = parseResponse(
        connectStartSchema,
        (
          await invokeCommand(connection, {
            command: "model-accounts.connect-start",
            input: {
              organizationId,
              providerId: provider.id,
              label,
              ...(options.account && { accountId: options.account }),
            },
          })
        ).data,
        "model-accounts.connect-start",
      );
      const verificationUrl = httpUrl(started.verificationUrl);
      if (!verificationUrl)
        throw new CommandError(
          "INVALID_RESPONSE",
          "The model-accounts.connect-start response is invalid: /verificationUrl must be an HTTP URL.",
        );
      process.stderr.write(
        `Open ${verificationUrl.href} to sign in.${started.userCode === null ? "" : ` Confirm that the page shows code ${started.userCode}.`}\n`,
      );
      if (interactive) openInBrowser(verificationUrl);
      const complete = async (code?: string) =>
        parseResponse(
          connectCompleteSchema,
          (
            await invokeCommand(connection, {
              command: "model-accounts.connect-complete",
              input: { organizationId, attemptId: started.attemptId, ...(code && { code }) },
            })
          ).data,
          "model-accounts.connect-complete",
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
          "MODEL_ACCOUNT_SIGN_IN_FAILED",
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
                  command: "model-accounts.update",
                  input: { organizationId, accountId: options.account, label, auth },
                }
              : {
                  command: "model-accounts.add",
                  input: { organizationId, providerId: provider.id, label, auth },
                },
          )
        ).data,
        options.account ? "model-accounts.update" : "model-accounts.add",
      ).id;
    }
    await writeOutput(
      options.json
        ? `${JSON.stringify({ status: "completed", accountId })}\n`
        : `Connected ${label} as model account ${accountId}.\n`,
    );
  });

  const mcp = program
    .command("mcp")
    .description("serve devboxes tools to a coding agent over stdio");
  mcp.action(async () => {
    const options = mcp.optsWithGlobals<{ api?: string; config?: string }>();
    await runDevboxesMcpServer(() => loadCommandConnection({ ...options, json: true }));
  });
};
