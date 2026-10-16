import { betterFetch } from "@better-fetch/fetch";
import {
  type CatalogCommand,
  catalogCommands,
  commandDocumentSchema,
} from "@firops/platform/protocol/command-catalog";
import { JsonValueSchema } from "@firops/platform/protocol/provider-auth";
import { describeErrors } from "@firops/platform/values/validation-errors";
import { defaultTextMapGetter, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import Type, { type Static, type TObject, type TSchema } from "typebox";
import Value from "typebox/value";

import { cliUserAgent } from "./api";

/**
 * `organizationId` is the one Organization the token is bound to, such as a Chat turn's. Every
 * command that takes an `organizationId` receives it in place of the one its input names.
 */
export type CommandConnection = { origin: string; token: string; organizationId?: string };

const organizationScopedOperationSchema = Type.Object({
  requestBody: Type.Object({
    content: Type.Object({
      "application/json": Type.Object({
        schema: Type.Object({ properties: Type.Object({ organizationId: Type.Object({}) }) }),
      }),
    }),
  }),
});
const commandObjectInputSchema = Type.Record(Type.String(), JsonValueSchema);

export const failureSchema = Type.Object({
  code: Type.String(),
  message: Type.String(),
  details: Type.Optional(JsonValueSchema),
});
const errorSchema = Type.Object({ error: failureSchema });
const systemErrorSchema = Type.Object({ code: Type.String() });

export type CommandDescription = {
  openapi: string;
  commands: CatalogCommand[];
  components: NonNullable<Static<typeof commandDocumentSchema>["components"]>;
};
type RequestCorrelation = { traceId: string | null; requestId: string | null };
export type CommandResponse = {
  status: number;
  data: Static<typeof JsonValueSchema>;
} & RequestCorrelation;

export class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly options: {
      status?: number;
      details?: Static<typeof JsonValueSchema>;
      correlation?: RequestCorrelation;
    } = {},
  ) {
    super(message);
    this.name = "CommandError";
  }

  static from(cause: unknown) {
    if (cause instanceof CommandError) return cause;
    if (!(cause instanceof Error)) return new CommandError("COMMAND_FAILED", String(cause));
    const kind = Value.Check(systemErrorSchema, cause) ? cause.code : cause.name;
    return new CommandError(
      "COMMAND_FAILED",
      cause.message.includes(kind) ? cause.message : `${kind}: ${cause.message}`,
    );
  }

  // A serialization conflict commits nothing, so the same command can be sent again.
  get retryable() {
    return this.code === "CONCURRENT_MODIFICATION";
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.options.details,
        retryable: this.retryable,
      },
      status: this.options.status,
      ...this.options.correlation,
    };
  }

  toString() {
    const qualifiers = [
      ...(this.options.status === undefined ? [] : [`HTTP ${this.options.status}`]),
      ...(this.retryable ? ["retryable"] : []),
    ];
    return `${this.code}${qualifiers.length ? ` (${qualifiers.join(", ")})` : ""}: ${this.message}`;
  }
}

const w3cTraceContext = new W3CTraceContextPropagator();

// The CLI joins the caller's W3C trace from TRACEPARENT. Without one it sends no traceparent, so
// the API starts each request's trace, and a result reports the trace the API names in its
// traceresponse.
const callerTrace = w3cTraceContext.extract(
  ROOT_CONTEXT,
  { traceparent: process.env.TRACEPARENT },
  defaultTextMapGetter,
);

export const injectCallerTrace = (headers: Headers) =>
  w3cTraceContext.inject(callerTrace, headers, {
    set: (carrier, key, value) => carrier.set(key, value),
  });

export const apiOrigin = (value: string, identity: "account" | "scoped" = "scoped"): string => {
  const url = URL.parse(value);
  const local =
    url !== null &&
    (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      (identity === "scoped" && url.hostname === "host.docker.internal"));
  if (
    url === null ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["/", "/api", "/api/"].includes(url.pathname)
  ) {
    throw new CommandError(
      "INVALID_API_URL",
      "Use an HTTPS API origin, optionally ending in /api, without credentials, query, or fragment. Local HTTP is allowed for development.",
    );
  }
  return url.origin;
};

export const credentialSafeJson = (
  text: string,
  secrets: readonly (string | undefined)[],
  redactAuthTokens = false,
): Static<typeof JsonValueSchema> =>
  text
    ? JSON.parse(text, (key: string, value: Static<typeof JsonValueSchema>) => {
        if (!Value.Check(Type.String(), value)) return value;
        if (redactAuthTokens && key === "token" && value) return "[redacted]";
        let text = value;
        for (const secret of secrets) {
          if (secret) text = text.replaceAll(secret, "[redacted]");
        }
        return text;
      })
    : null;

/** The `endpoint` response as `schema` declares it, or a refusal that names every problem. */
export const parseResponse = <Schema extends TSchema>(
  schema: Schema,
  data: Static<typeof JsonValueSchema>,
  endpoint: string,
): Static<Schema> => {
  if (Value.Check(schema, data)) return data;
  throw new CommandError(
    "INVALID_RESPONSE",
    `The ${endpoint} response is invalid: ${describeErrors(schema, data)}.`,
  );
};

export const requestJson = async (
  connection: CommandConnection,
  path: string,
  body?: Static<typeof JsonValueSchema>,
): Promise<CommandResponse> => {
  const headers = new Headers({ Accept: "application/json", "User-Agent": cliUserAgent });
  injectCallerTrace(headers);
  let traceId: string | null = null;
  let requestId: string | null = null;
  let result: CommandResponse | undefined;
  const { error } = await betterFetch<Static<typeof JsonValueSchema>>(path, {
    baseURL: connection.origin,
    method: body === undefined ? "GET" : "POST",
    body,
    auth: { type: "Bearer", token: connection.token },
    headers,
    redirect: "error",
    jsonParser: (text) => credentialSafeJson(text, [connection.token]),
    onResponse: ({ response }) => {
      traceId =
        trace.getSpanContext(
          w3cTraceContext.extract(
            ROOT_CONTEXT,
            { traceparent: response.headers.get("traceresponse") ?? undefined },
            defaultTextMapGetter,
          ),
        )?.traceId ?? null;
      requestId = response.headers.get("x-request-id");
    },
    onSuccess: ({ data, response }) => {
      result = { status: response.status, data, traceId, requestId };
    },
  });
  if (result) return result;
  const correlation = { traceId, requestId };
  if (!error)
    throw new CommandError("INVALID_RESPONSE", "The API returned no command result.", {
      correlation,
    });
  if (Value.Check(errorSchema, error)) {
    throw new CommandError(error.error.code, error.error.message, {
      status: error.status,
      details: error.error.details,
      correlation,
    });
  }
  throw new CommandError(
    "HTTP_ERROR",
    `The API returned HTTP ${error.status} without a command error.`,
    { status: error.status, correlation },
  );
};

/** Opens `url` in the default browser, or asks the person to open it when that fails. */
export const openInBrowser = (url: string) => {
  try {
    Bun.spawn(
      process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["rundll32", "url.dll,FileProtocolHandler", url]
          : ["xdg-open", url],
      { stdio: ["ignore", "ignore", "ignore"] },
    ).unref();
  } catch {
    process.stderr.write("Open the URL above in a browser.\n");
  }
};

/**
 * Writes command output to stdout and resolves once stdout accepted all of it. All CLI output goes
 * through `process.stdout`, which the entrypoint, Commander, and the MCP transport also write to.
 * Once `process.stdout` exists, `Bun.write(Bun.stdout, ...)` restarts from the first byte when a
 * pipe fills, so a slow reader receives the first 64 KiB twice. The output is written as bytes, which
 * the entrypoint's ANSI filter passes through, so a result's text keeps its C1 control characters.
 */
export const writeOutput = (text: string) =>
  new Promise<void>((resolve, reject) =>
    process.stdout.write(Buffer.from(text), (error) => (error ? reject(error) : resolve())),
  );

export const readCommandInput = async (source: string): Promise<Static<typeof JsonValueSchema>> => {
  let text: string;
  if (source === "-") {
    if (process.stdin.isTTY)
      throw new CommandError("INPUT_REQUIRED", "Pipe JSON to stdin or use --input @file.");
    text = await Bun.stdin.text();
  } else if (source.startsWith("@") && source.length > 1) {
    const file = Bun.file(source.slice(1));
    if (!(await file.exists()))
      throw new CommandError("INPUT_FILE_NOT_FOUND", "The --input file does not exist.");
    text = await file.text();
  } else {
    throw new CommandError(
      "INVALID_INPUT_SOURCE",
      "Use --input @file or --input -. Keep credentials out of command arguments.",
    );
  }
  let input: Static<typeof JsonValueSchema> | undefined;
  try {
    input = JSON.parse(text);
  } catch {
    input = undefined;
  }
  if (input === undefined)
    throw new CommandError("INVALID_INPUT_JSON", "The command input is not valid JSON.");
  return input;
};

export const describeCommands = async (
  connection: CommandConnection,
): Promise<CommandDescription> => {
  const response = await requestJson(connection, "/api/openapi/json");
  const document = response.data;
  if (!Value.Check(commandDocumentSchema, document)) {
    throw new CommandError(
      "INVALID_DISCOVERY",
      `The API returned an invalid OpenAPI document: ${describeErrors(commandDocumentSchema, document)}.`,
    );
  }
  const catalog = catalogCommands(document);
  if ("problem" in catalog) throw new CommandError("INVALID_DISCOVERY", catalog.problem);
  return {
    openapi: document.openapi,
    commands: catalog.commands,
    components: document.components ?? {},
  };
};

/** The advertised commands narrowed to one, or a refusal of a command the API does not advertise. */
export const describeCommand = (
  description: CommandDescription,
  command: string,
): CommandDescription & { commands: [CatalogCommand] } => {
  const operation = description.commands.find((candidate) => candidate.operationId === command);
  if (!operation) {
    throw new CommandError(
      "UNKNOWN_COMMAND",
      "This operation is not advertised by the configured API. Use devboxes commands to discover available operations.",
    );
  }
  return { ...description, commands: [operation] };
};

export const invokeCommand = async (
  connection: CommandConnection,
  invocation: { command: string; input: Static<typeof JsonValueSchema> },
  readCommands = describeCommands,
): Promise<CommandResponse> => {
  const [operation] = describeCommand(await readCommands(connection), invocation.command).commands;
  let input = invocation.input;
  if (
    connection.organizationId &&
    Value.Check(organizationScopedOperationSchema, operation) &&
    Value.Check(commandObjectInputSchema, input)
  ) {
    input = { ...input, organizationId: connection.organizationId };
  }
  return requestJson(connection, operation.path, input);
};

/**
 * A devboxes command tool. Its run refuses input that `input` rejects, and returns that refusal or a
 * command failure as an error result the agent reads.
 */
const commandTool = <Input extends TObject, Result>(
  name: string,
  description: string,
  input: Input,
  run: (input: Static<Input>) => Promise<Result>,
) => ({
  name,
  description,
  input,
  run: async <Submitted>(submitted: Submitted) => {
    try {
      if (!Value.Check(input, submitted))
        throw new CommandError(
          "INVALID_INPUT",
          `The ${name} input is invalid: ${describeErrors(input, submitted)}.`,
        );
      return { isError: false, result: await run(submitted) };
    } catch (error) {
      return { isError: true, result: CommandError.from(error).toJSON() };
    }
  },
});

/**
 * The devboxes command tools. `devboxes mcp` serves them over stdio, and the Chat native host
 * runs them in its own process. Each call reads the advertised commands with `readCommands`, which
 * by default asks the API again.
 */
export const devboxesCommandTools = (
  connection: CommandConnection,
  readCommands = describeCommands,
) => ({
  describe: commandTool(
    "devboxes_describe",
    "List devboxes command IDs, effects, and summaries when command is omitted. Pass an exact command ID to read its OpenAPI input, response, and authority contract before using devboxes_invoke. Discovery does not grant authority.",
    Type.Object({ command: Type.Optional(Type.String({ minLength: 1 })) }),
    async ({ command }) => {
      const description = await readCommands(connection);
      if (command !== undefined) return describeCommand(description, command);
      return {
        commands: description.commands.map((operation) => ({
          operationId: operation.operationId,
          effect: operation["x-devboxes"].effect,
          summary: operation.summary,
        })),
      };
    },
  ),
  invoke: commandTool(
    "devboxes_invoke",
    "Invoke an advertised devboxes command. Supply JSON input directly, never a local file reference. HTTP acceptance is not evidence that asynchronous work completed.",
    Type.Object({
      command: Type.String({ minLength: 1 }),
      // Tool arguments arrive as JSON, so the advertised schema accepts every value.
      input: Type.Unsafe<Static<typeof JsonValueSchema>>({}),
    }),
    (invocation) => invokeCommand(connection, invocation, readCommands),
  ),
});
