import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteAaisAppSession,
  fetchLearningSession,
  patchLearningSession,
} from "@/components/pages/learning/learning-session-client";

afterEach(() => {
  document.cookie = "aais_csrf=; Max-Age=0; path=/";
});

describe("learning session client", () => {
  it("loads the typed learner session from the session route", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      session: {
        studentId: "S001",
        displayName: "Bobie",
        sessionId: "session-1",
        activeTaskId: "training_task_1",
        tasks: [],
      },
    }));

    const session = await fetchLearningSession(fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledWith("/api/learning/session");
    expect(session).toMatchObject({
      studentId: "S001",
      activeTaskId: "training_task_1",
    });
  });

  it("patches the learner session with the actor-bound CSRF header", async () => {
    document.cookie = "aais_csrf=csrf-123; path=/";
    const fetchImpl = vi.fn(async () => jsonResponse({
      session: {
        studentId: "S001",
        displayName: "Bobie",
        sessionId: "session-1",
        activeTaskId: "training_task_1",
        tasks: [
          {
            taskId: "training_task_1",
            phase: "training",
            status: "in_progress",
            artifactText: "过程记录",
            selfReport: "",
          },
        ],
      },
    }));

    await patchLearningSession({
      action: "save-artifact",
      taskId: "training_task_1",
      artifactText: "过程记录",
    }, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledWith("/api/learning/session", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-aais-csrf": "csrf-123",
      },
      body: JSON.stringify({
        action: "save-artifact",
        taskId: "training_task_1",
        artifactText: "过程记录",
      }),
    });
  });

  it("maps failed session responses to safe client errors", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      error: {
        code: "AAIS_AUTH_REQUIRED",
        message: "AAIS authentication is required.",
      },
    }, { status: 401 }));

    await expect(fetchLearningSession(fetchImpl as unknown as typeof fetch))
      .rejects.toThrow("AAIS authentication is required.");
  });

  it("deletes the app session through the auth route", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));

    await deleteAaisAppSession(null, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledWith("/api/auth/app-session", {
      method: "DELETE",
      credentials: "same-origin",
      headers: {},
    });
  });

  it("binds a formal research logout acknowledgement to the expected visit", async () => {
    document.cookie = "aais_csrf=csrf-logout; path=/";
    const researchLogout = {
      expectedVisitId: "10000000-0000-4000-8000-000000000001",
      failureClientEventId: "10000000-0000-4000-8000-000000000002",
      finalClientTime: "2026-07-30T10:00:00.000Z",
      operationId: "account-logout-test-1",
      successClientEventId: "10000000-0000-4000-8000-000000000003",
    };
    const fetchImpl = vi.fn(async () => jsonResponse({
      ok: true,
      sessionRevoked: true,
      researchLogout: {
        clientEventId: researchLogout.successClientEventId,
        visitId: researchLogout.expectedVisitId,
      },
    }));

    const result = await deleteAaisAppSession(
      researchLogout,
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({
      researchAcknowledged: true,
      sessionRevoked: true,
    });

    expect(fetchImpl).toHaveBeenCalledWith("/api/auth/app-session", {
      method: "DELETE",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "x-aais-csrf": "csrf-logout",
      },
      body: JSON.stringify({ researchLogout }),
    });
  });

  it("rejects a failed revoke and reports a missing visit-bound acknowledgement", async () => {
    const researchLogout = {
      expectedVisitId: "10000000-0000-4000-8000-000000000001",
      failureClientEventId: "10000000-0000-4000-8000-000000000002",
      finalClientTime: "2026-07-30T10:00:00.000Z",
      operationId: "account-logout-test-2",
      successClientEventId: "10000000-0000-4000-8000-000000000003",
    };
    const failedFetch = vi.fn(async () => jsonResponse({
      error: { code: "AAIS_LOGOUT_FAILED" },
    }, { status: 503 }));
    const wrongVisitFetch = vi.fn(async () => jsonResponse({
      ok: true,
      sessionRevoked: true,
      researchLogout: {
        clientEventId: researchLogout.successClientEventId,
        visitId: "10000000-0000-4000-8000-000000000099",
      },
    }));

    await expect(deleteAaisAppSession(
      researchLogout,
      failedFetch as unknown as typeof fetch,
    )).rejects.toThrow("AAIS logout failed.");
    await expect(deleteAaisAppSession(
      researchLogout,
      wrongVisitFetch as unknown as typeof fetch,
    )).resolves.toEqual({
      researchAcknowledged: false,
      sessionRevoked: true,
    });
  });

  it("distinguishes a revoked session from a failed final research acknowledgement", async () => {
    const researchLogout = {
      expectedVisitId: "10000000-0000-4000-8000-000000000001",
      failureClientEventId: "10000000-0000-4000-8000-000000000002",
      finalClientTime: "2026-07-30T10:00:00.000Z",
      operationId: "account-logout-test-3",
      successClientEventId: "10000000-0000-4000-8000-000000000003",
    };
    const fetchImpl = vi.fn(async () => jsonResponse({
      error: { code: "AAIS_RESEARCH_LOGOUT_ACK_FAILED" },
      sessionRevoked: true,
      researchLogoutAcknowledged: false,
    }, { status: 503 }));

    await expect(deleteAaisAppSession(
      researchLogout,
      fetchImpl as unknown as typeof fetch,
    )).resolves.toEqual({
      researchAcknowledged: false,
      sessionRevoked: true,
    });
  });
});

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
}
