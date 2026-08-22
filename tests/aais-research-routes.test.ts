// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAaisCsrfToken } from "@/lib/server/aais-csrf";
import { createAaisSessionToken, type AaisSessionActor } from "@/lib/server/aais-session";

beforeEach(() => {
  process.env.AAIS_SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
});

afterEach(() => {
  delete process.env.AAIS_SESSION_SECRET;
  delete process.env.AAIS_RESEARCH_MODE;
  delete process.env.AAIS_RESEARCH_REQUIRED;
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("AAIS research API fail-closed boundaries", () => {
  it("returns an explicit 503 from visit and events when research mode is disabled", async () => {
    const [{ POST: createVisit }, { POST: recordEvent }] = await Promise.all([
      import("@/app/api/research/visit/route"),
      import("@/app/api/research/events/route"),
    ]);

    const visitResponse = await createVisit(new Request("http://localhost/api/research/visit", {
      method: "POST",
    }));
    const eventResponse = await recordEvent(new Request("http://localhost/api/research/events", {
      method: "POST",
    }));

    expect(visitResponse.status).toBe(503);
    expect(await visitResponse.json()).toMatchObject({
      error: { code: "AAIS_RESEARCH_DISABLED" },
      secrets: "redacted",
    });
    expect(eventResponse.status).toBe(503);
    expect(await eventResponse.json()).toMatchObject({
      error: { code: "AAIS_RESEARCH_DISABLED" },
      secrets: "redacted",
    });
  });

  it("blocks legacy product analytics and event exports on the dedicated research deployment", async () => {
    process.env.AAIS_RESEARCH_REQUIRED = "true";
    const actor: AaisSessionActor = {
      id: "student-1",
      role: "student",
      displayName: "Student One",
    };
    const session = createAaisSessionToken(actor, new Date(), { authSource: "development" });
    const [{ GET: exportEvents }, { GET: getAnalytics }] = await Promise.all([
      import("@/app/api/learning/export/route"),
      import("@/app/api/learning/analytics/route"),
    ]);
    const headers = { cookie: `aais_session=${session}` };

    const exportResponse = await exportEvents(new Request(
      "http://localhost/api/learning/export?format=json",
      { headers },
    ));
    const analyticsResponse = await getAnalytics(new Request(
      "http://localhost/api/learning/analytics",
      { headers },
    ));

    expect(exportResponse.status).toBe(403);
    expect(await exportResponse.json()).toMatchObject({
      error: { code: "AAIS_RESEARCH_CONTROLLED_EXPORT_REQUIRED" },
      secrets: "redacted",
    });
    expect(analyticsResponse.status).toBe(403);
    expect(await analyticsResponse.json()).toMatchObject({
      error: { code: "AAIS_RESEARCH_CONTROLLED_EXPORT_REQUIRED" },
      secrets: "redacted",
    });
  });

  it.each(["admin", "researcher"] as const)(
    "does not let a %s session flush the research LRS without the dedicated bearer",
    async (role) => {
    process.env.AAIS_RESEARCH_MODE = "true";
    const actor: AaisSessionActor = {
      id: `${role}-1`,
      role,
      displayName: role,
    };
    const session = createAaisSessionToken(actor, new Date(), { authSource: "development" });
    const csrf = createAaisCsrfToken(actor.id);
    const { POST } = await import("@/app/api/research/lrs/flush/route");

    const response = await POST(new Request("http://localhost/api/research/lrs/flush", {
      method: "POST",
      headers: {
        cookie: `aais_session=${session}; aais_csrf=${csrf}`,
        "x-aais-csrf": csrf,
      },
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "AAIS_RESEARCH_FORBIDDEN" },
      secrets: "redacted",
    });
    },
  );

  it("requires actor-bound CSRF for the controlled researcher event export", async () => {
    process.env.AAIS_RESEARCH_MODE = "true";
    const actor: AaisSessionActor = {
      id: "researcher-1",
      role: "researcher",
      displayName: "Researcher One",
    };
    const session = createAaisSessionToken(actor, new Date(), { authSource: "development" });
    const { GET } = await import("@/app/api/research/events/export/route");

    const response = await GET(new Request(
      "http://localhost/api/research/events/export?studyRunId=10000000-0000-4000-8000-000000000001&purpose=quality_audit",
      {
        headers: { cookie: `aais_session=${session}` },
      },
    ));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "AAIS_CSRF_REQUIRED" },
      secrets: "redacted",
    });
  });

  it("rejects an explicit unsupported controlled-export format", async () => {
    process.env.AAIS_RESEARCH_MODE = "true";
    const actor: AaisSessionActor = {
      id: "researcher-format-audit",
      role: "researcher",
      displayName: "Researcher Format Audit",
    };
    const session = createAaisSessionToken(actor, new Date(), { authSource: "development" });
    const csrf = createAaisCsrfToken(actor.id);
    const { GET } = await import("@/app/api/research/events/export/route");

    const response = await GET(new Request(
      "http://localhost/api/research/events/export?format=xml",
      {
        headers: {
          cookie: `aais_session=${session}; aais_csrf=${csrf}`,
          "x-aais-csrf": csrf,
        },
      },
    ));

    expect(response.status).toBe(400);
    expect(response.headers.get("content-disposition")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "AAIS_RESEARCH_REQUEST_INVALID" },
      secrets: "redacted",
    });
  });

  it.each(["admin", "researcher"] as const)(
    "does not let a %s session run research retention without the dedicated bearer",
    async (role) => {
      process.env.AAIS_RESEARCH_MODE = "true";
      const actor: AaisSessionActor = {
        id: `${role}-1`,
        role,
        displayName: role,
      };
      const session = createAaisSessionToken(actor, new Date(), { authSource: "development" });
      const csrf = createAaisCsrfToken(actor.id);
      const { POST } = await import("@/app/api/research/retention/route");

      const response = await POST(new Request("http://localhost/api/research/retention", {
        method: "POST",
        headers: {
          cookie: `aais_session=${session}; aais_csrf=${csrf}`,
          "x-aais-csrf": csrf,
        },
      }));

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "AAIS_RESEARCH_FORBIDDEN" },
        secrets: "redacted",
      });
    },
  );
});
