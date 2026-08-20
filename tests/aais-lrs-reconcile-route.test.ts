import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  csrf: vi.fn(),
  list: vi.fn(),
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

vi.mock("@/lib/server/aais-learning-store", () => ({
  isAaisLrsDeliveryReconciliationConflictError: (error: unknown) =>
    error instanceof Error && error.name === "AaisLrsDeliveryReconciliationConflictError",
  isAaisLrsDeliveryReconciliationStoreError: (error: unknown) =>
    error instanceof Error && error.name === "AaisLrsDeliveryReconciliationStoreError",
  listAaisPendingLrsDeliveryAttempts: mocks.list,
  reconcileAaisLrsDeliveryAttempt: mocks.reconcile,
}));

vi.mock("@/lib/server/aais-audit-log", () => ({
  recordAaisAuditEvent: mocks.audit,
}));

const claimId = "10000000-0000-4000-8000-000000000025";
const statementIds = [
  "20000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
];

function validBody() {
  return {
    claimId,
    evidence: {
      observedAt: new Date(Date.now() - 1_000).toISOString(),
      statements: [
        { statementId: statementIds[0], status: "stored" },
        { statementId: statementIds[1], status: "absent" },
      ],
    },
  };
}

beforeEach(() => {
  mocks.audit.mockReset();
  mocks.csrf.mockReset();
  mocks.list.mockReset();
  mocks.reconcile.mockReset();
  mocks.sessionActor.mockReset();
  mocks.sessionActor.mockResolvedValue({ id: "admin-operator", role: "admin" });
  mocks.list.mockResolvedValue([]);
  mocks.reconcile.mockResolvedValue({
    claimId,
    status: "reconciled",
    result: "mixed",
    statementCount: 2,
    stored: 1,
    absent: 1,
    reconciledAt: new Date().toISOString(),
    privacyFence: "idle",
    secrets: "redacted",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AAIS product LRS delivery reconciliation route", () => {
  it("lists a bounded, sorted, redacted pending-attempt view for an admin", async () => {
    mocks.list.mockResolvedValue([{
      claimId,
      state: "uncertain",
      startedAt: "2026-08-20T00:00:00.000Z",
      reconcileAfter: "2026-08-20T00:01:00.000Z",
      statementCount: 2,
      statementIds: [statementIds[1], statementIds[0]],
      learnerId: "learner-must-not-leak",
      frozenStatement: { actor: "must-not-leak" },
      payload: "must-not-leak",
    }]);
    const { GET } = await import("@/app/api/learning/lrs/outbox/reconcile/route");
    const request = createListRequest("?limit=7");

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.sessionActor).toHaveBeenCalledWith(request);
    expect(mocks.list).toHaveBeenCalledWith({ limit: 7 });
    expect(mocks.csrf).not.toHaveBeenCalled();
    expect(body).toEqual({
      attempts: [{
        claimId,
        state: "uncertain",
        startedAt: "2026-08-20T00:00:00.000Z",
        reconcileAfter: "2026-08-20T00:01:00.000Z",
        statementCount: 2,
        statementIds,
      }],
      count: 1,
      secrets: "redacted",
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("learner-must-not-leak");
    expect(serialized).not.toContain("frozenStatement");
    expect(serialized).not.toContain("payload");
  });

  it("rejects unauthenticated and non-admin list access before querying storage", async () => {
    const authError = new Error("private auth detail");
    authError.name = "AaisAuthError";
    mocks.sessionActor.mockRejectedValueOnce(authError);
    const { GET } = await import("@/app/api/learning/lrs/outbox/reconcile/route");

    const unauthenticated = await GET(createListRequest());
    expect(unauthenticated.status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(JSON.stringify(await unauthenticated.json())).not.toContain("private auth detail");

    mocks.sessionActor.mockResolvedValueOnce({ id: "learner", role: "student" });
    const nonAdmin = await GET(createListRequest("?limit=5"));
    expect(nonAdmin.status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("bounds list input and rejects duplicate or unknown query parameters", async () => {
    const { GET } = await import("@/app/api/learning/lrs/outbox/reconcile/route");

    expect((await GET(createListRequest("?limit=50"))).status).toBe(200);
    expect(mocks.list).toHaveBeenLastCalledWith({ limit: 50 });
    const callsBeforeInvalidInput = mocks.list.mock.calls.length;

    for (const query of ["?limit=51", "?limit=1&limit=2", "?cursor=private"]) {
      expect((await GET(createListRequest(query))).status).toBe(400);
    }
    expect(mocks.list).toHaveBeenCalledTimes(callsBeforeInvalidInput);
  });

  it.each([
    ["AaisLrsDeliveryReconciliationStoreError", 503,
      "AAIS_LRS_DELIVERY_RECONCILIATION_NOT_READY"],
    ["UnexpectedDatabaseError", 500,
      "AAIS_LRS_DELIVERY_RECONCILIATION_FAILED"],
  ] as const)("maps list %s failures without leaking raw database details", async (
    name,
    status,
    code,
  ) => {
    const error = new Error("private database row and learner identifier");
    error.name = name;
    mocks.list.mockRejectedValue(error);
    const { GET } = await import("@/app/api/learning/lrs/outbox/reconcile/route");

    const response = await GET(createListRequest());
    const text = JSON.stringify(await response.json());

    expect(response.status).toBe(status);
    expect(text).toContain(code);
    expect(text).not.toContain("private database row");
  });

  it("requires an admin session and CSRF before persisting bounded exact-set evidence", async () => {
    const body = validBody();
    const { POST } = await import("@/app/api/learning/lrs/outbox/reconcile/route");
    const request = createRequest(body);

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.sessionActor).toHaveBeenCalledWith(request);
    expect(mocks.csrf).toHaveBeenCalledWith(request, "admin-operator");
    expect(mocks.reconcile).toHaveBeenCalledWith({
      actorId: "admin-operator",
      claimId,
      evidence: body.evidence,
    });
    const responseText = JSON.stringify(await response.json());
    expect(responseText).toContain('"privacyFence":"idle"');
    expect(responseText).not.toContain(statementIds[0]);
    expect(responseText).not.toContain(statementIds[1]);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      event: "lrs_outbox_delivery_reconciled",
      actorId: "admin-operator",
      outcome: "success",
      metadata: expect.objectContaining({
        result: "mixed",
        statementCount: 2,
        exactStatementSetRequired: true,
        automaticStaleRelease: false,
      }),
    }));
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-admin before CSRF, parsing, or state mutation", async () => {
    mocks.sessionActor.mockResolvedValue({ id: "learner", role: "student" });
    const { POST } = await import("@/app/api/learning/lrs/outbox/reconcile/route");

    const response = await POST(createRequest(validBody()));

    expect(response.status).toBe(403);
    expect(mocks.csrf).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expectFailureAudit({
      code: "AAIS_LRS_DELIVERY_RECONCILIATION_FORBIDDEN",
      status: 403,
      actor: "learner",
    });
  });

  it("rejects missing CSRF before parsing or state mutation", async () => {
    const error = new Error("private csrf detail");
    error.name = "AaisCsrfError";
    mocks.csrf.mockImplementation(() => {
      throw error;
    });
    const { POST } = await import("@/app/api/learning/lrs/outbox/reconcile/route");

    const response = await POST(createRequest(validBody()));

    expect(response.status).toBe(403);
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain("private csrf detail");
    expectFailureAudit({ code: "AAIS_CSRF_REQUIRED", status: 403 });
  });

  it("rejects duplicate, incomplete-shape, and oversized evidence before reconciliation", async () => {
    const body = validBody();
    const duplicate = {
      ...body,
      evidence: {
        ...body.evidence,
        statements: [body.evidence.statements[0], body.evidence.statements[0]],
      },
    };
    const extraKey = { ...body, unexpected: true };
    const { POST } = await import("@/app/api/learning/lrs/outbox/reconcile/route");

    expect((await POST(createRequest(duplicate))).status).toBe(400);
    expect((await POST(createRequest(extraKey))).status).toBe(400);
    expect((await POST(createRequest(body, { "content-length": String(64 * 1024) }))).status)
      .toBe(413);
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledTimes(3);
    expect(mocks.audit.mock.calls.every(([event]) =>
      event.outcome === "failure"
      && event.event === "lrs_outbox_delivery_reconciliation_failed"
    )).toBe(true);
    expect(mocks.audit.mock.calls.map(([event]) => event.metadata)).toEqual([
      expect.objectContaining({
        code: "AAIS_LRS_DELIVERY_RECONCILIATION_INVALID",
        status: 400,
      }),
      expect.objectContaining({
        code: "AAIS_LRS_DELIVERY_RECONCILIATION_INVALID",
        status: 400,
      }),
      expect.objectContaining({
        code: "AAIS_LRS_DELIVERY_RECONCILIATION_TOO_LARGE",
        status: 413,
      }),
    ]);
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(statementIds[0]);
  });

  it.each([
    ["AaisLrsDeliveryReconciliationConflictError", 409,
      "AAIS_LRS_DELIVERY_RECONCILIATION_CONFLICT"],
    ["AaisLrsDeliveryReconciliationStoreError", 503,
      "AAIS_LRS_DELIVERY_RECONCILIATION_NOT_READY"],
  ] as const)("maps %s to a redacted typed response", async (name, status, code) => {
    const error = new Error("private database state");
    error.name = name;
    mocks.reconcile.mockRejectedValue(error);
    const { POST } = await import("@/app/api/learning/lrs/outbox/reconcile/route");

    const response = await POST(createRequest(validBody()));
    const text = JSON.stringify(await response.json());

    expect(response.status).toBe(status);
    expect(text).toContain(code);
    expect(text).not.toContain("private database state");
    expectFailureAudit({ code, status });
  });

  it("records one redacted failure audit for unauthenticated and unexpected failures", async () => {
    const authError = new Error("raw cookie and auth detail");
    authError.name = "AaisAuthError";
    mocks.sessionActor.mockRejectedValue(authError);
    const { POST } = await import("@/app/api/learning/lrs/outbox/reconcile/route");

    const unauthenticated = await POST(createRequest(validBody()));
    expect(unauthenticated.status).toBe(401);
    expectFailureAudit({ code: "AAIS_AUTH_REQUIRED", status: 401, actor: false });
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("raw cookie");
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(statementIds[0]);

    mocks.audit.mockReset();
    mocks.sessionActor.mockResolvedValue({ id: "admin-operator", role: "admin" });
    mocks.reconcile.mockRejectedValue(new Error("raw SQL and frozen statement"));
    const unexpected = await POST(createRequest(validBody()));
    expect(unexpected.status).toBe(500);
    expectFailureAudit({
      code: "AAIS_LRS_DELIVERY_RECONCILIATION_FAILED",
      status: 500,
    });
    const serialized = JSON.stringify(mocks.audit.mock.calls);
    expect(serialized).not.toContain("raw SQL");
    expect(serialized).not.toContain(statementIds[0]);
  });
});

function createRequest(value: unknown, extraHeaders: Record<string, string> = {}) {
  return new Request("https://aais.example.test/api/learning/lrs/outbox/reconcile", {
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

function createListRequest(query = "") {
  return new Request(`https://aais.example.test/api/learning/lrs/outbox/reconcile${query}`, {
    headers: {
      cookie: "aais_session=session-value",
    },
  });
}

function expectFailureAudit(input: {
  code: string;
  status: number;
  actor?: string | false;
}) {
  expect(mocks.audit).toHaveBeenCalledTimes(1);
  const event = mocks.audit.mock.calls[0]?.[0] as Record<string, unknown>;
  expect(event).toMatchObject({
    event: "lrs_outbox_delivery_reconciliation_failed",
    outcome: "failure",
    metadata: {
      operation: "reconcile",
      code: input.code,
      status: input.status,
      actorContext: input.actor === false ? "unauthenticated" : "authenticated",
      secrets: "redacted",
    },
  });
  if (input.actor === false) {
    expect(event).not.toHaveProperty("actorId");
  } else {
    expect(event).toHaveProperty("actorId", input.actor ?? "admin-operator");
  }
  const metadata = event.metadata as Record<string, unknown>;
  expect(metadata).not.toHaveProperty("actorId");
  expect(metadata).not.toHaveProperty("claimId");
  expect(metadata).not.toHaveProperty("statementIds");
  expect(metadata).not.toHaveProperty("body");
  expect(metadata).not.toHaveProperty("error");
}
