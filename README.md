# Devboxes CLI

Sign in, dispatch coding tasks, follow sessions, and run a local Devboxes runner.

## Install

```sh
pnpm add --global devboxes
```

### macOS

```sh
curl -L \
  https://devboxes.ai/install \
  -o devboxes-install

echo "35f4c98f35cbb7b1e1773ea523acccf0e4c5472d297195e0fe01dd965910ba32  devboxes-install" \
  | shasum -a 256 --check

sh devboxes-install
```

### Linux

```sh
curl -L \
  https://devboxes.ai/install \
  -o devboxes-install

echo "35f4c98f35cbb7b1e1773ea523acccf0e4c5472d297195e0fe01dd965910ba32  devboxes-install" \
  | sha256sum --check

sh devboxes-install
```

[Windows and other downloads](https://github.com/firatoezcan/devboxes-cli/releases/latest)

## Use

```sh
devboxes login
devboxes connect
devboxes credentials setup
devboxes doctor
devboxes listen
```

Dispatch and follow work:

```sh
devboxes dispatch "Fix the retry backoff" --repo owner/name
devboxes status <agentSessionId>
devboxes result <agentSessionId>
devboxes mcp
```

## Error telemetry

The CLI sends no error telemetry unless you enable it with a self-hosted Sentry
DSN and an environment name:

```sh
devboxes telemetry enable \
  --dsn https://PUBLIC_KEY@sentry.devboxes.ai/PROJECT_ID \
  --environment production
```

Disable it through the same CLI setting:

```sh
devboxes telemetry disable
```

Enabled events contain a fixed CLI error marker, the CLI runtime, version, and
the environment name you supplied. They exclude command arguments, credentials,
environment-variable values, prompts, transcripts, cookies, authorization
headers, OAuth codes, task tokens, request data, breadcrumbs, and user context.
The organization running the self-hosted Sentry instance controls storage and
retention.

Telemetry initialization or delivery failures append a local record containing
only the timestamp, CLI runtime, version, and failure class to
`<config path>.telemetry.log`. They do not change command output or exit status.
An initialization failure or command-error report gets one second in total
before the CLI continues.

See the [Devboxes documentation](https://docs.devboxes.ai) for the user guide.
Report bugs on the [issue tracker](https://github.com/firatoezcan/devboxes-cli/issues)
and security concerns through the
[security policy](https://github.com/firatoezcan/devboxes-cli/blob/main/SECURITY.md).
