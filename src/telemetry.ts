import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { log } from "@clack/prompts";
import { type Command } from "commander";

import {
  cliVersion,
  type DevboxesCliOptions,
  type DevboxesContext,
  loadContext,
  persistTelemetrySetting,
} from "./devboxes";

const telemetryDeliveryDeadlineMs = 1_000;
const telemetryTransportTimeoutMs = 750;

let activeTelemetry:
  | {
      configPath: string;
      endpoint: string;
      environment: string;
    }
  | undefined;

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
      if (!(await file.stat()).isFile()) return;
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
      return;
    } finally {
      await file?.close().catch(() => undefined);
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
  const sentryAuth = new URLSearchParams({
    sentry_version: "7",
    sentry_key: parsed.username,
  });
  const basePath = pathSegments.length > 0 ? `${pathSegments.join("/")}/` : "";
  return {
    endpoint: `${parsed.origin}/${basePath}api/${projectId}/envelope/?${sentryAuth}`,
    value: dsn,
  };
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

const initializeCliTelemetry = async (context: DevboxesContext) => {
  const telemetry = context.config.telemetry;
  if (!telemetry) return;

  try {
    const dsn = validatedTelemetryDsn(telemetry.dsn);
    const environment = validatedTelemetryEnvironment(telemetry.environment);
    activeTelemetry = {
      configPath: context.configPath,
      endpoint: dsn.endpoint,
      environment,
    };
  } catch {
    await appendTelemetryDiagnostic(context.configPath, "initialization_failed");
  }
};

export const captureCliTelemetryError = async () => {
  const telemetry = activeTelemetry;
  if (!telemetry) return;

  const deadline = performance.now() + telemetryDeliveryDeadlineMs;
  try {
    const eventId = randomUUID().replaceAll("-", "");
    const event = {
      event_id: eventId,
      timestamp: Date.now() / 1_000,
      platform: "javascript",
      level: "error",
      message: "Devboxes CLI command failed.",
      environment: telemetry.environment,
      release: cliVersion,
      tags: {
        runtime: "cli",
        "devboxes.version": cliVersion,
      },
    };
    const envelope = [
      JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }),
      JSON.stringify({ type: "event" }),
      JSON.stringify(event),
    ].join("\n");
    const remainingMs = Math.max(
      1,
      Math.min(telemetryTransportTimeoutMs, Math.ceil(deadline - performance.now())),
    );
    const response = await fetch(telemetry.endpoint, {
      body: envelope,
      method: "POST",
      signal: AbortSignal.timeout(remainingMs),
    });
    if (!response.ok) {
      await appendTelemetryDiagnostic(telemetry.configPath, "transport_failed", deadline);
    }
  } catch {
    await appendTelemetryDiagnostic(telemetry.configPath, "transport_failed", deadline);
  }
};

export const addTelemetryCommands = (program: Command) => {
  const telemetryCommand = program
    .command("telemetry")
    .description("manage opt-in CLI error telemetry");

  const enableCommand = telemetryCommand.command("enable");
  enableCommand
    .description("enable error telemetry through a self-hosted Sentry DSN")
    .requiredOption("--dsn <dsn>", "self-hosted Sentry DSN")
    .requiredOption("--environment <name>", "Sentry environment name")
    .action(async () => {
      const options = enableCommand.opts<{ dsn: string; environment: string }>();
      const dsn = validatedTelemetryDsn(options.dsn);
      const configPath = await persistTelemetrySetting(
        enableCommand.optsWithGlobals<DevboxesCliOptions>(),
        {
          dsn: dsn.value,
          environment: validatedTelemetryEnvironment(options.environment),
        },
      );
      log.success(`CLI error telemetry enabled in ${configPath}.`);
    });

  const disableCommand = telemetryCommand.command("disable");
  disableCommand.description("disable CLI error telemetry").action(async () => {
    await persistTelemetrySetting(disableCommand.optsWithGlobals<DevboxesCliOptions>(), undefined);
    log.success("CLI error telemetry is disabled.");
  });

  telemetryCommand.action(() => telemetryCommand.outputHelp());

  program.hook("preAction", async (_thisCommand, actionCommand) => {
    if (
      actionCommand === program ||
      actionCommand === telemetryCommand ||
      actionCommand.parent === telemetryCommand ||
      actionCommand.name() === "listen" ||
      actionCommand.name() === "mcp"
    ) {
      return;
    }
    const context = await loadContext(actionCommand.optsWithGlobals<DevboxesCliOptions>());
    await initializeCliTelemetry(context);
  });
};
