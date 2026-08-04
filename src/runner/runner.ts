import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import * as prompts from "@clack/prompts";
import { intro, isCancel, log, note, outro, password, select, spinner, text } from "@clack/prompts";
import { Command, InvalidArgumentError } from "commander";
import Docker from "dockerode";
import Type from "typebox";
import Value from "typebox/value";

import {
  ApiRequestError,
  apiRequestError,
  bearerBackend,
  cliVersion,
  deviceSessionToken,
  loadContext,
  openBrowser,
  platformConfigHome,
  platformDataHome,
  writeConfig,
  type DevboxesCliOptions,
  type DevboxesContext,
} from "../devboxes";
import {
  listenerRegistrationDeviceClientId,
  listenerUpgradeRequiredCode,
} from "../protocol/frozen";
import {
  OpencodeLaunchSpecSchema,
  opencodeUsageAuthorityLaunchProtocol,
} from "../protocol/launch-spec";
import {
  normalizeOpencodeProviderId,
  opencodeProviderAuthFingerprint,
  type OpencodeProviderAuthJson,
} from "../protocol/provider-auth";
import { taskContainerName } from "../protocol/task-runtime";
import {
  OpencodeConnectorDescriptorSchema,
  type OpencodeConnectorDescriptor,
} from "../provider-connect/descriptor-schema";
import {
  pollOpencodeOauthDeviceFlow,
  startOpencodeOauthDeviceFlow,
} from "../provider-connect/flows";
import {
  createOpencodeCredentialBroker,
  type ActiveOpencodeCredentialTask,
} from "./credential-broker";
import {
  ambiguousOpencodeCredentialMessage,
  CredentialStoreUnreadableError,
  credentialStoreExists,
  readCredentialStore,
  writeCredentialStore,
  type LocalCredentialStore,
} from "./credential-store";
import { dockerSocketPath } from "./docker-socket";
import { playIntro } from "./intro";
import {
  LocalRunnerOpencodeProviderAuthRuntime,
  type LocalCredentialStoreAccess,
  type LocalOpencodeProviderCredentialReference,
} from "./local-provider-auth";

type RunnerCliOptions = DevboxesCliOptions & {
  provider?: string;
  connect?: string;
  apiKey?: string;
  all: boolean;
  json?: boolean;
  live?: boolean;
  maxConcurrent?: number;
};

type ActiveTask = {
  taskId: string;
  organizationId: string;
  modelProviderId: string;
  perTaskToken: string;
  containerId: string | null;
  containerName: string | null;
  attemptCount: number;
  providerAuth?: OpencodeProviderAuthJson;
};

const OpencodeAuthFileSchema = Type.Record(
  Type.String({ minLength: 1 }),
  Type.Object({ type: Type.String({ minLength: 1 }) }, { additionalProperties: true }),
);

// ChatGPT-subscription codex logins carry a literal null API key next to their
// OAuth tokens, so the field must tolerate null for the file to parse at all.
const CodexAuthCacheSchema = Type.Object(
  {
    OPENAI_API_KEY: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    tokens: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);

const runnerVersion = cliVersion;
const runnerRuntime = "docker";
const runnerNativePlatform = `${process.platform}/${process.arch}`;
const runnerSupportedPlatforms = [process.arch === "arm64" ? "linux/arm64" : "linux/amd64"];

// A container-reconciliation report (dead or missing container) races the
// server-side transition that already moved the task off this machine's running
// claim: the in-container daemon reported a terminal status, the reaper requeued
// it, or another machine re-adopted it. The report route answers those with
// these 409 codes, and this machine did own the task — so the refusal is
// expected reconciliation to log at info level, not a fault. Any other failure
// (network, 5xx, an unrecognized code) still reads as a real problem.
const reportRaceIsBenign = (error: ApiRequestError) =>
  error.status === 409 &&
  (error.code === "task_not_running" || error.code === "task_other_machine");

const localApiHostnames = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const taskContainerApiBaseUrl = (apiBaseUrl: string) => {
  const url = new URL(apiBaseUrl);
  if (localApiHostnames.has(url.hostname)) url.hostname = "host.docker.internal";
  return url.toString().replace(/\/+$/, "");
};

const runnerDeviceSessionToken = (context: DevboxesContext, purpose: string) =>
  deviceSessionToken(context.config, {
    clientId: listenerRegistrationDeviceClientId,
    scope: "runner",
    purpose,
  });

const registerMachine = async (
  context: DevboxesContext,
  credential: string,
  organizationId: string | undefined,
) => {
  const backend = bearerBackend(context.config.apiBaseUrl, credential);
  const result = await backend.api.internal["runner-machines"].register.post({
    ...(organizationId ? { organizationId } : {}),
    ...(context.config.machineId ? { machineId: context.config.machineId } : {}),
    name: context.config.name ?? `${runnerRuntime}-${runnerNativePlatform}`,
    runtime: runnerRuntime,
    nativePlatform: runnerNativePlatform,
    supportedPlatforms: runnerSupportedPlatforms,
    listenerVersion: runnerVersion,
  });
  if (result.error) {
    throw apiRequestError("Runner registration", result.error, "connect");
  }
  const registered = result.data;
  if (!registered?.machine) {
    throw new Error("Runner registration returned no machine.");
  }
  const registeredMachine = registered.machine;
  context.config.organizationId = registeredMachine.organizationId;
  context.config.machineId = registeredMachine.id;
  if (registered.apiKey) context.config.apiKey = registered.apiKey;
  await writeConfig(context);
  return { ...registered, machine: registeredMachine };
};

const machineApiBackend = (context: DevboxesContext) => {
  const apiKey = context.config.apiKey;
  if (!apiKey) {
    throw new Error("This command requires a registered runner. Run `devboxes connect` first.");
  }
  return bearerBackend(context.config.apiBaseUrl, apiKey);
};

// The store passphrase lives server-side and is fetched per invocation — held
// in memory only, so the on-device ciphertext never sits next to its key and
// deleting the machine prevents future passphrase retrieval.
const credentialStoreAccess = async (
  context: DevboxesContext,
): Promise<LocalCredentialStoreAccess> => {
  const result =
    await machineApiBackend(context).api.internal["runner-machines"][
      "credential-store-passphrase"
    ].get();
  if (result.error) throw apiRequestError("Credential store passphrase", result.error, "connect");
  if (!result.data) throw new Error("Credential store passphrase was not returned.");
  return { configPath: context.configPath, passphrase: result.data.passphrase };
};

// One policy for every command that reads the store: skip the dashboard
// passphrase round trip entirely when no store file exists on disk.
const openCredentialStoreIfPresent = async (
  context: DevboxesContext,
  discardAmbiguousOpencode = false,
) => {
  if (!(await credentialStoreExists(context.configPath))) return undefined;
  const access = await credentialStoreAccess(context);
  return {
    access,
    store: await readCredentialStore({ ...access, discardAmbiguousOpencode }),
  };
};

const listOrgOpencodeProviderCredentials = async (context: DevboxesContext) => {
  const result =
    await machineApiBackend(context).api.internal["runner-machines"]["org-credentials"].get();
  if (result.error) throw apiRequestError("Organization credentials", result.error, "connect");
  return {
    opencodeProviderCredentials: result.data?.opencodeProviderCredentials ?? [],
    queuedProviderIds: result.data?.queuedProviderIds ?? [],
  };
};

type DiscoveredOpencodeProviderCredential = LocalOpencodeProviderCredentialReference & {
  authType: string;
};

type LocalCredentialFileCandidate = {
  authFile: string;
  source: LocalOpencodeProviderCredentialReference["source"];
  configured: boolean;
};

const localCredentialFileCandidates = (context: DevboxesContext) => {
  const credentialFileCandidates: LocalCredentialFileCandidate[] = [
    {
      authFile: join(platformDataHome(), "opencode", "auth.json"),
      source: "opencode-auth-file" as const,
      configured: false,
    },
    ...(process.platform === "darwin"
      ? [
          {
            authFile: join(
              process.env.HOME ?? homedir(),
              ".local",
              "share",
              "opencode",
              "auth.json",
            ),
            source: "opencode-auth-file" as const,
            configured: false,
          },
        ]
      : []),
    {
      authFile: join(platformConfigHome(), "opencode", "auth.json"),
      source: "opencode-auth-file" as const,
      configured: false,
    },
    {
      authFile: join(homedir(), "Library", "Application Support", "opencode", "auth.json"),
      source: "opencode-auth-file" as const,
      configured: false,
    },
    {
      authFile: join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
      source: "codex-auth-file" as const,
      configured: false,
    },
    ...(context.config.opencodeProviderCredentials ?? []).map((entry) => ({
      authFile: entry.authFile,
      source: entry.source,
      configured: true,
    })),
  ];

  const authFiles: Array<(typeof credentialFileCandidates)[number]> = [];
  const seenAuthFiles = new Set<string>();
  for (const credentialFile of credentialFileCandidates) {
    if (seenAuthFiles.has(credentialFile.authFile)) continue;
    seenAuthFiles.add(credentialFile.authFile);
    authFiles.push(credentialFile);
  }
  return authFiles;
};

const discoveredCredentialsFromFile = async (
  credentialFile: ReturnType<typeof localCredentialFileCandidates>[number],
  seenProviderIds: Set<string>,
) => {
  const { authFile, source } = credentialFile;
  if (source === "codex-auth-file") {
    const parsed = Value.Parse(CodexAuthCacheSchema, JSON.parse(await readFile(authFile, "utf8")));
    const apiKey = parsed.OPENAI_API_KEY;
    if (typeof apiKey !== "string" || !apiKey.trim() || seenProviderIds.has("openai")) return [];
    seenProviderIds.add("openai");
    return [{ providerId: "openai", authFile, source, authType: "api" }];
  }

  const parsed = Value.Parse(OpencodeAuthFileSchema, JSON.parse(await readFile(authFile, "utf8")));
  const credentials: DiscoveredOpencodeProviderCredential[] = [];
  for (const [providerId, auth] of Object.entries(parsed)) {
    if (seenProviderIds.has(providerId)) continue;
    seenProviderIds.add(providerId);
    credentials.push({
      providerId,
      authFile,
      source,
      authType: auth.type,
    });
  }
  return credentials;
};

const discoverLocalOpencodeProviderCredentials = async (context: DevboxesContext) => {
  const discovered: Array<LocalOpencodeProviderCredentialReference & { authType: string }> = [];
  const seenProviderIds = new Set<string>();
  for (const credentialFile of localCredentialFileCandidates(context)) {
    try {
      discovered.push(...(await discoveredCredentialsFromFile(credentialFile, seenProviderIds)));
    } catch (error) {
      const missing =
        error && typeof error === "object" && "code" in error && error.code === "ENOENT";
      if (missing && !credentialFile.configured) continue;
      log.warn(
        `Skipped ${credentialFile.source} at ${credentialFile.authFile}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return discovered;
};

const saveCredentialFileReferences = async (
  context: DevboxesContext,
  selected: DiscoveredOpencodeProviderCredential[],
) => {
  const selectedProviderIds = new Set(selected.map((entry) => entry.providerId));
  const replacesAmbiguousOpencode =
    selectedProviderIds.has("opencode") || selectedProviderIds.has("opencode-go");
  context.config.opencodeProviderCredentials = [
    ...(context.config.opencodeProviderCredentials ?? []).filter(
      (entry) =>
        !selectedProviderIds.has(entry.providerId) &&
        (!replacesAmbiguousOpencode ||
          entry.providerId !== "opencode" ||
          entry.providerIdFormat === "exact"),
    ),
    ...selected.map((entry) => ({
      providerId: entry.providerId,
      authFile: entry.authFile,
      source: entry.source,
      ...(entry.providerId === "opencode" ? { providerIdFormat: "exact" as const } : {}),
    })),
  ];
  await writeConfig(context);
  log.success(
    `Saved local Opencode provider credential references for ${[...selectedProviderIds].join(", ")}.`,
  );
};

// Store writers self-heal an unreadable store: its entries are
// cryptographically dead once the passphrase rotated (machine deleted or
// re-registered), so the next connect or API-key entry rewrites the file
// fresh instead of dead-ending the setup.
const readCredentialStoreForRewrite = async (
  storeAccess: LocalCredentialStoreAccess,
  discardAmbiguousOpencode = false,
) => {
  try {
    return await readCredentialStore({ ...storeAccess, discardAmbiguousOpencode });
  } catch (error) {
    if (!(error instanceof CredentialStoreUnreadableError)) throw error;
    log.warn(`${error.message} Storing a credential now recreates the store.`);
    return { entries: {} } satisfies LocalCredentialStore;
  }
};

// A ChatGPT-subscription codex login holds OAuth tokens instead of an API key.
// Those tokens belong to the codex CLI and are never imported — importing a
// rotating refresh token would race codex for the same token family — so setup
// points at the subscription connect instead.
const codexChatgptSubscriptionDetected = async () => {
  const codexAuthFile = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
  try {
    const parsed = Value.Parse(
      CodexAuthCacheSchema,
      JSON.parse(await readFile(codexAuthFile, "utf8")),
    );
    const apiKey = parsed.OPENAI_API_KEY;
    return (typeof apiKey !== "string" || !apiKey.trim()) && parsed.tokens !== undefined;
  } catch {
    return false;
  }
};

// Connector descriptors — vendor endpoints, public client ids, scopes — are
// served per use and never compiled in or cached: a vendor moving an endpoint
// must not rot shipped binaries, and a boot-time snapshot would just recreate
// the staleness. Entries whose flow kind this build does not know are skipped
// with an upgrade pointer, so new providers with an existing shape need no
// binary release at all.
const fetchOpencodeConnectors = async (context: DevboxesContext) => {
  const result = await machineApiBackend(context).api.internal["runner-machines"].connectors.get();
  if (result.error) throw apiRequestError("Connector catalog", result.error, "connect");
  const connectors: OpencodeConnectorDescriptor[] = [];
  const unknownProviderIds: string[] = [];
  // Eden types are compile-time only; served entries from a newer dashboard
  // are unknown data at this decode boundary, validated element-wise.
  const served: readonly unknown[] = result.data?.connectors ?? [];
  for (const entry of served) {
    if (Value.Check(OpencodeConnectorDescriptorSchema, entry)) {
      connectors.push(entry);
    } else if (entry && typeof entry === "object" && "providerId" in entry) {
      unknownProviderIds.push(String(entry.providerId));
    }
  }
  if (unknownProviderIds.length > 0) {
    log.warn(
      `This Devboxes version cannot connect ${unknownProviderIds.join(", ")}; install the latest Devboxes CLI to add support.`,
    );
  }
  return connectors;
};

// The vendor device flow runs in this process — the same wire mechanics the
// dashboard runs server-side for organization connects — and the resulting
// token family lands only in the on-device encrypted store.
export const connectOpencodeProviderSubscription = async (
  context: DevboxesContext,
  providerId: string | undefined,
) => {
  const requestedProviderId = providerId?.trim().toLowerCase();
  if (requestedProviderId === "opencode" || requestedProviderId === "opencode-go") {
    await storeManualApiKey(context, requestedProviderId);
    return requestedProviderId;
  }
  const connectors = await fetchOpencodeConnectors(context);
  const connector = connectors.find((candidate) => candidate.providerId === requestedProviderId);
  if (!connector) {
    const available = connectors.map((candidate) => candidate.providerId).join(", ");
    throw new Error(`Choose an OAuth provider to connect. Available: ${available}.`);
  }
  // Resolve store access before the vendor flow so a missing registration
  // fails before the user approves anything in a browser.
  const storeAccess = await credentialStoreAccess(context);

  const started = await startOpencodeOauthDeviceFlow(connector);
  // The code and URL print plainly so they stay copyable from any terminal.
  console.info(`Approve the ${connector.label} connection with code ${started.userCode}.`);
  console.info(started.verificationUrl);
  await openBrowser(started.verificationUrl);

  // Spinner only on interactive terminals; scripted runs keep silent polling.
  // onCancel: clack's spinner owns SIGINT while it runs; the first Ctrl-C must
  // abort the flow, not just repaint, or an approval that lands afterwards
  // would still write the token family into the store.
  const approval = process.stdout.isTTY
    ? spinner({ onCancel: () => process.exit(130) })
    : undefined;
  approval?.start(`Waiting for browser approval (code ${started.userCode})`);
  try {
    let intervalSeconds = started.intervalSeconds;
    // Thrown polls are transient vendor hiccups; keep polling until shortly
    // past the vendor deadline, matching the dashboard connect flow's
    // tolerance.
    const deadlineMs = started.expiresAtMs + 60 * 1000;
    for (;;) {
      if (Date.now() > deadlineMs) {
        throw new Error(`${connector.label} device authorization expired before it was approved.`);
      }
      await sleep(intervalSeconds * 1000);
      let result: Awaited<ReturnType<typeof pollOpencodeOauthDeviceFlow>>;
      try {
        result = await pollOpencodeOauthDeviceFlow(connector, started.payload);
      } catch {
        continue;
      }
      if (result.status === "pending") {
        intervalSeconds = result.intervalSeconds;
        continue;
      }
      if (result.status === "failed") throw new Error(result.error);

      const store = await readCredentialStoreForRewrite(storeAccess);
      store.entries[connector.providerId] = {
        auth: result.auth,
        ...(result.accountLabel ? { accountLabel: result.accountLabel } : {}),
      };
      await writeCredentialStore({ ...storeAccess, store });
      approval?.stop(`${connector.label} approved.`);
      log.success(
        `Connected ${connector.label}${
          result.accountLabel ? ` (${result.accountLabel})` : ""
        }. The credential is stored encrypted on this device.`,
      );
      log.info(
        "Restart `devboxes listen` to serve it to local runs. Run `devboxes credentials sync` to share it with the organization for cloud runs.",
      );
      return connector.providerId;
    }
  } catch (error) {
    approval?.error(`${connector.label} connection failed.`);
    throw error;
  }
};

// Interactive: prompts for provider and key. Headless (`setup --api-key
// <provider>` piped): the key arrives on stdin — never argv, where it would
// be visible in the process list.
const storeManualApiKey = async (context: DevboxesContext, providerIdFlag?: string) => {
  let providerId: string;
  if (providerIdFlag) {
    providerId = normalizeOpencodeProviderId(providerIdFlag);
  } else {
    const providerIdAnswer = await text({
      message: "Provider id",
      placeholder: "anthropic",
      validate(value) {
        try {
          normalizeOpencodeProviderId(value ?? "");
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    });
    // A cancelled prompt is not success: scripts chaining on setup must see it.
    if (isCancel(providerIdAnswer)) process.exit(130);
    providerId = normalizeOpencodeProviderId(providerIdAnswer);
  }

  let key: string;
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const answer = await password({
      message: `API key for ${providerId}`,
      validate: (value) => (value?.trim() ? undefined : "API key must not be empty."),
    });
    if (isCancel(answer)) process.exit(130);
    key = answer;
  } else {
    key = (await Bun.stdin.text()).trim();
    if (!key) {
      throw new Error(
        `Provide the ${providerId} API key on stdin, e.g. \`devboxes credentials setup --api-key ${providerId} < key.txt\`.`,
      );
    }
  }

  const storeAccess = await credentialStoreAccess(context);
  const replacesAmbiguousOpencode = providerId === "opencode" || providerId === "opencode-go";
  const store = await readCredentialStoreForRewrite(storeAccess, replacesAmbiguousOpencode);
  store.entries[providerId] = {
    auth: { type: "api", key: key.trim() },
  };
  await writeCredentialStore({ ...storeAccess, store });
  if (replacesAmbiguousOpencode) {
    const references = context.config.opencodeProviderCredentials ?? [];
    context.config.opencodeProviderCredentials = references.filter(
      (reference) => reference.providerId !== "opencode" || reference.providerIdFormat === "exact",
    );
    if (context.config.opencodeProviderCredentials.length !== references.length) {
      await writeConfig(context);
    }
  }
  log.success(`Stored the ${providerId} API key encrypted on this device.`);
  log.info(
    "Restart `devboxes listen` to serve it to local runs. Run `devboxes credentials sync` to share it with the organization.",
  );
};

const interactiveCredentialSetup = async (
  context: DevboxesContext,
  discovered: DiscoveredOpencodeProviderCredential[],
) => {
  // The intro animation plays while the dashboard round trips below run, so
  // neither latency is paid twice.
  const introPlayed = playIntro();
  // Store and organization state ride the machine key; without a registration
  // (or with the dashboard unreachable) setup degrades to file references.
  let storeAccess: LocalCredentialStoreAccess | undefined;
  let orgCredentials: Awaited<
    ReturnType<typeof listOrgOpencodeProviderCredentials>
  >["opencodeProviderCredentials"] = [];
  let queuedProviderIds: string[] = [];
  let connectors: OpencodeConnectorDescriptor[] = [];
  let dashboardNote = context.config.apiKey
    ? undefined
    : "Run `devboxes connect` to enable subscription connects, device-stored API keys, and organization sync.";
  let store: LocalCredentialStore = { entries: {} };
  let storeWarning: string | undefined;
  if (context.config.apiKey) {
    try {
      storeAccess = await credentialStoreAccess(context);
      ({ opencodeProviderCredentials: orgCredentials, queuedProviderIds } =
        await listOrgOpencodeProviderCredentials(context));
      connectors = await fetchOpencodeConnectors(context);
    } catch (error) {
      storeAccess = undefined;
      dashboardNote = `Devboxes is unreachable (${
        error instanceof Error ? error.message : String(error)
      }); subscription connect and sync are unavailable right now.`;
    }
  }
  if (storeAccess) {
    try {
      store = await readCredentialStore(storeAccess);
    } catch (error) {
      if (!(error instanceof CredentialStoreUnreadableError)) throw error;
      // Rotated passphrase: the entries are unrecoverable, but connect and
      // API-key entry rewrite the store fresh, so setup stays the repair path.
      storeWarning = `${error.message} Connecting a provider below recreates the store.`;
    }
  }
  const codexSubscription = await codexChatgptSubscriptionDetected();
  const saved: DiscoveredOpencodeProviderCredential[] = [];

  await introPlayed;
  intro("Provider credentials");
  const references = context.config.opencodeProviderCredentials ?? [];

  if (context.config.apiKey && !dashboardNote) {
    note(
      orgCredentials.length
        ? orgCredentials
            .map(
              (credential) =>
                `${credential.providerId}: ${credential.label}${
                  credential.accountLabel ? ` (${credential.accountLabel})` : ""
                } [${credential.authType}]`,
            )
            .join("\n")
        : "none configured",
      "Organization credentials",
    );
  }
  const hasLocalCredentials = Object.keys(store.entries).length > 0 || references.length > 0;
  note(
    hasLocalCredentials
      ? [
          ...Object.entries(store.entries).map(
            ([providerId, entry]) =>
              `${providerId}: ${entry.auth.type === "oauth" ? "subscription" : "API key"}${
                entry.accountLabel ? ` (${entry.accountLabel})` : ""
              } [encrypted store]`,
          ),
          ...references.map(
            (reference) => `${reference.providerId}: ${reference.source} reference`,
          ),
        ].join("\n")
      : "no local credentials configured",
    "This device",
  );
  if (dashboardNote) log.warn(dashboardNote);
  if (storeWarning) log.warn(storeWarning);
  // Need-driven setup: name the providers queued runs are actually waiting
  // for, so the operator configures what unblocks work instead of guessing
  // from the full connector list.
  const servedProviderIds = new Set([
    ...Object.keys(store.entries),
    ...references.map((reference) => reference.providerId),
    ...orgCredentials.map((credential) => credential.providerId),
  ]);
  const neededProviderIds = new Set(
    queuedProviderIds.filter((providerId) => !servedProviderIds.has(providerId)),
  );
  if (neededProviderIds.size > 0) {
    log.warn(
      `Queued runs are waiting for a provider nobody serves yet: ${[...neededProviderIds].join(", ")}.`,
    );
  }
  if (codexSubscription && !store.entries["openai"]) {
    log.info(
      "codex is signed in with a ChatGPT subscription; its tokens stay with codex — connect ChatGPT Pro/Plus below to use the subscription here.",
    );
  }

  const unsavedDiscovered = discovered.filter(
    (entry) => !references.some((reference) => reference.providerId === entry.providerId),
  );
  const actions: Array<{ label: string; hint?: string; run: () => Promise<unknown> }> = [
    ...(storeAccess
      ? connectors.map((connector) => ({
          label: `Connect ${connector.label}`,
          hint: neededProviderIds.has(connector.providerId)
            ? "queued runs are waiting for this provider"
            : "subscription stored on this device",
          run: () => connectOpencodeProviderSubscription(context, connector.providerId),
        }))
      : []),
    ...(storeAccess
      ? [
          {
            label: "Enter an API key",
            hint: "stored encrypted on this device",
            run: () => storeManualApiKey(context),
          },
        ]
      : []),
    ...unsavedDiscovered.map((entry) => ({
      label: `Save ${entry.providerId} reference`,
      hint: `${entry.authType} from ${entry.source}`,
      run: async () => {
        await saveCredentialFileReferences(context, [entry]);
        saved.push(entry);
      },
    })),
    ...(storeAccess && hasLocalCredentials
      ? [
          {
            label: "Sync local credentials to the organization",
            hint: "asks for a browser approval",
            run: () => syncOpencodeProviderCredentials(context, {}),
          },
        ]
      : []),
  ];
  if (actions.length === 0) {
    outro(
      "Nothing to configure yet. Sign in to a local coding agent or run `devboxes connect`, then re-run `devboxes credentials setup`.",
    );
    return saved;
  }

  // One action per invocation: pick, run, done — re-run setup for the next
  // change instead of looping back to the menu.
  const choice = await select({
    message: "What would you like to do?",
    options: [
      ...actions.map((action, index) => ({
        value: index,
        label: action.label,
        ...(action.hint ? { hint: action.hint } : {}),
      })),
      { value: -1, label: "Nothing right now" },
    ],
  });
  // Ctrl-C is not the same as choosing "Nothing right now": a cancelled
  // prompt must not read as success to a chaining script.
  if (isCancel(choice)) process.exit(130);
  if (choice === -1) {
    outro("Nothing changed.");
    return saved;
  }
  try {
    await actions[choice]?.run();
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    outro("The selected action failed; re-run `devboxes credentials setup` to try again.");
    return saved;
  }
  outro("Restart `devboxes listen` to advertise newly configured providers.");
  return saved;
};

export const setupOpencodeProviderCredentials = async (
  context: DevboxesContext,
  options: Pick<RunnerCliOptions, "all" | "provider" | "connect" | "apiKey">,
) => {
  if (options.connect) {
    await connectOpencodeProviderSubscription(context, options.connect);
    return [];
  }
  if (options.apiKey) {
    await storeManualApiKey(context, options.apiKey);
    return [];
  }

  const discovered = await discoverLocalOpencodeProviderCredentials(context);

  if (options.provider || options.all) {
    const requestedProviders = new Set(
      (options.provider ?? "")
        .split(",")
        .map((providerId) => providerId.trim())
        .filter(Boolean),
    );
    const selected = options.all
      ? discovered
      : discovered.filter((entry) => requestedProviders.has(entry.providerId));
    if (selected.length === 0) {
      // An explicitly requested provider that matches nothing is an error; a
      // bare `--all` sweep finding nothing stays a warning.
      if (options.provider) {
        throw new Error("No local provider credential files match --provider.");
      }
      log.warn("No local provider credential files were found.");
      return [];
    }
    await saveCredentialFileReferences(context, selected);
    log.info(
      "Run `devboxes credentials sync` to copy API-key credentials to encrypted organization storage.",
    );
    return selected;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (discovered.length === 1) {
      await saveCredentialFileReferences(context, discovered);
      return discovered;
    }
    log.warn(
      discovered.length === 0
        ? "No supported local provider credential files were found."
        : "Multiple local provider credentials were found.",
    );
    log.info(
      "Re-run `devboxes credentials setup --provider <provider>` or `--all` to save file references, or `devboxes credentials setup --connect <provider>` to connect a subscription.",
    );
    return [];
  }

  return interactiveCredentialSetup(context, discovered);
};

export const syncOpencodeProviderCredentials = async (
  context: DevboxesContext,
  options: Pick<RunnerCliOptions, "provider">,
) => {
  if (!context.config.organizationId) {
    throw new Error("Credential sync requires a registered runner organization.");
  }
  if (!context.config.machineId) {
    throw new Error("Credential sync requires a registered Runner machine.");
  }

  const references = context.config.opencodeProviderCredentials ?? [];
  const store = (await openCredentialStoreIfPresent(context))?.store ?? {
    entries: {},
  };

  let providerIds = [
    ...new Set([
      ...Object.keys(store.entries),
      ...references.map((reference) => reference.providerId),
    ]),
  ];
  if (providerIds.length === 0) {
    // An error, not a warning: a provisioning script that syncs nothing must
    // not report success.
    throw new Error(
      "No local Opencode provider credentials are configured. Run `devboxes credentials setup` before syncing credentials.",
    );
  }
  if (options.provider) {
    const requestedProviders = new Set(
      options.provider
        .split(",")
        .map((providerId) => providerId.trim())
        .filter(Boolean),
    );
    providerIds = providerIds.filter((providerId) => requestedProviders.has(providerId));
    if (providerIds.length === 0) {
      throw new Error("No configured local Opencode provider credentials match --provider.");
    }
  }

  // Resolve every credential before the browser approval: a run that would
  // sync nothing must fail here, not after a pointless human approval.
  const runtime = new LocalRunnerOpencodeProviderAuthRuntime(references);
  // The connect pointer in skip messages comes from the served catalog; an
  // unregistered, references-only sync degrades to the plain skip message.
  let connectableProviderIds = new Set<string>();
  if (context.config.apiKey) {
    try {
      connectableProviderIds = new Set(
        (await fetchOpencodeConnectors(context)).map((connector) => connector.providerId),
      );
    } catch {
      // Hint-only data; the sync decides its own failures.
    }
  }
  const syncable: Array<{
    providerId: string;
    auth: (typeof store.entries)[string]["auth"];
    accountLabel?: string;
  }> = [];
  for (const providerId of providerIds) {
    const storeEntry = store.entries[providerId];
    if (storeEntry) {
      // Device-store entries are runner-owned token families, so OAuth syncs
      // too. After a sync the dashboard and this runner refresh the same
      // family in parallel; a definitive vendor rejection surfaces on the org
      // credential row as a reconnect prompt.
      syncable.push({
        providerId,
        auth: storeEntry.auth,
        ...(storeEntry.accountLabel ? { accountLabel: storeEntry.accountLabel } : {}),
      });
      continue;
    }
    const providerAuth = await runtime.providerAuthForProvider({ providerId });
    const fileAuth = providerAuth[providerId]!;
    if (fileAuth.type !== "api") {
      // OAuth logins in a foreign CLI's auth file are broker-served, never
      // synced — copying another tool's rotating refresh token org-wide
      // would break that login. A mixed auth file must not hard-fail the
      // API-key sync next to it.
      const connectable = connectableProviderIds.has(providerId);
      log.warn(
        `Skipped ${providerId}: only API-key credentials sync from CLI auth files.${
          connectable
            ? ` Use \`devboxes credentials setup --connect ${providerId}\` to connect the subscription on this device, then sync.`
            : ""
        }`,
      );
      continue;
    }
    syncable.push({ providerId, auth: fileAuth });
  }
  if (syncable.length === 0) {
    throw new Error(
      "Nothing to sync: every requested credential was skipped. Connect the subscription on this device with `devboxes credentials setup --connect <provider>`, then sync again.",
    );
  }

  log.step(
    "Sync copies local Opencode credentials — connected subscriptions included — to encrypted Devboxes organization storage.",
  );
  // Credential sync always requires a fresh runner-scoped approval. A saved
  // terminal session is deliberately not reused for exporting local secrets.
  const sessionToken = await runnerDeviceSessionToken(context, "credential sync");
  const backend = bearerBackend(context.config.apiBaseUrl, sessionToken);

  for (const { providerId, auth, accountLabel } of syncable) {
    const syncBody = {
      providerId,
      runnerMachineId: context.config.machineId,
      ...(accountLabel ? { accountLabel } : {}),
      auth,
    };
    const response = await backend.api
      .org({ organizationId: context.config.organizationId })
      .credentials["opencode-provider-credentials"].sync.post(syncBody);
    if (response.error) {
      throw apiRequestError(`Sync provider ${providerId}`, response.error, "connect");
    }
    log.success(`Synced ${providerId} provider credentials to Devboxes.`);
  }
};

// Status is an inspection command: an unreachable dashboard (the passphrase
// round trip) or unreadable store degrades to a warning instead of killing
// the health probe.
const openCredentialStoreForStatus = async (context: DevboxesContext) => {
  try {
    return { entries: (await openCredentialStoreIfPresent(context))?.store.entries ?? {} };
  } catch (error) {
    return {
      entries: {} as LocalCredentialStore["entries"],
      storeError: error instanceof Error ? error.message : String(error),
    };
  }
};

// The machine-readable credential shape shared by `doctor --json` and
// `devboxes credentials status --json`: one stable contract, not two drifting ones.
const credentialStatusJson = async (context: DevboxesContext) => {
  const { entries, storeError } = await openCredentialStoreForStatus(context);
  return {
    store: Object.entries(entries).map(([providerId, entry]) => ({
      providerId,
      kind: entry.auth.type === "oauth" ? "subscription" : "api-key",
      accountLabel: entry.accountLabel ?? null,
    })),
    storeError: storeError ?? null,
    references: context.config.opencodeProviderCredentials ?? [],
  };
};

export const showOpencodeProviderCredentialStatus = async (
  context: DevboxesContext,
  options: Pick<RunnerCliOptions, "json"> = {},
) => {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(await credentialStatusJson(context), null, 2)}\n`);
    return;
  }
  const references = context.config.opencodeProviderCredentials ?? [];
  const { entries: storeEntries, storeError } = await openCredentialStoreForStatus(context);
  if (storeError) {
    log.warn(`The device credential store is present but not readable right now: ${storeError}`);
  }

  if (references.length === 0 && Object.keys(storeEntries).length === 0) {
    if (!storeError) {
      log.warn("No local Opencode provider credentials are configured.");
      log.info(
        "Run `devboxes credentials setup` to connect a subscription, store an API key, or save auth-file references.",
      );
    }
    return;
  }

  if (Object.keys(storeEntries).length > 0) {
    note(
      Object.entries(storeEntries)
        .map(
          ([providerId, entry]) =>
            `${providerId}: ${entry.auth.type === "oauth" ? "subscription" : "API key"}${
              entry.accountLabel ? ` (${entry.accountLabel})` : ""
            }`,
        )
        .join("\n"),
      "Device credential store (encrypted)",
    );
  }
  // Log lines, not a note box: notes wrap long lines and a wrapped auth-file
  // path is no longer copyable.
  if (references.length > 0) {
    log.info(
      [
        "Auth-file references:",
        ...references.map(
          (credential) =>
            `${credential.providerId}: ${credential.source}\n  ${credential.authFile}`,
        ),
      ].join("\n"),
    );
  }
  log.info("Run `devboxes credentials sync` to copy local credentials to organization storage.");
};

export const removeOpencodeProviderCredentials = async (
  context: DevboxesContext,
  options: Pick<RunnerCliOptions, "all" | "provider">,
) => {
  if (!options.all && !options.provider) {
    throw new Error("Choose credentials to remove with --provider <provider> or --all.");
  }
  const requestedProviders = new Set(
    (options.provider ?? "")
      .split(",")
      .map((providerId) => providerId.trim())
      .filter(Boolean),
  );
  const discardAmbiguousOpencode =
    options.all || requestedProviders.has("opencode") || requestedProviders.has("opencode-go");
  const references = context.config.opencodeProviderCredentials ?? [];
  const opened = await openCredentialStoreIfPresent(context, discardAmbiguousOpencode);
  const store = opened?.store;
  const configuredProviderIds = [
    ...new Set([
      ...references.map((reference) => reference.providerId),
      ...Object.keys(store?.entries ?? {}),
    ]),
  ];
  const removedProviderIds = configuredProviderIds.filter(
    (providerId) => options.all || requestedProviders.has(providerId),
  );
  const removedSet = new Set(removedProviderIds);
  const remainingReferences = references.filter(
    (reference) =>
      !removedSet.has(reference.providerId) &&
      (!requestedProviders.has("opencode-go") ||
        reference.providerId !== "opencode" ||
        reference.providerIdFormat === "exact"),
  );
  const removedLegacyOpencodeReference =
    requestedProviders.has("opencode-go") &&
    references.some(
      (reference) => reference.providerId === "opencode" && reference.providerIdFormat !== "exact",
    );
  if (configuredProviderIds.length === 0 || removedProviderIds.length === 0) {
    if (removedLegacyOpencodeReference) {
      context.config.opencodeProviderCredentials = remainingReferences;
      await writeConfig(context);
    }
    if (opened && discardAmbiguousOpencode) {
      await writeCredentialStore({ ...opened.access, store: opened.store });
    }
    if (removedLegacyOpencodeReference) {
      log.success("Removed ambiguous legacy OpenCode credentials for opencode-go.");
      log.info("Source credential files remain in their configured locations.");
      return;
    }
    // Removal is idempotent: "already absent" is the desired state, so a
    // re-run in a provisioning script succeeds instead of failing.
    log.warn(
      configuredProviderIds.length === 0
        ? "No local Opencode provider credentials are configured."
        : "No configured local Opencode provider credentials match --provider.",
    );
    return;
  }

  context.config.opencodeProviderCredentials = remainingReferences;
  await writeConfig(context);
  if (opened) {
    for (const providerId of removedProviderIds) {
      delete opened.store.entries[providerId];
    }
    await writeCredentialStore({ ...opened.access, store: opened.store });
  }

  log.success(`Removed local Opencode provider credentials for ${removedProviderIds.join(", ")}.`);
  log.info("Source credential files remain in their configured locations.");
};

export const runRunnerDoctor = async (
  context: DevboxesContext,
  options: Pick<RunnerCliOptions, "live" | "json"> = {},
) => {
  let ok = true;
  const checks: Array<{ status: "ok" | "warning" | "info"; message: string }> = [];
  const report = (status: "ok" | "warning" | "info", message: string) => {
    checks.push({ status, message });
    if (options.json) return;
    if (status === "ok") {
      log.success(message);
    } else if (status === "warning") {
      log.warn(message);
    } else {
      log.info(message);
    }
  };
  const registered = Boolean(context.config.organizationId && context.config.apiKey);
  const credentials = await credentialStatusJson(context);
  const storeExists = await credentialStoreExists(context.configPath);

  if (!options.json) {
    log.step("Devboxes runner doctor");
    note(
      [
        `Version: ${runnerVersion}`,
        `Config: ${context.configPath}`,
        `API: ${context.config.apiBaseUrl}`,
        `Auth: ${context.config.authBaseUrl}`,
        context.config.organizationId
          ? `Organization: ${context.config.organizationId}`
          : "Organization: not registered",
        registered ? "Registration: configured" : "Registration: missing",
      ].join("\n"),
      "Devboxes runner",
    );
  }
  report("info", `Task API: ${taskContainerApiBaseUrl(context.config.apiBaseUrl)}`);

  if (registered) {
    report("ok", "OK: runner registration is configured.");
  } else {
    ok = false;
    report("warning", "Needs attention: run `devboxes connect` to register this runner.");
  }

  try {
    const socketPath = dockerSocketPath();
    // A short deadline: doctor is a health probe, not a workload.
    const docker = new Docker({ socketPath, timeout: 10_000 });
    const engine = await docker.version();
    report(
      "ok",
      `OK: container runtime is reachable at ${socketPath} (engine ${engine.Version ?? "unknown"}, API ${engine.ApiVersion ?? "unknown"}).`,
    );
  } catch (error) {
    ok = false;
    report(
      "warning",
      `Needs attention: container runtime is not reachable. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (storeExists) {
    if (credentials.storeError) {
      ok = false;
      report("warning", `Needs attention: ${credentials.storeError}`);
    } else {
      report(
        "ok",
        credentials.store.length > 0
          ? `OK: the device credential store decrypts and holds ${credentials.store
              .map((entry) => entry.providerId)
              .join(", ")}.`
          : "OK: the device credential store decrypts but holds no credentials.",
      );
    }
    if (options.live && !credentials.storeError) {
      try {
        const storeAccess = await credentialStoreAccess(context);
        const storeEntries = (await readCredentialStore(storeAccess)).entries;
        const storeProviderIds = Object.keys(storeEntries);
        // Proof of life: a real vendor refresh per stored subscription, via the
        // same single-flight path task boots use.
        const runtime = new LocalRunnerOpencodeProviderAuthRuntime([], storeAccess, () =>
          fetchOpencodeConnectors(context),
        );
        const outcomes = await runtime.refreshExpiringStoredCredentials({
          windowMs: Number.POSITIVE_INFINITY,
          silent: options.json,
        });
        for (const outcome of outcomes) {
          if (outcome.ok) {
            report("ok", `OK: ${outcome.providerId} subscription refreshed against the vendor.`);
          } else {
            ok = false;
            report("warning", `Needs attention: ${outcome.error}`);
          }
        }
        const unverified = storeProviderIds.filter(
          (providerId) =>
            !outcomes.some((outcome) => outcome.providerId === providerId) &&
            storeEntries[providerId]?.auth.type !== "oauth",
        );
        if (unverified.length > 0) {
          report(
            "info",
            `Stored API keys are not vendor-verified (no universal liveness check): ${unverified.join(", ")}.`,
          );
        }
      } catch (error) {
        ok = false;
        report(
          "warning",
          `Needs attention: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  const references = context.config.opencodeProviderCredentials ?? [];
  if (references.length === 0) {
    if (!storeExists) {
      ok = false;
      report(
        "warning",
        "Needs attention: run `devboxes credentials setup` to configure local Opencode credentials.",
      );
    }
  } else {
    const credentialRuntime = new LocalRunnerOpencodeProviderAuthRuntime(references);
    for (const credential of references) {
      try {
        const providerAuth = await credentialRuntime.providerAuthForProvider({
          providerId: credential.providerId,
        });
        const auth = providerAuth[credential.providerId];
        if (auth?.type === "api") {
          report("ok", `OK: ${credential.providerId} local API credential is readable.`);
        } else if (auth?.type === "oauth") {
          report("ok", `OK: ${credential.providerId} local OAuth credential is readable.`);
        } else {
          ok = false;
          report(
            "warning",
            `Needs attention: ${credential.providerId} is not a servable credential. Run \`devboxes credentials setup --provider ${credential.providerId}\` again after configuring it.`,
          );
        }
      } catch (error) {
        ok = false;
        report(
          "warning",
          `Needs attention: ${credential.providerId} ${error instanceof Error ? error.message : "credential is unavailable."}`,
        );
      }
    }
  }

  if (ok) {
    report("ok", "Local runner credentials are ready.");
  }
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          version: runnerVersion,
          configPath: context.configPath,
          apiBaseUrl: context.config.apiBaseUrl,
          authBaseUrl: context.config.authBaseUrl,
          organizationId: context.config.organizationId ?? null,
          registered,
          healthy: ok,
          credentials,
          checks,
        },
        null,
        2,
      )}\n`,
    );
  }
  return ok;
};

export const startCredentialBroker = (
  activeCredentials: ReadonlyMap<string, ActiveOpencodeCredentialTask>,
) => {
  // Task containers reach the broker through host.docker.internal, which on
  // native Linux Docker resolves to the bridge gateway IP — not loopback — so
  // the broker must listen on all interfaces. Access is gated by the random
  // port plus the per-task bearer token, which only active tasks hold.
  // Pick from the Devboxes 30k dev port range instead of the OS-ephemeral
  // range so broker ports stay predictable for firewall rules and
  // container-side debugging.
  let app: ReturnType<typeof createOpencodeCredentialBroker> | undefined;
  for (let attempt = 0; attempt < 20 && !app; attempt++) {
    const candidatePort = 34000 + Math.floor(Math.random() * 1000);
    try {
      app = createOpencodeCredentialBroker({ activeCredentials }).listen({
        hostname: "0.0.0.0",
        port: candidatePort,
      });
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "EADDRINUSE") throw error;
    }
  }
  const port = app?.server?.port;
  if (!app || !port) throw new Error("Local Opencode credential broker did not start.");

  console.info(`Local Opencode credential broker listening on port ${port}.`);
  return {
    close: () => app.stop(),
    providerAuthUrl: `http://host.docker.internal:${port}`,
  };
};

const listen = async (
  context: DevboxesContext,
  options: Pick<RunnerCliOptions, "maxConcurrent">,
) => {
  // The first signal stops the loop gracefully (interrupting any poll/backoff
  // sleep immediately); a second signal force-exits for operators who cannot
  // wait out an in-flight iteration.
  const stop = new AbortController();
  const requestStop = (signal: string) => {
    if (stop.signal.aborted) {
      console.info(`Received ${signal} again; exiting immediately.`);
      process.exit(130);
    }
    console.info(`Received ${signal}; finishing the current iteration...`);
    stop.abort();
  };
  process.on("SIGINT", () => requestStop("SIGINT"));
  process.on("SIGTERM", () => requestStop("SIGTERM"));
  const stoppableSleep = async (ms: number) => {
    try {
      await sleep(ms, undefined, { signal: stop.signal });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      throw error;
    }
  };

  const maxConcurrent = options.maxConcurrent ?? 1;
  const activeTasks = new Map<string, ActiveTask>();
  console.info(`Devboxes ${runnerVersion} starting container runtime...`);
  const { DockerOpencodeTaskRuntime } = await import("./docker-task-runtime");
  const taskRuntime = new DockerOpencodeTaskRuntime({
    daemonApiBaseUrl: taskContainerApiBaseUrl(context.config.apiBaseUrl),
  });
  const apiKey = context.config.apiKey;
  if (!apiKey) {
    throw new Error("This command requires a registered runner. Run `devboxes connect` first.");
  }
  const backend = bearerBackend(context.config.apiBaseUrl, apiKey);
  const heartbeat = async () => {
    const result = await backend.api.internal["runner-machines"].heartbeat.post({
      nativePlatform: runnerNativePlatform,
      supportedPlatforms: runnerSupportedPlatforms,
      listenerVersion: runnerVersion,
    });
    if (result.error) throw apiRequestError("Heartbeat", result.error, "connect");
    return result.data;
  };
  const openedStore = await openCredentialStoreIfPresent(context).catch((error) => {
    console.error(
      `Device credential store is unavailable for runner claims: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  });
  let providerSnapshotPassphrase = openedStore?.access.passphrase;
  const credentialSnapshotPassphrase = async () => {
    if (!providerSnapshotPassphrase) {
      providerSnapshotPassphrase = (await credentialStoreAccess(context)).passphrase;
    }
    return providerSnapshotPassphrase;
  };
  const configuredCredentials: LocalOpencodeProviderCredentialReference[] = [];
  for (const credential of context.config.opencodeProviderCredentials ?? []) {
    if (credential.providerId === "opencode" && credential.providerIdFormat !== "exact") {
      console.error(
        `Local provider credential opencode is unavailable for runner claims: ${ambiguousOpencodeCredentialMessage}`,
      );
      continue;
    }
    configuredCredentials.push(credential);
  }
  // Provider ids this machine serves from disk through the broker are fixed at
  // startup; `devboxes credentials setup` needs a restart to advertise a new id.
  // The credential behind an existing id is read before every claim so replacing
  // an API key with OAuth, or OAuth with an API key, changes the next claim's
  // immutable monetary authority. Org-stored credentials qualify further tasks
  // server-side and those launch against the dashboard route instead.
  const localProviderIds = new Set([
    ...configuredCredentials.map((credential) => credential.providerId),
    ...Object.keys(openedStore?.store.entries ?? {}),
  ]);
  const credentialRuntime = new LocalRunnerOpencodeProviderAuthRuntime(
    configuredCredentials,
    openedStore?.access,
    () => fetchOpencodeConnectors(context),
  );
  const credentialBroker = startCredentialBroker(activeTasks);
  // Claim-time refresh cannot keep an idle subscription token family alive.
  // Sweep at startup for anything that expired while the runner was off, then
  // hourly; the 70-minute window outlasts a full cron period so nothing expires
  // between fires. The sweep shares the claim runtime, so cron and claim refresh
  // single-flight per family.
  const credentialRefreshWindowMs = 70 * 60 * 1000;
  if (openedStore) {
    void credentialRuntime.refreshExpiringStoredCredentials({
      windowMs: credentialRefreshWindowMs,
    });
  }
  const credentialRefreshJob = openedStore
    ? Bun.cron("0 * * * *", () =>
        credentialRuntime.refreshExpiringStoredCredentials({
          windowMs: credentialRefreshWindowMs,
        }),
      ).unref()
    : undefined;
  try {
    console.info("Connecting to Devboxes...");
    await heartbeat();

    // Startup reconciliation: containers and per-task secrets survive runner
    // restarts. The read-only task listing (never a lease refresh, which would fake
    // liveness) tells us which leftovers to re-adopt, which to keep for the
    // committed-state reuse path (queued), and which to tear down.
    console.info("Reconciling tasks after restart...");
    const leftovers = await taskRuntime.listLeftoverTasks();
    const listingResult = await backend.api.internal["runner-machines"].tasks.get({
      query:
        leftovers.length > 0
          ? { taskIds: leftovers.map((leftover) => leftover.taskId).join(",") }
          : {},
    });
    if (listingResult.error) {
      // Without server truth, deleting local state would be deleting on
      // uncertainty. Keep everything for the next startup.
      console.info(
        `Skipped task reconciliation: ${apiRequestError("Task listing", listingResult.error, "connect")}`,
      );
    } else {
      const listing = listingResult.data;
      const knownTasks = new Map(listing.tasks.map((task) => [task.taskId, task] as const));

      // Re-adopt running tasks assigned to this machine whose container is still
      // alive, so lease refresh and stopRequestedAt handling resume after the
      // restart. A running task whose container is gone can never finish: report
      // it failed and clean up its secrets.
      for (const task of listing.tasks) {
        if (!task.runningOnThisMachine || !task.containerName) continue;
        let state: { Running: boolean } | null;
        try {
          state = await taskRuntime.inspectTask({
            taskId: task.taskId,
            containerId: task.containerId,
            containerName: task.containerName,
          });
        } catch (error) {
          // An inspect failure is not "container gone": do not fail the task on
          // uncertainty. It stays untracked until the next restart or the reaper.
          console.info(`Failed to inspect container for task ${task.taskId}: ${String(error)}`);
          continue;
        }
        if (state?.Running) {
          if (
            !task.modelProviderId ||
            !task.perTaskToken ||
            !task.providerAuthSource ||
            !task.providerCredentialFingerprint
          ) {
            console.info(
              `Skipped re-adopting task ${task.taskId}: provider auth context is absent.`,
            );
            continue;
          }
          let providerAuth: OpencodeProviderAuthJson | undefined;
          if (task.providerAuthSource === "local-broker") {
            let snapshotPassphrase: string;
            try {
              snapshotPassphrase = await credentialSnapshotPassphrase();
            } catch (error) {
              console.info(
                `Skipped re-adopting task ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`,
              );
              continue;
            }
            try {
              providerAuth = await taskRuntime.readProviderAuthSnapshot({
                organizationId: task.organizationId,
                taskId: task.taskId,
                providerId: task.modelProviderId,
                passphrase: snapshotPassphrase,
              });
            } catch {
              providerAuth = undefined;
            }
            const auth = providerAuth?.[task.modelProviderId];
            if (
              !auth ||
              (auth.type !== "api" && auth.type !== "oauth") ||
              opencodeProviderAuthFingerprint(task.modelProviderId, auth) !==
                task.providerCredentialFingerprint
            ) {
              const errorMessage =
                "The claim-captured local provider credential is unavailable after runner restart.";
              await taskRuntime.stopTask({
                taskId: task.taskId,
                organizationId: task.organizationId,
                containerId: task.containerId,
              });
              const reported = await backend.api.internal["runner-machines"]
                .tasks({ taskId: task.taskId })
                .report.post({
                  status: "failed",
                  errorMessage,
                  attemptCount: task.attemptCount,
                });
              if (reported.error) {
                throw apiRequestError("Credential authority report", reported.error, "connect");
              }
              console.info(`Failed task ${task.taskId}: ${errorMessage}`);
              continue;
            }
          }
          // The reconciliation minted a fresh per-task token; the container's
          // mounted secret file must hold the same token the broker serves.
          await taskRuntime
            .refreshBackendToken({
              organizationId: task.organizationId,
              taskId: task.taskId,
              backendToken: task.perTaskToken,
            })
            .catch((error) => {
              console.info(`Failed to refresh the token file for task ${task.taskId}: ${error}`);
            });
          activeTasks.set(task.taskId, {
            taskId: task.taskId,
            organizationId: task.organizationId,
            modelProviderId: task.modelProviderId,
            perTaskToken: task.perTaskToken,
            containerId: task.containerId,
            containerName: task.containerName,
            attemptCount: task.attemptCount,
            ...(providerAuth ? { providerAuth } : {}),
          });
          console.info(`Re-adopted running task ${task.taskId}.`);
          continue;
        }
        const containerFate = state
          ? "exited before reporting a final status"
          : "disappeared while the runner was restarting";
        const reported = await backend.api.internal["runner-machines"]
          .tasks({ taskId: task.taskId })
          .report.post({
            status: "failed",
            errorMessage: `Runner container ${containerFate}.`,
            attemptCount: task.attemptCount,
          });
        if (reported.error) {
          const reportError = apiRequestError("Report", reported.error, "connect");
          console.info(
            reportRaceIsBenign(reportError)
              ? `Task ${task.taskId} was already resolved server-side (${reportError.code}); cleaning up its missing container.`
              : `Failed to report missing container for task ${task.taskId}: ${reportError}`,
          );
        }
        await taskRuntime
          .stopTask({
            taskId: task.taskId,
            organizationId: task.organizationId,
            containerId: task.containerId,
          })
          .catch((error) => {
            console.info(`Failed to clean up task ${task.taskId}: ${error}`);
          });
        console.info(`Reported task ${task.taskId} failed: its container ${containerFate}.`);
      }

      // Tear down leftovers whose tasks are gone, terminal, or claimed elsewhere.
      // Queued tasks keep their containers: relaunch on this machine reuses the
      // committed container state.
      for (const leftover of leftovers) {
        if (activeTasks.has(leftover.taskId)) continue;
        const known = knownTasks.get(leftover.taskId);
        if (known && (known.status === "queued" || known.runningOnThisMachine)) continue;
        const stopped = await taskRuntime
          .stopTask({
            ...leftover,
            organizationId: known?.organizationId ?? leftover.organizationId,
          })
          .catch((error) => {
            console.info(`Failed to clean up leftover task ${leftover.taskId}: ${error}`);
            return null;
          });
        if (stopped) console.info(`Cleaned up leftover task ${leftover.taskId}.`);
      }
    }

    console.info("Listening for queued tasks.");

    // Transient API failures must never kill the daemon: every iteration's API
    // work is wrapped, failures back off exponentially (bounded), success resets.
    let consecutiveFailures = 0;
    while (!stop.signal.aborted) {
      try {
        await heartbeat();

        for (const task of activeTasks.values()) {
          // A daemon that dies before reporting (provider auth unavailable, a
          // crash during boot) leaves a dead container behind a still-leased
          // task; blind lease refreshes would keep it "running" forever, so
          // every iteration checks the container is actually alive.
          if (task.containerId || task.containerName) {
            const state = await taskRuntime
              .inspectTask({
                taskId: task.taskId,
                containerId: task.containerId,
                containerName: task.containerName ?? taskContainerName(task.taskId),
              })
              .catch(() => null);
            if (state && !state.Running) {
              const reported = await backend.api.internal["runner-machines"]
                .tasks({ taskId: task.taskId })
                .report.post({
                  status: "failed",
                  errorMessage: `Runner container exited with code ${state.ExitCode} before reporting a final status.`,
                  attemptCount: task.attemptCount,
                });
              if (reported.error) {
                const reportError = apiRequestError("Report", reported.error, "connect");
                console.info(
                  reportRaceIsBenign(reportError)
                    ? `Task ${task.taskId} was already resolved server-side (${reportError.code}); cleaning up its dead container.`
                    : `Failed to report dead container for task ${task.taskId}: ${reportError}`,
                );
              }
              await taskRuntime.stopTask(task).catch((stopError) => {
                console.info(
                  `Failed to clean up ${task.containerName ?? task.taskId}: ${stopError}`,
                );
              });
              activeTasks.delete(task.taskId);
              console.info(`Task ${task.taskId} exited before reporting; cleaned it up.`);
              continue;
            }
          }

          const leaseResult = await backend.api.internal["runner-machines"]
            .tasks({ taskId: task.taskId })
            .lease.post({});
          if (leaseResult.error) {
            const leaseError = apiRequestError("Lease", leaseResult.error, "connect");
            if (
              leaseError.code === "task_not_found" ||
              leaseError.code === "task_other_organization" ||
              leaseError.code === "task_other_machine"
            ) {
              // Only the structured task_* codes prove this machine no longer owns
              // the task. A bare 403/404 (expired auth, disabled machine, proxy or
              // middleware noise) must back off instead of destroying a healthy
              // container, so it rethrows below.
              const stopped = await taskRuntime.stopTask(task).catch((stopError) => {
                console.info(
                  `Failed to clean up ${task.containerName ?? task.taskId}: ${stopError}`,
                );
                return null;
              });
              activeTasks.delete(task.taskId);
              console.info(
                stopped
                  ? `Task ${task.taskId} is gone or reassigned; removed its container and secrets.`
                  : `Task ${task.taskId} is gone or reassigned.`,
              );
              continue;
            }
            throw leaseError;
          }
          const lease = leaseResult.data;
          if (lease.terminal || lease.status !== "running") {
            // Terminal tasks never get a stop request, so tear down the container and
            // the per-task secrets here exactly like an explicit stop would.
            const stopped = await taskRuntime.stopTask(task).catch((error) => {
              console.info(`Failed to clean up ${task.containerName ?? task.taskId}: ${error}`);
              return null;
            });
            activeTasks.delete(task.taskId);
            console.info(
              stopped
                ? `Task ${task.taskId} is no longer active; removed its container and secrets.`
                : `Task ${task.taskId} is no longer active.`,
            );
            continue;
          }
          if (lease.stopRequested) {
            console.info(`Stopping task ${task.taskId}...`);
            const stopped = await taskRuntime.stopTask(task);
            const acked = await backend.api.internal["runner-machines"]
              .tasks({ taskId: task.taskId })
              ["stop-ack"].post({
                stopped: stopped.stopped,
                containerId: stopped.containerId ?? undefined,
                containerName: stopped.containerName,
                errorMessage: lease.stopReason ?? undefined,
              });
            if (acked.error) throw apiRequestError("Stop ack", acked.error, "connect");
            activeTasks.delete(task.taskId);
            console.info(`Stopped task ${task.taskId}.`);
          }
        }

        if (activeTasks.size < maxConcurrent) {
          const localProviderCredentials: Array<{
            providerId: string;
            authType: "api" | "oauth";
            credentialFingerprint: string;
          }> = [];
          const claimProviderAuth = new Map<string, OpencodeProviderAuthJson>();
          for (const providerId of [...localProviderIds].sort()) {
            try {
              const providerAuth = await credentialRuntime.providerAuthForProvider({ providerId });
              const auth = providerAuth[providerId];
              if (!auth) {
                throw new Error(
                  `Local provider credential ${providerId} did not return its auth type.`,
                );
              }
              if (auth.type !== "api" && auth.type !== "oauth") {
                throw new Error(
                  `Local provider credential ${providerId} has unsupported auth type.`,
                );
              }
              localProviderCredentials.push({
                providerId,
                authType: auth.type,
                credentialFingerprint: opencodeProviderAuthFingerprint(providerId, auth),
              });
              claimProviderAuth.set(providerId, providerAuth);
            } catch (error) {
              console.error(
                `Local provider credential ${providerId} is unavailable for this claim: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          const claimResult = await backend.api.internal["runner-machines"].claim.post({
            leaseMs: 120_000,
            // Providers the local broker can serve; the server unions these
            // with the org's stored credentials, which run on any machine
            // through the dashboard provider-auth route.
            localProviderCredentials,
            // The launch-spec protocols this binary executes; a server that
            // serves none of them answers listener_upgrade_required.
            launchProtocols: [opencodeUsageAuthorityLaunchProtocol],
          });
          if (claimResult.error) throw apiRequestError("Claim", claimResult.error, "connect");
          // An empty queue answers 204, which Eden types as the "No Content" literal.
          const task = claimResult.data;
          if (task && typeof task !== "string") {
            console.info(`Claimed task ${task.taskId}; launching on ${task.platform}...`);
            const providerAuth =
              task.launchSpec.providerAuthSource === "local-broker"
                ? claimProviderAuth.get(task.modelProviderId)
                : undefined;
            const pinnedAuth = providerAuth?.[task.modelProviderId];
            if (
              task.launchSpec.providerAuthSource === "local-broker" &&
              (!pinnedAuth ||
                (pinnedAuth.type !== "api" && pinnedAuth.type !== "oauth") ||
                opencodeProviderAuthFingerprint(task.modelProviderId, pinnedAuth) !==
                  task.providerCredentialFingerprint)
            ) {
              throw new Error(
                `Claimed task ${task.taskId} did not retain its local credential authority.`,
              );
            }
            if (providerAuth) {
              await taskRuntime.persistProviderAuthSnapshot({
                organizationId: task.organizationId,
                taskId: task.taskId,
                providerId: task.modelProviderId,
                providerAuth,
                passphrase: await credentialSnapshotPassphrase(),
              });
            }
            let activeTask: ActiveTask = {
              taskId: task.taskId,
              organizationId: task.organizationId,
              modelProviderId: task.modelProviderId,
              perTaskToken: task.perTaskToken,
              containerId: null,
              containerName: null,
              attemptCount: task.attemptCount,
              ...(providerAuth ? { providerAuth } : {}),
            };
            activeTasks.set(task.taskId, activeTask);
            const launchLeaseRefresh = setInterval(() => {
              void backend.api.internal["runner-machines"]
                .tasks({ taskId: task.taskId })
                .lease.post({})
                .then((refreshed) => {
                  if (refreshed.error) {
                    console.info(
                      `Failed to refresh launch lease for ${task.taskId}: ${apiRequestError("Lease", refreshed.error, "connect")}`,
                    );
                  }
                })
                .catch((error) => {
                  console.info(`Failed to refresh launch lease for ${task.taskId}: ${error}`);
                });
            }, 30_000);
            try {
              // Eden types are compile-time only: the served spec crosses a
              // real decode boundary here, validated before anything runs.
              const launchSpec = Value.Parse(OpencodeLaunchSpecSchema, task.launchSpec);
              const container = await taskRuntime.launchTask({
                organizationId: task.organizationId,
                taskId: task.taskId,
                runId: task.runId,
                apiKey: task.perTaskToken,
                // The server decided the provider-auth source (it computes the
                // availability union at claim); this machine owns the URLs.
                providerAuthUrl:
                  launchSpec.providerAuthSource === "local-broker"
                    ? credentialBroker.providerAuthUrl
                    : `${taskContainerApiBaseUrl(context.config.apiBaseUrl)}/internal`,
                imageRef: task.imageRef,
                launchSpec,
              });
              activeTask = {
                ...activeTask,
                taskId: task.taskId,
                organizationId: task.organizationId,
                containerId: container.containerId,
                containerName: container.containerName,
              };
              const reported = await backend.api.internal["runner-machines"]
                .tasks({ taskId: task.taskId })
                .report.post({
                  status: "launched",
                  containerId: container.containerId,
                  containerName: container.containerName,
                  attemptCount: task.attemptCount,
                });
              if (reported.error) {
                throw apiRequestError("Launch report", reported.error, "connect");
              }
              activeTasks.set(task.taskId, activeTask);
              console.info(`Launched ${container.containerName}.`);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              activeTasks.delete(task.taskId);
              const stopped = await taskRuntime.stopTask(activeTask).catch((stopError) => {
                console.info(
                  `Failed to clean up ${activeTask.containerName ?? activeTask.taskId}: ${stopError}`,
                );
                return null;
              });
              if (stopped?.stopped) {
                console.info(
                  `Cleaned up ${activeTask.containerName ?? activeTask.taskId} after launch failure.`,
                );
              }
              const failureReport = await backend.api.internal["runner-machines"]
                .tasks({ taskId: task.taskId })
                .report.post({
                  status: "failed",
                  errorMessage: message,
                  attemptCount: task.attemptCount,
                })
                .catch((reportError) => ({ error: reportError }));
              if (failureReport.error) {
                console.info(
                  `Failed to report launch failure for ${task.taskId}: ${JSON.stringify(failureReport.error)}`,
                );
              }
              console.info(`Launch failed for ${task.taskId}: ${message}`);
            } finally {
              clearInterval(launchLeaseRefresh);
            }
          }
        }

        consecutiveFailures = 0;
        await stoppableSleep(10_000);
      } catch (error) {
        // Reserved upgrade lever: when the API someday answers this code,
        // binaries already in the wild stop with the server's message instead
        // of retrying a contract they can no longer speak.
        if (error instanceof ApiRequestError && error.code === listenerUpgradeRequiredCode) {
          // A running CLI can do nothing about being too old except stop
          // deliberately: exit non-zero so process supervisors notice, and
          // leave active containers running — startup reconciliation re-adopts
          // them after the upgrade, exactly like recovering from a crash.
          console.error(error.message);
          if (activeTasks.size > 0) {
            console.info(
              `Leaving ${activeTasks.size} running task container(s) untouched; the upgraded Devboxes CLI re-adopts them on startup.`,
            );
          }
          process.exitCode = 1;
          break;
        }
        consecutiveFailures += 1;
        const backoffMs = Math.min(10_000 * 2 ** Math.min(consecutiveFailures - 1, 5), 300_000);
        console.info(
          `Poll failed (${consecutiveFailures} in a row, retrying in ${Math.round(
            backoffMs / 1000,
          )}s): ${String(error)}`,
        );
        await stoppableSleep(backoffMs);
      }
    }
  } finally {
    credentialRefreshJob?.stop();
    await credentialBroker.close();
  }
};

const positiveIntegerOption = (value: string) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value.trim()) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return parsed;
};

export const addRunnerCommands = (program: Command) => {
  const runnerOptions = (command: Command): RunnerCliOptions => {
    const options = command.optsWithGlobals<Partial<RunnerCliOptions>>();
    return { ...options, all: options.all ?? false };
  };

  const connectCommand = program.command("connect");
  connectCommand
    .description("register this machine as a Devboxes runner")
    .option("--name <name>", "runner machine name")
    .action(async () => {
      const options = runnerOptions(connectCommand);
      const context = await loadContext(options);
      await playIntro();
      const registerWithUserSessionOrDevice = async (purpose: string) => {
        if (context.config.sessionToken) {
          try {
            return await registerMachine(
              context,
              context.config.sessionToken,
              context.config.organizationId,
            );
          } catch (error) {
            if (!(error instanceof ApiRequestError) || error.status !== 401) throw error;
          }
        }
        return registerMachine(
          context,
          await runnerDeviceSessionToken(context, purpose),
          context.config.organizationId,
        );
      };
      let registration;
      if (context.config.apiKey) {
        try {
          // The verified key already binds the live machine to its
          // organization. Do not constrain it with the account organization
          // that a preceding `devboxes login` may have written into the shared
          // config; the response restores the machine's organization below.
          registration = await registerMachine(context, context.config.apiKey, undefined);
        } catch (error) {
          if (!(error instanceof ApiRequestError) || error.status !== 401) throw error;
          if (!context.config.machineId) {
            throw new Error(
              "The saved runner credential is invalid and this config has no machine identity. Move the config aside and run `devboxes connect` to register a new machine.",
            );
          }
          registration = await registerWithUserSessionOrDevice("runner re-registration");
        }
      } else {
        registration = await registerWithUserSessionOrDevice("runner registration");
      }
      log.success(`Machine ${registration.machine.id} saved at ${context.configPath}.`);
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        log.info(
          "Run `devboxes credentials setup` to configure local Opencode provider credentials.",
        );
        return;
      }

      const answer = await prompts.confirm({
        message: "Configure provider credentials for this runner now?",
      });
      if (isCancel(answer) || !answer) {
        log.info("Skipped provider credential setup. Run `devboxes credentials setup` later.");
        return;
      }

      await setupOpencodeProviderCredentials(context, options);
    });

  const doctorCommand = program.command("doctor");
  doctorCommand
    .description("check runner registration, container runtime, and credential readiness")
    .option("--live", "prove stored subscriptions with a real vendor refresh", false)
    .option("--json", "print machine-readable runner health on stdout", false)
    .action(async () => {
      const options = runnerOptions(doctorCommand);
      if (
        !(await runRunnerDoctor(await loadContext(options), {
          live: options.live,
          json: options.json,
        }))
      ) {
        process.exitCode = 1;
      }
    });

  const listenCommand = program.command("listen");
  listenCommand
    .description("poll Devboxes and run queued tasks in containers on your machine")
    .option(
      "--max-concurrent <count>",
      "maximum concurrently running tasks",
      positiveIntegerOption,
      1,
    )
    .action(async () => {
      const options = runnerOptions(listenCommand);
      await listen(await loadContext(options), options);
    });

  const credentialsCommand = program.command("credentials").description("manage local credentials");

  const setupCommand = credentialsCommand.command("setup");
  setupCommand
    .description(
      "configure provider credentials: connect subscriptions, store API keys, save auth-file references",
    )
    .option("--provider <providers>", "comma-separated provider ids")
    .option("--all", "save every discovered provider credential", false)
    .option(
      "--connect <provider>",
      // The connectable set is served by the dashboard, not compiled in; the
      // error path and the interactive menu enumerate the live list.
      "connect a subscription via device OAuth (run `devboxes credentials setup` to list providers)",
    )
    .option(
      "--api-key <provider>",
      "store a provider API key on this device (the key is read from stdin when piped)",
    )
    .action(async () => {
      const options = runnerOptions(setupCommand);
      await setupOpencodeProviderCredentials(await loadContext(options), {
        all: options.all ?? false,
        provider: options.provider,
        connect: options.connect,
        apiKey: options.apiKey,
      });
    });

  const syncCommand = credentialsCommand.command("sync");
  syncCommand
    .description("upload local credentials to encrypted organization storage")
    .option("--provider <providers>", "comma-separated provider ids")
    .action(async () => {
      const options = runnerOptions(syncCommand);
      await syncOpencodeProviderCredentials(await loadContext(options), {
        provider: options.provider,
      });
    });

  const statusCredentialsCommand = credentialsCommand.command("status");
  statusCredentialsCommand
    .description("show saved local credential references")
    .option("--json", "print machine-readable credential status on stdout", false)
    .action(async () => {
      const options = runnerOptions(statusCredentialsCommand);
      await showOpencodeProviderCredentialStatus(await loadContext(options), {
        json: options.json,
      });
    });

  const removeCommand = credentialsCommand.command("remove");
  removeCommand
    .description("remove saved local credential references")
    .option("--provider <providers>", "comma-separated provider ids")
    .option("--all", "remove every saved provider credential reference", false)
    .action(async () => {
      const options = runnerOptions(removeCommand);
      await removeOpencodeProviderCredentials(await loadContext(options), {
        all: options.all ?? false,
        provider: options.provider,
      });
    });
};
