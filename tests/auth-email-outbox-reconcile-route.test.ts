import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  csrf: vi.fn(),
  reconcile: vi.fn(),
  sessionActor: vi.fn(),
}));

vi.mock("@/lib/server/aais-request-auth", () => ({
  isAaisAuthError: (error: unknown) =>
    error instanceof Error && error.name === "AaisAuthError",
  requireAaisSessionActor: mocks.sessionActor,
}));

vi.mock("@/lib/server/aais-csrf", () => ({
  isAaisCsrfError: (error: unknown) =>
    error instanceof Error && error.name === "AaisCsrfError",
  requireAaisCsrf: mocks.csrf,
}));

vi.mock("@/lib/server/aais-auth-delivery", () => ({
  isAaisAuthEmailOutboxStoreError: (error: unknown) =>
    error instanceof Error && error.name === "AaisAuthEmailOutboxStoreError",
  isAaisAuthEmailReconciliationConflictError: (error: unknown) =>
    error instanceof Error && error.name === "AaisAuthEmailReconciliationConflictError",
  reconcileAaisAuthEmailOutbox: mocks.reconcile,
}));

vi.mock("@/lib/server/aais-audit-log", () => ({
  recordAaisAuditEvent: mocks.audit,
}));

const body = {
  outboxId: "10000000-0000-4000-8000-000000000015",
  disposition: "sent",
  evidence: {
    provider: "resend",
    messageId: "resend_message_1234567890",
    status: "delivered",
    observedAt: "2026-08-20T00:20:00.000Z",
  },
};

beforeEach(() => {
  mocks.audit.mockReset();
  mocks.csrf.mockReset();
  mocks.reconcile.mockReset();
  mocks.sessionActor.mockReset();
  mocks.sessionActor.mockResolvedValue({ id: "admin-operator", role: "admin" });
  mocks.reconcile.mockResolvedValue({
    disposition: "sent",
    outboxId: body.outboxId,
    reconciledAt: "2026-08-20T00:30:00.000Z",
    reissueAllowed: false,
    status: "sent",
    tokenState: "delivered",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AAIS authentication email reconciliation route", () => {
  it("requires an admin session and CSRF, persists evidence, and redacts provider identifiers", async () => {
    const { POST } = await import("@/app/api/auth/email-outbox/reconcile/route");
    const request = createRequest(body);

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.sessionActor).toHaveBeenCalledWith(request);
    expect(mocks.csrf).toHaveBeenCalledWith(request, "admin-operator");
    expect(mocks.reconcile).toHaveBeenCalledWith({
      actorId: "admin-operator",
      disposition: "sent",
      evidence: body.evidence,
      outboxId: body.outboxId,
    });
    const responseText = JSON.stringify(await response.json());
    expect(responseText).toContain('"reissueAllowed":false');
    expect(responseText).not.toContain(body.evidence.messageId);
    expect(responseText).not.toContain("AAIS password reset");
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      event: "auth.email_outbox.reconciled",
      actorId: "admin-operator",
      outcome: "success",
      metadata: expect.objectContaining({
        disposition: "sent",
        evidenceProvider: "resend",
        evidenceStatus: "delivered",
      }),
    }));
  });

  it("rejects a non-admin actor before reconciliation", async () => {
    mocks.sessionActor.mockResolvedValue({ id: "learner", role: "student" });
    const { POST } = await import("@/app/api/auth/email-outbox/reconcile/route");

    const response = await POST(createRequest(body));

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.csrf).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it("rejects missing CSRF before parsing or writing evidence", async () => {
    const csrfError = new Error("private csrf detail");
    csrfError.name = "AaisCsrfError";
    mocks.csrf.mockImplementation(() => {
      throw csrfError;
    });
    const { POST } = await import("@/app/api/auth/email-outbox/reconcile/route");

    const response = await POST(createRequest(body));

    expect(response.status).toBe(403);
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain("private csrf detail");
  });

  it("rejects contradictory or oversized evidence bodies without reconciliation", async () => {
    const { POST } = await import("@/app/api/auth/email-outbox/reconcile/route");
    const contradictory = createRequest({
      ...body,
      disposition: "not_sent",
      evidence: { ...body.evidence, status: "delivered" },
    });
    const oversized = createRequest(body, {
      "content-length": String(8 * 1024),
    });

    expect((await POST(contradictory)).status).toBe(400);
    expect((await POST(oversized)).status).toBe(413);
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it("maps an ineligible or conflicting transition to a redacted 409", async () => {
    const conflict = new Error("private outbox state");
    conflict.name = "AaisAuthEmailReconciliationConflictError";
    mocks.reconcile.mockRejectedValue(conflict);
    const { POST } = await import("@/app/api/auth/email-outbox/reconcile/route");

    const response = await POST(createRequest(body));

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.stringify(await response.json())).not.toContain("private outbox state");
  });
});

function createRequest(value: unknown, extraHeaders: Record<string, string> = {}) {
  return new Request("https://aais.example.test/api/auth/email-outbox/reconcile", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: "aais_session=session-value; aais_csrf=csrf-value",
      "x-aais-csrf": "csrf-value",
      ...extraHeaders,
    },
    body: JSON.stringify(value),
  });
}
