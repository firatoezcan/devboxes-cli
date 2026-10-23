import {
  loadContext,
  type DevboxesCliOptions,
  type DevboxesContext,
} from "@firops/connections/local/config";
import Type from "typebox";

import { defaultApiOrigin } from "./api";
import {
  apiOrigin,
  asksInTerminal,
  CommandError,
  parseResponse,
  requestJson,
  type CommandConnection,
} from "./commands";

/** Signs the person in again with `devboxes login` under `options`. */
export type LogIn = (options: Pick<DevboxesCliOptions, "config" | "api">) => Promise<void>;

const inspectedAccountSchema = Type.Object({
  account: Type.Object({ id: Type.String(), email: Type.String() }),
});

/** The account that `connection` acts as. */
const accountOf = async (connection: CommandConnection) => {
  const { data } = await requestJson(connection, "/api/commands/account/inspect", {});
  return parseResponse(inspectedAccountSchema, data, "account.inspect").account;
};

export type AccountContext = DevboxesContext & {
  config: DevboxesContext["config"] & { apiBaseUrl: string };
};

export const loadAccountContext = async (
  options: Pick<DevboxesCliOptions, "config" | "api">,
): Promise<AccountContext> => {
  const context = await loadContext(options);
  const { config } = context;
  if ((config.sessionToken || config.cookieJar) && !config.apiBaseUrl) {
    throw new CommandError("INVALID_CONFIG", "A saved credential must have its own API origin.");
  }
  const storedOrigin = config.apiBaseUrl ? apiOrigin(config.apiBaseUrl, "account") : undefined;
  const api =
    options.api ?? process.env.DEVBOXES_API_URL ?? (storedOrigin ? undefined : defaultApiOrigin);
  const origin = api === undefined ? storedOrigin : apiOrigin(api, "account");
  if (!origin) {
    throw new CommandError(
      "API_URL_REQUIRED",
      "Select an API origin with --api or DEVBOXES_API_URL.",
    );
  }
  if (storedOrigin && storedOrigin !== origin) {
    throw new CommandError(
      "API_ORIGIN_MISMATCH",
      `This configuration belongs to another API origin than ${options.api === undefined ? "DEVBOXES_API_URL" : "--api"} selects. Select a different --config file for this origin.`,
    );
  }
  return { ...context, config: { ...config, apiBaseUrl: `${origin}/api` } };
};

/**
 * The connection a command uses: DEVBOXES_TOKEN's delegation, or the saved account session. At a
 * terminal, `logIn` lets an account session sign in again when a change needs a recent sign-in; the
 * change is sent again only when the same account signed in.
 */
export const loadCommandConnection = async (
  options: Pick<DevboxesCliOptions, "config" | "api"> & { json?: boolean },
  logIn?: LogIn,
): Promise<CommandConnection> => {
  const token = process.env.DEVBOXES_TOKEN;
  if (token !== undefined) {
    if (!/^[\x21-\x7e]+$/.test(token)) {
      throw new CommandError(
        "INVALID_DEVBOXES_TOKEN",
        "DEVBOXES_TOKEN must contain a delegation token. No personal configuration was loaded.",
      );
    }
    const api = options.api ?? process.env.DEVBOXES_API_URL ?? defaultApiOrigin;
    if (api === undefined) {
      throw new CommandError(
        "API_URL_REQUIRED",
        "Select an API origin with --api or DEVBOXES_API_URL.",
      );
    }
    return { origin: apiOrigin(api), token };
  }
  const context = await loadAccountContext(options);
  const tokenFromConfig = context.config.sessionToken;
  if (!tokenFromConfig || !/^[\x21-\x7e]+$/.test(tokenFromConfig)) {
    throw new CommandError(
      "AUTHENTICATION_REQUIRED",
      "Sign in with devboxes login before invoking commands.",
    );
  }
  const connection = { origin: apiOrigin(context.config.apiBaseUrl), token: tokenFromConfig };
  return {
    ...connection,
    ...(logIn &&
      asksInTerminal(options.json) && {
        signInAgain: async () => {
          const before = await accountOf(connection);
          await logIn(options);
          const next = await loadCommandConnection(options);
          const after = await accountOf(next);
          if (after.id !== before.id)
            throw new CommandError(
              "ACCOUNT_CHANGED",
              `You signed in as ${after.email}, not ${before.email}, so devboxes didn't send the change. Sign in as ${before.email} and repeat it.`,
            );
          return next.token;
        },
      }),
  };
};
