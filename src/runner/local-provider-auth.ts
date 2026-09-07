import { readFile } from "node:fs/promises";

import Type from "typebox";
import Value from "typebox/value";

import {
  OpencodeProviderAuthResponseSchema,
  validateOpencodeProviderAuth,
  type OpencodeProviderAuthJson,
  type OpencodeProviderAuthSourceValue,
} from "../protocol/provider-auth";
import type { OpencodeConnectorDescriptor } from "../provider-connect/descriptor-schema";
import { refreshOpencodeOauthAccess } from "../provider-connect/flows";
import {
  ambiguousOpencodeCredentialMessage,
  readCredentialStore,
  writeCredentialStore,
} from "./credential-store";

export type LocalOpencodeProviderCredentialReference = {
  providerId: string;
  authFile: string;
  source: "opencode-auth-file" | "codex-auth-file";
  providerIdFormat?: "exact";
};

export type LocalCredentialStoreAccess = { configPath: string; passphrase: string };

type OAuth = Extract<OpencodeProviderAuthJson[string], { type: "oauth" }>;

// ChatGPT-subscription codex logins carry a literal null API key next to their
// OAuth tokens, so the field must tolerate null for the file to parse at all.
const CodexAuthCacheSchema = Type.Object(
  { OPENAI_API_KEY: Type.Optional(Type.Union([Type.String(), Type.Null()])) },
  { additionalProperties: true },
);

// Local OAuth is refreshed before its credential is advertised for a claim.
// The claimed task then keeps that exact material; `expires: 0` marks tokens
// that never expire.
const refreshSkewMs = 10 * 60 * 1000;

export class LocalRunnerOpencodeProviderAuthRuntime {
  private readonly pendingRefreshes = new Map<string, Promise<OAuth>>();

  constructor(
    private readonly credentials: LocalOpencodeProviderCredentialReference[],
    private readonly storeAccess?: LocalCredentialStoreAccess,
    // How vendor endpoints reach a shipped binary: connector descriptors are
    // served by the dashboard per use, never compiled in — a vendor moving an
    // endpoint must not rot binaries in the wild. Only store-backed OAuth
    // refreshes consult it, so reference-only runtimes omit it.
    private readonly fetchConnectors?: () => Promise<readonly OpencodeConnectorDescriptor[]>,
  ) {}

  async providerAuthForProvider(input: { providerId: string }): Promise<OpencodeProviderAuthJson> {
    // The store holds the runner's own token families and outranks file
    // references: store OAuth refreshes in place, while a foreign CLI's auth
    // file must be served untouched.
    if (this.storeAccess) {
      const entry = (await readCredentialStore(this.storeAccess)).entries[input.providerId];
      if (entry) {
        const auth = entry.auth;
        if (
          auth.type !== "oauth" ||
          auth.expires === 0 ||
          auth.expires > Date.now() + refreshSkewMs
        ) {
          return { [input.providerId]: auth };
        }
        return {
          [input.providerId]: await this.singleFlightRefresh(
            this.storeAccess,
            input.providerId,
            auth,
          ),
        };
      }
    }

    const credential = this.credentials.find((entry) => entry.providerId === input.providerId);
    if (!credential) {
      throw new Error(`Opencode credentials for provider ${input.providerId} are not configured.`);
    }
    if (input.providerId === "opencode" && credential.providerIdFormat !== "exact") {
      throw new Error(ambiguousOpencodeCredentialMessage);
    }

    let auth: OpencodeProviderAuthSourceValue;
    try {
      const parsed = JSON.parse(await readFile(credential.authFile, "utf8"));
      if (credential.source === "codex-auth-file") {
        const authCache = Value.Parse(CodexAuthCacheSchema, parsed);
        const codexApiKey = authCache.OPENAI_API_KEY;
        auth =
          input.providerId === "openai" && codexApiKey?.trim()
            ? { type: "api", key: codexApiKey }
            : undefined;
      } else {
        auth = Value.Parse(OpencodeProviderAuthResponseSchema, parsed)[input.providerId];
      }
    } catch {
      throw new Error(
        `Local provider credential file for provider ${input.providerId} is unavailable. Run \`devboxes credentials setup --provider ${input.providerId}\` again, then restart \`devboxes listen\`.`,
      );
    }

    if (!auth) {
      throw new Error(`Opencode credentials for provider ${input.providerId} are not configured.`);
    }

    return {
      [input.providerId]: validateOpencodeProviderAuth(input.providerId, auth),
    };
  }

  // Idle keep-alive sweep for the `listen` cron (which ignores the returned
  // outcomes) and the proof-of-life half of `doctor --live` (which reports
  // them). Claim-time refresh cannot keep an idle token family alive. Never
  // throws — a cron callback that rejects would take the runner down.
  async refreshExpiringStoredCredentials(input: {
    windowMs: number;
    silent?: boolean;
  }): Promise<Array<{ providerId: string; ok: boolean; error?: string }>> {
    if (!this.storeAccess) return [];
    const storeAccess = this.storeAccess;
    const outcomes: Array<{ providerId: string; ok: boolean; error?: string }> = [];
    try {
      const entries = (await readCredentialStore(storeAccess)).entries;
      for (const [providerId, entry] of Object.entries(entries)) {
        const auth = entry.auth;
        if (auth.type !== "oauth" || auth.expires === 0) continue;
        if (auth.expires > Date.now() + input.windowMs) continue;
        try {
          await this.singleFlightRefresh(storeAccess, providerId, auth);
          if (!input.silent) {
            console.info(`Refreshed stored ${providerId} credentials ahead of expiry.`);
          }
          outcomes.push({ providerId, ok: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!input.silent) {
            console.error(`Scheduled refresh for provider ${providerId} failed: ${message}`);
          }
          outcomes.push({ providerId, ok: false, error: message });
        }
      }
    } catch (error) {
      if (!input.silent) {
        console.error(
          `Scheduled credential refresh skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return outcomes;
  }

  // Single-flight per provider: concurrent task boots (and the keep-alive
  // sweep) must not race two vendor refreshes against one rotating family.
  private singleFlightRefresh(
    storeAccess: LocalCredentialStoreAccess,
    providerId: string,
    auth: OAuth,
  ) {
    let pending = this.pendingRefreshes.get(providerId);
    if (!pending) {
      pending = this.refreshStoredOauth(storeAccess, providerId, auth).finally(() => {
        this.pendingRefreshes.delete(providerId);
      });
      this.pendingRefreshes.set(providerId, pending);
    }
    return pending;
  }

  private async refreshStoredOauth(
    storeAccess: LocalCredentialStoreAccess,
    providerId: string,
    auth: OAuth,
  ) {
    // A descriptor fetch failure is a dashboard blip, exactly as transient as
    // a vendor 5xx; a served list without this provider is definitive.
    let connectors: readonly OpencodeConnectorDescriptor[];
    try {
      connectors = this.fetchConnectors ? await this.fetchConnectors() : [];
    } catch (error) {
      throw new Error(`Opencode credentials for provider ${providerId} could not be refreshed.`, {
        cause: error,
      });
    }
    const connector = connectors.find((candidate) => candidate.providerId === providerId);
    if (!connector) {
      throw new Error(
        `Opencode credentials for provider ${providerId} have no connector to refresh with. Run \`devboxes credentials setup --connect ${providerId}\` to reconnect.`,
      );
    }
    let refreshed: Awaited<ReturnType<typeof refreshOpencodeOauthAccess>>;
    try {
      refreshed = await refreshOpencodeOauthAccess(connector, { auth });
    } catch (error) {
      throw new Error(`Opencode credentials for provider ${providerId} could not be refreshed.`, {
        cause: error,
      });
    }
    if ("error" in refreshed) {
      throw new Error(
        `Opencode credentials for provider ${providerId} were rejected on refresh: ${refreshed.error} Run \`devboxes credentials setup --connect ${providerId}\` to reconnect.`,
      );
    }
    const store = await readCredentialStore(storeAccess);
    const currentEntry = store.entries[providerId];
    // Persist only while the entry still holds the family we refreshed: a
    // concurrent `credentials setup` re-connect mints a fresh family that a
    // rotation of the old one must not clobber (the file-level analog of the
    // dashboard route's ciphertext guard).
    if (currentEntry?.auth.type === "oauth" && currentEntry.auth.refresh === auth.refresh) {
      const accountLabel = refreshed.accountLabel ?? currentEntry.accountLabel;
      store.entries[providerId] =
        accountLabel === undefined
          ? { auth: refreshed.auth }
          : { auth: refreshed.auth, accountLabel };
      await writeCredentialStore({ ...storeAccess, store });
    }
    return refreshed.auth;
  }
}
