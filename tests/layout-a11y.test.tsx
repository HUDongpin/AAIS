import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { metadata } from "@/app/layout";
import { shouldEnableAaisVercelAnalytics } from "@/lib/aais-vercel-analytics";

describe("AAIS root accessibility affordances", () => {
  it("uses CAAIS as the browser-tab title", () => {
    expect(metadata.title).toBe("CAAIS");
  });

  it("provides a keyboard skip link to the shared content target", () => {
    const layout = readFileSync("src/app/layout.tsx", "utf8");
    const globalCss = readFileSync("src/app/globals.css", "utf8");

    expect(layout).toContain('href="#aais-main-content"');
    expect(layout).toContain('id="aais-main-content"');
    expect(layout).toContain("跳到主要内容");
    expect(globalCss).toContain(".aais-skip-link");
    expect(globalCss).toContain(".aais-skip-link:focus");
    expect(globalCss).toContain("translateY(0)");
  });

  it("disables Vercel Web Analytics for every research activation signal", () => {
    expect(shouldEnableAaisVercelAnalytics({})).toBe(false);
    expect(shouldEnableAaisVercelAnalytics({
      VERCEL: "1",
      AAIS_RESEARCH_MODE: "true",
    }))
      .toBe(false);
    expect(shouldEnableAaisVercelAnalytics({
      AAIS_DEPLOYMENT_PROVIDER: "vercel",
      AAIS_RESEARCH_REQUIRED: "TRUE",
    }))
      .toBe(false);
    expect(shouldEnableAaisVercelAnalytics({
      VERCEL: "1",
      AAIS_RESEARCH_ENVIRONMENT: "research",
    }))
      .toBe(false);
    expect(shouldEnableAaisVercelAnalytics({
      AAIS_DEPLOYMENT_PROVIDER: "vercel",
      AAIS_RESEARCH_MODE: "false",
      AAIS_RESEARCH_REQUIRED: "false",
      AAIS_RESEARCH_ENVIRONMENT: "production",
    })).toBe(true);
    expect(shouldEnableAaisVercelAnalytics({
      AAIS_DEPLOYMENT_PROVIDER: "aliyun",
    })).toBe(false);
  });
});
