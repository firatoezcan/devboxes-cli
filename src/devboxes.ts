import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { log, note, spinner } from "@clack/prompts";
import {
  loadContext,
  writeConfig,
  type DevboxesCliOptions,
  type DevboxesConfig,
  type DevboxesContext,
} from "@firops/connections/local/config";
import { resolveDispatchProject } from "@firops/devbox/workspace/dispatch-project";
import { createAuthClient } from "better-auth/client";
import { deviceAuthorizationClient } from "better-auth/client/plugins";
import { Command, InvalidArgumentError } from "commander";
import open from "open";
import Type from "typebox";
import Value from "typebox/value";

import { apiRequestError, bearerBackend } from "./api";

const AgentSessionIdSchema = Type.String({ format: "uuid" });

const cliCommandName = "devboxes";
// Must stay in the validateClient allowlist of the API's deviceAuthorization
// auth plugin. Public identifier, not a secret: it only names which client
// asked for the browser approval.
const cliDeviceClientId = "devboxes-cli";

// An abandoned browser approval must not hang the CLI forever.
const deviceFlowTimeoutMs = 5 * 60_000;

export const openBrowser = async (url: string) => {
  // BROWSER=none is the conventional opt-out for headless machines, CI, and
  // tests — and a piped run must never pop a browser mid-script. The URL is
  // already printed by every caller, so skipping loses nothing.
  if (process.env.BROWSER === "none" || !process.stdout.isTTY) return;
  try {
    await open(url);
  } catch {
    // The printed URL remains the fallback.
  }
};

export const deviceSessionToken = async (
  config: DevboxesConfig,
  options: { clientId: string; scope: string; purpose: string },
) => {
  const authClient = createAuthClient({
    baseURL: config.authBaseUrl,
    plugins: [deviceAuthorizationClient()],
  });
  const { data: device, error } = await authClient.device.code({
    client_id: options.clientId,
    scope: options.scope,
  });
  if (error || !device) {
    throw new Error(`Device authorization failed: ${JSON.stringify(error)}`);
  }
  // The code and URL print plainly so they stay copyable from any terminal.
  console.info(`Approve Devboxes ${options.purpose} with code ${device.user_code}.`);
  console.info(device.verification_uri_complete);
  await openBrowser(device.verification_uri_complete);

  // Spinner only on interactive terminals; scripted runs keep silent polling.
  // While a clack spinner runs it owns SIGINT — without onCancel the first
  // Ctrl-C would paint "Canceled" yet leave the poll loop running, and a
  // subsequent browser approval would still write credentials to disk.
  const approval = process.stdout.isTTY
    ? spinner({ onCancel: () => process.exit(130) })
    : undefined;
  approval?.start(`Waiting for browser approval (code ${device.user_code})`);
  try {
    let intervalMs = Math.max(device.interval ?? 5, 1) * 1_000;
    const deadline = Date.now() + deviceFlowTimeoutMs;
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(
          `Devboxes ${options.purpose} timed out after 5 minutes without browser approval.`,
        );
      }
      await sleep(intervalMs);
      const token = await authClient.device.token({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: options.clientId,
      });
      if (token.data?.access_token) {
        approval?.stop(`Devboxes ${options.purpose} approved.`);
        return token.data.access_token;
      }
      const errorCode = (token.error as { error?: string } | null)?.error;
      if (errorCode === "authorization_pending") continue;
      if (errorCode === "slow_down") {
        intervalMs += 5_000;
        continue;
      }
      throw new Error(`Device ${options.purpose} failed: ${JSON.stringify(token.error)}`);
    }
  } catch (error) {
    approval?.error(`Devboxes ${options.purpose} was not approved.`);
    throw error;
  }
};

const connectedBackend = (context: DevboxesContext) => {
  const { sessionToken, organizationId } = context.config;
  if (!sessionToken || !organizationId) {
    throw new Error(
      `This command requires a signed-in account. Run \`${cliCommandName} login\` first.`,
    );
  }
  return {
    backend: bearerBackend(context.config.apiBaseUrl, sessionToken),
    organizationId,
  };
};

export const loginDevboxes = async (context: DevboxesContext) => {
  const sessionToken = await deviceSessionToken(context.config, {
    clientId: cliDeviceClientId,
    scope: "cli",
    purpose: "CLI sign-in",
  });
  context.config.sessionToken = sessionToken;

  const backend = bearerBackend(context.config.apiBaseUrl, sessionToken);
  const me = await backend.api.me.get();
  if (me.error) throw apiRequestError("Account lookup", me.error);
  const organization = me.data?.organization;
  if (!me.data || !organization) {
    throw new Error(
      "This account has no active organization. Accept an invitation in the dashboard, then run `devboxes login` again.",
    );
  }
  // A registered runner config already binds its machine identity, key, and
  // encrypted credential store to one organization. The account session may
  // currently have another organization active; adding that session must not
  // retarget machine-scoped commands or credential sync.
  if (!(context.config.machineId && context.config.apiKey && context.config.organizationId)) {
    context.config.organizationId = organization.id;
  }
  await writeConfig(context);
  return { user: me.data.user, organization };
};

export type DispatchInput = {
  task: string;
  repo?: string;
  project?: string;
  model?: string;
  branch?: string;
  title?: string;
  blueprintVersionId?: string;
  // Directory whose git origin remote may infer the project when neither
  // --project, --repo, nor an issue reference selects one. Defaults to the
  // process working directory.
  cwd?: string;
};

export const dispatchDevboxesTask = async (context: DevboxesContext, input: DispatchInput) => {
  const { backend, organizationId } = connectedBackend(context);
  const task = input.task.trim();
  if (!task) throw new Error("Enter a task or a GitHub issue URL, or use owner/repo#123.");

  const projectsResponse = await backend.api.org({ organizationId }).projects.get();
  if (projectsResponse.error) throw apiRequestError("Project list", projectsResponse.error);
  const projects = projectsResponse.data ?? [];
  const { project, issue, projectSelection, inferredFromGitRemote } = await resolveDispatchProject({
    projects,
    task,
    project: input.project,
    repo: input.repo,
    cwd: input.cwd ?? process.cwd(),
  });

  // The dashboard's dispatch dialog defaults the base branch to main; keep
  // the CLI on the same product default.
  const branch = input.branch?.trim() || "main";
  const model = input.model?.trim() || undefined;
  const title = input.title?.trim() || undefined;
  const blueprintVersionId = input.blueprintVersionId?.trim() || undefined;
  // A bare issue reference targets the default "Implement GitHub Issue"
  // blueprint, whose prompt parses ISSUE_URL and DESTINATION_BRANCH from the
  // final lines of the task input.
  const taskPrompt = issue
    ? `Implement the GitHub issue below and prepare a pull request.\n\nISSUE_URL=${issue.url}\nDESTINATION_BRANCH=${branch}`
    : task;

  const dispatched = await backend.api.org({ organizationId }).runs.dispatch.post({
    projectId: project.id,
    task: taskPrompt,
    branch,
    model,
    title,
    blueprintVersionId,
  });
  if (dispatched.error) throw apiRequestError("Dispatch", dispatched.error);
  if (!dispatched.data)
    throw new Error(
      "Devboxes did not return a session. Check Sessions in the dashboard before submitting again.",
    );

  return {
    agentSessionId: dispatched.data.agentSessionId,
    runId: dispatched.data.runId,
    status: dispatched.data.status,
    projectId: project.id,
    repository: project.repository.name,
    branch,
    projectSelection,
    inferredFromGitRemote,
  };
};

export type ContinueInput = {
  agentSessionId: string;
  task: string;
};

export const continueDevboxesSession = async (context: DevboxesContext, input: ContinueInput) => {
  const { backend, organizationId } = connectedBackend(context);
  if (!input.task.trim()) throw new Error("Enter the task for the next run.");

  const continuation = await backend.api
    .org({ organizationId })
    ["agent-sessions"]({ agentSessionId: input.agentSessionId })
    .continuations.post({ task: input.task, clientMessageId: randomUUID() });
  if (continuation.error) throw apiRequestError("Session continuation", continuation.error);
  const session = continuation.data;
  if (!session) throw new Error("Session continuation returned no Session.");
  if (session.id !== input.agentSessionId) {
    throw new Error("Session continuation returned a different Session.");
  }

  return {
    agentSessionId: session.id,
    runId: session.continuationRunId,
    status: session.currentTask.status,
  };
};

export const readDevboxesSession = async (context: DevboxesContext, agentSessionId: string) => {
  const { backend, organizationId } = connectedBackend(context);
  const sessionResponse = await backend.api
    .org({ organizationId })
    ["agent-sessions"]({ agentSessionId })
    .get();
  if (sessionResponse.error) throw apiRequestError("Agent session lookup", sessionResponse.error);
  const session = sessionResponse.data;
  if (!session) throw new Error("Agent session lookup returned no session.");
  const currentRun = session.runs.at(-1);
  if (!currentRun) throw new Error("Session lookup returned no Run.");
  const currentTask = session.currentTask;
  if (currentTask.runId !== currentRun.id) {
    throw new Error("Session lookup returned a task for a different Run.");
  }

  // The Run is the product truth for status, outcome, and usage. A
  // session without its canonical Run is an invalid read, not another public
  // status shape.
  const runResponse = await backend.api
    .org({ organizationId })
    .runs({ runId: currentRun.id })
    .get();
  if (runResponse.error) throw apiRequestError("Run lookup", runResponse.error);
  const run = runResponse.data;
  if (!run) throw new Error("Run lookup returned no Run.");

  return { session, currentTask, run };
};

const terminalRunStatuses = new Set(["succeeded", "failed", "cancelled"]);

export const sessionReachedTerminalState = (input: { run: { status: string } }) =>
  terminalRunStatuses.has(input.run.status);

const sessionStatusJson = (input: Awaited<ReturnType<typeof readDevboxesSession>>) => ({
  agentSessionId: input.session.id,
  sessionStatus: input.currentTask.status,
  runId: input.run.id,
  runStatus: input.run.status,
  currentStep: input.run.currentStep,
  terminal: sessionReachedTerminalState(input),
  repository: input.currentTask.repositoryFullName,
  branch: input.run.branch ?? input.currentTask.baseBranch,
  model: `${input.currentTask.modelProviderId}/${input.currentTask.modelId}`,
  outcome: input.run.outcome,
  errorMessage: input.run.errorMessage ?? input.currentTask.errorMessage ?? null,
  queuedAt: input.run.queuedAt,
  startedAt: input.run.startedAt,
  completedAt: input.run.completedAt,
  usage: input.run.usage,
});

export const addAccountCommands = (program: Command) => {
  const cliOptions = (command: Command): DevboxesCliOptions =>
    command.optsWithGlobals<DevboxesCliOptions>();
  const agentSessionIdArgument = (value: string) => {
    if (!Value.Check(AgentSessionIdSchema, value)) {
      throw new InvalidArgumentError("must be a UUID");
    }
    return value;
  };

  const loginCommand = program.command("login");
  loginCommand
    .description("sign in to Devboxes by approving this terminal in your browser")
    .action(async () => {
      const context = await loadContext(cliOptions(loginCommand));
      const connected = await loginDevboxes(context);
      log.success(
        `Signed in as ${connected.user.email} to organization ${connected.organization.name}. Credentials saved at ${context.configPath}.`,
      );
    });

  const dispatchCommand = program.command("dispatch");
  dispatchCommand
    .description("start a run from a task or GitHub issue")
    .argument("<task...>", "task instructions, a GitHub issue URL, or owner/repo#123")
    .option(
      "--repo <owner/name>",
      "project repository; inferred from this directory's Git origin when omitted",
    )
    .option("--project <id>", "project ID; overrides --repo")
    .option("--model <provider/model>", "provider/model ID; uses the server default when omitted")
    .option("--branch <branch>", "starting branch and pull request destination", "main")
    .option("--title <title>", "run title")
    .option(
      "--blueprint-version <id>",
      "blueprint version ID; defaults to the current Implement GitHub Issue version",
    )
    .option("--json", "write the dispatch result as JSON to stdout", false)
    .action(async (taskWords: string[]) => {
      const options = dispatchCommand.opts<{
        repo?: string;
        project?: string;
        model?: string;
        branch: string;
        title?: string;
        blueprintVersion?: string;
        json: boolean;
      }>();
      const context = await loadContext(cliOptions(dispatchCommand));
      const dispatched = await dispatchDevboxesTask(context, {
        task: taskWords.join(" "),
        repo: options.repo,
        project: options.project,
        model: options.model,
        branch: options.branch,
        title: options.title,
        blueprintVersionId: options.blueprintVersion,
      });
      if (options.json) {
        process.stdout.write(`${JSON.stringify(dispatched, null, 2)}\n`);
        return;
      }
      // An implicit default must be visible, so a wrong guess is caught
      // immediately and corrected with --repo or --project.
      if (dispatched.projectSelection === "git-remote") {
        log.info(
          `Project: ${dispatched.repository} (inferred from git remote ${dispatched.inferredFromGitRemote})`,
        );
      } else if (dispatched.projectSelection === "single-project") {
        log.info(`Project: ${dispatched.repository} (the organization's only project)`);
      }
      log.success(
        `Dispatched run ${dispatched.runId} on ${dispatched.repository} (${dispatched.branch}).`,
      );
      log.info(
        `Follow it with \`${cliCommandName} status ${dispatched.agentSessionId}\` and fetch the outcome with \`${cliCommandName} result ${dispatched.agentSessionId}\`.`,
      );
    });

  const continueCommand = program.command("continue");
  continueCommand
    .description("start another run in an existing session")
    .argument("<agentSessionId>", "session ID returned by dispatch", agentSessionIdArgument)
    .argument("<task...>", "instructions for the next run")
    .option("--json", "write the continuation result as JSON to stdout", false)
    .action(async (agentSessionId: string, taskWords: string[]) => {
      const options = continueCommand.opts<{ json: boolean }>();
      const context = await loadContext(cliOptions(continueCommand));
      const continuation = await continueDevboxesSession(context, {
        agentSessionId,
        task: taskWords.join(" "),
      });
      if (options.json) {
        process.stdout.write(`${JSON.stringify(continuation, null, 2)}\n`);
        return;
      }
      log.success(
        `Continued Session ${continuation.agentSessionId} with Run ${continuation.runId} (${continuation.status}).`,
      );
      log.info(
        `Follow it with \`${cliCommandName} status ${continuation.agentSessionId}\` and fetch the outcome with \`${cliCommandName} result ${continuation.agentSessionId}\`.`,
      );
    });

  for (const name of ["status", "result"] as const) {
    const command = program.command(name);
    command
      .description(
        name === "result"
          ? "read the current run outcome; exits with status 1 while work is unfinished"
          : "read the current run status for a session",
      )
      .argument("<agentSessionId>", "session ID returned by dispatch")
      .option(
        "--json",
        `write ${name === "result" ? "the result" : "status"} as JSON to stdout`,
        false,
      )
      .action(async (agentSessionId: string) => {
        const options = command.opts<{ json: boolean }>();
        const context = await loadContext(cliOptions(command));
        const status = sessionStatusJson(await readDevboxesSession(context, agentSessionId));
        if (options.json) {
          process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
        } else {
          note(
            [
              `Session: ${status.agentSessionId} (${status.sessionStatus})`,
              `Run: ${status.runId} (${status.runStatus})`,
              ...(status.currentStep ? [`Step: ${status.currentStep}`] : []),
              `Repository: ${status.repository} → ${status.branch}`,
              `Model: ${status.model}`,
              ...(status.outcome?.summary ? [`Outcome: ${status.outcome.summary.text}`] : []),
              ...(status.outcome?.externalResults.flatMap((result) =>
                result.canonicalUrl ? [`${result.type}: ${result.canonicalUrl}`] : [],
              ) ?? []),
              ...(status.outcome?.publicationFailures.map(
                (failure) => `${failure.type} publication failed: ${failure.error}`,
              ) ?? []),
              ...(status.errorMessage ? [`Error: ${status.errorMessage}`] : []),
            ].join("\n"),
            "Devboxes session",
          );
        }
        if (name === "result" && !status.terminal) {
          if (!options.json) {
            log.warn(
              `The Run is still ${status.runStatus}; poll \`${cliCommandName} status ${agentSessionId}\` until it finishes.`,
            );
          }
          process.exitCode = 1;
        }
      });
  }

  const mcpCommand = program.command("mcp");
  mcpCommand
    .description("bridge the authenticated Devboxes MCP server over stdio")
    .option("--project <projectId>", "fix Run and Agent Session operations to this Project ID")
    .action(async () => {
      const context = await loadContext(cliOptions(mcpCommand));
      const options = mcpCommand.opts<{ project?: string }>();
      // Deferred so account commands never pay the MCP SDK import, and
      // so devboxes.ts and mcp.ts avoid a static import cycle.
      const { runDevboxesMcpServer } = await import("./mcp");
      await runDevboxesMcpServer(context, { projectId: options.project });
    });
};
