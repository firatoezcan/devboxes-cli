import { createHash } from "node:crypto";

import Type, { type Static } from "typebox";
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

type OpencodeWellKnownAuth = {
  type: "wellknown";
  key: string;
  token: string;
};

export type OpencodeProviderAuthJson = Record<
  string,
  OpencodeApiAuth | OpencodeOauthAuth | OpencodeWellKnownAuth
>;

// What validation actually admits: opencode's wellknown entries never pass
// this boundary, so downstream code can rely on the api/oauth split.
export type OpencodeProviderAuth = OpencodeApiAuth | OpencodeOauthAuth;

export type OpencodeProviderAuthSourceValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | OpencodeProviderAuthSourceValue[]
  | { [key: string]: OpencodeProviderAuthSourceValue };

// The provider-auth endpoint has two complete server implementations — the
// dashboard's internal route (claim-captured organization credentials) and the
// runner machine's local credential broker (claim-captured local credentials).
// Both serve this route shape with a per-task bearer token, and the in-container
// daemon talks to whichever base URL its task was launched with.
export const opencodeProviderAuthPath = "/opencode-tasks/:taskId/provider-auth";

export const OpencodeProviderAuthResponseSchema = Type.Record(
  Type.String({ minLength: 1 }),
  Type.Object({ type: Type.String({ minLength: 1 }) }, { additionalProperties: true }),
);
export type OpencodeProviderAuthResponse = Static<typeof OpencodeProviderAuthResponseSchema>;

const ProviderAuthRecordSchema = Type.Object(
  { type: Type.String({ minLength: 1 }) },
  { additionalProperties: true },
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
// Deliberately narrow charset: provider ids reach container env, broker route
// matching, and the opencode_dispatch_tasks/opencode_provider_credentials
// check constraints, so dots, slashes, and uppercase are rejected rather than
// escaped. Must stay in sync with those database check constraints.
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
  let candidate: { type: string };
  try {
    candidate = Value.Parse(ProviderAuthRecordSchema, auth);
  } catch {
    throw new Error(`Opencode credentials for provider ${providerId} are invalid.`);
  }

  if (candidate.type === "api") {
    let apiAuth: Static<typeof ApiProviderAuthSchema>;
    try {
      apiAuth = Value.Parse(ApiProviderAuthSchema, auth);
    } catch {
      throw new Error(`Opencode API credentials for provider ${providerId} are invalid.`);
    }
    if (!apiAuth.key?.trim()) {
      throw new Error(`Opencode API credentials for provider ${providerId} are invalid.`);
    }
    let metadata: Record<string, string> | undefined;
    if (apiAuth.metadata !== undefined) {
      try {
        metadata = Value.Parse(ApiProviderAuthMetadataSchema, apiAuth.metadata);
      } catch {
        throw new Error(`Opencode API credential metadata for provider ${providerId} is invalid.`);
      }
    }
    const validatedAuth: OpencodeApiAuth = {
      type: "api",
      key: apiAuth.key.trim(),
    };
    if (metadata !== undefined) validatedAuth.metadata = metadata;
    return validatedAuth;
  }

  if (candidate.type === "oauth") {
    let oauthAuth: Static<typeof OauthProviderAuthSchema>;
    try {
      oauthAuth = Value.Parse(OauthProviderAuthSchema, auth);
    } catch {
      throw new Error(`Opencode OAuth credentials for provider ${providerId} are invalid.`);
    }
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

export const opencodeProviderAuthFingerprint = (providerId: string, auth: OpencodeProviderAuth) => {
  let canonicalAuth: OpencodeProviderAuth;
  if (auth.type === "api") {
    canonicalAuth = { type: auth.type, key: auth.key };
    if (auth.metadata) {
      canonicalAuth.metadata = Object.fromEntries(
        Object.entries(auth.metadata).sort(([left], [right]) => left.localeCompare(right)),
      );
    }
  } else {
    canonicalAuth = {
      type: auth.type,
      refresh: auth.refresh,
      access: auth.access,
      expires: auth.expires,
    };
    if (auth.accountId !== undefined) canonicalAuth.accountId = auth.accountId;
    if (auth.enterpriseUrl !== undefined) canonicalAuth.enterpriseUrl = auth.enterpriseUrl;
    if (auth.metadata !== undefined) {
      canonicalAuth.metadata = Object.fromEntries(
        Object.entries(auth.metadata).sort(([left], [right]) => left.localeCompare(right)),
      );
    }
  }
  return createHash("sha256")
    .update(`${normalizeOpencodeProviderId(providerId)}\0${JSON.stringify(canonicalAuth)}`)
    .digest("hex");
};
