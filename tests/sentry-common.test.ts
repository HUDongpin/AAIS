import { describe, expect, it } from "vitest";
import {
  sanitizeAaisSentryEvent,
  sanitizeAaisSentrySpan,
  sanitizeAaisSentryTransaction,
} from "../sentry.common";

describe("AAIS Sentry redaction", () => {
  it("removes one-time auth credentials from request URLs, fragments and breadcrumbs", () => {
    const event = sanitizeAaisSentryEvent({
      message: "request failed at /login?reset_token=message-secret",
      transaction: "/login?invite_token=transaction-secret",
      exception: {
        values: [{
          type: "Error",
          value: "bad callback /login?invite_token=exception-secret",
        }],
      },
      request: {
        url: "https://aais.example.test/login?invite_token=invite-secret&lang=en-US#reset_token=fragment-secret",
        query_string: "reset_token=query-secret&lang=en-US",
        cookies: { aais_session: "session-secret" },
        headers: { authorization: "Bearer secret" },
      },
      breadcrumbs: [
        {
          category: "navigation /login?invite_token=category-secret",
          message: "navigate /login?reset_token=reset-secret",
          data: {
            url: "/login?invite_token=invite-secret&lang=zh-CN#private",
          },
        },
      ],
      extra: {
        callback_url: "https://aais.example.test/login?reset_token=reset-secret",
      },
      tags: {
        callback_url: "/login?reset_token=tag-url-secret",
        auth_token: "tag-secret",
      },
    } as unknown as Parameters<typeof sanitizeAaisSentryEvent>[0]);

    expect(event.request?.url).toBe(
      "https://aais.example.test/login?lang=en-US",
    );
    expect(event.request).not.toHaveProperty("cookies");
    expect(event.request).not.toHaveProperty("headers");
    expect(event.request).not.toHaveProperty("query_string");
    expect(event.message).toBe("request failed at /login?reset_token=redacted");
    expect(event.transaction).toBe("/login");
    expect(event.exception?.values?.[0]?.value).toBe(
      "bad callback /login?invite_token=redacted",
    );
    expect(event.breadcrumbs?.[0]?.category).toBe(
      "navigation /login?invite_token=redacted",
    );
    expect(event.breadcrumbs?.[0]?.message).toBe(
      "navigate /login?reset_token=redacted",
    );
    expect(event.breadcrumbs?.[0]?.data?.url).toBe(
      "/login?lang=zh-CN",
    );
    expect(event.extra?.callback_url).toBe(
      "https://aais.example.test/login",
    );
    expect(event.tags).toMatchObject({
      callback_url: "/login",
      auth_token: "redacted",
    });
    expect(JSON.stringify(event)).not.toContain("invite-secret");
    expect(JSON.stringify(event)).not.toContain("reset-secret");
    expect(JSON.stringify(event)).not.toContain("fragment-secret");
    expect(JSON.stringify(event)).not.toContain("session-secret");
    expect(JSON.stringify(event)).not.toContain("message-secret");
    expect(JSON.stringify(event)).not.toContain("transaction-secret");
    expect(JSON.stringify(event)).not.toContain("exception-secret");
    expect(JSON.stringify(event)).not.toContain("query-secret");
    expect(JSON.stringify(event)).not.toContain("category-secret");
    expect(JSON.stringify(event)).not.toContain("tag-url-secret");
    expect(JSON.stringify(event)).not.toContain("tag-secret");
  });

  it("removes OIDC authorization codes, state and nonce values from captured URLs and text", () => {
    const event = sanitizeAaisSentryEvent({
      message: "callback failed /api/auth/oidc/callback?code=message-code&state=message-state",
      request: {
        url: "https://aais.example.test/api/auth/oidc/callback?code=request-code&state=request-state&session_state=session-secret&lang=en-US#nonce=fragment-nonce",
      },
      breadcrumbs: [{
        message: "navigate /api/auth/oidc/callback?code=breadcrumb-code&nonce=breadcrumb-nonce",
        data: {
          url: "/api/auth/oidc/callback?code=data-code&state=data-state",
        },
      }],
    } as unknown as Parameters<typeof sanitizeAaisSentryEvent>[0]);

    expect(event.request?.url).toBe(
      "https://aais.example.test/api/auth/oidc/callback?lang=en-US",
    );
    expect(event.message).toBe(
      "callback failed /api/auth/oidc/callback?code=redacted&state=redacted",
    );
    expect(event.breadcrumbs?.[0]?.message).toBe(
      "navigate /api/auth/oidc/callback?code=redacted&nonce=redacted",
    );
    expect(event.breadcrumbs?.[0]?.data?.url).toBe(
      "/api/auth/oidc/callback",
    );
    expect(JSON.stringify(event)).not.toMatch(/(?:message|request|session|fragment|breadcrumb|data)-(?:code|state|secret|nonce)/);
  });

  it("strips URL credentials and sensitive query fields from transactions and spans", () => {
    const transaction = sanitizeAaisSentryTransaction({
      type: "transaction",
      transaction: "https://transaction-user:transaction-pass@aais.example.test/api/auth/oidc/callback?code=transaction-code&state=transaction-state&lang=en-US#nonce=fragment-nonce",
      request: {
        url: "https://request-user:request-pass@aais.example.test/api/auth/oidc/callback?code=request-code&state=request-state&lang=zh-CN",
      },
      spans: [{
        trace_id: "a".repeat(32),
        span_id: "b".repeat(16),
        start_timestamp: 1,
        timestamp: 2,
        description: "https://span-user:span-pass@idp.example.test/oauth2/token?code=span-code&state=span-state&lang=en-US#private",
        data: {
          "url.full": "https://data-user:data-pass@idp.example.test/oauth2/token?code=data-code&state=data-state&lang=en-US",
          "url.query": "code=query-code&state=query-state&lang=en-US",
          "http.request.header.authorization": "Bearer span-authorization-secret",
        },
      }],
    } as Parameters<typeof sanitizeAaisSentryTransaction>[0]);
    const standaloneSpan = sanitizeAaisSentrySpan({
      trace_id: "c".repeat(32),
      span_id: "d".repeat(16),
      start_timestamp: 1,
      timestamp: 2,
      description: "https://standalone-user:standalone-pass@idp.example.test/jwks?code=standalone-code&state=standalone-state&lang=en-US",
      data: {
        "http.url": "https://attribute-user:attribute-pass@idp.example.test/jwks?code=attribute-code&state=attribute-state&lang=en-US",
      },
    });

    expect(transaction.transaction).toBe(
      "https://aais.example.test/api/auth/oidc/callback?lang=en-US",
    );
    expect(transaction.request?.url).toBe(
      "https://aais.example.test/api/auth/oidc/callback?lang=zh-CN",
    );
    expect(transaction.spans?.[0]?.description).toBe(
      "https://idp.example.test/oauth2/token?lang=en-US",
    );
    expect(transaction.spans?.[0]?.data).toMatchObject({
      "url.full": "https://idp.example.test/oauth2/token?lang=en-US",
      "url.query": "lang=en-US",
      "http.request.header.authorization": "redacted",
    });
    expect(standaloneSpan.description).toBe(
      "https://idp.example.test/jwks?lang=en-US",
    );
    expect(standaloneSpan.data["http.url"]).toBe(
      "https://idp.example.test/jwks?lang=en-US",
    );

    const serialized = JSON.stringify({ transaction, standaloneSpan });
    for (const secret of [
      "transaction-user",
      "transaction-pass",
      "transaction-code",
      "transaction-state",
      "request-user",
      "request-pass",
      "request-code",
      "request-state",
      "span-user",
      "span-pass",
      "span-code",
      "span-state",
      "data-user",
      "data-pass",
      "data-code",
      "data-state",
      "query-code",
      "query-state",
      "standalone-user",
      "standalone-pass",
      "standalone-code",
      "standalone-state",
      "attribute-user",
      "attribute-pass",
      "attribute-code",
      "attribute-state",
      "span-authorization-secret",
      "fragment-nonce",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
