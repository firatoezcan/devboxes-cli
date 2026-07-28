import Type, { type Static } from "typebox";

// The wire schema for served connector descriptors — the contract between the
// dashboard's descriptor data (descriptors.ts, served over
// `GET /internal/runner-machines/connectors`) and the flow executors compiled
// into both the API and shipped runner binaries. Flow BEHAVIOR (pending
// signals, token exchange legs, JWT parsing) lives in flows.ts selected by
// `kind`; everything a vendor controls — endpoints, public client ids,
// scopes — is descriptor DATA, so it can move server-side without re-shipping
// binaries. `additionalProperties: true` everywhere is the forward-compat
// contract: a runner parses served entries element-wise, uses the fields
// its compiled kind executor knows, and skips entries whose kind it does not
// know.
//
// Runner binaries import ONLY this schema module, never descriptors.ts —
// compiled descriptor data in a binary is exactly the rot this design kills
// (enforced by an ast-grep rule).

const connectorBase = {
  providerId: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
  description: Type.String(),
};

// Absent on providers whose stored token never refreshes (GitHub's permanent
// device token); present = form-encoded refresh_token grant against tokenUrl.
const ConnectorRefreshSchema = Type.Object(
  {
    tokenUrl: Type.String({ minLength: 1 }),
    clientId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: true },
);

export const OpencodeConnectorDescriptorSchema = Type.Union([
  // ChatGPT Pro/Plus: usercode start → poll answers HTTP 403/404 while
  // unapproved, then yields an authorization code plus the vendor-generated
  // PKCE verifier for a second token exchange; account id from JWT claims.
  Type.Object(
    {
      ...connectorBase,
      kind: Type.Literal("openai-device"),
      clientId: Type.String({ minLength: 1 }),
      usercodeUrl: Type.String({ minLength: 1 }),
      pollUrl: Type.String({ minLength: 1 }),
      tokenUrl: Type.String({ minLength: 1 }),
      redirectUri: Type.String({ minLength: 1 }),
      // The vendor never sends a verification URL; this constant is it.
      verificationUrl: Type.String({ minLength: 1 }),
      refresh: ConnectorRefreshSchema,
    },
    { additionalProperties: true },
  ),
  // GitHub device flow, JSON-encoded: pending arrives as 200 + body error;
  // the resulting token is permanent (stored as refresh==access, expires 0 —
  // opencode mints the short-lived Copilot API tokens from it in-container),
  // so there is no refresh block. verificationUrlHosts match exactly.
  Type.Object(
    {
      ...connectorBase,
      kind: Type.Literal("github-device"),
      clientId: Type.String({ minLength: 1 }),
      scope: Type.String({ minLength: 1 }),
      deviceCodeUrl: Type.String({ minLength: 1 }),
      accessTokenUrl: Type.String({ minLength: 1 }),
      verificationUrlHosts: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    },
    { additionalProperties: true },
  ),
  // Clean RFC 8628 form-encoded flow: pending arrives as a non-2xx response
  // with an RFC error body, slow_down adds five seconds, refresh tokens
  // rotate (a refresh answer may omit the replacement). verificationUrlHosts
  // match the host or any of its subdomains.
  Type.Object(
    {
      ...connectorBase,
      kind: Type.Literal("rfc8628-form"),
      clientId: Type.String({ minLength: 1 }),
      scope: Type.String({ minLength: 1 }),
      deviceAuthorizationUrl: Type.String({ minLength: 1 }),
      tokenUrl: Type.String({ minLength: 1 }),
      verificationUrlHosts: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      // Applied when the vendor response carries no expires_in.
      defaultDeviceCodeTtlSeconds: Type.Number({ minimum: 1 }),
      refresh: ConnectorRefreshSchema,
    },
    { additionalProperties: true },
  ),
]);

export type OpencodeConnectorDescriptor = Static<typeof OpencodeConnectorDescriptorSchema>;
