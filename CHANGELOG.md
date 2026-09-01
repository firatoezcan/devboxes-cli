# devboxes

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
