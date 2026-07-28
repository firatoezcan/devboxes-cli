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

`devboxes listen` controls the configured Docker daemon. Access to a Docker
socket can amount to control of the host, so run it only on a trusted machine
and never expose an unauthenticated Docker TCP endpoint. The CLI accepts local
Unix sockets and Windows named pipes and rejects remote TCP sockets.

Tasks run organization-dispatched code in containers. An organization member
who can dispatch a task to a runner can cause that container to receive the
provider credential selected for the task. Treat runner membership, provider
credentials, mounted Opencode configuration, and the Docker host as one
security boundary. A dedicated runner host limits unrelated exposure.

When a task ends, stops, or is reassigned, its container and per-task secrets
are removed. Startup reconciliation removes terminal or orphaned leftovers and
re-adopts work that is still valid. This cleanup limits persistence; it is not
a sandbox against an operator who already controls the host or Docker daemon.

## Credential handling

- The shared config and encrypted device store are written atomically with
  owner-only mode `0600`. Per-task secret files also use `0600`, but are
  written directly because replacing a bind-mounted inode would leave a
  container reading stale data.
- The device store is age-encrypted. Devboxes holds its passphrase and returns
  it to the registered runner in memory. Deleting the runner prevents future
  retrieval; it does not erase plaintext already exposed to a locally
  controlled process.
- The host credential broker binds a random port on all interfaces because
  native-Linux containers reach the host through the Docker bridge rather than
  loopback. A random per-task bearer token gates every request and is compared
  in constant time. Other reachable hosts cannot obtain a credential without
  that token, but normal host and network hardening still applies.
- Provider credentials are served at container boot and written to a
  memory-backed filesystem inside the container. They are not placed in
  container environment variables, images, or durable layers.
- `devboxes credentials sync` copies selected local credentials into the
  organization's encrypted store. That intentionally expands availability to
  cloud and other runner machines; sync only credentials suitable for that
  organization-wide trust boundary.

The public npm package and source mirror expose these implementations under
MIT so they can be audited. Public source does not make locally stored
credentials, organization data, or hosted secrets public.
