import type { TSchema } from "typebox";
import { Settings } from "typebox/system";
import Value from "typebox/value";

/**
 * Every way `value` fails `schema`, each as its JSON pointer and message. TypeBox stops collecting
 * at `maxErrors`, so the cap is lifted for this one synchronous collection.
 */
export const describeErrors = <Checked>(schema: TSchema, value: Checked) => {
  const { maxErrors } = Settings.Get();
  Settings.Set({ maxErrors: Number.POSITIVE_INFINITY });
  try {
    return Value.Errors(schema, value)
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
  } finally {
    Settings.Set({ maxErrors });
  }
};
