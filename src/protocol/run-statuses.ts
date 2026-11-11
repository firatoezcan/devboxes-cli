/**
 * The statuses of an ended Run. A paused Run stopped at its model account's usage limit with its
 * work kept, and its Session continues when a person asks.
 */
export const endedRunStatuses = ["succeeded", "failed", "cancelled", "paused"] as const;

/** The statuses of a Run that waits to start or works, with no stop requested. */
export const activeRunStatuses = ["queued", "running"] as const;

/** The statuses of a Run that has not ended: it is active, or stops at a request. */
export const unendedRunStatuses = [...activeRunStatuses, "cancel_requested"] as const;

/** Every status of a Run. Its Task has none of its own. */
export const runStatuses = [...unendedRunStatuses, ...endedRunStatuses] as const;
