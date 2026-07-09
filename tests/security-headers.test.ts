import { describe, expect, it } from "vitest";
import { config as middlewareConfig, middleware } from "@/../middleware";
import nextConfig, { createAaisContentSecurityPolicy } from "@/../next.config";

describe("AAIS Next security headers", () => {
  it("applies enterprise security headers to every route", async () => {
    expect(nextConfig.headers).toBeTypeOf("function");
    const rules = await nextConfig.headers?.();
    const globalRule = rules?.find((rule) => rule.source === "/:path*");
    const headers = Object.fromEntries(
      (globalRule?.headers ?? []).map((header) => [header.key.toLowerCase(), header.value]),
    );

    expect(headers["strict-transport-security"]).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"]).toContain("camera=()");
    expect(headers["permissions-policy"]).toContain("microphone=()");
    expect(headers["content-security-policy"]).toBeUndefined();
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  });

  it("creates nonce-based production CSP without unsafe inline or eval allowances", () => {
    const policy = createAaisContentSecurityPolicy({
      nonce: "test-nonce",
      env: { NODE_ENV: "production" } as NodeJS.ProcessEnv,
    });

    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self' 'nonce-test-nonce' 'strict-dynamic'");
    expect(policy).toContain("style-src 'self' 'nonce-test-nonce'");
    expect(policy).toContain("font-src 'self' data: https://cdn.prod.website-files.com");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).not.toContain("'unsafe-inline'");
    expect(policy)
      .not.toContain("'unsafe-eval'");
  });

  it("keeps development CSP compatible with React debugging", () => {
    const policy = createAaisContentSecurityPolicy({
      nonce: "test-nonce",
      env: { NODE_ENV: "development" } as NodeJS.ProcessEnv,
    });

    expect(policy)
      .toContain("'unsafe-eval'");
    expect(policy)
      .toContain("'unsafe-inline'");
    expect(policy)
      .toContain("ws:");
  });

  it("sets per-request nonce CSP through Next middleware", () => {
    const response = middleware(new Request("http://localhost/login") as never);
    const policy = response.headers.get("content-security-policy") ?? "";

    expect(middlewareConfig.matcher[0].source).toContain("_next/static");
    expect(policy).toContain("script-src 'self' 'nonce-");
    expect(policy).toContain("'strict-dynamic'");
    expect(policy).toContain("style-src 'self' 'nonce-");
  });
});
