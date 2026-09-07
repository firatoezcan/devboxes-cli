import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  cliVersion,
  continueDevboxesSession,
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
        "Start a Devboxes run from task instructions or a GitHub issue reference. Returns agentSessionId for subsequent status, result, and continuation calls. Choose a blueprint suited to the task; the default is Implement GitHub Issue.",
      inputSchema: {
        task: z.string().describe("Task instructions, a GitHub issue URL, or owner/repo#123"),
        repo: z
          .string()
          .optional()
          .describe(
            "Repository in owner/name format. When omitted, Devboxes uses the MCP working directory's Git origin if it matches one project, or the organization's only project if there is no match. Check projectSelection and inferredFromGitRemote in the result to confirm the choice.",
          ),
        project: z.string().optional().describe("Project ID; overrides repo"),
        model: z
          .string()
          .optional()
          .describe("Provider/model ID; uses the server default when omitted"),
        branch: z
          .string()
          .optional()
          .describe("Starting branch and pull request destination; defaults to main"),
        title: z.string().optional().describe("Run title"),
        blueprintVersionId: z
          .string()
          .optional()
          .describe(
            "Exact blueprint version ID; defaults to the current Implement GitHub Issue version",
          ),
      },
    },
    async (input) => jsonResult(await dispatchDevboxesTask(context, input)),
  );

  server.registerTool(
    "continue_session",
    {
      description:
        "Start another run in an existing session. Preserves the session ID and returns the new run ID and current session status.",
      inputSchema: {
        agentSessionId: z.uuid().describe("Session ID returned by dispatch_task"),
        task: z
          .string()
          .refine((value) => value.trim().length > 0, "Task text is required")
          .describe("Instructions for the next run"),
      },
    },
    async (input) => jsonResult(await continueDevboxesSession(context, input)),
  );

  server.registerTool(
    "get_session_status",
    {
      description:
        "Read the current run status for a session. Poll until terminal is true, then read the result. Terminal includes succeeded, failed, and cancelled; inspect runStatus rather than treating terminal as success.",
      inputSchema: {
        agentSessionId: z.string().describe("Session ID returned by dispatch_task"),
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
        "Read the current run outcome, including its summary, published results, and publication failures. Check terminal and runStatus; unfinished work or terminal failure must not be reported as success.",
      inputSchema: {
        agentSessionId: z.string().describe("Session ID returned by dispatch_task"),
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
