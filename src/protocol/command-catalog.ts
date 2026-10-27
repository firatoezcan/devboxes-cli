import Type, { type Static } from "typebox";
import Value from "typebox/value";

import { describeErrors } from "../values/validation-errors";

/** The API's OpenAPI document, as `/api/openapi/json` serves it. */
export const commandDocumentSchema = Type.Object({
  openapi: Type.String(),
  paths: Type.Record(Type.String(), Type.Object({ post: Type.Optional(Type.Unknown()) })),
  components: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

/**
 * The roles a member of an Organization holds. A contract that names them all lets every member
 * call the command.
 */
export const organizationRoles = ["owner", "admin", "member", "reviewer", "viewer"] as const;

/** The roles that add or replace a credential, and finish a setup that stores one. */
export const credentialRoles: readonly (typeof organizationRoles)[number][] = ["owner", "admin"];

/** The roles that tell devboxes which roadmap features their Organization wants. */
export const roadmapInterestRoles: readonly (typeof organizationRoles)[number][] = [
  "owner",
  "admin",
  "member",
];

const sharedFields = {
  delegable: Type.Optional(Type.Literal(false)),
  authority: Type.String({ minLength: 1 }),
  shipped: Type.Optional(
    Type.Object({
      on: Type.String({ format: "date" }),
      note: Type.String({ pattern: "^[^\\n]+$" }),
    }),
  ),
};

const contractFields = {
  roles: Type.Immutable(Type.Array(Type.Enum(organizationRoles), { uniqueItems: true })),
  lifecycle: Type.Optional(Type.Literal("any")),
  ...sharedFields,
};

/**
 * Why a write is elevated: it spends money; changes who can do or see what; hands over or replaces
 * a credential; destroys data that can't be restored; or acts outside devboxes in the
 * Organization's name. A write that does none of these, or that can be undone, is `false`. An
 * account session makes an elevated write only within ten minutes of signing in, and is otherwise
 * refused with SESSION_NOT_FRESH: sign in again in the browser or with `devboxes login`. A member
 * delegation makes one only if a session signed in within those ten minutes created it, and is
 * otherwise refused with DELEGATION_NOT_FRESH: the member makes the change after signing in, or
 * creates the delegation again. A Run's delegation makes the elevated writes a Blueprint may grant,
 * `publication.commit` and `repositories.github-write`, whatever the sign-in that started the Run.
 * A Chat turn's elevated write runs once a member with one of its `approverRoles` approves it
 * (DEC-chat-elevated-writes-need-approval).
 */
const elevationSchema = Type.Union([
  Type.Literal(false),
  Type.Literal("money"),
  Type.Literal("access"),
  Type.Literal("credential"),
  Type.Literal("unrestorable"),
  Type.Literal("external"),
]);

/**
 * A command's `x-devboxes`: whether it only reads or also writes; for a write, the class that makes
 * it `elevated`, which laws/LAWS.bend states for each class; the Organization roles that may call
 * it, none for a command that takes no Organization; `lifecycle: "any"` when it also runs on an
 * Organization that is suspended, archived or being deleted; `delegable: false` when only a
 * person's session may call it, never a member delegation; who may call it, in words; and, once it
 * is usable from Chat, `shipped`: the day and a one-line note on what it lets devboxes do. A Chat
 * turn calls a command under the Organization's Chat policy, and the roles bind the people the turn
 * answers only where the route names a `chatRequesterAction`. A read is never elevated. A write
 * states `elevated: false` too, so dropping the flag can't pass unseen; the document the API serves
 * leaves it out, as `servedDocument` says. An elevated write that Chat holds for approval names
 * the `approverRoles` whose members approve it, which law:chat-held-writes-name-approvers requires
 * of exactly those writes.
 */
export const commandContractSchema = Type.Union([
  Type.Object({ effect: Type.Literal("read"), ...contractFields }, { additionalProperties: false }),
  Type.Object(
    {
      effect: Type.Literal("write"),
      elevated: elevationSchema,
      approverRoles: Type.Optional(
        Type.Immutable(
          Type.Array(Type.Enum(organizationRoles), { uniqueItems: true, minItems: 1 }),
        ),
      ),
      ...contractFields,
    },
    { additionalProperties: false },
  ),
]);

export type CommandContract = Static<typeof commandContractSchema>;

/**
 * The `x-devboxes` a client reads from the document an API serves, which may be newer than the
 * client: the contract's fields, any field a later API adds, and on an elevated write
 * `elevated: true`, which every released client reads.
 */
const servedFields = { roles: Type.Array(Type.String()), ...sharedFields };
const servedContractSchema = Type.Union([
  Type.Object({ effect: Type.Literal("read"), ...servedFields }),
  Type.Object({
    effect: Type.Literal("write"),
    elevated: Type.Optional(Type.Literal(true)),
    ...servedFields,
  }),
]);

const operationSchema = Type.Object({
  operationId: Type.String({ minLength: 1 }),
  summary: Type.Optional(Type.String()),
  "x-devboxes": servedContractSchema,
  requestBody: Type.Optional(Type.Unknown()),
  responses: Type.Record(Type.String(), Type.Unknown()),
});

export type CatalogCommand = Static<typeof operationSchema> & { path: string; method: "POST" };

/**
 * The document as the API serves it, in the shape every released client reads: an elevated write's
 * contract says `elevated: true` and names its class in `elevation`, which those clients ignore,
 * and any other write leaves both out. A document it served already comes back as it is.
 */
export const servedDocument = (document: Static<typeof commandDocumentSchema>) => ({
  ...document,
  paths: Object.fromEntries(
    Object.entries(document.paths).map(([path, item]) => {
      const operation = item.post as { "x-devboxes"?: unknown } | undefined;
      const contract = operation?.["x-devboxes"];
      if (!Value.Check(commandContractSchema, contract) || contract.effect === "read")
        return [path, item];
      const { elevated, ...served } = contract;
      const shown =
        elevated === false ? served : { ...served, elevated: true, elevation: elevated };
      return [path, { ...item, post: { ...operation, "x-devboxes": shown } }];
    }),
  ),
});

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
 * elevated ones among them.
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
    if (detail.effect === "write" && detail.elevated) entry.elevated.push(operationId);
    entry.readAndWrite.push(operationId);
    resources.set(resource, entry);
  }
  return resources;
};
