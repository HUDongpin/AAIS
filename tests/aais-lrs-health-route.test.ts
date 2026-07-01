import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const persistentOutboxStatusMock = vi.fn();

beforeEach(() => {
  persistentOutboxStatusMock.mockReset();
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
    probeAaisLrsConnection: async () => ({
      status: "connected",
      configured: true,
      httpStatus: 200,
    }),
    sendAaisLrsHealthStatement: async () => ({
      status: "sent",
      sent: 1,
      httpStatus: 204,
    }),
  }));
  vi.doMock("@/lib/server/aais-learning-store", () => ({
    getAaisPersistentLrsOutboxStatus: persistentOutboxStatusMock,
  }));
});

afterEach(() => {
  vi.doUnmock("@/lib/server/aais-lrs-client");
  vi.doUnmock("@/lib/server/aais-learning-store");
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
    const route = await import("@/app/api/learning/lrs/health/route");

    const response = await route.GET();
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
  });
});
