import {
  loadContext,
  type DevboxesCliOptions,
  type DevboxesContext,
} from "./connections/config";

import { defaultApiOrigin } from "./api";
import { apiOrigin, CommandError, type CommandConnection } from "./commands";

export type AccountContext = DevboxesContext & {
  config: DevboxesContext["config"] & { apiBaseUrl: string };
};

export const loadAccountContext = async (
  options: Pick<DevboxesCliOptions, "config" | "api">,
): Promise<AccountContext> => {
  if (
    [
      "DEVBOX_API_BASE_URL",
      "DEVBOX_AUTH_BASE_URL",
      "DEVBOX_CLI_SESSION_TOKEN",
      "DEVBOX_ORGANIZATION_ID",
      "DEVBOX_RUNNER_API_KEY",
      "DEVBOX_RUNNER_NAME",
    ].some((key) => process.env[key] !== undefined)
  ) {
    throw new CommandError(
      "LEGACY_CONNECTION",
      "Use DEVBOXES_API_URL and DEVBOXES_TOKEN for a scoped connection, or --api and a saved account configuration.",
    );
  }
  const context = await loadContext(options);
  const { config } = context;
  if ((config.sessionToken || config.cookieJar) && !config.apiBaseUrl) {
    throw new CommandError("INVALID_CONFIG", "A saved credential must have its own API origin.");
  }
  const storedOrigin = config.apiBaseUrl ? apiOrigin(config.apiBaseUrl, "account") : undefined;
  const api = options.api ?? (storedOrigin ? undefined : defaultApiOrigin);
  const origin = api === undefined ? storedOrigin : apiOrigin(api, "account");
  if (!origin) {
    throw new CommandError(
      "API_URL_REQUIRED",
      "Select an API origin with --api when signing up or logging in.",
    );
  }
  if (storedOrigin && storedOrigin !== origin) {
    throw new CommandError(
      "API_ORIGIN_MISMATCH",
      "This configuration belongs to another API origin. Select a different --config file for this origin.",
    );
  }
  return { ...context, config: { ...config, apiBaseUrl: `${origin}/api` } };
};

export const loadCommandConnection = async (
  options: Pick<DevboxesCliOptions, "config" | "api">,
): Promise<CommandConnection> => {
  const api = process.env.DEVBOXES_API_URL;
  const token = process.env.DEVBOXES_TOKEN;
  if (api !== undefined || token !== undefined) {
    if (!api || !token || !/^[\x21-\x7e]+$/.test(token)) {
      throw new CommandError(
        "INCOMPLETE_SCOPED_CONNECTION",
        "A scoped connection requires both DEVBOXES_API_URL and DEVBOXES_TOKEN. No personal configuration was loaded.",
      );
    }
    const origin = apiOrigin(api);
    if (options.api !== undefined && apiOrigin(options.api) !== origin) {
      throw new CommandError(
        "API_ORIGIN_MISMATCH",
        "--api must match DEVBOXES_API_URL for a scoped connection.",
      );
    }
    return { origin, token };
  }
  const context = await loadAccountContext(options);
  const tokenFromConfig = context.config.sessionToken;
  if (!tokenFromConfig || !/^[\x21-\x7e]+$/.test(tokenFromConfig)) {
    throw new CommandError(
      "AUTHENTICATION_REQUIRED",
      "Sign in with devboxes login before invoking commands.",
    );
  }
  return { origin: apiOrigin(context.config.apiBaseUrl), token: tokenFromConfig };
};
