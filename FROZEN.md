# Frozen contracts

This contract is compiled into the shipped `devboxes` binary by
`bun build --compile` and imported by the dashboard API at runtime. Whatever is
listed here exists on user machines and in published container images we cannot
patch. **Changing a frozen value breaks binaries and images in the wild** — the
correct move is always a new `launchProtocols` tag, a new connector `kind`, or
an additive field, never an edit to a frozen constant.

`src/protocol/frozen.test.ts` pins every constant below with literal-equality
assertions. That test is a change-detector on purpose; red there means you
are about to break shipped artifacts.

## The constants, and who reads each one

| Contract                      | Value                                                                                                                    | Reader that would break                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launch protocol tag           | `devboxes-launch-v1`                                                                                                     | Every runner's claim negotiation; the server refuses non-mutual claims with `listener_upgrade_required`                                                  |
| Client-owned launch env keys  | `DEVBOX_BACKEND_BASE_URL`, `DEVBOX_OPENCODE_PROVIDER_AUTH_URL`, `DEVBOX_OPENCODE_CONFIG_JSON_FILE`                       | Shipped runtimes overlay exactly these keys over the served spec; serving them would be silently ignored, renaming them orphans the overlay              |
| Daemon bootstrap protocol tag | `devboxes-daemon-bootstrap-v1`                                                                                           | `/entrypoint.sh` baked into every published runner image exits `upgrade_required` on mismatch                                                            |
| Container home                | `/home/workspace`                                                                                                        | Published images (user, permissions), served spec env, daemon auth-file path                                                                             |
| Secrets dir + files           | `/run/devboxes/secrets/{backend-token,opencode-config.json}`                                                             | Shipped runner binaries bind-mount to these targets; the in-container daemon reads them                                                                  |
| Daemon entrypoint             | `/entrypoint.sh`                                                                                                         | Baked into every published runner image                                                                                                                  |
| Task container name           | `firops-opencode-task-<sha256(taskId)[0:12]>`                                                                            | Startup reconciliation matches leftover containers by re-deriving names                                                                                  |
| State image                   | `firops/opencode-task-state:<sha256(taskId)[0:12]>`                                                                      | Stop must find and delete snapshots committed by any earlier runner build                                                                                |
| Reconciliation labels         | `devboxes.firops.io/workload=opencode-dispatch-task`, `devboxes.firops.io/task-id`, `devboxes.firops.io/organization-id` | Shipped runner binaries and the Kubernetes driver list and re-adopt leftovers by these exact keys; they stay runtime-composed and win over served labels |
| Provider-auth route shape     | `/opencode-tasks/:taskId/provider-auth` + per-task bearer                                                                | Baked into image entrypoints and shipped daemons                                                                                                         |
| Runner machine API prefix     | `/api/internal/runner-machines/*`                                                                                        | Every shipped runner's Eden client; Eden coupling is compile-time, so route paths cannot move                                                            |
| Upgrade stop code             | `listener_upgrade_required`                                                                                              | Shipped runners exit cleanly (containers left for re-adoption) when any runner-machine response carries it                                               |
| Task-callback stop code       | `task_callback_terminal`                                                                                                 | Daemons in published runner images stop on a per-task callback 401 carrying it; dropping it revives the unbounded poll loop                              |
| Device registration client id | `devboxes-listener-registration`                                                                                         | Shipped runners send it on device-auth start; the server validates it                                                                                    |
| Credential store format       | age-encrypted `provider-credentials.json.age`, version 1                                                                 | Every existing on-device store; a format change strands stored subscriptions                                                                             |

## Not frozen (churn lands here, server-side)

- Launch spec **content**: env keys/values (minus the client-owned three),
  entrypoint, working dir, labels, memory-backed paths — served per claim.
- Connector descriptors: vendor URLs, public client ids, scopes, TTLs,
  verification hosts — served by `/internal/runner-machines/connectors`.
- `DEVBOX_LISTENER_MIN_VERSION` — operator lever, not a wire contract.
