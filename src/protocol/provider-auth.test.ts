import { describe, expect, it } from "bun:test";

import {
  normalizeOpencodeProviderId,
  opencodeProviderAuthJsonKey,
  validateOpencodeProviderAuth,
} from "./provider-auth";

describe("normalizeOpencodeProviderId", () => {
  it("trims and lowercases valid provider ids", () => {
    expect(normalizeOpencodeProviderId("  OpenAI ")).toBe("openai");
    expect(normalizeOpencodeProviderId("amazon-bedrock")).toBe("amazon-bedrock");
    expect(normalizeOpencodeProviderId("z_ai2")).toBe("z_ai2");
    expect(normalizeOpencodeProviderId("0penai")).toBe("0penai");
  });

  it("rejects ids outside the constrained charset", () => {
    for (const providerId of [
      "",
      "   ",
      "open.ai",
      "openai/gpt",
      "-openai",
      "_openai",
      "open ai",
    ]) {
      expect(() => normalizeOpencodeProviderId(providerId)).toThrow(
        "Opencode provider id is invalid.",
      );
    }
  });
});

describe("validateOpencodeProviderAuth", () => {
  it("returns a normalized api auth with the key trimmed and extra fields stripped", () => {
    const auth = validateOpencodeProviderAuth("openai", {
      type: "api",
      key: "  sk-live  ",
      refresh: "stray-refresh-token",
    });
    expect(auth).toEqual({ type: "api", key: "sk-live" });
  });

  it("preserves string-record metadata", () => {
    const auth = validateOpencodeProviderAuth("openai", {
      type: "api",
      key: "sk-live",
      metadata: { project: "devboxes", region: "eu" },
    });
    expect(auth).toEqual({
      type: "api",
      key: "sk-live",
      metadata: { project: "devboxes", region: "eu" },
    });
  });

  it("rejects missing, empty, or non-string keys", () => {
    for (const key of [undefined, "", "   ", 42]) {
      expect(() => validateOpencodeProviderAuth("openai", { type: "api", key })).toThrow(
        "Opencode API credentials for provider openai are invalid.",
      );
    }
  });

  it("rejects non-string metadata values", () => {
    expect(() =>
      validateOpencodeProviderAuth("openai", {
        type: "api",
        key: "sk-live",
        metadata: { region: 7 },
      }),
    ).toThrow("Opencode API credential metadata for provider openai is invalid.");
  });

  it("returns a normalized oauth auth with extra fields stripped", () => {
    const auth = validateOpencodeProviderAuth("openai", {
      type: "oauth",
      refresh: "refresh-token",
      access: "access-token",
      expires: 1750000000000,
      accountId: "account-77",
      stray: "field",
    });
    expect(auth).toEqual({
      type: "oauth",
      refresh: "refresh-token",
      access: "access-token",
      expires: 1750000000000,
      accountId: "account-77",
    });
  });

  it("accepts never-expiring oauth entries and preserves the enterprise url", () => {
    const auth = validateOpencodeProviderAuth("github-copilot", {
      type: "oauth",
      refresh: "gho_token",
      access: "gho_token",
      expires: 0,
      enterpriseUrl: "company.ghe.com",
    });
    expect(auth).toEqual({
      type: "oauth",
      refresh: "gho_token",
      access: "gho_token",
      expires: 0,
      enterpriseUrl: "company.ghe.com",
    });
  });

  it("rejects oauth entries with missing or invalid token fields", () => {
    for (const auth of [
      { type: "oauth", refresh: "", access: "access", expires: 0 },
      { type: "oauth", refresh: "refresh", access: "", expires: 0 },
      { type: "oauth", refresh: "refresh", access: "access", expires: -1 },
      // Fractional expires would be silently dropped by opencode's auth.json
      // reader, surfacing as "no credential" — reject it at the boundary.
      { type: "oauth", refresh: "refresh", access: "access", expires: 1750000000000.5 },
      { type: "oauth", refresh: "refresh", access: "access" },
      { type: "oauth", access: "access", expires: 0 },
    ]) {
      expect(() => validateOpencodeProviderAuth("openai", auth)).toThrow(
        "Opencode OAuth credentials for provider openai are invalid.",
      );
    }
  });

  it("rejects auth types opencode providers cannot consume here", () => {
    for (const type of ["session", "wellknown"]) {
      expect(() => validateOpencodeProviderAuth("openai", { type, key: "sk-live" })).toThrow(
        "Opencode credentials for provider openai must be API-key or OAuth entries.",
      );
    }
  });

  it("rejects inputs that are not auth records", () => {
    for (const auth of [null, "api", 3, [], { type: "" }, {}]) {
      expect(() => validateOpencodeProviderAuth("openai", auth)).toThrow(
        "Opencode credentials for provider openai are invalid.",
      );
    }
  });
});

describe("opencodeProviderAuthJsonKey", () => {
  it("maps the opencode gateway to its well-known opencode-go auth key", () => {
    expect(opencodeProviderAuthJsonKey("opencode")).toBe("opencode-go");
  });

  it("keeps every other provider id as its own auth key", () => {
    expect(opencodeProviderAuthJsonKey("openai")).toBe("openai");
    expect(opencodeProviderAuthJsonKey("deepseek")).toBe("deepseek");
  });
});
