import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Only the vendor OAuth boundary is mocked: refresh calls target the live
// vendor token endpoints, which tests must never reach.
const refreshOpencodeOauthAccess = mock();
await mock.module("../provider-connect/flows", () => ({
  refreshOpencodeOauthAccess,
}));

const { LocalRunnerOpencodeProviderAuthRuntime } = await import("./local-provider-auth");
const { readCredentialStore, writeCredentialStore } = await import("./credential-store");
type OpencodeConnectorDescriptor =
  import("../provider-connect/descriptor-schema").OpencodeConnectorDescriptor;

// Served connector data is a boundary these tests own: the vendor flow module
// is mocked above, so descriptors only need to route refreshes by providerId.
const testConnectors: readonly OpencodeConnectorDescriptor[] = ["openai", "anthropic"].map(
  (providerId) => ({
    providerId,
    label: providerId,
    description: "",
    kind: "rfc8628-form",
    clientId: "test-client",
    scope: "test",
    deviceAuthorizationUrl: "https://vendor.invalid/device",
    tokenUrl: "https://vendor.invalid/token",
    verificationUrlHosts: ["vendor.invalid"],
    defaultDeviceCodeTtlSeconds: 300,
    refresh: { tokenUrl: "https://vendor.invalid/token", clientId: "test-client" },
  }),
);

describe("Opencode provider auth runtime", () => {
  let fixtureDir: string;
  let authFile: string;

  beforeEach(async () => {
    mock.clearAllMocks();
    fixtureDir = await mkdtemp(join(tmpdir(), "devboxes-provider-auth-runtime-"));
    authFile = join(fixtureDir, "auth.json");
  });

  afterEach(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it("returns only the selected provider auth entry from a local auth file", async () => {
    await writeFile(
      authFile,
      '{"openai":{"type":"api","key":"openai-key"},"anthropic":{"type":"api","key":"anthropic-key"}}',
    );

    const runtime = new LocalRunnerOpencodeProviderAuthRuntime([
      { providerId: "openai", authFile, source: "opencode-auth-file" },
    ]);

    expect(await runtime.providerAuthForProvider({ providerId: "openai" })).toEqual({
      openai: { type: "api", key: "openai-key" },
    });
  });

  it("serves OpenCode Zen and OpenCode Go under their exact provider ids", async () => {
    await writeFile(
      authFile,
      '{"opencode":{"type":"api","key":"zen-key"},"opencode-go":{"type":"api","key":"go-key"}}',
    );

    const runtime = new LocalRunnerOpencodeProviderAuthRuntime([
      {
        providerId: "opencode",
        authFile,
        source: "opencode-auth-file",
        providerIdFormat: "exact",
      },
      {
        providerId: "opencode-go",
        authFile,
        source: "opencode-auth-file",
      },
    ]);

    expect(await runtime.providerAuthForProvider({ providerId: "opencode" })).toEqual({
      opencode: { type: "api", key: "zen-key" },
    });
    expect(await runtime.providerAuthForProvider({ providerId: "opencode-go" })).toEqual({
      "opencode-go": { type: "api", key: "go-key" },
    });
  });

  it("reads OpenAI API-key credentials from a Codex auth cache", async () => {
    await writeFile(authFile, '{"auth_mode":"apikey","OPENAI_API_KEY":"codex-openai-key"}');

    const runtime = new LocalRunnerOpencodeProviderAuthRuntime([
      { providerId: "openai", authFile, source: "codex-auth-file" },
    ]);

    expect(await runtime.providerAuthForProvider({ providerId: "openai" })).toEqual({
      openai: { type: "api", key: "codex-openai-key" },
    });
  });

  it("reports missing provider credentials without returning another provider", async () => {
    await writeFile(authFile, '{"anthropic":{"type":"api","key":"anthropic-key"}}');

    const runtime = new LocalRunnerOpencodeProviderAuthRuntime([
      { providerId: "openai", authFile, source: "opencode-auth-file" },
    ]);

    await assert.rejects(
      runtime.providerAuthForProvider({ providerId: "openai" }),
      /Opencode credentials for provider openai are not configured\./,
    );
  });

  it("serves local OAuth credentials for the selected provider", async () => {
    await writeFile(
      authFile,
      '{"openai":{"type":"oauth","refresh":"refresh-1","access":"access-1","expires":1750000000000,"accountId":"account-1"}}',
    );

    const runtime = new LocalRunnerOpencodeProviderAuthRuntime([
      { providerId: "openai", authFile, source: "opencode-auth-file" },
    ]);

    expect(await runtime.providerAuthForProvider({ providerId: "openai" })).toEqual({
      openai: {
        type: "oauth",
        refresh: "refresh-1",
        access: "access-1",
        expires: 1750000000000,
        accountId: "account-1",
      },
    });
  });

  it("rejects auth types opencode cannot consume", async () => {
    await writeFile(authFile, '{"anthropic":{"type":"session","token":"provider-token"}}');

    const runtime = new LocalRunnerOpencodeProviderAuthRuntime([
      { providerId: "anthropic", authFile, source: "opencode-auth-file" },
    ]);

    await assert.rejects(
      runtime.providerAuthForProvider({ providerId: "anthropic" }),
      /Opencode credentials for provider anthropic must be API-key or OAuth entries\./,
    );
  });

  it("rejects account-backed entries", async () => {
    await writeFile(
      authFile,
      '{"openai":{"type":"account","key":"provider-account","token":"provider-token"}}',
    );

    const runtime = new LocalRunnerOpencodeProviderAuthRuntime([
      { providerId: "openai", authFile, source: "opencode-auth-file" },
    ]);

    await assert.rejects(
      runtime.providerAuthForProvider({ providerId: "openai" }),
      /Opencode credentials for provider openai must be API-key or OAuth entries\./,
    );
  });

  it("reports missing local auth files without leaking the host path", async () => {
    const missingAuthFile = join(fixtureDir, "missing-auth.json");
    const runtime = new LocalRunnerOpencodeProviderAuthRuntime([
      { providerId: "openai", authFile: missingAuthFile, source: "opencode-auth-file" },
    ]);

    await assert.rejects(runtime.providerAuthForProvider({ providerId: "openai" }), (error) => {
      expect(String(error)).toContain("credentials setup --provider openai");
      expect(String(error)).not.toContain(missingAuthFile);
      return true;
    });
  });

  it("treats a ChatGPT-mode codex auth cache as unconfigured instead of unreadable", async () => {
    await writeFile(
      authFile,
      '{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"refresh_token":"rt"}}',
    );
    const runtime = new LocalRunnerOpencodeProviderAuthRuntime([
      { providerId: "openai", authFile, source: "codex-auth-file" },
    ]);

    await assert.rejects(
      runtime.providerAuthForProvider({ providerId: "openai" }),
      /Opencode credentials for provider openai are not configured\./,
    );
  });

  it("serves fresh store credentials over file references without refreshing", async () => {
    await writeFile(authFile, '{"openai":{"type":"api","key":"file-key"}}');
    const configPath = join(fixtureDir, "config.json");
    const passphrase = "runtime-store-passphrase";
    const freshAuth = {
      type: "oauth" as const,
      refresh: "store-refresh",
      access: "store-access",
      expires: Date.now() + 3_600_000,
    };
    await writeCredentialStore({
      configPath,
      passphrase,
      store: { entries: { openai: { auth: freshAuth } } },
    });

    const runtime = new LocalRunnerOpencodeProviderAuthRuntime(
      [{ providerId: "openai", authFile, source: "opencode-auth-file" }],
      { configPath, passphrase },
    );

    expect(await runtime.providerAuthForProvider({ providerId: "openai" })).toEqual({
      openai: freshAuth,
    });
    expect(refreshOpencodeOauthAccess).not.toHaveBeenCalled();
  });

  it("refreshes an expiring store OAuth entry once and persists the rotation", async () => {
    const configPath = join(fixtureDir, "config.json");
    const passphrase = "runtime-store-passphrase";
    await writeCredentialStore({
      configPath,
      passphrase,
      store: {
        entries: {
          openai: {
            auth: {
              type: "oauth",
              refresh: "old-refresh",
              access: "old-access",
              expires: Date.now() + 60_000,
              accountId: "chatgpt-account",
            },
            accountLabel: "user@example.com",
          },
        },
      },
    });
    const rotatedExpiry = Date.now() + 3_600_000;
    refreshOpencodeOauthAccess.mockImplementation(async () => ({
      auth: {
        type: "oauth",
        refresh: "new-refresh",
        access: "new-access",
        expires: rotatedExpiry,
        accountId: "chatgpt-account",
      },
    }));

    const runtime = new LocalRunnerOpencodeProviderAuthRuntime(
      [],
      { configPath, passphrase },
      async () => testConnectors,
    );
    const [first, second] = await Promise.all([
      runtime.providerAuthForProvider({ providerId: "openai" }),
      runtime.providerAuthForProvider({ providerId: "openai" }),
    ]);

    // Single-flight: concurrent task boots share one vendor refresh.
    expect(refreshOpencodeOauthAccess).toHaveBeenCalledTimes(1);
    expect(first.openai).toMatchObject({ refresh: "new-refresh", access: "new-access" });
    expect(second.openai).toMatchObject({ refresh: "new-refresh" });
    const persisted = await readCredentialStore({ configPath, passphrase });
    expect(persisted.entries.openai).toMatchObject({
      auth: { refresh: "new-refresh", access: "new-access", expires: rotatedExpiry },
      accountLabel: "user@example.com",
    });
  });

  it("does not clobber a concurrently re-connected family when persisting a refresh", async () => {
    const configPath = join(fixtureDir, "config.json");
    const passphrase = "runtime-store-passphrase";
    await writeCredentialStore({
      configPath,
      passphrase,
      store: {
        entries: {
          openai: {
            auth: {
              type: "oauth",
              refresh: "old-refresh",
              access: "old-access",
              expires: Date.now() + 60_000,
            },
          },
        },
      },
    });
    const reconnectedAuth = {
      type: "oauth" as const,
      refresh: "reconnected-refresh",
      access: "reconnected-access",
      expires: Date.now() + 7_200_000,
    };
    refreshOpencodeOauthAccess.mockImplementation(async () => {
      // A concurrent `credentials setup --connect` finishes mid-vendor-call
      // and lands a brand-new token family in the store.
      await writeCredentialStore({
        configPath,
        passphrase,
        store: { entries: { openai: { auth: reconnectedAuth } } },
      });
      return {
        auth: {
          type: "oauth",
          refresh: "rotated-old-refresh",
          access: "rotated-old-access",
          expires: Date.now() + 3_600_000,
        },
      };
    });

    const runtime = new LocalRunnerOpencodeProviderAuthRuntime(
      [],
      { configPath, passphrase },
      async () => testConnectors,
    );
    const served = await runtime.providerAuthForProvider({ providerId: "openai" });

    // The vendor result still serves this task, but the fresh family wins on disk.
    expect(served.openai).toMatchObject({ refresh: "rotated-old-refresh" });
    const persisted = await readCredentialStore({ configPath, passphrase });
    expect(persisted.entries.openai?.auth).toEqual(reconnectedAuth);
  });

  it("keep-alive sweep refreshes only families expiring inside the window and never throws", async () => {
    const configPath = join(fixtureDir, "config.json");
    const passphrase = "runtime-store-passphrase";
    const freshExpiry = Date.now() + 3 * 3_600_000;
    await writeCredentialStore({
      configPath,
      passphrase,
      store: {
        entries: {
          openai: {
            auth: {
              type: "oauth",
              refresh: "idle-refresh",
              access: "idle-access",
              expires: Date.now() + 30 * 60 * 1000,
            },
          },
          anthropic: {
            auth: {
              type: "oauth",
              refresh: "fresh-refresh",
              access: "fresh-access",
              expires: freshExpiry,
            },
          },
          xai: { auth: { type: "api", key: "xai-key" } },
        },
      },
    });
    const keptAliveExpiry = Date.now() + 3_600_000;
    refreshOpencodeOauthAccess.mockImplementation(async () => ({
      auth: {
        type: "oauth",
        refresh: "kept-alive-refresh",
        access: "kept-alive-access",
        expires: keptAliveExpiry,
      },
    }));

    const runtime = new LocalRunnerOpencodeProviderAuthRuntime(
      [],
      { configPath, passphrase },
      async () => testConnectors,
    );
    await runtime.refreshExpiringStoredCredentials({ windowMs: 70 * 60 * 1000 });

    expect(refreshOpencodeOauthAccess).toHaveBeenCalledTimes(1);
    const persisted = await readCredentialStore({ configPath, passphrase });
    expect(persisted.entries.openai?.auth).toMatchObject({ refresh: "kept-alive-refresh" });
    expect(persisted.entries.anthropic?.auth).toMatchObject({
      refresh: "fresh-refresh",
      expires: freshExpiry,
    });
    expect(persisted.entries.xai?.auth).toEqual({ type: "api", key: "xai-key" });

    // A definitive rejection is logged, not thrown — a rejecting sweep would
    // take the whole listen process down from inside the cron callback.
    refreshOpencodeOauthAccess.mockImplementation(async () => ({ error: "invalid_grant." }));
    await runtime.refreshExpiringStoredCredentials({ windowMs: 24 * 3_600_000 });
    expect(
      (await readCredentialStore({ configPath, passphrase })).entries.openai?.auth,
    ).toMatchObject({ refresh: "kept-alive-refresh" });
  });
});
