# devboxes

## 0.1.0

### Minor Changes

- 3ed71eb: Initial public release of the Devboxes CLI: `connect` signs a terminal in via
  browser approval (device authorization), `dispatch` starts a run from task
  text or a GitHub issue, `status`/`result` follow it to the final output and
  pull request, and `devboxes mcp` serves the same actions as MCP tools over
  stdio. Runs on Bun; install with `npm i -g devboxes`.
