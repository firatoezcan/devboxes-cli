import type { Command } from "commander";

import { describeCommands, invokeCommand, readCommandInput } from "./commands";
import { loadCommandConnection } from "./connection";
import { runDevboxesMcpServer } from "./mcp";

export const addAccountCommands = (program: Command) => {
  const commands = program
    .command("commands")
    .description("list every advertised application command");
  commands.action(async () => {
    const options = commands.optsWithGlobals<{ api?: string; config?: string; json?: boolean }>();
    const connection = await loadCommandConnection(options);
    const description = await describeCommands(connection);
    if (options.json) {
      await Bun.write(Bun.stdout, `${JSON.stringify(description)}\n`);
    } else {
      for (const operation of description.commands) {
        await Bun.write(
          Bun.stdout,
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
    await Bun.write(
      Bun.stdout,
      `${JSON.stringify(
        await describeCommands(connection, operationId),
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
    await Bun.write(Bun.stdout, `${JSON.stringify(result, null, options.json ? undefined : 2)}\n`);
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
