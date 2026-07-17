import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { log, note, spinner } from "@clack/prompts";
import { treaty } from "@elysiajs/eden";
import { createAuthClient } from "better-auth/client";
import { deviceAuthorizationClient } from "better-auth/client/plugins";
import { Command } from "commander";
import open from "open";
import Type, { type Static } from "typebox";
import Value from "typebox/value";

// Type-only wiring against the private monorepo this CLI is developed in,
// resolved through tsconfig "paths" there and fully erased at runtime (both
// are `import type`). In the published package and the public source mirror
// these specifiers stay unresolved on purpose: nothing private ships.
import type { ApiType } from "#monorepo/api";
import type { GlobalEvent } from "#monorepo/opencode-events";

import packageJson from "../package.json";
import { writeSecretFile } from "./secret-file";

type DevboxesCliOptions = {
  config?: string;
  api?: string;
  auth?: string;
  organization?: string;
};

type DevboxesCliConfig = {
  apiBaseUrl: string;
  authBaseUrl: string;
  organizationId?: string;
  sessionToken?: string;
};

export type DevboxesCliContext = {
  config: DevboxesCliConfig;
  configPath: string;
  // Unknown cli.json keys from a newer binary, preserved on write.
  configExtras?: Record<string, unknown>;
};

const CliConfigFileSchema = Type.Object({
  apiBaseUrl: Type.Optional(Type.String({ minLength: 1 })),
  authBaseUrl: Type.Optional(Type.String({ minLength: 1 })),
  organizationId: Type.Optional(Type.String({ minLength: 1 })),
  sessionToken: Type.Optional(Type.String({ minLength: 1 })),
});

type CliConfigFile = Static<typeof CliConfigFileSchema>;

export const cliCommandName = "devboxes";
// The npm package version is the single source of truth: `changeset version`
// bumps package.json, and --version/user-agent/MCP server info follow it.
export const cliVersion: string = packageJson.version;
const cliUserAgent = `devboxes-cli/${cliVersion} (${process.platform}/${process.arch})`;
// Must stay in the validateClient allowlist of the API's deviceAuthorization
// auth plugin. Public identifier, not a secret: it only names which client
// asked for the browser approval.
export const cliDeviceClientId = "devboxes-cli";
// Mirrors the dashboard dispatch console's default model (defaultOpencodeModel
// in the web app's model catalog).
export const defaultDispatchModel = "deepseek/deepseek-v4-pro";

const windowsApplicationDataHome = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");

const platformConfigHome = () => {
  if (process.env.XDG_CONFIG_HOME) return process.env.XDG_CONFIG_HOME;
  if (process.platform === "win32") return windowsApplicationDataHome;
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  return join(homedir(), ".config");
};

const writeConfig = async (context: DevboxesCliContext) => {
  // The config carries the session token: atomic fsync'd tmp+rename, 0600.
  // Known fields win over preserved unknown keys from a newer binary.
  await writeSecretFile({
    path: context.configPath,
    contents: `${JSON.stringify({ ...context.configExtras, ...context.config }, null, 2)}\n`,
    tmpPrefix: ".cli.",
  });
};

export const loadContext = async (options: DevboxesCliOptions): Promise<DevboxesCliContext> => {
  const configPath = options.config ?? join(platformConfigHome(), "devboxes", "cli.json");
  let fileConfig: CliConfigFile = {};
  let rawConfigText: string | null = null;
  try {
    rawConfigText = await readFile(configPath, "utf8");
  } catch (error) {
    const missing =
      error && typeof error === "object" && "code" in error && error.code === "ENOENT";
    if (!missing) throw error;
  }
  if (rawConfigText !== null) {
    try {
      fileConfig = Value.Parse(CliConfigFileSchema, JSON.parse(rawConfigText));
    } catch (error) {
      // A raw TypeBox/JSON error prints as little as the word "Parse": name
      // the file and the recovery at the boundary instead.
      throw new Error(
        `Devboxes CLI config at ${configPath} is invalid: ${
          error instanceof Error ? error.message : String(error)
        }. Fix or delete the file, then run \`${cliCommandName} connect\`.`,
      );
    }
  }
  // Unknown keys written by a newer CLI round-trip through writeConfig.
  const knownConfigKeys = new Set(Object.keys(CliConfigFileSchema.properties));
  const configExtras = Object.fromEntries(
    Object.entries(fileConfig).filter(([key]) => !knownConfigKeys.has(key)),
  );
  const configuredApiBaseUrl =
    options.api ?? process.env.DEVBOX_API_BASE_URL ?? fileConfig.apiBaseUrl;
  if (!configuredApiBaseUrl) {
    throw new Error(
      `No API base URL configured. Run \`${cliCommandName} connect --api <url>\` (e.g. --api https://devboxes.example.com/api) or set DEVBOX_API_BASE_URL.`,
    );
  }
  // Normalized exactly once, here: no trailing slash and always ending in
  // /api. Every consumer relies on that shape — the Eden client strips the
  // suffix back off before its typed routes re-add it, and the SSE reader
  // string-concatenates paths onto it. Parse before looking at the suffix:
  // a raw-string check mistakes a host-only URL like https://api for an
  // already-suffixed one, and the API always mounts at lowercase /api.
  let parsedApiBaseUrl: URL;
  try {
    parsedApiBaseUrl = new URL(configuredApiBaseUrl);
  } catch {
    throw new Error(`Devboxes API base URL is not a valid URL: ${configuredApiBaseUrl}`);
  }
  // A scheme-less "host:3000/api" parses as scheme "host:", and non-special
  // schemes (file:, git:, ssh:) have no origin at all — both would rebuild
  // into a garbage base URL; fail naming the input instead.
  if (parsedApiBaseUrl.origin === "null") {
    throw new Error(
      `Devboxes API base URL must be an absolute http(s) URL (e.g. https://app.local.devboxes.ai/api): ${configuredApiBaseUrl}`,
    );
  }
  // The origin+pathname rebuild below would silently drop these; refuse loudly
  // instead. The message deliberately does not echo the input — it may carry
  // the very credentials being rejected.
  if (
    parsedApiBaseUrl.username ||
    parsedApiBaseUrl.password ||
    parsedApiBaseUrl.search ||
    parsedApiBaseUrl.hash
  ) {
    throw new Error(
      "Devboxes API base URL must not contain credentials, a query string, or a fragment.",
    );
  }
  const apiBasePath = parsedApiBaseUrl.pathname.replace(/\/+$/, "");
  const apiBaseUrl = `${parsedApiBaseUrl.origin}${
    apiBasePath.toLowerCase().endsWith("/api")
      ? `${apiBasePath.slice(0, -"/api".length)}/api`
      : `${apiBasePath}/api`
  }`;
  const authBaseUrl = (
    options.auth ??
    process.env.DEVBOX_AUTH_BASE_URL ??
    fileConfig.authBaseUrl ??
    `${apiBaseUrl}/auth`
  ).replace(/\/+$/, "");

  // The session token travels over these base URLs, so require HTTPS everywhere
  // except loopback HTTP for local development (same policy as the listener).
  for (const [label, value] of [
    ["API base URL", apiBaseUrl],
    ["auth base URL", authBaseUrl],
  ] as const) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`Devboxes ${label} is not a valid URL: ${value}`);
    }
    const loopbackHttp =
      url.protocol === "http:" &&
      // URL.hostname keeps the brackets around an IPv6 literal.
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]");
    if (url.protocol !== "https:" && !loopbackHttp) {
      throw new Error(
        `Devboxes ${label} must use HTTPS (or loopback HTTP for local development): ${value}`,
      );
    }
  }

  return {
    configPath,
    configExtras,
    config: {
      apiBaseUrl,
      authBaseUrl,
      organizationId:
        options.organization ?? process.env.DEVBOX_ORGANIZATION_ID ?? fileConfig.organizationId,
      sessionToken: process.env.DEVBOX_CLI_SESSION_TOKEN ?? fileConfig.sessionToken,
    },
  };
};

// An abandoned browser approval must not hang the CLI forever.
const connectFlowTimeoutMs = 5 * 60_000;

class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Translates an Eden treaty error into one readable line. The raw response
// body is never serialized into the message — a validation error echoes the
// request body back, and dispatch bodies carry task text that must stay out
// of captured logs verbatim.
const apiRequestError = (operation: string, error: { status: unknown; value: unknown }) => {
  const value = error.value as { code?: unknown; error?: unknown } | null;
  const code =
    value && typeof value === "object" && typeof value.code === "string" ? value.code : null;
  const detail =
    value && typeof value === "object" && typeof value.error === "string"
      ? value.error
      : "The API answered without an error description.";
  const status = typeof error.status === "number" ? error.status : 0;
  const hint = status === 401 ? ` Run \`${cliCommandName} connect\` to sign in again.` : "";
  return new ApiRequestError(
    `${operation} failed with HTTP ${String(error.status)}: ${detail}${hint}`,
    status,
    code,
  );
};

const openBrowser = async (url: string) => {
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

const deviceSessionToken = async (config: DevboxesCliConfig) => {
  const authClient = createAuthClient({
    baseURL: config.authBaseUrl,
    plugins: [deviceAuthorizationClient()],
  });
  const { data: device, error } = await authClient.device.code({
    client_id: cliDeviceClientId,
    scope: "cli",
  });
  if (error || !device) {
    throw new Error(`Device authorization failed: ${JSON.stringify(error)}`);
  }
  // The code and URL print plainly so they stay copyable from any terminal.
  console.info(`Approve the Devboxes CLI sign-in with code ${device.user_code}.`);
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
    const deadline = Date.now() + connectFlowTimeoutMs;
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error("Devboxes CLI sign-in timed out after 5 minutes without browser approval.");
      }
      await sleep(intervalMs);
      const token = await authClient.device.token({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: cliDeviceClientId,
      });
      if (token.data?.access_token) {
        approval?.stop("Devboxes CLI sign-in approved.");
        return token.data.access_token;
      }
      const errorCode = (token.error as { error?: string } | null)?.error;
      if (errorCode === "authorization_pending") continue;
      if (errorCode === "slow_down") {
        intervalMs += 5_000;
        continue;
      }
      throw new Error(`Device sign-in failed: ${JSON.stringify(token.error)}`);
    }
  } catch (error) {
    approval?.error("Devboxes CLI sign-in was not approved.");
    throw error;
  }
};

// One bearer-authorized Eden client policy for every API call the CLI makes.
// loadContext guarantees the base URL ends in /api; Eden's typed routes re-add
// that segment (backend.api...), so the treaty origin is the URL without it.
const bearerBackend = (apiBaseUrl: string, sessionToken: string) =>
  treaty<ApiType>(apiBaseUrl.replace(/\/api$/, ""), {
    onRequest(_path, requestOptions) {
      const headers = new Headers(requestOptions.headers);
      headers.set("Authorization", `Bearer ${sessionToken}`);
      headers.set("User-Agent", cliUserAgent);
      return { ...requestOptions, headers };
    },
  });

const connectedBackend = (context: DevboxesCliContext) => {
  const { sessionToken, organizationId } = context.config;
  if (!sessionToken || !organizationId) {
    throw new Error(
      `This command requires a connected account. Run \`${cliCommandName} connect\` first.`,
    );
  }
  return {
    backend: bearerBackend(context.config.apiBaseUrl, sessionToken),
    organizationId,
    sessionToken,
  };
};

export const connectDevboxes = async (context: DevboxesCliContext) => {
  const sessionToken = await deviceSessionToken(context.config);
  context.config.sessionToken = sessionToken;

  const backend = bearerBackend(context.config.apiBaseUrl, sessionToken);
  const me = await backend.api.me.get();
  if (me.error) throw apiRequestError("Account lookup", me.error);
  const organization = me.data?.organization;
  if (!me.data || !organization) {
    throw new Error(
      "This account has no active organization. Finish onboarding in the Devboxes dashboard, then connect again.",
    );
  }
  context.config.organizationId = organization.id;
  await writeConfig(context);
  return { user: me.data.user, organization };
};

// Accepts a full GitHub issue URL or the short owner/repo#123 form. Anything
// else is free-form task text.
export const parseGitHubIssueReference = (task: string) => {
  const trimmed = task.trim();
  const urlMatch = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)$/.exec(trimmed);
  if (urlMatch) {
    return {
      url: trimmed,
      repositoryFullName: `${urlMatch[1]}/${urlMatch[2]}`,
    };
  }
  const shortMatch = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(trimmed);
  if (shortMatch) {
    return {
      url: `https://github.com/${shortMatch[1]}/${shortMatch[2]}/issues/${shortMatch[3]}`,
      repositoryFullName: `${shortMatch[1]}/${shortMatch[2]}`,
    };
  }
  return null;
};

// Git remotes name the same repository as https ("https://github.com/acme/api.git"),
// ssh ("ssh://git@github.com:22/acme/api"), or scp-like ("git@github.com:acme/api")
// URLs. All collapse to one lowercase "host[:port]/path" key with credentials,
// scheme-default ports, ".git", and slashes stripped. Project inference compares
// these keys with exact string equality only — never fuzzy — so a remote that
// does not normalize to exactly one project repository selects nothing.
const schemeDefaultPorts: Record<string, string> = {
  "http:": "80",
  "https:": "443",
  "ssh:": "22",
  "git:": "9418",
};

export const normalizeGitRemoteUrl = (remote: string) => {
  const trimmed = remote.trim();
  if (!trimmed) return null;
  let host: string;
  let path: string;
  const scpLike = trimmed.includes("://")
    ? null
    : /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed);
  if (scpLike?.[1] && scpLike[2]) {
    host = scpLike[1];
    path = scpLike[2];
  } else {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    // Local paths and file:// remotes have no host to match a hosted project.
    if (!url.hostname) return null;
    const port = url.port && url.port !== schemeDefaultPorts[url.protocol] ? `:${url.port}` : "";
    host = `${url.hostname}${port}`;
    path = url.pathname;
  }
  const normalizedPath = path
    .replace(/\/+$/, "")
    // Case-insensitive: the key is lowercased below, so ".GIT" must strip
    // exactly like ".git".
    .replace(/\.git$/i, "")
    .replace(/^\/+/, "");
  if (!normalizedPath) return null;
  return `${host}/${normalizedPath}`.toLowerCase();
};

// The origin remote of the dispatch working directory. Anything that keeps it
// from resolving — not a git repository, no origin remote, git not installed —
// means "no inference", never an error.
const gitRemoteOriginUrl = async (cwd: string) => {
  try {
    const git = Bun.spawn(["git", "remote", "get-url", "origin"], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [output, exitCode] = await Promise.all([new Response(git.stdout).text(), git.exited]);
    if (exitCode !== 0) return null;
    return output.trim() || null;
  } catch {
    return null;
  }
};

export type DispatchInput = {
  task: string;
  repo?: string;
  project?: string;
  model?: string;
  branch?: string;
  title?: string;
  blueprint?: string;
  // Directory whose git origin remote may infer the project when neither
  // --project, --repo, nor an issue reference selects one. Defaults to the
  // process working directory.
  cwd?: string;
};

export const dispatchDevboxesTask = async (context: DevboxesCliContext, input: DispatchInput) => {
  const { backend, organizationId } = connectedBackend(context);
  const task = input.task.trim();
  if (!task) throw new Error("Dispatch requires task text or a GitHub issue reference.");

  const projectsResponse = await backend.api.org({ organizationId }).projects.get();
  if (projectsResponse.error) throw apiRequestError("Project list", projectsResponse.error);
  const projects = projectsResponse.data ?? [];
  if (projects.length === 0) {
    throw new Error(
      "The organization has no projects. Create one in the Devboxes dashboard first.",
    );
  }

  const issue = parseGitHubIssueReference(task);
  const requestedRepo = (input.repo ?? issue?.repositoryFullName)?.toLowerCase();
  let project: (typeof projects)[number] | undefined;
  // How the project was picked, so callers can display an implicit choice;
  // explicit --project/--repo/issue selection always wins.
  let projectSelection: "explicit" | "git-remote" | "single-project" = "explicit";
  // Set only when the cwd git remote picked the project. Carries the
  // credential-free normalized comparison key, never the raw remote URL — a
  // token-embedded remote (https://user:ghp_…@host/…) must not leak into
  // --json output or MCP results, which get persisted into transcripts.
  let inferredFromGitRemote: string | null = null;
  if (input.project) {
    project = projects.find((candidate) => candidate.id === input.project);
    if (!project) throw new Error(`No project has id ${input.project}.`);
  } else if (requestedRepo) {
    const matches = projects.filter((candidate) => {
      const fullName = candidate.repository.name.toLowerCase();
      return fullName === requestedRepo || fullName.endsWith(`/${requestedRepo}`);
    });
    if (matches.length !== 1) {
      const available = projects.map((candidate) => candidate.repository.name).join(", ");
      throw new Error(
        matches.length === 0
          ? `No project matches repository ${requestedRepo}. Connected repositories: ${available}.`
          : `Repository ${requestedRepo} matches more than one project. Pass --project <id>.`,
      );
    }
    project = matches[0];
  } else {
    const remote = await gitRemoteOriginUrl(input.cwd ?? process.cwd());
    const normalizedRemote = remote ? normalizeGitRemoteUrl(remote) : null;
    const remoteMatches = normalizedRemote
      ? projects.filter(
          (candidate) => normalizeGitRemoteUrl(candidate.repository.url) === normalizedRemote,
        )
      : [];
    if (normalizedRemote && remoteMatches.length === 1) {
      project = remoteMatches[0];
      projectSelection = "git-remote";
      inferredFromGitRemote = normalizedRemote;
    } else if (remoteMatches.length > 1) {
      // Projects sharing a remote share the repository name, so "--repo"
      // would be dead-end advice here; only --project disambiguates.
      const matching = remoteMatches.map((candidate) => candidate.repository.name).join(", ");
      throw new Error(
        `The git remote matches more than one project (${matching}). Pass --project <id>.`,
      );
    } else if (projects.length === 1) {
      project = projects[0];
      projectSelection = "single-project";
    } else {
      const available = projects.map((candidate) => candidate.repository.name).join(", ");
      throw new Error(
        `Pass --repo <owner/name> to pick a project. Connected repositories: ${available}.`,
      );
    }
  }
  if (!project) throw new Error("Dispatch requires a project.");

  // The dashboard's dispatch dialog defaults the base branch to main; keep
  // the CLI on the same product default.
  const branch = input.branch?.trim() || "main";
  // A bare issue reference targets the default "Implement GitHub Issue"
  // blueprint, whose prompt parses ISSUE_URL and DESTINATION_BRANCH from the
  // final lines of the task input.
  const taskPrompt = issue
    ? `Implement the GitHub issue below and prepare a pull request.\n\nISSUE_URL=${issue.url}\nDESTINATION_BRANCH=${branch}`
    : task;

  const dispatched = await backend.api.org({ organizationId }).runs.dispatch.post({
    projectId: project.id,
    task: taskPrompt,
    model: input.model?.trim() || defaultDispatchModel,
    branch,
    ...(input.title?.trim() ? { title: input.title.trim() } : {}),
    ...(input.blueprint?.trim() ? { blueprintId: input.blueprint.trim() } : {}),
  });
  if (dispatched.error) throw apiRequestError("Dispatch", dispatched.error);
  if (!dispatched.data) throw new Error("Dispatch returned no session.");

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

export const readDevboxesSession = async (context: DevboxesCliContext, agentSessionId: string) => {
  const { backend, organizationId } = connectedBackend(context);
  const sessionResponse = await backend.api
    .org({ organizationId })
    ["agent-sessions"]({ agentSessionId })
    .get();
  if (sessionResponse.error) throw apiRequestError("Agent session lookup", sessionResponse.error);
  const session = sessionResponse.data;
  if (!session) throw new Error("Agent session lookup returned no session.");

  // The run row is the product truth for outcome and PR link. A missing run
  // (404) degrades to session-status truth instead of failing status/result —
  // defensive only: run deletion cascades to the dispatch task, so in steady
  // state the session lookup above 404s first and this branch covers just the
  // in-between window (and a run hidden by soft deletion).
  const runResponse = await backend.api.org({ organizationId }).runs({ runId: session.runId }).get();
  if (runResponse.error && runResponse.error.status !== 404) {
    throw apiRequestError("Run lookup", runResponse.error);
  }
  const run = runResponse.data ?? null;

  return { session, run };
};

const terminalRunStatuses = new Set(["succeeded", "failed", "cancelled"]);
const terminalSessionStatuses = new Set(["completed", "stopped", "failed", "cancelled"]);

export const sessionReachedTerminalState = (input: {
  session: { status: string };
  run: { status: string } | null;
}) =>
  input.run
    ? terminalRunStatuses.has(input.run.status)
    : terminalSessionStatuses.has(input.session.status);

// A stalled SSE connection must not hang `result` forever; the read leg gets
// the same ceiling as the connect flow's browser-approval poll.
const finalOutputReadTimeoutMs = 5 * 60_000;

// Reads the session's stored Opencode events once — the SSE endpoint drains
// the ClickHouse backlog first and only then emits its first keepalive, so the
// keepalive is the CLI's clean "caught up, disconnect" signal — and extracts
// the text of the latest assistant message as the session's final output.
export const readFinalAssistantMessage = async (
  context: DevboxesCliContext,
  agentSessionId: string,
) => {
  const { organizationId, sessionToken } = connectedBackend(context);
  const controller = new AbortController();
  const readDeadline = AbortSignal.timeout(finalOutputReadTimeoutMs);
  const response = await fetch(
    `${context.config.apiBaseUrl}/org/${organizationId}/agent-sessions/${agentSessionId}/opencode/event`,
    {
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        Accept: "text/event-stream",
        "User-Agent": cliUserAgent,
      },
      signal: AbortSignal.any([controller.signal, readDeadline]),
    },
  ).catch((error: unknown) => {
    if (readDeadline.aborted) {
      throw new Error(
        `Opencode event read timed out after ${finalOutputReadTimeoutMs / 60_000} minutes without a response.`,
      );
    }
    throw error;
  });
  if (!response.ok || !response.body) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new ApiRequestError(
      `Opencode event read failed with HTTP ${response.status}${detail ? `: ${detail}` : "."}`,
      response.status,
    );
  }

  const roleByMessageId = new Map<string, string>();
  const textPartsByMessageId = new Map<string, Map<string, string>>();
  let latestAssistantMessageId: string | null = null;

  const applyEvent = (event: GlobalEvent["payload"]) => {
    const info =
      event.type === "message.updated"
        ? event.properties.info
        : event.type === "sync" && event.syncEvent.type === "message.updated.1"
          ? event.syncEvent.data.info
          : null;
    if (info) {
      roleByMessageId.set(info.id, info.role);
      if (info.role === "assistant") latestAssistantMessageId = info.id;
    }
    const part =
      event.type === "message.part.updated"
        ? event.properties.part
        : event.type === "sync" && event.syncEvent.type === "message.part.updated.1"
          ? event.syncEvent.data.part
          : null;
    if (part?.type === "text" && !part.synthetic && !part.ignored) {
      const parts = textPartsByMessageId.get(part.messageID) ?? new Map<string, string>();
      parts.set(part.id, part.text);
      textPartsByMessageId.set(part.messageID, parts);
    }
  };

  // One SSE block per stored event: "id: <cursor>\ndata: <event json>\n\n",
  // with ": keepalive" comments once the backlog is drained.
  const handleEventBlock = (block: string) => {
    let sawKeepalive = false;
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) {
        if (line.slice(1).trim() === "keepalive") sawKeepalive = true;
        continue;
      }
      if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trimStart();
    }
    if (data) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return sawKeepalive;
      }
      if (parsed && typeof parsed === "object" && "type" in parsed) {
        applyEvent(parsed as GlobalEvent["payload"]);
      }
    }
    return sawKeepalive;
  };

  const decoder = new TextDecoder();
  let buffered = "";
  let caughtUp = false;
  try {
    for await (const chunk of response.body) {
      buffered += decoder.decode(chunk, { stream: true });
      let boundary = buffered.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        if (handleEventBlock(block)) caughtUp = true;
        boundary = buffered.indexOf("\n\n");
      }
      if (caughtUp) break;
    }
  } catch (error) {
    // AbortSignal.timeout surfaces as an opaque TimeoutError; name the deadline.
    if (readDeadline.aborted) {
      throw new Error(
        `Opencode event read timed out after ${finalOutputReadTimeoutMs / 60_000} minutes without catching up.`,
      );
    }
    throw error;
  } finally {
    controller.abort();
  }

  if (!latestAssistantMessageId) return null;
  const parts = textPartsByMessageId.get(latestAssistantMessageId);
  if (!parts || parts.size === 0) return null;
  return [...parts.values()].join("\n\n").trim() || null;
};

export const readDevboxesSessionResult = async (
  context: DevboxesCliContext,
  agentSessionId: string,
) => {
  const { session, run } = await readDevboxesSession(context, agentSessionId);
  let finalOutput: string | null = null;
  let finalOutputError: string | null = null;
  try {
    finalOutput = await readFinalAssistantMessage(context, agentSessionId);
  } catch (error) {
    // The outcome and PR link stay useful even when event storage is
    // unreachable; surface the gap instead of failing the whole result.
    finalOutputError = error instanceof Error ? error.message : String(error);
  }
  return {
    session,
    run,
    terminal: sessionReachedTerminalState({ session, run }),
    finalOutput,
    finalOutputError,
  };
};

const sessionStatusJson = (input: Awaited<ReturnType<typeof readDevboxesSession>>) => ({
  agentSessionId: input.session.id,
  sessionStatus: input.session.status,
  runId: input.session.runId,
  runStatus: input.run?.status ?? null,
  currentStep: input.run?.currentStep ?? null,
  terminal: sessionReachedTerminalState(input),
  repository: input.session.repositoryFullName,
  branch: input.run?.branch ?? input.session.baseBranch,
  model: `${input.session.modelProviderId}/${input.session.modelId}`,
  pullRequestUrl: input.run?.pullRequestUrl ?? null,
  errorMessage: input.run?.errorMessage ?? input.session.errorMessage ?? null,
  queuedAt: input.run?.queuedAt ?? null,
  startedAt: input.run?.startedAt ?? null,
  completedAt: input.run?.completedAt ?? null,
  costUsd: input.run?.costUsd ?? null,
});

const printSessionStatus = (input: Awaited<ReturnType<typeof readDevboxesSession>>) => {
  const status = sessionStatusJson(input);
  note(
    [
      `Session: ${status.agentSessionId} (${status.sessionStatus})`,
      `Run: ${status.runId} (${status.runStatus ?? "unknown"})`,
      ...(status.currentStep ? [`Step: ${status.currentStep}`] : []),
      `Repository: ${status.repository} → ${status.branch}`,
      `Model: ${status.model}`,
      ...(status.pullRequestUrl ? [`Pull request: ${status.pullRequestUrl}`] : []),
      ...(status.errorMessage ? [`Error: ${status.errorMessage}`] : []),
    ].join("\n"),
    "Devboxes session",
  );
};

export const createDevboxesCommand = () => {
  const program = new Command();
  program
    .name(cliCommandName)
    .description("Dispatch Devboxes tasks and follow their sessions from your terminal")
    .version(cliVersion)
    .showHelpAfterError()
    .option("--config <path>", "CLI config file")
    .option("--api <url>", "Devboxes API base URL")
    .option("--auth <url>", "Devboxes auth base URL")
    .option("--organization <id>", "Devboxes organization id");

  const cliOptions = (command: Command): DevboxesCliOptions =>
    command.optsWithGlobals<DevboxesCliOptions>();

  const connectCommand = program.command("connect");
  connectCommand
    .description("sign this terminal in to Devboxes via browser approval")
    .action(async () => {
      const context = await loadContext(cliOptions(connectCommand));
      const connected = await connectDevboxes(context);
      log.success(
        `Connected as ${connected.user.email} to organization ${connected.organization.name}. Credentials saved at ${context.configPath}.`,
      );
    });

  const dispatchCommand = program.command("dispatch");
  dispatchCommand
    .description("dispatch a task or GitHub issue as a new Devboxes run")
    .argument("<task...>", "task text, a GitHub issue URL, or owner/repo#123")
    .option(
      "--repo <owner/name>",
      "repository of the target project (default: inferred from the cwd git origin remote)",
    )
    .option("--project <id>", "target project id (overrides --repo)")
    .option("--model <provider/model>", "Opencode model", defaultDispatchModel)
    .option("--branch <branch>", "base branch and PR destination", "main")
    .option("--title <title>", "run title")
    .option("--blueprint <id>", "blueprint id (defaults to the Implement GitHub Issue blueprint)")
    .option("--json", "print the dispatch result as JSON on stdout", false)
    .action(async (taskWords: string[]) => {
      const options = dispatchCommand.opts<{
        repo?: string;
        project?: string;
        model: string;
        branch: string;
        title?: string;
        blueprint?: string;
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
        blueprint: options.blueprint,
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

  const statusCommand = program.command("status");
  statusCommand
    .description("show the current status of a dispatched session")
    .argument("<agentSessionId>", "agent session id returned by dispatch")
    .option("--json", "print machine-readable status on stdout", false)
    .action(async (agentSessionId: string) => {
      const options = statusCommand.opts<{ json: boolean }>();
      const context = await loadContext(cliOptions(statusCommand));
      const current = await readDevboxesSession(context, agentSessionId);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(sessionStatusJson(current), null, 2)}\n`);
        return;
      }
      printSessionStatus(current);
    });

  const resultCommand = program.command("result");
  resultCommand
    .description("show the final output and pull request of a finished session")
    .argument("<agentSessionId>", "agent session id returned by dispatch")
    .option("--json", "print the machine-readable result on stdout", false)
    .action(async (agentSessionId: string) => {
      const options = resultCommand.opts<{ json: boolean }>();
      const context = await loadContext(cliOptions(resultCommand));
      const result = await readDevboxesSessionResult(context, agentSessionId);
      const status = sessionStatusJson(result);
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              ...status,
              finalOutput: result.finalOutput,
              finalOutputError: result.finalOutputError,
            },
            null,
            2,
          )}\n`,
        );
      } else {
        printSessionStatus(result);
        if (result.finalOutput) note(result.finalOutput, "Final output");
        if (result.finalOutputError)
          log.warn(`Final output unavailable: ${result.finalOutputError}`);
        if (!result.terminal) {
          log.warn(
            `The session is still ${status.runStatus ?? status.sessionStatus}; poll \`${cliCommandName} status ${agentSessionId}\` until it finishes.`,
          );
        }
      }
      // A not-yet-finished result must not read as success to chaining scripts.
      if (!result.terminal) process.exitCode = 1;
    });

  const mcpCommand = program.command("mcp");
  mcpCommand
    .description("serve dispatch/status/result as MCP tools over stdio")
    .action(async () => {
      const context = await loadContext(cliOptions(mcpCommand));
      // Deferred so dispatch/status/result never pay the MCP SDK import, and
      // so devboxes.ts and mcp.ts avoid a static import cycle.
      const { runDevboxesMcpServer } = await import("./mcp");
      await runDevboxesMcpServer(context);
    });

  return program;
};
