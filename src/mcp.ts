import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  cliVersion,
  dispatchDevboxesTask,
  readDevboxesSession,
  readDevboxesSessionResult,
  sessionReachedTerminalState,
  type DevboxesCliContext,
} from "./devboxes";

const jsonResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

// A thin stdio wrapper over the exact same API calls the CLI commands make.
// The context (API base URL, session token, organization) comes from the
// stored `devboxes connect` credentials; stdout stays reserved for the MCP
// protocol, so nothing here logs.
export const createDevboxesMcpServer = (context: DevboxesCliContext) => {
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
          .describe("Repository full name (owner/name) selecting the target project"),
        project: z.string().optional().describe("Project id (overrides repo)"),
        model: z.string().optional().describe("Opencode model as provider/model"),
        branch: z.string().optional().describe("Base branch and PR destination (default main)"),
        title: z.string().optional().describe("Run title"),
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
        sessionStatus: current.session.status,
        runId: current.session.runId,
        runStatus: current.run?.status ?? null,
        currentStep: current.run?.currentStep ?? null,
        terminal: sessionReachedTerminalState(current),
        pullRequestUrl: current.run?.pullRequestUrl ?? null,
        errorMessage: current.run?.errorMessage ?? current.session.errorMessage ?? null,
      });
    },
  );

  server.registerTool(
    "get_session_result",
    {
      description:
        "Read the outcome of a Devboxes session: final assistant output, pull request URL, and error message. Meaningful once get_session_status reports terminal: true.",
      inputSchema: {
        agentSessionId: z.string().describe("Agent session id returned by dispatch_task"),
      },
    },
    async (input) => {
      const result = await readDevboxesSessionResult(context, input.agentSessionId);
      return jsonResult({
        agentSessionId: result.session.id,
        sessionStatus: result.session.status,
        runStatus: result.run?.status ?? null,
        terminal: result.terminal,
        pullRequestUrl: result.run?.pullRequestUrl ?? null,
        errorMessage: result.run?.errorMessage ?? result.session.errorMessage ?? null,
        costUsd: result.run?.costUsd ?? null,
        finalOutput: result.finalOutput,
        finalOutputError: result.finalOutputError,
      });
    },
  );

  return server;
};

export const runDevboxesMcpServer = async (context: DevboxesCliContext) => {
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
