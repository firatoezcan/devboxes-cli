import { type Static, t as Type } from "elysia";

export const WorkspaceModelSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 300 }),
    name: Type.String({ minLength: 1, maxLength: 300 }),
  },
  { additionalProperties: false },
);

export const WorkspaceModelResolutionSchema = Type.Union([
  Type.Object(
    {
      outcome: Type.Literal("usable"),
      providerLabel: Type.String({ minLength: 1, maxLength: 300 }),
      models: Type.Array(WorkspaceModelSchema, { minItems: 1, maxItems: 500 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      outcome: Type.Literal("invalid"),
      reason: Type.Union([
        Type.Literal("provider_not_connected"),
        Type.Literal("credential_rejected"),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      outcome: Type.Literal("unavailable"),
      reason: Type.Union([
        Type.Literal("resolution_pending"),
        Type.Literal("reachability_model_unavailable"),
        Type.Literal("reachability_failed"),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      outcome: Type.Literal("rate_limited"),
      reason: Type.Literal("account_rate_limited"),
    },
    { additionalProperties: false },
  ),
]);

export type WorkspaceModelResolution = Static<typeof WorkspaceModelResolutionSchema>;

export const workspaceModelResolutionLeaseMs = 20 * 60_000;
export const workspaceModelResolutionTokenLifetimeSeconds = 25 * 60;

export const workspaceModelResolutionFailureMessage = (
  resolution: Exclude<WorkspaceModelResolution, { outcome: "usable" }>,
) => {
  switch (resolution.reason) {
    case "provider_not_connected":
      return "OpenCode did not resolve this authenticated Runner provider credential.";
    case "credential_rejected":
      return "OpenCode rejected this Runner provider credential.";
    case "resolution_pending":
      return "Workspace model resolution is pending for this Runner provider credential.";
    case "reachability_model_unavailable":
      return "OpenCode did not resolve a reachability model for this Runner provider credential.";
    case "reachability_failed":
      return "OpenCode could not complete this Runner provider credential reachability request.";
    case "account_rate_limited":
      return "The Provider rate-limited this Runner provider credential reachability request.";
  }
};

export const workspaceModelResolutionPath = "/api/internal/model-resolutions/:resolutionId/result";
