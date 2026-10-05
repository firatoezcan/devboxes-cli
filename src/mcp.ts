import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { cliVersion } from "./api";
import { CommandError, describeCommands, invokeCommand, type CommandConnection } from "./commands";

const toolResult = async (
  operation: () => Promise<NonNullable<CallToolResult["structuredContent"]>>,
): Promise<CallToolResult> => {
  try {
    const result = await operation();
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  } catch (error) {
    const result = CommandError.from(error).toJSON();
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  }
};

export const runDevboxesMcpServer = async (connection: CommandConnection) => {
  const server = new McpServer({ name: "devboxes", version: cliVersion });
  server.registerTool(
    "devboxes_describe",
    {
      description:
        "List Devboxes command IDs, effects, and summaries when command is omitted. Pass an exact command ID to read its OpenAPI input, response, and authority contract before using devboxes_invoke. Discovery does not grant authority.",
      inputSchema: { command: z.string().min(1).optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ command }) =>
      toolResult(async () => {
        const description = await describeCommands(connection, command);
        if (command !== undefined) return description;
        return {
          commands: description.commands.map((operation) => ({
            operationId: operation.operationId,
            effect: operation["x-devboxes"].effect,
            summary: operation.summary,
          })),
        };
      }),
  );
  server.registerTool(
    "devboxes_invoke",
    {
      description:
        "Invoke an advertised Devboxes command. Supply JSON input directly, never a local file reference. HTTP acceptance is not evidence that asynchronous work completed.",
      inputSchema: {
        command: z.string().min(1),
        input: z.json(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (invocation) => toolResult(() => invokeCommand(connection, invocation)),
  );

  const { promise: closed, resolve: finish } = Promise.withResolvers<void>();
  server.server.onclose = finish;
  process.stdin.once("end", finish);
  process.stdin.once("close", finish);
  try {
    await server.connect(new StdioServerTransport());
    await closed;
  } finally {
    process.stdin.off("end", finish);
    process.stdin.off("close", finish);
    await server.close();
  }
};
