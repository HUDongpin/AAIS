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
        "aais.route": "/login?reset_token=tag-url-secret",
      },
    } as unknown as Parameters<typeof sanitizeAaisSentryEvent>[0]);

    expect(event.request?.url).toBe("[external-endpoint-omitted]");
    expect(event.request).not.toHaveProperty("cookies");
    expect(event.request).not.toHaveProperty("headers");
    expect(event.request).not.toHaveProperty("query_string");
    expect(event.message).toBe("redacted");
    expect(event.transaction).toBe("/login");
    expect(event.exception?.values?.[0]?.value).toBe("redacted");
    expect(event.breadcrumbs?.[0]?.category).toBe("redacted");
    expect(event.breadcrumbs?.[0]?.message).toBe("redacted");
    expect(event.breadcrumbs?.[0]?.data?.url).toBe(
      "/login",
    );
    expect(event.extra?.callback_url).toBe("[external-endpoint-omitted]");
    expect(event.tags).toEqual({ "aais.route": "/login" });
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

    expect(event.request?.url).toBe("[external-endpoint-omitted]");
    expect(event.message).toBe("redacted");
    expect(event.breadcrumbs?.[0]?.message).toBe("redacted");
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

    expect(transaction.transaction).toBe("[transaction-omitted]");
    expect(transaction.request?.url).toBe("[external-endpoint-omitted]");
    expect(transaction.spans?.[0]?.description).toBe("[span-description-omitted]");
    expect(transaction.spans?.[0]?.data).toMatchObject({
      "url.full": "[external-endpoint-omitted]",
      "url.query": "",
    });
    expect(transaction.spans?.[0]?.data?.["http.request.header.authorization"]).toBeUndefined();
    expect(standaloneSpan.description).toBe("[span-description-omitted]");
    expect(standaloneSpan.data["http.url"]).toBe("[external-endpoint-omitted]");

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

  it("fail-closes arbitrary AI bodies, headers, identities, errors, and provider URLs", () => {
    const sentinels = [
      "PROMPT_SENTINEL_DO_NOT_CAPTURE",
      "RESPONSE_SENTINEL_DO_NOT_CAPTURE",
      "ATTACHMENT_SENTINEL_DO_NOT_CAPTURE",
      "ACTOR_SENTINEL_DO_NOT_CAPTURE",
      "CSRF_SENTINEL_DO_NOT_CAPTURE",
      "PROVIDER_BODY_SENTINEL_DO_NOT_CAPTURE",
      "API_KEY_SENTINEL_DO_NOT_CAPTURE",
      "dashscope.aliyuncs.com",
      "api.deepseek.com",
      "compatible-mode/v1/chat/completions",
      "chat/completions",
    ];
    const event = sanitizeAaisSentryEvent({
      message: "PROMPT_SENTINEL_DO_NOT_CAPTURE",
      server_name: "ACTOR_SENTINEL_DO_NOT_CAPTURE",
      logger: "PROVIDER_BODY_SENTINEL_DO_NOT_CAPTURE",
      debug_meta: {
        images: [{
          type: "sourcemap",
          code_file: "https://api.deepseek.com/chat/completions",
          debug_file: "PROMPT_SENTINEL_DO_NOT_CAPTURE",
        }],
      },
      transaction: "POST /compatible-mode/v1/chat/completions?api_key=API_KEY_SENTINEL_DO_NOT_CAPTURE",
      fingerprint: ["PROMPT_SENTINEL_DO_NOT_CAPTURE"],
      contexts: {
        aais: {
          diagnosticId: "11111111-1111-4111-8111-111111111111",
          prompt: "PROMPT_SENTINEL_DO_NOT_CAPTURE",
          PROMPT_SENTINEL_DO_NOT_CAPTURE: true,
        },
        unsafe: {
          response: "RESPONSE_SENTINEL_DO_NOT_CAPTURE",
        },
      },
      request: {
        env: { REMOTE_ADDR: "ACTOR_SENTINEL_DO_NOT_CAPTURE" },
        url: "https://api.deepseek.com:bad/chat/completions?api_key=API_KEY_SENTINEL_DO_NOT_CAPTURE&prompt=PROMPT_SENTINEL_DO_NOT_CAPTURE",
      },
      logentry: {
        message: "PROVIDER_BODY_SENTINEL_DO_NOT_CAPTURE",
        params: ["PROMPT_SENTINEL_DO_NOT_CAPTURE"],
      },
      exception: {
        values: [{
          type: "PROVIDER_BODY_SENTINEL_DO_NOT_CAPTURE",
          module: "PROMPT_SENTINEL_DO_NOT_CAPTURE",
          value: "PROVIDER_BODY_SENTINEL_DO_NOT_CAPTURE https://api.deepseek.com/chat/completions",
          mechanism: {
            type: "generic",
            handled: false,
            data: { body: "RESPONSE_SENTINEL_DO_NOT_CAPTURE" },
            source: "ACTOR_SENTINEL_DO_NOT_CAPTURE",
          },
          stacktrace: {
            frames: [{
              filename: "PROVIDER_BODY_SENTINEL_DO_NOT_CAPTURE",
              abs_path: "/Users/ACTOR_SENTINEL_DO_NOT_CAPTURE/provider.ts",
              function: "PROVIDER_BODY_SENTINEL_DO_NOT_CAPTURE",
              module: "PROMPT_SENTINEL_DO_NOT_CAPTURE",
              platform: "RESPONSE_SENTINEL_DO_NOT_CAPTURE",
              module_metadata: { key: "API_KEY_SENTINEL_DO_NOT_CAPTURE" },
              debug_id: "PROVIDER_BODY_SENTINEL_DO_NOT_CAPTURE",
              instruction_addr: "ACTOR_SENTINEL_DO_NOT_CAPTURE",
              addr_mode: "PROMPT_SENTINEL_DO_NOT_CAPTURE",
              context_line: "const prompt = 'PROMPT_SENTINEL_DO_NOT_CAPTURE'",
              pre_context: ["API_KEY_SENTINEL_DO_NOT_CAPTURE"],
              post_context: ["RESPONSE_SENTINEL_DO_NOT_CAPTURE"],
              vars: { csrf: "CSRF_SENTINEL_DO_NOT_CAPTURE" },
            }],
          },
        }],
      },
      breadcrumbs: [{
        category: "PROMPT_SENTINEL_DO_NOT_CAPTURE",
        message: "RESPONSE_SENTINEL_DO_NOT_CAPTURE",
        data: {
          requestBody: { prompt: "PROMPT_SENTINEL_DO_NOT_CAPTURE" },
          responseBody: "RESPONSE_SENTINEL_DO_NOT_CAPTURE",
          attachmentContent: "ATTACHMENT_SENTINEL_DO_NOT_CAPTURE",
          actorId: "ACTOR_SENTINEL_DO_NOT_CAPTURE",
          headers: {
            "x-aais-csrf": "CSRF_SENTINEL_DO_NOT_CAPTURE",
            authorization: "Bearer API_KEY_SENTINEL_DO_NOT_CAPTURE",
          },
          endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
          url: "http://[::1]/PROVIDER_BODY_SENTINEL_DO_NOT_CAPTURE",
          unsafeSafeNames: {
            operationId: "PROMPT_SENTINEL_DO_NOT_CAPTURE",
            modelFingerprint: "RESPONSE_SENTINEL_DO_NOT_CAPTURE",
          },
        },
      }],
      extra: {
        errorMessage: "PROVIDER_BODY_SENTINEL_DO_NOT_CAPTURE",
        providerResponseBody: "RESPONSE_SENTINEL_DO_NOT_CAPTURE",
        learnerIdentity: "ACTOR_SENTINEL_DO_NOT_CAPTURE",
        miscellaneous: "PROMPT_SENTINEL_DO_NOT_CAPTURE",
        redaction: { PROMPT_SENTINEL_DO_NOT_CAPTURE: true },
        diagnosticId: "11111111-1111-4111-8111-111111111111",
        modelFingerprint: "0123456789abcdef",
      },
      spans: [{
        trace_id: "e".repeat(32),
        span_id: "f".repeat(16),
        start_timestamp: 1,
        timestamp: 2,
        description: "POST https://api.deepseek.com/chat/completions",
        data: {
          "http.request.body": "PROMPT_SENTINEL_DO_NOT_CAPTURE",
          "http.response.body": "PROVIDER_BODY_SENTINEL_DO_NOT_CAPTURE",
          "http.request.headers": {
            "x-aais-csrf": "CSRF_SENTINEL_DO_NOT_CAPTURE",
          },
          "server.address": "dashscope.aliyuncs.com",
          "url.full": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
          "url.path": "/compatible-mode/v1/chat/completions",
          "http.target": "/chat/completions",
          "http.route": "/compatible-mode/v1/chat/completions",
          "http.url": "https://dashscope.aliyuncs.com:bad/compatible-mode/v1/chat/completions?api_key=API_KEY_SENTINEL_DO_NOT_CAPTURE",
          "aais.route": "/api/learning/ai-guide",
          PROMPT_SENTINEL_DO_NOT_CAPTURE: true,
        },
      }],
      threads: {
        values: [{
          id: 1,
          name: "ACTOR_SENTINEL_DO_NOT_CAPTURE",
          stacktrace: {
            frames: [{
              filename: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
              abs_path: "/Users/ACTOR_SENTINEL_DO_NOT_CAPTURE/provider.ts",
              context_line: "PROMPT_SENTINEL_DO_NOT_CAPTURE",
              pre_context: ["API_KEY_SENTINEL_DO_NOT_CAPTURE"],
              post_context: ["RESPONSE_SENTINEL_DO_NOT_CAPTURE"],
              vars: { body: "PROVIDER_BODY_SENTINEL_DO_NOT_CAPTURE" },
            }],
          },
        }],
      },
    } as unknown as Parameters<typeof sanitizeAaisSentryEvent>[0]);
    const arbitraryTransaction = sanitizeAaisSentryTransaction({
      type: "transaction",
      transaction: "PROMPT_SENTINEL_DO_NOT_CAPTURE",
    } as Parameters<typeof sanitizeAaisSentryTransaction>[0]);

    const serialized = JSON.stringify({ event, arbitraryTransaction });
    for (const sentinel of sentinels) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(event.extra).toMatchObject({
      diagnosticId: "11111111-1111-4111-8111-111111111111",
      modelFingerprint: "0123456789abcdef",
      secrets: "redacted",
    });
    expect(event.spans?.[0]?.description).toBe("[span-description-omitted]");
    expect(event.transaction).toBe("[transaction-omitted]");
    expect(event.fingerprint).toBeUndefined();
    expect(event.server_name).toBeUndefined();
    expect(event.logger).toBeUndefined();
    expect(event.debug_meta).toBeUndefined();
    expect(event.request?.env).toBeUndefined();
    expect(event.exception?.values?.[0]?.type).toBe("redacted");
    expect(event.exception?.values?.[0]?.module).toBeUndefined();
    expect(event.exception?.values?.[0]?.mechanism?.data).toBeUndefined();
    expect(event.exception?.values?.[0]?.mechanism?.source).toBeUndefined();
    expect(event.threads?.values?.[0]?.name).toBeUndefined();
    expect(event.contexts).toEqual({
      aais: {
        diagnosticId: "11111111-1111-4111-8111-111111111111",
        secrets: "redacted",
      },
    });
    expect(event.logentry).toEqual({ message: "redacted" });
    expect(event.threads?.values?.[0]?.stacktrace?.frames?.[0]).toMatchObject({
      filename: "[source-omitted]",
    });
    expect(event.exception?.values?.[0]?.stacktrace?.frames?.[0]).toEqual({
      filename: "[source-omitted]",
    });
    expect(arbitraryTransaction.transaction).toBe("[transaction-omitted]");
    expect(event.spans?.[0]?.data?.["url.full"]).toBe("[external-endpoint-omitted]");
    expect(event.spans?.[0]?.data).toMatchObject({
      "url.path": "[external-endpoint-omitted]",
      "http.target": "[external-endpoint-omitted]",
      "http.route": "[external-endpoint-omitted]",
      "aais.route": "/api/learning/ai-guide",
    });
  });
});
