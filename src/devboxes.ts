import { chmod, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
// resolved through tsconfig "paths" there and fully erased at runtime
// (`import type`). The registry package contains no source; in the public
// source mirror this specifier stays unresolved on purpose.
import type { ApiType } from "#monorepo/api";

import packageJson from "../package.json";
import { writeSecretFile } from "./secret-file";

export type DevboxesCliOptions = {
  config?: string;
  api?: string;
  auth?: string;
  organization?: string;
  name?: string;
};

export type DevboxesConfig = {
  apiBaseUrl: string;
  authBaseUrl: string;
  telemetry?: {
    dsn: string;
    environment: string;
  };
  organizationId?: string;
  sessionToken?: string;
  machineId?: string;
  name?: string;
  apiKey?: string;
  opencodeProviderCredentials?: Array<{
    providerId: string;
    authFile: string;
    source: "opencode-auth-file" | "codex-auth-file";
    providerIdFormat?: "exact";
  }>;
};

export type DevboxesContext = {
  config: DevboxesConfig;
  configPath: string;
  // Unknown config.json keys from a newer binary, preserved on write.
  configExtras?: Record<string, unknown>;
};

const LocalCredentialReferenceSchema = Type.Object(
  {
    providerId: Type.String({ minLength: 1 }),
    authFile: Type.String({ minLength: 1 }),
    source: Type.Union([Type.Literal("opencode-auth-file"), Type.Literal("codex-auth-file")]),
    providerIdFormat: Type.Optional(Type.Literal("exact")),
  },
  { additionalProperties: false },
);

const ConfigFileSchema = Type.Object({
  apiBaseUrl: Type.Optional(Type.String({ minLength: 1 })),
  authBaseUrl: Type.Optional(Type.String({ minLength: 1 })),
  telemetry: Type.Optional(
    Type.Object(
      {
        dsn: Type.String(),
        environment: Type.String(),
      },
      { additionalProperties: false },
    ),
  ),
  organizationId: Type.Optional(Type.String({ minLength: 1 })),
  sessionToken: Type.Optional(Type.String({ minLength: 1 })),
  machineId: Type.Optional(Type.String({ format: "uuid" })),
  name: Type.Optional(Type.String({ minLength: 1 })),
  apiKey: Type.Optional(Type.String({ minLength: 1 })),
  opencodeProviderCredentials: Type.Optional(Type.Array(LocalCredentialReferenceSchema)),
});

type ConfigFile = Static<typeof ConfigFileSchema>;

const cliCommandName = "devboxes";
// The workspace package version is the single source of truth for the native
// build and staged npm wrapper.
export const cliVersion: string = packageJson.version;
export const cliUserAgent = `devboxes/${cliVersion} (${process.platform}/${process.arch})`;
// Must stay in the validateClient allowlist of the API's deviceAuthorization
// auth plugin. Public identifier, not a secret: it only names which client
// asked for the browser approval.
const cliDeviceClientId = "devboxes-cli";
const windowsApplicationDataHome = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");

export const platformConfigHome = () => {
  if (process.env.XDG_CONFIG_HOME) return process.env.XDG_CONFIG_HOME;
  if (process.platform === "win32") return windowsApplicationDataHome;
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  return join(homedir(), ".config");
};

export const platformDataHome = () => {
  if (process.env.XDG_DATA_HOME) return process.env.XDG_DATA_HOME;
  if (process.platform === "win32") return windowsApplicationDataHome;
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  return join(homedir(), ".local", "share");
};

const defaultConfigPath = () => join(platformConfigHome(), "devboxes", "config.json");

// The config can carry the terminal session and runner API key, so every write
// uses the same atomic fsync'd tmp+rename boundary and 0600 file mode.
const writeConfigFile = async (configPath: string, config: object) => {
  await writeSecretFile({
    path: configPath,
    contents: `${JSON.stringify(config, null, 2)}\n`,
    tmpPrefix: ".config.",
  });
  if (configPath === defaultConfigPath()) {
    await chmod(dirname(configPath), 0o700);
  }
};

const readConfigFile = async (configPath: string, customConfigPath: boolean) => {
  let fileConfig: ConfigFile = {};
  let rawConfigText: string | null = null;
  try {
    rawConfigText = await readFile(configPath, "utf8");
  } catch (error) {
    const missing =
      error && typeof error === "object" && "code" in error && error.code === "ENOENT";
    if (!missing) throw error;
  }
  if (rawConfigText !== null) {
    if (!customConfigPath) await chmod(dirname(configPath), 0o700);
    await chmod(configPath, 0o600);
    try {
      fileConfig = Value.Parse(ConfigFileSchema, JSON.parse(rawConfigText));
    } catch (error) {
      throw new Error(
        `Devboxes CLI config at ${configPath} is invalid: ${
          error instanceof Error ? error.message : String(error)
        }. Fix or delete the file, then run \`${cliCommandName} login\`.`,
      );
    }
  }
  return fileConfig;
};

export const writeConfig = async (context: DevboxesContext) =>
  writeConfigFile(context.configPath, { ...context.configExtras, ...context.config });

export const persistTelemetrySetting = async (
  options: Pick<DevboxesCliOptions, "config">,
  telemetry: DevboxesConfig["telemetry"],
) => {
  const configPath = options.config ?? defaultConfigPath();
  const fileConfig = await readConfigFile(configPath, options.config !== undefined);
  if (telemetry) {
    fileConfig.telemetry = telemetry;
    await writeConfigFile(configPath, fileConfig);
  } else if (fileConfig.telemetry) {
    delete fileConfig.telemetry;
    await writeConfigFile(configPath, fileConfig);
  }
  return configPath;
};

export const loadContext = async (options: DevboxesCliOptions): Promise<DevboxesContext> => {
  const configPath = options.config ?? defaultConfigPath();
  const fileConfig = await readConfigFile(configPath, options.config !== undefined);
  // Unknown keys written by a newer CLI round-trip through writeConfig.
  const knownConfigKeys = new Set(Object.keys(ConfigFileSchema.properties));
  const configExtras = Object.fromEntries(
    Object.entries(fileConfig).filter(([key]) => !knownConfigKeys.has(key)),
  );
  // Hosted Devboxes is the default. Local-development settings can override it.
  const configuredApiBaseUrl =
    options.api ??
    process.env.DEVBOX_API_BASE_URL ??
    fileConfig.apiBaseUrl ??
    "https://api.devboxes.ai/api";
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
      `Devboxes API base URL must be an absolute http(s) URL (e.g. https://api.devboxes.ai/api): ${configuredApiBaseUrl}`,
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
  // except loopback HTTP for local development.
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
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
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
      telemetry: fileConfig.telemetry,
      organizationId:
        options.organization ?? process.env.DEVBOX_ORGANIZATION_ID ?? fileConfig.organizationId,
      sessionToken: process.env.DEVBOX_CLI_SESSION_TOKEN ?? fileConfig.sessionToken,
      machineId: fileConfig.machineId,
      name:
        options.name ??
        process.env.DEVBOX_RUNNER_NAME ??
        fileConfig.name ??
        `docker-${process.platform}/${process.arch}`,
      apiKey: process.env.DEVBOX_RUNNER_API_KEY ?? fileConfig.apiKey,
      opencodeProviderCredentials: fileConfig.opencodeProviderCredentials,
    },
  };
};

// An abandoned browser approval must not hang the CLI forever.
const deviceFlowTimeoutMs = 5 * 60_000;

export class ApiRequestError extends Error {
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
export const apiRequestError = (
  operation: string,
  error: { status: unknown; value: unknown },
  reauthenticateWith: "login" | "connect" = "login",
) => {
  const value = error.value as { code?: unknown; error?: unknown } | null;
  const code =
    value && typeof value === "object" && typeof value.code === "string" ? value.code : null;
  const detail =
    value && typeof value === "object" && typeof value.error === "string"
      ? value.error
      : "The API answered without an error description.";
  const status = typeof error.status === "number" ? error.status : 0;
  const hint =
    status === 401 ? ` Run \`${cliCommandName} ${reauthenticateWith}\` and try again.` : "";
  return new ApiRequestError(
    `${operation} failed with HTTP ${String(error.status)}: ${detail}${hint}`,
    status,
    code,
  );
};

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

// One bearer-authorized Eden client policy for every API call the CLI makes.
// loadContext guarantees the base URL ends in /api; Eden's typed routes re-add
// that segment (backend.api...), so the treaty origin is the URL without it.
export const bearerBackend = (apiBaseUrl: string, sessionToken: string) =>
  treaty<ApiType>(apiBaseUrl.replace(/\/api$/, ""), {
    onRequest(_path, requestOptions) {
      const headers = new Headers(requestOptions.headers);
      headers.set("Authorization", `Bearer ${sessionToken}`);
      headers.set("User-Agent", cliUserAgent);
      return { ...requestOptions, headers };
    },
  });

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
    sessionToken,
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
      "This account has no active organization. Finish onboarding in the Devboxes dashboard, then log in again.",
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
  const scpLike = trimmed.includes("://") ? null : /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed);
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
  blueprintVersionId?: string;
  // Directory whose git origin remote may infer the project when neither
  // --project, --repo, nor an issue reference selects one. Defaults to the
  // process working directory.
  cwd?: string;
};

export const dispatchDevboxesTask = async (context: DevboxesContext, input: DispatchInput) => {
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
  const model = input.model?.trim();
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
    ...(model ? { model } : {}),
    ...(input.title?.trim() ? { title: input.title.trim() } : {}),
    ...(input.blueprintVersionId?.trim()
      ? { blueprintVersionId: input.blueprintVersionId.trim() }
      : {}),
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

  // The Run is the product truth for status, outcome, PR link, and usage. A
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

// A stalled read must not hang `result` forever; the read leg gets the same
// ceiling as the login flow's browser-approval poll.
const finalOutputReadTimeoutMs = 5 * 60_000;

// Reads generated stable events and extracts the latest assistant turn. A
// Session that never reached OpenCode has no output yet.
const readFinalAssistantMessage = async (context: DevboxesContext, agentSessionId: string) => {
  const { backend, organizationId } = connectedBackend(context);
  const readDeadline = AbortSignal.timeout(finalOutputReadTimeoutMs);
  const response = await backend.api
    .org({ organizationId })
    ["agent-sessions"]({ agentSessionId })
    .opencode.events.get({ fetch: { signal: readDeadline } })
    .catch((error: unknown) => {
      // AbortSignal.timeout surfaces as an opaque TimeoutError; name the deadline.
      if (readDeadline.aborted) {
        throw new Error(
          `OpenCode event read timed out after ${finalOutputReadTimeoutMs / 60_000} minutes without a response.`,
        );
      }
      throw error;
    });
  if (response.error) throw apiRequestError("OpenCode stable event read", response.error);

  const events = response.data ?? [];
  let assistantMessageId: string | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "session.next.step.started") {
      assistantMessageId = event.data.assistantMessageID;
      break;
    }
  }
  if (!assistantMessageId) return null;
  const texts: string[] = [];
  for (const event of events) {
    if (
      event.type === "session.next.text.ended" &&
      event.data.assistantMessageID === assistantMessageId
    ) {
      texts.push(event.data.text);
    }
  }
  return texts.join("\n\n").trim() || null;
};

export const readDevboxesSessionResult = async (
  context: DevboxesContext,
  agentSessionId: string,
) => {
  const { session, currentTask, run } = await readDevboxesSession(context, agentSessionId);
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
    currentTask,
    run,
    terminal: sessionReachedTerminalState({ run }),
    finalOutput,
    finalOutputError,
  };
};

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
  pullRequestUrl: input.run.pullRequestUrl,
  errorMessage: input.run.errorMessage ?? input.currentTask.errorMessage ?? null,
  queuedAt: input.run.queuedAt,
  startedAt: input.run.startedAt,
  completedAt: input.run.completedAt,
  usage: input.run.usage,
});

const printSessionStatus = (input: Awaited<ReturnType<typeof readDevboxesSession>>) => {
  const status = sessionStatusJson(input);
  note(
    [
      `Session: ${status.agentSessionId} (${status.sessionStatus})`,
      `Run: ${status.runId} (${status.runStatus})`,
      ...(status.currentStep ? [`Step: ${status.currentStep}`] : []),
      `Repository: ${status.repository} → ${status.branch}`,
      `Model: ${status.model}`,
      ...(status.pullRequestUrl ? [`Pull request: ${status.pullRequestUrl}`] : []),
      ...(status.errorMessage ? [`Error: ${status.errorMessage}`] : []),
    ].join("\n"),
    "Devboxes session",
  );
};

export const addAccountCommands = (program: Command) => {
  const cliOptions = (command: Command): DevboxesCliOptions =>
    command.optsWithGlobals<DevboxesCliOptions>();

  const loginCommand = program.command("login");
  loginCommand
    .description("sign this terminal in to Devboxes via browser approval")
    .action(async () => {
      const context = await loadContext(cliOptions(loginCommand));
      const connected = await loginDevboxes(context);
      log.success(
        `Signed in as ${connected.user.email} to organization ${connected.organization.name}. Credentials saved at ${context.configPath}.`,
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
    .option("--model <provider/model>", "model id (uses the server default when omitted)")
    .option("--branch <branch>", "base branch and PR destination", "main")
    .option("--title <title>", "run title")
    .option(
      "--blueprint-version <id>",
      "Blueprint Version id (defaults to the current Implement GitHub Issue version)",
    )
    .option("--json", "print the dispatch result as JSON on stdout", false)
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
            `The Run is still ${status.runStatus}; poll \`${cliCommandName} status ${agentSessionId}\` until it finishes.`,
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
};
