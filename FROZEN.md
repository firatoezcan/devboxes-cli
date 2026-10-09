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
- `packages/platform/src/protocol/task-runtime.ts` defines the Task container
  layout: the uids and gid, the home and workspace paths, the managed executor
  path, the executor environment, the executor drain time, and Runner heartbeat
  expiry.
- `packages/platform/src/protocol/task-environment.ts` defines the environment
  keys the executor passes through to the agent, and the reserved Task keys.
- `packages/platform/src/protocol/daemon-artifact.ts` defines the daemon
  release's bootstrap protocol and platforms. The API takes the executor digest
  that a Runner claim returns from that release.
- `apps/firops-api/src/execution/runners.ts` owns
  `/api/internal/execution/runners` claims, assignments, stop reports, and
  Runner heartbeat expiry.
- `apps/firops-api/src/execution/callbacks.ts` owns Task callbacks. The hidden
  `runtime-*` routes in `apps/firops-api/src/routes/commands/providers.ts` are
  Task callbacks for the Run's Provider Account.
  `execution/authority.ts` validates the signed Run token against the Task,
  Run, Organization, and current actor authority.
- `packages/devbox/src/runner/docker-task-runtime.ts` owns Docker launch.
  The container name is `devboxes-task-<taskId>` and its identity label is
  `devboxes.task`. Launch reuses the existing named container when present.
- `packages/devbox/src/runner/executor-artifact.ts` downloads the executor over
  HTTPS and verifies its SHA-256 digest before the Runner mounts it.
- `apps/firops-api/src/execution/managed.ts` owns managed launch of the Task
  Pod from the `devboxes-task` SandboxTemplate.

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
the executor opens a loopback listener that adds the token and forwards only that
transfer's Git service to the Task repository: fetch, or the publish node's push.
While a transfer runs, any local process can use that service through the
listener. The API forwards a push only while the publish node runs, and only as
the creation of one staging ref `refs/devboxes/push/<Run>/<UUID>`. It then
moves the Session's branch to that commit with GitHub's `updateRefs`, from the
Run's expected head and without force, and deletes the staging ref. When the
branch does not exist yet, the commit must build on the Run's start head.

The executor embeds OpenCode with the repository's project configuration, so a
repository can define agents and other OpenCode settings. OpenCode in the
executor runs only its built-in plugins and the executor's own plugin. It
ignores `plugins` entries in configuration documents and files in `plugin` and
`plugins` configuration directories, including those the agent writes during
the Run. Project marker discovery imports no plugin.

The executor also turns off configured providers. A configuration cannot name a
provider package or send the provider credential to another endpoint. The
payload's model catalog defines the provider. A dependency patch removes
OpenCode's `{file:...}` expansion, so a configuration cannot copy a file's
contents into a value. `{env:...}` reads the executor's sanitized environment.

Configured local MCP servers and formatters run as separate uid 1001 processes.
The executor itself connects to configured remote MCP servers and downloads
skills from configured URLs. On a Runner, it also sends the agent's web searches
to Exa at `mcp.exa.ai`. Those requests carry only values from the configuration
and the agent.

The existing Workspace Image qualification owner verifies the native runtime
against the selected image. Prove a contract change with Runner, callback, and
native qualification tests that exercise actual CLI-to-API and executor-to-API
behavior. Do not add tests that pin protocol values.
