import { betterFetch } from "@better-fetch/fetch";
import { defaultTextMapGetter, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { z } from "zod";

import { cliUserAgent } from "./api";

/**
 * `organizationId` is the one Organization the token is bound to, such as a Chat turn's. Every
 * command that takes an `organizationId` receives it in place of the one its input names.
 */
export type CommandConnection = { origin: string; token: string; organizationId?: string };

const operationSchema = z
  .object({
    operationId: z.string().min(1),
    summary: z.string().optional(),
    "x-devboxes": z.object({
      effect: z.enum(["read", "write"]),
      authority: z.string().min(1),
    }),
    requestBody: z.unknown().optional(),
    responses: z.record(z.string(), z.unknown()),
  })
  .passthrough();

const organizationScopedOperationSchema = z.object({
  requestBody: z.object({
    content: z.object({
      "application/json": z.object({
        schema: z.object({ properties: z.object({ organizationId: z.object({}) }) }),
      }),
    }),
  }),
});
const commandObjectInputSchema = z.record(z.string(), z.json());

const documentSchema = z.object({
  openapi: z.string(),
  paths: z.record(z.string(), z.object({ post: z.unknown().optional() }).passthrough()),
  components: z.record(z.string(), z.unknown()).optional(),
});

export const failureSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.json().optional(),
});
export const errorSchema = z.object({ error: failureSchema });
const systemErrorSchema = z.object({ code: z.string() });
const responseTextSchema = z.string();

type Command = z.infer<typeof operationSchema> & { path: string; method: "POST" };
export type CommandDescription = {
  openapi: string;
  commands: Command[];
  components: NonNullable<z.infer<typeof documentSchema>["components"]>;
};
type RequestCorrelation = { traceId: string | null; requestId: string | null };
export type CommandResponse = { status: number; data: z.core.util.JSONType } & RequestCorrelation;

export class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly options: {
      status?: number;
      details?: z.core.util.JSONType;
      correlation?: RequestCorrelation;
    } = {},
  ) {
    super(message);
    this.name = "CommandError";
  }

  static from(cause: unknown) {
    if (cause instanceof CommandError) return cause;
    if (!(cause instanceof Error)) return new CommandError("COMMAND_FAILED", String(cause));
    const system = systemErrorSchema.safeParse(cause);
    return new CommandError(
      "COMMAND_FAILED",
      `${system.success ? system.data.code : cause.name}: ${cause.message}`,
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
): z.core.util.JSONType =>
  text
    ? JSON.parse(text, (key: string, value: z.core.util.JSONType) => {
        const parsed = responseTextSchema.safeParse(value);
        if (!parsed.success) return value;
        if (redactAuthTokens && key === "token" && parsed.data) return "[redacted]";
        let text = parsed.data;
        for (const secret of secrets) {
          if (secret) text = text.replaceAll(secret, "[redacted]");
        }
        return text;
      })
    : null;

export const requestJson = async (
  connection: CommandConnection,
  path: string,
  body?: z.core.util.JSONType,
): Promise<CommandResponse> => {
  const headers = new Headers({ Accept: "application/json", "User-Agent": cliUserAgent });
  injectCallerTrace(headers);
  let traceId: string | null = null;
  let requestId: string | null = null;
  let result: CommandResponse | undefined;
  const { error } = await betterFetch<z.core.util.JSONType>(path, {
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
  const failure = errorSchema.safeParse(error);
  if (failure.success) {
    throw new CommandError(failure.data.error.code, failure.data.error.message, {
      status: error.status,
      details: failure.data.error.details,
      correlation,
    });
  }
  throw new CommandError(
    "HTTP_ERROR",
    `The API returned HTTP ${error.status} without a command error.`,
    { status: error.status, correlation },
  );
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

export const readCommandInput = async (source: string): Promise<z.core.util.JSONType> => {
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
  let input: z.core.util.JSONType | undefined;
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
  const document = documentSchema.safeParse(response.data);
  if (!document.success) {
    throw new CommandError("INVALID_DISCOVERY", "The API returned an invalid OpenAPI document.");
  }
  const commands = [];
  const ids = new Set<string>();
  for (const [path, item] of Object.entries(document.data.paths)) {
    const route = /^\/api\/commands\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(path);
    if (!route || item.post === undefined) continue;
    const parsed = operationSchema.safeParse(item.post);
    if (!parsed.success || parsed.data.operationId !== `${route[1]}.${route[2]}`) {
      throw new CommandError(
        "INVALID_DISCOVERY",
        "A command route has an invalid operation contract.",
      );
    }
    if (ids.has(parsed.data.operationId)) {
      throw new CommandError("INVALID_DISCOVERY", "Command operation IDs must be unique.");
    }
    ids.add(parsed.data.operationId);
    commands.push({ ...parsed.data, path, method: "POST" as const });
  }
  return {
    openapi: document.data.openapi,
    commands,
    components: document.data.components ?? {},
  };
};

/** The advertised commands narrowed to one, or a refusal of a command the API does not advertise. */
export const describeCommand = (
  description: CommandDescription,
  command: string,
): CommandDescription & { commands: [Command] } => {
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
  invocation: { command: string; input: z.core.util.JSONType },
  readCommands = describeCommands,
): Promise<CommandResponse> => {
  const [operation] = describeCommand(await readCommands(connection), invocation.command).commands;
  let input = invocation.input;
  if (connection.organizationId && organizationScopedOperationSchema.safeParse(operation).success) {
    const object = commandObjectInputSchema.safeParse(input);
    if (object.success) input = { ...object.data, organizationId: connection.organizationId };
  }
  return requestJson(connection, operation.path, input);
};

const commandToolOutcome = async <Result>(operation: () => Promise<Result>) => {
  try {
    return { isError: false, result: await operation() };
  } catch (error) {
    return { isError: true, result: CommandError.from(error).toJSON() };
  }
};

/**
 * The Devboxes command tools. `devboxes mcp` serves them over stdio, and the Chat native host
 * runs them in its own process. A command failure becomes an error result the agent reads. Each
 * call reads the advertised commands with `readCommands`, which by default asks the API again.
 */
export const devboxesCommandTools = (
  connection: CommandConnection,
  readCommands = describeCommands,
) => ({
  describe: {
    name: "devboxes_describe",
    description:
      "List Devboxes command IDs, effects, and summaries when command is omitted. Pass an exact command ID to read its OpenAPI input, response, and authority contract before using devboxes_invoke. Discovery does not grant authority.",
    input: z.object({ command: z.string().min(1).optional() }),
    run: ({ command }: { command?: string }) =>
      commandToolOutcome(async () => {
        const description = await readCommands(connection);
        if (command !== undefined) return describeCommand(description, command);
        return {
          commands: description.commands.map((operation) => ({
            operationId: operation.operationId,
            effect: operation["x-devboxes"].effect,
            summary: operation.summary,
          })),
        };
      }),
  },
  invoke: {
    name: "devboxes_invoke",
    description:
      "Invoke an advertised Devboxes command. Supply JSON input directly, never a local file reference. HTTP acceptance is not evidence that asynchronous work completed.",
    input: z.object({ command: z.string().min(1), input: z.json() }),
    run: (invocation: { command: string; input: z.core.util.JSONType }) =>
      commandToolOutcome(() => invokeCommand(connection, invocation, readCommands)),
  },
});
