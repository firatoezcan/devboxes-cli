import type { Breadcrumb, Event, SpanJSON } from "@sentry/core";
import Type from "typebox";
import Value from "typebox/value";

const TelemetryPrimitiveSchema = Type.Union([Type.Boolean(), Type.Number(), Type.String()]);
const TelemetryStringSchema = Type.String();

const sensitiveQueryParameter =
  /(?:^|[^a-z0-9])(?:auth|authorization|bearer|code|credentials?|csrf|invitation|jwt|key|nonce|oauth|otp|password|registration|reset|saml|secrets?|sessions?|signature|sso|state|tokens?|verification|xsrf)(?:$|[^a-z0-9])/i;
const nestedUrlParameter =
  /(?:^|[^a-z0-9])(?:callback|continue|next|redirect|return|url|uri)(?:$|[^a-z0-9])/i;
const credentialHeader =
  /^(?:authorization|cookie|proxy-authorization|set-cookie|x-access-token|x-api-key|x-auth-token|x-csrf-token|x-hub-signature-256|x-xsrf-token)$/i;
const urlHeader = /^(?:content-location|location|referer|referrer)$/i;
const allowedQueryParameterValues = {
  page: /^[1-9]\d{0,5}$/,
  sort: /^(?:created|desc|highestindex|name|updated)$/,
  source: /^(?:email|invite)$/,
  tab: /^(?:blueprint|capabilities|env|environment|files|models|overview|pull-requests|repository|runs|settings|slack)$/,
  view: /^(?:list|summary)$/,
} satisfies Record<string, RegExp>;
type AllowedQueryParameter = keyof typeof allowedQueryParameterValues;
const allowedHeaderValues = {
  "accept-language": /^[A-Za-z0-9*.,;= -]{1,128}$/,
  "content-length": /^(?:0|[1-9]\d{0,18})$/,
  "content-type": /^[\x20-\x7e]{1,128}$/,
  "x-request-id": /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
} satisfies Record<string, RegExp>;
type AllowedHeader = keyof typeof allowedHeaderValues;
const allowedEventTags = new Set([
  "action",
  "artifact_sha256",
  "better-auth.error",
  "boundary",
  "capability",
  "command",
  "errorClass",
  "image_digest",
  "operation",
  "podName",
  "requestId",
  "resolutionId",
  "route",
  "runId",
  "runtime",
  "sessionId",
  "source_sha",
  "stage",
  "taskId",
  "version",
]);
const allowedEventMessages = new Set([
  "Kubernetes pod inspection failed",
  "Kubernetes pod inspection failures suppressed",
  "Kubernetes pod inspection recovered",
  "Bootstrap operator account created.",
  "An unauthorized user reached the auth creation boundary.",
  "Bootstrap operator configuration remains enabled after use.",
  "Invited registration runtime prerequisites are unavailable.",
  "Invited registration rolled back before completion.",
]);
const allowedContextFields = {
  app: new Set(["app_build", "app_identifier", "app_name", "app_version"]),
  browser: new Set(["name", "version"]),
  device: new Set(["arch", "brand", "family", "manufacturer", "model", "model_id"]),
  os: new Set(["build", "kernel_version", "name", "version"]),
  runtime: new Set(["name", "version"]),
  trace: new Set(["op", "origin", "parent_span_id", "span_id", "status", "trace_id"]),
} satisfies Record<string, Set<string>>;
const allowedSpanDataFields = new Set([
  "http.method",
  "http.query",
  "http.request.header.referer",
  "http.request.header.user_agent",
  "http.request.header.x_request_id",
  "http.request.method",
  "http.response.header.location",
  "http.response.status_code",
  "http.route",
  "http.status_code",
  "http.target",
  "http.url",
  "sentry.op",
  "sentry.origin",
  "sentry.sample_rate",
  "url.full",
  "url.query",
]);
const allowedBreadcrumbCategories = new Set(["fetch", "http", "navigation", "xhr"]);
const allowedBreadcrumbDataFields = new Set([
  "from",
  "method",
  "status_code",
  "statusCode",
  "to",
  "url",
]);
const maximumNestedRedactionDepth = 4;
const maximumSentryPathSegments = 32;
const maximumSentryUrlLength = 2_048;
const sentryOperationMethods = new Set([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
]);
const ownedSentryRouteRoots = new Set([
  "accept-invitation",
  "account",
  "activation",
  "agent-sessions",
  "api",
  "api-reference",
  "audit-log",
  "blueprints",
  "claim-access",
  "credentials",
  "device",
  "devboxes",
  "docs",
  "feedback",
  "forgot-password",
  "github-app",
  "health",
  "imprint",
  "login",
  "members",
  "organizations",
  "privacy",
  "projects",
  "pull-requests",
  "queue",
  "reset-password",
  "runners",
  "runs",
  "sign-up",
  "slack",
  "terms",
  "two-factor",
  "users",
  "verify-email",
  "waitlist",
]);
const allowedSentryRouteSegments = new Set([
  ...ownedSentryRouteRoots,
  "auth",
  "callback",
  "chat-integrations",
  "config",
  "danger",
  "data-export",
  "data-rights",
  "delete",
  "health",
  "install",
  "internal",
  "link",
  "live",
  "me",
  "model-resolutions",
  "opencode-tasks",
  "operator",
  "provider-auth",
  "packages",
  "ready",
  "search",
  "start",
  "status",
  "unsubscribe",
  "v1",
]);

export const redactSentryQuery = (
  query: string | Record<string, string> | Array<[string, string]>,
  depth = 0,
): string => {
  const leadingQuestionMark = query.constructor === String && query[0] === "?";
  const parameters = new URLSearchParams(query);
  const redacted = new URLSearchParams();

  for (const [name, value] of parameters) {
    const normalizedName = name.toLowerCase();
    const allowedValue =
      Object.hasOwn(allowedQueryParameterValues, normalizedName) &&
      allowedQueryParameterValues[normalizedName as AllowedQueryParameter].test(value);
    const readableName = name
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
    const containsSensitiveName =
      sensitiveQueryParameter.test(name) || sensitiveQueryParameter.test(readableName);
    const containsNestedName =
      nestedUrlParameter.test(name) || nestedUrlParameter.test(readableName);
    let nestedValue = value;
    let nestedRedactionFailed = false;
    if (containsNestedName) {
      for (
        let encodingDepth = 0;
        encodingDepth < maximumNestedRedactionDepth && !/[?#]/.test(nestedValue);
        encodingDepth += 1
      ) {
        try {
          const decoded = decodeURIComponent(nestedValue);
          if (decoded === nestedValue) break;
          nestedValue = decoded;
          if (encodingDepth === maximumNestedRedactionDepth - 1 && !/[?#]/.test(nestedValue)) {
            nestedRedactionFailed = true;
          }
        } catch {
          nestedRedactionFailed = true;
          break;
        }
      }
    }
    const containsNestedUrl = containsNestedName && /[?#]/.test(nestedValue);
    redacted.append(
      name,
      containsSensitiveName
        ? "[Filtered]"
        : nestedRedactionFailed
          ? "[Filtered]"
          : containsNestedUrl
            ? depth >= maximumNestedRedactionDepth
              ? "[Filtered]"
              : redactSentryUrl(nestedValue, depth + 1)
            : allowedValue
              ? value
              : "[Filtered]",
    );
  }

  const result = redacted.toString();
  return leadingQuestionMark ? `?${result}` : result;
};

const redactSentryRoute = (route: string, depth = 0): string | undefined => {
  if (!route || route.length > maximumSentryUrlLength) return undefined;
  const isAbsoluteUrl = route.startsWith("https://") || route.startsWith("http://");
  if ((!isAbsoluteUrl && !route.startsWith("/")) || route.startsWith("//") || /\s/.test(route)) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(route, "https://redaction.invalid");
  } catch {
    return undefined;
  }
  if (parsed.username || parsed.password || parsed.pathname.includes("//")) return undefined;

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length > maximumSentryPathSegments) return undefined;
  if (segments.length > 0 && !ownedSentryRouteRoots.has(segments[0] ?? "")) return undefined;
  const normalizedPath =
    segments.length === 0
      ? "/"
      : `/${segments
          .map((segment) => (allowedSentryRouteSegments.has(segment) ? segment : ":param"))
          .join("/")}`;
  const query = parsed.search ? `?${redactSentryQuery(parsed.search.slice(1), depth)}` : "";
  return `${normalizedPath}${query}`;
};

export const redactSentryUrl = (url: string, depth = 0): string =>
  redactSentryRoute(url, depth) ?? "[Filtered]";

const redactSentryOperationName = (name: string | undefined): string | undefined => {
  if (!name || name.length > 512) return undefined;
  const separatorIndex = name.indexOf(" ");
  const method = separatorIndex === -1 ? undefined : name.slice(0, separatorIndex);
  if (method && !sentryOperationMethods.has(method)) return undefined;
  const route = name.slice(separatorIndex + 1);
  const redactedRoute = redactSentryRoute(route);
  return redactedRoute === undefined ? undefined : `${method ? `${method} ` : ""}${redactedRoute}`;
};

export const redactSentryHeader = (name: string, value: string): string | undefined => {
  const normalizedName = name.replaceAll("_", "-").toLowerCase();
  if (credentialHeader.test(normalizedName)) return undefined;
  if (urlHeader.test(normalizedName)) return redactSentryUrl(value);
  if (!Object.hasOwn(allowedHeaderValues, normalizedName)) return undefined;
  const normalizedValue = value.trim();
  return allowedHeaderValues[normalizedName as AllowedHeader].test(normalizedValue)
    ? normalizedValue
    : undefined;
};

export const scrubSentryRequest = <T extends Event>(event: T): T => {
  if (!event.request) return event;
  if (event.request.url) event.request.url = redactSentryUrl(event.request.url);
  if (event.request.query_string) {
    event.request.query_string = redactSentryQuery(event.request.query_string);
  }
  if (event.request.headers) {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(event.request.headers)) {
      const redacted = redactSentryHeader(name, value);
      if (redacted !== undefined) headers[name] = redacted;
    }
    event.request.headers = headers;
  }
  delete event.request.cookies;
  delete event.request.data;
  delete event.request.env;
  return event;
};

export const scrubSentryBreadcrumb = <T extends Breadcrumb>(breadcrumb: T): T | null => {
  if (!breadcrumb.category || !allowedBreadcrumbCategories.has(breadcrumb.category)) return null;
  const data: Breadcrumb["data"] = {};
  for (const [field, value] of Object.entries(breadcrumb.data ?? {})) {
    if (!allowedBreadcrumbDataFields.has(field)) continue;
    if (
      (field === "url" || field === "from" || field === "to") &&
      Value.Check(TelemetryStringSchema, value)
    ) {
      data[field] = redactSentryUrl(value);
    } else if (Value.Check(TelemetryPrimitiveSchema, value)) {
      data[field] = value;
    }
  }
  breadcrumb.data = data;
  delete breadcrumb.message;
  return breadcrumb;
};

export const scrubSentrySpan = <T extends SpanJSON>(span: T): T => {
  const data: SpanJSON["data"] = {};
  for (const [field, value] of Object.entries(span.data)) {
    if (!allowedSpanDataFields.has(field)) continue;
    if (
      ["url.full", "http.url", "http.target"].includes(field) &&
      Value.Check(TelemetryStringSchema, value)
    ) {
      data[field] = redactSentryUrl(value);
    } else if (
      ["url.query", "http.query"].includes(field) &&
      Value.Check(TelemetryStringSchema, value)
    ) {
      data[field] = redactSentryQuery(value);
    } else if (
      field.startsWith("http.request.header.") ||
      field.startsWith("http.response.header.")
    ) {
      if (!Value.Check(TelemetryStringSchema, value)) continue;
      const header = field.replace(/^http\.(?:request|response)\.header\./, "");
      const redacted = redactSentryHeader(header, value);
      if (redacted !== undefined) data[field] = redacted;
    } else if (Value.Check(TelemetryPrimitiveSchema, value)) {
      data[field] = value;
    }
  }
  span.data = data;
  const description = redactSentryOperationName(span.description);
  if (description === undefined) delete span.description;
  else span.description = description;
  return span;
};

export const scrubSentryEvent = <T extends Event>(event: T): T => {
  scrubSentryRequest(event);
  const transaction = redactSentryOperationName(event.transaction);
  if (transaction === undefined) delete event.transaction;
  else event.transaction = transaction;
  delete event.modules;
  delete event.server_name;

  const tags: Event["tags"] = {};
  for (const [name, value] of Object.entries(event.tags ?? {})) {
    if (!allowedEventTags.has(name) || !Value.Check(TelemetryPrimitiveSchema, value)) continue;
    tags[name] = value;
  }
  event.tags = tags;

  const contexts: Event["contexts"] = {};
  for (const [name, value] of Object.entries(event.contexts ?? {})) {
    const allowedFields = allowedContextFields[name as keyof typeof allowedContextFields];
    if (!value || !allowedFields) continue;
    const context: Exclude<NonNullable<Event["contexts"]>[string], undefined> = {};
    for (const [field, fieldValue] of Object.entries(value)) {
      if (allowedFields.has(field) && Value.Check(TelemetryPrimitiveSchema, fieldValue)) {
        context[field] = fieldValue;
      }
    }
    contexts[name] = context;
  }
  event.contexts = contexts;

  if (event.exception?.values) {
    for (const value of event.exception.values) {
      value.value = "[Filtered]";
      if (value.mechanism) {
        const mechanism = { type: value.mechanism.type };
        if (value.mechanism.handled !== undefined) {
          Object.assign(mechanism, { handled: value.mechanism.handled });
        }
        value.mechanism = mechanism;
      }
      if (value.stacktrace?.frames) {
        for (const frame of value.stacktrace.frames) {
          delete frame.vars;
        }
      }
    }
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      .map((breadcrumb) => scrubSentryBreadcrumb(breadcrumb))
      .filter((breadcrumb): breadcrumb is Breadcrumb => breadcrumb !== null);
  }
  if (!event.message || !allowedEventMessages.has(event.message)) delete event.message;
  const logMessage = event.logentry?.message;
  if (!logMessage || !allowedEventMessages.has(logMessage)) {
    delete event.logentry;
  } else {
    event.logentry = { message: logMessage };
  }
  delete event.extra;
  delete event.user;
  return event;
};
