import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAaisCsrfToken, getAaisCsrfCookieName } from "@/lib/server/aais-csrf";
import { createAaisSessionToken } from "@/lib/server/aais-session";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-privacy-"));
  process.env.AAIS_DATA_DIR = tempDir;
  process.env.AAIS_SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.AAIS_DATA_DIR;
  delete process.env.AAIS_SESSION_SECRET;
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/server/aais-learning-store");
  await rm(tempDir, { force: true, recursive: true });
});

describe("AAIS learner privacy route", () => {
  it("exports and deletes only the authenticated learner data", async () => {
    const sessionRoute = await import("@/app/api/learning/session/route");
    const privacyRoute = await import("@/app/api/learning/privacy/route");
    const s001Headers = createAuthedHeaders("S001");
    const phoebeHeaders = createAuthedHeaders("Phoebe");

    for (const headers of [s001Headers, phoebeHeaders]) {
      const response = await sessionRoute.POST(new Request(
        "http://localhost/api/learning/session",
        {
          method: "POST",
          headers,
        },
      ));
      expect(response.status).toBe(200);
    }

    await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: s001Headers,
        body: JSON.stringify({
          dataGeneration: 1,
          action: "save-artifact",
          taskId: "training_task_1",
          artifactText: "S001 raw learner artifact for privacy export",
          expectedArtifactRevision: 0,
          mutationId: "privacy-s001-artifact-save",
        }),
      }),
    );
    await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: phoebeHeaders,
        body: JSON.stringify({
          dataGeneration: 1,
          action: "save-artifact",
          taskId: "training_task_1",
          artifactText: "Phoebe data must remain after S001 deletion",
          expectedArtifactRevision: 0,
          mutationId: "privacy-phoebe-artifact-save",
        }),
      }),
    );

    const exportResponse = await privacyRoute.GET(
      new Request("http://localhost/api/learning/privacy", {
        headers: {
          cookie: s001Headers.cookie,
        },
      }),
    );
    const exported = await exportResponse.json();

    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(exported).toMatchObject({
      schemaVersion: 1,
      exportScope: "learner-data",
      studentId: "S001",
      privacy: {
        ownerScoped: true,
        includesRawLearnerText: true,
        secrets: "redacted",
      },
      secrets: "redacted",
    });
    expect(JSON.stringify(exported)).toContain("S001 raw learner artifact for privacy export");
    expect(JSON.stringify(exported)).not.toContain("Phoebe data must remain after S001 deletion");
    expect(JSON.stringify(exported)).not.toContain("test-session-secret");

    const missingCsrfResponse = await privacyRoute.DELETE(
      new Request("http://localhost/api/learning/privacy", {
        method: "DELETE",
        headers: {
          cookie: s001Headers.cookie,
        },
      }),
    );
    const missingCsrfBody = await missingCsrfResponse.json();

    expect(missingCsrfResponse.status).toBe(403);
    expect(missingCsrfBody.error).toEqual({
      code: "AAIS_CSRF_REQUIRED",
      message: "AAIS CSRF token is required.",
    });

    const missingGenerationResponse = await privacyRoute.DELETE(
      new Request("http://localhost/api/learning/privacy", {
        method: "DELETE",
        headers: s001Headers,
        body: JSON.stringify({}),
      }),
    );
    expect(missingGenerationResponse.status).toBe(409);
    await expect(missingGenerationResponse.json()).resolves.toMatchObject({
      error: { code: "AAIS_LEARNER_DATA_GENERATION_REQUIRED" },
    });

    const deleteResponse = await privacyRoute.DELETE(
      new Request("http://localhost/api/learning/privacy", {
        method: "DELETE",
        headers: s001Headers,
        body: JSON.stringify({ dataGeneration: 1 }),
      }),
    );
    const deleteBody = await deleteResponse.json();

    expect(deleteResponse.status).toBe(200);
    expect(deleteBody.deletion).toMatchObject({
      studentId: "S001",
      storageMode: "file",
      learnerRecordDeleted: true,
      nextGeneration: 2,
      accountRetained: true,
      antiAbuseGuideUsage: {
        retained: true,
        scope: "content-free-account-daily-aggregate",
        rawLearnerContent: false,
        quotaEffectEndsAt: expect.stringMatching(/T00:00:00\.000Z$/),
        cleanup: "next-quota-maintenance-after-utc-reset",
      },
      secrets: "redacted",
    });

    const afterDeleteResponse = await privacyRoute.GET(
      new Request("http://localhost/api/learning/privacy", {
        headers: {
          cookie: s001Headers.cookie,
        },
      }),
    );
    const afterDelete = await afterDeleteResponse.json();
    expect(afterDelete.data.session).toBeNull();
    expect(afterDelete.data.events).toEqual([]);

    const phoebeExportResponse = await privacyRoute.GET(
      new Request("http://localhost/api/learning/privacy", {
        headers: {
          cookie: phoebeHeaders.cookie,
        },
      }),
    );
    const phoebeExport = await phoebeExportResponse.json();
    expect(JSON.stringify(phoebeExport)).toContain("Phoebe data must remain after S001 deletion");
  });

  it("rejects unauthenticated privacy access without diagnostics", async () => {
    const privacyRoute = await import("@/app/api/learning/privacy/route");

    const response = await privacyRoute.GET(new Request("http://localhost/api/learning/privacy"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      error: {
        code: "AAIS_AUTH_REQUIRED",
        message: "AAIS authentication is required.",
      },
      secrets: "redacted",
    });
  });

  it.each([
    ["in_flight", "AAIS_LRS_DELIVERY_IN_FLIGHT"],
    ["reconciliation_required", "AAIS_LRS_DELIVERY_RECONCILIATION_REQUIRED"],
  ] as const)(
    "does not report deletion success while the LRS fence is %s",
    async (reason, expectedCode) => {
      vi.doMock("@/lib/server/aais-learning-store", async (importOriginal) => {
        const actual = await importOriginal<
          typeof import("@/lib/server/aais-learning-store")
        >();
        return {
          ...actual,
          getAaisLearningStore: () => ({
            deleteLearnerData: async () => {
              throw new actual.AaisLearnerDataDeliveryFenceError(reason);
            },
          }),
        };
      });
      const privacyRoute = await import("@/app/api/learning/privacy/route");
      const response = await privacyRoute.DELETE(
        new Request("http://localhost/api/learning/privacy", {
          method: "DELETE",
          headers: createAuthedHeaders("S001"),
          body: JSON.stringify({ dataGeneration: 1 }),
        }),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: expectedCode },
        deletionCompleted: false,
        externalDeliveryState: reason,
        secrets: "redacted",
      });
    },
  );
});

function createAuthedHeaders(id: string, role: "student" | "teacher" | "admin" = "student") {
  const csrfToken = createAaisCsrfToken(id);
  const sessionToken = createAaisSessionToken({
    id,
    role,
    displayName: id,
  }, new Date(), { authSource: "development" });
  return {
    cookie: `aais_session=${sessionToken}; ${getAaisCsrfCookieName()}=${csrfToken}`,
    "x-aais-csrf": csrfToken,
  };
}
