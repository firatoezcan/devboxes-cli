# devboxes

The Devboxes CLI signs a terminal in, dispatches coding tasks, follows their
sessions, and runs a local Docker runner. `devboxes mcp` exposes dispatch and
session commands as MCP tools over stdio.

## Install

The primary package runs from source and requires
[Bun](https://bun.sh) 1.3 or newer on `PATH`.

```sh
npm i -g devboxes   # or: bun i -g devboxes
```

Runner hosts without Bun can use standalone binaries from the Devboxes release
channel. Linux binaries ship with checksums; macOS disk images are signed and
notarized. Both channels use the same version.

## Sign in and dispatch

```sh
# Approve this terminal in a browser.
devboxes login

# Dispatch from text, an issue URL, or owner/repository#issue.
devboxes dispatch "Fix the retry backoff in the queue worker" --repo owner/name
devboxes dispatch https://github.com/owner/name/issues/123
devboxes dispatch owner/name#123

# Follow the session and read its outcome.
devboxes status <agentSessionId> [--json]
devboxes result <agentSessionId> [--json]

# Serve dispatch, status, and result as MCP tools.
devboxes mcp
```

`dispatch` accepts `--project`, `--repo`, `--model`, `--branch`, `--title`,
`--blueprint`, and `--json`. Without a project or repository argument, it
matches the working directory's Git `origin` against the organization's
projects.

Hosted Devboxes is the default. Self-hosted installations pass
`--api https://<host>/api`; `--auth` and `--organization` are available when
the deployment requires them.

## Run a local runner

The local runner executes Devboxes tasks in isolated Docker containers on the
machine where `devboxes listen` runs. It accepts local Unix sockets and Windows
named pipes, not remote Docker TCP endpoints. Bare `devboxes` prints help and
never starts the runner.

```sh
# Register this machine. A valid login session is reused when available.
devboxes connect [--name <runner-name>]

# Configure local provider access, then check the complete runner state.
devboxes credentials setup
devboxes doctor
devboxes doctor --live    # also refreshes stored subscriptions against vendors
devboxes doctor --json

# Poll for work and run it in Docker.
devboxes listen [--max-concurrent <n>]
```

`DEVBOX_RUNNER_API_KEY` is the unattended registration path. With it set,
`devboxes connect` registers without browser approval. Otherwise, a valid
saved runner key is reused, then a valid `devboxes login` session, and finally
runner device approval when the machine has no usable credential.

Provider credentials have one command group:

```sh
devboxes credentials setup
devboxes credentials setup --connect openai
devboxes credentials setup --api-key anthropic < key.txt
devboxes credentials setup --all
devboxes credentials status
devboxes credentials sync
devboxes credentials remove --provider openai
```

API keys supplied interactively use a masked prompt; piped values come from
stdin and never appear in the process list. `credentials sync` copies selected
local credentials into the organization's encrypted store for cloud and other
runner machines. Local runs can use the device store directly.

## Configuration

Account and runner state share one owner-only, atomically written file:
`~/.config/devboxes/config.json` (or the platform/XDG equivalent). It preserves
unknown keys and contains the account session, organization, runner identity,
runner API key, and credential references. The encrypted device credential
store remains a separate age-encrypted file beside it.

Invite-cohort machines with the former runner config preserve their machine
identity, API key, and credential references by moving the file before using
this release. Rename `listener.json` to `config.json` under
`$XDG_CONFIG_HOME/devboxes` or `~/.config/devboxes` on Linux,
`~/Library/Application Support/devboxes` on macOS, or `%APPDATA%\devboxes` on
Windows. The CLI does not read the former file path. The Linux default is:

```sh
mv ~/.config/devboxes/listener.json ~/.config/devboxes/config.json
devboxes login
```

Important runner environment variables:

| Variable                             | Purpose                                                       |
| ------------------------------------ | ------------------------------------------------------------- |
| `DEVBOX_OPENCODE_DOCKER_SOCKET_PATH` | Docker Unix socket or Windows named pipe.                     |
| `DEVBOX_OPENCODE_CONFIG_DIR`         | Operator Opencode configuration mounted read-only into tasks. |
| `DEVBOX_OPENCODE_HOME_ROOT`          | Host root for per-task secret files.                          |
| `DEVBOX_RUNNER_NAME`                 | Runner name used by `connect`.                                |
| `DEVBOX_RUNNER_API_KEY`              | Pre-minted key for unattended registration.                   |
| `DEVBOX_API_BASE_URL`                | API base URL; `--api` takes precedence.                       |
| `DEVBOX_AUTH_BASE_URL`               | Auth base URL; `--auth` takes precedence.                     |
| `DEVBOX_ORGANIZATION_ID`             | Organization id; `--organization` takes precedence.           |

## Security model

Giving the CLI a Docker socket grants it control of that Docker daemon and is a
host-trust decision. Dispatched tasks execute organization-supplied code, and a
task that uses a provider receives the corresponding credential. Only allow
trusted organization members to dispatch to a runner and use a dedicated
machine where practical.

The host credential broker listens on a random bridge-reachable port so native
Linux containers can reach it. Every request requires a random per-task bearer
token checked with a timing-safe comparison. Credentials are written only to a
memory-backed filesystem inside the container, never to its environment,
image, or durable layer. The device store is age-encrypted; its passphrase is
retrieved from Devboxes into memory. Deleting the runner prevents future
retrieval but cannot retract plaintext already exposed to a locally controlled
process.

See [SECURITY.md](./SECURITY.md) for the full trust boundary and private
reporting instructions.

## Source, issues, and license

Development happens in a private monorepo. The public
[source mirror](https://github.com/firatoezcan/devboxes-cli) is a read-only
release mirror: npm version `X.Y.Z` matches mirror tag `vX.Y.Z`.

The npm tarball and mirror deliberately include the account CLI, local runner,
frozen runner protocol, and provider-connection implementation under the
[MIT license](./LICENSE). Unifying the products therefore makes runner,
protocol, and provider-connection source that was previously private publicly
available and reusable under MIT. External pull requests are ported into the
monorepo rather than merged directly into the mirror.

Report bugs and feature requests on the mirror issue tracker. Report
vulnerabilities privately as described in [SECURITY.md](./SECURITY.md).
