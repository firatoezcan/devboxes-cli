# devboxes

The Devboxes CLI: connect a terminal to your Devboxes account, dispatch coding
tasks as runs, follow their sessions, and read the outcome (final agent output
plus pull request link). `devboxes mcp` serves the same actions as MCP tools
over stdio for coding agents.

## Install

Requires [Bun](https://bun.sh) >= 1.3 on your `PATH` — the CLI runs on the Bun
runtime.

```sh
npm i -g devboxes   # or: bun i -g devboxes
```

## Quickstart

```sh
# Sign this terminal in via browser approval (device authorization flow).
devboxes connect   # hosted cloud by default; self-hosted: --api https://<your-host>/api

# Dispatch a task — free text with a target repository, or a GitHub issue.
devboxes dispatch "Fix the retry backoff in the queue worker" --repo owner/name
devboxes dispatch https://github.com/owner/name/issues/123
devboxes dispatch owner/name#123

# Follow the run and fetch the outcome.
devboxes status <agentSessionId> [--json]
devboxes result <agentSessionId> [--json]

# Serve dispatch/status/result as MCP tools over stdio for coding agents.
devboxes mcp
```

`dispatch` picks the project from `--project`, `--repo`, or the issue
reference; without any of those it infers the project from the working
directory's git `origin` remote — exact match on the normalized remote URL
against the organization's project repositories, printed as
`Project: owner/name (inferred from git remote …)` and always overridable
with the explicit flags. It also accepts `--model`, `--branch`, `--title`,
`--blueprint`, and `--json`; run `devboxes dispatch --help` for details.

`connect` stores the resulting session token owner-only (mode 0600) at
`~/.config/devboxes/cli.json` (XDG/platform equivalents). Dispatch, status,
and result call the same organization API routes the dashboard uses,
authorized by that token. Authenticated commands roll the session's expiry
forward server-side (Better Auth refresh-on-use, at most once per day), so a
regularly used CLI stays connected; only after a full session lifetime of
inactivity does a 401 mean "run `devboxes connect` again".

## Source, issues, and releases

Development happens in a private monorepo. This public repository
([firatoezcan/devboxes-cli](https://github.com/firatoezcan/devboxes-cli)) is a
read-only mirror of the released sources: every npm release `X.Y.Z` matches
the tag `vX.Y.Z` here, so the published tarball is diffable against public
source. Bug reports and feature requests are welcome on the issue tracker;
pull requests are ported into the monorepo rather than merged here.

## Security

See [SECURITY.md](./SECURITY.md) — report vulnerabilities privately to
hello@devboxes.ai.

## License

[MIT](./LICENSE)
