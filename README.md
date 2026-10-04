# Devboxes CLI

The CLI discovers and invokes the application's API-owned commands. Its MCP
server exposes the same discovery and invocation implementation to agents.

The package launcher requires Bun 1.4.2 or later. Published native binaries
include their runtime and do not require a separate JavaScript runtime.

## Run from this checkout

```sh
bun apps/devboxes-cli/src/cli.ts --help
pnpm vp run devboxes#build:smoke
```

Start the API with `pnpm vp run dev:api` and use the printed HTTP origin on
`127.0.0.1` with its assigned port. Local startup needs no DNS or certificate
setup. Remote API connections require HTTPS.

## Create an account or sign in

```sh
devboxes --api https://api.devboxes.ai signup --email you@example.com --name "Your name"
devboxes login --email you@example.com
```

The CLI prompts for a password without echoing it. For automation, pipe the
password into `--password-stdin`; do not put it in command arguments. Use
`--config <path>` to keep separate API origins or accounts in separate files.
Credentials are saved atomically with file mode `0600`. `devboxes logout`
revokes the current session and clears its saved credential.

A two-factor login saves its pending challenge and reports that verification is
required. Discover the installed authentication endpoints and inspect the native
TOTP input before submitting a code:

```sh
devboxes auth
devboxes auth /two-factor/verify-totp
devboxes auth /two-factor/verify-totp --input @verification.json
```

`auth` reads Better Auth's generated schema. It also exposes the installed
password recovery, email verification, account, session, and factor-management
endpoints. An endpoint that accepts both GET and POST requires `--method GET` or
`--method POST`. GET input supplies query parameters; template-path parameters
use the same JSON object. Authentication operations follow the native owner's
semantics. Enrollment results contain authenticator secrets and backup codes;
store them privately.

The CLI redacts session tokens from its output. To revoke one session, submit
`{"id":"<session id>"}` from `/list-sessions` to `/revoke-session`. The CLI
resolves that session's token itself.

## Discover and invoke application commands

```sh
devboxes commands
devboxes describe organizations.create
devboxes invoke organizations.create --input @organization.json
devboxes invoke organizations.list --input @empty.json
```

`organization.json` contains the documented command input, such as
`{"name":"Example team","slug":"example-team"}`. `empty.json` contains `{}`.
Use `--input -` to read JSON from stdin. `--json` selects machine-readable output.
The API's OpenAPI contract defines inputs, results, authority, and errors.

## Join an Organization

An owner uses `invitations.create` to record an invitation for an email address.
The intended recipient verifies that email through the native authentication
flow, discovers the invitation with `invitations.received`, and accepts or
declines with `invitations.respond`. Owners inspect and cancel invitations with
`invitations.list` and `invitations.cancel`.

Invitation creation does not send a notification email. Account-verification
and password-recovery email remain available. Admission requires the inviter to
remain an active owner and cannot replace an active or suspended membership.

## Use the same commands through MCP

```sh
devboxes mcp
```

The stdio server exposes `devboxes_describe` and `devboxes_invoke`. It calls the
same API commands as the terminal. It does not proxy a separate API MCP catalog.

For an agent, issue a bounded grant with `delegations.create`, then supply
`DEVBOXES_API_URL` and `DEVBOXES_TOKEN` to the child process. Both variables are
required; an incomplete scoped connection never loads a personal credential.
Scoped connections cannot manage personal account authentication, and
`devboxes logout` refuses them. Revoke the grant with `delegations.revoke` when
its work ends.

## Run execution capacity

Register a Runner through the discovered `capacity.register` application command.
Use `devboxes runner listen --help` for credential-file, Docker socket, state
directory, and container-reachable API options.

## Native OpenCode daemon

The public source checkout builds `devboxes-daemon`, the standalone native
OpenCode HTTP server. Sessions and the durable event log persist in `opencode.db`
under its data directory. On Linux, that directory is `$XDG_DATA_HOME/opencode`,
or `$HOME/.local/share/opencode` when `XDG_DATA_HOME` is unset or empty. Preserve
this directory across daemon restarts to retain Sessions and replay stored events.

## Verify the CLI

In the Dashboard workspace, run:

```sh
pnpm vp run devboxes#test
pnpm vp run devboxes#test:full
pnpm vp run devboxes#build:smoke
```

The tests use Bun and need no PostgreSQL or ClickHouse service. The smoke command
compiles and executes the host binary. It does not prove another platform's
binary can run.

In the standalone public source checkout, `bun run test` and `bun run test:full`
run the Bun suite without a private workspace runner or an `origin/dev` branch.
The source export retains the local-config, provider-connection, and Docker
socket contracts beside their exported implementations.
