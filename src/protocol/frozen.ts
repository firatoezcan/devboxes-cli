import { type Static, t as Type } from "elysia";

export const reconciliationLabels = {
  workload: "devboxes.firops.io/workload",
  workloadValue: "opencode-dispatch-task",
  taskId: "devboxes.firops.io/task-id",
  organizationId: "devboxes.firops.io/organization-id",
} as const;

export const runnerMachineApiPrefix = "/api/internal/runner-machines";
export const runnerMachineRoutePrefix = "/internal/runner-machines";
export const listenerUpgradeRequiredCode = "listener_upgrade_required";
// The daemon half of listener_upgrade_required: a per-task callback 401 that
// carries this code says the task is over for the token holder, so the
// in-container daemon stops instead of polling a dead task at POLL_MS
// forever. Daemons baked into published Workspace Images match the literal.
export const opencodeTaskCallbackTerminalCode = "task_callback_terminal";
// A permission request proves the Run's full-permission engine policy did not
// hold. The API fails the Run with this wire code and the daemon stops.
export const opencodeEnginePermissionPolicyErrorCode = "engine_permission_policy_violation";
export const githubTaskCredentialFailureCodes = {
  envelopeInvalid: "github_app_task_credential_envelope_invalid",
  installationRepositoryMismatch: "github_app_installation_repository_mismatch",
  installationRevoked: "github_app_installation_revoked",
  installationSuspended: "github_app_installation_suspended",
  reconsentRequired: "github_app_reconsent_required",
  repositoryAccessRevoked: "github_app_repository_access_revoked",
  responseInvalid: "github_app_task_credential_response_invalid",
} as const;
export const GitHubTaskCredentialFailureCodeSchema = Type.Union([
  Type.Literal(githubTaskCredentialFailureCodes.envelopeInvalid),
  Type.Literal(githubTaskCredentialFailureCodes.installationRepositoryMismatch),
  Type.Literal(githubTaskCredentialFailureCodes.installationRevoked),
  Type.Literal(githubTaskCredentialFailureCodes.installationSuspended),
  Type.Literal(githubTaskCredentialFailureCodes.reconsentRequired),
  Type.Literal(githubTaskCredentialFailureCodes.repositoryAccessRevoked),
  Type.Literal(githubTaskCredentialFailureCodes.responseInvalid),
]);
export type GitHubTaskCredentialFailureCode = Static<typeof GitHubTaskCredentialFailureCodeSchema>;
export const GitHubTaskCredentialReceiptSchema = Type.Object(
  {
    repositories: Type.Tuple([
      Type.Object(
        {
          externalId: Type.String({ pattern: "^[1-9][0-9]*$" }),
          fullName: Type.String({ minLength: 3 }),
        },
        { additionalProperties: false },
      ),
    ]),
    permissions: Type.Tuple([
      Type.Object(
        { name: Type.Literal("actions"), access: Type.Literal("read") },
        { additionalProperties: false },
      ),
      Type.Object(
        { name: Type.Literal("checks"), access: Type.Literal("read") },
        { additionalProperties: false },
      ),
      Type.Object(
        { name: Type.Literal("contents"), access: Type.Literal("write") },
        { additionalProperties: false },
      ),
      Type.Object(
        { name: Type.Literal("issues"), access: Type.Literal("write") },
        { additionalProperties: false },
      ),
      Type.Object(
        { name: Type.Literal("metadata"), access: Type.Literal("read") },
        { additionalProperties: false },
      ),
      Type.Object(
        { name: Type.Literal("pull_requests"), access: Type.Literal("write") },
        { additionalProperties: false },
      ),
      Type.Object(
        { name: Type.Literal("statuses"), access: Type.Literal("read") },
        { additionalProperties: false },
      ),
      Type.Object(
        { name: Type.Literal("workflows"), access: Type.Literal("write") },
        { additionalProperties: false },
      ),
    ]),
    additionalPermissions: Type.Tuple([]),
    expiresAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
export type GitHubTaskCredentialReceipt = Static<typeof GitHubTaskCredentialReceiptSchema>;

export const revokeGitHubTaskCredential = async (
  token: string,
  signal: AbortSignal = AbortSignal.timeout(10_000),
) => {
  const response = await fetch("https://api.github.com/installation/token", {
    method: "DELETE",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal,
  });

  if (response.status === 204) return "revoked" as const;
  if (response.status === 401) return "already_invalid" as const;

  throw new Error(`GitHub task credential revocation failed: ${response.status}`);
};
export const listenerRegistrationDeviceClientId = "devboxes-listener-registration";
export const credentialStoreFileName = "provider-credentials.json.age";
export const credentialStoreVersion = 1;
