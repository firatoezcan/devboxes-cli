import { betterFetch } from "@better-fetch/fetch";
import {
  type CatalogCommand,
  catalogCommands,
  commandDocumentSchema,
} from "./protocol/command-catalog";
import { JsonValueSchema, type JsonValue } from "./protocol/json";
import { redactedSecret, secretRedactingReviver } from "./security/secret-redaction";
import { describeErrors } from "./values/validation-errors";
import { defaultTextMapGetter, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import Type, { type Static, type TObject, type TSchema } from "typebox";
import Value from "typebox/value";

import { cliUserAgent } from "./api";

/**
 * `organizationId` is the one Organization the token is bound to, such as a Chat turn's. Every
 * command that takes an `organizationId` receives it in place of the one its input names.
 */
export type CommandConnection = {
  origin: string;
  token: string;
  organizationId?: string;
  /** Headers every request sends besides the ones `requestJson` sets. */
  headers?: Record<string, string>;
  /**
   * Saves the session token a response hands over in `set-auth-token`, which replaces the account
   * session's when the change ends that session, as turning on two-factor authentication does.
   */
  saveToken?: (token: string) => Promise<void>;
  /**
   * Signs the person at the terminal in again and answers the new session token, for an account
   * session that may ask: `requestJson` then sends a request refused with SESSION_NOT_FRESH once more.
   */
  signInAgain?: () => Promise<string>;
  /**
   * Asks the person at the terminal, in one pass, for the Blueprint inputs that a request lacks a
   * usable value for, and answers the values by name: `requestJson` then sends a request refused
   * with BLUEPRINT_INPUT_MISSING or BLUEPRINT_INPUT_TYPE once more, when each listed input comes
   * from the dispatch, whose value goes in `inputs`, or is the issue the work is linked to, whose
   * value goes in `issue`.
   */
  askInputs?: (
    unresolved: Static<typeof askableInputsSchema>["inputs"],
  ) => Promise<Record<string, JsonValue>>;
};

const scalar = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);

/** The part of JSON Schema that the API's command input schemas use. A writeOnly string is a secret. */
const fieldSchema = Type.Cyclic(
  {
    Field: Type.Object({
      type: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
      description: Type.Optional(Type.String()),
      maxLength: Type.Optional(Type.Number()),
      writeOnly: Type.Optional(Type.Boolean()),
      properties: Type.Optional(Type.Record(Type.String(), Type.Ref("Field"))),
      required: Type.Optional(Type.Array(Type.String())),
      patternProperties: Type.Optional(Type.Record(Type.String(), Type.Ref("Field"))),
      items: Type.Optional(Type.Ref("Field")),
      anyOf: Type.Optional(Type.Array(Type.Ref("Field"))),
      enum: Type.Optional(Type.Array(scalar)),
      const: Type.Optional(scalar),
    }),
  },
  "Field",
);
export type Field = Static<typeof fieldSchema>;
const requestSchema = Type.Object({
  content: Type.Object({ "application/json": Type.Object({ schema: fieldSchema }) }),
});

/** The input schema `operation` advertises, or undefined for an operation without input. */
export const commandInputSchema = (operation: CatalogCommand): Field | undefined => {
  if (operation.requestBody === undefined) return undefined;
  if (!Value.Check(requestSchema, operation.requestBody))
    throw unreadableAnswer(
      `the input schema of ${operation.operationId}`,
      describeErrors(requestSchema, operation.requestBody),
    );
  return operation.requestBody.content["application/json"].schema;
};

const commandObjectInputSchema = Type.Record(Type.String(), JsonValueSchema);

export const failureSchema = Type.Object({
  code: Type.String(),
  message: Type.String(),
  details: Type.Optional(JsonValueSchema),
});
const errorSchema = Type.Object({ error: failureSchema });
const askableInputsSchema = Type.Object({
  inputs: Type.Array(
    Type.Object({
      name: Type.String(),
      source: Type.Union([Type.Literal("dispatch"), Type.Literal("issue")]),
      type: Type.Union([Type.Literal("string"), Type.Literal("number"), Type.Literal("boolean")]),
      description: Type.Optional(Type.String()),
    }),
  ),
});
const inputsBodySchema = Type.Object({
  inputs: Type.Optional(Type.Record(Type.String(), JsonValueSchema)),
});
const systemErrorSchema = Type.Object({ code: Type.String() });

export type CommandDescription = {
  openapi: string;
  commands: CatalogCommand[];
  components: NonNullable<Static<typeof commandDocumentSchema>["components"]>;
};
type RequestCorrelation = { traceId: string | null; requestId: string | null };
type CommandResponse = {
  status: number;
  data: JsonValue;
} & RequestCorrelation;

export class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly options: {
      status?: number;
      details?: JsonValue;
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
): JsonValue => {
  if (!text) return null;
  const redact = secretRedactingReviver(secrets.filter((secret) => secret !== undefined));
  return JSON.parse(text, (key: string, value: JsonValue) =>
    redactAuthTokens && key === "token" && Value.Check(Type.String({ minLength: 1 }), value)
      ? redactedSecret
      : redact(key, value),
  );
};

/**
 * The refusal of an API answer that this CLI can't read, naming the `answer` and its `problems`.
 * Production always runs the newest API, so the CLI is the one to update.
 */
const unreadableAnswer = (answer: string, problems: string, correlation?: RequestCorrelation) =>
  new CommandError(
    "INVALID_RESPONSE",
    `This devboxes CLI can't read ${answer} (${problems}). Install the current CLI from https://devboxes.ai/install.`,
    { correlation },
  );

/** The `endpoint` response as `schema` declares it, or a refusal that names every problem. */
export const parseResponse = <Schema extends TSchema>(
  schema: Schema,
  data: JsonValue,
  endpoint: string,
): Static<Schema> => {
  if (Value.Check(schema, data)) return data;
  throw unreadableAnswer(`the ${endpoint} response`, describeErrors(schema, data));
};

export const requestJson = async (
  connection: CommandConnection,
  path: string,
  body?: JsonValue,
): Promise<CommandResponse> => {
  const headers = new Headers({
    ...connection.headers,
    Accept: "application/json",
    "User-Agent": cliUserAgent,
  });
  injectCallerTrace(headers);
  let traceId: string | null = null;
  let requestId: string | null = null;
  let result: CommandResponse | undefined;
  const { error } = await betterFetch<JsonValue>(path, {
    baseURL: connection.origin,
    method: body === undefined ? "GET" : "POST",
    body,
    auth: { type: "Bearer", token: connection.token },
    headers,
    redirect: "error",
    jsonParser: (text) => credentialSafeJson(text, [connection.token]),
    onResponse: async ({ response }) => {
      const replaced = response.headers.get("set-auth-token");
      if (replaced && connection.saveToken) await connection.saveToken(replaced);
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
    throw unreadableAnswer(`the ${path} response`, "it holds no command result", correlation);
  if (Value.Check(errorSchema, error)) {
    if (error.error.code === "SESSION_NOT_FRESH" && connection.signInAgain)
      return requestJson(
        { ...connection, token: await connection.signInAgain(), signInAgain: undefined },
        path,
        body,
      );
    if (
      (error.error.code === "BLUEPRINT_INPUT_MISSING" ||
        error.error.code === "BLUEPRINT_INPUT_TYPE") &&
      connection.askInputs &&
      Value.Check(askableInputsSchema, error.error.details) &&
      Value.Check(inputsBodySchema, body)
    ) {
      const unresolved = error.error.details.inputs;
      const answers = await connection.askInputs(unresolved);
      const inputs = { ...body.inputs };
      let issue: JsonValue | undefined;
      for (const { name, source } of unresolved) {
        if (source === "issue") issue = answers[name] ?? null;
        else inputs[name] = answers[name] ?? null;
      }
      return requestJson({ ...connection, askInputs: undefined }, path, {
        ...body,
        inputs,
        ...(issue !== undefined && { issue }),
      });
    }
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

/** Whether the CLI may ask in the terminal: outside --json, with stdin and stderr on a terminal. */
export const asksInTerminal = (json: boolean | undefined) =>
  !json && process.stdin.isTTY && process.stderr.isTTY;

/**
 * `value` as an HTTP or HTTPS URL, or null. The CLI opens no other URL in a browser, because the
 * operating system hands any other scheme to whatever handler it has for it.
 */
export const httpUrl = (value: string) => {
  const url = URL.parse(value);
  return url && ["http:", "https:"].includes(url.protocol) ? url : null;
};

/**
 * Opens `url`, an HTTP or HTTPS URL from `httpUrl`, in the default browser, or asks the person to
 * open it when that fails.
 */
export const openInBrowser = (url: URL) => {
  try {
    Bun.spawn(
      process.platform === "darwin"
        ? ["open", url.href]
        : process.platform === "win32"
          ? ["rundll32", "url.dll,FileProtocolHandler", url.href]
          : ["xdg-open", url.href],
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

export const readCommandInput = async (source: string): Promise<JsonValue> => {
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
  let input: JsonValue | undefined;
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
  if (!Value.Check(commandDocumentSchema, document))
    throw unreadableAnswer("the command list", describeErrors(commandDocumentSchema, document));
  const catalog = catalogCommands(document);
  if ("problem" in catalog) throw unreadableAnswer("the command list", catalog.problem);
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
  invocation: { command: string; input: JsonValue },
  readCommands = describeCommands,
): Promise<CommandResponse> => {
  const [operation] = describeCommand(await readCommands(connection), invocation.command).commands;
  let input = invocation.input;
  if (
    connection.organizationId &&
    commandInputSchema(operation)?.properties?.organizationId &&
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
export const commandTool = <Input extends TObject, Result>(
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
 * The devboxes command tools, describe and invoke, which `devboxes mcp` serves over stdio and the
 * Chat native host runs in its own process. Each call reads the advertised commands with
 * `readCommands`, which by default asks the API again.
 */
export const devboxesCommandTools = (
  connection: CommandConnection,
  readCommands = describeCommands,
) => ({
  describe: commandTool(
    "devboxes_describe",
    "Look up devboxes application commands before you use one. Without `command`, it lists the commands you can call, each with its `operationId`, its `effect` (read or write) and a one-line `summary`. With an exact command ID, it returns that command's full contract: its input and response schemas, who may call it and, for an elevated write, its elevation level and `approverRoles`, the roles whose Members can approve it. Describe a command before you first call it with devboxes_invoke, because its description carries the rules for using it. Being listed doesn't promise a call will succeed: a command can still refuse you because of your role, the Chat policy or a stale sign-in.",
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
    "Run a devboxes application command. Pass `command`, its operation ID, and `input`, a JSON object written into the call itself, never a path to a local file; devboxes checks it against the command's schema. You get back the command's own response. When a command refuses, the answer looks like `{ error: { code, message, details, retryable }, status }`, for example with the code ROLE_REQUIRED, and the code and details tell you what went wrong.\n\nCommands that start work (sessions.dispatch, sessions.continue, sessions.input, review.request and schedules.run) answer as soon as the work is admitted, with what started, such as its `sessionUrl`. The result comes later, as finishedWork in a later turn or through sessions.inspect, so never report admitted work as done.\n\nFrom Chat, an elevated write doesn't run straight away. The call refuses with ELEVATION_REQUIRED, and `details.elevation` holds `{ requestId, approvalUrl }`. Tell the person the change is waiting for approval, say who can approve it (the roles in the command's approverRoles, which devboxes_describe shows) and link approvalUrl. Once a Member with one of those roles approves it (for a direct conversation, only that conversation's person can), the change runs by itself, so don't call the command again. If you learn that an approver refused it, tell the person who asked, in this conversation, that the change was refused and won't run, so nobody keeps waiting for it.\n\nDescribe a command with devboxes_describe before you first invoke it.",
    Type.Object({
      command: Type.String({ minLength: 1 }),
      // Tool arguments arrive as JSON, so the advertised schema accepts every value.
      input: Type.Unsafe<JsonValue>({}),
    }),
    (invocation) => invokeCommand(connection, invocation, readCommands),
  ),
});
