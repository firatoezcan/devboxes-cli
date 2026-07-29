import Type, { type Static } from "typebox";

// The server-authored launch spec: everything about a task container that is
// a PRODUCT decision — env composition, working directory, entrypoint,
// metadata labels, memory-backed paths, provider-auth routing — arrives from
// the claim response as data, so the launch contract can evolve server-side
// without re-shipping runner binaries. Runtimes (the CLI's Docker
// driver and the dashboard's Kubernetes driver) stay thin executors that add
// only machine-local mechanics: sockets, bind sources, host paths, tmpfs
// option strings, URL rewrites.
//
// Versioning: the claim REQUEST advertises the protocols a binary can
// execute; a server that cannot serve any of them answers
// listener_upgrade_required, which shipped binaries stop on cleanly. Within
// one protocol tag the spec is additive-only (`additionalProperties: true`
// keeps unknown future fields from failing older binaries); anything a binary
// would interpret differently is a new tag.
export const opencodeLaunchProtocol = "devboxes-launch-v1";
export const opencodeExactProviderIdsLaunchProtocol = "devboxes-launch-v2";

// Env keys the RUNTIME owns because only it knows their values — the
// runner's broker port and host.docker.internal rewrites, the Kubernetes
// driver's cluster URLs and secret mount presence. Frozen contract: the
// server never sends these keys, and each runtime overlays its own values
// over the served env.
export const clientOwnedLaunchEnvKeys = [
  "DEVBOX_BACKEND_BASE_URL",
  "DEVBOX_OPENCODE_PROVIDER_AUTH_URL",
  "DEVBOX_OPENCODE_CONFIG_JSON_FILE",
] as const;

// Security line: the spec contains no mounts, no host paths, no bind
// sources — a server must never be able to tell a machine what to mount.
// Mount targets are frozen constants in task-runtime.ts; a new secret mount
// is by definition a launch-protocol bump.
export const OpencodeLaunchSpecSchema = Type.Object(
  {
    launchProtocol: Type.Literal(opencodeExactProviderIdsLaunchProtocol),
    workingDir: Type.String({ minLength: 1 }),
    entrypoint: Type.String({ minLength: 1 }),
    // The full server-composed env (opencode flags, XDG homes, task ids, the
    // daemon artifact pin) minus clientOwnedLaunchEnvKeys.
    env: Type.Record(Type.String({ minLength: 1 }), Type.String()),
    // Container paths that must live on memory-backed storage (the daemon
    // writes decrypted provider keys under them); each runtime supplies its
    // own memory-backing mechanics — docker tmpfs options, Kubernetes
    // Memory-medium emptyDir.
    memoryBackedPaths: Type.Array(Type.String({ minLength: 1 })),
    // Additive metadata. The reconciliation labels a runtime reads back on
    // restart (workload/task-id/organization-id) stay runtime-composed and
    // win on conflict — a served rename must never strand leftovers.
    labels: Type.Record(Type.String({ minLength: 1 }), Type.String()),
    // Which provider-auth source serves this task: the machine's local
    // credential broker or the dashboard's internal route. The server decides
    // (it already computes the availability union at claim); the runtime
    // still owns the URL value itself.
    providerAuthSource: Type.Union([Type.Literal("organization"), Type.Literal("local-broker")]),
  },
  { additionalProperties: true },
);

export type OpencodeLaunchSpec = Static<typeof OpencodeLaunchSpecSchema>;
