# Runner and executor contract

The [zero-user reset](../../docs/product/session-decisions.md#current-owner-correction-zero-user-cli-first-reset)
and [ruthless MVP directive](../../docs/product/ruthless-mvp-directive.md) govern
the current API, CLI, and executor together. This file describes current
boundaries, not compatibility guarantees for retired protocols.

## Contract owners

- `packages/platform/src/protocol/launch-spec.ts` defines
  `devboxes-native-launch` and the required Task environment: the Task
  identity and the Run's `TRACEPARENT`, which the Runner claim returns and the
  executor sends on every callback and Git request.
- `packages/platform/src/protocol/runner-payload.ts` defines the native Task
  payload, execution snapshot, inputs, and Review results.
- `apps/firops-api/src/execution/runners.ts` owns
  `/api/internal/execution/runners` claims, assignments, stop reports, and
  Runner heartbeat expiry.
- `apps/firops-api/src/execution/callbacks.ts` owns Task callbacks.
  `execution/authority.ts` validates the signed Run token against the Task,
  Run, Organization, and current actor authority.
- `packages/devbox/src/runner/docker-task-runtime.ts` owns Docker launch.
  The container name is `devboxes-task-<taskId>` and its identity label is
  `devboxes.task`. Launch reuses the existing named container when present.

## Native execution isolation

The Runner stages the SHA-256-verified executor and mounts it read-only at
`/usr/local/bin/devboxes-executor`. The container starts as `0:1000` with
`DAC_OVERRIDE`, `SETGID`, and `SETUID`; it drops all other capabilities and uses
`no-new-privileges`.

The Run token is supplied as `DEVBOX_BACKEND_TOKEN` in Docker Env and is visible
to anyone with Docker access. The private executor captures its configuration,
sanitizes the process environment, and drops to uid 1001 before importing the
native execution module. The in-process uid change makes the executor
non-dumpable under Docker, so other uid 1001 processes cannot read its
environment or memory. Non-dumpability under gVisor, the managed runtime, is
unverified until the post-release drill Run.

The executor's Git children do not receive the token. For each Git transfer,
the executor opens a loopback listener that adds the token and forwards only Git
fetch requests to the Task repository. While a transfer runs, any local process
can fetch the same repository through that listener.

The executor starts OpenCode with project configuration, so a repository's
OpenCode plugins load inside the executor process and can reach the Run token.
Follow-up issue #1556 tracks closing that path.

The existing Workspace Image qualification owner verifies the native runtime
against the selected image. Runner, callback, and native qualification tests
must exercise these boundaries rather than pin retired implementation constants.
