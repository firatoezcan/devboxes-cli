import { URLPattern } from "node:url";

import type { BetterFetchOption } from "@better-fetch/fetch";
import { isCancel, password as passwordPrompt, select, text } from "@clack/prompts";
import { writeConfig } from "@firops/connections/local/config";
import { JsonValueSchema } from "@firops/platform/protocol/provider-auth";
import { describeErrors } from "@firops/platform/values/validation-errors";
import { createAuthClient } from "better-auth/client";
import { Option, type Command } from "commander";
import { CookieJar } from "tough-cookie";
import Type, { type Static, type TObject } from "typebox";
import Value from "typebox/value";

import { cliUserAgent } from "./api";
import {
  apiOrigin,
  CommandError,
  credentialSafeJson,
  failureSchema,
  injectCallerTrace,
  openInBrowser,
  parseResponse,
  readCommandInput,
  writeOutput,
} from "./commands";
import { loadAccountContext, type AccountContext } from "./connection";

const userSchema = Type.Object({
  id: Type.String(),
  email: Type.String(),
  name: Type.String(),
  emailVerified: Type.Boolean(),
});
const authenticationSchema = Type.Object({
  token: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  user: userSchema,
});
const ownSessionSelectionSchema = Type.Object(
  { id: Type.String({ minLength: 1, description: "The session id that /list-sessions returns" }) },
  { additionalProperties: false },
);
const userSessionSelectionSchema = Type.Object(
  {
    userId: Type.String({ minLength: 1, description: "The user whose session is revoked" }),
    id: Type.String({
      minLength: 1,
      description: "The session id that /admin/list-user-sessions returns",
    }),
  },
  { additionalProperties: false },
);
const sessionSelectionSchemas = new Map<string, TObject>([
  ["/revoke-session", ownSessionSelectionSchema],
  ["/admin/revoke-user-session", userSessionSelectionSchema],
]);
const oauthFailureSchema = Type.Object({ error: Type.String(), error_description: Type.String() });
const listedSessionSchema = Type.Object({ id: Type.String(), token: Type.String() });

const signInMethods: { method: "github" | "email" | "password"; flag: string; label: string }[] = [
  { method: "github", flag: "--github", label: "GitHub" },
  { method: "email", flag: "--email <email>", label: "Email code" },
  { method: "password", flag: "--email <email> --password-stdin", label: "Email and password" },
];
const deviceClientId = "devboxes-cli";

type AccountOptions = {
  api?: string;
  config?: string;
  github?: boolean;
  email?: string;
  name?: string;
  codeStdin?: boolean;
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
      Record<string, Static<typeof JsonValueSchema> | undefined>,
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
  let result: { status: number; data: Static<typeof JsonValueSchema> } | undefined;
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
        injectCallerTrace(headers);
      },
      onResponse: async ({ response, request }) => {
        const setCookies = response.headers.getSetCookie();
        for (const header of setCookies) cookies.setCookieSync(header, String(request.url));
        secrets.push(...cookies.getCookiesSync(String(request.url)).map((cookie) => cookie.value));
        if (!response.ok) {
          for (const value of Object.values(options.body ?? options.query ?? {})) {
            if (Value.Check(Type.String(), value)) secrets.push(value);
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
  const failure = Value.Check(failureSchema, error)
    ? error
    : Value.Check(oauthFailureSchema, error)
      ? { code: error.error, message: error.error_description, details: undefined }
      : undefined;
  return {
    failure: new CommandError(
      failure?.code ?? "HTTP_ERROR",
      failure?.message ?? `Authentication returned HTTP ${error.status}.`,
      { status: error.status, details: failure?.details },
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
          ? "create an account with GitHub or a code sent to your email"
          : "sign in with GitHub, a code sent to your email, or your password",
      )
      .addOption(
        new Option("--github", "Continue with GitHub in a browser").conflicts([
          "email",
          "name",
          "codeStdin",
          "passwordStdin",
        ]),
      )
      .option("--email <email>", "Sign in with this email address, by default with an emailed code")
      .option("--code-stdin", "Read the emailed code from stdin and finish the sign-in");
    if (action === "signup") command.option("--name <name>", "Display name for an email account");
    else
      command.addOption(
        new Option(
          "--password-stdin",
          "Sign in with the account password from stdin instead of a code",
        ).conflicts("codeStdin"),
      );
    const methods =
      action === "signup"
        ? signInMethods.filter((entry) => entry.method !== "password")
        : signInMethods;
    command.action(async () => {
      const options = command.optsWithGlobals<AccountOptions>();
      if (process.env.DEVBOXES_TOKEN !== undefined) {
        throw new CommandError(
          "SCOPED_AUTHENTICATION",
          "Account login cannot replace a scoped connection. Remove DEVBOXES_TOKEN before signing in to a local account.",
        );
      }
      const interactive = !options.json && process.stdin.isTTY && process.stderr.isTTY;
      let choice = methods.find((entry) =>
        entry.method === "github"
          ? options.github
          : options.email !== undefined &&
            (entry.method === "password") === !!options.passwordStdin,
      );
      const context = await loadAccountContext(options);
      if (!choice) {
        if (!interactive) {
          throw new CommandError(
            "SIGN_IN_METHOD_REQUIRED",
            "Choose a sign-in method: --github or --email <email>.",
            { details: { methods: methods.map(({ method, flag }) => ({ method, flag })) } },
          );
        }
        const selected = await select({
          message: action === "signup" ? "Create your account with" : "Sign in with",
          options: methods.map((entry) => ({ value: entry, label: entry.label })),
          output: process.stderr,
        });
        if (isCancel(selected)) throw new CommandError("CANCELLED", "Authentication cancelled.");
        choice = selected;
      }
      const report = async (user: Static<typeof userSchema>) => {
        await writeOutput(
          `${
            options.json
              ? JSON.stringify({ user: Value.Clean(userSchema, user), signedIn: true })
              : `Signed in as ${user.email}.`
          }\n`,
        );
      };

      if (choice.method === "github") {
        const device = (
          await requestAuthentication(context, "/device/code", {
            method: "POST",
            body: { client_id: deviceClientId },
          })
        ).data;
        const deviceCodeSchema = Type.Object({
          device_code: Type.String({ minLength: 1 }),
          user_code: Type.String({ minLength: 1 }),
          verification_uri_complete: Type.String(),
          expires_in: Type.Number(),
          interval: Type.Number(),
        });
        if (!Value.Check(deviceCodeSchema, device)) {
          throw new CommandError(
            "INVALID_AUTH_RESPONSE",
            `Device authorization did not return its codes and an HTTP verification URL: ${describeErrors(deviceCodeSchema, device)}.`,
          );
        }
        const verification = URL.parse(device.verification_uri_complete);
        if (!verification || !["http:", "https:"].includes(verification.protocol)) {
          throw new CommandError(
            "INVALID_AUTH_RESPONSE",
            "Device authorization did not return its codes and an HTTP verification URL: /verification_uri_complete must be an HTTP URL.",
          );
        }
        verification.searchParams.set("provider", choice.method);
        process.stderr.write(
          `${
            options.json
              ? JSON.stringify({
                  verification: {
                    url: verification.href,
                    userCode: device.user_code,
                    expiresIn: device.expires_in,
                  },
                })
              : `Open ${verification.href} to continue with ${choice.label}.\nConfirm that the page shows code ${device.user_code}. Waiting for approval...`
          }\n`,
        );
        if (interactive) openInBrowser(verification.href);
        const expiresAt = Date.now() + device.expires_in * 1000;
        let interval = device.interval;
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
                  device_code: device.device_code,
                  client_id: deviceClientId,
                },
              },
              false,
            );
          } catch (error) {
            if (!(error instanceof TypeError && "code" in error)) throw error;
          }
          if (granted && !("failure" in granted)) {
            accessToken = parseResponse(
              Type.Object({ access_token: Type.String({ minLength: 1 }) }),
              granted.data,
              "/device/token",
            ).access_token;
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
        const session = parseResponse(
          Type.Object({ user: userSchema }),
          (await requestAuthentication(context, "/get-session")).data,
          "/get-session",
        );
        await report(session.user);
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
      if (choice.method === "password") {
        let password: string;
        if (options.passwordStdin) {
          if (process.stdin.isTTY) {
            throw new CommandError(
              "PASSWORD_INPUT_REQUIRED",
              "Pipe the password into --password-stdin, or run devboxes login without flags and choose email and password.",
            );
          }
          password = (await Bun.stdin.text()).replace(/\r?\n$/, "");
        } else {
          const entered = await passwordPrompt({ message: "Password", output: process.stderr });
          if (isCancel(entered)) throw new CommandError("CANCELLED", "Authentication cancelled.");
          password = entered;
        }
        if (!password)
          throw new CommandError("PASSWORD_INPUT_REQUIRED", "The password must not be empty.");
        const signedIn = await authenticationResponse(context, "/sign-in/email", {
          method: "POST",
          body: { email, password },
        });
        if ("failure" in signedIn) {
          if (signedIn.failure.code !== "EMAIL_NOT_VERIFIED") throw signedIn.failure;
          throw new CommandError(
            "EMAIL_NOT_VERIFIED",
            `${email} is not verified yet. Sign in with the code devboxes emails you: devboxes login --email ${email}. That sign-in removes the password, which you then set again through the reset email.`,
            signedIn.failure.options,
          );
        }
        let response = signedIn;
        const challenge = response.data;
        if (
          Value.Check(
            Type.Object({
              twoFactorRedirect: Type.Literal(true),
              twoFactorMethods: Type.Array(Type.String()),
            }),
            challenge,
          )
        ) {
          delete context.config.sessionToken;
          await writeConfig(context);
          if (!interactive) {
            await writeOutput(
              `${
                options.json
                  ? JSON.stringify({
                      signedIn: false,
                      twoFactorRequired: true,
                      twoFactorMethods: challenge.twoFactorMethods,
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
        await report(parseResponse(authenticationSchema, response.data, "/sign-in/email").user);
        return;
      }
      if (options.codeStdin && process.stdin.isTTY) {
        throw new CommandError("CODE_INPUT_REQUIRED", "Pipe the emailed code into --code-stdin.");
      }
      if (!options.codeStdin) {
        await requestAuthentication(context, "/email-otp/send-verification-otp", {
          method: "POST",
          body: { email, type: "sign-in" },
        });
        if (!interactive) {
          await writeOutput(
            `${
              options.json
                ? JSON.stringify({ signedIn: false, codeSent: true })
                : `devboxes sent a sign-in code to ${email}. Pipe it into the same command with --code-stdin.`
            }\n`,
          );
          return;
        }
      }
      const code = options.codeStdin
        ? (await Bun.stdin.text()).trim()
        : await promptText(`Code sent to ${email}`);
      const authenticated = parseResponse(
        authenticationSchema,
        (
          await requestAuthentication(context, "/sign-in/email-otp", {
            method: "POST",
            body: { email, otp: code, name },
          })
        ).data,
        "/sign-in/email-otp",
      );
      await report(authenticated.user);
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
    await writeOutput(
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
    const document = parseResponse(
      Type.Object({
        paths: Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown())),
        components: Type.Optional(Type.Unknown()),
      }),
      response.data,
      "/open-api/generate-schema",
    );
    const operations = [];
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, schema] of Object.entries(methods)) {
        if (method !== "get" && method !== "post") continue;
        if (!Value.Check(Type.Record(Type.String(), Type.Unknown()), schema)) continue;
        const selection = sessionSelectionSchemas.get(path);
        operations.push({
          schema: selection
            ? {
                ...schema,
                requestBody: {
                  required: true,
                  content: { "application/json": { schema: selection } },
                },
              }
            : schema,
          path,
          method,
        });
      }
    }
    if (!endpoint) {
      await writeOutput(
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
      await writeOutput(
        `${JSON.stringify(
          { operation, components: document.components },
          null,
          options.json ? undefined : 2,
        )}\n`,
      );
      return;
    }
    const submitted = await readCommandInput(options.input);
    if (!Value.Check(Type.Record(Type.String(), JsonValueSchema), submitted))
      throw new CommandError("INVALID_INPUT", "Authentication input must be a JSON object.");
    let input = submitted;
    if (operation.path === "/revoke-session") {
      if (!Value.Check(ownSessionSelectionSchema, submitted))
        throw new CommandError(
          "INVALID_INPUT",
          "Select the session to revoke by the id that /list-sessions returns.",
        );
      const listed = await requestAuthentication(context, "/list-sessions", {}, false);
      const token = parseResponse(
        Type.Array(listedSessionSchema),
        listed.data,
        "/list-sessions",
      ).find((listedSession) => listedSession.id === submitted.id)?.token;
      if (!token)
        throw new CommandError(
          "SESSION_NOT_FOUND",
          "No active session of this account has that id.",
        );
      input = { token };
    }
    if (operation.path === "/admin/revoke-user-session") {
      if (!Value.Check(userSessionSelectionSchema, submitted))
        throw new CommandError(
          "INVALID_INPUT",
          "Select the session to revoke by its userId and the id that /admin/list-user-sessions returns.",
        );
      const listed = await requestAuthentication(
        context,
        "/admin/list-user-sessions",
        { method: "POST", body: { userId: submitted.userId } },
        false,
      );
      const sessionToken = parseResponse(
        Type.Object({ sessions: Type.Array(listedSessionSchema) }),
        listed.data,
        "/admin/list-user-sessions",
      ).sessions.find((listedSession) => listedSession.id === submitted.id)?.token;
      if (!sessionToken)
        throw new CommandError("SESSION_NOT_FOUND", "No session of this user has that id.");
      input = { sessionToken };
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
      const value = input[name];
      if (!Value.Check(Type.String({ minLength: 1 }), value)) {
        throw new CommandError(
          "INVALID_INPUT",
          `Authentication input requires path parameter ${name}.`,
        );
      }
      delete input[name];
      params[name] = value;
      return `:${name}`;
    });
    const query = operation.method === "get" ? input : undefined;
    if (
      query &&
      !Value.Check(
        Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
        query,
      )
    )
      throw new CommandError(
        "INVALID_INPUT",
        "GET authentication input accepts string, number, and boolean query values.",
      );
    const result = await requestAuthentication(context, path, {
      method: operation.method.toUpperCase(),
      params,
      body: operation.method === "post" ? input : undefined,
      query,
    });
    await writeOutput(
      `${JSON.stringify(
        {
          status: result.status,
          data: Value.Check(authenticationSchema, result.data)
            ? {
                user: Value.Clean(userSchema, result.data.user),
                signedIn: result.data.token !== null,
              }
            : result.data,
        },
        null,
        options.json ? undefined : 2,
      )}\n`,
    );
  });
};
