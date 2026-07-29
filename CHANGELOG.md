# devboxes

## 0.2.3

### Patch Changes

- Keep the npm binary installer out of workspace source installs and scope native release builders to Devboxes dependencies.

## 0.2.2

### Patch Changes

- Make release validation reliable on cold machines.

## 0.2.1

### Patch Changes

- Install a self-contained native Devboxes executable through npm without requiring Bun at runtime, and publish checksum-verified native installers for machines without npm.

## 0.2.0

### Minor Changes

- 60517f5: Separate OpenCode Zen and OpenCode Go credentials and require the v2 runner protocol for dispatch. Existing ambiguous OpenCode credentials must be reconnected, v2 runners must be staged before the v2-only server cutover, and the provider-identity cutover is forward-only after exact Zen credentials are connected.
- 3e8ca70: Unify terminal sign-in, task dispatch, and runner management in the `devboxes` CLI.

  Existing invite-cohort runners must rename `listener.json` to `config.json`
  before starting 0.2.0, then run `devboxes login`. The platform config
  directory is `$XDG_CONFIG_HOME/devboxes` (or `~/.config/devboxes`) on Linux,
  `~/Library/Application Support/devboxes` on macOS, and
  `%APPDATA%\devboxes` on Windows. For the Linux default:

  ```sh
  mv ~/.config/devboxes/listener.json ~/.config/devboxes/config.json
  devboxes login
  ```

  Renaming the file preserves the registered machine identity and credential
  references. The CLI no longer reads `listener.json`.

## 0.1.0

### Minor Changes

- 3ed71eb: Initial public release of the Devboxes CLI: `connect` signs a terminal in via
  browser approval (device authorization), `dispatch` starts a run from task
  text or a GitHub issue, `status`/`result` follow it to the final output and
  pull request, and `devboxes mcp` serves the same actions as MCP tools over
  stdio. Runs on Bun; install with `npm i -g devboxes`.
