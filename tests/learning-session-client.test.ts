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

    await deleteAaisAppSession(fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledWith("/api/auth/app-session", {
      method: "DELETE",
      credentials: "same-origin",
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
