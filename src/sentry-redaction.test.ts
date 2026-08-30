import { describe, expect, it } from "bun:test";

import type { Breadcrumb, Event, SpanJSON } from "@sentry/core";

import {
  redactSentryQuery,
  redactSentryUrl,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  scrubSentryRequest,
  scrubSentrySpan,
} from "./sentry-redaction";

describe("shared Sentry payload policy", () => {
  it("keeps only allowlisted request diagnostics", () => {
    expect(redactSentryQuery("view=customer-token-secret")).toBe("view=%5BFiltered%5D");
    expect(redactSentryQuery("scope=openid%20profile")).toBe("scope=%5BFiltered%5D");
    const input: Event = {
      request: {
        cookies: { session: "cookie-secret" },
        data: { prompt: "request-prompt-secret" },
        env: { AUTH_TOKEN: "environment-secret" },
        headers: {
          accept: "header-secret".repeat(100),
          authorization: "Bearer authorization-secret",
          "Accept-Language": "en-US",
          referer: "https://app.devboxes.ai/reset-password?page=2&token=referer-secret",
          "User-Agent": "user-agent-secret".repeat(100),
          "X-Request-ID": "01990f53-9b4a-7000-8000-000000000042",
          "x-provider-payload": "provider-secret",
        },
        query_string: "page=2&sort=created&token=query-secret&payload=payload-secret",
        url: "https://app.devboxes.ai/reset-password?page=2&token=url-secret#fragment-secret",
      },
    };
    const event = scrubSentryRequest(input);

    expect(event.request).toEqual({
      headers: {
        "Accept-Language": "en-US",
        referer: "/reset-password?page=2&token=%5BFiltered%5D",
        "X-Request-ID": "01990f53-9b4a-7000-8000-000000000042",
      },
      query_string: "page=2&sort=created&token=%5BFiltered%5D&payload=%5BFiltered%5D",
      url: "/reset-password?page=2&token=%5BFiltered%5D",
    });
    for (const field of ["cookies", "data", "env"]) {
      expect(event.request).not.toHaveProperty(field);
    }
    expect(JSON.stringify(event)).not.toMatch(
      /(?:cookie|prompt|environment|authorization|header|user-agent|referer|provider|query|payload|url|fragment)-secret/,
    );
    expect(redactSentryUrl(`https://app.devboxes.ai/runs/${"path-secret".repeat(300)}`)).toBe(
      "[Filtered]",
    );
    expect(redactSentryUrl("https://app.devboxes.ai/runs/path-secret")).toBe("/runs/:param");
  });

  it("keeps only bounded event identity, trace context, and fixed operator messages", () => {
    const input: Event = {
      breadcrumbs: [
        {
          category: "navigation",
          data: {
            from: "https://app.devboxes.ai/login?source=invite&token=breadcrumb-secret",
            payload: "breadcrumb-payload-secret",
          },
          message: "breadcrumb-message-secret",
        },
        { category: "console", message: "console-secret" },
      ],
      contexts: {
        provider: { payload: "context-provider-secret" },
        runtime: { environment: "context-environment-secret", name: "bun", version: "1" },
        trace: {
          data: { prompt: "context-prompt-secret" },
          span_id: "0123456789abcdef",
          trace_id: "0123456789abcdef0123456789abcdef",
        },
      },
      exception: {
        values: [
          {
            mechanism: {
              data: { provider: "mechanism-secret" },
              handled: false,
              type: "generic",
            },
            stacktrace: { frames: [{ filename: "app.ts", vars: { token: "frame-secret" } }] },
            type: "Error",
            value: "exception-secret",
          },
        ],
      },
      extra: { body: "extra-secret" },
      logentry: {
        message: "Kubernetes pod inspection failed",
        params: ["log-parameter-secret"],
      },
      message: "Kubernetes pod inspection failed",
      tags: {
        artifact_sha256: "a".repeat(64),
        boundary: "task",
        capability: "agent-task",
        command: "status",
        prompt: "tag-secret",
        runId: "run_public_42",
        runtime: "api",
        sessionId: "session_public_42",
        source_sha: "1".repeat(40),
        version: "2.1.0",
      },
      modules: { "private-module-secret": "1.0.0" },
      server_name: "private-host-secret",
      transaction: "GET /api/runs?token=transaction-secret#transaction-fragment-secret",
      user: { email: "operator-secret@example.invalid" },
    };
    const event = scrubSentryEvent(input);

    expect(event).toMatchObject({
      breadcrumbs: [
        {
          category: "navigation",
          data: {
            from: "/login?source=invite&token=%5BFiltered%5D",
          },
        },
      ],
      contexts: {
        runtime: { name: "bun", version: "1" },
        trace: {
          span_id: "0123456789abcdef",
          trace_id: "0123456789abcdef0123456789abcdef",
        },
      },
      exception: {
        values: [
          {
            mechanism: { handled: false, type: "generic" },
            stacktrace: { frames: [{ filename: "app.ts" }] },
            type: "Error",
            value: "[Filtered]",
          },
        ],
      },
      logentry: { message: "Kubernetes pod inspection failed" },
      message: "Kubernetes pod inspection failed",
      tags: {
        artifact_sha256: "a".repeat(64),
        boundary: "task",
        capability: "agent-task",
        command: "status",
        runId: "run_public_42",
        runtime: "api",
        sessionId: "session_public_42",
        source_sha: "1".repeat(40),
        version: "2.1.0",
      },
      transaction: "GET /api/runs?token=%5BFiltered%5D",
    });
    expect(event.breadcrumbs?.[0]).not.toHaveProperty("message");
    expect(event.exception?.values?.[0]?.stacktrace?.frames?.[0]).not.toHaveProperty("vars");
    for (const field of ["extra", "modules", "server_name", "user"]) {
      expect(event).not.toHaveProperty(field);
    }
    expect(JSON.stringify(event)).not.toMatch(
      /(?:breadcrumb|console|context|mechanism|frame|exception|extra|log-parameter|tag|transaction|operator)-secret/,
    );

    expect(
      scrubSentryEvent({
        message: "provider transcript secret",
        transaction: "provider request containing a customer prompt",
      }).transaction,
    ).toBeUndefined();
    expect(scrubSentryEvent({ transaction: "GET /api/runs/path-token-secret" }).transaction).toBe(
      "GET /api/runs/:param",
    );
    expect(
      scrubSentryEvent({ transaction: "GET /provider-prompt-secret" }).transaction,
    ).toBeUndefined();
  });

  it("keeps only allowlisted span and breadcrumb diagnostics", () => {
    const spanInput: SpanJSON = {
      data: {
        "ai.prompt": "span-prompt-secret",
        "http.query": "sort=created&token=span-query-secret",
        "http.request.header.authorization": "Bearer span-authorization-secret",
        "http.request.header.referer":
          "https://app.devboxes.ai/login?page=3&token=span-referer-secret",
        "http.request.header.user_agent": "Devboxes test",
        "http.request.header.x_request_id": "span-request-42",
        "provider.payload": "span-provider-secret",
        "url.full":
          "https://app.devboxes.ai/runs?page=4&token=span-url-secret#span-fragment-secret",
      },
      description: "GET https://app.devboxes.ai/runs?page=4&token=span-description-secret#fragment",
      span_id: "0123456789abcdef",
      start_timestamp: 1,
      trace_id: "0123456789abcdef0123456789abcdef",
    };
    const breadcrumbInput: Breadcrumb = {
      category: "navigation",
      data: {
        method: "GET",
        providerPayload: "breadcrumb-provider-secret",
        to: "https://app.devboxes.ai/runs?view=list&token=breadcrumb-token-secret#fragment",
      },
      message: "breadcrumb-message-secret",
    };
    const span = scrubSentrySpan(spanInput);
    const breadcrumb = scrubSentryBreadcrumb(breadcrumbInput);

    expect(span).toMatchObject({
      data: {
        "http.query": "sort=created&token=%5BFiltered%5D",
        "http.request.header.referer": "/login?page=3&token=%5BFiltered%5D",
        "url.full": "/runs?page=4&token=%5BFiltered%5D",
      },
      description: "GET /runs?page=4&token=%5BFiltered%5D",
    });
    expect(breadcrumb).toEqual({
      category: "navigation",
      data: {
        method: "GET",
        to: "/runs?view=list&token=%5BFiltered%5D",
      },
    });
    expect(breadcrumb).not.toHaveProperty("message");
    expect(JSON.stringify({ breadcrumb, span })).not.toMatch(
      /(?:span|breadcrumb)-(?:prompt|query|authorization|referer|provider|url|fragment|description|token|message)-secret/,
    );

    expect(
      scrubSentrySpan({
        data: {},
        description: "provider prompt containing customer data",
        span_id: "0123456789abcdef",
        start_timestamp: 1,
        trace_id: "0123456789abcdef0123456789abcdef",
      }).description,
    ).toBeUndefined();
    expect(
      scrubSentrySpan({
        data: {},
        description: "GET //user:pass@host.invalid/runs/protocol-secret",
        span_id: "0123456789abcdef",
        start_timestamp: 1,
        trace_id: "0123456789abcdef0123456789abcdef",
      }).description,
    ).toBeUndefined();
  });
});
