# devboxes

## 0.9.0

### Minor Changes

- Update every CLI and Runner to this release. It resets Runner registrations and ends the Runs in progress. A Runner of an earlier release stops at its next poll with `RUNNER_TOKEN_REQUIRED` and claims no more work. To run work on a Runner computer again, update the CLI, remove the Task containers that the old Runner leaves behind, run `devboxes runner add`, and start `devboxes runner listen`. `devboxes runner add` replaces the key it saved before.

  The leftover containers keep running and can still hold the model account's key and the Organization's secrets. `docker ps --all --filter label=devboxes.task` lists them. Remove each one with `docker rm --force --volumes <container>`, and delete the folder of the same Task ID, the container's name without `devboxes-task-`, in the Runner's state directory, which `devboxes runner listen --help` shows.

- The API renamed the resources of 17 operations. `devboxes invoke`, `devboxes mcp` and scripts that call an old name fail, and so do `devboxes connect` and `devboxes machine add` of 0.8.0:
  - `capacity.register` is now `runners.add`. `capacity.list`, `capacity.configure` and `capacity.remove` are now `runners.list`, `runners.configure` and `runners.remove`.
  - `providers.list` is now `model-accounts.providers`. `providers.models`, `providers.select`, `providers.connect-start` and `providers.connect-complete` are now `model-accounts.models`, `model-accounts.select`, `model-accounts.connect-start` and `model-accounts.connect-complete`.
  - `connections.add`, `connections.list`, `connections.inspect`, `connections.usage`, `connections.update` and `connections.delete` are now `model-accounts.add`, `model-accounts.list`, `model-accounts.inspect`, `model-accounts.usage`, `model-accounts.update` and `model-accounts.delete`.
  - `images.configure` and `images.inspect` are now `workspace-images.configure` and `workspace-images.inspect`.
- `delegations.create` takes `resources`, a `read` or `write` level for each resource, in place of `operations`. A resource is the part of an operation ID before its dot. `read` grants the resource's reads, and `write` grants every operation of it, including operations that devboxes adds later. A resource whose level grants no operation fails with `RESOURCE_UNAVAILABLE`. `delegations.list` answers `resources` too. `chat.policy` and `chat.configure-policy` state a Chat policy's grant as `resources` in the same way, and `chat.configure-policy` refuses with `RESOURCE_UNAVAILABLE` where it refused with `CHAT_OPERATION_UNAVAILABLE`.
- `devboxes runner add` replaces `devboxes machine add`, and both Runner commands now sit under `devboxes runner`. The CLI calls the renamed operations `runners.add` and `model-accounts.*`, and its errors say `RUNNER_NOT_ADDED`, `RUNNER_ALREADY_ADDED` and, for a failed model account sign-in, `MODEL_ACCOUNT_SIGN_IN_FAILED` instead of `CONNECTION_FAILED`. `--json` prints the added Runner under `runner`.
- In a terminal without `--input`, `devboxes invoke` asks in one pass for every Blueprint input that the API reports as missing or of the wrong type, and for the issue the work is linked to when the API asks for one, then sends the request again. With `--input`, it prints the API's `BLUEPRINT_INPUT_MISSING` or `BLUEPRINT_INPUT_TYPE` refusal. Without `--input`, with `--json` or outside a terminal, it still fails with `INPUT_REQUIRED` before it calls the API.

### Patch Changes

- `devboxes login`, `devboxes signup` and `devboxes auth` hide only HttpOnly cookie values in the answers they print. A cookie that a web page may read, such as the one that records the last sign-in method, no longer turns matching text such as `email` into `[redacted]`.

## 0.8.0

### Minor Changes

- The CLI is built with Bun 1.4.4, the first Bun release that fixes CVE-2026-111497 (Node2Shell), an out-of-bounds write in its Brotli decoder that lets crafted Brotli data run code. Every earlier CLI release embeds an older Bun. Update every installed CLI and Runner to this release.
- An elevated write, such as adding a Credential or changing an Organization's members, needs a sign-in from the last 10 minutes. In a terminal, the CLI then runs `devboxes login` and sends the refused request once more after you sign in to the same account. Signing in to another account fails with `ACCOUNT_CHANGED`. With `--json`, outside a terminal or with `DEVBOXES_TOKEN`, the CLI prints the API's `SESSION_NOT_FRESH` refusal. `devboxes mcp` uses a new sign-in without a restart.
- When your account has two-factor authentication, `devboxes login` asks for an authenticator or backup code, or emails you a code. Outside a terminal, its message names the `devboxes auth` operations that send and verify the emailed code.
- `devboxes login --github` and `--google` print one line: the page to open, the code it shows, and that you approve the sign-in there.
- The CLI needs an API that states each command's roles. An older API's command list fails with `INVALID_DISCOVERY`: "This devboxes CLI needs a newer devboxes API."
- `devboxes connect` says model account where it said Provider Account, and refuses a provider that takes neither a sign-in nor an API key with `PROVIDER_NOT_CONNECTABLE` before it asks for anything.
- `devboxes connect` opens only an `http:` or `https:` sign-in URL in a browser. An answer with another URL fails with `INVALID_RESPONSE` before the CLI shows it.
- `devboxes runner listen` requires the state directory and its `relay.json` to be yours, with no access for group or others, and fails with `INVALID_RUNNER_STATE_DIRECTORY` otherwise. The token file must be yours too. On Windows, the file's access-control list decides and the CLI skips these checks.
- The Runner removes Task containers with their anonymous volumes. For a failed Task container it keeps, it prints the command that removes the container and its folder.
- A Task whose image pull fails ends at its start with the pull's error and the image's name.
- The CLI ignores the old `DEVBOX_*` connection variables instead of failing with `LEGACY_CONNECTION`.
- `devboxes auth /admin/revoke-user-session` no longer looks up the session's token, because the API no longer serves that operation.

### Patch Changes

- 47f2fd4: `devboxes machine add` offers the Organizations where your role may add a machine, as the roles the API's `capacity.register` contract names: today owners and admins. When you hold no such role anywhere, it fails with `ORGANIZATION_NOT_FOUND`.

## 0.7.1

### Patch Changes

- 0e3ec91: 0.7.0 was tagged but never published, so this release ships the 0.7.0 changes. The public source of the CLI now typechecks with `@clack/prompts` 1.8, the version a fresh install of that source resolves.

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
