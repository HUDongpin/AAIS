import { readFile } from "node:fs/promises";
import path from "node:path";
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
    expect(policy).toContain("style-src-attr 'none'");
    expect(policy).toContain("font-src 'self' data:");
    expect(policy).not.toContain("cdn.prod.website-files.com");
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

  it("keeps the controlled research browser on same-origin connections", () => {
    const policy = createAaisContentSecurityPolicy({
      nonce: "test-nonce",
      env: {
        NODE_ENV: "production",
        AAIS_RESEARCH_MODE: "true",
        AAIS_RESEARCH_REQUIRED: "true",
      } as NodeJS.ProcessEnv,
    });

    expect(policy).toContain("connect-src 'self'");
    expect(policy).not.toContain("connect-src 'self' https:");
    expect(policy).not.toContain("cdn.prod.website-files.com");
  });

  it("does not load runtime fonts or CSS assets from remote origins", async () => {
    const css = await readFile(path.join(process.cwd(), "src/app/globals.css"), "utf8");

    expect(css).not.toMatch(/url\(\s*["']?https?:/i);
    expect(css).not.toContain("cdn.prod.website-files.com");
  });

  it("keeps production UI surfaces free of CSP-blocked inline style writes", async () => {
    const sourcePaths = [
      "src/components/pages/login-page.tsx",
      "src/components/pages/login/login-design.tsx",
      "src/components/pages/learning-page.tsx",
      "src/components/pages/learning/document-editor.tsx",
      "src/components/pages/learning/document-editor-dom.ts",
      "src/components/pages/learning/learning-top-bar.tsx",
      "src/components/pages/learning/use-content-panel-resize.ts",
    ];

    for (const sourcePath of sourcePaths) {
      const source = await readFile(path.join(process.cwd(), sourcePath), "utf8");
      expect(source, sourcePath).not.toMatch(/\bstyle\s*=\s*\{/);
      expect(source, sourcePath).not.toMatch(/\.style\.[A-Za-z_$][\w$]*\s*=(?!=)/);
      expect(source, sourcePath).not.toMatch(/setAttribute\(\s*["']style["']/);
    }
  });

  it("sets per-request nonce CSP through Next middleware", () => {
    const response = middleware(new Request("http://localhost/login") as never);
    const policy = response.headers.get("content-security-policy") ?? "";

    expect(middlewareConfig.matcher[0].source).toContain("_next/static");
    expect(policy).toContain("script-src 'self' 'nonce-");
    expect(policy).toContain("'strict-dynamic'");
    expect(policy).toContain("style-src 'self' 'nonce-");
    expect(policy).toContain("style-src-attr 'none'");
  });
});
