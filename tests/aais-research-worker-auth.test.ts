// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAaisCsrfToken } from "@/lib/server/aais-csrf";
import { createAaisSessionToken } from "@/lib/server/aais-session";

const storeFactory = vi.hoisted(() => vi.fn());
const monitoringMock = vi.hoisted(() => vi.fn());
const auditMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/aais-research-store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/server/aais-research-store")>();
  return {
    ...original,
    getAaisResearchStore: storeFactory,
  };
});

vi.mock("@/lib/server/aais-monitoring", () => ({
  recordAaisMonitoringIssue: monitoringMock,
}));

vi.mock("@/lib/server/aais-audit-log", () => ({
  recordAaisAuditEvent: auditMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AAIS_RESEARCH_MODE = "true";
  process.env.AAIS_SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
});

afterEach(() => {
  delete process.env.AAIS_RESEARCH_MODE;
  delete process.env.AAIS_RESEARCH_LRS_OUTBOX_FLUSH_TOKEN;
  delete process.env.AAIS_RESEARCH_RETENTION_TOKEN;
  delete process.env.AAIS_SESSION_SECRET;
});

describe("AAIS research worker authorization", () => {
  it("fails closed before opening the store when the LRS flush token is weak", async () => {
    process.env.AAIS_RESEARCH_LRS_OUTBOX_FLUSH_TOKEN = "x";
    const { POST } = await import("@/app/api/research/lrs/flush/route");

    const response = await POST(new Request("http://localhost/api/research/lrs/flush", {
      method: "POST",
      headers: { authorization: "Bearer x" },
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "AAIS_RESEARCH_NOT_CONFIGURED" },
      secrets: "redacted",
    });
    expect(storeFactory).not.toHaveBeenCalled();
  });

  it("fails closed before opening the store when the retention token is weak", async () => {
    process.env.AAIS_RESEARCH_RETENTION_TOKEN = "x";
    const { POST } = await import("@/app/api/research/retention/route");

    const response = await POST(new Request("http://localhost/api/research/retention", {
      method: "POST",
      headers: { authorization: "Bearer x" },
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "AAIS_RESEARCH_NOT_CONFIGURED" },
      secrets: "redacted",
    });
    expect(storeFactory).not.toHaveBeenCalled();
  });

  it("caps a research LRS invocation to a small resumable batch", async () => {
    const token = "research-worker-token-1234567890abcdef";
    process.env.AAIS_RESEARCH_LRS_OUTBOX_FLUSH_TOKEN = token;
    const flushLrsOutbox = vi.fn(async () => ({
      selected: 25,
      sent: 25,
      retried: 0,
      deadLetter: 0,
      stoppedReason: "limit",
      hasMore: true,
    }));
    storeFactory.mockReturnValue({ flushLrsOutbox });
    const route = await import("@/app/api/research/lrs/flush/route");

    const response = await route.POST(new Request(
      "http://localhost/api/research/lrs/flush?limit=10000",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.revalidate).toBe(0);
    expect(route.runtime).toBe("nodejs");
    expect(route.maxDuration).toBeGreaterThan(20);
    expect(flushLrsOutbox).toHaveBeenCalledWith(25);
    await expect(response.json()).resolves.toMatchObject({
      result: { stoppedReason: "limit", hasMore: true },
      secrets: "redacted",
    });
  });

  it("returns a non-green response and records monitoring when a flush dead-letters a row", async () => {
    const token = "research-worker-token-1234567890abcdef";
    process.env.AAIS_RESEARCH_LRS_OUTBOX_FLUSH_TOKEN = token;
    const flushLrsOutbox = vi.fn(async () => ({
      selected: 1,
      sent: 0,
      retried: 0,
      deadLetter: 1,
      stoppedReason: "limit",
      hasMore: true,
    }));
    storeFactory.mockReturnValue({ flushLrsOutbox });
    const { POST } = await import("@/app/api/research/lrs/flush/route");

    const response = await POST(new Request(
      "http://localhost/api/research/lrs/flush?action=events",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    ));

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(monitoringMock).toHaveBeenCalledWith(expect.objectContaining({
      event: "aais.research_lrs.degraded",
      status: 502,
      route: "/api/research/lrs/flush",
    }));
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      event: "research_lrs_flush",
      outcome: "failure",
    }));
  });

  it.each([
    {
      action: "events",
      storeMethod: "flushLrsOutbox",
      result: {
        selected: 1,
        sent: 0,
        retried: 1,
        deadLetter: 0,
        stoppedReason: "limit",
        hasMore: true,
      },
    },
    {
      action: "deletions",
      storeMethod: "flushLrsDeletions",
      result: {
        selected: 1,
        confirmed: 0,
        retried: 1,
        deadLetter: 0,
        stoppedReason: "limit",
        hasMore: true,
      },
    },
  ])("returns 502 and monitoring when a provider 503 leaves $action work retryable", async ({
    action,
    storeMethod,
    result,
  }) => {
    const token = "research-worker-token-1234567890abcdef";
    process.env.AAIS_RESEARCH_LRS_OUTBOX_FLUSH_TOKEN = token;
    const flush = vi.fn(async () => result);
    storeFactory.mockReturnValue({ [storeMethod]: flush });
    const { POST } = await import("@/app/api/research/lrs/flush/route");

    const response = await POST(new Request(
      `http://localhost/api/research/lrs/flush?action=${action}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    ));

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const responseBody = await response.json();
    expect(responseBody).toMatchObject({
      action,
      authorization: { mode: "research-bearer" },
      result: { retried: 1, deadLetter: 0 },
      secrets: "redacted",
    });
    expect(JSON.stringify(responseBody)).not.toContain(token);
    expect(monitoringMock).toHaveBeenCalledWith(expect.objectContaining({
      event: "aais.research_lrs.degraded",
      status: 502,
      route: "/api/research/lrs/flush",
      extra: expect.objectContaining({ retried: 1, deadLetter: 0, secrets: "redacted" }),
    }));
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      event: "research_lrs_flush",
      outcome: "failure",
      metadata: expect.objectContaining({ retried: 1, deadLetter: 0, secrets: "redacted" }),
    }));
  });

  it("requeues bounded event dead letters with the strong research bearer", async () => {
    const token = "research-worker-token-1234567890abcdef";
    process.env.AAIS_RESEARCH_LRS_OUTBOX_FLUSH_TOKEN = token;
    const requeueLrsOutboxDeadLetters = vi.fn(async () => ({
      selected: 2,
      requeued: 2,
      rejected: 0,
      stoppedReason: "empty",
      hasMore: false,
    }));
    storeFactory.mockReturnValue({ requeueLrsOutboxDeadLetters });
    const { POST } = await import("@/app/api/research/lrs/flush/route");

    const response = await POST(new Request(
      "http://localhost/api/research/lrs/flush?action=requeue-events&limit=2",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    ));

    expect(response.status).toBe(200);
    expect(requeueLrsOutboxDeadLetters).toHaveBeenCalledWith(2);
    await expect(response.json()).resolves.toMatchObject({
      action: "requeue-events",
      authorization: { mode: "research-bearer" },
      result: { requeued: 2, rejected: 0 },
      secrets: "redacted",
    });
  });

  it("allows only an admin session with actor-bound CSRF to requeue deletion dead letters", async () => {
    const actor = {
      id: "research-recovery-admin",
      role: "admin" as const,
      displayName: "Research Recovery Admin",
    };
    const session = createAaisSessionToken(actor, new Date(), { authSource: "development" });
    const csrf = createAaisCsrfToken(actor.id);
    const requeueLrsDeletionDeadLetters = vi.fn(async () => ({
      selected: 1,
      requeued: 1,
      rejected: 0,
      stoppedReason: "limit",
      hasMore: true,
    }));
    storeFactory.mockReturnValue({ requeueLrsDeletionDeadLetters });
    const { POST } = await import("@/app/api/research/lrs/flush/route");

    const withoutCsrf = await POST(new Request(
      "http://localhost/api/research/lrs/flush?action=requeue-deletions",
      {
        method: "POST",
        headers: { cookie: `aais_session=${session}` },
      },
    ));
    expect(withoutCsrf.status).toBe(403);
    expect(requeueLrsDeletionDeadLetters).not.toHaveBeenCalled();

    const researcher = {
      id: "research-recovery-researcher",
      role: "researcher" as const,
      displayName: "Research Recovery Researcher",
    };
    const researcherSession = createAaisSessionToken(
      researcher,
      new Date(),
      { authSource: "development" },
    );
    const researcherCsrf = createAaisCsrfToken(researcher.id);
    const nonAdmin = await POST(new Request(
      "http://localhost/api/research/lrs/flush?action=requeue-deletions",
      {
        method: "POST",
        headers: {
          cookie: `aais_session=${researcherSession}; aais_csrf=${researcherCsrf}`,
          "x-aais-csrf": researcherCsrf,
        },
      },
    ));
    expect(nonAdmin.status).toBe(403);
    expect(requeueLrsDeletionDeadLetters).not.toHaveBeenCalled();

    const response = await POST(new Request(
      "http://localhost/api/research/lrs/flush?action=requeue-deletions",
      {
        method: "POST",
        headers: {
          cookie: `aais_session=${session}; aais_csrf=${csrf}`,
          "x-aais-csrf": csrf,
        },
      },
    ));

    expect(response.status).toBe(200);
    expect(requeueLrsDeletionDeadLetters).toHaveBeenCalledWith(10);
    await expect(response.json()).resolves.toMatchObject({
      authorization: { mode: "admin-session" },
      result: { requeued: 1 },
    });
  });

  it("caps a Node retention invocation and exposes a duration above its worker budget", async () => {
    const token = "research-retention-token-1234567890abcdef";
    process.env.AAIS_RESEARCH_RETENTION_TOKEN = token;
    const runRetention = vi.fn(async () => ({
      rawTextDeletedCount: 25,
      stoppedReason: "limit",
      hasMore: true,
    }));
    storeFactory.mockReturnValue({ runRetention });
    const route = await import("@/app/api/research/retention/route");

    const response = await route.POST(new Request(
      "http://localhost/api/research/retention?limit=10000",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    ));

    expect(route.dynamic).toBe("force-dynamic");
    expect(route.runtime).toBe("nodejs");
    expect(route.maxDuration).toBeGreaterThan(20);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(runRetention).toHaveBeenCalledWith(25);
    await expect(response.json()).resolves.toMatchObject({
      result: { stoppedReason: "limit", hasMore: true },
      secrets: "redacted",
    });
  });

  it("returns non-green and records redacted operations signals when retention is blocked", async () => {
    const token = "research-retention-token-1234567890abcdef";
    process.env.AAIS_RESEARCH_RETENTION_TOKEN = token;
    const runRetention = vi.fn(async () => ({
      status: "blocked" as const,
      blockedActiveVisitCount: 0,
      staleRawTextWriteLeaseCount: 1,
      stoppedReason: "empty" as const,
      hasMore: false,
    }));
    storeFactory.mockReturnValue({ runRetention });
    const { POST } = await import("@/app/api/research/retention/route");

    const response = await POST(new Request(
      "http://localhost/api/research/retention",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    ));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      result: {
        status: "blocked",
        blockedActiveVisitCount: 0,
        staleRawTextWriteLeaseCount: 1,
      },
      secrets: "redacted",
    });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      event: "research_retention_blocked",
      outcome: "failure",
      metadata: expect.objectContaining({
        authMode: "research-bearer",
        blockedActiveVisitCount: 0,
        staleRawTextWriteLeaseCount: 1,
        secrets: "redacted",
      }),
    }));
    expect(monitoringMock).toHaveBeenCalledWith(expect.objectContaining({
      event: "aais.research_retention.blocked",
      status: 503,
      route: "/api/research/retention",
      extra: expect.objectContaining({
        blockedActiveVisitCount: 0,
        staleRawTextWriteLeaseCount: 1,
        secrets: "redacted",
      }),
    }));
    const signals = JSON.stringify({
      audit: auditMock.mock.calls,
      monitoring: monitoringMock.mock.calls,
    });
    expect(signals).not.toContain(token);
  });

  it("uses the dedicated default retention batch size", async () => {
    const token = "research-retention-token-1234567890abcdef";
    process.env.AAIS_RESEARCH_RETENTION_TOKEN = token;
    const runRetention = vi.fn(async () => ({
      stoppedReason: "empty",
      hasMore: false,
    }));
    storeFactory.mockReturnValue({ runRetention });
    const { POST } = await import("@/app/api/research/retention/route");

    const response = await POST(new Request(
      "http://localhost/api/research/retention",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    ));

    expect(response.status).toBe(200);
    expect(runRetention).toHaveBeenCalledWith(10);
  });

  it.each(["0", "-1", "1.5", "1e2", "01", "invalid"])(
    "rejects an invalid retention worker limit %s before opening the store",
    async (limit) => {
      const token = "research-retention-token-1234567890abcdef";
      process.env.AAIS_RESEARCH_RETENTION_TOKEN = token;
      const { POST } = await import("@/app/api/research/retention/route");

      const response = await POST(new Request(
        `http://localhost/api/research/retention?limit=${encodeURIComponent(limit)}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        },
      ));

      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(storeFactory).not.toHaveBeenCalled();
    },
  );

  it.each(["0", "-1", "1.5", "1e2", "01", "invalid"])(
    "rejects an invalid LRS worker limit %s before opening the research store",
    async (limit) => {
      const token = "research-worker-token-1234567890abcdef";
      process.env.AAIS_RESEARCH_LRS_OUTBOX_FLUSH_TOKEN = token;
      const { POST } = await import("@/app/api/research/lrs/flush/route");

      const response = await POST(new Request(
        `http://localhost/api/research/lrs/flush?limit=${encodeURIComponent(limit)}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        },
      ));

      expect(response.status).toBe(400);
      expect(storeFactory).not.toHaveBeenCalled();
    },
  );
});
