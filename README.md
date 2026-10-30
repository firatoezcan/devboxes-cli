# devboxes CLI

The CLI discovers and invokes the application's API-owned commands. Its MCP
server exposes the same discovery and invocation implementation to agents.

The package launcher requires Bun 1.4.4 or later. Published native binaries
include their runtime and do not require a separate JavaScript runtime.

## Run from source

Install dependencies with `bun install` in the public source repository, or
with `pnpm install` at the root of the Dashboard workspace. Then run these
commands from the package directory: the repository root of the public source,
or `apps/devboxes-cli` in the Dashboard workspace.

```sh
bun src/cli.ts --help
bun run build:smoke
```

## Create an account or sign in

```sh
devboxes signup
devboxes login
```

[Install the CLI and run operations](https://docs.devboxes.ai/guides/cli#sign-in)
describes the sign-in methods, including email codes and passwords, the flags
for scripts and agents, and two-factor completion.

Released binaries embed `https://api.devboxes.ai` as the default API origin
through `scripts/build-cli-binaries.ts`. A source run has no default: it uses a
saved account's origin, and otherwise requires `--api` or `DEVBOXES_API_URL`.
`--api` takes precedence over `DEVBOXES_API_URL`, both override the default, and
a saved configuration keeps the origin it was created for. A local API can use
an HTTP origin on `127.0.0.1`. Remote API connections require HTTPS.

Credentials are saved atomically with file mode `0600`. Use `--config <path>` to
keep separate API origins or accounts in separate files. `devboxes logout`
revokes the current session and clears its saved credential.

`devboxes auth` reads Better Auth's generated schema and exposes the installed
two-factor, email-code, password, account, session, and factor-management
endpoints. An endpoint that accepts both GET and POST requires `--method GET` or
`--method POST`. GET input supplies query parameters; template-path parameters
use the same JSON object. Authentication operations follow the native owner's
semantics. Enrollment results contain authenticator secrets and backup codes;
store them privately.

The CLI redacts session tokens from its output. To revoke one session, submit
`{"id":"<session id>"}` from `/list-sessions` to `/revoke-session`. The CLI
resolves that session's token itself and fails with `SESSION_NOT_FOUND` when the
listing has no session with that id. Describing the operation shows this id
input.

## Discover and invoke application commands

```sh
devboxes commands
devboxes describe organizations.create
devboxes invoke organizations.create
```

In a terminal, `devboxes invoke` asks for the operation's input field by field.
A field such as `organizationId` or `projectId` offers a choice from the matching
list operation, secrets such as keys and tokens are asked without showing what you
type, and the optional fields come last, chosen from a list.

Scripts and agents pass the input as JSON instead, from a file with
`--input @organization.json` or from stdin with `--input -`. Without a terminal or
with `--json`, `devboxes invoke` requires `--input`. `--json` selects
machine-readable output.

The API's OpenAPI contract defines inputs, results, authority, and errors.

## Join an Organization

An owner uses `invitations.create` to invite an email address, and devboxes
emails that address a link to the invitation. When the email doesn't go out,
the answer's `emailed` is `false`, and its `link` is for the owner to share. The intended recipient signs in
to an account with that verified email and accepts or declines on that page,
or with `invitations.received` and `invitations.respond`. Owners inspect and
cancel invitations with `invitations.list` and `invitations.cancel`. To send
the email again, cancel the invitation and create a new one.

An Organization sends at most 60 invitations in 24 hours. Admission requires
the inviter to remain an active owner and cannot replace an active membership.

## Use the same commands through MCP

```sh
devboxes mcp
```

The stdio server exposes `devboxes_describe` and `devboxes_invoke`. It calls the
same API commands as the terminal. It does not proxy a separate API MCP catalog.

For an agent, issue a bounded grant with `delegations.create`, then supply its
token to the child process as `DEVBOXES_TOKEN`. The CLI sends the token to the
`--api` origin, else `DEVBOXES_API_URL`, else the default origin. When
`DEVBOXES_TOKEN` is set, the CLI never loads a personal credential, and an empty
or malformed token fails with `INVALID_DEVBOXES_TOKEN`.
Scoped connections cannot manage personal account authentication, and
`devboxes logout` refuses them. Revoke the grant with `delegations.revoke` when
its work ends.

## Run execution capacity

`devboxes runner add` registers this computer as a Runner through
`runners.add` and saves the Runner key, readable only by the current user,
in `devboxes/runner/token` under the user's configuration directory.
`devboxes runner listen` reads that file unless `--token-file` names another, and
`--state-directory` doesn't move it. Use `devboxes runner listen --help` for the
Docker socket and state directory options.

## Verify the CLI

From the package directory, run:

```sh
bun run test
bun run test:full
bun run build:smoke
```

The tests use Bun and need no PostgreSQL or ClickHouse service. In the public
source, `test` and `test:full` both run the whole suite. In the Dashboard
workspace, `test` runs only the tests selected by changes since `origin/dev`.
The smoke command compiles and executes the host binary. It does not prove
another platform's binary can run.

The source export retains the local-config, provider-connection, and Docker
socket contracts beside their exported implementations.
