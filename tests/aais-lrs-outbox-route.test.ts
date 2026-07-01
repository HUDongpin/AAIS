import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAaisCsrfToken, getAaisCsrfCookieName } from "@/lib/server/aais-csrf";
import { createAaisSessionToken } from "@/lib/server/aais-session";

const flushMock = vi.fn();

beforeEach(() => {
  process.env.AAIS_SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
  flushMock.mockReset();
  vi.resetModules();
  vi.doMock("@/lib/server/aais-learning-store", () => ({
    flushAaisPersistentLrsOutbox: flushMock,
  }));
});

afterEach(() => {
  delete process.env.AAIS_SESSION_SECRET;
  delete process.env.AAIS_LRS_OUTBOX_FLUSH_TOKEN;
  delete process.env.CRON_SECRET;
  vi.doUnmock("@/lib/server/aais-learning-store");
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
      error: "AAIS authentication is required.",
      secrets: "redacted",
    });
    expect(flushMock).not.toHaveBeenCalled();
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
    expect(flushMock).toHaveBeenCalledWith({ limit: 25 });
    expect(body).toMatchObject({
      authorization: {
        mode: "admin-session",
      },
      outbox: {
        status: "sent",
        sent: 3,
        failed: 0,
        secrets: "redacted",
      },
      secrets: "redacted",
    });
    expect(JSON.stringify(body)).not.toContain("lrs-secret-that-must-not-leak");
  });

  it("accepts a configured bearer token for scheduled outbox drains", async () => {
    process.env.AAIS_LRS_OUTBOX_FLUSH_TOKEN = "scheduled-flush-token-with-at-least-32-characters";
    flushMock.mockResolvedValue({
      status: "partial",
      sent: 2,
      failed: 1,
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

    expect(response.status).toBe(200);
    expect(flushMock).toHaveBeenCalledWith({ limit: 200 });
    expect(body.authorization.mode).toBe("bearer-token");
    expect(JSON.stringify(body)).not.toContain(process.env.AAIS_LRS_OUTBOX_FLUSH_TOKEN);
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
  });
});

function createAuthedCookie(id: string, role: "student" | "teacher" | "admin") {
  const csrfToken = createAaisCsrfToken(id);
  const sessionToken = createAaisSessionToken({
    id,
    role,
    displayName: id,
  });
  return `aais_session=${sessionToken}; ${getAaisCsrfCookieName()}=${csrfToken}`;
}
