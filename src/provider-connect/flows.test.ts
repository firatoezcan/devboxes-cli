import { afterEach, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";

import { opencodeProviderConnectors } from "./descriptors";
import {
  pollOpencodeOauthDeviceFlow,
  startOpencodeOauthDeviceFlow,
} from "./flows";

const openaiConnector = opencodeProviderConnectors.find(
  (connector) => connector.providerId === "openai",
);
const copilotConnector = opencodeProviderConnectors.find(
  (connector) => connector.providerId === "github-copilot",
);
const xaiConnector = opencodeProviderConnectors.find((connector) => connector.providerId === "xai");
assert(openaiConnector?.kind === "openai-device");
assert(copilotConnector?.kind === "github-device");
assert(xaiConnector?.kind === "rfc8628-form");

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type StubHandler = (url: string, init?: RequestInit) => Response;
type TestJwtClaims = {
  email?: string;
  sub?: string;
  "https://api.openai.com/auth"?: { chatgpt_account_id: string };
};

const stubFetch = (handler: StubHandler) => {
  const requests: Array<{ url: string; body: string }> = [];
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({
        url: request.url,
        body: await request.text(),
      });
      return handler(request.url, init);
    },
    {
      preconnect: (...args: Parameters<typeof originalFetch.preconnect>) =>
        originalFetch.preconnect(...args),
    },
  );
  return requests;
};

const fakeJwt = (payload: TestJwtClaims) => {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encodedPayload}.signature`;
};

describe("ChatGPT device flow", () => {
  test("start returns the user code and stores the device grant in the payload", async () => {
    const requests = stubFetch(() =>
      Response.json({ device_auth_id: "device-auth-1", user_code: "ABCD-1234", interval: "7" }),
    );

    const start = await startOpencodeOauthDeviceFlow(openaiConnector);

    expect(requests[0]?.url).toBe("https://auth.openai.com/api/accounts/deviceauth/usercode");
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    });
    expect(start.userCode).toBe("ABCD-1234");
    expect(start.verificationUrl).toBe("https://auth.openai.com/codex/device");
    expect(start.intervalSeconds).toBe(7);
    expect(start.payload).toEqual({
      kind: "openai-device",
      deviceAuthId: "device-auth-1",
      userCode: "ABCD-1234",
    });
  });

  test("a fractional string interval rounds up instead of polling early", async () => {
    stubFetch(() =>
      Response.json({ device_auth_id: "device-auth-1", user_code: "ABCD-1234", interval: "7.5" }),
    );

    const start = await startOpencodeOauthDeviceFlow(openaiConnector);

    expect(start.intervalSeconds).toBe(8);
  });

  test("unapproved codes answer pending on 403 and 404", async () => {
    for (const status of [403, 404]) {
      stubFetch(() => new Response("denied", { status }));
      const result = await pollOpencodeOauthDeviceFlow(
        openaiConnector,
        {
          kind: "openai-device",
          deviceAuthId: "device-auth-1",
          userCode: "ABCD-1234",
        },
        5,
      );
      expect(result).toEqual({ status: "pending", intervalSeconds: 5 });
    }
  });

  test("approved poll exchanges the authorization code for an opencode oauth entry", async () => {
    const accessToken = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-77" },
    });
    const idToken = fakeJwt({ email: "dev@example.com" });
    const requests = stubFetch((url) => {
      if (url.endsWith("/deviceauth/token")) {
        return Response.json({ authorization_code: "auth-code-1", code_verifier: "verifier-1" });
      }
      return Response.json({
        access_token: accessToken,
        refresh_token: "refresh-1",
        id_token: idToken,
        expires_in: 1800,
      });
    });

    const result = await pollOpencodeOauthDeviceFlow(
      openaiConnector,
      {
        kind: "openai-device",
        deviceAuthId: "device-auth-1",
        userCode: "ABCD-1234",
      },
      5,
    );

    const exchange = requests[1];
    expect(exchange?.url).toBe("https://auth.openai.com/oauth/token");
    const exchangeBody = new URLSearchParams(exchange?.body);
    expect(exchangeBody.get("grant_type")).toBe("authorization_code");
    expect(exchangeBody.get("code")).toBe("auth-code-1");
    expect(exchangeBody.get("code_verifier")).toBe("verifier-1");
    expect(exchangeBody.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");

    if (result.status !== "completed") throw new Error(`Expected completion, got ${result.status}`);
    expect(result.auth.type).toBe("oauth");
    expect(result.auth.refresh).toBe("refresh-1");
    expect(result.auth.access).toBe(accessToken);
    expect(result.auth.expires).toBeGreaterThan(Date.now());
    expect(result.auth.accountId).toBe("account-77");
    expect(result.accountLabel).toBe("dev@example.com");
  });

  test("token exchange rejection fails the attempt", async () => {
    stubFetch((url) =>
      url.endsWith("/deviceauth/token")
        ? Response.json({ authorization_code: "auth-code-1", code_verifier: "verifier-1" })
        : new Response("nope", { status: 400 }),
    );

    const result = await pollOpencodeOauthDeviceFlow(
      openaiConnector,
      {
        kind: "openai-device",
        deviceAuthId: "device-auth-1",
        userCode: "ABCD-1234",
      },
      5,
    );
    expect(result.status).toBe("failed");
  });

  test("an exchange without a refresh token fails instead of storing a dead credential", async () => {
    stubFetch((url) =>
      url.endsWith("/deviceauth/token")
        ? Response.json({ authorization_code: "auth-code-1", code_verifier: "verifier-1" })
        : Response.json({ access_token: "access-1", expires_in: 3600 }),
    );

    const result = await pollOpencodeOauthDeviceFlow(
      openaiConnector,
      {
        kind: "openai-device",
        deviceAuthId: "device-auth-1",
        userCode: "ABCD-1234",
      },
      5,
    );
    expect(result).toEqual({ status: "failed" });
  });

  test("an off-schema vendor body is rejected", async () => {
    stubFetch(() => Response.json({ nonsense: true }));

    await assert.rejects(startOpencodeOauthDeviceFlow(openaiConnector));
  });

  test("vendor 5xx during a poll is transient, not a failed attempt", async () => {
    stubFetch(() => new Response("bad gateway", { status: 502 }));
    await assert.rejects(
      pollOpencodeOauthDeviceFlow(
        openaiConnector,
        {
          kind: "openai-device",
          deviceAuthId: "device-auth-1",
          userCode: "ABCD-1234",
        },
        5,
      ),
      /502/,
    );
    await assert.rejects(
      pollOpencodeOauthDeviceFlow(
        copilotConnector,
        {
          kind: "github-device",
          deviceCode: "device-code-1",
        },
        5,
      ),
      /502/,
    );
  });
});

describe("GitHub Copilot device flow", () => {
  test("start on github.com returns the vendor verification data", async () => {
    const requests = stubFetch(() =>
      Response.json({
        verification_uri: "https://github.com/login/device",
        user_code: "WXYZ-9876",
        device_code: "device-code-1",
        interval: 6,
        expires_in: 900,
      }),
    );

    const start = await startOpencodeOauthDeviceFlow(copilotConnector);

    expect(requests[0]?.url).toBe("https://github.com/login/device/code");
    expect(Object.fromEntries(new URLSearchParams(requests[0]?.body))).toEqual({
      client_id: "Ov23li8tweQw6odWQebz",
      scope: "read:user",
    });
    expect(start.userCode).toBe("WXYZ-9876");
    expect(start.verificationUrl).toBe("https://github.com/login/device");
    expect(start.expiresAtMs).toBeLessThanOrEqual(Date.now() + 900 * 1000);
    expect(start.payload).toEqual({
      kind: "github-device",
      deviceCode: "device-code-1",
    });
  });

  test("pending and slow_down answers stay pending with adjusted intervals", async () => {
    stubFetch(() => Response.json({ error: "authorization_pending" }));
    expect(
      await pollOpencodeOauthDeviceFlow(
        copilotConnector,
        {
          kind: "github-device",
          deviceCode: "device-code-1",
        },
        5,
      ),
    ).toEqual({ status: "pending", intervalSeconds: 5 });

    stubFetch(() => Response.json({ error: "slow_down", interval: 12 }));
    expect(
      await pollOpencodeOauthDeviceFlow(
        copilotConnector,
        {
          kind: "github-device",
          deviceCode: "device-code-1",
        },
        5,
      ),
    ).toEqual({ status: "pending", intervalSeconds: 12 });

    stubFetch(() => Response.json({ error: "slow_down" }));
    expect(
      await pollOpencodeOauthDeviceFlow(
        copilotConnector,
        {
          kind: "github-device",
          deviceCode: "device-code-1",
        },
        900,
      ),
    ).toEqual({ status: "pending", intervalSeconds: 905 });
  });

  test("approval proves Copilot token minting before storing the github oauth entry", async () => {
    stubFetch((url) =>
      url.endsWith("/login/oauth/access_token")
        ? Response.json({ access_token: "gho_token" })
        : url.endsWith("/copilot_internal/v2/token")
          ? Response.json({ token: "copilot-api-token" })
          : Response.json(
              { id: 4217, login: "debug-owner" },
              { headers: { "x-oauth-scopes": "read:user" } },
            ),
    );

    const result = await pollOpencodeOauthDeviceFlow(
      copilotConnector,
      {
        kind: "github-device",
        deviceCode: "device-code-1",
      },
      5,
    );

    if (result.status !== "completed") throw new Error(`Expected completion, got ${result.status}`);
    expect(result.auth).toEqual({
      type: "oauth",
      refresh: "gho_token",
      access: "gho_token",
      expires: 0,
    });
    expect(result.accountExternalId).toBe("4217");
    expect(result.accountLabel).toBe("debug-owner");
  });

  test("rejects a github identity that cannot mint a Copilot execution token", async () => {
    stubFetch((url) =>
      url.endsWith("/login/oauth/access_token")
        ? Response.json({ access_token: "gho_token" })
        : url.endsWith("/copilot_internal/v2/token")
          ? Response.json({ message: "Copilot access is not available" }, { status: 403 })
          : Response.json(
              { id: 4217, login: "debug-owner" },
              { headers: { "x-oauth-scopes": "read:user" } },
            ),
    );

    expect(
      await pollOpencodeOauthDeviceFlow(
        copilotConnector,
        {
          kind: "github-device",
          deviceCode: "device-code-1",
        },
        5,
      ),
    ).toEqual({ status: "failed", reason: "insufficient-scope" });
  });

  test("denial fails the attempt", async () => {
    stubFetch(() =>
      Response.json({ error: "access_denied", error_description: "The user denied access." }),
    );

    const result = await pollOpencodeOauthDeviceFlow(
      copilotConnector,
      {
        kind: "github-device",
        deviceCode: "device-code-1",
      },
      5,
    );
    expect(result).toEqual({ status: "failed" });
  });

  test("slow vendor polling intervals are honored", async () => {
    stubFetch(() =>
      Response.json({
        verification_uri: "https://github.com/login/device",
        user_code: "WXYZ-9876",
        device_code: "device-code-1",
        interval: 240,
        expires_in: 3600,
      }),
    );

    const start = await startOpencodeOauthDeviceFlow(copilotConnector);

    expect(start.intervalSeconds).toBe(240);
  });

  test("a zero or missing interval falls back instead of polling every second", async () => {
    stubFetch(() =>
      Response.json({
        verification_uri: "https://github.com/login/device",
        user_code: "WXYZ-9876",
        device_code: "device-code-1",
        interval: 0,
      }),
    );

    const start = await startOpencodeOauthDeviceFlow(copilotConnector);
    expect(start.intervalSeconds).toBe(5);
  });

  test("a verification URL off the answering domain is rejected", async () => {
    stubFetch(() =>
      Response.json({
        verification_uri: "https://evil.example.com/login/device",
        user_code: "WXYZ-9876",
        device_code: "device-code-1",
        interval: 5,
      }),
    );

    await assert.rejects(
      startOpencodeOauthDeviceFlow(copilotConnector),
      /unexpected verification URL/,
    );
  });

  test("a token-less, error-less answer stays pending like opencode's own loop", async () => {
    stubFetch(() => Response.json({}));

    expect(
      await pollOpencodeOauthDeviceFlow(
        copilotConnector,
        {
          kind: "github-device",
          deviceCode: "device-code-1",
        },
        5,
      ),
    ).toEqual({ status: "pending", intervalSeconds: 5 });
  });
});

describe("xAI Grok device flow", () => {
  test("preserves a provider interval above 900 seconds through slow_down", async () => {
    const vendor = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/device") {
          return Response.json({
            device_code: "xai-device-code",
            user_code: "GROK-1234",
            verification_uri: "https://accounts.x.ai/activate",
            interval: 1600,
          });
        }
        return Response.json({ error: "slow_down" }, { status: 400 });
      },
    });
    const connector = {
      ...xaiConnector,
      deviceAuthorizationUrl: new URL("/device", vendor.url).href,
      tokenUrl: new URL("/token", vendor.url).href,
    };

    try {
      const started = await startOpencodeOauthDeviceFlow(connector);
      expect(started.intervalSeconds).toBe(1600);
      expect(
        await pollOpencodeOauthDeviceFlow(connector, started.payload, started.intervalSeconds),
      ).toEqual({ status: "pending", intervalSeconds: 1605 });
    } finally {
      await vendor.stop(true);
    }
  });

  test("start requests a device code from the Grok-CLI client", async () => {
    const requests = stubFetch(() =>
      Response.json({
        device_code: "xai-device-code",
        user_code: "GROK-1234",
        verification_uri: "https://accounts.x.ai/activate",
        verification_uri_complete: "https://accounts.x.ai/activate?user_code=GROK-1234",
        expires_in: 300,
        interval: 5,
      }),
    );

    const start = await startOpencodeOauthDeviceFlow(xaiConnector);

    expect(requests[0]?.url).toBe("https://auth.x.ai/oauth2/device/code");
    const startBody = new URLSearchParams(requests[0]?.body);
    expect(startBody.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
    expect(startBody.get("scope")).toBe(
      "openid profile email offline_access grok-cli:access api:access",
    );
    expect(start.userCode).toBe("GROK-1234");
    expect(start.verificationUrl).toBe("https://accounts.x.ai/activate?user_code=GROK-1234");
    expect(start.expiresAtMs).toBeGreaterThan(Date.now());
    expect(start.expiresAtMs).toBeLessThanOrEqual(Date.now() + 300 * 1000);
    expect(start.payload).toEqual({
      kind: "rfc8628-form",
      deviceCode: "xai-device-code",
    });
  });

  test("a verification URL off x.ai is rejected", async () => {
    stubFetch(() =>
      Response.json({
        device_code: "xai-device-code",
        user_code: "GROK-1234",
        verification_uri: "https://accounts.x.ai/activate",
        verification_uri_complete: "https://evil.example.com/activate?user_code=GROK-1234",
        interval: 5,
      }),
    );

    await assert.rejects(startOpencodeOauthDeviceFlow(xaiConnector), /unexpected verification URL/);
  });

  test("RFC 8628 error answers map to pending, slow_down, denied, and expired", async () => {
    stubFetch(() => Response.json({ error: "authorization_pending" }, { status: 400 }));
    expect(
      await pollOpencodeOauthDeviceFlow(
        xaiConnector,
        {
          kind: "rfc8628-form",
          deviceCode: "xai-device-code",
        },
        5,
      ),
    ).toEqual({ status: "pending", intervalSeconds: 5 });

    stubFetch(() => Response.json({ error: "slow_down" }, { status: 400 }));
    expect(
      await pollOpencodeOauthDeviceFlow(
        xaiConnector,
        {
          kind: "rfc8628-form",
          deviceCode: "xai-device-code",
        },
        5,
      ),
    ).toEqual({ status: "pending", intervalSeconds: 10 });

    stubFetch(() => Response.json({ error: "access_denied" }, { status: 400 }));
    expect(
      await pollOpencodeOauthDeviceFlow(
        xaiConnector,
        {
          kind: "rfc8628-form",
          deviceCode: "xai-device-code",
        },
        5,
      ),
    ).toEqual({ status: "failed" });

    stubFetch(() => Response.json({ error: "expired_token" }, { status: 400 }));
    expect(
      await pollOpencodeOauthDeviceFlow(
        xaiConnector,
        {
          kind: "rfc8628-form",
          deviceCode: "xai-device-code",
        },
        5,
      ),
    ).toEqual({ status: "failed" });
  });

  test("approval exchanges the device code for a rotating opencode oauth entry", async () => {
    const idToken = fakeJwt({ email: "grok@example.com", sub: "xai-debug-account" });
    const requests = stubFetch(() =>
      Response.json({
        access_token: "xai-access-1",
        refresh_token: "xai-refresh-1",
        id_token: idToken,
        expires_in: 1800,
      }),
    );

    const result = await pollOpencodeOauthDeviceFlow(
      xaiConnector,
      {
        kind: "rfc8628-form",
        deviceCode: "xai-device-code",
      },
      5,
    );

    expect(requests[0]?.url).toBe("https://auth.x.ai/oauth2/token");
    const pollBody = new URLSearchParams(requests[0]?.body);
    expect(pollBody.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(pollBody.get("device_code")).toBe("xai-device-code");

    if (result.status !== "completed") throw new Error(`Expected completion, got ${result.status}`);
    expect(result.auth.type).toBe("oauth");
    expect(result.auth.refresh).toBe("xai-refresh-1");
    expect(result.auth.access).toBe("xai-access-1");
    expect(result.auth.expires).toBeGreaterThan(Date.now());
    expect(result.accountLabel).toBe("grok@example.com");
    expect(result.accountExternalId).toBe("xai-debug-account");
  });

  test("an approval without a refresh token fails instead of storing a dead credential", async () => {
    stubFetch(() => Response.json({ access_token: "xai-access-1" }));

    const result = await pollOpencodeOauthDeviceFlow(
      xaiConnector,
      {
        kind: "rfc8628-form",
        deviceCode: "xai-device-code",
      },
      5,
    );
    expect(result).toEqual({ status: "failed" });
  });

  test("poll 5xx is transient", async () => {
    stubFetch(() => new Response("bad gateway", { status: 502 }));
    await assert.rejects(
      pollOpencodeOauthDeviceFlow(
        xaiConnector,
        {
          kind: "rfc8628-form",
          deviceCode: "xai-device-code",
        },
        5,
      ),
      /502/,
    );
  });
});

describe("descriptor contract", () => {
  test("a payload started under a different kind cannot reach the wrong vendor", async () => {
    await assert.rejects(
      pollOpencodeOauthDeviceFlow(
        xaiConnector,
        {
          kind: "openai-device",
          deviceAuthId: "device-auth-1",
          userCode: "ABCD-1234",
        },
        5,
      ),
      /start a new connect attempt/,
    );
  });
});
