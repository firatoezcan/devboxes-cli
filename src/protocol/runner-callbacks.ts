import Type from "typebox";

import { opencodeDaemonPlatforms } from "./daemon-artifact";
import { runStatuses } from "./run-statuses";
import { ClaudeCodeArtifactSchema } from "./task-runtime";

/*
 * What each route under /internal/execution/runners answers the Runner that `devboxes runner`
 * runs. Each schema is its route's `response`, which the API validates, and what the CLI parses,
 * so neither side changes an answer alone.
 */

const AssignedTaskSchema = Type.Object({
  id: Type.String(),
  executorId: Type.Union([Type.String(), Type.Null()]),
  containerId: Type.Union([Type.String(), Type.Null()]),
  status: Type.Enum(runStatuses),
});

/** `/claim`: the Task this Runner starts next, or none. */
export const RunnerClaimSchema = Type.Object({
  task: Type.Union([
    Type.Object({
      ...AssignedTaskSchema.properties,
      image: Type.String(),
      platform: Type.Enum(opencodeDaemonPlatforms),
      daemon: Type.Object({
        sha256: Type.String(),
        version: Type.String(),
        url: Type.String(),
        sha256ByArchitecture: Type.Optional(
          Type.Object({ amd64: Type.Optional(Type.String()), arm64: Type.Optional(Type.String()) }),
        ),
      }),
      claudeCode: Type.Union([ClaudeCodeArtifactSchema, Type.Null()]),
      traceparent: Type.String({ minLength: 1 }),
    }),
    Type.Null(),
  ]),
});

/** `/assignments`: the Tasks this Runner holds an executor for, or must stop one of. */
export const RunnerAssignmentsSchema = Type.Object({ tasks: Type.Array(AssignedTaskSchema) });

/** `/reconcile`: the Task's status once the Runner's observation is recorded. */
export const RunnerReconcileSchema = Type.Object({ status: Type.Enum(runStatuses) });

/** Each route's answer by its name under /internal/execution/runners. */
export const runnerAnswers = {
  claim: RunnerClaimSchema,
  assignments: RunnerAssignmentsSchema,
  reconcile: RunnerReconcileSchema,
};
