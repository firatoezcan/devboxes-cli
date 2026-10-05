import Type from "typebox";
import Value from "typebox/value";

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

export const ProviderAuthRecordSchema = Type.Object(
  { type: Type.String({ minLength: 1 }) },
  { additionalProperties: true },
);
const WorkspaceImageQualificationProviderAuthLeaseSchema = Type.Object(
  {
    providerID: Type.String({ minLength: 1 }),
    modelID: Type.String({ minLength: 1 }),
    auth: ProviderAuthRecordSchema,
  },
  { additionalProperties: false },
);

const ApiProviderAuthSchema = Type.Object(
  {
    type: Type.Literal("api"),
    key: Type.Optional(Type.String()),
    metadata: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);

const ApiProviderAuthMetadataSchema = Type.Record(Type.String(), Type.String());

const OauthProviderAuthMetadataValueSchema = Type.Cyclic(
  {
    OauthProviderAuthMetadataValue: Type.Union([
      Type.String(),
      Type.Number(),
      Type.Boolean(),
      Type.Null(),
      Type.Array(Type.Ref("OauthProviderAuthMetadataValue")),
      Type.Record(Type.String(), Type.Ref("OauthProviderAuthMetadataValue")),
    ]),
  },
  "OauthProviderAuthMetadataValue",
);
const OauthProviderAuthMetadataSchema = Type.Record(
  Type.String(),
  OauthProviderAuthMetadataValueSchema,
);

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

export const validateOpencodeProviderAuth = (
  providerId: string,
  auth: OpencodeProviderAuthSourceValue,
): OpencodeProviderAuth => {
  const candidate = Value.Parse(ProviderAuthRecordSchema, auth);

  if (candidate.type === "api") {
    const apiAuth = Value.Parse(ApiProviderAuthSchema, auth);
    if (!apiAuth.key?.trim()) {
      throw new Error(`Opencode API credentials for provider ${providerId} are invalid.`);
    }
    const metadata =
      apiAuth.metadata === undefined
        ? undefined
        : Value.Parse(ApiProviderAuthMetadataSchema, apiAuth.metadata);
    const validatedAuth: OpencodeApiAuth = {
      type: "api",
      key: apiAuth.key.trim(),
    };
    if (metadata !== undefined) validatedAuth.metadata = metadata;
    return validatedAuth;
  }

  if (candidate.type === "oauth") {
    const oauthAuth = Value.Parse(OauthProviderAuthSchema, auth);
    const validatedAuth: OpencodeOauthAuth = {
      type: "oauth",
      refresh: oauthAuth.refresh,
      access: oauthAuth.access,
      expires: oauthAuth.expires,
    };
    if (oauthAuth.metadata !== undefined) validatedAuth.metadata = oauthAuth.metadata;
    if (oauthAuth.accountId !== undefined) validatedAuth.accountId = oauthAuth.accountId;
    if (oauthAuth.enterpriseUrl !== undefined) {
      validatedAuth.enterpriseUrl = oauthAuth.enterpriseUrl;
    }
    return validatedAuth;
  }

  throw new Error(
    `Opencode credentials for provider ${providerId} must be API-key or OAuth entries.`,
  );
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
