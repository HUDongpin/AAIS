import { describe, expect, it, vi } from "vitest";

describe("AAIS Sentry Next config", () => {
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
});
