import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

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

export const runDevboxesMcpServer = async (connection: CommandConnection) => {
  const { describe, invoke } = devboxesCommandTools(connection);
  const server = new McpServer({ name: "devboxes", version: cliVersion });
  server.registerTool(
    describe.name,
    {
      description: describe.description,
      inputSchema: describe.input,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => mcpResult(await describe.run(input)),
  );
  server.registerTool(
    invoke.name,
    {
      description: invoke.description,
      inputSchema: invoke.input,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (input) => mcpResult(await invoke.run(input)),
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
