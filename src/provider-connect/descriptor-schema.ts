import Type, { type Static } from "typebox";

const connectorBase = {
  providerId: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
  description: Type.String(),
};

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
    },
    { additionalProperties: true },
  ),
  // GitHub stores the device token; native OpenCode mints Copilot API tokens.
  // The verification URL must be on webUrl's origin.
  Type.Object(
    {
      ...connectorBase,
      kind: Type.Literal("github-device"),
      clientId: Type.String({ minLength: 1 }),
      scope: Type.String({ minLength: 1 }),
      webUrl: Type.String({ minLength: 1 }),
      apiUrl: Type.String({ minLength: 1 }),
    },
    { additionalProperties: true },
  ),
  // RFC 8628 pending answers use a non-2xx response with an RFC error body.
  // verificationUrlHosts match the host or any of its subdomains.
  Type.Object(
    {
      ...connectorBase,
      kind: Type.Literal("rfc8628-form"),
      clientId: Type.String({ minLength: 1 }),
      scope: Type.String({ minLength: 1 }),
      deviceAuthorizationUrl: Type.String({ minLength: 1 }),
      tokenUrl: Type.String({ minLength: 1 }),
      verificationUrlHosts: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    },
    { additionalProperties: true },
  ),
]);

export type OpencodeConnectorDescriptor = Static<typeof OpencodeConnectorDescriptorSchema>;
