import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAaisCsrfToken, getAaisCsrfCookieName } from "@/lib/server/aais-csrf";
import { createAaisSessionToken } from "@/lib/server/aais-session";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-api-"));
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

describe("AAIS learning API routes", () => {
  it("loads and mutates a durable session through the session route", async () => {
    const sessionRoute = await import("@/app/api/learning/session/route");
    const s001Cookie = createAuthedCookie("S001");

    let response = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session", {
        headers: {
          cookie: s001Cookie,
        },
      }),
    );
    let body = await response.json();
    expect(body.session.activeTaskId).toBe("training_task_1");

    response = await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          action: "save-artifact",
          taskId: "training_task_1",
          artifactText: "训练任务过程记录",
        }),
      }),
    );
    body = await response.json();
    expect(body.session.tasks[0].artifactText).toBe("训练任务过程记录");

    response = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session", {
        headers: {
          cookie: s001Cookie,
        },
      }),
    );
    body = await response.json();
    expect(body.session.tasks[0].artifactText).toBe("训练任务过程记录");

    response = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session", {
        headers: {
          cookie: createAuthedCookie("Phoebe"),
        },
      }),
    );
    body = await response.json();
    expect(body.session.studentId).toBe("Phoebe");
  });

  it("rejects unsigned learner session requests", async () => {
    const sessionRoute = await import("@/app/api/learning/session/route");

    const response = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session?studentId=S001", {
        headers: {
          cookie: "aais_student_id=S001",
        },
      }),
    );

    expect(response.status).toBe(401);
  });

  it("fails closed in production when persistent learner storage is not configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("AAIS_DATA_DIR", "");
    vi.stubEnv("AAIS_DATABASE_URL", "");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("POSTGRES_URL", "");
    vi.stubEnv("DATABASE_URL_UNPOOLED", "");
    vi.stubEnv("PGHOST", "");
    vi.stubEnv("PGHOST_UNPOOLED", "");
    vi.stubEnv("PGUSER", "");
    vi.stubEnv("PGDATABASE", "");
    vi.stubEnv("PGPASSWORD", "");
    vi.resetModules();
    const sessionRoute = await import("@/app/api/learning/session/route");

    const response = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session", {
        headers: {
          cookie: createAuthedCookie("S001"),
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: "AAIS production learner storage requires Postgres configuration.",
    });
  });

  it("does not call the AI provider when production storage is not configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("AAIS_DATA_DIR", "");
    vi.stubEnv("AAIS_DATABASE_URL", "");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("POSTGRES_URL", "");
    vi.stubEnv("DATABASE_URL_UNPOOLED", "");
    vi.stubEnv("PGHOST", "");
    vi.stubEnv("PGHOST_UNPOOLED", "");
    vi.stubEnv("PGUSER", "");
    vi.stubEnv("PGDATABASE", "");
    vi.stubEnv("PGPASSWORD", "");
    vi.stubEnv("AAIS_AI_PROVIDER", "openai-compatible");
    vi.stubEnv("AAIS_AI_ENDPOINT", "https://ai.example.test/v1/chat/completions");
    vi.stubEnv("AAIS_AI_API_KEY", "secret-api-key-that-must-not-leak");
    vi.stubEnv("AAIS_AI_MODEL", "enterprise-model");
    vi.stubEnv("AAIS_AI_EVAL_APPROVED", "true");
    vi.stubEnv("AAIS_AI_EVAL_VERSION", "eval-2026-06-30");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: "Provider answer that must not be generated without storage.",
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
    const guideRoute = await import("@/app/api/learning/ai-guide/route");

    const response = await guideRoute.POST(
      new Request("http://localhost/api/learning/ai-guide", {
        method: "POST",
        headers: {
          cookie: createAuthedCookie("S001"),
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          phase: "training",
          taskId: "training_task_1",
          learnerInput: "我应该如何开始？",
          workspaceState: {
            currentStep: "guide",
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain("Provider answer");
    expect(JSON.stringify(body)).not.toContain("secret-api-key-that-must-not-leak");
    expect(body).toEqual({
      error: "AAIS production learner storage requires Postgres configuration.",
    });
  });

  it("uses the signed actor instead of spoofable studentId fields", async () => {
    const sessionRoute = await import("@/app/api/learning/session/route");
    const exportRoute = await import("@/app/api/learning/export/route");
    const phoebeCookie = createAuthedCookie("Phoebe");

    const response = await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie: phoebeCookie,
          "x-aais-csrf": createAaisCsrfToken("Phoebe"),
        },
        body: JSON.stringify({
          studentId: "S001",
          action: "save-artifact",
          taskId: "training_task_1",
          artifactText: "Phoebe 的过程记录",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.session.studentId).toBe("Phoebe");

    const exported = await exportRoute.GET(
      new Request("http://localhost/api/learning/export?studentId=S001&format=json", {
        headers: {
          cookie: phoebeCookie,
        },
      }),
    );

    expect(exported.headers.get("content-disposition")).toContain("aais-Phoebe-events.json");
  });

  it("rejects state-changing session requests without the actor-bound csrf token", async () => {
    const sessionRoute = await import("@/app/api/learning/session/route");

    const response = await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie: createAuthedCookie("S001"),
        },
        body: JSON.stringify({
          action: "save-artifact",
          taskId: "training_task_1",
          artifactText: "missing csrf should fail",
        }),
      }),
    );

    expect(response.status).toBe(403);
  });

  it("records guide messages in the persistent learner session", async () => {
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    const sessionRoute = await import("@/app/api/learning/session/route");
    const s001Cookie = createAuthedCookie("S001");

    const guideResponse = await guideRoute.POST(
      new Request("http://localhost/api/learning/ai-guide", {
        method: "POST",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          phase: "training",
          taskId: "training_task_1",
          learnerInput: "我应该如何开始？",
          workspaceState: {
            currentStep: "guide",
          },
        }),
      }),
    );
    const guideBody = await guideResponse.json();
    expect(guideBody.orchestration.graph.topologicalOrder).toEqual(["A1", "A2", "A3", "A4"]);

    const sessionResponse = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session", {
        headers: {
          cookie: s001Cookie,
        },
      }),
    );
    const sessionBody = await sessionResponse.json();

    expect(sessionBody.session.guideMessages.map((message: { kind: string }) => message.kind)).toEqual([
      "user",
      "assistant",
    ]);
    expect(sessionBody.session.events.map((event: { event: string }) => event.event)).toEqual(
      expect.arrayContaining(["ai_prompt_submitted", "ai_response_completed"]),
    );
  });

  it("exports the persisted event log as CSV through the export route", async () => {
    const sessionRoute = await import("@/app/api/learning/session/route");
    const exportRoute = await import("@/app/api/learning/export/route");
    const s001Cookie = createAuthedCookie("S001");

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
          artifactText: "可导出的过程记录",
        }),
      }),
    );

    const response = await exportRoute.GET(
      new Request("http://localhost/api/learning/export?format=csv", {
        headers: {
          cookie: s001Cookie,
        },
      }),
    );
    const text = await response.text();

    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("aais-S001-events.csv");
    expect(text).toContain("artifact_saved");

    const cookieResponse = await exportRoute.GET(
      new Request("http://localhost/api/learning/export?format=json", {
        headers: {
          cookie: createAuthedCookie("Phoebe"),
        },
      }),
    );
    expect(cookieResponse.headers.get("content-disposition")).toContain("aais-Phoebe-events.json");
  });

  it("exports cohort analytics only to educator sessions without raw learner text", async () => {
    const sessionRoute = await import("@/app/api/learning/session/route");
    const exportRoute = await import("@/app/api/learning/export/route");
    const s001Cookie = createAuthedCookie("S001");
    const s002Cookie = createAuthedCookie("S002");

    await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          action: "complete-task",
          taskId: "training_task_1",
        }),
      }),
    );
    await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          action: "select-task",
          taskId: "practice_task_1",
        }),
      }),
    );
    await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          action: "save-artifact",
          taskId: "practice_task_1",
          artifactText: "第一位学习者不应出现在 cohort export 的原文",
        }),
      }),
    );
    await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          action: "save-artifact",
          taskId: "practice_task_1",
          artifactText: "第一位学习者不应出现在 cohort export 的原文",
        }),
      }),
    );
    await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie: s002Cookie,
          "x-aais-csrf": createAaisCsrfToken("S002"),
        },
        body: JSON.stringify({
          action: "save-artifact",
          taskId: "training_task_1",
          artifactText: "第二位学习者也不应进入 cohort export 原文",
        }),
      }),
    );

    const studentResponse = await exportRoute.GET(
      new Request("http://localhost/api/learning/export?scope=cohort&format=json", {
        headers: {
          cookie: s001Cookie,
        },
      }),
    );
    expect(studentResponse.status).toBe(403);

    const teacherCsvResponse = await exportRoute.GET(
      new Request("http://localhost/api/learning/export?scope=cohort&format=csv&phase=practice&agent=A2&event=coaching_push", {
        headers: {
          cookie: createAuthedCookie("teacher-a", "teacher"),
        },
      }),
    );
    const csv = await teacherCsvResponse.text();

    expect(teacherCsvResponse.status).toBe(200);
    expect(teacherCsvResponse.headers.get("content-type")).toContain("text/csv");
    expect(teacherCsvResponse.headers.get("content-disposition")).toContain("aais-cohort-analytics.csv");
    expect(csv).toContain("learner_key,risk_level,priority_reasons");
    expect(csv).toContain("coaching_signals,ai_interactions,ai_acceptance_decisions");
    expect(csv).toContain("learner-");
    expect(csv).not.toContain("S001");
    expect(csv).not.toContain("S002");
    expect(csv).not.toContain("第一位学习者不应出现在 cohort export 的原文");
    expect(csv).not.toContain("第二位学习者也不应进入 cohort export 原文");
    expect(csv).not.toContain("test-session-secret");
    expect(csv).not.toContain("aais_session=");

    const teacherJsonResponse = await exportRoute.GET(
      new Request("http://localhost/api/learning/export?scope=cohort&format=json&phase=practice&agent=A2&event=coaching_push", {
        headers: {
          cookie: createAuthedCookie("teacher-a", "teacher"),
        },
      }),
    );
    const json = await teacherJsonResponse.json();
    const jsonText = JSON.stringify(json);

    expect(teacherJsonResponse.status).toBe(200);
    expect(teacherJsonResponse.headers.get("content-disposition")).toContain("aais-cohort-analytics.json");
    expect(json).toMatchObject({
      schemaVersion: 1,
      exportScope: "cohort",
      filters: {
        applied: {
          phase: "practice",
          agent: "A2",
          event: "coaching_push",
        },
      },
      privacy: {
        actorMode: "pseudonymous",
        rawLearnerText: "excluded",
      },
      secrets: "redacted",
    });
    expect(json.learners).toHaveLength(1);
    expect(json.learners[0].learnerKey).toMatch(/^learner-/);
    expect(jsonText).not.toContain("S001");
    expect(jsonText).not.toContain("S002");
    expect(jsonText).not.toContain("第一位学习者不应出现在 cohort export 的原文");
    expect(jsonText).not.toContain("第二位学习者也不应进入 cohort export 原文");
    expect(jsonText).not.toContain("test-session-secret");
  });

  it("serves authenticated learning analytics for dashboards and BI integration", async () => {
    const sessionRoute = await import("@/app/api/learning/session/route");
    const analyticsRoute = await import("@/app/api/learning/analytics/route");
    const s001Cookie = createAuthedCookie("S001");

    await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          action: "complete-task",
          taskId: "training_task_1",
        }),
      }),
    );

    const response = await analyticsRoute.GET(
      new Request("http://localhost/api/learning/analytics", {
        headers: {
          cookie: s001Cookie,
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.analytics).toMatchObject({
      dashboard: {
        trainingToPractice: {
          trainingCompleted: true,
        },
      },
      integrations: {
        factLayer: "lrs",
      },
      privacy: {
        actorMode: "pseudonymous",
      },
    });
    expect(JSON.stringify(body)).not.toContain("test-session-secret");
  });

  it("serves cohort analytics only to teacher or admin sessions", async () => {
    const sessionRoute = await import("@/app/api/learning/session/route");
    const analyticsRoute = await import("@/app/api/learning/analytics/route");
    const s001Cookie = createAuthedCookie("S001");

    await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          action: "complete-task",
          taskId: "training_task_1",
        }),
      }),
    );

    const studentResponse = await analyticsRoute.GET(
      new Request("http://localhost/api/learning/analytics?scope=cohort", {
        headers: {
          cookie: s001Cookie,
        },
      }),
    );
    expect(studentResponse.status).toBe(403);

    const teacherResponse = await analyticsRoute.GET(
      new Request("http://localhost/api/learning/analytics?scope=cohort", {
        headers: {
          cookie: createAuthedCookie("teacher-a", "teacher"),
        },
      }),
    );
    const body = await teacherResponse.json();

    expect(teacherResponse.status).toBe(200);
    expect(body.analytics.dashboard.cohort).toMatchObject({
      learnerCount: 1,
      trainingCompleted: 1,
    });
    expect(JSON.stringify(body)).not.toContain("test-session-secret");
  });

  it("serves teacher cohort analytics slices by safe join-key filters", async () => {
    const sessionRoute = await import("@/app/api/learning/session/route");
    const analyticsRoute = await import("@/app/api/learning/analytics/route");
    const s001Cookie = createAuthedCookie("S001");
    const s002Cookie = createAuthedCookie("S002");

    await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          action: "complete-task",
          taskId: "training_task_1",
        }),
      }),
    );
    await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          action: "select-task",
          taskId: "practice_task_1",
        }),
      }),
    );
    await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          action: "save-artifact",
          taskId: "practice_task_1",
          artifactText: "第一位学习者的低进展 API 记录",
        }),
      }),
    );
    await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          action: "save-artifact",
          taskId: "practice_task_1",
          artifactText: "第一位学习者的低进展 API 记录",
        }),
      }),
    );
    await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie: s002Cookie,
          "x-aais-csrf": createAaisCsrfToken("S002"),
        },
        body: JSON.stringify({
          action: "save-artifact",
          taskId: "training_task_1",
          artifactText: "第二位学习者的训练 API 记录",
        }),
      }),
    );

    const teacherResponse = await analyticsRoute.GET(
      new Request("http://localhost/api/learning/analytics?scope=cohort&phase=practice&agent=A2&event=coaching_push", {
        headers: {
          cookie: createAuthedCookie("teacher-a", "teacher"),
        },
      }),
    );
    const body = await teacherResponse.json();

    expect(teacherResponse.status).toBe(200);
    expect(body.analytics.filters).toEqual({
      applied: {
        phase: "practice",
        agent: "A2",
        event: "coaching_push",
      },
    });
    expect(body.analytics.dashboard.cohort).toMatchObject({
      learnerCount: 1,
      coachingSignals: 1,
      aiInteractions: 0,
    });
    expect(body.analytics.learners).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("第一位学习者的低进展 API 记录");
    expect(JSON.stringify(body)).not.toContain("第二位学习者的训练 API 记录");
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
