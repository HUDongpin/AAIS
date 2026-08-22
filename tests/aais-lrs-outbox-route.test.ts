import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAaisCsrfToken, getAaisCsrfCookieName } from "@/lib/server/aais-csrf";
import { createAaisSessionToken } from "@/lib/server/aais-session";

const flushMock = vi.fn();
const requeueMock = vi.fn();
const monitoringMock = vi.fn();

beforeEach(() => {
  process.env.AAIS_SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
  flushMock.mockReset();
  requeueMock.mockReset();
  monitoringMock.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.resetModules();
  vi.doMock("@/lib/server/aais-learning-store", () => ({
    flushAaisPersistentLrsOutbox: flushMock,
    getAaisDatabaseConfiguration: () => null,
    requeueAaisPersistentLrsDeadLetters: requeueMock,
  }));
  vi.doMock("@/lib/server/aais-monitoring", () => ({
    recordAaisMonitoringIssue: monitoringMock,
  }));
});

afterEach(() => {
  delete process.env.AAIS_SESSION_SECRET;
  delete process.env.AAIS_LRS_OUTBOX_FLUSH_TOKEN;
  delete process.env.CRON_SECRET;
  vi.doUnmock("@/lib/server/aais-learning-store");
  vi.doUnmock("@/lib/server/aais-monitoring");
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("AAIS LRS persistent outbox flush route", () => {
  it("rejects unauthenticated flush attempts", async () => {
    const route = await import("@/app/api/learning/lrs/outbox/flush/route");

    const response = await route.POST(
      new Request("http://localhost/api/learning/lrs/outbox/flush", {
        method: "POST",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      error: {
        code: "AAIS_AUTH_REQUIRED",
        message: "AAIS authentication is required.",
      },
      secrets: "redacted",
    });
    expect(flushMock).not.toHaveBeenCalled();
    expect(readAuditEvents()).toMatchObject([
      {
        type: "aais.audit",
        event: "lrs_outbox_flush",
        outcome: "failure",
        metadata: {
          action: "flush",
          authMode: "none",
          limit: 50,
          errorStatus: 401,
          errorKind: "auth_required",
          secrets: "redacted",
        },
      },
    ]);
  });

  it("requires an admin session and actor-bound CSRF token", async () => {
    const route = await import("@/app/api/learning/lrs/outbox/flush/route");

    const studentResponse = await route.POST(
      new Request("http://localhost/api/learning/lrs/outbox/flush", {
        method: "POST",
        headers: {
          cookie: createAuthedCookie("S001", "student"),
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
      }),
    );

    expect(studentResponse.status).toBe(403);
    expect(flushMock).not.toHaveBeenCalled();

    const adminWithoutCsrf = await route.POST(
      new Request("http://localhost/api/learning/lrs/outbox/flush", {
        method: "POST",
        headers: {
          cookie: createAuthedCookie("admin-a", "admin"),
        },
      }),
    );

    expect(adminWithoutCsrf.status).toBe(403);
    expect(flushMock).not.toHaveBeenCalled();
  });

  it("flushes the persistent outbox for an admin session without leaking provider secrets", async () => {
    flushMock.mockResolvedValue({
      status: "sent",
      sent: 3,
      failed: 0,
      deferred: 0,
      batches: 1,
      stoppedReason: "drained",
      hasMore: false,
      secrets: "redacted",
      providerSecret: "lrs-secret-that-must-not-leak",
    });
    const route = await import("@/app/api/learning/lrs/outbox/flush/route");

    const response = await route.POST(
      new Request("http://localhost/api/learning/lrs/outbox/flush?limit=25", {
        method: "POST",
        headers: {
          cookie: createAuthedCookie("admin-a", "admin"),
          "x-aais-csrf": createAaisCsrfToken("admin-a"),
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.revalidate).toBe(0);
    expect(route.runtime).toBe("nodejs");
    expect(route.maxDuration).toBe(120);
    expect(flushMock).toHaveBeenCalledWith({ limit: 25 });
    expect(body).toMatchObject({
      action: "flush",
      authorization: {
        mode: "admin-session",
      },
      outbox: {
        status: "sent",
        sent: 3,
        failed: 0,
        deferred: 0,
        batches: 1,
        stoppedReason: "drained",
        hasMore: false,
        secrets: "redacted",
      },
      secrets: "redacted",
    });
    expect(JSON.stringify(body)).not.toContain("lrs-secret-that-must-not-leak");
    expect(readAuditEvents()).toMatchObject([
      {
        type: "aais.audit",
        event: "lrs_outbox_flush",
        actorId: expect.stringMatching(/^actor:[a-f0-9]{16}$/),
        actorIdRedaction: "sha256-16",
        outcome: "success",
        metadata: {
          action: "flush",
          authMode: "admin-session",
          limit: 25,
          status: "sent",
          sent: 3,
          failed: 0,
          secrets: "redacted",
        },
      },
    ]);
    expect(JSON.stringify(readAuditEvents())).not.toContain("admin-a");
  });

  it("requeues dead-letter rows for an admin session without exposing payloads", async () => {
    requeueMock.mockResolvedValue({
      status: "requeued",
      requeued: 4,
      secrets: "redacted",
      payload: "raw learner payload must not leak",
    });
    const route = await import("@/app/api/learning/lrs/outbox/flush/route");

    const response = await route.POST(
      new Request("http://localhost/api/learning/lrs/outbox/flush?action=requeue-dead-letter&limit=10", {
        method: "POST",
        headers: {
          cookie: createAuthedCookie("admin-a", "admin"),
          "x-aais-csrf": createAaisCsrfToken("admin-a"),
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(requeueMock).toHaveBeenCalledWith({ limit: 10 });
    expect(flushMock).not.toHaveBeenCalled();
    expect(body).toEqual({
      action: "requeue-dead-letter",
      authorization: {
        mode: "admin-session",
      },
      outbox: {
        status: "requeued",
        requeued: 4,
        secrets: "redacted",
      },
      secrets: "redacted",
    });
    expect(JSON.stringify(body)).not.toContain("raw learner payload must not leak");
    const auditEvents = readAuditEvents();
    expect(auditEvents).toMatchObject([
      {
        type: "aais.audit",
        event: "lrs_outbox_requeue_dead_letter",
        actorId: expect.stringMatching(/^actor:[a-f0-9]{16}$/),
        actorIdRedaction: "sha256-16",
        outcome: "success",
        metadata: {
          action: "requeue-dead-letter",
          authMode: "admin-session",
          limit: 10,
          status: "requeued",
          requeued: 4,
          secrets: "redacted",
        },
      },
    ]);
    expect(JSON.stringify(auditEvents)).not.toContain("admin-a");
    expect(JSON.stringify(auditEvents)).not.toContain("raw learner payload must not leak");
  });

  it("accepts a configured bearer token for scheduled outbox drains", async () => {
    process.env.AAIS_LRS_OUTBOX_FLUSH_TOKEN = "scheduled-flush-token-with-at-least-32-characters";
    flushMock.mockResolvedValue({
      status: "partial",
      sent: 2,
      failed: 1,
      deferred: 7,
      batches: 4,
      stoppedReason: "budget_exhausted",
      hasMore: true,
      secrets: "redacted",
    });
    const route = await import("@/app/api/learning/lrs/outbox/flush/route");

    const response = await route.POST(
      new Request("http://localhost/api/learning/lrs/outbox/flush?limit=5000", {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.AAIS_LRS_OUTBOX_FLUSH_TOKEN}`,
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(flushMock).toHaveBeenCalledWith({ limit: 200 });
    expect(body.authorization.mode).toBe("bearer-token");
    expect(body.outbox).toMatchObject({
      deferred: 7,
      batches: 4,
      stoppedReason: "budget_exhausted",
      hasMore: true,
    });
    expect(JSON.stringify(body)).not.toContain(process.env.AAIS_LRS_OUTBOX_FLUSH_TOKEN);
    expect(monitoringMock).toHaveBeenCalledWith(expect.objectContaining({
      event: "aais.lrs_outbox.degraded",
      message: "AAIS LRS outbox flush partial",
      route: "/api/learning/lrs/outbox/flush",
      tags: expect.objectContaining({
        "aais.auth_mode": "bearer-token",
        "aais.outbox_action": "flush",
        "aais.outbox_status": "partial",
      }),
      extra: expect.objectContaining({
        authMode: "bearer-token",
        failed: 1,
        secrets: "redacted",
      }),
    }));
    expect(JSON.stringify(monitoringMock.mock.calls)).not.toContain(process.env.AAIS_LRS_OUTBOX_FLUSH_TOKEN);
    const auditEvents = readAuditEvents();
    expect(auditEvents).toMatchObject([
      {
        event: "lrs_outbox_flush",
        outcome: "failure",
        metadata: {
          action: "flush",
          authMode: "bearer-token",
          limit: 200,
          status: "partial",
          sent: 2,
          failed: 1,
          secrets: "redacted",
        },
      },
    ]);
    expect(JSON.stringify(auditEvents)).not.toContain(process.env.AAIS_LRS_OUTBOX_FLUSH_TOKEN);
  });

  it("does not accept a weak configured worker bearer", async () => {
    process.env.AAIS_LRS_OUTBOX_FLUSH_TOKEN = "x";
    const route = await import("@/app/api/learning/lrs/outbox/flush/route");

    const response = await route.POST(new Request(
      "http://localhost/api/learning/lrs/outbox/flush",
      {
        method: "POST",
        headers: { authorization: "Bearer x" },
      },
    ));

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(flushMock).not.toHaveBeenCalled();
    expect(requeueMock).not.toHaveBeenCalled();
  });

  it("accepts a configured bearer token for dead-letter requeue operations", async () => {
    process.env.AAIS_LRS_OUTBOX_FLUSH_TOKEN = "scheduled-flush-token-with-at-least-32-characters";
    requeueMock.mockResolvedValue({
      status: "empty",
      requeued: 0,
      secrets: "redacted",
    });
    const route = await import("@/app/api/learning/lrs/outbox/flush/route");

    const response = await route.POST(
      new Request("http://localhost/api/learning/lrs/outbox/flush?action=requeue-dead-letter&limit=5000", {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.AAIS_LRS_OUTBOX_FLUSH_TOKEN}`,
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(requeueMock).toHaveBeenCalledWith({ limit: 200 });
    expect(body).toMatchObject({
      action: "requeue-dead-letter",
      authorization: {
        mode: "bearer-token",
      },
      outbox: {
        status: "empty",
        requeued: 0,
        secrets: "redacted",
      },
      secrets: "redacted",
    });
    expect(JSON.stringify(body)).not.toContain(process.env.AAIS_LRS_OUTBOX_FLUSH_TOKEN);
    const auditEvents = readAuditEvents();
    expect(auditEvents).toMatchObject([
      {
        event: "lrs_outbox_requeue_dead_letter",
        outcome: "success",
        metadata: {
          action: "requeue-dead-letter",
          authMode: "bearer-token",
          limit: 200,
          status: "empty",
          requeued: 0,
          secrets: "redacted",
        },
      },
    ]);
    expect(JSON.stringify(auditEvents)).not.toContain(process.env.AAIS_LRS_OUTBOX_FLUSH_TOKEN);
  });

  it("accepts Vercel Cron GET requests signed with CRON_SECRET", async () => {
    process.env.CRON_SECRET = "vercel-cron-secret-with-at-least-32-characters";
    flushMock.mockResolvedValue({
      status: "sent",
      sent: 2,
      failed: 0,
      secrets: "redacted",
    });
    const route = await import("@/app/api/learning/lrs/outbox/flush/route");

    const response = await route.GET(
      new Request("http://localhost/api/learning/lrs/outbox/flush", {
        method: "GET",
        headers: {
          authorization: `Bearer ${process.env.CRON_SECRET}`,
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(flushMock).toHaveBeenCalledWith({ limit: 50 });
    expect(body.authorization.mode).toBe("bearer-token");
    expect(JSON.stringify(body)).not.toContain(process.env.CRON_SECRET);
  });

  it("rejects unsigned Vercel Cron GET requests", async () => {
    process.env.CRON_SECRET = "vercel-cron-secret-with-at-least-32-characters";
    const route = await import("@/app/api/learning/lrs/outbox/flush/route");

    const response = await route.GET(
      new Request("http://localhost/api/learning/lrs/outbox/flush", {
        method: "GET",
      }),
    );

    expect(response.status).toBe(403);
    expect(flushMock).not.toHaveBeenCalled();
  });

  it("does not allow GET requests to requeue dead-letter rows", async () => {
    process.env.CRON_SECRET = "vercel-cron-secret-with-at-least-32-characters";
    const route = await import("@/app/api/learning/lrs/outbox/flush/route");

    const response = await route.GET(
      new Request("http://localhost/api/learning/lrs/outbox/flush?action=requeue-dead-letter", {
        method: "GET",
        headers: {
          authorization: `Bearer ${process.env.CRON_SECRET}`,
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "AAIS_LRS_OUTBOX_ACTION_UNSUPPORTED",
        message: "AAIS LRS outbox action is not supported.",
      },
      secrets: "redacted",
    });
    expect(JSON.stringify(body)).not.toContain("requeue-dead-letter");
    expect(flushMock).not.toHaveBeenCalled();
    expect(requeueMock).not.toHaveBeenCalled();
    expect(readAuditEvents()).toMatchObject([
      {
        event: "lrs_outbox_requeue_dead_letter",
        outcome: "failure",
        metadata: {
          action: "requeue-dead-letter",
          authMode: "bearer-token",
          limit: 50,
          errorStatus: 400,
          errorKind: "unsupported_action",
          secrets: "redacted",
        },
      },
    ]);
  });

  it("still allows an admin session when the scheduled bearer token is configured", async () => {
    process.env.AAIS_LRS_OUTBOX_FLUSH_TOKEN = "scheduled-flush-token-with-at-least-32-characters";
    flushMock.mockResolvedValue({
      status: "sent",
      sent: 1,
      failed: 0,
      secrets: "redacted",
    });
    const route = await import("@/app/api/learning/lrs/outbox/flush/route");

    const response = await route.POST(
      new Request("http://localhost/api/learning/lrs/outbox/flush", {
        method: "POST",
        headers: {
          cookie: createAuthedCookie("admin-a", "admin"),
          "x-aais-csrf": createAaisCsrfToken("admin-a"),
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.authorization.mode).toBe("admin-session");
    expect(flushMock).toHaveBeenCalledWith({ limit: 50 });
    expect(monitoringMock).not.toHaveBeenCalled();
  });

  it("returns 503 when persistent outbox storage is not configured", async () => {
    flushMock.mockResolvedValue({
      status: "not_configured",
      sent: 0,
      secrets: "redacted",
    });
    const route = await import("@/app/api/learning/lrs/outbox/flush/route");

    const response = await route.POST(
      new Request("http://localhost/api/learning/lrs/outbox/flush", {
        method: "POST",
        headers: {
          cookie: createAuthedCookie("admin-a", "admin"),
          "x-aais-csrf": createAaisCsrfToken("admin-a"),
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.outbox.status).toBe("not_configured");
    expect(JSON.stringify(body)).not.toContain("test-session-secret");
    expect(monitoringMock).toHaveBeenCalledWith(expect.objectContaining({
      event: "aais.lrs_outbox.degraded",
      message: "AAIS LRS outbox flush not_configured",
      status: 503,
      route: "/api/learning/lrs/outbox/flush",
      tags: expect.objectContaining({
        "aais.auth_mode": "admin-session",
        "aais.outbox_action": "flush",
        "aais.outbox_status": "not_configured",
      }),
      extra: expect.objectContaining({
        authMode: "admin-session",
        sent: 0,
        secrets: "redacted",
      }),
    }));
    expect(JSON.stringify(monitoringMock.mock.calls)).not.toContain("test-session-secret");
  });
});

function createAuthedCookie(id: string, role: "student" | "teacher" | "admin") {
  const csrfToken = createAaisCsrfToken(id);
  const sessionToken = createAaisSessionToken({
    id,
    role,
    displayName: id,
  }, new Date(), { authSource: "development" });
  return `aais_session=${sessionToken}; ${getAaisCsrfCookieName()}=${csrfToken}`;
}

function readAuditEvents() {
  return vi.mocked(console.info).mock.calls.map((call) => JSON.parse(String(call[0])));
}
