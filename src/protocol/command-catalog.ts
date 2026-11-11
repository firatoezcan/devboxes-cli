import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";

import type { JsonValue } from "./json";
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

const sharedFields = {
  delegable: Type.Optional(Type.Literal(false)),
  chat: Type.Optional(Type.Union([Type.Literal("policy"), Type.Literal("always")])),
  authority: Type.String({ minLength: 1 }),
  shipped: Type.Optional(
    Type.Object({
      on: Type.String({ format: "date" }),
      note: Type.String({ pattern: "^[^\\n]+$" }),
    }),
  ),
};

const contractFields = {
  does: Type.String({ pattern: "^[a-z][^\\n]*[^.\\n]$" }),
  roles: Type.Immutable(Type.Array(Type.Enum(organizationRoles), { uniqueItems: true })),
  lifecycle: Type.Optional(Type.Literal("any")),
  crossProject: Type.Optional(Type.Literal("referable")),
  ...sharedFields,
};

/**
 * What follows a person's approval of a Chat turn's held write, as the description of every held
 * command, the CLI's command guide and the ELEVATION_REQUIRED refusal tell Chat's model
 * (DEC-approval-continues-the-request).
 */
export const approvedHeldWrite =
  "Once it's approved, you go on with the request in this thread, in a new turn that makes the same call, so don't call it again in this turn.";

/**
 * Why a write is elevated: it spends money; changes who can do or see what; hands over or replaces
 * a credential; destroys data that can't be restored; or acts outside devboxes in the
 * Organization's name. A write that does none of these, or that can be undone, is `false`. An
 * account session makes an `access` or `credential` write only within 5 minutes of signing in, and
 * any other elevated write within an hour (DEC-recent-sign-in-five-or-sixty-minutes); it is
 * otherwise refused with SESSION_NOT_FRESH: sign in again in the browser or with `devboxes login`. A
 * member delegation makes one only if a session signed in within that window created it, and is
 * otherwise refused with DELEGATION_NOT_FRESH: the member makes the change after signing in, or
 * creates the delegation again. A Run's delegation makes the elevated writes a Blueprint may grant,
 * `runElevatedOperations`, whatever the sign-in that started the Run. A Chat turn's elevated write
 * runs once a member with one of its `approverRoles` approves it
 * (DEC-approval-continues-the-request).
 */
const elevationSchema = Type.Union([
  Type.Literal(false),
  Type.Literal("money"),
  Type.Literal("access"),
  Type.Literal("credential"),
  Type.Literal("unrestorable"),
  Type.Literal("external"),
]);

export type Elevation = Static<typeof elevationSchema>;

/**
 * A command's contract: `does`, what the command lets devboxes do, as an infinitive phrase that
 * completes "lets devboxes …" and "asked devboxes to …", without a final period, which the
 * document serves capitalized as the command's `summary` and every reader shows a person in place
 * of the operationId; whether it only reads or also writes, which is the level a grant of its
 * resource needs (`grants`); for a write, the class that makes
 * it `elevated`, which laws/LAWS.bend states for each class; the Organization roles that may call
 * it, none for a command that takes no Organization; `lifecycle: "any"` when it also runs on an
 * Organization that is archived or being deleted; `crossProject: "referable"` when a Chat
 * delegation may also name a Project its conversation doesn't route, if that Project's issues are
 * referable, the conversation is a chat platform's Channel or the web app's Chat, and every person
 * its turn answers is linked to a member who holds one of the contract's roles, which
 * law:only-issue-reads-cross-projects allows only issues.read (DEC-referable-project-issues); `delegable: false` when only a
 * person's session may call it, never a member delegation; `chat` when a Chat delegation may hold
 * it: `policy` when the Chat policy's resources grant it, and `always` when every Chat turn may
 * call it whatever its policy lists, which only the listings of Projects and work setups, reading a
 * tracker conversation's own issue, and opening the turn's own conversation log are
 * (DEC-approval-continues-the-request); without it, the
 * command refuses a Chat token; who may call it, in words; and, once it is usable from Chat,
 * `shipped`: the day and a one-line note on what it lets devboxes do. A Chat turn calls a command
 * under the Organization's Chat policy, and the roles bind the people the turn
 * answers only where the route names a `chatRequester` action. A read is never elevated. A write
 * states `elevated: false` too, so dropping the flag can't pass unseen. An elevated write that
 * Chat holds for approval names the `approverRoles` whose members approve it, which
 * law:chat-held-writes-name-approvers requires of exactly those writes; while the write is
 * elevated, a Chat turn calls it only for a person linked to a member with one of them.
 * `elevatedWhen: "sensitive"` makes a write elevated by its class only while what its input names
 * is marked sensitive, which law:only-integration-calls-elevated-when-sensitive allows only
 * integrations.call, and whose route must then declare `sensitiveConnection`. Such a write names
 * `chatRequesterRoles` too, which law:chat-requesters-only-where-elevation-is-conditional requires
 * of exactly those writes: while it isn't elevated, a Chat turn calls it only for a person linked
 * to a member with one of them.
 */
export const commandContractSchema = Type.Union([
  Type.Object({ effect: Type.Literal("read"), ...contractFields }, { additionalProperties: false }),
  Type.Object(
    {
      effect: Type.Literal("write"),
      elevated: elevationSchema,
      elevatedWhen: Type.Optional(Type.Literal("sensitive")),
      approverRoles: Type.Optional(
        Type.Immutable(
          Type.Array(Type.Enum(organizationRoles), { uniqueItems: true, minItems: 1 }),
        ),
      ),
      chatRequesterRoles: Type.Optional(
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
 * Each `x-devboxes` of the served document, which the API serves without `does`. The dashboard,
 * which ships with the API, reads it whole, and the laws prove that every served contract has it.
 */
const servedFields = { roles: Type.Array(Type.String()), ...sharedFields };
export const servedContractSchema = Type.Union([
  Type.Object({ effect: Type.Literal("read"), ...servedFields }),
  Type.Object({
    effect: Type.Literal("write"),
    elevated: elevationSchema,
    elevatedWhen: Type.Optional(Type.Literal("sensitive")),
    ...servedFields,
  }),
]);

/**
 * The class that makes a call of `contract` elevated, or false when it isn't: a read's is false,
 * and an `elevatedWhen: "sensitive"` write's is its class only while what the call names is
 * `sensitive`.
 */
export const elevationOf = (contract: CommandContract, sensitive: boolean): Elevation =>
  contract.effect === "write" && (contract.elevatedWhen !== "sensitive" || sensitive)
    ? contract.elevated
    : false;

/**
 * What every client reads of a served command: its operationId, its summary and its `effect` as
 * text. An installed CLI shows the rest of the contract as the API serves it and reads no more of
 * it than the command it runs needs, so a contract change it doesn't use breaks nothing
 * (DEC-clients-fail-only-on-what-they-use).
 */
const operationSchema = Type.Object({
  operationId: Type.String({ minLength: 1 }),
  summary: Type.String({ minLength: 1 }),
  "x-devboxes": Type.Object({ effect: Type.String() }),
  requestBody: Type.Optional(Type.Unknown()),
  responses: Type.Optional(Type.Unknown()),
});

export type CatalogCommand = Static<typeof operationSchema> & { path: string; method: "POST" };

/** The body of every command failure, which the document's components state. */
const failureComponents = Type.Object({
  schemas: Type.Object({
    CommandError: Type.Object({
      description: Type.String(),
      properties: Type.Object({
        error: Type.Object({ properties: Type.Record(Type.String(), Type.Unknown()) }),
      }),
    }),
  }),
});

/** What the served document changes in an operation: its contract and its responses. */
const servedOperationSchema = Type.Object({
  operationId: Type.Optional(Type.String()),
  "x-devboxes": Type.Optional(Type.Unknown()),
  requestBody: Type.Optional(Type.Unknown()),
  responses: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

/**
 * Where the served document finds the details of a command's failures: each detail code's schema,
 * and the detail codes that each command's own code raises, by operationId, as the API derives
 * them from its source.
 */
export type DetailCodeSources = {
  schemas: Readonly<Record<string, TSchema>>;
  raised: Readonly<Record<string, readonly string[]>>;
};

/**
 * The detail codes that a command can raise (DEC-command-errors-per-command): those its own code
 * raises, as `raised` lists them by operationId, INVALID_INPUT when it takes a body, which the API's
 * validation refuses, and ELEVATION_REQUIRED for a write that names `approverRoles`, which Chat
 * holds for approval.
 */
export const detailCodesOf = (
  command: { operationId: string; contract: CommandContract; takesBody: boolean },
  raised: DetailCodeSources["raised"],
) => {
  const codes = new Set(raised[command.operationId]);
  if (command.takesBody) codes.add("INVALID_INPUT");
  if (command.contract.effect === "write" && command.contract.approverRoles)
    codes.add("ELEVATION_REQUIRED");
  return [...codes].sort();
};

/** FNV-1a's 32-bit offset basis and prime, which hash a set of detail codes into its response's name. */
const fnvOffsetBasis = 0x811c9dc5;
const fnvPrime = 0x01000193;

/**
 * The document as the API serves it: each contract leaves out `does`, and the response of every
 * command failure, a CommandError body, refers to the details schemas of only the codes
 * `detailCodesOf` gives its command. A command that raises none refers to
 * `components.responses.CommandError`, and one that does to the `CommandError.<hash>` response of its
 * set of codes, named by a hash of the set, so the name stays while the set does. The document
 * states the details schemas of only the codes some command raises.
 */
export const servedDocument = (
  document: Static<typeof commandDocumentSchema>,
  sources: DetailCodeSources,
) => {
  Value.Assert(failureComponents, document.components);
  const { CommandError } = document.components.schemas;
  const { details: _details, ...errorFields } = CommandError.properties.error.properties;
  const body = {
    ...CommandError,
    properties: {
      ...CommandError.properties,
      error: { ...CommandError.properties.error, properties: errorFields },
    },
  };
  const elysiaFailure = {
    description: CommandError.description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/CommandError" } } },
  };
  const codesOf = (operation: Static<typeof servedOperationSchema>) => {
    const { operationId, requestBody } = operation;
    const contract = operation["x-devboxes"];
    return operationId !== undefined && Value.Check(commandContractSchema, contract)
      ? detailCodesOf(
          { operationId, contract, takesBody: requestBody !== undefined },
          sources.raised,
        )
      : [];
  };
  const detailedFailure = (codes: readonly string[]) => ({
    description: `${CommandError.description} Its details are those of ${codes.join(", ")}.`,
    content: {
      "application/json": {
        schema: {
          allOf: [
            { $ref: "#/components/schemas/CommandError" },
            {
              properties: {
                error: {
                  properties: {
                    details: {
                      anyOf: codes.map((code) => ({
                        $ref: `#/components/schemas/CommandErrorDetails.${code}`,
                      })),
                    },
                  },
                },
              },
            },
          ],
        },
      },
    },
  });
  const failureName = (codes: readonly string[]) => {
    if (codes.length === 0) return "CommandError";
    let hash = fnvOffsetBasis;
    for (const character of codes.join(" "))
      hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), fnvPrime);
    return `CommandError.${(hash >>> 0).toString(36)}`;
  };
  const failing = Object.values(document.paths).flatMap((item) =>
    Object.values(item).flatMap((operation) =>
      Value.Check(servedOperationSchema, operation) &&
      Object.values(operation.responses ?? {}).some((response) =>
        Value.Equal(response, elysiaFailure),
      )
        ? [operation]
        : [],
    ),
  );
  const codeSets = new Map<string, readonly string[]>();
  for (const operation of failing) {
    const codes = codesOf(operation);
    const name = failureName(codes);
    const stated = codeSets.get(name);
    if (stated !== undefined && !Value.Equal(stated, codes))
      throw new Error(`Two sets of detail codes hash to ${name}.`);
    if (codes.length > 0) codeSets.set(name, codes);
  }
  const raisedCodes = [...new Set([...codeSets.values()].flat())].sort();
  const served = (operation: Static<typeof servedOperationSchema>) => {
    const { responses } = operation;
    const failure = failing.includes(operation)
      ? { $ref: `#/components/responses/${failureName(codesOf(operation))}` }
      : undefined;
    const referred = {
      ...operation,
      ...(responses && {
        responses: Object.fromEntries(
          Object.entries(responses).map(([status, response]) => [
            status,
            failure && Value.Equal(response, elysiaFailure) ? failure : response,
          ]),
        ),
      }),
    };
    const contract = operation["x-devboxes"];
    if (!Value.Check(commandContractSchema, contract)) return referred;
    const { does: _does, ...servedContract } = contract;
    return { ...referred, "x-devboxes": servedContract };
  };
  const paths = Object.fromEntries(
    Object.entries(document.paths).map(([path, item]) => [
      path,
      Object.fromEntries(
        Object.entries(item).map(([method, operation]) => [
          method,
          Value.Check(servedOperationSchema, operation) ? served(operation) : operation,
        ]),
      ),
    ]),
  );
  return {
    ...document,
    paths,
    components: {
      ...document.components,
      schemas: {
        ...document.components.schemas,
        CommandError: body,
        ...Object.fromEntries(
          raisedCodes.map((code) => {
            const schema = sources.schemas[code];
            if (!schema) throw new Error(`${code} is raised, but no details schema states it.`);
            return [`CommandErrorDetails.${code}`, schema];
          }),
        ),
      },
      responses: {
        CommandError: elysiaFailure,
        ...Object.fromEntries([...codeSets].map(([name, codes]) => [name, detailedFailure(codes)])),
      },
    },
  };
};

/** The operationId `<resource>.<verb>` of a command's path `/api/commands/<resource>/<verb>`, or null. */
export const commandOperationId = (path: string) => {
  const route = /^\/api\/commands\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(path);
  return route ? `${route[1]}.${route[2]}` : null;
};

/**
 * The commands of the API's OpenAPI document: every POST under `/api/commands/<resource>/<verb>`
 * whose operation this module reads, with the operationId `<resource>.<verb>`. Each other command
 * is `unreadable`, named by its path's operationId with what in it doesn't parse, so a client
 * built before the API changed one operation still reads all the others.
 */
export const catalogCommands = (document: Static<typeof commandDocumentSchema>) => {
  const commands: CatalogCommand[] = [];
  const unreadable: { operationId: string; problem: string }[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    const operationId = commandOperationId(path);
    if (operationId === null || item.post === undefined) continue;
    const operation = item.post;
    if (!Value.Check(operationSchema, operation))
      unreadable.push({ operationId, problem: describeErrors(operationSchema, operation) });
    else if (operation.operationId !== operationId)
      unreadable.push({ operationId, problem: `/operationId must be ${operationId}` });
    else commands.push({ ...operation, path, method: "POST" });
  }
  return { commands, unreadable };
};

/** The section and name of the component that JSON pointer `reference` names, or null for another pointer. */
const componentReference = (reference: string) => {
  const [section, name] = (/^#\/components\/([^/]+)\/([^/]+)$/.exec(reference) ?? [])
    .slice(1)
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  return section && name ? { section, name } : null;
};

/** Every `$ref` in `value`, at any depth. */
const references = (value: JsonValue | CatalogCommand) => {
  const found: string[] = [];
  JSON.stringify(value, (key, child: JsonValue) => {
    if (key === "$ref" && Value.Check(Type.String(), child)) found.push(child);
    return child;
  });
  return found;
};

const describedResponseSchema = Type.Object({ description: Type.String() });
const responseReferenceSchema = Type.Object({ $ref: Type.String() });

/**
 * The manual of `operationId`, a command that `document` serves, or null when it serves none by
 * that name: its operation with only the components it refers to, directly or through another
 * component. The short manual, everyone's default (DEC-one-short-manual), gives each distinct
 * failure as one response, keyed by its statuses joined with "/", that holds only its description,
 * which names the codes that carry details, so it carries no component that only failures refer
 * to. A failed call answers with its own code, message and details. The `full` manual keeps every
 * response as the document serves it.
 */
export const commandManual = (
  document: Static<typeof commandDocumentSchema>,
  operationId: string,
  full: boolean,
) => {
  const served = catalogCommands(document).commands.find(
    (command) => command.operationId === operationId,
  );
  if (!served) return null;
  const components = document.components ?? {};
  let operation = served;
  if (!full) {
    const failures = new Map<string, string[]>();
    const responses: Record<string, JsonValue> = {};
    const servedResponses: Record<string, JsonValue> = Object(served.responses);
    for (const [status, response] of Object.entries(servedResponses)) {
      const reference = Value.Check(responseReferenceSchema, response)
        ? componentReference(response.$ref)
        : null;
      const failure =
        reference?.section === "responses"
          ? Object(components.responses)[reference.name]
          : response;
      if (status.startsWith("2") || !Value.Check(describedResponseSchema, failure)) {
        responses[status] = response;
        continue;
      }
      failures.set(failure.description, [...(failures.get(failure.description) ?? []), status]);
    }
    for (const [description, statuses] of failures) responses[statuses.join("/")] = { description };
    operation = { ...served, responses };
  }
  const referred: Record<string, Record<string, JsonValue>> = {};
  const pending = references(operation);
  for (let reference = pending.pop(); reference !== undefined; reference = pending.pop()) {
    const component = componentReference(reference);
    if (!component) continue;
    const { section, name } = component;
    if (referred[section]?.[name] !== undefined) continue;
    const target: JsonValue | undefined = Object(components[section])[name];
    if (target === undefined) continue;
    referred[section] = { ...referred[section], [name]: target };
    pending.push(...references(target));
  }
  return { openapi: document.openapi, commands: [operation], components: referred };
};

/** The resource of an operation: the part of its operationId before the dot. */
export const resourceOf = (operationId: string) => operationId.split(".", 1)[0] ?? operationId;

/** The level a grant gives one resource. */
export type GrantLevel = "read" | "write";

/**
 * The grant of a delegation token or a Chat policy: a level for each resource, as Stripe
 * restricted keys store it (DEC-delegation-grants-resource-level). A grant names no operation, so
 * an operation added to a granted resource reaches it, and renaming an operation inside its
 * resource changes no grant.
 */
export type ResourceGrants = Record<string, GrantLevel>;

/**
 * Whether `resources` grant the operation `operationId`, whose contract names `effect`: `write` on
 * its resource grants every operation of it, and `read` those whose `effect` is `read`.
 */
export const grants = (
  resources: ResourceGrants,
  operationId: string,
  effect: CommandContract["effect"],
) => {
  const level = resources[resourceOf(operationId)];
  return level === "write" || (level === "read" && effect === "read");
};

/**
 * The resources of `resources` whose level grants none of `contracts`, the operations a holder can
 * call: a resource the holder has no operation of, and `read` on one where it has only writes.
 */
export const ungrantedResources = (
  resources: ResourceGrants,
  contracts: Iterable<readonly [operationId: string, contract: CommandContract]>,
) => {
  const granted = new Set(
    [...contracts].flatMap(([operationId, { effect }]) =>
      grants(resources, operationId, effect) ? [resourceOf(operationId)] : [],
    ),
  );
  return Object.keys(resources).filter((resource) => !granted.has(resource));
};

/**
 * What a delegation token can hold of one resource: the operations that each level grants, and the
 * elevated ones among them.
 */
export type DelegationResource = Record<GrantLevel, string[]> & { elevated: string[] };

/**
 * The resources that grants of `operations` reach, each with the operations each level grants and
 * the elevated ones among them. A token's are the served commands without `delegable: false`; a
 * Chat policy's are the contracts whose `chat` is `policy` (`chatResources`).
 */
export const delegationResources = (
  operations: Iterable<
    readonly [
      operationId: string,
      contract: { effect: "read" } | { effect: "write"; elevated: Elevation },
    ]
  >,
) => {
  const resources = new Map<string, DelegationResource>();
  for (const [operationId, detail] of operations) {
    const resource = resourceOf(operationId);
    const entry = resources.get(resource) ?? { read: [], write: [], elevated: [] };
    for (const level of ["read", "write"] as const)
      if (grants({ [resource]: level }, operationId, detail.effect)) entry[level].push(operationId);
    if (detail.effect === "write" && detail.elevated !== false) entry.elevated.push(operationId);
    resources.set(resource, entry);
  }
  return resources;
};

/**
 * The resources a delegation token can reach in `document`: the served commands without
 * `delegable: false`. The dashboard ships with the API, so this reads every contract whole and
 * fails on a command it can't read instead of leaving it out.
 */
export const tokenResources = (document: Static<typeof commandDocumentSchema>) => {
  const { commands, unreadable } = catalogCommands(document);
  if (unreadable.length > 0)
    throw new Error(
      `The command list holds commands the dashboard can't read: ${unreadable
        .map(({ operationId, problem }) => `${operationId} (${problem})`)
        .join(", ")}.`,
    );
  return delegationResources(
    commands.flatMap(({ operationId, "x-devboxes": served }) => {
      const contract = Value.Parse(servedContractSchema, served);
      return contract.delegable === false ? [] : [[operationId, contract] as const];
    }),
  );
};
