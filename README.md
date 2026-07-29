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

See the [Devboxes documentation](https://docs.devboxes.ai) for the user guide.
Report bugs on the [issue tracker](https://github.com/firatoezcan/devboxes-cli/issues)
and security concerns through the
[security policy](https://github.com/firatoezcan/devboxes-cli/blob/main/SECURITY.md).
