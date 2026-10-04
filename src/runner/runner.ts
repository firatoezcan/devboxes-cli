import * as prompts from "@clack/prompts";
import { intro, isCancel, log, note, outro, password, select, spinner, text } from "@clack/prompts";
import {
  loadContext,
  persistCredentialFileReferences,
  type DevboxesCliOptions,
  type DevboxesContext,
} from "@firops/connections/local/config";
import {
  codexChatgptSubscriptionDetected,
  discoverLocalOpencodeProviderCredentials,
  type DiscoveredOpencodeProviderCredential,
} from "@firops/connections/local/credential-discovery";
import {
  CredentialStoreUnreadableError,
  credentialStoreExists,
  readCredentialStore,
  removeLocalProviderCredentials,
  storeLocalProviderCredential,
  type LocalCredentialStore,
} from "@firops/connections/local/credential-store";
import {
  LocalRunnerOpencodeProviderAuthRuntime,
  type LocalCredentialStoreAccess,
} from "@firops/connections/local/local-provider-auth";
import type { OpencodeConnectorDescriptor } from "@firops/connections/provider-connect/descriptor-schema";
import {
  awaitOpencodeOauthDeviceFlow,
  startOpencodeOauthDeviceFlow,
} from "@firops/connections/provider-connect/flows";
import { dockerSocketPath, taskContainerApiBaseUrl } from "@firops/devbox/runner/docker-socket";
import { listenerRegistrationDeviceClientId } from "@firops/platform/protocol/frozen";
import { normalizeOpencodeProviderId } from "@firops/platform/protocol/provider-auth";
import { Command, InvalidArgumentError } from "commander";
import Docker from "dockerode";

import { ApiRequestError, apiRequestError, bearerBackend, cliVersion } from "../api";
import { deviceSessionToken, openBrowser } from "../devboxes";
import {
  credentialStoreAccess,
  fetchOpencodeConnectors,
  machineApiBackend,
  openCredentialStoreIfPresent,
  registerMachine,
} from "./backend";
import { playIntro } from "./intro";
import { listen } from "./listen";

type RunnerCliOptions = DevboxesCliOptions & {
  provider?: string;
  connect?: string;
  apiKey?: string;
  all: boolean;
  json?: boolean;
  live?: boolean;
  maxConcurrent?: number;
};

const runnerDeviceSessionToken = (context: DevboxesContext, purpose: string) =>
  deviceSessionToken(context.config, {
    clientId: listenerRegistrationDeviceClientId,
    scope: "runner",
    purpose,
  });

const listOrgOpencodeProviderCredentials = async (context: DevboxesContext) => {
  const result =
    await machineApiBackend(context).api.internal["runner-machines"]["org-credentials"].get();
  if (result.error) throw apiRequestError("Organization credentials", result.error, "connect");
  return {
    opencodeProviderCredentials: result.data?.opencodeProviderCredentials ?? [],
    queuedProviderIds: result.data?.queuedProviderIds ?? [],
  };
};

const saveCredentialFileReferences = async (
  context: DevboxesContext,
  selected: DiscoveredOpencodeProviderCredential[],
) => {
  const selectedProviderIds = await persistCredentialFileReferences(context, selected);
  log.success(
    `Saved local Opencode provider credential references for ${selectedProviderIds.join(", ")}.`,
  );
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
    const result = await awaitOpencodeOauthDeviceFlow(connector, started);

    const { recreatedStoreError } = await storeLocalProviderCredential({
      context,
      storeAccess,
      providerId: connector.providerId,
      entry: { auth: result.auth, accountLabel: result.accountLabel || undefined },
    });
    if (recreatedStoreError) {
      log.warn(`${recreatedStoreError} Storing a credential now recreates the store.`);
    }
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
  const { recreatedStoreError } = await storeLocalProviderCredential({
    context,
    storeAccess,
    providerId,
    entry: { auth: { type: "api", key: key.trim() } },
  });
  if (recreatedStoreError) {
    log.warn(`${recreatedStoreError} Storing a credential now recreates the store.`);
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
      `Queued runs need a provider that no connected runner can currently serve: ${[...neededProviderIds].join(", ")}.`,
    );
  }
  if (codexSubscription && !store.entries["openai"]) {
    log.info(
      "Codex has a ChatGPT subscription login. Its tokens stay with Codex. Connect ChatGPT Pro/Plus below to authorize Devboxes separately.",
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
      "No credentials are available to configure. Run `devboxes connect`, then `devboxes credentials setup` to connect a subscription or add an API key.",
    );
    return saved;
  }

  // One action per invocation: pick, run, done — re-run setup for the next
  // change instead of looping back to the menu.
  const choice = await select({
    message: "What would you like to do?",
    options: [
      ...actions.map((action, index) =>
        action.hint
          ? { value: index, label: action.label, hint: action.hint }
          : { value: index, label: action.label },
      ),
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
    outro(
      "Credential setup failed. Review the error, then run `devboxes credentials setup` again.",
    );
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

  const { credentials: discovered, warnings } = await discoverLocalOpencodeProviderCredentials(
    context.config.opencodeProviderCredentials ?? [],
  );
  for (const warning of warnings) log.warn(warning);

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

  const requestedProviders = options.provider
    ? new Set(
        options.provider
          .split(",")
          .map((providerId) => providerId.trim())
          .filter(Boolean),
      )
    : null;

  // Resolve every credential before the browser approval: a run that would
  // sync nothing must fail here, not after a pointless human approval.
  const runtime = new LocalRunnerOpencodeProviderAuthRuntime(references);
  const { syncable, skippedProviderIds } = await runtime.prepareOrganizationCredentialSync({
    store,
    requestedProviders,
  });
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
  for (const providerId of skippedProviderIds) {
    const connectable = connectableProviderIds.has(providerId);
    log.warn(
      `Skipped ${providerId}: only API-key credentials sync from CLI auth files.${
        connectable
          ? ` Use \`devboxes credentials setup --connect ${providerId}\` to connect the subscription on this device, then sync.`
          : ""
      }`,
    );
  }
  if (syncable.length === 0) {
    throw new Error(
      "No requested credentials could be synced. For a subscription, run `devboxes credentials setup --connect <provider>` on this device, then sync again.",
    );
  }

  log.step(
    "Sync uploads supported local credentials, including connected subscriptions, to encrypted organization storage. Eligible organization runners can use that access.",
  );
  // Credential sync always requires a fresh runner-scoped approval. A saved
  // terminal session is deliberately not reused for exporting local secrets.
  const sessionToken = await runnerDeviceSessionToken(context, "credential sync");
  const backend = bearerBackend(context.config.apiBaseUrl, sessionToken);
  const catalogResponse = await backend.api
    .org({ organizationId: context.config.organizationId })
    .credentials["opencode-provider-credentials"].get();
  if (catalogResponse.error) {
    throw apiRequestError("List Organization Provider Accounts", catalogResponse.error, "connect");
  }
  const apiKeyProviderIds = new Set<string>(
    catalogResponse.data?.apiKeyProviders.map((provider) => provider.id) ?? [],
  );
  const oauthProviderIds = new Set<string>(
    catalogResponse.data?.oauthProviders.map((provider) => provider.id) ?? [],
  );
  const supportedSyncable = syncable.filter(({ providerId, auth }) => {
    const supported =
      auth.type === "api" ? apiKeyProviderIds.has(providerId) : oauthProviderIds.has(providerId);
    if (!supported) {
      log.warn(
        `Skipped ${providerId}: this provider and auth type cannot be stored as an Organization Provider Account.`,
      );
    }
    return supported;
  });
  if (supportedSyncable.length === 0) {
    throw new Error("No local credentials match the supported Organization provider auth types.");
  }

  for (const { providerId, auth, accountLabel } of supportedSyncable) {
    const syncBody = {
      providerId,
      runnerMachineId: context.config.machineId,
      accountLabel,
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
      log.warn("No local model credentials are configured.");
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
  const storeAccess = (await credentialStoreExists(context.configPath))
    ? await credentialStoreAccess(context)
    : undefined;
  const { removedProviderIds, removedLegacyOpencodeReference, hadConfiguredCredentials } =
    await removeLocalProviderCredentials({
      context,
      all: options.all,
      requestedProviders,
      storeAccess,
    });
  if (removedProviderIds.length === 0) {
    if (removedLegacyOpencodeReference) {
      log.success("Removed ambiguous legacy OpenCode credentials for opencode-go.");
      log.info("Original credential files have not been deleted.");
      return;
    }
    log.warn(
      hadConfiguredCredentials
        ? "No saved local credentials match --provider."
        : "No local model credentials are configured.",
    );
    return;
  }
  log.success(`Removed local Opencode provider credentials for ${removedProviderIds.join(", ")}.`);
  log.info("Original credential files have not been deleted.");
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
        `Version: ${cliVersion}`,
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
          version: cliVersion,
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
    .description("register this machine to run Devboxes tasks")
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
    .description("check machine registration, Docker access, and credential readiness")
    .option("--live", "check stored subscriptions by refreshing them with their providers", false)
    .option("--json", "write runner health as JSON to stdout", false)
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
    .description("listen for queued tasks and run them in Docker on this machine")
    .option(
      "--max-concurrent <count>",
      "maximum number of tasks to run at the same time",
      positiveIntegerOption,
      1,
    )
    .action(async () => {
      const options = runnerOptions(listenCommand);
      await listen(await loadContext(options), options);
    });

  const credentialsCommand = program
    .command("credentials")
    .description("set up, inspect, share, or remove local model credentials");

  const setupCommand = credentialsCommand.command("setup");
  setupCommand
    .description("connect a subscription, store an API key, or reference a local auth file")
    .option("--provider <providers>", "comma-separated provider IDs")
    .option("--all", "save references to every discovered provider credential", false)
    .option(
      "--connect <provider>",
      // The connectable set is served by the dashboard, not compiled in; the
      // error path and the interactive menu enumerate the live list.
      "connect a subscription through browser approval; run setup without flags to list providers",
    )
    .option(
      "--api-key <provider>",
      "store a provider API key on this device; read the key from stdin when piped",
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
    .description("share supported local credentials through encrypted organization storage")
    .option("--provider <providers>", "comma-separated provider IDs")
    .action(async () => {
      const options = runnerOptions(syncCommand);
      await syncOpencodeProviderCredentials(await loadContext(options), {
        provider: options.provider,
      });
    });

  const statusCredentialsCommand = credentialsCommand.command("status");
  statusCredentialsCommand
    .description("show local model credential status")
    .option("--json", "write credential status as JSON to stdout", false)
    .action(async () => {
      const options = runnerOptions(statusCredentialsCommand);
      await showOpencodeProviderCredentialStatus(await loadContext(options), {
        json: options.json,
      });
    });

  const removeCommand = credentialsCommand.command("remove");
  removeCommand
    .description("remove local credentials or auth-file references")
    .option("--provider <providers>", "comma-separated provider IDs")
    .option("--all", "remove all saved local provider credentials and references", false)
    .action(async () => {
      const options = runnerOptions(removeCommand);
      await removeOpencodeProviderCredentials(await loadContext(options), {
        all: options.all ?? false,
        provider: options.provider,
      });
    });
};
