import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";

import type { OpencodeOauthAuth } from "../protocol/provider-auth";
import type { OpencodeConnectorDescriptor } from "./descriptor-schema";

// Vendor device-OAuth flow executors, parameterized by connector descriptor:
// every endpoint, public client id, and scope arrives as data (descriptors.ts
// server-side, the served connector list runner-side), while flow BEHAVIOR —
// pending/error semantics, token exchange legs, JWT claim parsing — stays
// compiled here, selected by the descriptor's `kind`. The semantics mirror
// opencode's own plugins (plugin/codex.ts, plugin/github-copilot/copilot.ts,
// plugin/xai.ts) so the stored credential is exactly what opencode expects to
// find in its auth file. Every flow is a device flow: the vendor hosts the
// verification page, the user enters a short code, and the caller polls — no
// client secret.

type OpenaiDeviceDescriptor = Extract<OpencodeConnectorDescriptor, { kind: "openai-device" }>;
type GithubDeviceDescriptor = Extract<OpencodeConnectorDescriptor, { kind: "github-device" }>;
type Rfc8628FormDescriptor = Extract<OpencodeConnectorDescriptor, { kind: "rfc8628-form" }>;
type VendorJson = string | number | boolean | null | VendorJson[] | { [key: string]: VendorJson };

const userAgent = "devboxes-dashboard";

// Vendors bound device codes at ~15 minutes; attempts never outlive that even
// when the vendor response carries no explicit expiry.
const attemptMaxAgeMs = 15 * 60 * 1000;

// Vendor calls sit on interactive connection and credential-maintenance paths;
// a hung connection must become a thrown — transient — error instead of a
// stuck handler.
const vendorFetchTimeoutMs = 10_000;

// Zero and negatives mean "no usable interval" (opencode's parseInt||5 does
// the same); the ceiling only guards against absurd values — a vendor asking
// for a slower cadence must be honored, never polled faster than requested.
const clampedIntervalSeconds = (seconds: number | undefined, fallback: number) => {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return Math.min(fallback, 900);
  }
  // Ceil, not round: a fractional vendor interval must never poll faster
  // than requested.
  return Math.min(Math.ceil(seconds), 900);
};

// TypeBox parse failures surface as a bare "Parse" message; a vendor answering
// with an off-schema body must read as that vendor's failure instead. Thrown
// means transient, same as any other vendor hiccup.
const parsedVendorBody = <T extends TSchema>(
  schema: T,
  body: VendorJson,
  flowLabel: string,
): Static<T> => {
  try {
    return Value.Parse(schema, body);
  } catch {
    throw new Error(`${flowLabel} returned an unexpected response body.`);
  }
};

// The payload crosses a decode boundary (JSON parsed from a stored attempt
// row or the runner's in-flight connect), so it carries the flow kind it
// was started with; executors refuse a payload whose kind does not match the
// descriptor they were handed.
export type OpencodeOauthAttemptPayload =
  | {
      kind: "openai-device";
      providerId: string;
      deviceAuthId: string;
      userCode: string;
      intervalSeconds: number;
    }
  | {
      kind: "github-device";
      providerId: string;
      deviceCode: string;
      intervalSeconds: number;
    }
  | {
      kind: "rfc8628-form";
      providerId: string;
      deviceCode: string;
      intervalSeconds: number;
    };

export type OpencodeOauthDeviceStart = {
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
  expiresAtMs: number;
  payload: OpencodeOauthAttemptPayload;
};

export type OpencodeOauthPollResult =
  | { status: "pending"; intervalSeconds: number }
  | { status: "failed"; error: string; reason?: "insufficient-scope" }
  | {
      status: "completed";
      auth: OpencodeOauthAuth;
      accountExternalId?: string;
      accountLabel?: string;
    };

// --- Shared vendor response schemas -----------------------------------------

const TokenResponseSchema = Type.Object(
  {
    access_token: Type.String({ minLength: 1 }),
    refresh_token: Type.Optional(Type.String()),
    id_token: Type.Optional(Type.String()),
    expires_in: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

const JwtStringSchema = Type.String();
const JwtAuthClaimsSchema = Type.Object(
  { chatgpt_account_id: Type.Optional(Type.Unknown()) },
  { additionalProperties: true },
);
const JwtOrganizationSchema = Type.Object(
  { id: Type.Optional(Type.Unknown()) },
  { additionalProperties: true },
);
const JwtClaimsSchema = Type.Object(
  {
    chatgpt_account_id: Type.Optional(Type.Unknown()),
    email: Type.Optional(Type.Unknown()),
    sub: Type.Optional(Type.Unknown()),
    "https://api.openai.com/auth": Type.Optional(Type.Unknown()),
    organizations: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);

// Claims are best-effort display/routing data; one malformed field must not
// drop the whole token's claims (a strict schema would lose a valid
// chatgpt_account_id next to, say, a null email). Narrow each field alone.
const bearerJwtClaims = (token: string) => {
  const segments = token.split(".");
  // Exactly header.payload.signature, matching opencode's own claims parser.
  if (segments.length !== 3) return undefined;
  const payload = segments[1];
  if (!payload) return undefined;
  let claims: Static<typeof JwtClaimsSchema>;
  try {
    claims = Value.Parse(JwtClaimsSchema, JSON.parse(Buffer.from(payload, "base64url").toString()));
  } catch {
    return undefined;
  }
  const nestedAuth = claims["https://api.openai.com/auth"];
  const nestedAccountId = Value.Check(JwtAuthClaimsSchema, nestedAuth)
    ? nestedAuth.chatgpt_account_id
    : undefined;
  const firstOrganization = Value.Check(Type.Array(JwtOrganizationSchema), claims.organizations)
    ? claims.organizations[0]
    : undefined;
  const firstOrganizationId = firstOrganization?.id;
  return {
    chatgptAccountId: Value.Check(JwtStringSchema, claims.chatgpt_account_id)
      ? claims.chatgpt_account_id
      : undefined,
    nestedChatgptAccountId: Value.Check(JwtStringSchema, nestedAccountId)
      ? nestedAccountId
      : undefined,
    firstOrganizationId: Value.Check(JwtStringSchema, firstOrganizationId)
      ? firstOrganizationId
      : undefined,
    email: Value.Check(JwtStringSchema, claims.email) ? claims.email : undefined,
    subject: Value.Check(JwtStringSchema, claims.sub) ? claims.sub : undefined,
  };
};

// --- ChatGPT-style device flow (kind: openai-device) ------------------------

const OpenaiUsercodeResponseSchema = Type.Object(
  {
    device_auth_id: Type.String({ minLength: 1 }),
    user_code: Type.String({ minLength: 1 }),
    interval: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  },
  { additionalProperties: true },
);

const OpenaiDeviceTokenResponseSchema = Type.Object(
  {
    authorization_code: Type.String({ minLength: 1 }),
    code_verifier: Type.String({ minLength: 1 }),
  },
  { additionalProperties: true },
);

const openaiAccountId = (tokens: Static<typeof TokenResponseSchema>) => {
  for (const token of [tokens.id_token, tokens.access_token]) {
    if (!token) continue;
    const claims = bearerJwtClaims(token);
    // `||` (not `??`) matches opencode: an empty-string claim falls through.
    const accountId =
      claims?.chatgptAccountId || claims?.nestedChatgptAccountId || claims?.firstOrganizationId;
    if (accountId) return accountId;
  }
  return undefined;
};

const openaiOauthFromTokens = (
  tokens: Static<typeof TokenResponseSchema>,
  previousRefreshToken: string,
  previousAccountId?: string,
): Omit<Extract<OpencodeOauthPollResult, { status: "completed" }>, "status"> => {
  const accountId = openaiAccountId(tokens) ?? previousAccountId;
  const auth: OpencodeOauthAuth = {
    type: "oauth",
    // A refresh answer may omit the rotated refresh token; the previous one
    // stays valid then (same contract the rfc8628 flow handles explicitly).
    refresh: tokens.refresh_token || previousRefreshToken,
    access: tokens.access_token,
    // opencode's auth.json reader silently drops entries whose expires is not
    // an integer, so a fractional expires_in must never produce a float here.
    expires: Math.round(Date.now() + (tokens.expires_in ?? 3600) * 1000),
  };
  if (accountId) auth.accountId = accountId;
  const accountLabel = tokens.id_token ? bearerJwtClaims(tokens.id_token)?.email : undefined;
  if (accountId && accountLabel) return { auth, accountExternalId: accountId, accountLabel };
  if (accountId) return { auth, accountExternalId: accountId };
  if (accountLabel) return { auth, accountLabel };
  return { auth };
};

const startOpenaiDeviceFlow = async (
  descriptor: OpenaiDeviceDescriptor,
): Promise<OpencodeOauthDeviceStart> => {
  const response = await fetch(descriptor.usercodeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": userAgent },
    body: JSON.stringify({ client_id: descriptor.clientId }),
    signal: AbortSignal.timeout(vendorFetchTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `${descriptor.label} device authorization failed to start (${response.status}).`,
    );
  }
  const device = parsedVendorBody(
    OpenaiUsercodeResponseSchema,
    await response.json(),
    `${descriptor.label} device authorization`,
  );
  const interval = device.interval;
  const intervalSeconds = clampedIntervalSeconds(
    interval === undefined
      ? undefined
      : Value.Check(Type.Number(), interval)
        ? interval
        : Number.parseInt(interval, 10),
    5,
  );
  return {
    userCode: device.user_code,
    // The vendor never sends a verification URL for this flow shape.
    verificationUrl: descriptor.verificationUrl,
    intervalSeconds,
    expiresAtMs: Date.now() + attemptMaxAgeMs,
    payload: {
      kind: "openai-device",
      providerId: descriptor.providerId,
      deviceAuthId: device.device_auth_id,
      userCode: device.user_code,
      intervalSeconds,
    },
  };
};

const pollOpenaiDeviceFlow = async (
  descriptor: OpenaiDeviceDescriptor,
  payload: Extract<OpencodeOauthAttemptPayload, { kind: "openai-device" }>,
): Promise<OpencodeOauthPollResult> => {
  const response = await fetch(descriptor.pollUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": userAgent },
    body: JSON.stringify({ device_auth_id: payload.deviceAuthId, user_code: payload.userCode }),
    signal: AbortSignal.timeout(vendorFetchTimeoutMs),
  });
  // This flow shape signals "not approved yet" with 403/404 rather than
  // RFC 8628 error codes.
  if (response.status === 403 || response.status === 404) {
    return { status: "pending", intervalSeconds: payload.intervalSeconds };
  }
  // Thrown means transient: the attempt stays pending and the next poll
  // retries. Only definitive vendor answers fail the attempt.
  if (response.status >= 500) {
    throw new Error(
      `${descriptor.label} device authorization failed upstream (${response.status}).`,
    );
  }
  if (!response.ok) {
    return {
      status: "failed",
      error: `${descriptor.label} device authorization failed (${response.status}).`,
    };
  }

  const grant = parsedVendorBody(
    OpenaiDeviceTokenResponseSchema,
    await response.json(),
    `${descriptor.label} device authorization`,
  );
  const tokenResponse = await fetch(descriptor.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: grant.authorization_code,
      redirect_uri: descriptor.redirectUri,
      client_id: descriptor.clientId,
      code_verifier: grant.code_verifier,
    }).toString(),
    signal: AbortSignal.timeout(vendorFetchTimeoutMs),
  });
  if (tokenResponse.status >= 500) {
    throw new Error(
      `${descriptor.label} token exchange failed upstream (${tokenResponse.status}).`,
    );
  }
  if (!tokenResponse.ok) {
    return {
      status: "failed",
      error: `${descriptor.label} token exchange failed (${tokenResponse.status}).`,
    };
  }
  const tokens = parsedVendorBody(
    TokenResponseSchema,
    await tokenResponse.json(),
    `${descriptor.label} token exchange`,
  );
  if (!tokens.refresh_token) {
    return { status: "failed", error: `${descriptor.label} did not return a refresh token.` };
  }
  return { status: "completed", ...openaiOauthFromTokens(tokens, tokens.refresh_token) };
};

// --- GitHub device flow (kind: github-device) --------------------------------
// The resulting token never expires and is stored as both refresh and access
// with expires 0 — opencode mints the short-lived Copilot API tokens from it
// in-container, which is also why this kind has no refresh block.

const GithubDeviceResponseSchema = Type.Object(
  {
    verification_uri: Type.String({ minLength: 1 }),
    user_code: Type.String({ minLength: 1 }),
    device_code: Type.String({ minLength: 1 }),
    interval: Type.Optional(Type.Number()),
    expires_in: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

const GithubAccessTokenResponseSchema = Type.Object(
  {
    access_token: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
    error_description: Type.Optional(Type.String()),
    interval: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

const GithubUserResponseSchema = Type.Object(
  {
    id: Type.Number(),
    login: Type.String({ minLength: 1 }),
  },
  { additionalProperties: true },
);

const GithubCopilotTokenResponseSchema = Type.Object(
  {
    token: Type.String({ minLength: 1 }),
  },
  { additionalProperties: true },
);

const startGithubDeviceFlow = async (
  descriptor: GithubDeviceDescriptor,
): Promise<OpencodeOauthDeviceStart> => {
  const response = await fetch(descriptor.deviceCodeUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": userAgent,
    },
    body: JSON.stringify({ client_id: descriptor.clientId, scope: descriptor.scope }),
    signal: AbortSignal.timeout(vendorFetchTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `${descriptor.label} device authorization failed to start (${response.status}).`,
    );
  }
  const device = parsedVendorBody(
    GithubDeviceResponseSchema,
    await response.json(),
    `${descriptor.label} device authorization`,
  );
  // The verification URL ends up as a link in the dashboard and is opened by
  // the CLI; only an HTTPS URL on an allowlisted host (exact match for this
  // flow shape) is acceptable.
  const verificationUrl = new URL(device.verification_uri);
  if (
    verificationUrl.protocol !== "https:" ||
    !descriptor.verificationUrlHosts.includes(verificationUrl.hostname)
  ) {
    throw new Error(
      `${descriptor.label} device authorization returned an unexpected verification URL.`,
    );
  }
  const intervalSeconds = clampedIntervalSeconds(device.interval, 5);
  const vendorExpiryMs =
    device.expires_in !== undefined && Number.isFinite(device.expires_in)
      ? device.expires_in * 1000
      : attemptMaxAgeMs;
  return {
    userCode: device.user_code,
    verificationUrl: verificationUrl.toString(),
    intervalSeconds,
    expiresAtMs: Date.now() + Math.min(vendorExpiryMs, attemptMaxAgeMs),
    payload: {
      kind: "github-device",
      providerId: descriptor.providerId,
      deviceCode: device.device_code,
      intervalSeconds,
    },
  };
};

const pollGithubDeviceFlow = async (
  descriptor: GithubDeviceDescriptor,
  payload: Extract<OpencodeOauthAttemptPayload, { kind: "github-device" }>,
): Promise<OpencodeOauthPollResult> => {
  const response = await fetch(descriptor.accessTokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": userAgent,
    },
    body: JSON.stringify({
      client_id: descriptor.clientId,
      device_code: payload.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    signal: AbortSignal.timeout(vendorFetchTimeoutMs),
  });
  // Thrown means transient: the attempt stays pending and the next poll
  // retries. Only definitive vendor answers fail the attempt.
  if (response.status >= 500) {
    throw new Error(
      `${descriptor.label} device authorization failed upstream (${response.status}).`,
    );
  }
  if (!response.ok) {
    return {
      status: "failed",
      error: `${descriptor.label} device authorization failed (${response.status}).`,
    };
  }
  const data = parsedVendorBody(
    GithubAccessTokenResponseSchema,
    await response.json(),
    `${descriptor.label} device authorization`,
  );

  if (data.access_token) {
    const identityResponse = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${data.access_token}`,
        "User-Agent": userAgent,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(vendorFetchTimeoutMs),
    });
    if (!identityResponse.ok) {
      const failure: OpencodeOauthPollResult = {
        status: "failed",
        error:
          identityResponse.status === 403
            ? "GitHub rejected the account identity check because the OAuth token has insufficient scope."
            : "GitHub rejected the account identity check.",
      };
      if (identityResponse.status === 403) failure.reason = "insufficient-scope";
      return failure;
    }
    const scopes = (identityResponse.headers.get("x-oauth-scopes") ?? "")
      .split(",")
      .map((scope) => scope.trim());
    if (!scopes.includes("read:user")) {
      return {
        status: "failed",
        reason: "insufficient-scope",
        error: "GitHub did not grant the read:user scope required to bind the Provider Account.",
      };
    }
    const identity = parsedVendorBody(
      GithubUserResponseSchema,
      await identityResponse.json(),
      "GitHub account identity",
    );
    const copilotResponse = await fetch("https://api.github.com/copilot_internal/v2/token", {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${data.access_token}`,
        "User-Agent": userAgent,
      },
      signal: AbortSignal.timeout(vendorFetchTimeoutMs),
    });
    if (!copilotResponse.ok) {
      if (copilotResponse.status === 401 || copilotResponse.status === 403) {
        return {
          status: "failed",
          reason: "insufficient-scope",
          error: "GitHub did not grant this account access to the Copilot execution API.",
        };
      }
      return {
        status: "failed",
        error: "GitHub rejected the Copilot execution capability check.",
      };
    }
    parsedVendorBody(
      GithubCopilotTokenResponseSchema,
      await copilotResponse.json(),
      "GitHub Copilot execution token",
    );
    return {
      status: "completed",
      auth: {
        type: "oauth",
        refresh: data.access_token,
        access: data.access_token,
        expires: 0,
      },
      accountExternalId: String(identity.id),
      accountLabel: identity.login,
    };
  }
  if (data.error === "authorization_pending") {
    return { status: "pending", intervalSeconds: payload.intervalSeconds };
  }
  if (data.error === "slow_down") {
    // RFC 8628 §3.5: add 5 seconds; the vendor may also send the new interval.
    return {
      status: "pending",
      intervalSeconds: clampedIntervalSeconds(data.interval, payload.intervalSeconds + 5),
    };
  }
  if (data.error) {
    return {
      status: "failed",
      error: data.error_description || data.error,
    };
  }
  // A 200 with neither a token nor an error is not a denial; opencode keeps
  // polling in this state, so the attempt stays pending.
  return { status: "pending", intervalSeconds: payload.intervalSeconds };
};

// --- RFC 8628 form-encoded flow (kind: rfc8628-form) -------------------------
// Pending answers arrive as non-2xx responses with an RFC error body; refresh
// tokens rotate, and a refresh response may omit the new refresh token, in
// which case the previous one stays valid.

const Rfc8628DeviceResponseSchema = Type.Object(
  {
    device_code: Type.String({ minLength: 1 }),
    user_code: Type.String({ minLength: 1 }),
    verification_uri: Type.String({ minLength: 1 }),
    verification_uri_complete: Type.Optional(Type.String()),
    expires_in: Type.Optional(Type.Number()),
    interval: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

const Rfc8628TokenErrorSchema = Type.Object(
  {
    error: Type.Optional(Type.String()),
    error_description: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const rfc8628OauthFromTokens = (
  tokens: Static<typeof TokenResponseSchema>,
  previousRefreshToken: string,
) => {
  const auth: OpencodeOauthAuth = {
    type: "oauth",
    // The vendor may omit the rotated refresh token; the previous one stays valid.
    refresh: tokens.refresh_token || previousRefreshToken,
    access: tokens.access_token,
    expires: Math.round(Date.now() + (tokens.expires_in ?? 3600) * 1000),
  };
  const claims = tokens.id_token ? bearerJwtClaims(tokens.id_token) : undefined;
  return { auth, accountExternalId: claims?.subject, accountLabel: claims?.email };
};

const startRfc8628FormFlow = async (
  descriptor: Rfc8628FormDescriptor,
): Promise<OpencodeOauthDeviceStart> => {
  const response = await fetch(descriptor.deviceAuthorizationUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": userAgent,
    },
    body: new URLSearchParams({
      client_id: descriptor.clientId,
      scope: descriptor.scope,
    }).toString(),
    signal: AbortSignal.timeout(vendorFetchTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `${descriptor.label} device authorization failed to start (${response.status}).`,
    );
  }
  const device = parsedVendorBody(
    Rfc8628DeviceResponseSchema,
    await response.json(),
    `${descriptor.label} device authorization`,
  );
  // The verification URL ends up as a link in the dashboard and is opened by
  // the CLI; only an HTTPS URL on an allowlisted host or one of its
  // subdomains is acceptable. `||` so an empty verification_uri_complete
  // falls through to verification_uri.
  const verificationUrl = new URL(device.verification_uri_complete || device.verification_uri);
  if (
    verificationUrl.protocol !== "https:" ||
    // Host or any subdomain of it — the live xAI flow answers with
    // accounts.x.ai against an x.ai allowlist entry.
    !descriptor.verificationUrlHosts.some(
      (host) => verificationUrl.hostname === host || verificationUrl.hostname.endsWith(`.${host}`),
    )
  ) {
    throw new Error(
      `${descriptor.label} device authorization returned an unexpected verification URL.`,
    );
  }
  const intervalSeconds = clampedIntervalSeconds(device.interval, 5);
  const vendorExpiryMs =
    device.expires_in !== undefined && Number.isFinite(device.expires_in) && device.expires_in > 0
      ? device.expires_in * 1000
      : descriptor.defaultDeviceCodeTtlSeconds * 1000;
  return {
    userCode: device.user_code,
    verificationUrl: verificationUrl.toString(),
    intervalSeconds,
    expiresAtMs: Date.now() + Math.min(vendorExpiryMs, attemptMaxAgeMs),
    payload: {
      kind: "rfc8628-form",
      providerId: descriptor.providerId,
      deviceCode: device.device_code,
      intervalSeconds,
    },
  };
};

const pollRfc8628FormFlow = async (
  descriptor: Rfc8628FormDescriptor,
  payload: Extract<OpencodeOauthAttemptPayload, { kind: "rfc8628-form" }>,
): Promise<OpencodeOauthPollResult> => {
  const response = await fetch(descriptor.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": userAgent,
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: descriptor.clientId,
      device_code: payload.deviceCode,
    }).toString(),
    signal: AbortSignal.timeout(vendorFetchTimeoutMs),
  });
  if (response.ok) {
    const tokens = parsedVendorBody(
      TokenResponseSchema,
      await response.json(),
      `${descriptor.label} device authorization`,
    );
    if (!tokens.refresh_token) {
      return { status: "failed", error: `${descriptor.label} did not return a refresh token.` };
    }
    return { status: "completed", ...rfc8628OauthFromTokens(tokens, tokens.refresh_token) };
  }

  // RFC 8628 §3.5: pending answers arrive as error responses; parse the body
  // before deciding anything from the status code.
  let errorBody: Static<typeof Rfc8628TokenErrorSchema>;
  try {
    errorBody = Value.Parse(Rfc8628TokenErrorSchema, await response.json());
  } catch {
    errorBody = {};
  }
  if (errorBody.error === "authorization_pending") {
    return { status: "pending", intervalSeconds: payload.intervalSeconds };
  }
  if (errorBody.error === "slow_down") {
    // RFC 8628 §3.5: add 5 seconds (this flow shape sends no replacement interval).
    return {
      status: "pending",
      intervalSeconds: Math.min(payload.intervalSeconds + 5, 900),
    };
  }
  if (errorBody.error === "access_denied" || errorBody.error === "authorization_denied") {
    return { status: "failed", error: `${descriptor.label} device authorization was denied.` };
  }
  if (errorBody.error === "expired_token") {
    return {
      status: "failed",
      error: `The ${descriptor.label} device code expired before it was approved.`,
    };
  }
  // Thrown means transient: the attempt stays pending and the next poll
  // retries. Only definitive vendor answers fail the attempt.
  if (response.status >= 500) {
    throw new Error(
      `${descriptor.label} device authorization failed upstream (${response.status}).`,
    );
  }
  return {
    status: "failed",
    error:
      errorBody.error_description ||
      errorBody.error ||
      `${descriptor.label} device authorization failed (${response.status}).`,
  };
};

// --- Shared entry points -----------------------------------------------------

export const startOpencodeOauthDeviceFlow = async (
  descriptor: OpencodeConnectorDescriptor,
): Promise<OpencodeOauthDeviceStart> => {
  if (descriptor.kind === "openai-device") return startOpenaiDeviceFlow(descriptor);
  if (descriptor.kind === "github-device") return startGithubDeviceFlow(descriptor);
  return startRfc8628FormFlow(descriptor);
};

export const pollOpencodeOauthDeviceFlow = async (
  descriptor: OpencodeConnectorDescriptor,
  payload: OpencodeOauthAttemptPayload,
): Promise<OpencodeOauthPollResult> => {
  // The payload records the flow kind it was started with; a descriptor whose
  // kind moved underneath a pending attempt must fail instead of reaching the
  // wrong vendor endpoint with the wrong grant.
  if (descriptor.kind === "openai-device" && payload.kind === "openai-device") {
    return pollOpenaiDeviceFlow(descriptor, payload);
  }
  if (descriptor.kind === "github-device" && payload.kind === "github-device") {
    return pollGithubDeviceFlow(descriptor, payload);
  }
  if (descriptor.kind === "rfc8628-form" && payload.kind === "rfc8628-form") {
    return pollRfc8628FormFlow(descriptor, payload);
  }
  throw new Error(
    `Opencode provider ${descriptor.providerId} attempt was started as ${payload.kind} but the connector is now ${descriptor.kind}; start a new connect attempt.`,
  );
};

// Refresh prepares an OAuth credential source for a later claim. A thrown
// error is transient (network); a returned error carries the vendor status so
// callers can distinguish throttling from a definitive rejection.
export const refreshOpencodeOauthAccess = async (
  descriptor: OpencodeConnectorDescriptor,
  input: { auth: OpencodeOauthAuth },
): Promise<
  { auth: OpencodeOauthAuth; accountLabel?: string } | { error: string; status?: number }
> => {
  if (descriptor.kind === "github-device") {
    return { error: `Opencode provider ${descriptor.providerId} has no OAuth refresh flow.` };
  }
  const response = await fetch(descriptor.refresh.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": userAgent,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.auth.refresh,
      client_id: descriptor.refresh.clientId,
    }).toString(),
    signal: AbortSignal.timeout(vendorFetchTimeoutMs),
  });
  if (response.status >= 500) {
    throw new Error(`${descriptor.label} token refresh failed upstream (${response.status}).`);
  }
  if (!response.ok) {
    return {
      error: `${descriptor.label} token refresh was rejected (${response.status}).`,
      status: response.status,
    };
  }
  const tokens = parsedVendorBody(
    TokenResponseSchema,
    await response.json(),
    `${descriptor.label} token refresh`,
  );
  return descriptor.kind === "openai-device"
    ? openaiOauthFromTokens(tokens, input.auth.refresh, input.auth.accountId)
    : rfc8628OauthFromTokens(tokens, input.auth.refresh);
};
