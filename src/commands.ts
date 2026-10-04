import { betterFetch } from "@better-fetch/fetch";
import { z } from "zod";

import { cliUserAgent } from "./api";

export type CommandConnection = { origin: string; token: string };

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
const errorSchema = z.object({ error: failureSchema });
const responseTextSchema = z.string();

export type CommandDescription = {
  openapi: string;
  commands: (z.infer<typeof operationSchema> & { path: string; method: "POST" })[];
  components: NonNullable<z.infer<typeof documentSchema>["components"]>;
};
export type CommandResponse = { status: number; data: z.core.util.JSONType };

export class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly details?: z.core.util.JSONType,
  ) {
    super(message);
    this.name = "CommandError";
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
        details: this.details,
        retryable: this.retryable,
      },
      status: this.status,
    };
  }
}

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

const requestJson = async (
  connection: CommandConnection,
  path: string,
  body?: z.core.util.JSONType,
): Promise<CommandResponse> => {
  let result: CommandResponse | undefined;
  const { error } = await betterFetch<z.core.util.JSONType>(path, {
    baseURL: connection.origin,
    method: body === undefined ? "GET" : "POST",
    body,
    auth: { type: "Bearer", token: connection.token },
    headers: { Accept: "application/json", "User-Agent": cliUserAgent },
    redirect: "error",
    jsonParser: (text) => credentialSafeJson(text, [connection.token]),
    onSuccess: ({ data, response }) => {
      result = { status: response.status, data };
    },
  });
  if (result) return result;
  if (!error) throw new CommandError("INVALID_RESPONSE", "The API returned no command result.");
  const failure = errorSchema.safeParse(error);
  if (failure.success) {
    throw new CommandError(
      failure.data.error.code,
      failure.data.error.message,
      error.status,
      failure.data.error.details,
    );
  }
  throw new CommandError(
    "HTTP_ERROR",
    `The API returned HTTP ${error.status} without a command error.`,
    error.status,
  );
};

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
  command?: string,
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
  if (command !== undefined && !ids.has(command)) {
    throw new CommandError(
      "UNKNOWN_COMMAND",
      "This operation is not advertised by the configured API. Use devboxes commands to discover available operations.",
    );
  }
  return {
    openapi: document.data.openapi,
    commands: commands.filter(
      (operation) => command === undefined || operation.operationId === command,
    ),
    components: document.data.components ?? {},
  };
};

export const invokeCommand = async (
  connection: CommandConnection,
  invocation: { command: string; input: z.core.util.JSONType },
): Promise<CommandResponse> => {
  const description = await describeCommands(connection, invocation.command);
  const operation = description.commands[0];
  if (!operation) throw new CommandError("UNKNOWN_COMMAND", "The command is unavailable.");
  return requestJson(connection, operation.path, invocation.input);
};
