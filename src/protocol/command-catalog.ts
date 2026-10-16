import Type, { type Static } from "typebox";
import Value from "typebox/value";

import { describeErrors } from "../values/validation-errors";

/** The API's OpenAPI document, as `/api/openapi/json` serves it. */
export const commandDocumentSchema = Type.Object({
  openapi: Type.String(),
  paths: Type.Record(Type.String(), Type.Object({ post: Type.Optional(Type.Unknown()) })),
  components: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const operationSchema = Type.Object({
  operationId: Type.String({ minLength: 1 }),
  summary: Type.Optional(Type.String()),
  "x-devboxes": Type.Object({
    effect: Type.Union([Type.Literal("read"), Type.Literal("write")]),
    delegable: Type.Optional(Type.Literal(false)),
    elevated: Type.Optional(Type.Literal(true)),
    authority: Type.String({ minLength: 1 }),
  }),
  requestBody: Type.Optional(Type.Unknown()),
  responses: Type.Record(Type.String(), Type.Unknown()),
});

export type CatalogCommand = Static<typeof operationSchema> & { path: string; method: "POST" };

/**
 * The commands of the API's OpenAPI document: every POST under `/api/commands/<resource>/<verb>`,
 * whose operationId is `<resource>.<verb>` and unique, or the problem with the first that is not.
 */
export const catalogCommands = (
  document: Static<typeof commandDocumentSchema>,
): { commands: CatalogCommand[] } | { problem: string } => {
  const commands: CatalogCommand[] = [];
  const ids = new Set<string>();
  for (const [path, item] of Object.entries(document.paths)) {
    const route = /^\/api\/commands\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(path);
    if (!route || item.post === undefined) continue;
    const operation = item.post;
    if (!Value.Check(operationSchema, operation)) {
      return {
        problem: `A command route has an invalid operation contract: ${describeErrors(operationSchema, operation)}.`,
      };
    }
    if (operation.operationId !== `${route[1]}.${route[2]}`) {
      return {
        problem: `A command route has an invalid operation contract: /operationId must be ${route[1]}.${route[2]}.`,
      };
    }
    if (ids.has(operation.operationId)) return { problem: "Command operation IDs must be unique." };
    ids.add(operation.operationId);
    commands.push({ ...operation, path, method: "POST" });
  }
  return { commands };
};

/**
 * What a delegation token can hold of one resource: its read operations, all of them, and the
 * elevated ones among them, which move money, change access or credentials, or erase data.
 */
export type DelegationResource = { read: string[]; readAndWrite: string[]; elevated: string[] };

/**
 * The resources a member delegation can reach. A resource is the part of an operationId before the
 * dot. Write includes read, so `readAndWrite` holds every operation of the resource. Commands with
 * `delegable: false` refuse every delegation and are left out, and so is a resource left with none.
 */
export const delegationResources = (commands: readonly CatalogCommand[]) => {
  const resources = new Map<string, DelegationResource>();
  for (const { operationId, "x-devboxes": detail } of commands) {
    if (detail.delegable === false) continue;
    const [resource = operationId] = operationId.split(".");
    const entry = resources.get(resource) ?? { read: [], readAndWrite: [], elevated: [] };
    if (detail.effect === "read") entry.read.push(operationId);
    if (detail.elevated) entry.elevated.push(operationId);
    entry.readAndWrite.push(operationId);
    resources.set(resource, entry);
  }
  return resources;
};
