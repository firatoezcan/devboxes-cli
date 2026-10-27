/**
 * The statuses of an ended Run and its Task. A paused Run stopped at its model account's usage
 * limit with its work kept, and its Session continues when a person asks.
 */
export const endedRunStatuses = ["succeeded", "failed", "cancelled", "paused"] as const;

/** Every status of a Run and of its Task. */
export const runStatuses = ["queued", "running", "cancel_requested", ...endedRunStatuses] as const;
