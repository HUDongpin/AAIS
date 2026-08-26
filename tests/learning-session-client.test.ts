import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteAaisAppSession,
  deleteLearnerPrivacyData,
  fetchLearningSession,
  patchLearningSessionKeepalive,
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

  it("initializes a missing learner session explicitly with actor-bound CSRF", async () => {
    document.cookie = "aais_csrf=csrf-initialize; path=/";
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        error: {
          code: "AAIS_LEARNER_SESSION_NOT_FOUND",
          message: "AAIS learner session was not found.",
        },
      }, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({
        session: {
          studentId: "S001",
          sessionId: "session-1",
          activeTaskId: "training_task_1",
          tasks: [],
        },
      }));

    await expect(fetchLearningSession(fetchImpl as unknown as typeof fetch)).resolves.toMatchObject({
      studentId: "S001",
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/learning/session");
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/learning/session", {
      method: "POST",
      headers: { "x-aais-csrf": "csrf-initialize" },
    });
  });

  it("propagates abort state and never initializes after an abandoned GET resolves 404", async () => {
    let resolveGet!: (response: Response) => void;
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeTruthy();
      return new Promise<Response>((resolve) => {
        resolveGet = resolve;
      });
    });
    const controller = new AbortController();
    const pending = fetchLearningSession(fetchImpl as unknown as typeof fetch, {
      signal: controller.signal,
    });

    controller.abort();
    resolveGet(jsonResponse({ error: "not found" }, { status: 404 }));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
            artifactRevision: 1,
            selfReport: "",
            selfReportRevision: 0,
          },
        ],
      },
    }));

    await patchLearningSession({
      action: "save-artifact",
      taskId: "training_task_1",
      artifactText: "过程记录",
      expectedArtifactRevision: 0,
      mutationId: "learning-client-save",
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
        expectedArtifactRevision: 0,
        mutationId: "learning-client-save",
      }),
    });
  });

  it("rejects an oversized keepalive body before dispatch so callers can fall back", () => {
    const fetchImpl = vi.fn();

    expect(patchLearningSessionKeepalive({
      action: "save-artifact",
      taskId: "training_task_1",
      artifactText: "研".repeat(25_000),
      dataGeneration: 1,
      expectedArtifactRevision: 0,
      mutationId: "learning-client-oversized-keepalive",
    }, fetchImpl as unknown as typeof fetch)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
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

  it("preserves a typed text-revision conflict code for safe client recovery", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      error: {
        code: "AAIS_ARTIFACT_REVISION_CONFLICT",
        message: "AAIS artifact changed after this edit started. Reload before saving again.",
      },
    }, { status: 409 }));

    await expect(patchLearningSession({
      action: "save-artifact",
      artifactText: "stale",
      expectedArtifactRevision: 0,
      mutationId: "typed-client-conflict",
      taskId: "training_task_1",
    }, fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({
      code: "AAIS_ARTIFACT_REVISION_CONFLICT",
      status: 409,
    });
  });

  it("binds learner-data deletion to the current generation and returns the tombstone", async () => {
    document.cookie = "aais_csrf=csrf-delete; path=/";
    const fetchImpl = vi.fn(async () => jsonResponse({
      deletion: {
        studentId: "S001",
        nextGeneration: 2,
      },
    }));

    await expect(deleteLearnerPrivacyData(
      1,
      fetchImpl as unknown as typeof fetch,
    )).resolves.toMatchObject({
      deletion: {
        studentId: "S001",
        nextGeneration: 2,
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/learning/privacy", {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        "x-aais-csrf": "csrf-delete",
      },
      body: JSON.stringify({ dataGeneration: 1 }),
    });
  });

  it("fails closed when learner-data deletion omits the next generation", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      deletion: { studentId: "S001" },
    }));

    await expect(deleteLearnerPrivacyData(
      1,
      fetchImpl as unknown as typeof fetch,
    )).rejects.toThrow("did not return a generation");
  });

  it("deletes the app session through the auth route", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      ok: true,
      sessionAbsent: true,
      sessionRevoked: false,
    }));

    await expect(deleteAaisAppSession(
      null,
      fetchImpl as unknown as typeof fetch,
    )).resolves.toEqual({
      researchAcknowledged: false,
      sessionAbsent: true,
      sessionRevoked: false,
    });

    expect(fetchImpl).toHaveBeenCalledWith("/api/auth/app-session", {
      method: "DELETE",
      credentials: "same-origin",
      headers: {},
    });
  });

  it("does not fabricate a formal-research acknowledgement for an absent session", async () => {
    const researchLogout = {
      expectedVisitId: "10000000-0000-4000-8000-000000000011",
      failureClientEventId: "10000000-0000-4000-8000-000000000012",
      finalClientTime: "2026-07-30T10:00:00.000Z",
      operationId: "account-logout-test-absent",
      successClientEventId: "10000000-0000-4000-8000-000000000013",
    };
    const fetchImpl = vi.fn(async () => jsonResponse({
      ok: true,
      sessionAbsent: true,
      sessionRevoked: false,
    }));

    await expect(deleteAaisAppSession(
      researchLogout,
      fetchImpl as unknown as typeof fetch,
    )).resolves.toEqual({
      researchAcknowledged: false,
      sessionAbsent: true,
      sessionRevoked: false,
    });
  });

  it("requires an explicit terminal-session marker for ordinary logout", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));

    await expect(deleteAaisAppSession(
      null,
      fetchImpl as unknown as typeof fetch,
    )).resolves.toEqual({
      researchAcknowledged: false,
      sessionAbsent: false,
      sessionRevoked: false,
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
      sessionAbsent: false,
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
      sessionAbsent: false,
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
      sessionAbsent: false,
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
