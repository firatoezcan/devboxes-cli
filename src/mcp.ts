import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import { cliVersion } from "./api";
import { devboxesCommandTools, type CommandConnection } from "./commands";

const mcpResult = ({
  isError,
  result,
}: {
  isError: boolean;
  result: NonNullable<CallToolResult["structuredContent"]>;
}): CallToolResult => ({
  ...(isError && { isError }),
  content: [{ type: "text", text: JSON.stringify(result) }],
  structuredContent: result,
});

/**
 * Serves the devboxes command tools over stdio. Each request loads its connection with `connect`, so
 * a `devboxes login` in another terminal reaches the next call.
 */
export const runDevboxesMcpServer = async (connect: () => Promise<CommandConnection>) => {
  const { describe, invoke } = devboxesCommandTools(await connect());
  const server = new Server(
    { name: "devboxes", version: cliVersion },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: describe.name,
        description: describe.description,
        inputSchema: describe.input,
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      {
        name: invoke.name,
        description: invoke.description,
        inputSchema: invoke.input,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const tools = devboxesCommandTools(await connect());
    if (params.name === describe.name) return mcpResult(await tools.describe.run(params.arguments));
    if (params.name === invoke.name) return mcpResult(await tools.invoke.run(params.arguments));
    throw new McpError(ErrorCode.InvalidParams, `Tool ${params.name} not found`);
  });

  const { promise: closed, resolve: finish } = Promise.withResolvers<void>();
  server.onclose = finish;
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
