# Devboxes CLI

Start coding tasks, check their results, and run a Docker-based Devboxes runner from your terminal. The CLI can also expose task commands to an agent through MCP.

## Install and sign in

```sh
pnpm add --global devboxes
devboxes --version
devboxes login
```

Approve the terminal in your browser. You need an active Devboxes organization; owners and admins can start runs. See the [installation guide](https://docs.devboxes.ai/guide/installation) for native downloads and checksum verification.

## Start a task

Use an existing project and a branch that exists in its repository:

```sh
devboxes dispatch --repo your-team/your-repository --branch main \
  https://github.com/your-team/your-repository/issues/123
```

The default blueprint is **Implement GitHub Issue**. The CLI recognizes issue URLs and `owner/repo#123` references and supplies their issue instructions. For another workflow, pass its exact `--blueprint-version` ID. Set `--project` to choose a project directly; it overrides `--repo`.

The response includes a session ID. Use that ID, not the run ID, for these commands:

```sh
devboxes status <agentSessionId>
devboxes result <agentSessionId>
devboxes continue <agentSessionId> "Address the review feedback and rerun the relevant tests."
```

`status` reads once. `result` exits with status 1 while work is unfinished. A terminal run can succeed, fail, or be cancelled; inspect `runStatus` and the outcome. A successful execution is not merge approval.

## Run tasks on this machine

With Docker running:

```sh
devboxes connect
devboxes credentials setup
devboxes doctor
devboxes listen
```

Keep the listener running to accept work. It defaults to one concurrent task; use `--max-concurrent` to change the limit. Local credentials remain local unless you explicitly run `devboxes credentials sync`, which shares supported credentials through encrypted organization storage.

## Use with an agent

```sh
devboxes mcp
```

This serves `dispatch_task`, `continue_session`, `get_session_status`, and `get_session_result` over stdio. The [automation reference](https://docs.devboxes.ai/reference/automation) defines inputs and result handling. Terminal commands also support `--json` where listed by `--help`.

## Error telemetry

The CLI sends no error telemetry unless you enable it with a self-hosted Sentry
DSN and an environment name:

```sh
devboxes telemetry enable \
  --dsn https://PUBLIC_KEY@sentry.devboxes.ai/PROJECT_ID \
  --environment production
```

Disable it through the same CLI setting:

```sh
devboxes telemetry disable
```

Enabled events contain a fixed CLI error marker, the CLI runtime, version, and
the environment name you supplied. They exclude command arguments, credentials,
environment-variable values, prompts, transcripts, cookies, authorization
headers, OAuth codes, task tokens, request data, breadcrumbs, and user context.
The organization running the self-hosted Sentry instance controls storage and
retention.

Telemetry initialization or delivery failures append a local record containing
only the timestamp, CLI runtime, version, and failure class to
`<config path>.telemetry.log`. They do not change command output or exit status.
An initialization failure or command-error report gets one second in total
before the CLI continues.

See the [Devboxes documentation](https://docs.devboxes.ai) for the user guide.
Report bugs on the [issue tracker](https://github.com/firatoezcan/devboxes-cli/issues)
and security concerns through the
[security policy](https://github.com/firatoezcan/devboxes-cli/blob/main/SECURITY.md).
