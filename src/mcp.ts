import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  cliVersion,
  dispatchDevboxesTask,
  readDevboxesSession,
  readDevboxesSessionResult,
  sessionReachedTerminalState,
  type DevboxesContext,
} from "./devboxes";

const jsonResult = (value: z.infer<ReturnType<typeof z.json>>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

// A thin stdio wrapper over the exact same API calls the CLI commands make.
// The context (API base URL, session token, organization) comes from the
// stored `devboxes login` credentials; stdout stays reserved for the MCP
// protocol, so nothing here logs.
export const createDevboxesMcpServer = (context: DevboxesContext) => {
  const server = new McpServer({ name: "devboxes", version: cliVersion });

  server.registerTool(
    "dispatch_task",
    {
      description:
        "Dispatch a task to Devboxes as a new run. The task is free-form text, a GitHub issue URL, or owner/repo#123. Returns the agentSessionId used by get_session_status and get_session_result.",
      inputSchema: {
        task: z.string().describe("Task text, a GitHub issue URL, or owner/repo#123"),
        repo: z
          .string()
          .optional()
          .describe(
            "Repository full name (owner/name) selecting the target project. When omitted, the project is inferred from the git origin remote of the MCP server's working directory if it matches exactly one connected repository; without a match, an organization with a single project falls back to it. The result reports the choice as projectSelection and inferredFromGitRemote.",
          ),
        project: z.string().optional().describe("Project id (overrides repo)"),
        model: z.string().optional().describe("Model id (uses the server default when omitted)"),
        branch: z.string().optional().describe("Base branch and PR destination (default main)"),
        title: z.string().optional().describe("Run title"),
        blueprintVersionId: z
          .string()
          .optional()
          .describe(
            "Exact Blueprint Version id (defaults to the current Implement GitHub Issue version)",
          ),
      },
    },
    async (input) => jsonResult(await dispatchDevboxesTask(context, input)),
  );

  server.registerTool(
    "get_session_status",
    {
      description:
        "Read the current status of a dispatched Devboxes session. Poll this until `terminal` is true, then call get_session_result.",
      inputSchema: {
        agentSessionId: z.string().describe("Agent session id returned by dispatch_task"),
      },
    },
    async (input) => {
      const current = await readDevboxesSession(context, input.agentSessionId);
      return jsonResult({
        agentSessionId: current.session.id,
        sessionStatus: current.currentTask.status,
        runId: current.run.id,
        runStatus: current.run.status,
        currentStep: current.run.currentStep,
        terminal: sessionReachedTerminalState(current),
        outcome: current.run.outcome,
        errorMessage: current.run.errorMessage ?? current.currentTask.errorMessage ?? null,
        usage: current.run.usage,
      });
    },
  );

  server.registerTool(
    "get_session_result",
    {
      description:
        "Read the structured outcome of a Devboxes Session. Meaningful once get_session_status reports terminal: true.",
      inputSchema: {
        agentSessionId: z.string().describe("Agent session id returned by dispatch_task"),
      },
    },
    async (input) => {
      const result = await readDevboxesSessionResult(context, input.agentSessionId);
      return jsonResult({
        agentSessionId: result.session.id,
        sessionStatus: result.currentTask.status,
        runStatus: result.run.status,
        terminal: result.terminal,
        outcome: result.run.outcome,
        errorMessage: result.run.errorMessage ?? result.currentTask.errorMessage ?? null,
        usage: result.run.usage,
      });
    },
  );

  return server;
};

export const runDevboxesMcpServer = async (context: DevboxesContext) => {
  const server = createDevboxesMcpServer(context);
  await server.connect(new StdioServerTransport());
  // Serve until the parent closes the session or stdin. The SDK transport
  // only ever reads data, so a vanished client's stdin EOF must end the
  // process here instead of leaving an orphaned server behind.
  await new Promise<void>((resolve) => {
    server.server.onclose = resolve;
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
  await server.close();
};
