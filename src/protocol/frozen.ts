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
export const listenerRegistrationDeviceClientId = "devboxes-listener-registration";
export const credentialStoreFileName = "provider-credentials.json.age";
export const credentialStoreVersion = 1;
