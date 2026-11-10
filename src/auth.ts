import { URLPattern } from "node:url";

import type { BetterFetchOption } from "@better-fetch/fetch";
import { isCancel, password as passwordPrompt, select, text } from "@clack/prompts";
import { displayDeviceCode } from "./protocol/device-code";
import type { JsonValue } from "./protocol/json";
import { describeErrors } from "./values/validation-errors";
import { writeConfig } from "./connections/config";
import { createAuthClient } from "better-auth/client";
import { Option, type Command } from "commander";
import { CookieJar } from "tough-cookie";
import Type, { type Static } from "typebox";
import Value from "typebox/value";

import { cliUserAgent } from "./api";
import {
  apiOrigin,
  asksInTerminal,
  CommandError,
  credentialSafeJson,
  failureSchema,
  injectCallerTrace,
  httpUrl,
  openInBrowser,
  parseResponse,
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
const oauthFailureSchema = Type.Object({ error: Type.String(), error_description: Type.String() });

const signInMethods: {
  method: "github" | "google" | "email" | "password";
  flag: string;
  label: string;
}[] = [
  { method: "github", flag: "--github", label: "GitHub" },
  { method: "google", flag: "--google", label: "Google" },
  { method: "email", flag: "--email <email>", label: "Email code" },
  { method: "password", flag: "--email <email> --password-stdin", label: "Email and password" },
];
const deviceClientId = "devboxes-cli";

type AccountOptions = {
  api?: string;
  config?: string;
  github?: boolean;
  google?: boolean;
  email?: string;
  codeStdin?: boolean;
  secondFactorStdin?: boolean;
  emailSecondFactor?: boolean;
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
      Record<string, JsonValue | undefined>,
      Record<string, string | number | boolean>,
      Record<string, string>
    >,
    "body" | "method"
  > = {},
  redactResponse = true,
) => {
  const origin = apiOrigin(context.config.apiBaseUrl);
  const endpoint = new URLPattern({ baseURL: origin, pathname: `/api/auth${path}` });
  const cookies = context.config.cookieJar
    ? CookieJar.deserializeSync(context.config.cookieJar)
    : new CookieJar();
  const secrets = [context.config.sessionToken];
  let result: { status: number; data: JsonValue } | undefined;
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
            "The authentication endpoint escaped its route.",
          );
        }
        const cookie = cookies.getCookieStringSync(String(url));
        if (cookie) headers.set("Cookie", cookie);
        injectCallerTrace(headers);
      },
      onResponse: async ({ response, request }) => {
        const setCookies = response.headers.getSetCookie();
        for (const header of setCookies) cookies.setCookieSync(header, String(request.url));
        // Only an HttpOnly cookie carries a credential. A page reads the others, such as the last
        // sign-in method, so they are no secret.
        secrets.push(
          ...cookies
            .getCookiesSync(String(request.url))
            .flatMap((cookie) => (cookie.httpOnly ? [cookie.value] : [])),
        );
        if (!response.ok) {
          for (const value of Object.values(options.body ?? {})) {
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
          ? "Create a devboxes account. With --github or --google, it's a single run through the browser. With an email address, it takes two runs. First, run `devboxes signup --email <address> --password-stdin` and pipe in the new password; this emails you a code and exits. Then run `devboxes signup --email <address> --code-stdin` and pipe in that code to finish creating the account."
          : "Sign in with GitHub, with Google, with a code sent to your email, or with your password. For a password sign-in, run `devboxes login --email <address> --password-stdin` and pipe in the password.\n\nIf the account has two-factor authentication, the sign-in then waits for a second factor. To finish, run `devboxes login --second-factor-stdin` and pipe in a code from your authenticator app (6 digits) or a backup code (anything else). If you'd rather get the code by email, run `devboxes login --email-second-factor` first, then pipe the emailed code into `devboxes login --email-second-factor --second-factor-stdin`.",
      )
      .addOption(
        new Option(
          "--github",
          action === "signup"
            ? "Sign up with GitHub in a browser."
            : "Sign in with GitHub in a browser.",
        ).conflicts(["google", "email", "codeStdin", "passwordStdin"]),
      )
      .addOption(
        new Option(
          "--google",
          action === "signup"
            ? "Sign up with Google in a browser."
            : "Sign in with Google in a browser.",
        ).conflicts(["email", "codeStdin", "passwordStdin"]),
      );
    if (action === "signup")
      command
        .option("--email <email>", "Create the account for this email address.")
        .option("--password-stdin", "Read the new account's password from stdin.")
        .addOption(
          new Option(
            "--code-stdin",
            "Read the emailed code from stdin and finish creating the account. The code has to be piped in; in a terminal with nothing piped in, it refuses with CODE_INPUT_REQUIRED.",
          ).conflicts("passwordStdin"),
        );
    else
      command
        .option(
          "--email <email>",
          "Sign in with this email address. By default, devboxes emails you a code.",
        )
        .option("--code-stdin", "Read the emailed code from stdin and finish signing in.")
        .addOption(
          new Option(
            "--password-stdin",
            "Sign in with your account password, read from stdin, instead of an emailed code.",
          ).conflicts("codeStdin"),
        )
        .addOption(
          new Option(
            "--second-factor-stdin",
            "Finish a password sign-in that's waiting for a second factor, reading the code from stdin. Six digits count as an authenticator code; anything else counts as a backup code.",
          ).conflicts(["github", "google", "email", "codeStdin", "passwordStdin"]),
        )
        .addOption(
          new Option(
            "--email-second-factor",
            "Have devboxes email you a code for the second factor. Then pass it with --email-second-factor --second-factor-stdin to finish signing in.",
          ).conflicts(["github", "google", "email", "codeStdin", "passwordStdin"]),
        );
    const methods =
      action === "signup"
        ? signInMethods.filter((entry) => entry.method !== "email")
        : signInMethods;
    command.action(async () => {
      const options = command.optsWithGlobals<AccountOptions>();
      if (process.env.DEVBOXES_TOKEN !== undefined) {
        throw new CommandError(
          "SCOPED_AUTHENTICATION",
          "Account login cannot replace a scoped connection. Remove DEVBOXES_TOKEN before signing in to a local account.",
        );
      }
      const interactive = asksInTerminal(options.json);
      let choice = methods.find((entry) =>
        entry.method === "github" || entry.method === "google"
          ? options[entry.method]
          : options.email !== undefined &&
            (entry.method === "password") === (action === "signup" || !!options.passwordStdin),
      );
      const context = await loadAccountContext(options);
      const report = async (user: Static<typeof userSchema>) => {
        await writeOutput(
          `${
            options.json
              ? JSON.stringify({ user: Value.Clean(userSchema, user), signedIn: true })
              : `Signed in as ${user.email}.`
          }\n`,
        );
      };
      if (options.secondFactorStdin || options.emailSecondFactor) {
        if (!options.secondFactorStdin) {
          await requestAuthentication(context, "/two-factor/send-otp", {
            method: "POST",
            body: {},
          });
          await writeOutput(
            `${
              options.json
                ? JSON.stringify({ signedIn: false, codeSent: true })
                : "devboxes emailed you a code. Pipe it into devboxes login --email-second-factor --second-factor-stdin."
            }\n`,
          );
          return;
        }
        const code = (await Bun.stdin.text()).replace(/\s/g, "");
        const path = options.emailSecondFactor
          ? "/two-factor/verify-otp"
          : /^\d{6}$/.test(code)
            ? "/two-factor/verify-totp"
            : "/two-factor/verify-backup-code";
        const verified = await requestAuthentication(context, path, {
          method: "POST",
          body: { code },
        });
        await report(parseResponse(authenticationSchema, verified.data, path).user);
        return;
      }
      if (!choice) {
        if (!interactive) {
          throw new CommandError(
            "SIGN_IN_METHOD_REQUIRED",
            "Choose a sign-in method: --github, --google or --email <email>.",
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

      if (choice.method === "github" || choice.method === "google") {
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
        const verification = httpUrl(device.verification_uri_complete);
        if (!verification) {
          throw new CommandError(
            "INVALID_AUTH_RESPONSE",
            "Device authorization did not return its codes and an HTTP verification URL: /verification_uri_complete must be an HTTP URL.",
          );
        }
        verification.searchParams.set("provider", choice.method);
        if (action === "signup") verification.searchParams.set("sign_up", "true");
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
              : `Open ${verification.href}, check that it shows code ${displayDeviceCode(device.user_code)}, and approve the sign-in.`
          }\n`,
        );
        if (interactive) openInBrowser(verification);
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
      if (interactive) email ??= await promptText("Email");
      if (!email) {
        throw new CommandError(
          "INVALID_USAGE",
          `Email ${action === "signup" ? "signup" : "login"} requires --email <email>.`,
        );
      }
      if (options.codeStdin && process.stdin.isTTY) {
        throw new CommandError("CODE_INPUT_REQUIRED", "Pipe the emailed code into --code-stdin.");
      }
      const readPassword = async () => {
        let password: string;
        if (options.passwordStdin) {
          if (process.stdin.isTTY) {
            throw new CommandError(
              "PASSWORD_INPUT_REQUIRED",
              `Pipe the password into --password-stdin, or run devboxes ${action} on its own and choose email and password.`,
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
        return password;
      };
      if (action === "signup") {
        if (!options.codeStdin) {
          await requestAuthentication(context, "/sign-up/email", {
            method: "POST",
            body: { email, password: await readPassword(), name: "" },
          });
          if (!interactive) {
            await writeOutput(
              `${
                options.json
                  ? JSON.stringify({ signedIn: false, codeSent: true })
                  : `devboxes sent a code to ${email}. Pipe it into devboxes signup --email ${email} --code-stdin to finish creating your account.`
              }\n`,
            );
            return;
          }
        }
        const code = options.codeStdin
          ? (await Bun.stdin.text()).trim()
          : await promptText(`Code sent to ${email}`);
        const verified = await requestAuthentication(context, "/email-otp/verify-email", {
          method: "POST",
          body: { email, otp: code },
        });
        await report(
          parseResponse(authenticationSchema, verified.data, "/email-otp/verify-email").user,
        );
        return;
      }
      if (choice.method === "password") {
        const password = await readPassword();
        const signedIn = await authenticationResponse(context, "/sign-in/email", {
          method: "POST",
          body: { email, password },
        });
        if ("failure" in signedIn) {
          if (signedIn.failure.code !== "EMAIL_NOT_VERIFIED") throw signedIn.failure;
          throw new CommandError(
            "EMAIL_NOT_VERIFIED",
            `${email} is not verified yet. devboxes sent a new code to it. Pipe it into devboxes signup --email ${email} --code-stdin to finish creating your account.`,
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
                  : "Two-factor verification is required. Pipe an authenticator or backup code into devboxes login --second-factor-stdin. For a code by email, run devboxes login --email-second-factor, then pipe the code into devboxes login --email-second-factor --second-factor-stdin."
              }\n`,
            );
            return;
          }
          const emailed = await select({
            message: "Second factor",
            options: [
              { value: false, label: "Authenticator app or backup code" },
              { value: true, label: `Email a code to ${email}` },
            ],
            output: process.stderr,
          });
          if (isCancel(emailed)) throw new CommandError("CANCELLED", "Authentication cancelled.");
          if (emailed) {
            await requestAuthentication(context, "/two-factor/send-otp", {
              method: "POST",
              body: {},
            });
            response = await requestAuthentication(context, "/two-factor/verify-otp", {
              method: "POST",
              body: { code: await promptText(`Code sent to ${email}`) },
            });
          } else {
            const code = (await promptText("Authenticator code or backup code")).replace(/\s/g, "");
            response = await requestAuthentication(
              context,
              /^\d{6}$/.test(code) ? "/two-factor/verify-totp" : "/two-factor/verify-backup-code",
              { method: "POST", body: { code } },
            );
          }
        }
        await report(parseResponse(authenticationSchema, response.data, "/sign-in/email").user);
        return;
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
                : `If ${email} has a devboxes account, devboxes sent it a sign-in code. Pipe it into the same command with --code-stdin. To create an account, run devboxes signup.`
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
            body: { email, otp: code },
          })
        ).data,
        "/sign-in/email-otp",
      );
      await report(authenticated.user);
    });
  }

  const logout = program
    .command("logout")
    .description(
      "Sign out. This revokes your current sign-in on the server and deletes the saved credential from this computer.",
    );
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
        jsonParser: (text) => credentialSafeJson(text, [token]),
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
};
