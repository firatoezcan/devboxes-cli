import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { cliVersion, type DevboxesContext } from "./devboxes";

const connectedMcpEndpoint = (context: DevboxesContext) => {
  const { apiBaseUrl, organizationId, sessionToken } = context.config;
  if (!organizationId || !sessionToken) {
    throw new Error("This command requires a signed-in account. Run `devboxes login` first.");
  }
  return {
    endpoint: new URL(`${apiBaseUrl}/org/${encodeURIComponent(organizationId)}/mcp`),
    sessionToken,
  };
};

export const runDevboxesMcpServer = async (
  context: DevboxesContext,
  options: { projectId?: string } = {},
) => {
  let remote: Client | undefined;
  const connectedRemote = async () => {
    if (remote) return remote;
    const { endpoint, sessionToken } = connectedMcpEndpoint(context);
    const headers = new Headers({
      Authorization: `Bearer ${sessionToken}`,
      "User-Agent": `devboxes/${cliVersion}`,
    });
    if (options.projectId) headers.set("X-Devboxes-Project-Id", options.projectId);
    remote = new Client({ name: "devboxes-cli", version: cliVersion });
    await remote.connect(
      new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers },
      }),
    );
    return remote;
  };

  const local = new Server(
    { name: "devboxes", version: cliVersion },
    { capabilities: { tools: {} } },
  );
  local.setRequestHandler(ListToolsRequestSchema, async () =>
    (await connectedRemote()).listTools(),
  );
  local.setRequestHandler(CallToolRequestSchema, async ({ params }) =>
    (await connectedRemote()).callTool(params),
  );

  local.onclose = () => {
    void remote?.close();
  };
  await local.connect(new StdioServerTransport());
  await new Promise<void>((resolve) => {
    const closeRemote = local.onclose;
    local.onclose = () => {
      closeRemote?.();
      resolve();
    };
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
  await local.close();
};
