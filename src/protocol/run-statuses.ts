/**
 * The statuses of an ended Run. A paused Run stopped at its model account's usage limit with its
 * work kept, and its Session continues when a person asks.
 */
export const endedRunStatuses = ["succeeded", "failed", "cancelled", "paused"] as const;

/** Every status of a Run. Its Task has none of its own. */
export const runStatuses = ["queued", "running", "cancel_requested", ...endedRunStatuses] as const;
