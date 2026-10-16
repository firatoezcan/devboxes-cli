import { confirm, isCancel, multiline, multiselect, password, select, text } from "@clack/prompts";
import { JsonValueSchema } from "./protocol/provider-auth";
import { describeErrors } from "./values/validation-errors";
import Type, { type Static } from "typebox";
import Value from "typebox/value";

import {
  type CommandConnection,
  type CommandDescription,
  CommandError,
  commandInputSchema,
  describeCommand,
  type Field,
  invokeCommand,
} from "./commands";

type Json = Static<typeof JsonValueSchema>;

const listedSchema = Type.Array(
  Type.Object({
    id: Type.String(),
    name: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    label: Type.Optional(Type.String()),
    email: Type.Optional(Type.String()),
  }),
);

export type PromptContext = { connection: CommandConnection; description: CommandDescription };

const answered = async <Answer>(prompt: Promise<Answer>) => {
  const answer = await prompt;
  if (isCancel(answer)) throw new CommandError("CANCELLED", "Command cancelled.");
  return answer as Exclude<Answer, symbol>;
};

const question = (path: string, field: Field) => {
  const [summary] = field.description?.split(/(?<=\.)\s/) ?? [];
  return summary ? `${path}: ${summary}` : path;
};

const types = (field: Field) =>
  field.type === undefined ? [] : Array.isArray(field.type) ? field.type : [field.type];

const problem = (field: Field, value: Json) =>
  Value.Check(field, value) ? undefined : describeErrors(field, value);

/**
 * The items of the list operation that names what an `<thing>Id` field takes, such as
 * organizations.list for organizationId, or undefined when there is none that the input gathered
 * so far can call, or when the list refuses, so the person types the ID instead. A list answers an
 * array or an object that holds the array under `<thing>s`.
 */
const listed = async (context: PromptContext, name: string, scope: Record<string, Json>) => {
  if (!name.endsWith("Id")) return undefined;
  const plural = `${name.slice(0, -2)}s`;
  const list = context.description.commands.find(
    (command) => command.operationId === `${plural}.list`,
  );
  if (!list) return undefined;
  const required = commandInputSchema(list)?.required ?? [];
  if (!required.every((key) => key in scope)) return undefined;
  let data: Json;
  try {
    ({ data } = await invokeCommand(
      context.connection,
      {
        command: list.operationId,
        input: Object.fromEntries(required.map((key) => [key, scope[key] ?? null])),
      },
      async () => context.description,
    ));
  } catch (error) {
    if (error instanceof CommandError) return undefined;
    throw error;
  }
  const items = Value.Check(Type.Record(Type.String(), JsonValueSchema), data)
    ? data[plural]
    : data;
  return Value.Check(listedSchema, items) ? items : undefined;
};

/**
 * Asks for one value of `field` in the terminal. `scope` is the command input gathered so far, which
 * a list operation behind an `<thing>Id` field may need.
 */
export const promptField = async (
  context: PromptContext,
  path: string,
  field: Field,
  scope: Record<string, Json>,
): Promise<Json> => {
  const message = question(path, field);
  const name = path.split(".").at(-1) ?? path;
  if (field.const !== undefined) return field.const;
  if (field.enum) {
    return answered(
      select({
        message,
        options: field.enum.map((value) => ({ value, label: String(value) })),
        output: process.stderr,
      }),
    );
  }
  if (field.anyOf) {
    const variant = await answered(
      select({
        message,
        options: field.anyOf.map((option) => ({
          value: option,
          label:
            option.const === undefined
              ? Object.entries(option.properties ?? {})
                  .flatMap(([key, property]) =>
                    property.const === undefined ? [] : [`${key} ${String(property.const)}`],
                  )
                  .join(", ") || types(option).join(" or ")
              : String(option.const),
        })),
        output: process.stderr,
      }),
    );
    return promptField(context, path, variant, scope);
  }
  const kinds = types(field);
  if (kinds.includes("null")) {
    if (!(await answered(confirm({ message: `Set ${path}?`, output: process.stderr }))))
      return null;
    return promptField(
      context,
      path,
      { ...field, type: kinds.filter((kind) => kind !== "null") },
      scope,
    );
  }
  const [kind] = kinds;
  if (kind === "object" && field.properties) {
    return promptObject(context, path, field, {}, scope);
  }
  if (kind === "object") {
    const entries: Record<string, Json> = {};
    const [entry] = Object.values(field.patternProperties ?? {});
    while (entry) {
      const key = (
        await answered(
          text({
            message: `${message}: name of another entry, or empty to finish`,
            output: process.stderr,
          }),
        )
      )?.trim();
      if (!key) break;
      entries[key] = await promptField(context, `${path}.${key}`, entry, scope);
    }
    return entries;
  }
  if (kind === "array") {
    const items: Json[] = [];
    const { items: item } = field;
    if (item?.enum) {
      return answered(
        multiselect({
          message,
          options: item.enum.map((value) => ({ value, label: String(value) })),
          required: false,
          output: process.stderr,
        }),
      );
    }
    while (
      item &&
      (await answered(
        confirm({
          message: `Add ${items.length === 0 ? "an" : "another"} item to ${path}?`,
          output: process.stderr,
        }),
      ))
    ) {
      items.push(await promptField(context, `${path}[${items.length}]`, item, scope));
    }
    return items;
  }
  if (kind === "boolean") return answered(confirm({ message, output: process.stderr }));
  if (kind === "integer" || kind === "number") {
    const entered = await answered(
      text({
        message,
        validate: (value) => problem(field, Number(value?.trim() || Number.NaN)),
        output: process.stderr,
      }),
    );
    return Number(entered.trim());
  }
  const choices = await listed(context, name, scope);
  if (choices?.length) {
    return answered(
      select({
        message,
        options: choices.map((choice) => ({
          value: choice.id,
          label: choice.name ?? choice.title ?? choice.label ?? choice.email ?? choice.id,
          hint: choice.id,
        })),
        output: process.stderr,
      }),
    );
  }
  const prompt = field.writeOnly ? password : (field.maxLength ?? 0) > 300 ? multiline : text;
  return answered(
    prompt({ message, validate: (value) => problem(field, value ?? ""), output: process.stderr }),
  );
};

/**
 * Asks for the required properties of an object in order, then offers its optional ones. `value`
 * holds properties already known, which are not asked again.
 */
const promptObject = async (
  context: PromptContext,
  path: string,
  field: Field,
  value: Record<string, Json>,
  scope: Record<string, Json>,
) => {
  const properties = Object.entries(field.properties ?? {}).filter(([name]) => !(name in value));
  const required = new Set(field.required);
  const at = (name: string) => (path ? `${path}.${name}` : name);
  for (const [name, property] of properties) {
    if (required.has(name)) value[name] = await promptField(context, at(name), property, scope);
  }
  const optional = properties.filter(([name]) => !required.has(name));
  if (optional.length === 0) return value;
  const chosen = await answered(
    multiselect({
      message: `Also set${path ? ` in ${path}` : ""} (space chooses, enter continues)`,
      options: optional.map(([name, property]) => ({
        value: name,
        label: name,
        hint: property.description?.split(/(?<=\.)\s/)[0],
      })),
      required: false,
      output: process.stderr,
    }),
  );
  for (const [name, property] of optional) {
    if (chosen.includes(name)) value[name] = await promptField(context, at(name), property, scope);
  }
  return value;
};

/**
 * Asks in the terminal for the input of `operationId`, field by field, from the input schema the
 * API advertises for it. An Organization-bound token's Organization is not asked for.
 */
export const promptCommandInput = async (context: PromptContext, operationId: string) => {
  const [operation] = describeCommand(context.description, operationId).commands;
  const schema = commandInputSchema(operation);
  if (schema === undefined) return {};
  if (types(schema)[0] !== "object" || !schema.properties)
    return promptField(context, operationId, schema, {});
  const value: Record<string, Json> = {};
  if (context.connection.organizationId) value.organizationId = context.connection.organizationId;
  return promptObject(context, "", schema, value, value);
};
