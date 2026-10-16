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
  `execution/authority.ts` validates a managed Task's signed Run token, or a
  Runner Task's relayed Runner credential, against the Task, Run, Organization,
  and current actor authority, and a managed Task's token against the client IP
  in `DEVBOX_MANAGED_TASK_SOURCE_CIDRS`.
- `apps/devboxes-cli/src/runner/listen.ts` owns the Runner's relay. It signs
  each executor's token, accepts only Task callbacks with it, and forwards them
  to the API with the Runner credential and the token's Task in
  `devboxes-task`. The API accepts no token from a Runner's container.
- `apps/firops-api/src/execution/tool-cache.ts` owns the tool cache callbacks:
  `/tool-cache`, `/tool-cache-upload` and `/tool-cache-ack`.
  `apps/elysia-opencode/src/executor/execution.ts` restores and saves the
  tool cache.
- `packages/devbox/src/runner/docker-task-runtime.ts` owns Docker launch.
  The container name is `devboxes-task-<taskId>` and its identity label is
  `devboxes.task`. Launch reuses the existing named container when present.
  It also owns the Claude Code volume of a Claude subscription Run.
- `packages/devbox/src/runner/executor-artifact.ts` downloads the executor over
  HTTPS and verifies its SHA-256 digest before the Runner mounts it, and
  verifies Claude Code's npm tarball and the binary in it against the SHA-512
  values that `apps/firops-api/src/execution/claude-code-artifact.ts` pins.
- `apps/elysia-opencode/src/executor/claude-code-launcher.ts` owns the
  launcher that runs a Claude subscription Run's Claude Code as its own uid.
- `apps/firops-api/src/execution/managed.ts` owns managed launch of the Task
  Pod from the SandboxTemplate of the Task's machine size: `devboxes-task`,
  `devboxes-task-large` or `devboxes-task-xl`.

## Native execution isolation

The Runner stages the SHA-256-verified executor and mounts it read-only at
`/usr/local/bin/devboxes-executor`. The container starts as `0:1000` with
`DAC_OVERRIDE`, `SETGID`, and `SETUID`; it drops all other capabilities and uses
`no-new-privileges`.

The executor's token is supplied as `DEVBOX_BACKEND_TOKEN` in Docker Env and is
visible to anyone with Docker access. It authenticates only at the Runner's
relay, which `DEVBOX_BACKEND_BASE_URL` names at `host.docker.internal`. The
relay listens on the host's loopback address under Docker Desktop and OrbStack,
and on the bridge gateway address under a Linux Docker Engine, whose host must
accept container traffic to that address and the relay's port.

The private executor captures its configuration, sanitizes the process
environment, and drops to uid 1001 before importing the native execution
module. The in-process uid change makes the executor non-dumpable under Docker
and under gVisor, the managed runtime, so other uid 1001 processes cannot read
its environment, memory or file descriptors.

A Claude subscription Run's Claude Code runs as uid 1002, which the agent can't
read, signal or trace:

- The Task container has the official Claude Code binary at
  `/run/devboxes/claude-code/claude`, owned by 1002:1002 with mode 0500, on a
  read-only mount. A Docker Runner mounts the named volume
  `devboxes-claude-code-<binary digest>`. On every Claude subscription Task it
  hashes the volume's binary against the pin and fills the volume again from
  the verified npm tarball when they differ, without the Task image's content
  at the mount point. A managed Pod mounts an `emptyDir` that its `claude-code`
  init container fills with `install` from the API image, as root with only
  `CHOWN`, because only root, the owner of the API image's Claude Code, can
  read it.
- Before the privilege drop, and only when `/run/devboxes/claude-code` is a
  read-only mount, which a Task image can't add, bootstrap opens the binary and
  starts the executor again as the launcher with that file descriptor. The
  launcher drops itself to uid 1002 and runs Claude Code through the
  descriptor, so a later change at the binary's path changes nothing. The
  daemon starts each Claude Code process through the launcher's standard input
  and output, which only the daemon holds. When that channel fails, every
  running and later Claude Code request fails with the error, and the daemon
  closes the launcher's input, which ends it.
- Before a Claude subscription Run uses Claude Code, the executor checks that
  the binary is a regular file of uid 1002 that the agent can neither read nor
  run.
- Every Task container mounts an empty read-only directory at
  `/etc/claude-code`. It is Claude Code's home and where Claude Code reads
  policy settings that no flag turns off, so the Task image can't configure
  Claude Code.

The executor's Git children do not receive the token. For each Git transfer, the
executor opens a loopback listener that adds the token and forwards only that
transfer's Git service to the Task repository: fetch, or the publish node's
push. While a transfer runs, any local process can use that service through the
listener. The API accepts a push only while the publish node runs, and only as
the creation of one ref `refs/devboxes/push/<Run>/<UUID>`. It sends that commit
to the Session's branch instead, from the branch head it read, so GitHub refuses
the update if the branch moved meanwhile. GitHub accepts the update whether or
not it is a fast-forward. The publish node succeeds only when the status report
that the listener received from the API accepts that ref. A push that the
workspace's Git configuration sends elsewhere fails the node, although Git
reports success. The report does not identify the commit the API recorded. The
listener therefore forwards only a push whose one command creates that ref at
the commit the publish node pushes. When GitHub refuses the update of a
teammate's pull request branch and branch protection or a ruleset that the App
cannot bypass forbids its direct updates, the API moves the Session to its own
branch. The executor pushes once more after any failed push. When the branch
already holds the pushed commit, before or after GitHub's refusal, the API
records it without updating the branch. When a work or fix Run pauses at its
model account's usage limit before its publish node runs, the executor runs that
node before it saves the checkpoint. The node commits the uncommitted changes as
`Pause at the <provider> usage limit: checkpoint of <Session title>` and pushes
to `refs/devboxes/checkpoint/<Run>/<UUID>` instead of the push ref. With nothing
to push, the node is skipped. The API publishes that ref to the Session's branch
in the same way but opens no pull request. An API from before this contract
refuses the ref, so nothing is published and the checkpoint keeps the work. A
Run that starts from such a checkpoint owes the pull request until a Run after
the paused one pushes, or records a pull request or GitHub's refusal of one:
when its publish node succeeds without a push and the Session's branch is still
at the checkpoint, the API records the branch's open pull request or opens one
with the Session's title. A failed request to GitHub there records nothing and
does not fail the node, so the next such Run tries again.

Every `/nodes` answer carries `pullRequest`: the number of the pull request
that the Run's publication recorded, or null. The daemon release moves the
executor channel before the API rolls, so the executor reads an answer without
`pullRequest` from the previous API as null. Once the publish node succeeds,
the executor names that pull request in the context of every later agent turn,
so a node after it updates the pull request by its number and never looks it
up.

A Run of a taskbox Project has no repository. Its payload's `taskbox` names the
workspace archive that the Session's checkpoint saved, or null for none, and is
null in every other Run. The executor of a taskbox Run uses no Git: it unpacks
that gzip tar into a plain workspace directory, saves the directory the same way
for its checkpoint, through the tool cache's safe pack and unpack, and sends a
null `repositoryStartSha` in `/started`, which the API accepts only from a Run
without a repository. `/repository` answers a taskbox Run with
`EXECUTOR_OUTDATED`, because only an executor from before taskboxes asks it, and
the Git transport refuses one with `REPOSITORY_UNAVAILABLE`. Admission refuses
such a Run a publish node and any `repositories` operation.

The executor embeds OpenCode with the repository's project configuration, so a
repository can define agents and other OpenCode settings. OpenCode in the
executor runs only its built-in plugins and the plugins of the executor and
the devboxes runtime. It ignores `plugins` entries in configuration documents
and files in `plugin` and `plugins` configuration directories, including those
the agent writes during the Run. It turns off the built-in `opencode.warming`
plugin, so a repository's configuration cannot start background model requests
that publish no usage.

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
against the images Worker's reference image for each daemon release, and
against any build on request. Prove a contract change with Runner, callback, and
native qualification tests that exercise actual CLI-to-API and executor-to-API
behavior. Do not add tests that pin protocol values.

## Tool cache

A work or fix Run restores its Project's tool cache after the repository
checkout and before any node. After its last node it takes its final checkpoint
first and then saves the paths that changed. A SIGTERM interrupts the save, and
the API refuses the save of a cancelled Run. `/tool-cache` returns each cached
home path with a signed read URL for its current archive on the executor's
platform. `/tool-cache-upload` signs an archive's upload, and `/tool-cache-ack`
makes it the path's current archive only while the archive the Run restored, or
the absence of one, is still current. Review and recheck Runs get no paths.
Every tool cache failure, including an API without these routes, becomes part
of a notice and never fails the Run. The restore notice is a section of the
Run's first prompt, after its instruction, so it never takes a model turn of its
own; the save notice follows the save. `verify:workspace-image`
proves the restore, the save after the checkpoint, and a SIGTERM during a save.
