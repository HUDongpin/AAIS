import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAaisCsrfToken } from "@/lib/server/aais-csrf";

const persistentOutboxStatusMock = vi.fn();
const probeMock = vi.fn();
const sendHealthMock = vi.fn();

beforeEach(() => {
  persistentOutboxStatusMock.mockReset();
  probeMock.mockReset();
  sendHealthMock.mockReset();
  probeMock.mockResolvedValue({
    status: "connected",
    configured: true,
    httpStatus: 200,
  });
  sendHealthMock.mockResolvedValue({
    status: "sent",
    sent: 1,
    httpStatus: 204,
  });
  process.env.AAIS_SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
  for (const key of [
    "AAIS_DATABASE_URL",
    "DATABASE_URL",
    "POSTGRES_URL",
    "POSTGRES_PRISMA_URL",
    "POSTGRES_URL_NO_SSL",
    "DATABASE_URL_UNPOOLED",
    "POSTGRES_URL_NON_POOLING",
  ]) {
    vi.stubEnv(key, "");
  }
  vi.resetModules();
  vi.doMock("@/lib/server/aais-lrs-client", () => ({
    getLrsConfigurationStatus: () => ({
      configured: true,
      requiredEnv: ["LRS_ENDPOINT", "LRS_USERNAME", "LRS_PASSWORD"],
    }),
    getAaisLrsDeliveryQueueStatus: () => ({
      pendingBatches: 0,
      retryBatches: 0,
      deadLetterBatches: 0,
      inFlight: false,
      lastResult: null,
      lastError: null,
      secrets: "redacted",
    }),
    probeAaisLrsConnection: probeMock,
    sendAaisLrsHealthStatement: sendHealthMock,
  }));
  vi.doMock("@/lib/server/aais-learning-store", () => ({
    getAaisPersistentLrsOutboxStatus: persistentOutboxStatusMock,
  }));
});

afterEach(() => {
  vi.doUnmock("@/lib/server/aais-lrs-client");
  vi.doUnmock("@/lib/server/aais-learning-store");
  vi.doUnmock("@/lib/server/aais-request-auth");
  delete process.env.AAIS_SESSION_SECRET;
  delete process.env.AAIS_READINESS_BEARER_TOKEN;
  delete process.env.AAIS_LRS_OUTBOX_FLUSH_TOKEN;
  delete process.env.CRON_SECRET;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("AAIS LRS health route", () => {
  it("reports persistent outbox counts without exposing payloads or secrets", async () => {
    persistentOutboxStatusMock.mockResolvedValue({
      mode: "persistent",
      storage: "postgres",
      configured: true,
      pending: 2,
      retry: 1,
      sent: 7,
      deadLetter: 1,
      total: 11,
      coalescing: {
        enabled: true,
        windowSeconds: 30,
        events: ["artifact_saved", "artifact_edited", "planning_submitted"],
        strategy: "latest-write-wins",
      },
      recovery: {
        deadLetterRequeue: true,
        action: "POST /api/learning/lrs/outbox/flush?action=requeue-dead-letter",
        auth: ["admin-session-csrf", "bearer-token"],
        redaction: "payloads-excluded",
      },
      payload: "raw learner text must not leak",
      secret: "lrs-secret-that-must-not-leak",
      secrets: "redacted",
    });
    vi.stubEnv("AAIS_READINESS_BEARER_TOKEN", "readiness-health-token-with-at-least-32-characters");
    const route = await import("@/app/api/learning/lrs/health/route");

    const response = await route.GET(new Request("http://localhost/api/learning/lrs/health", {
      headers: { authorization: "Bearer readiness-health-token-with-at-least-32-characters" },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.delivery.persistentOutbox).toEqual({
      mode: "persistent",
      storage: "postgres",
      configured: true,
      pending: 2,
      retry: 1,
      sent: 7,
      deadLetter: 1,
      total: 11,
      coalescing: {
        enabled: true,
        windowSeconds: 30,
        events: ["artifact_saved", "artifact_edited", "planning_submitted"],
        strategy: "latest-write-wins",
      },
      recovery: {
        deadLetterRequeue: true,
        action: "POST /api/learning/lrs/outbox/flush?action=requeue-dead-letter",
        auth: ["admin-session-csrf", "bearer-token"],
        redaction: "payloads-excluded",
      },
      secrets: "redacted",
    });
    expect(JSON.stringify(body)).not.toContain("raw learner text must not leak");
    expect(JSON.stringify(body)).not.toContain("lrs-secret-that-must-not-leak");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(probeMock).toHaveBeenCalledWith({ timeoutMs: 5_000 });
    expect(persistentOutboxStatusMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unauthenticated and invalid-bearer reads before probing dependencies", async () => {
    vi.stubEnv("AAIS_READINESS_BEARER_TOKEN", "readiness-health-token-with-at-least-32-characters");
    const route = await import("@/app/api/learning/lrs/health/route");

    const anonymous = await route.GET(new Request("http://localhost/api/learning/lrs/health"));
    const invalid = await route.GET(new Request("http://localhost/api/learning/lrs/health", {
      headers: { authorization: "Bearer wrong-token" },
    }));

    expect(anonymous.status).toBe(401);
    expect(invalid.status).toBe(403);
    expect(probeMock).not.toHaveBeenCalled();
    expect(persistentOutboxStatusMock).not.toHaveBeenCalled();
  });

  it("allows only an operator write bearer or admin session to send a health statement", async () => {
    vi.stubEnv("AAIS_LRS_OUTBOX_FLUSH_TOKEN", "lrs-write-token-with-at-least-32-characters");
    vi.doMock("@/lib/server/aais-request-auth", async () => {
      const actual = await vi.importActual<typeof import("@/lib/server/aais-request-auth")>(
        "@/lib/server/aais-request-auth",
      );
      return {
        ...actual,
        requireAaisSessionActor: async () => ({
          id: "student-health",
          displayName: "Student",
          role: "student" as const,
        }),
      };
    });
    const route = await import("@/app/api/learning/lrs/health/route");
    const studentResponse = await route.POST(new Request("http://localhost/api/learning/lrs/health", {
      method: "POST",
      headers: {
        cookie: "aais_session=test-student-session",
        "x-aais-csrf": createAaisCsrfToken("student-health"),
      },
    }));
    expect(studentResponse.status).toBe(403);
    expect(sendHealthMock).not.toHaveBeenCalled();

    const operatorResponse = await route.POST(new Request("http://localhost/api/learning/lrs/health", {
      method: "POST",
      headers: { authorization: "Bearer lrs-write-token-with-at-least-32-characters" },
    }));
    expect(operatorResponse.status).toBe(200);
    expect(operatorResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(sendHealthMock).toHaveBeenCalledWith(
      "aais-lrs-health-operator",
      { timeoutMs: 5_000 },
    );
  });
});
