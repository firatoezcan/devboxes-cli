import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { log } from "@clack/prompts";
import * as Sentry from "@sentry/bun";
import { type Command } from "commander";
import {
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  scrubSentrySpan,
} from "devboxes/sentry-redaction";

import {
  cliVersion,
  type DevboxesCliOptions,
  type DevboxesContext,
  loadContext,
  persistTelemetrySetting,
} from "./devboxes";

const telemetryDeliveryDeadlineMs = 1_000;
const telemetryTransportTimeoutMs = 750;

let activeTelemetry: { configPath: string; deliveryFailed: boolean } | undefined;

const appendTelemetryDiagnostic = async (
  configPath: string,
  failure: "initialization_failed" | "transport_failed",
  deadline = performance.now() + telemetryDeliveryDeadlineMs,
) => {
  const remainingMs = Math.ceil(deadline - performance.now());
  if (remainingMs <= 0) return;

  const writeDiagnostic = (async () => {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(
        `${configPath}.telemetry.log`,
        constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_CREAT |
          constants.O_NONBLOCK |
          constants.O_NOFOLLOW,
        0o600,
      );
      if (!(await file.stat()).isFile()) {
        console.error("CLI telemetry diagnostic write failed.");
        return;
      }
      await file.chmod(0o600);
      await file.appendFile(
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          runtime: "cli",
          version: cliVersion,
          failure,
        })}\n`,
      );
    } catch {
      console.error("CLI telemetry diagnostic write failed.");
    } finally {
      await file?.close().catch(() => {
        console.error("CLI telemetry diagnostic close failed.");
      });
    }
  })();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      writeDiagnostic,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, remainingMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const validatedTelemetryDsn = (input: string) => {
  const dsn = input.trim();
  let parsed: URL;
  try {
    parsed = new URL(dsn);
  } catch {
    throw new Error("The telemetry DSN must be a valid Sentry DSN.");
  }
  const loopbackHttp =
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]");
  const pathSegments = parsed.pathname.slice(1).split("/");
  const projectId = pathSegments.pop() ?? "";
  if (
    (parsed.protocol !== "https:" && !loopbackHttp) ||
    !/^\w+$/.test(parsed.username) ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !/^\d+$/.test(projectId) ||
    pathSegments.some((segment) => !segment)
  ) {
    throw new Error(
      "The telemetry DSN must use HTTPS (or loopback HTTP), contain a valid public key and numeric project id, and contain no password, query, or fragment.",
    );
  }
  return dsn;
};

const validatedTelemetryEnvironment = (input: string) => {
  const environment = input.trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(environment)) {
    throw new Error(
      "The telemetry environment must be 1-64 letters, numbers, dots, underscores, or hyphens.",
    );
  }
  return environment;
};

const initializeCliTelemetry = async (context: DevboxesContext, command: string) => {
  const telemetry = context.config.telemetry;
  if (!telemetry) return;

  const ambientVercel = process.env.VERCEL;
  const ambientSentryUseEnvironment = process.env.SENTRY_USE_ENVIRONMENT;
  try {
    try {
      delete process.env.VERCEL;
      process.env.SENTRY_USE_ENVIRONMENT = "false";
      Sentry.init({
        debug: false,
        dsn: validatedTelemetryDsn(telemetry.dsn),
        enabled: true,
        environment: validatedTelemetryEnvironment(telemetry.environment),
        initialScope: {
          tags: {
            command,
            runtime: "cli",
            version: cliVersion,
          },
        },
        integrations: (integrations) =>
          integrations.filter(({ name }) => name !== "ProcessSession"),
        release: `devboxes-cli@${cliVersion}`,
        sendDefaultPii: false,
        serverName: "devboxes-cli",
        spotlight: false,
        tracesSampleRate: 0,
        beforeSend: scrubSentryEvent,
        beforeSendTransaction: scrubSentryEvent,
        beforeSendSpan: scrubSentrySpan,
        beforeBreadcrumb: scrubSentryBreadcrumb,
      });
    } finally {
      if (ambientVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = ambientVercel;
      if (ambientSentryUseEnvironment === undefined) delete process.env.SENTRY_USE_ENVIRONMENT;
      else process.env.SENTRY_USE_ENVIRONMENT = ambientSentryUseEnvironment;
    }
    if (!Sentry.isEnabled()) throw new Error("Sentry SDK stayed disabled.");
    const telemetryState = { configPath: context.configPath, deliveryFailed: false };
    const client = Sentry.getClient();
    if (!client) throw new Error("Sentry SDK did not create a client.");
    client.on("afterSendEvent", (_event, response) => {
      telemetryState.deliveryFailed =
        response.statusCode === undefined ||
        response.statusCode < 200 ||
        response.statusCode >= 300;
    });
    activeTelemetry = telemetryState;
  } catch {
    await appendTelemetryDiagnostic(context.configPath, "initialization_failed");
  }
};

export const captureCliTelemetryError = async (cause: unknown) => {
  const telemetry = activeTelemetry;
  if (!telemetry) return;

  const deadline = performance.now() + telemetryDeliveryDeadlineMs;
  try {
    telemetry.deliveryFailed = false;
    Sentry.captureException(cause);
    if (!(await Sentry.flush(telemetryTransportTimeoutMs)) || telemetry.deliveryFailed) {
      await appendTelemetryDiagnostic(telemetry.configPath, "transport_failed", deadline);
    }
  } catch {
    await appendTelemetryDiagnostic(telemetry.configPath, "transport_failed", deadline);
  }
};

export const addTelemetryCommands = (program: Command) => {
  const telemetryCommand = program
    .command("telemetry")
    .description("manage optional CLI error reporting");

  const enableCommand = telemetryCommand.command("enable");
  enableCommand
    .description("send CLI error reports to your self-hosted Sentry instance")
    .requiredOption("--dsn <dsn>", "self-hosted Sentry DSN")
    .requiredOption("--environment <name>", "Sentry environment name")
    .action(async () => {
      const options = enableCommand.opts<{ dsn: string; environment: string }>();
      const dsn = validatedTelemetryDsn(options.dsn);
      const configPath = await persistTelemetrySetting(
        enableCommand.optsWithGlobals<DevboxesCliOptions>(),
        {
          dsn,
          environment: validatedTelemetryEnvironment(options.environment),
        },
      );
      log.success(`CLI error telemetry enabled in ${configPath}.`);
    });

  const disableCommand = telemetryCommand.command("disable");
  disableCommand.description("stop sending CLI error reports").action(async () => {
    await persistTelemetrySetting(disableCommand.optsWithGlobals<DevboxesCliOptions>(), undefined);
    log.success("CLI error reporting is disabled.");
  });

  telemetryCommand.action(() => telemetryCommand.outputHelp());

  program.hook("preAction", async (_thisCommand, actionCommand) => {
    if (
      actionCommand === program ||
      actionCommand === telemetryCommand ||
      actionCommand.parent === telemetryCommand
    ) {
      return;
    }
    const context = await loadContext(actionCommand.optsWithGlobals<DevboxesCliOptions>());
    await initializeCliTelemetry(context, actionCommand.name());
  });
};
