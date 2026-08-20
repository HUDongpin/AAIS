import { afterEach, describe, expect, it, vi } from "vitest";

describe("Playwright deployed Preview configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses Vercel automation bypass headers only for deployed E2E", async () => {
    vi.stubEnv("AAIS_E2E_BASE_URL", "https://preview.example.vercel.app");
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "test-bypass-secret");

    const { default: config } = await import("../playwright.config.ts");

    expect(config.use?.extraHTTPHeaders).toEqual({
      "x-vercel-protection-bypass": "test-bypass-secret",
      "x-vercel-set-bypass-cookie": "true",
    });
    expect(config.use?.trace).toBe("off");
  });

  it("keeps local E2E free of Vercel-only headers", async () => {
    vi.stubEnv("AAIS_E2E_BASE_URL", "");
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "");

    const { default: config } = await import("../playwright.config.ts");

    expect(config.use?.extraHTTPHeaders).toBeUndefined();
    expect(config.use?.trace).toBe("on-first-retry");
    expect(config.webServer?.env).toMatchObject({
      AAIS_NEXT_DIST_DIR: ".next-e2e",
      NODE_ENV: "development",
    });
  });
});
