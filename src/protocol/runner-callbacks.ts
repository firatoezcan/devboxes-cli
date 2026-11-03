import Type from "typebox";

import { opencodeDaemonPlatforms } from "./daemon-artifact";
import { machineSizes } from "./project";
import { runStatuses } from "./run-statuses";
import { ClaudeCodeArtifactSchema } from "./task-runtime";

/*
 * What each route under /internal/execution/runners answers the Runner that `devboxes runner`
 * runs. Each schema is its route's `response`, which the API validates, and what the CLI parses,
 * so neither side changes an answer alone. A `status` is the status of the Task's Run, which stays
 * queued after the claim until the agent starts.
 */

const AssignedTaskSchema = Type.Object({
  id: Type.String(),
  executorId: Type.Union([Type.String(), Type.Null()]),
  containerId: Type.Union([Type.String(), Type.Null()]),
  status: Type.Enum(runStatuses),
});

const ExecutorSchema = Type.Object({
  sha256: Type.String(),
  version: Type.String(),
  url: Type.String(),
});

/**
 * `/claim`: the Task this Runner starts next, or none, and the current executor for the Runner's
 * platform, which the Runner downloads before a Task needs it, or null when the API could not read
 * the release channel.
 */
export const RunnerClaimSchema = Type.Object({
  task: Type.Union([
    Type.Object({
      ...AssignedTaskSchema.properties,
      image: Type.String(),
      platform: Type.Enum(opencodeDaemonPlatforms),
      machineSize: Type.Enum(machineSizes),
      daemon: Type.Object({
        ...ExecutorSchema.properties,
        sha256ByArchitecture: Type.Optional(
          Type.Object({ amd64: Type.Optional(Type.String()), arm64: Type.Optional(Type.String()) }),
        ),
      }),
      claudeCode: Type.Union([ClaudeCodeArtifactSchema, Type.Null()]),
      /**
       * The home paths the Runner keeps in Docker volumes on its machine, shared by the Tasks of
       * the Organization's Projects there, in place of the tool cache archives of managed Tasks.
       */
      toolCache: Type.Object({
        organizationId: Type.String({ minLength: 1 }),
        paths: Type.Array(Type.String({ minLength: 1 })),
      }),
      traceparent: Type.String({ minLength: 1 }),
    }),
    Type.Null(),
  ]),
  executor: Type.Union([ExecutorSchema, Type.Null()]),
});

/**
 * `/claim`'s body: the CPUs and memory devboxes may use on the Runner's machine, the lower of what
 * its Docker engine reports and the cap its owner set, and the platform that engine runs, by
 * `dockerArchitecturePlatforms`.
 */
export const RunnerMachineSchema = Type.Object({
  cpus: Type.Number({ exclusiveMinimum: 0 }),
  memoryBytes: Type.Integer({ minimum: 1 }),
  platform: Type.Enum(opencodeDaemonPlatforms),
});

/** `/assignments`: the Tasks this Runner holds an executor for, or must stop one of. */
export const RunnerAssignmentsSchema = Type.Object({ tasks: Type.Array(AssignedTaskSchema) });

/** `/reconcile`: the Run's status once the Runner's observation is recorded. */
export const RunnerReconcileSchema = Type.Object({ status: Type.Enum(runStatuses) });

/**
 * `/release`: whether the calling listener let go of the Runner, and otherwise until when it holds
 * the Runner, because a Task still has an executor on its machine.
 */
export const RunnerReleaseSchema = Type.Union([
  Type.Object({ released: Type.Literal(true) }),
  Type.Object({
    released: Type.Literal(false),
    heldUntil: Type.String({ format: "date-time" }),
  }),
]);

/** `/identify`: the Runner a Runner credential belongs to. */
export const RunnerIdentitySchema = Type.Object({ id: Type.String() });

/** Each route's answer by its name under /internal/execution/runners. */
export const runnerAnswers = {
  claim: RunnerClaimSchema,
  assignments: RunnerAssignmentsSchema,
  reconcile: RunnerReconcileSchema,
  release: RunnerReleaseSchema,
  identify: RunnerIdentitySchema,
};

/**
 * The header in which `devboxes runner listen` names itself on `/claim`, `/assignments`,
 * `/reconcile` and `/release`: a one-way digest, under its own label, of its Docker engine's ID and
 * its relay key, so it is the same across restarts on one engine with one state directory and
 * reveals nothing of the key. One listener holds a Runner at a time (DEC-one-listener-per-runner).
 */
export const runnerListenerHeader = "devboxes-listener";
