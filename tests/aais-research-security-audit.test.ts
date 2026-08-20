// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAaisCsrfToken } from "@/lib/server/aais-csrf";
import { createAaisSessionToken, type AaisSessionActor } from "@/lib/server/aais-session";

const mocks = vi.hoisted(() => ({
  exportEvents: vi.fn(),
  getOrCreateVisit: vi.fn(),
}));

vi.mock("@/lib/server/aais-research-store", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/server/aais-research-store")
  >();
  return {
    ...actual,
    getAaisResearchStore: () => ({
      exportEvents: mocks.exportEvents,
      getOrCreateVisit: mocks.getOrCreateVisit,
    }),
  };
});

let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env.AAIS_RESEARCH_MODE = "true";
  process.env.AAIS_SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
  mocks.exportEvents.mockReset();
  mocks.getOrCreateVisit.mockReset();
  info = vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.AAIS_RESEARCH_MODE;
  delete process.env.AAIS_RESEARCH_LRS_OUTBOX_FLUSH_TOKEN;
  delete process.env.AAIS_SESSION_SECRET;
  vi.restoreAllMocks();
});

describe("AAIS research security audit", () => {
  it("records one de-identified audit when the participant allowlist rejects a session", async () => {
    const rawActorId = "student-not-on-research-roster";
    const rawErrorDetail = "private allowlist diagnostic must not be logged";
    const { AaisResearchAuthorizationError } = await import(
      "@/lib/server/aais-research-store"
    );
    mocks.getOrCreateVisit.mockRejectedValueOnce(
      new AaisResearchAuthorizationError(rawErrorDetail),
    );
    const actor = createActor(rawActorId, "student");
    const csrf = createAaisCsrfToken(actor.id);
    const session = createAaisSessionToken(actor, new Date(), {
      authSource: "development",
    });
    const { POST } = await import("@/app/api/research/visit/route");

    const response = await POST(new Request("http://localhost/api/research/visit", {
      method: "POST",
      headers: {
        cookie: `aais_session=${session}; aais_csrf=${csrf}`,
        "x-aais-csrf": csrf,
      },
    }));

    expect(response.status).toBe(403);
    const audits = readResearchSecurityAudits();
    expect(audits).toEqual([
      expect.objectContaining({
        type: "aais.audit",
        event: "research.security",
        outcome: "failure",
        metadata: {
          route: "/api/research/visit",
          operation: "visit.create",
          status: 403,
          errorKind: "authorization_failed",
          authMode: "session",
          secrets: "redacted",
        },
      }),
    ]);
    expect(audits[0]).not.toHaveProperty("actorId");
    expect(JSON.stringify(audits)).not.toContain(rawActorId);
    expect(JSON.stringify(audits)).not.toContain(rawErrorDetail);
    expect(JSON.stringify(audits)).not.toContain(session);
    expect(JSON.stringify(audits)).not.toContain(csrf);
  });

  it("records one redacted worker audit for a wrong research bearer", async () => {
    const expectedBearer = "expected-research-flush-token-with-32-characters";
    const wrongBearer = "wrong-research-flush-token-with-at-least-32-chars";
    process.env.AAIS_RESEARCH_LRS_OUTBOX_FLUSH_TOKEN = expectedBearer;
    const { POST } = await import("@/app/api/research/lrs/flush/route");

    const response = await POST(new Request("http://localhost/api/research/lrs/flush", {
      method: "POST",
      headers: { authorization: `Bearer ${wrongBearer}` },
    }));

    expect(response.status).toBe(403);
    const audits = readResearchSecurityAudits();
    expect(audits).toEqual([
      expect.objectContaining({
        type: "aais.audit",
        event: "research.security",
        outcome: "failure",
        metadata: {
          route: "/api/research/lrs/flush",
          operation: "lrs.flush",
          status: 403,
          errorKind: "authorization_failed",
          authMode: "research-bearer",
          secrets: "redacted",
        },
      }),
    ]);
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain(expectedBearer);
    expect(serialized).not.toContain(wrongBearer);
    expect(serialized).not.toContain("Bearer ");
  });

  it("records one session-mode audit for a controlled export CSRF rejection", async () => {
    const actor = createActor("researcher-csrf-sensitive", "researcher");
    const session = createAaisSessionToken(actor, new Date(), {
      authSource: "development",
    });
    const studyRunId = "10000000-0000-4000-8000-000000000099";
    const { GET } = await import("@/app/api/research/events/export/route");

    const response = await GET(new Request(
      `http://localhost/api/research/events/export?studyRunId=${studyRunId}&purpose=quality_audit`,
      { headers: { cookie: `aais_session=${session}` } },
    ));

    expect(response.status).toBe(403);
    const audits = readResearchSecurityAudits();
    expect(audits).toEqual([
      expect.objectContaining({
        type: "aais.audit",
        event: "research.security",
        outcome: "failure",
        metadata: {
          route: "/api/research/events/export",
          operation: "events.export",
          status: 403,
          errorKind: "csrf_required",
          authMode: "session",
          secrets: "redacted",
        },
      }),
    ]);
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain(actor.id);
    expect(serialized).not.toContain(session);
    expect(serialized).not.toContain(studyRunId);
  });

  it("records one session-mode audit when controlled export is disabled", async () => {
    const rawActorId = "researcher-export-disabled-sensitive";
    const rawErrorDetail = "internal export switch diagnostic must not be logged";
    const { AaisResearchExportDisabledError } = await import(
      "@/lib/server/aais-research-store"
    );
    const exportDisabledError = new AaisResearchExportDisabledError();
    exportDisabledError.message = rawErrorDetail;
    mocks.exportEvents.mockRejectedValueOnce(exportDisabledError);
    const actor = createActor(rawActorId, "researcher");
    const csrf = createAaisCsrfToken(actor.id);
    const session = createAaisSessionToken(actor, new Date(), {
      authSource: "development",
    });
    const studyRunId = "10000000-0000-4000-8000-000000000098";
    const { GET } = await import("@/app/api/research/events/export/route");

    const response = await GET(new Request(
      `http://localhost/api/research/events/export?studyRunId=${studyRunId}&purpose=quality_audit`,
      {
        headers: {
          cookie: `aais_session=${session}; aais_csrf=${csrf}`,
          "x-aais-csrf": csrf,
        },
      },
    ));

    expect(response.status).toBe(403);
    const audits = readResearchSecurityAudits();
    expect(audits).toEqual([
      expect.objectContaining({
        type: "aais.audit",
        event: "research.security",
        outcome: "failure",
        metadata: {
          route: "/api/research/events/export",
          operation: "events.export",
          status: 403,
          errorKind: "export_disabled",
          authMode: "session",
          secrets: "redacted",
        },
      }),
    ]);
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain(rawActorId);
    expect(serialized).not.toContain(rawErrorDetail);
    expect(serialized).not.toContain(studyRunId);
    expect(serialized).not.toContain(session);
    expect(serialized).not.toContain(csrf);
  });
});

function createActor(
  id: string,
  role: AaisSessionActor["role"],
): AaisSessionActor {
  return {
    id,
    role,
    displayName: "Raw display name must not enter the audit",
  };
}

function readResearchSecurityAudits() {
  return (info.mock.calls as unknown[][])
    .map((call: unknown[]) => JSON.parse(String(call[0])) as Record<string, unknown>)
    .filter((event: Record<string, unknown>) => event.event === "research.security");
}
