# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities privately to **security@devboxes.ai**. Do not
open a public issue. Include the affected version from `devboxes --version`,
the observed impact, and reproduction steps. We will acknowledge the report
and coordinate a fix or mitigation before public disclosure.

## Scope and supported versions

This policy covers the latest published `devboxes` version: its account CLI,
MCP server, local Docker runner, runner protocol, and provider-connection
implementation. Reports about the hosted Devboxes platform are welcome at the
same address.

## Runner trust boundary

`devboxes runner listen` controls Docker on the Runner machine. Docker access can
amount to control of the host, so run it only on a trusted machine.

Tasks run organization-dispatched code in containers. An organization member
who can dispatch a task to a runner can cause that container to receive the
provider credential selected for the task. Treat runner membership, provider
credentials, mounted Opencode configuration, and the Docker host as one
security boundary. A dedicated runner host limits unrelated exposure.

The listener reconciles observed executors with the API. It removes a stopped
container and per-task state after confirmed success or cancellation. It retains
failed containers for inspection. A disconnected listener or expired lease does
not establish that a container stopped.

## Credential handling

- The account configuration is written atomically with owner-only mode `0600`.
- Store the Runner token from `capacity.register` in a regular, owner-only file
  (`0600`). Protect that file and the Runner state directory from other local users.
- Per-task callback tokens are passed in the container environment as
  `DEVBOX_BACKEND_TOKEN`. Docker access permits inspection of that environment.
- Native configuration and private daemon state use container memory-backed
  filesystems. Docker access still permits inspection of container files and
  credentials. These controls do not protect against the host operator.

The four-file npm package contains the launcher, manifest, README, and license;
the optional native packages contain the compiled commands. The public source
mirror exposes the CLI and runner implementation under MIT so it can be
audited. Public source does not make locally stored credentials, organization
data, or hosted secrets public.
