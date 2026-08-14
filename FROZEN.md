# Frozen contracts

This contract is compiled into the shipped `devboxes` binary by
`bun build --compile` and imported by the dashboard API at runtime. Whatever is
listed here is the current shape compiled into user machines and published
Workspace Images. A launch-contract replacement is atomic: the API and runners
serve and accept only the one protocol named below.

`src/protocol/frozen.test.ts` pins every constant below with literal-equality
assertions. That test is a change-detector on purpose; red there means you
are about to break shipped artifacts.

## The constants, and who reads each one

| Contract                      | Value                                                                                                                    | Reader that would break                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace launch protocol tag | `devboxes-launch-v5`                                                                                                     | The API, direct CLI, Kubernetes runner, and Workspace daemon agree on the exact capability shape before work is leased                                   |
| Client-owned launch env keys  | `DEVBOX_BACKEND_BASE_URL`, `DEVBOX_OPENCODE_PROVIDER_AUTH_URL`, `DEVBOX_OPENCODE_CONFIG_JSON_FILE`                       | Shipped runtimes overlay exactly these keys over the served spec; serving them would be silently ignored, renaming them orphans the overlay              |
| Daemon bootstrap protocol tag | `devboxes-daemon-bootstrap-v1`                                                                                           | `/entrypoint.sh` baked into every published Workspace Image exits `upgrade_required` on mismatch                                                         |
| Container home                | `/home/workspace`                                                                                                        | Published Workspace Images (user, permissions), served spec env, daemon auth-file path                                                                   |
| Secrets dir + files           | `/run/devboxes/secrets/{backend-token,opencode-config.json}`                                                             | Shipped runner binaries bind-mount to these targets; the in-container daemon reads them                                                                  |
| Daemon entrypoint             | `/entrypoint.sh`                                                                                                         | Baked into every published Workspace Image                                                                                                               |
| Task container name           | `firops-opencode-task-<sha256(taskId)[0:12]>`                                                                            | Startup reconciliation matches leftover containers by re-deriving names                                                                                  |
| State image                   | `firops/opencode-task-state:<sha256(taskId)[0:12]>`                                                                      | Stop must find and delete snapshots committed by any earlier runner build                                                                                |
| Reconciliation labels         | `devboxes.firops.io/workload=opencode-dispatch-task`, `devboxes.firops.io/task-id`, `devboxes.firops.io/organization-id` | Shipped runner binaries and the Kubernetes driver list and re-adopt leftovers by these exact keys; they stay runtime-composed and win over served labels |
| Provider-auth route shapes    | `/opencode-tasks/:taskId/provider-auth` and `/model-resolutions/:resolutionId/provider-auth` + per-capability bearer     | The Workspace daemon selects the route declared by the current launch capability                                                                         |
| Daemon bootstrap route        | `/api/runner-versions/:version` + signed Task or provider-model-resolution bearer                                        | Every Workspace Image fetches its exact server-pinned daemon before either capability can start                                                          |
| Runner machine API prefix     | `/api/internal/runner-machines/*`                                                                                        | Every shipped runner's Eden client; Eden coupling is compile-time, so route paths cannot move                                                            |
| Upgrade stop code             | `listener_upgrade_required`                                                                                              | Shipped runners exit cleanly (containers left for re-adoption) when any runner-machine response carries it                                               |
| Task-callback stop code       | `task_callback_terminal`                                                                                                 | Daemons in published Workspace Images stop on a per-task callback 401 carrying it; dropping it revives the unbounded poll loop                           |
| Engine permission stop code   | `engine_permission_policy_violation`                                                                                     | Daemons stop on a per-task callback 409 carrying it; the API returns it only after atomically failing the Task, Run, and current step                    |
| Device registration client id | `devboxes-listener-registration`                                                                                         | Shipped runners send it on device-auth start; the server validates it                                                                                    |
| Credential store format       | age-encrypted `provider-credentials.json.age`, version 1                                                                 | Every existing on-device store; a format change strands stored subscriptions                                                                             |

## Current Workspace capability protocol

`devboxes-launch-v5` runs agent-controlled processes under uid 1001. The runtime
starts the capability-limited daemon as uid 0 with shared gid 1000 and grants
`CHOWN`, `SETGID`, and `SETUID` so it can assign agent-owned auth files and
establish that boundary. Docker also grants `DAC_OVERRIDE` so the daemon can
read the listener-owned mode-0600 secret bind mounts, and sets
`no-new-privileges` before the agent boundary. The daemon alone can access its
mode-0700 publication directory and root-readable backend token.
The same protocol carries either an `agent-task` or a
`provider-model-resolution` capability. OpenCode is installed and executed only
inside the Workspace Image. It resolves the authenticated Provider/plugin model
set and uses bounded TanStack AI sessions to prove each candidate against that
account. Only exact successes enter the result. The API and direct CLI never
package or spawn OpenCode; they validate, persist, union, repair-authorize, and
lock only the Workspace result. The runner keeps matching local credential
material behind its capability broker. For an Organization credential, the
server keeps encrypted claim-time authority. A runner that does not advertise
`devboxes-launch-v5` receives `listener_upgrade_required` before any work is
leased.

OAuth authority is `subscription`. API-key authority is `metered` only when
the selected model has engine cost metadata; otherwise it is `unavailable`.
Missing money is never inferred as zero.

New runners write credential-store version 2, where every entry key is an exact
provider id. They migrate unambiguous v1 entries in memory, but a v1 `opencode`
entry must be reconnected because it could mean OpenCode Go or OpenCode Zen.
Shipped v1 readers reject version 2 as newer instead of serving an exact Zen
credential under their old Go mapping.

The listener reports and omits a configured ambiguous reference. If the
encrypted store cannot be decrypted, validated as a supported version, or read
without ambiguous provider meaning, the listener reports the store and omits
all store-derived providers for that process. It still polls with healthy file
references or an empty local set for Organization credentials. Startup never
rewrites or deletes the rejected store; credential setup or removal owns any
store change.

## Not frozen (churn lands here, server-side)

- Launch spec **content**: env keys/values (minus the client-owned three),
  entrypoint, working dir, labels, memory-backed paths — served per claim.
- Connector descriptors: vendor URLs, public client ids, scopes, TTLs,
  verification hosts — served by `/internal/runner-machines/connectors`.
- `DEVBOX_LISTENER_MIN_VERSION` — operator lever, not a wire contract.
