import { describe, expect, it } from "vitest";
import nextConfig from "@/../next.config";

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
    expect(headers["content-security-policy"]).toContain("default-src 'self'");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["content-security-policy"]).toContain("base-uri 'self'");
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  });
});
