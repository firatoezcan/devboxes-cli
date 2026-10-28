import Type from "typebox";
import Value from "typebox/value";

import { JsonValueSchema } from "./json";

type OpencodeApiAuth = {
  type: "api";
  key: string;
  metadata?: Record<string, string>;
};

export type OpencodeProviderAuthMetadataValue =
  | string
  | number
  | boolean
  | null
  | OpencodeProviderAuthMetadataValue[]
  | { [key: string]: OpencodeProviderAuthMetadataValue };

export type OpencodeOauthAuth = {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  metadata?: Record<string, OpencodeProviderAuthMetadataValue>;
  accountId?: string;
  enterpriseUrl?: string;
};

export type OpencodeProviderAuth = OpencodeApiAuth | OpencodeOauthAuth;
export type OpencodeRuntimeProviderAuth =
  | { type: "api"; key: string; settings?: Record<string, string> }
  | {
      type: "oauth";
      access: string;
      expires: number;
      metadata?: Record<string, OpencodeProviderAuthMetadataValue>;
      refresh: string;
    };
export type WorkspaceImageQualificationProviderAuthLease = {
  providerID: string;
  modelID: string;
  auth: OpencodeProviderAuth;
};

export type OpencodeProviderAuthSourceValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly OpencodeProviderAuthSourceValue[]
  | { readonly [key: string]: OpencodeProviderAuthSourceValue };

const ApiProviderAuthSchema = Type.Object(
  {
    type: Type.Literal("api"),
    key: Type.String({ pattern: "\\S" }),
    metadata: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  { additionalProperties: true },
);

const OauthProviderAuthMetadataSchema = Type.Record(Type.String(), JsonValueSchema);

// Mirrors the generated SDK OAuth shape: what opencode reads from its auth
// file. `expires` is epoch milliseconds; 0 marks tokens that never expire
// (GitHub Copilot stores the GitHub token that way). Integer, not number:
// opencode's auth.json reader silently drops entries with fractional expires,
// which would surface as "no credential" with no error anywhere.
const OauthProviderAuthSchema = Type.Object(
  {
    type: Type.Literal("oauth"),
    refresh: Type.String({ minLength: 1 }),
    access: Type.String({ minLength: 1 }),
    expires: Type.Integer({ minimum: 0 }),
    metadata: Type.Optional(OauthProviderAuthMetadataSchema),
    accountId: Type.Optional(Type.String()),
    enterpriseUrl: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

/** An API-key or OAuth credential as OpenCode stores it, wherever one crosses a process boundary. */
export const OpencodeProviderAuthSchema = Type.Union([
  ApiProviderAuthSchema,
  OauthProviderAuthSchema,
]);
/** What /internal/workspace-images/qualification-provider-auth answers the image builder. */
export const WorkspaceImageQualificationProviderAuthLeaseSchema = Type.Object(
  {
    providerID: Type.String({ minLength: 1 }),
    modelID: Type.String({ minLength: 1 }),
    /**
     * Any JSON: validateOpencodeProviderAuth checks it next, so its provider-named error is the one
     * that surfaces.
     */
    auth: JsonValueSchema,
  },
  { additionalProperties: false },
);

// Matches the provider_id check constraints in schema.ts, which also require
// the stored id to be trimmed and lowercase.
const providerIdPattern = /^[a-z0-9][a-z0-9_-]*$/;

export const normalizeOpencodeProviderId = (providerId: string) => {
  const normalizedProviderId = providerId.trim().toLowerCase();
  if (!providerIdPattern.test(normalizedProviderId)) {
    throw new Error("Opencode provider id is invalid.");
  }
  return normalizedProviderId;
};

/** The provider whose Provider Accounts hold a Claude sign-in's inference token as their key. */
export const claudeSubscriptionProviderID = "claude-subscription";

/** Whether a member can connect the provider with an API key: a Claude subscription only signs in. */
export const takesApiKey = (providerId: string) => providerId !== claudeSubscriptionProviderID;

export const validateOpencodeProviderAuth = (
  providerId: string,
  source: OpencodeProviderAuthSourceValue,
): OpencodeProviderAuth => {
  const auth: unknown = source;
  if (!Value.Check(OpencodeProviderAuthSchema, auth)) {
    throw new Error(
      `Opencode credentials for provider ${providerId} must be valid API-key or OAuth entries.`,
    );
  }
  if (providerId === claudeSubscriptionProviderID && auth.type !== "api")
    throw new Error(`A ${providerId} Provider Account does not take ${auth.type} credentials.`);
  if (auth.type === "api") {
    const validatedAuth: OpencodeApiAuth = { type: "api", key: auth.key.trim() };
    if (auth.metadata !== undefined) validatedAuth.metadata = auth.metadata;
    return validatedAuth;
  }
  const validatedAuth: OpencodeOauthAuth = {
    type: "oauth",
    refresh: auth.refresh,
    access: auth.access,
    expires: auth.expires,
  };
  if (auth.metadata !== undefined) validatedAuth.metadata = auth.metadata;
  if (auth.accountId !== undefined) validatedAuth.accountId = auth.accountId;
  if (auth.enterpriseUrl !== undefined) validatedAuth.enterpriseUrl = auth.enterpriseUrl;
  return validatedAuth;
};

export const validateWorkspaceImageQualificationProviderAuthLease = (
  source: OpencodeProviderAuthSourceValue,
): WorkspaceImageQualificationProviderAuthLease => {
  const lease = Value.Parse(WorkspaceImageQualificationProviderAuthLeaseSchema, source);
  const providerID = normalizeOpencodeProviderId(lease.providerID);
  if (providerID !== lease.providerID) {
    throw new Error("Workspace Image qualification provider id is not normalized.");
  }
  const modelID = lease.modelID.trim();
  if (!modelID || modelID !== lease.modelID) {
    throw new Error("Workspace Image qualification model id is invalid.");
  }
  const auth = validateOpencodeProviderAuth(providerID, lease.auth);
  return {
    providerID,
    modelID,
    auth,
  };
};

export const hydrateOpencodeProviderAuth = (
  auth: OpencodeProviderAuth,
): OpencodeRuntimeProviderAuth => {
  if (auth.type === "api") {
    return auth.metadata
      ? { type: "api", key: auth.key, settings: auth.metadata }
      : { type: "api", key: auth.key };
  }
  const metadata = { ...auth.metadata };
  if (auth.accountId) metadata.accountID = auth.accountId;
  if (auth.enterpriseUrl) metadata.enterpriseUrl = auth.enterpriseUrl;
  return {
    type: "oauth",
    access: auth.access,
    expires: auth.expires,
    metadata,
    refresh: auth.refresh,
  };
};
