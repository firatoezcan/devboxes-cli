import { URLPattern } from "node:url";

import type { BetterFetchOption } from "@better-fetch/fetch";
import { isCancel, password as passwordPrompt, select, text } from "@clack/prompts";
import { writeConfig } from "./connections/config";
import { createAuthClient } from "better-auth/client";
import { Option, type Command } from "commander";
import { CookieJar } from "tough-cookie";
import { z } from "zod";

import { cliUserAgent } from "./api";
import {
  apiOrigin,
  CommandError,
  credentialSafeJson,
  failureSchema,
  invocationTrace,
  readCommandInput,
} from "./commands";
import { loadAccountContext, type AccountContext } from "./connection";

const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  emailVerified: z.boolean(),
});
const authenticationSchema = z.object({ token: z.string().min(1).nullable(), user: userSchema });
const submittedSecretSchema = z.string();
const ownSessionSelectionSchema = z.strictObject({
  id: z.string().min(1).meta({ description: "The session id that /list-sessions returns" }),
});
const userSessionSelectionSchema = z.strictObject({
  userId: z.string().min(1).meta({ description: "The user whose session is revoked" }),
  id: z
    .string()
    .min(1)
    .meta({ description: "The session id that /admin/list-user-sessions returns" }),
});
const sessionSelectionSchemas = new Map<string, z.ZodType>([
  ["/revoke-session", ownSessionSelectionSchema],
  ["/admin/revoke-user-session", userSessionSelectionSchema],
]);
const authenticationFailureSchema = z
  .union([
    failureSchema,
    z.object({ error: z.string(), error_description: z.string() }).transform((failure) => ({
      code: failure.error,
      message: failure.error_description,
    })),
  ])
  .pipe(failureSchema);

const signInMethods: { method: "github" | "vercel" | "email"; flag: string; label: string }[] = [
  { method: "github", flag: "--github", label: "GitHub" },
  { method: "vercel", flag: "--vercel", label: "Vercel" },
  { method: "email", flag: "--email <email>", label: "Email and password" },
];
const deviceClientId = "devboxes-cli";

type AccountOptions = {
  api?: string;
  config?: string;
  github?: boolean;
  vercel?: boolean;
  email?: string;
  name?: string;
  passwordStdin?: boolean;
  json?: boolean;
};

const promptText = async (message: string) => {
  const entered = await text({
    message,
    output: process.stderr,
    validate: (value) => (value?.trim() ? undefined : `${message} is required.`),
  });
  if (isCancel(entered)) throw new CommandError("CANCELLED", "Authentication cancelled.");
  return entered.trim();
};

const authenticationResponse = async (
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
  const commandTrace = invocationTrace();
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
        commandTrace.inject(headers);
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
  return {
    failure: new CommandError(
      failure.success ? failure.data.code : "HTTP_ERROR",
      failure.success ? failure.data.message : `Authentication returned HTTP ${error.status}.`,
      { status: error.status, details: failure.success ? failure.data.details : undefined },
    ),
  };
};

const requestAuthentication = async (...request: Parameters<typeof authenticationResponse>) => {
  const response = await authenticationResponse(...request);
  if ("failure" in response) throw response.failure;
  return response;
};

export const addAuthenticationCommands = (program: Command) => {
  for (const action of ["signup", "login"] as const) {
    const command = program
      .command(action)
      .description(
        action === "signup"
          ? "create an account with GitHub, Vercel, or email and password"
          : "sign in with GitHub, Vercel, or email and password",
      )
      .addOption(
        new Option("--github", "Continue with GitHub in a browser").conflicts([
          "vercel",
          "email",
          "name",
          "passwordStdin",
        ]),
      )
      .addOption(
        new Option("--vercel", "Continue with Vercel in a browser").conflicts([
          "email",
          "name",
          "passwordStdin",
        ]),
      )
      .option("--email <email>", "Use email and password with this account email")
      .option("--password-stdin", "Read the password from stdin instead of a masked prompt");
    if (action === "signup") command.option("--name <name>", "Display name for an email account");
    command.action(async () => {
      const options = command.optsWithGlobals<AccountOptions>();
      if (process.env.DEVBOXES_TOKEN !== undefined) {
        throw new CommandError(
          "SCOPED_AUTHENTICATION",
          "Account login cannot replace a scoped connection. Remove DEVBOXES_TOKEN before signing in to a local account.",
        );
      }
      const interactive = !options.json && process.stdin.isTTY && process.stderr.isTTY;
      let choice = signInMethods.find((entry) =>
        entry.method === "email" ? options.email !== undefined : options[entry.method],
      );
      const context = await loadAccountContext(options);
      if (!choice) {
        if (!interactive) {
          throw new CommandError(
            "SIGN_IN_METHOD_REQUIRED",
            "Choose a sign-in method: --github, --vercel, or --email <email>.",
            { details: { methods: signInMethods.map(({ method, flag }) => ({ method, flag })) } },
          );
        }
        const selected = await select({
          message: action === "signup" ? "Create your account with" : "Sign in with",
          options: signInMethods.map((entry) => ({ value: entry, label: entry.label })),
          output: process.stderr,
        });
        if (isCancel(selected)) throw new CommandError("CANCELLED", "Authentication cancelled.");
        choice = selected;
      }
      const report = async (user: z.infer<typeof userSchema>, signedIn: boolean) => {
        await Bun.write(
          Bun.stdout,
          `${
            options.json
              ? JSON.stringify({ user, signedIn })
              : [
                  signedIn ? `Signed in as ${user.email}.` : `Account created for ${user.email}.`,
                  ...(action === "signup" && !user.emailVerified
                    ? [`Open the verification link sent to ${user.email}.`]
                    : []),
                ].join(" ")
          }\n`,
        );
      };

      if (choice.method !== "email") {
        const device = z
          .object({
            device_code: z.string().min(1),
            user_code: z.string().min(1),
            verification_uri_complete: z.url({ protocol: /^https?$/ }),
            expires_in: z.number(),
            interval: z.number(),
          })
          .safeParse(
            (
              await requestAuthentication(context, "/device/code", {
                method: "POST",
                body: { client_id: deviceClientId },
              })
            ).data,
          );
        if (!device.success) {
          throw new CommandError(
            "INVALID_AUTH_RESPONSE",
            "Device authorization did not return its codes and an HTTP verification URL.",
          );
        }
        const verification = new URL(device.data.verification_uri_complete);
        verification.searchParams.set("provider", choice.method);
        process.stderr.write(
          `${
            options.json
              ? JSON.stringify({
                  verification: {
                    url: verification.href,
                    userCode: device.data.user_code,
                    expiresIn: device.data.expires_in,
                  },
                })
              : `Open ${verification.href} to continue with ${choice.label}.\nConfirm that the page shows code ${device.data.user_code}. Waiting for approval...`
          }\n`,
        );
        if (interactive) {
          try {
            Bun.spawn(
              process.platform === "darwin"
                ? ["open", verification.href]
                : process.platform === "win32"
                  ? ["rundll32", "url.dll,FileProtocolHandler", verification.href]
                  : ["xdg-open", verification.href],
              { stdio: ["ignore", "ignore", "ignore"] },
            ).unref();
          } catch {
            process.stderr.write("Open the URL above in a browser.\n");
          }
        }
        const expiresAt = Date.now() + device.data.expires_in * 1000;
        let interval = device.data.interval;
        let wait = interval;
        let accessToken: string | undefined;
        while (!accessToken) {
          if (Date.now() >= expiresAt) {
            throw new CommandError(
              "expired_token",
              "The device code expired before the sign-in was approved.",
            );
          }
          await Bun.sleep(wait * 1000);
          let granted: Awaited<ReturnType<typeof authenticationResponse>> | null = null;
          try {
            granted = await authenticationResponse(
              context,
              "/device/token",
              {
                method: "POST",
                body: {
                  grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                  device_code: device.data.device_code,
                  client_id: deviceClientId,
                },
              },
              false,
            );
          } catch (error) {
            if (!(error instanceof TypeError && "code" in error)) throw error;
          }
          if (granted && !("failure" in granted)) {
            accessToken = z
              .object({ access_token: z.string().min(1) })
              .parse(granted.data).access_token;
          } else if (granted?.failure.code === "slow_down") {
            interval += 5;
            wait = interval;
          } else if (granted?.failure.code === "authorization_pending") {
            wait = interval;
          } else if (!granted || (granted.failure.options.status ?? 0) >= 500) {
            wait = Math.min(Math.max(wait * 2, 1), 60);
          } else {
            throw granted.failure;
          }
        }
        delete context.config.cookieJar;
        context.config.sessionToken = accessToken;
        await writeConfig(context);
        const session = z
          .object({ user: userSchema })
          .parse((await requestAuthentication(context, "/get-session")).data);
        await report(session.user, true);
        return;
      }

      let email = options.email;
      let name = options.name;
      if (interactive) {
        email ??= await promptText("Email");
        if (action === "signup") name ??= await promptText("Name");
      }
      if (!email || (action === "signup" && !name)) {
        throw new CommandError(
          "INVALID_USAGE",
          action === "signup"
            ? "Email signup requires --email <email> and --name <name>."
            : "Email login requires --email <email>.",
        );
      }
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
      let response = await requestAuthentication(
        context,
        action === "signup" ? "/sign-up/email" : "/sign-in/email",
        { method: "POST", body: { email, password, name } },
      );
      const challenge = z
        .object({ twoFactorRedirect: z.literal(true), twoFactorMethods: z.array(z.string()) })
        .safeParse(response.data);
      if (challenge.success) {
        delete context.config.sessionToken;
        await writeConfig(context);
        if (!interactive) {
          await Bun.write(
            Bun.stdout,
            `${
              options.json
                ? JSON.stringify({
                    signedIn: false,
                    twoFactorRequired: true,
                    twoFactorMethods: challenge.data.twoFactorMethods,
                  })
                : 'Two-factor verification is required. Pipe {"code":"<authenticator code>"} into devboxes auth /two-factor/verify-totp --input -, or {"code":"<backup code>"} into devboxes auth /two-factor/verify-backup-code --input -.'
            }\n`,
          );
          return;
        }
        const code = (await promptText("Authenticator code or backup code")).replace(/\s/g, "");
        response = await requestAuthentication(
          context,
          /^\d{6}$/.test(code) ? "/two-factor/verify-totp" : "/two-factor/verify-backup-code",
          { method: "POST", body: { code } },
        );
      }
      const parsed = authenticationSchema.safeParse(response.data);
      if (!parsed.success)
        throw new CommandError(
          "INVALID_AUTH_RESPONSE",
          "Authentication did not return the expected user and session contract.",
          { status: response.status },
        );
      await report(parsed.data.user, parsed.data.token !== null);
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
        { status: error.status },
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
    const context = await loadAccountContext(options);
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
        if (!operation.success) continue;
        const selection = sessionSelectionSchemas.get(path);
        operations.push({
          schema: selection
            ? {
                ...operation.data,
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: z.toJSONSchema(selection, { target: "openapi-3.0" }),
                    },
                  },
                },
              }
            : operation.data,
          path,
          method,
        });
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
      const selection = ownSessionSelectionSchema.safeParse(input.data);
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
    if (operation.path === "/admin/revoke-user-session") {
      const selection = userSessionSelectionSchema.safeParse(input.data);
      if (!selection.success)
        throw new CommandError(
          "INVALID_INPUT",
          "Select the session to revoke by its userId and the id that /admin/list-user-sessions returns.",
        );
      const listed = await requestAuthentication(
        context,
        "/admin/list-user-sessions",
        { method: "POST", body: { userId: selection.data.userId } },
        false,
      );
      const sessionToken = z
        .object({ sessions: z.array(z.object({ id: z.string(), token: z.string() })) })
        .parse(listed.data)
        .sessions.find((listedSession) => listedSession.id === selection.data.id)?.token;
      if (!sessionToken)
        throw new CommandError("SESSION_NOT_FOUND", "No session of this user has that id.");
      input.data = { sessionToken };
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
