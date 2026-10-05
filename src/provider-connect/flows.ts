import type { OpencodeOauthAuth } from "../protocol/provider-auth";
import { decodeJwt, type JWTPayload } from "jose";
import {
  None,
  allowInsecureRequests,
  deviceAuthorizationRequest,
  deviceCodeGrantRequest,
  genericTokenEndpointRequest,
} from "oauth4webapi";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import { z } from "zod";

import type { OpencodeConnectorDescriptor } from "./descriptor-schema";

type OpenaiDeviceDescriptor = Extract<OpencodeConnectorDescriptor, { kind: "openai-device" }>;
type GithubDeviceDescriptor = Extract<OpencodeConnectorDescriptor, { kind: "github-device" }>;
type Rfc8628FormDescriptor = Extract<OpencodeConnectorDescriptor, { kind: "rfc8628-form" }>;

const userAgent = "devboxes-dashboard";

const clampedIntervalSeconds = (seconds: number | undefined, fallback: number) => {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return fallback;
  }
  // Ceil, not round: a fractional vendor interval must never poll faster
  // than requested.
  return Math.ceil(seconds);
};

// The caller stores this payload and decodes it for each poll. It carries the
// flow kind it was started with; executors refuse a payload whose kind does not
// match the descriptor they were handed.
export const OpencodeOauthAttemptPayloadSchema = z.union([
  z.object({ kind: z.literal("openai-device"), deviceAuthId: z.string(), userCode: z.string() }),
  z.object({ kind: z.literal("github-device"), deviceCode: z.string() }),
  z.object({ kind: z.literal("github-device"), accessToken: z.string().min(1) }),
  z.object({ kind: z.literal("rfc8628-form"), deviceCode: z.string() }),
]);

export type OpencodeOauthAttemptPayload = z.infer<typeof OpencodeOauthAttemptPayloadSchema>;

export type OpencodeOauthDeviceStart = {
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
  expiresAtMs: number | null;
  payload: OpencodeOauthAttemptPayload;
};

export type OpencodeOauthPollResult =
  | {
      status: "pending";
      intervalSeconds: number;
      payload?: Extract<OpencodeOauthAttemptPayload, { accessToken: string }>;
    }
  | { status: "failed"; reason?: "insufficient-scope" }
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
    id_token: Type.Optional(Type.String({ minLength: 1 })),
    expires_in: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

const OauthIdentityClaimsSchema = z
  .object({
    chatgpt_account_id: z.string().optional(),
    email: z.string().optional(),
    sub: z.string().optional(),
    "https://api.openai.com/auth": z
      .object({ chatgpt_account_id: z.string().optional() })
      .optional(),
    organizations: z.array(z.object({ id: z.string().optional() })).optional(),
  })
  .transform((claims) => ({
    accountId:
      claims.chatgpt_account_id ||
      claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
      claims.organizations?.[0]?.id,
    email: claims.email,
    subject: claims.sub,
  }))
  .brand<"OauthIdentityClaims">();

type OauthIdentityClaims = z.output<typeof OauthIdentityClaimsSchema>;

const parseOauthIdentityClaims = (token: string): OauthIdentityClaims =>
  OauthIdentityClaimsSchema.parse(decodeJwt(token));

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

const openaiOauthFromTokens = (
  tokens: Static<typeof TokenResponseSchema>,
  refreshToken: string,
): Omit<Extract<OpencodeOauthPollResult, { status: "completed" }>, "status"> => {
  const identity = tokens.id_token ? parseOauthIdentityClaims(tokens.id_token) : undefined;
  let accessClaims: JWTPayload | undefined;
  if (!identity?.accountId) {
    try {
      accessClaims = decodeJwt(tokens.access_token);
    } catch {
      accessClaims = undefined;
    }
  }
  const accessIdentity = accessClaims ? OauthIdentityClaimsSchema.parse(accessClaims) : undefined;
  const accountId = identity?.accountId || accessIdentity?.accountId;
  const auth: OpencodeOauthAuth = {
    type: "oauth",
    refresh: refreshToken,
    access: tokens.access_token,
    expires: Math.round(Date.now() + (tokens.expires_in ?? 3600) * 1000),
  };
  if (accountId) auth.accountId = accountId;
  const accountLabel = identity?.email;
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
  });
  if (!response.ok) {
    throw new Error(
      `${descriptor.label} device authorization failed to start (${response.status}).`,
    );
  }
  const device = Value.Parse(OpenaiUsercodeResponseSchema, await response.json());
  const intervalSeconds = clampedIntervalSeconds(
    device.interval === undefined ? undefined : Number(device.interval),
    5,
  );
  return {
    userCode: device.user_code,
    // The vendor never sends a verification URL for this flow shape.
    verificationUrl: descriptor.verificationUrl,
    intervalSeconds,
    expiresAtMs: null,
    payload: {
      kind: "openai-device",
      deviceAuthId: device.device_auth_id,
      userCode: device.user_code,
    },
  };
};

const pollOpenaiDeviceFlow = async (
  descriptor: OpenaiDeviceDescriptor,
  payload: Extract<OpencodeOauthAttemptPayload, { kind: "openai-device" }>,
  intervalSeconds: number,
): Promise<OpencodeOauthPollResult> => {
  const response = await fetch(descriptor.pollUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": userAgent },
    body: JSON.stringify({ device_auth_id: payload.deviceAuthId, user_code: payload.userCode }),
  });
  // This flow shape signals "not approved yet" with 403/404 rather than
  // RFC 8628 error codes.
  if (response.status === 403 || response.status === 404) {
    return { status: "pending", intervalSeconds };
  }
  // Thrown means transient: the attempt stays pending and the next poll
  // retries. Only definitive vendor answers fail the attempt.
  if (response.status >= 500) {
    throw new Error(
      `${descriptor.label} device authorization failed upstream (${response.status}).`,
    );
  }
  if (!response.ok) return { status: "failed" };

  const grant = Value.Parse(OpenaiDeviceTokenResponseSchema, await response.json());
  const tokenUrl = new URL(descriptor.tokenUrl);
  const tokenResponse = await genericTokenEndpointRequest(
    { issuer: tokenUrl.origin, token_endpoint: tokenUrl.href },
    { client_id: descriptor.clientId },
    None(),
    "authorization_code",
    {
      code: grant.authorization_code,
      redirect_uri: descriptor.redirectUri,
      code_verifier: grant.code_verifier,
    },
    { [allowInsecureRequests]: tokenUrl.protocol === "http:" },
  );
  if (tokenResponse.status >= 500) {
    throw new Error(
      `${descriptor.label} token exchange failed upstream (${tokenResponse.status}).`,
    );
  }
  if (!tokenResponse.ok) return { status: "failed" };
  const tokens = Value.Parse(TokenResponseSchema, await tokenResponse.json());
  if (!tokens.refresh_token) return { status: "failed" };
  return { status: "completed", ...openaiOauthFromTokens(tokens, tokens.refresh_token) };
};

// --- GitHub device flow (kind: github-device) --------------------------------
// Native OpenCode mints short-lived Copilot tokens from the stored device token.

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
    interval: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

const GithubIdentityResponseSchema = Type.Object(
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
  const deviceCodeUrl = new URL(`${descriptor.webUrl}/login/device/code`);
  const response = await deviceAuthorizationRequest(
    { issuer: deviceCodeUrl.origin, device_authorization_endpoint: deviceCodeUrl.href },
    { client_id: descriptor.clientId },
    None(),
    { scope: descriptor.scope },
    {
      headers: { "User-Agent": userAgent },
      [allowInsecureRequests]: deviceCodeUrl.protocol === "http:",
    },
  );
  if (!response.ok) {
    throw new Error(
      `${descriptor.label} device authorization failed to start (${response.status}).`,
    );
  }
  const device = Value.Parse(GithubDeviceResponseSchema, await response.json());
  // The verification URL ends up as a link in the dashboard and is opened by
  // the CLI; only a URL on the GitHub web origin is acceptable.
  const verificationUrl = new URL(device.verification_uri);
  if (verificationUrl.origin !== deviceCodeUrl.origin) {
    throw new Error(
      `${descriptor.label} device authorization returned an unexpected verification URL.`,
    );
  }
  const intervalSeconds = clampedIntervalSeconds(device.interval, 5);
  return {
    userCode: device.user_code,
    verificationUrl: verificationUrl.toString(),
    intervalSeconds,
    expiresAtMs: device.expires_in === undefined ? null : Date.now() + device.expires_in * 1000,
    payload: { kind: "github-device", deviceCode: device.device_code },
  };
};

const pollGithubDeviceFlow = async (
  descriptor: GithubDeviceDescriptor,
  payload: Extract<OpencodeOauthAttemptPayload, { kind: "github-device" }>,
  intervalSeconds: number,
): Promise<OpencodeOauthPollResult> => {
  let accessToken: string;
  if ("accessToken" in payload) {
    accessToken = payload.accessToken;
  } else {
    const accessTokenUrl = new URL(`${descriptor.webUrl}/login/oauth/access_token`);
    const response = await deviceCodeGrantRequest(
      { issuer: accessTokenUrl.origin, token_endpoint: accessTokenUrl.href },
      { client_id: descriptor.clientId },
      None(),
      payload.deviceCode,
      {
        headers: { "User-Agent": userAgent },
        [allowInsecureRequests]: accessTokenUrl.protocol === "http:",
      },
    );
    // Thrown means transient: the attempt stays pending and the next poll
    // retries. Only definitive vendor answers fail the attempt.
    if (response.status >= 500) {
      throw new Error(
        `${descriptor.label} device authorization failed upstream (${response.status}).`,
      );
    }
    if (!response.ok) return { status: "failed" };
    const data = Value.Parse(GithubAccessTokenResponseSchema, await response.json());
    if (!data.access_token) {
      if (data.error === "slow_down") {
        // RFC 8628 §3.5: add 5 seconds; the vendor may also send the new interval.
        return {
          status: "pending",
          intervalSeconds: clampedIntervalSeconds(data.interval, intervalSeconds + 5),
        };
      }
      if (data.error && data.error !== "authorization_pending") return { status: "failed" };
      // A 200 with neither a token nor an error is not a denial; opencode keeps
      // polling in this state, so the attempt stays pending.
      return { status: "pending", intervalSeconds };
    }
    accessToken = data.access_token;
  }

  const pending: OpencodeOauthPollResult = {
    status: "pending",
    intervalSeconds,
    payload: { kind: "github-device", accessToken },
  };
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": userAgent,
  };
  const identityResponse = await fetch(`${descriptor.apiUrl}/user`, { headers }).catch(
    () => undefined,
  );
  if (!identityResponse || identityResponse.status >= 500) return pending;
  if (!identityResponse.ok) {
    return identityResponse.status === 403
      ? { status: "failed", reason: "insufficient-scope" }
      : { status: "failed" };
  }
  const scopes = (identityResponse.headers.get("x-oauth-scopes") ?? "")
    .split(",")
    .map((scope) => scope.trim());
  if (!scopes.includes("read:user")) return { status: "failed", reason: "insufficient-scope" };
  const identityBody = await identityResponse.text().catch(() => undefined);
  if (identityBody === undefined) return pending;
  const identity = Value.Parse(GithubIdentityResponseSchema, JSON.parse(identityBody));
  const copilotResponse = await fetch(`${descriptor.apiUrl}/copilot_internal/v2/token`, {
    headers,
  }).catch(() => undefined);
  if (!copilotResponse || copilotResponse.status >= 500) return pending;
  if (!copilotResponse.ok) {
    return copilotResponse.status === 401 || copilotResponse.status === 403
      ? { status: "failed", reason: "insufficient-scope" }
      : { status: "failed" };
  }
  const copilotBody = await copilotResponse.text().catch(() => undefined);
  if (copilotBody === undefined) return pending;
  Value.Parse(GithubCopilotTokenResponseSchema, JSON.parse(copilotBody));
  return {
    status: "completed",
    auth: { type: "oauth", refresh: accessToken, access: accessToken, expires: 0 },
    accountExternalId: String(identity.id),
    accountLabel: identity.login,
  };
};

// --- RFC 8628 form-encoded flow (kind: rfc8628-form) -------------------------
// Pending answers arrive as non-2xx responses with an RFC error body.

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
  { error: Type.Optional(Type.String()) },
  { additionalProperties: true },
);

const rfc8628OauthFromTokens = (
  tokens: Static<typeof TokenResponseSchema>,
  refreshToken: string,
) => {
  const auth: OpencodeOauthAuth = {
    type: "oauth",
    refresh: refreshToken,
    access: tokens.access_token,
    expires: Math.round(Date.now() + (tokens.expires_in ?? 3600) * 1000),
  };
  const claims = tokens.id_token ? parseOauthIdentityClaims(tokens.id_token) : undefined;
  return { auth, accountExternalId: claims?.subject, accountLabel: claims?.email };
};

const startRfc8628FormFlow = async (
  descriptor: Rfc8628FormDescriptor,
): Promise<OpencodeOauthDeviceStart> => {
  const deviceAuthorizationUrl = new URL(descriptor.deviceAuthorizationUrl);
  const response = await deviceAuthorizationRequest(
    {
      issuer: deviceAuthorizationUrl.origin,
      device_authorization_endpoint: deviceAuthorizationUrl.href,
    },
    { client_id: descriptor.clientId },
    None(),
    { scope: descriptor.scope },
    {
      headers: { "User-Agent": userAgent },
      [allowInsecureRequests]: deviceAuthorizationUrl.protocol === "http:",
    },
  );
  if (!response.ok) {
    throw new Error(
      `${descriptor.label} device authorization failed to start (${response.status}).`,
    );
  }
  const device = Value.Parse(Rfc8628DeviceResponseSchema, await response.json());
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
  return {
    userCode: device.user_code,
    verificationUrl: verificationUrl.toString(),
    intervalSeconds,
    expiresAtMs: device.expires_in === undefined ? null : Date.now() + device.expires_in * 1000,
    payload: { kind: "rfc8628-form", deviceCode: device.device_code },
  };
};

const pollRfc8628FormFlow = async (
  descriptor: Rfc8628FormDescriptor,
  payload: Extract<OpencodeOauthAttemptPayload, { kind: "rfc8628-form" }>,
  intervalSeconds: number,
): Promise<OpencodeOauthPollResult> => {
  const tokenUrl = new URL(descriptor.tokenUrl);
  const response = await deviceCodeGrantRequest(
    { issuer: tokenUrl.origin, token_endpoint: tokenUrl.href },
    { client_id: descriptor.clientId },
    None(),
    payload.deviceCode,
    {
      headers: { "User-Agent": userAgent },
      [allowInsecureRequests]: tokenUrl.protocol === "http:",
    },
  );
  if (response.ok) {
    const tokens = Value.Parse(TokenResponseSchema, await response.json());
    if (!tokens.refresh_token) return { status: "failed" };
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
  if (errorBody.error === "authorization_pending") return { status: "pending", intervalSeconds };
  if (errorBody.error === "slow_down") {
    // RFC 8628 §3.5: add 5 seconds (this flow shape sends no replacement interval).
    return { status: "pending", intervalSeconds: intervalSeconds + 5 };
  }
  if (
    errorBody.error === "access_denied" ||
    errorBody.error === "authorization_denied" ||
    errorBody.error === "expired_token"
  ) {
    return { status: "failed" };
  }
  // Thrown means transient: the attempt stays pending and the next poll
  // retries. Only definitive vendor answers fail the attempt.
  if (response.status >= 500) {
    throw new Error(
      `${descriptor.label} device authorization failed upstream (${response.status}).`,
    );
  }
  return { status: "failed" };
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
  intervalSeconds: number,
): Promise<OpencodeOauthPollResult> => {
  // The payload records the flow kind it was started with; a descriptor whose
  // kind moved underneath a pending attempt must fail instead of reaching the
  // wrong vendor endpoint with the wrong grant.
  if (descriptor.kind === "openai-device" && payload.kind === "openai-device") {
    return pollOpenaiDeviceFlow(descriptor, payload, intervalSeconds);
  }
  if (descriptor.kind === "github-device" && payload.kind === "github-device") {
    return pollGithubDeviceFlow(descriptor, payload, intervalSeconds);
  }
  if (descriptor.kind === "rfc8628-form" && payload.kind === "rfc8628-form") {
    return pollRfc8628FormFlow(descriptor, payload, intervalSeconds);
  }
  throw new Error(
    `Opencode provider ${descriptor.providerId} attempt was started as ${payload.kind} but the connector is now ${descriptor.kind}; start a new connect attempt.`,
  );
};
