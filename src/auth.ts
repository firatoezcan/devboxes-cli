import { URLPattern } from "node:url";

import type { BetterFetchOption } from "@better-fetch/fetch";
import { isCancel, password as passwordPrompt } from "@clack/prompts";
import { writeConfig } from "@firops/connections/local/config";
import { createAuthClient } from "better-auth/client";
import type { Command } from "commander";
import { CookieJar } from "tough-cookie";
import { z } from "zod";

import { cliUserAgent } from "./api";
import {
  apiOrigin,
  CommandError,
  credentialSafeJson,
  failureSchema,
  readCommandInput,
} from "./commands";
import { loadAccountContext, type AccountContext } from "./connection";

const authenticationSchema = z.object({
  token: z.string().min(1).nullable(),
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    emailVerified: z.boolean(),
  }),
});
const submittedSecretSchema = z.string();
const authenticationFailureSchema = z
  .union([
    failureSchema,
    z.object({ error: z.string(), error_description: z.string() }).transform((failure) => ({
      code: failure.error,
      message: failure.error_description,
    })),
  ])
  .pipe(failureSchema);

type AccountOptions = {
  api?: string;
  config?: string;
  email: string;
  name?: string;
  passwordStdin?: boolean;
  json?: boolean;
};

const requestAuthentication = async (
  context: AccountContext,
  path: string,
  options: Pick<
    BetterFetchOption<
      Record<string, z.core.util.JSONType | undefined>,
      Record<string, string | number | boolean>,
      Record<string, string>
    >,
    "body" | "method" | "params" | "query"
  > = {},
  redactResponse = true,
) => {
  const origin = apiOrigin(context.config.apiBaseUrl);
  const endpoint = new URLPattern({ baseURL: origin, pathname: `/api/auth${path}` });
  const cookies = context.config.cookieJar
    ? CookieJar.deserializeSync(context.config.cookieJar)
    : new CookieJar();
  const secrets = [context.config.sessionToken];
  let result: { status: number; data: unknown } | undefined;
  const client = createAuthClient({
    baseURL: origin,
    disableDefaultFetchPlugins: true,
    fetchOptions: {
      auth: { type: "Bearer", token: context.config.sessionToken },
      headers: { "User-Agent": cliUserAgent, Origin: origin },
      redirect: "error",
      jsonParser: redactResponse ? (text) => credentialSafeJson(text, secrets, true) : JSON.parse,
      onRequest: ({ url, headers }) => {
        if (new URL(url).origin !== origin || !endpoint.test(String(url))) {
          throw new CommandError(
            "INVALID_AUTH_ENDPOINT",
            "The authentication endpoint escaped its advertised route.",
          );
        }
        const cookie = cookies.getCookieStringSync(String(url));
        if (cookie) headers.set("Cookie", cookie);
      },
      onResponse: async ({ response, request }) => {
        const setCookies = response.headers.getSetCookie();
        for (const header of setCookies) cookies.setCookieSync(header, String(request.url));
        secrets.push(...cookies.getCookiesSync(String(request.url)).map((cookie) => cookie.value));
        if (!response.ok) {
          for (const value of Object.values(options.body ?? options.query ?? {})) {
            const secret = submittedSecretSchema.safeParse(value);
            if (secret.success) secrets.push(secret.data);
          }
        }
        const sessionToken = response.headers.get("set-auth-token");
        if (sessionToken) {
          context.config.sessionToken = sessionToken;
          secrets.push(sessionToken);
        }
        if (setCookies.length || sessionToken) {
          context.config.cookieJar = JSON.stringify(cookies);
          await writeConfig(context);
        }
      },
      onSuccess: ({ data, response }) => {
        result = { status: response.status, data };
      },
    },
  });
  const { error } = await client.$fetch<unknown>(path, options);
  if (result) return result;
  if (!error) throw new CommandError("INVALID_AUTH_RESPONSE", "Authentication returned no result.");
  const failure = authenticationFailureSchema.safeParse(error);
  throw new CommandError(
    failure.success ? failure.data.code : "HTTP_ERROR",
    failure.success ? failure.data.message : `Authentication returned HTTP ${error.status}.`,
    error.status,
    failure.success ? failure.data.details : undefined,
  );
};

export const addAuthenticationCommands = (program: Command) => {
  for (const action of ["signup", "login"] as const) {
    const command = program
      .command(action)
      .description(
        action === "signup"
          ? "create an account with email and password"
          : "sign in with email and password",
      )
      .requiredOption("--email <email>", "Account email")
      .option("--password-stdin", "Read the password from stdin instead of a masked prompt");
    if (action === "signup") command.requiredOption("--name <name>", "Display name");
    command.action(async () => {
      const options = command.optsWithGlobals<AccountOptions>();
      if (process.env.DEVBOXES_TOKEN !== undefined) {
        throw new CommandError(
          "SCOPED_AUTHENTICATION",
          "Account login cannot replace a scoped connection. Remove DEVBOXES_TOKEN before signing in to a local account.",
        );
      }
      const api = options.api ?? process.env.DEVBOXES_API_URL;
      const context = await loadAccountContext({ config: options.config, api });
      let password: string;
      if (options.passwordStdin) {
        if (process.stdin.isTTY) {
          throw new CommandError(
            "PASSWORD_INPUT_REQUIRED",
            "Pipe the password into --password-stdin, or omit that flag to use a masked prompt.",
          );
        }
        password = (await Bun.stdin.text()).replace(/\r?\n$/, "");
      } else {
        if (!process.stdin.isTTY || !process.stderr.isTTY) {
          throw new CommandError(
            "PASSWORD_INPUT_REQUIRED",
            "Use --password-stdin when no interactive terminal is available.",
          );
        }
        const entered = await passwordPrompt({ message: "Password", output: process.stderr });
        if (isCancel(entered)) throw new CommandError("CANCELLED", "Authentication cancelled.");
        password = entered;
      }
      if (!password)
        throw new CommandError("PASSWORD_INPUT_REQUIRED", "The password must not be empty.");
      const response = await requestAuthentication(
        context,
        action === "signup" ? "/sign-up/email" : "/sign-in/email",
        {
          method: "POST",
          body: {
            email: options.email,
            password,
            name: action === "signup" ? options.name : undefined,
          },
        },
      );
      if (z.object({ twoFactorRedirect: z.literal(true) }).safeParse(response.data).success) {
        delete context.config.sessionToken;
        await writeConfig(context);
        await Bun.write(
          Bun.stdout,
          `${
            options.json
              ? JSON.stringify({ signedIn: false, twoFactorRequired: true })
              : "Two-factor verification is required. Use devboxes auth to discover the verification operations."
          }\n`,
        );
        return;
      }
      const parsed = authenticationSchema.safeParse(response.data);
      if (!parsed.success)
        throw new CommandError(
          "INVALID_AUTH_RESPONSE",
          "Authentication did not return the expected user and session contract.",
          response.status,
        );
      const result = { user: parsed.data.user, signedIn: parsed.data.token !== null };
      if (options.json) {
        await Bun.write(Bun.stdout, `${JSON.stringify(result)}\n`);
      } else {
        await Bun.write(
          Bun.stdout,
          `${
            result.signedIn
              ? `Signed in as ${result.user.email}.`
              : `Account created for ${result.user.email}. Complete email verification before signing in.`
          }\n`,
        );
      }
    });
  }

  const logout = program
    .command("logout")
    .description("revoke the current session and remove its saved credential");
  logout.action(async () => {
    const options = logout.optsWithGlobals<{ config?: string; api?: string; json?: boolean }>();
    if (process.env.DEVBOXES_TOKEN !== undefined) {
      throw new CommandError(
        "SCOPED_AUTHENTICATION",
        "Logout revokes a saved account session. Revoke a scoped delegation with delegations.revoke.",
      );
    }
    const context = await loadAccountContext(options);
    const token = context.config.sessionToken;
    if (!token) {
      throw new CommandError("AUTHENTICATION_REQUIRED", "No saved account session to revoke.");
    }
    const { error } = await createAuthClient({
      baseURL: apiOrigin(context.config.apiBaseUrl),
      disableDefaultFetchPlugins: true,
      fetchOptions: {
        auth: { type: "Bearer", token },
        redirect: "error",
      },
    }).$fetch("/sign-out", { method: "POST", body: {} });
    if (error && error.status !== 401) {
      throw new CommandError(
        "SIGN_OUT_FAILED",
        `Sign-out returned HTTP ${error.status}. The saved credential was retained.`,
        error.status,
      );
    }
    delete context.config.cookieJar;
    delete context.config.sessionToken;
    await writeConfig(context);
    await Bun.write(
      Bun.stdout,
      `${
        options.json
          ? JSON.stringify({ signedOut: true })
          : "Signed out. The session has been revoked."
      }\n`,
    );
  });

  const nativeAuth = program
    .command("auth")
    .description("discover or invoke the installed Better Auth account and security operations")
    .argument("[path]", "Native authentication endpoint path; omit to list its generated schema")
    .option("--method <method>", "GET or POST when an endpoint supports both")
    .option("--input <source>", "Invoke with JSON from @file or - for stdin; omit to describe");
  nativeAuth.action(async (endpoint?: string) => {
    if (process.env.DEVBOXES_TOKEN !== undefined) {
      throw new CommandError(
        "SCOPED_AUTHENTICATION",
        "Scoped connections cannot manage a personal account.",
      );
    }
    const options = nativeAuth.optsWithGlobals<{
      api?: string;
      config?: string;
      json?: boolean;
      input?: string;
      method?: string;
    }>();
    const context = await loadAccountContext({
      ...options,
      api: options.api ?? process.env.DEVBOXES_API_URL,
    });
    const response = await requestAuthentication(context, "/open-api/generate-schema");
    const document = z
      .object({
        paths: z.record(z.string(), z.record(z.string(), z.unknown())),
        components: z.unknown().optional(),
      })
      .parse(response.data);
    const operations = [];
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, schema] of Object.entries(methods)) {
        if (method !== "get" && method !== "post") continue;
        const operation = z.record(z.string(), z.unknown()).safeParse(schema);
        if (operation.success) operations.push({ schema: operation.data, path, method });
      }
    }
    if (!endpoint) {
      await Bun.write(
        Bun.stdout,
        `${JSON.stringify(
          { operations, components: document.components },
          null,
          options.json ? undefined : 2,
        )}\n`,
      );
      return;
    }
    const matches = operations.filter(
      (entry) =>
        entry.path === endpoint &&
        (!options.method || entry.method === options.method.toLowerCase()),
    );
    const [operation] = matches;
    if (!operation)
      throw new CommandError(
        "UNKNOWN_AUTH_OPERATION",
        "The installed authentication owner does not advertise this endpoint and method.",
      );
    if (matches.length > 1)
      throw new CommandError(
        "AUTH_METHOD_REQUIRED",
        "This endpoint accepts GET and POST. Select one with --method.",
      );
    if (!options.input) {
      await Bun.write(
        Bun.stdout,
        `${JSON.stringify(
          { operation, components: document.components },
          null,
          options.json ? undefined : 2,
        )}\n`,
      );
      return;
    }
    const input = z.record(z.string(), z.json()).safeParse(await readCommandInput(options.input));
    if (!input.success)
      throw new CommandError("INVALID_INPUT", "Authentication input must be a JSON object.");
    if (operation.path === "/revoke-session") {
      const selection = z.strictObject({ id: z.string().min(1) }).safeParse(input.data);
      if (!selection.success)
        throw new CommandError(
          "INVALID_INPUT",
          "Select the session to revoke by the id that /list-sessions returns.",
        );
      const listed = await requestAuthentication(context, "/list-sessions", {}, false);
      const token = z
        .array(z.object({ id: z.string(), token: z.string() }))
        .parse(listed.data)
        .find((listedSession) => listedSession.id === selection.data.id)?.token;
      if (!token)
        throw new CommandError(
          "SESSION_NOT_FOUND",
          "No active session of this account has that id.",
        );
      input.data = { token };
    }
    if (
      !operation.path.startsWith("/") ||
      operation.path.startsWith("//") ||
      operation.path.includes("..") ||
      operation.path.includes("?") ||
      operation.path.includes("#")
    ) {
      throw new CommandError(
        "INVALID_DISCOVERY",
        "The authentication owner advertised an invalid endpoint path.",
      );
    }
    const params: Record<string, string> = {};
    const path = operation.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
      const value = z.string().min(1).safeParse(input.data[name]);
      if (!value.success) {
        throw new CommandError(
          "INVALID_INPUT",
          `Authentication input requires path parameter ${name}.`,
        );
      }
      delete input.data[name];
      params[name] = value.data;
      return `:${name}`;
    });
    const query =
      operation.method === "get"
        ? z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).safeParse(input.data)
        : undefined;
    if (query && !query.success)
      throw new CommandError(
        "INVALID_INPUT",
        "GET authentication input accepts string, number, and boolean query values.",
      );
    const result = await requestAuthentication(context, path, {
      method: operation.method.toUpperCase(),
      params,
      body: operation.method === "post" ? input.data : undefined,
      query: query?.data,
    });
    const authentication = authenticationSchema.safeParse(result.data);
    await Bun.write(
      Bun.stdout,
      `${JSON.stringify(
        {
          status: result.status,
          data: authentication.success
            ? { user: authentication.data.user, signedIn: authentication.data.token !== null }
            : result.data,
        },
        null,
        options.json ? undefined : 2,
      )}\n`,
    );
  });
};
