import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  flush: vi.fn(),
  audit: vi.fn(),
  monitoring: vi.fn(),
}));

vi.mock("@/lib/server/aais-auth-delivery", () => ({
  flushAaisAuthEmailOutbox: mocks.flush,
  isAaisAuthDeliveryConfigurationError: (error: unknown) =>
    error instanceof Error && error.name === "AaisAuthDeliveryConfigurationError",
  isAaisAuthEmailOutboxStoreError: (error: unknown) =>
    error instanceof Error && error.name === "AaisAuthEmailOutboxStoreError",
}));

vi.mock("@/lib/server/aais-audit-log", () => ({
  recordAaisAuditEvent: mocks.audit,
}));

vi.mock("@/lib/server/aais-monitoring", () => ({
  recordAaisMonitoringIssue: mocks.monitoring,
}));

const cronSecret = "cron-auth-email-outbox-secret-0123456789-ABCDEFG";
const dedicatedSecret = "dedicated-auth-email-worker-0123456789-ABCDEFG";

beforeEach(() => {
  mocks.flush.mockReset();
  mocks.audit.mockReset();
  mocks.monitoring.mockReset();
  mocks.flush.mockResolvedValue({
    status: "pass",
    claimed: 1,
    sent: 1,
    retry: 0,
    deadLetter: 0,
    stale: 0,
    deferred: 0,
    hasMore: false,
    stoppedReason: "empty",
    secrets: "redacted",
  });
  vi.stubEnv("CRON_SECRET", cronSecret);
  vi.stubEnv("AAIS_AUTH_EMAIL_OUTBOX_FLUSH_TOKEN", dedicatedSecret);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("AAIS authentication email outbox worker route", () => {
  it.each([
    ["GET", cronSecret],
    ["POST", dedicatedSecret],
  ])("accepts a strong bearer for %s", async (method, secret) => {
    const route = await import("@/app/api/auth/email-outbox/flush/route");
    const response = await route[method as "GET" | "POST"](new Request(
      "https://aais.example.test/api/auth/email-outbox/flush?token=ignored",
      {
        method,
        headers: { authorization: `Bearer ${secret}` },
      },
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      status: "pass",
      sent: 1,
      secrets: "redacted",
    });
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(route.maxDuration).toBe(120);
  });

  it.each([
    undefined,
    "",
    "Bearer wrong-auth-email-outbox-secret-0123456789-ABCDEFG",
    `Basic ${cronSecret}`,
    `Bearer ${cronSecret} trailing`,
  ])("rejects missing or malformed bearer credentials without flushing", async (authorization) => {
    const { GET } = await import("@/app/api/auth/email-outbox/flush/route");
    const headers: Record<string, string> = authorization === undefined
      ? {}
      : { authorization };
    const response = await GET(new Request(
      `https://aais.example.test/api/auth/email-outbox/flush?token=${cronSecret}`,
      { headers },
    ));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.flush).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain(cronSecret);
  });

  it("rejects weak configured secrets", async () => {
    vi.stubEnv("CRON_SECRET", "weak");
    vi.stubEnv("AAIS_AUTH_EMAIL_OUTBOX_FLUSH_TOKEN", "also-weak");
    const { GET } = await import("@/app/api/auth/email-outbox/flush/route");
    const response = await GET(new Request(
      "https://aais.example.test/api/auth/email-outbox/flush",
      { headers: { authorization: "Bearer weak" } },
    ));

    expect(response.status).toBe(401);
    expect(mocks.flush).not.toHaveBeenCalled();
  });

  it("maps configuration failures to a redacted 503", async () => {
    const error = new Error("secret provider detail");
    error.name = "AaisAuthDeliveryConfigurationError";
    mocks.flush.mockRejectedValue(error);
    const { POST } = await import("@/app/api/auth/email-outbox/flush/route");
    const response = await POST(new Request(
      "https://aais.example.test/api/auth/email-outbox/flush",
      {
        method: "POST",
        headers: { authorization: `Bearer ${dedicatedSecret}` },
      },
    ));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.stringify(await response.json())).not.toContain("provider detail");
  });

  it("returns a non-success status when the worker creates dead letters", async () => {
    mocks.flush.mockResolvedValue({
      status: "pass",
      claimed: 1,
      sent: 0,
      retry: 0,
      deadLetter: 1,
      stale: 0,
      deferred: 0,
      hasMore: false,
      stoppedReason: "empty",
      secrets: "redacted",
    });
    const { POST } = await import("@/app/api/auth/email-outbox/flush/route");

    const response = await POST(new Request(
      "https://aais.example.test/api/auth/email-outbox/flush",
      {
        method: "POST",
        headers: { authorization: `Bearer ${dedicatedSecret}` },
      },
    ));

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      deadLetter: 1,
      secrets: "redacted",
    });
  });

  it("reports retryable provider failures as degraded instead of false-green", async () => {
    mocks.flush.mockResolvedValue({
      status: "pass",
      claimed: 1,
      sent: 0,
      retry: 1,
      deadLetter: 0,
      stale: 0,
      deferred: 0,
      hasMore: false,
      stoppedReason: "empty",
      secrets: "redacted",
    });
    const { POST } = await import("@/app/api/auth/email-outbox/flush/route");

    const response = await POST(new Request(
      "https://aais.example.test/api/auth/email-outbox/flush",
      {
        method: "POST",
        headers: { authorization: `Bearer ${dedicatedSecret}` },
      },
    ));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      retry: 1,
      deadLetter: 0,
      secrets: "redacted",
    });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      event: "auth.email_outbox.flush",
      outcome: "failure",
    }));
    expect(mocks.monitoring).toHaveBeenCalledWith(expect.objectContaining({
      event: "aais.auth_email_outbox.degraded",
      tags: { "aais.outbox_status": "retry" },
      extra: expect.objectContaining({
        retry: 1,
        deadLetter: 0,
        secrets: "redacted",
      }),
    }));
  });
});
