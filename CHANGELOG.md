# devboxes

## 0.2.5

### Patch Changes

- Install Devboxes from one final npm and GitHub release with verified packages and binaries.

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
  text or a GitHub issue, `status`/`result` follow it to its structured Run
  outcome, and `devboxes mcp` serves the same actions as MCP tools over stdio.
