import { beforeAll, afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as schema from "@firops/api/db/schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { eq } from "drizzle-orm";

import { createApiIntegrationHarness } from "@/test/api-integration";

import {
  connectDevboxes,
  createDevboxesCommand,
  dispatchDevboxesTask,
  loadContext,
  parseGitHubIssueReference,
  readDevboxesSession,
  readDevboxesSessionResult,
  type DevboxesCliContext,
} from "./devboxes";
import { createDevboxesMcpServer } from "./mcp";

const ownerUserId = "devboxes-cli-owner";
const ownerEmail = "devboxes-cli-owner@example.com";
const ownerPassword = "devboxes-cli-owner-password";

const harness = createApiIntegrationHarness("devboxes-cli");

describe("devboxes CLI", () => {
  let dbClient: Awaited<ReturnType<typeof harness.db>>;
  let listener: ReturnType<typeof Bun.serve>;
  let origin: string;
  let configDir: string;
  let context: DevboxesCliContext;
  let organizationId: string;
  let fixture: Awaited<ReturnType<typeof harness.seedGithubProjectRun>>;
  let secondFixture: Awaited<ReturnType<typeof harness.seedGithubProjectRun>>;

  beforeAll(async () => {
    dbClient = await harness.db();
    const auth = await harness.auth();
    const server = await harness.server();

    await auth.api.createUser({
      body: {
        email: ownerEmail,
        name: "Devboxes CLI Owner",
        password: ownerPassword,
        data: { id: ownerUserId, emailVerified: true, status: "active" },
      },
    });
    // Open signup gives every new user a default organization with an owner
    // membership; /api/me (and therefore `devboxes connect`) resolves that
    // organization, so the project fixtures must live in it.
    const defaultMembership = await dbClient.db.query.member.findFirst({
      where: { userId: ownerUserId },
    });
    if (!defaultMembership) throw new Error("Expected a default organization membership.");
    organizationId = defaultMembership.organizationId;
    fixture = await harness.seedGithubProjectRun({
      organizationId,
      createdByUserId: ownerUserId,
    });
    // A second project proves --repo/issue-URL project selection instead of a
    // single-project fallback.
    secondFixture = await harness.seedGithubProjectRun({
      organizationId,
      createdByUserId: ownerUserId,
      repository: { name: "acme/other-service", url: "https://github.com/acme/other-service" },
      githubAppInstallation: { githubInstallationId: "102" },
    });
    for (const projectFixture of [fixture, secondFixture]) {
      await dbClient.db.insert(schema.blueprintSteps).values({
        organizationId,
        blueprintVersionId: projectFixture.blueprintVersionId,
        stepKey: "implement",
        name: "Implement",
        order: 1,
        action: "opencode.run",
      });
    }

    // The CLI talks over real HTTP, so the app needs a real socket.
    listener = Bun.serve({ port: 0, fetch: (request) => server.handle(request) });
    origin = `http://127.0.0.1:${listener.port}`;

    configDir = await mkdtemp(join(tmpdir(), "devboxes-cli-config-"));
    context = await loadContext({
      config: join(configDir, "cli.json"),
      api: `${origin}/api`,
    });
  }, 120_000);

  afterAll(async () => {
    await listener?.stop(true);
    const { closeOpencodeClickHouseEventStorage } = await import("@/clickhouse/opencode-events");
    await closeOpencodeClickHouseEventStorage();
    if (configDir) await rm(configDir, { recursive: true, force: true });
  });

  it("keeps the CLI command surface", () => {
    const command = createDevboxesCommand();
    expect(command.name()).toBe("devboxes");
    // The command surface is a set contract; help-listing order is cosmetics.
    expect(command.options.map((option) => option.long).sort()).toEqual(
      ["--api", "--auth", "--config", "--organization", "--version"].sort(),
    );
    expect(command.commands.map((child) => child.name()).sort()).toEqual(
      ["connect", "dispatch", "mcp", "result", "status"].sort(),
    );
    const dispatch = command.commands.find((child) => child.name() === "dispatch");
    expect(dispatch?.options.map((option) => option.long).sort()).toEqual(
      ["--blueprint", "--branch", "--json", "--model", "--project", "--repo", "--title"].sort(),
    );
  });

  it("parses GitHub issue references", () => {
    expect(
      parseGitHubIssueReference("https://github.com/firatoezcan/devboxes-dashboard/issues/42"),
    ).toEqual({
      url: "https://github.com/firatoezcan/devboxes-dashboard/issues/42",
      repositoryFullName: "firatoezcan/devboxes-dashboard",
    });
    expect(parseGitHubIssueReference("firatoezcan/devboxes-dashboard#42")).toEqual({
      url: "https://github.com/firatoezcan/devboxes-dashboard/issues/42",
      repositoryFullName: "firatoezcan/devboxes-dashboard",
    });
    expect(parseGitHubIssueReference("Fix the queue worker retry logic.")).toBeNull();
  });

  it("connects through the real device authorization flow", async () => {
    const connectPromise = connectDevboxes(context);

    // The browser-approval leg, driven exactly like the /device page: a
    // signed-in user approves the printed user code.
    let userCode: string | undefined;
    for (let attempt = 0; attempt < 100 && !userCode; attempt += 1) {
      const [pending] = await dbClient.db.select().from(schema.deviceCode).limit(1);
      userCode = pending?.userCode;
      if (!userCode) await Bun.sleep(100);
    }
    if (!userCode) throw new Error("The device flow never persisted a device code.");

    const approverCookie = await harness.signInEmailSessionCookie({
      email: ownerEmail,
      password: ownerPassword,
    });
    const approval = await fetch(`${origin}/api/auth/device/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
        Cookie: approverCookie,
      },
      body: JSON.stringify({ userCode }),
    });
    expect(approval.status).toBe(200);

    const connected = await connectPromise;
    expect(connected.user.email).toBe(ownerEmail);
    expect(connected.organization.id).toBe(organizationId);

    const configFile = JSON.parse(await readFile(context.configPath, "utf8")) as {
      apiBaseUrl: string;
      organizationId: string;
      sessionToken: string;
    };
    expect(configFile.apiBaseUrl).toBe(`${origin}/api`);
    expect(configFile.organizationId).toBe(organizationId);
    expect(configFile.sessionToken.length).toBeGreaterThan(0);
    const mode = (await stat(context.configPath)).mode & 0o777;
    expect(mode).toBe(0o600);

    // A fresh context loads the persisted credentials the way every later
    // command invocation would.
    context = await loadContext({ config: context.configPath });
  }, 60_000);

  let dispatchedSessionId: string;
  let dispatchedRunId: string;

  it("dispatches free-form task text to the project matching --repo", async () => {
    const dispatched = await dispatchDevboxesTask(context, {
      task: "Fix the flaky retry handling in the queue worker.",
      repo: fixture.repositoryFullName,
      model: "openai/gpt-5.5",
      blueprint: fixture.blueprintId,
    });
    dispatchedSessionId = dispatched.agentSessionId;
    dispatchedRunId = dispatched.runId;

    expect(dispatched.status).toBe("queued");
    expect(dispatched.projectId).toBe(fixture.projectId);
    expect(dispatched.repository).toBe(fixture.repositoryFullName);

    const task = await dbClient.db.query.opencodeDispatchTasks.findFirst({
      where: { id: dispatched.agentSessionId, organizationId },
    });
    expect(task?.status).toBe("queued");
    expect(task?.taskPrompt).toContain("Fix the flaky retry handling in the queue worker.");
    expect(task?.modelProviderId).toBe("openai");
    expect(task?.modelId).toBe("gpt-5.5");
    const run = await dbClient.db.query.runs.findFirst({
      where: { id: dispatched.runId, organizationId },
    });
    expect(run?.status).toBe("queued");
  });

  it("dispatches a bare issue URL with ISSUE_URL task composition and infers the project", async () => {
    const issueUrl = `https://github.com/${fixture.repositoryFullName}/issues/42`;
    const dispatched = await dispatchDevboxesTask(context, {
      task: issueUrl,
      blueprint: fixture.blueprintId,
    });

    expect(dispatched.projectId).toBe(fixture.projectId);
    const task = await dbClient.db.query.opencodeDispatchTasks.findFirst({
      where: { id: dispatched.agentSessionId, organizationId },
    });
    expect(task?.taskPrompt).toContain(`ISSUE_URL=${issueUrl}`);
    expect(task?.taskPrompt).toContain("DESTINATION_BRANCH=main");
    expect(task?.baseBranch).toBe("main");
  });

  it("refuses an ambiguous dispatch instead of guessing a project", async () => {
    await expect(
      dispatchDevboxesTask(context, { task: "Ship something somewhere." }),
    ).rejects.toThrow("Pass --repo");
    await expect(
      dispatchDevboxesTask(context, { task: "Ship it.", repo: "acme/unknown-repo" }),
    ).rejects.toThrow("No project matches repository");
  });

  it("reads session and run status for a dispatched session", async () => {
    const current = await readDevboxesSession(context, dispatchedSessionId);
    expect(current.session.id).toBe(dispatchedSessionId);
    expect(current.session.status).toBe("queued");
    expect(current.run?.id).toBe(dispatchedRunId);
    expect(current.run?.status).toBe("queued");

    await expect(
      readDevboxesSession(context, "00000000-0000-7000-8000-00000000dead"),
    ).rejects.toThrow("404");
  });

  it("reads the result with pull request link and final assistant output", async () => {
    const { appendRawOpencodeEventsToClickHouse } = await import("@/clickhouse/opencode-events");
    await appendRawOpencodeEventsToClickHouse({
      organizationId,
      agentSessionId: dispatchedSessionId,
      events: [
        {
          type: "message.updated",
          properties: {
            sessionID: "ses-cli",
            info: { id: "msg-user", sessionID: "ses-cli", role: "user", time: { created: 1 } },
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: "ses-cli",
            part: {
              id: "prt-user",
              sessionID: "ses-cli",
              messageID: "msg-user",
              type: "text",
              text: "Fix the flaky retry handling in the queue worker.",
            },
            time: 1,
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: "ses-cli",
            info: {
              id: "msg-assistant",
              sessionID: "ses-cli",
              role: "assistant",
              time: { created: 2 },
            },
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: "ses-cli",
            part: {
              id: "prt-assistant",
              sessionID: "ses-cli",
              messageID: "msg-assistant",
              type: "text",
              text: "Retry handling now backs off exponentially; opened a pull request.",
            },
            time: 2,
          },
        },
      ],
    });
    await dbClient.db
      .update(schema.runs)
      .set({
        status: "succeeded",
        pullRequestUrl: "https://github.com/firatoezcan/devboxes-dashboard/pull/77",
        completedAt: new Date(),
      })
      .where(eq(schema.runs.id, dispatchedRunId));

    const result = await readDevboxesSessionResult(context, dispatchedSessionId);
    expect(result.terminal).toBe(true);
    expect(result.run?.pullRequestUrl).toBe(
      "https://github.com/firatoezcan/devboxes-dashboard/pull/77",
    );
    expect(result.finalOutputError).toBeNull();
    expect(result.finalOutput).toBe(
      "Retry handling now backs off exponentially; opened a pull request.",
    );
  });

  it("serves dispatch/status/result as MCP tools over the stored credentials", async () => {
    const server = createDevboxesMcpServer(context);
    const client = new Client({ name: "devboxes-cli-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "dispatch_task",
        "get_session_result",
        "get_session_status",
      ]);

      const statusResult = await client.callTool({
        name: "get_session_status",
        arguments: { agentSessionId: dispatchedSessionId },
      });
      const statusContent = statusResult.content as Array<{ type: string; text: string }>;
      const status = JSON.parse(statusContent[0]!.text) as {
        runStatus: string;
        terminal: boolean;
        pullRequestUrl: string;
      };
      expect(status.runStatus).toBe("succeeded");
      expect(status.terminal).toBe(true);
      expect(status.pullRequestUrl).toBe(
        "https://github.com/firatoezcan/devboxes-dashboard/pull/77",
      );

      const resultCall = await client.callTool({
        name: "get_session_result",
        arguments: { agentSessionId: dispatchedSessionId },
      });
      const resultContent = resultCall.content as Array<{ type: string; text: string }>;
      const sessionResult = JSON.parse(resultContent[0]!.text) as { finalOutput: string };
      expect(sessionResult.finalOutput).toBe(
        "Retry handling now backs off exponentially; opened a pull request.",
      );

      const missing = await client.callTool({
        name: "get_session_status",
        arguments: { agentSessionId: "00000000-0000-7000-8000-00000000dead" },
      });
      expect(missing.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
