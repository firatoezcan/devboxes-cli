import Type from "typebox";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Checks a value's top level only: a string, number, boolean, null, array or object, whatever it
 * holds. It proves a JSON value only for one parsed from JSON text, whose nested values are JSON
 * already. A deeper check needs a cyclic schema, which fails to compile in an Elysia response that
 * also holds an optional property.
 */
export const JsonValueSchema = Type.Unsafe<JsonValue>(
  Type.Union([
    Type.String(),
    Type.Number(),
    Type.Boolean(),
    Type.Null(),
    Type.Array(Type.Unknown()),
    Type.Record(Type.String(), Type.Unknown()),
  ]),
);
