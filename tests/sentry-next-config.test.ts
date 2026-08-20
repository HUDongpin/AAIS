import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("AAIS Sentry Next config", () => {
  afterEach(() => {
    vi.doUnmock("@sentry/nextjs");
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("registers transaction and span sanitizers in every Sentry runtime", () => {
    for (const fileName of [
      "sentry.server.config.ts",
      "sentry.edge.config.ts",
      "instrumentation-client.ts",
    ]) {
      const source = readFileSync(resolve(process.cwd(), fileName), "utf8");
      expect(source).toMatch(
        /beforeSendTransaction:\s*sanitizeAaisSentryTransaction/,
      );
      expect(source).toMatch(/beforeSendSpan:\s*sanitizeAaisSentrySpan/);
    }
  });

  it("enables Vercel cron monitor instrumentation for configured crons", async () => {
    const withSentryConfig = vi.fn((config, sentryOptions) => ({
      ...config,
      __sentryOptionsForTest: sentryOptions,
    }));
    vi.doMock("@sentry/nextjs", () => ({
      withSentryConfig,
    }));
    vi.resetModules();

    const nextConfig = (await import("@/../next.config")).default as {
      __sentryOptionsForTest?: {
        _experimental?: {
          vercelCronsMonitoring?: boolean;
        };
      };
    };

    expect(withSentryConfig).toHaveBeenCalledOnce();
    expect(nextConfig.__sentryOptionsForTest?._experimental?.vercelCronsMonitoring).toBe(true);
  });

  it("uses a separate Next build directory only for the local browser harness", async () => {
    vi.stubEnv("AAIS_NEXT_DIST_DIR", ".next-e2e");
    vi.resetModules();

    const nextConfig = (await import("@/../next.config")).default;

    expect(nextConfig.distDir).toBe(".next-e2e");
  });
});
