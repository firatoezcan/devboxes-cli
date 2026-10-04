# @devboxes/cli-linux-x64

This package contains the compiled Devboxes CLI for `linux/x64`. The
`devboxes` launcher selects it from the platform-specific optional dependencies.
It contains no separate application implementation or test framework.

The package declares `os: linux` and `cpu: x64` and ships
`bin/devboxes.exe`. The filename is shared across distribution packages; it does
not imply a Windows executable format. The compiler target determines the format.
The binary embeds Bun and does not require a Node runtime.

## Verify the distribution

From the Dashboard repository root, run the inherited artifact and release
contracts rather than an empty package-local suite:

```sh
pnpm vp run validate:cli-binary-release-test
pnpm vp run validate:cli-release-test
```

These owners check release assembly, platform metadata, packaging, launcher
selection, and installation boundaries. Cross-platform inspection does not prove
that a binary executes on the target operating system.

To compile this target without publishing:

```sh
pnpm vp run devboxes#build --platform linux/amd64
```

The build owner replaces the CLI's `dist/` output. To build and execute the
current host artifact, run `pnpm vp run devboxes#build:smoke`. Count that native
execution as proof for this package only when the host matches `linux/x64`.

The [CLI README](../../README.md) owns authentication, configuration, commands,
and Runner operation. Distribution tests do not require Production credentials
and do not authorize publishing a release.
