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
  await rm(tempDir, { force: true, recursive: true });
});

describe("AAIS learner privacy route", () => {
  it("exports and deletes only the authenticated learner data", async () => {
    const sessionRoute = await import("@/app/api/learning/session/route");
    const privacyRoute = await import("@/app/api/learning/privacy/route");
    const s001Cookie = createAuthedCookie("S001");
    const phoebeCookie = createAuthedCookie("Phoebe");

    await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          action: "save-artifact",
          taskId: "training_task_1",
          artifactText: "S001 raw learner artifact for privacy export",
        }),
      }),
    );
    await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie: phoebeCookie,
          "x-aais-csrf": createAaisCsrfToken("Phoebe"),
        },
        body: JSON.stringify({
          action: "save-artifact",
          taskId: "training_task_1",
          artifactText: "Phoebe data must remain after S001 deletion",
        }),
      }),
    );

    const exportResponse = await privacyRoute.GET(
      new Request("http://localhost/api/learning/privacy", {
        headers: {
          cookie: s001Cookie,
        },
      }),
    );
    const exported = await exportResponse.json();

    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get("cache-control")).toBe("no-store");
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
          cookie: s001Cookie,
        },
      }),
    );
    const missingCsrfBody = await missingCsrfResponse.json();

    expect(missingCsrfResponse.status).toBe(403);
    expect(missingCsrfBody.error).toEqual({
      code: "AAIS_CSRF_REQUIRED",
      message: "AAIS CSRF token is required.",
    });

    const deleteResponse = await privacyRoute.DELETE(
      new Request("http://localhost/api/learning/privacy", {
        method: "DELETE",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
      }),
    );
    const deleteBody = await deleteResponse.json();

    expect(deleteResponse.status).toBe(200);
    expect(deleteBody.deletion).toMatchObject({
      studentId: "S001",
      storageMode: "file",
      learnerRecordDeleted: true,
      accountRetained: true,
      secrets: "redacted",
    });

    const afterDeleteResponse = await privacyRoute.GET(
      new Request("http://localhost/api/learning/privacy", {
        headers: {
          cookie: s001Cookie,
        },
      }),
    );
    const afterDelete = await afterDeleteResponse.json();
    expect(afterDelete.data.session).toBeNull();
    expect(afterDelete.data.events).toEqual([]);

    const phoebeExportResponse = await privacyRoute.GET(
      new Request("http://localhost/api/learning/privacy", {
        headers: {
          cookie: phoebeCookie,
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
});

function createAuthedCookie(id: string, role: "student" | "teacher" | "admin" = "student") {
  const csrfToken = createAaisCsrfToken(id);
  const sessionToken = createAaisSessionToken({
    id,
    role,
    displayName: id,
  });
  return `aais_session=${sessionToken}; ${getAaisCsrfCookieName()}=${csrfToken}`;
}
