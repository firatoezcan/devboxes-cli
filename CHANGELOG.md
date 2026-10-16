# devboxes

## 0.7.0

### Minor Changes

- 0c37839: Sign up with GitHub or with an email and a password, and sign in with GitHub, a code that devboxes emails you, or your password. `devboxes signup --email <email>` asks for a password, or reads it with `--password-stdin`, then asks for the six-digit code that devboxes emails you and signs you in. Outside a terminal it creates the account and stops, and `devboxes signup --email <email> --code-stdin` on the same computer finishes it. `devboxes signup --github` creates an account for a GitHub account that isn't linked to one yet. `devboxes login --email` asks for the six-digit code that devboxes emails you; outside a terminal it sends the code and stops, and `--code-stdin` finishes the sign-in. `devboxes login` creates no account. Scripts pipe the password into `devboxes login --email <email> --password-stdin`, which asks for your second factor when two-factor authentication is on. `devboxes signup` no longer takes `--name`.
- 4b69edc: Run `devboxes invoke <operation>` in a terminal and it asks for the input field by field, from the schema the API advertises. A field such as `organizationId` or `projectId` offers a choice from the matching list operation; enums, booleans, unions and nullable fields get a choice or a yes/no question, secrets such as keys and tokens are asked with the typed characters hidden, and the optional fields are offered last. The API marks those secret inputs `writeOnly`. `--input @file` and `--input -` work as before; outside a terminal or with `--json`, `devboxes invoke` requires `--input` and otherwise fails with `INPUT_REQUIRED`. In a terminal, `devboxes connect` asks for the Organization unless you pass `--organization`, and for the Provider Account's name unless you pass `--label`; outside a terminal or with `--json`, it requires both flags and otherwise fails with `ORGANIZATION_REQUIRED` or `LABEL_REQUIRED`.
- 4f6cf18: `devboxes machine add` adds this computer as a Runner of an Organization. It asks for the Organization and the machine's name, which starts as the computer's name, registers the machine for its processor through `capacity.register`, and saves the Runner key in a file only the current user can read. In a terminal it then offers to start the Runner. Outside a terminal or with `--json`, `--organization` and `--name` are required. A computer whose saved key still works fails with `MACHINE_ALREADY_ADDED`; when the API refuses the saved key, for example after the machine was removed, the command adds the machine again and replaces the key. `devboxes runner listen` reads the saved key unless `--token-file` names another file, and says to run `devboxes machine add` first when there is no saved key.
- 7aa7d8e: `devboxes runner listen` runs on rootless Docker. Before it starts the first Task, it checks that a container of the Task's image reaches the Runner. When a Task container can't reach the Runner, the Runner stops with `DOCKER_ENGINE_UNSUPPORTED` and names the two Docker settings to turn on.

### Patch Changes

- f534e71: `devboxes machine add` offers only the Organizations you own, because only an owner can add a machine. The list needs at least one Organization your account owns, or the command fails with `ORGANIZATION_NOT_FOUND`. The help text of `devboxes connect` and `devboxes invoke` says when the CLI asks questions in a terminal.

## 0.6.0

### Minor Changes

- `devboxes runner listen` relays each Task's callbacks to the API with the Runner credential, so no token inside a Task container authenticates at the API. The relay listens where the executor reaches `host.docker.internal`, and its key and port persist in the state directory. `--daemon-api` is removed. Runners need Docker Desktop, OrbStack or a native Linux Docker Engine; any other engine, such as Colima or rootless Docker, is refused with `DOCKER_ENGINE_UNSUPPORTED`. The current API requires this version for Runner claims.

### Patch Changes

- `devboxes runner listen` sets `DO_NOT_TRACK=1` on macOS and Windows unless `DO_NOT_TRACK` is already set, so Bun sends no crash reports from a Runner by default.

## 0.5.0

### Minor Changes

- Connect a Provider Account with `devboxes connect`: without a provider ID it offers each provider's browser sign-in and API key, `devboxes connect <providerId>` signs in without prompts, and `--api-key` with `--account` replaces an account's key. A Claude subscription connects by signing in on Anthropic's page and pasting the code at a masked prompt.
- 02b6989: Remove `--vercel` from `devboxes signup` and `devboxes login`. Sign in with GitHub or with email and password.

### Patch Changes

- `devboxes runner listen` runs Claude subscription Runs with the Claude Code build the API assigns, and removes the task directory and executor of a Run that paused at its usage limit.
- Write command output once to a slow pipe. A reader that fell behind received the first 64 KiB twice and could not parse the JSON.

## 0.4.2

### Patch Changes

- fa2cb94: Connect with only `DEVBOXES_TOKEN` set: the CLI sends the delegation token to the `--api` origin, else `DEVBOXES_API_URL`, else `https://api.devboxes.ai`. An empty or malformed `DEVBOXES_TOKEN` fails with `INVALID_DEVBOXES_TOKEN`.

## 0.4.1

### Patch Changes

- Ship the native binary as an executable again. The 0.4.0 native packages stored `bin/devboxes.exe` without execute permission, so the CLI could not start.

## 0.4.0

### Minor Changes

- Discover and invoke the API's application commands with `devboxes commands`, `devboxes describe`, and `devboxes invoke`, and expose the same commands to agents through `devboxes mcp`. Create an account with `devboxes signup`, manage account security with `devboxes auth`, and run registered execution capacity with `devboxes runner listen`. This release removes `dispatch`, `continue`, `status`, `result`, `connect`, `doctor`, `listen`, `credentials`, and `telemetry`.
- a0405c6: Sign up or sign in with GitHub, Vercel, or email and password, complete two-factor sign-in at the prompt, and connect released binaries to https://api.devboxes.ai by default.

### Patch Changes

- 9b409d6: Print the warning that a command result carries, such as the warning for a delegation token without an expiry, on stderr; with `--json`, the warning stays in the result.

## 0.3.6

### Patch Changes

- Allow repository authentication helpers to execute in Docker task containers while keeping credential storage non-executable.

## 0.3.5

### Patch Changes

- Retry transient Windows sharing violations during installer replacement.

## 0.3.4

### Patch Changes

- Validate the Windows launcher with a native executable before publication.

## 0.3.3

### Patch Changes

- Use configured Provider Accounts for shared OpenCode connections. Replace an
  existing Windows installation with the verified download.

## 0.3.2

### Patch Changes

- Install and verify the pinned Docker Compose release before validating the public CLI release.

## 0.3.1

### Patch Changes

- Build the CLI release from a clean environment with the native tools required
  for every supported npm package and binary.

## 0.3.0

### Minor Changes

- 30295c4: Add opt-in CLI error telemetry with `devboxes telemetry enable` and `devboxes telemetry disable`.
- 3134a97: Replace the removed `dispatch --blueprint` option with `dispatch --blueprint-version` so each dispatch selects an exact Blueprint Version.
- a665094: Continue an existing Session with a fresh Run from the CLI or MCP, and load explicitly selected read-only config files without modifying them.
- 1b98bc0: Return the stored structured Run outcome from `status` and `result` instead of reconstructing final output and pull-request details from Session events.

## 0.2.4

### Patch Changes

- Install from npm without lifecycle scripts and keep workspace-only source out of the registry package.

## 0.2.3

### Patch Changes

- Keep the npm binary installer out of workspace source installs and scope native release builders to Devboxes dependencies.

## 0.2.2

### Patch Changes

- Make release validation reliable on cold machines.

## 0.2.1

### Patch Changes

- Install the native Devboxes command through npm and publish checksum-verified direct installers.

## 0.2.0

### Minor Changes

- 60517f5: Separate OpenCode Zen and OpenCode Go credentials and require the v2 runner protocol for dispatch.
- 3e8ca70: Unify terminal sign-in, task dispatch, and runner management in the `devboxes` CLI.

## 0.1.0

### Minor Changes

- 3ed71eb: Initial public release of the Devboxes CLI: `connect` signs a terminal in via
  browser approval (device authorization), `dispatch` starts a run from task
  text or a GitHub issue, `status`/`result` follow it to the final output and
  pull request, and `devboxes mcp` serves the same actions as MCP tools over
  stdio.
