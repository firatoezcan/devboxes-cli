# @firops/devboxes-cli

The user-facing `devboxes` CLI: connect a terminal to a Devboxes account,
dispatch tasks as runs, follow their sessions, and read the outcome (final
agent output plus pull request link). `devboxes mcp` serves the same three
actions as MCP tools over stdio for coding agents.

```sh
devboxes connect --api https://<devboxes-host>/api
devboxes dispatch "Fix the retry backoff in the queue worker" --repo owner/name
devboxes dispatch https://github.com/owner/name/issues/123
devboxes status <agentSessionId> [--json]
devboxes result <agentSessionId> [--json]
devboxes mcp
```

`connect` runs the Better Auth device-authorization flow (client id
`devboxes-cli`, approved on the dashboard's `/device` page) and stores the
resulting session token 0600 at `~/.config/devboxes/cli.json` (XDG/platform
equivalents). Dispatch, status, and result call the same organization API
routes the dashboard uses, authorized by that token as an `Authorization:
Bearer` header. Sessions expire server-side; a 401 means "run `devboxes
connect` again".

Development:

```sh
pnpm vp run @firops/devboxes-cli#devboxes -- --help   # run from source
pnpm vp run @firops/devboxes-cli#test                 # Bun integration tests (embedded PGlite + chDB)
pnpm vp run @firops/devboxes-cli#tslint               # typecheck
```

The agent-facing usage guide lives at `.agents/skills/devboxes-dispatch/SKILL.md`.
