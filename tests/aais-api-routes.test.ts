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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock("@/lib/ai/orchestration/aais-learning-guide-graph");
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

  it("does not echo raw task ids in learner session or scaffold errors", async () => {
    const sessionRoute = await import("@/app/api/learning/session/route");
    const scaffoldRoute = await import("@/app/api/learning/scaffold/route");
    const cookie = createAuthedCookie("S001");
    const csrf = createAaisCsrfToken("S001");

    const lockedTaskResponse = await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie,
          "x-aais-csrf": csrf,
        },
        body: JSON.stringify({
          action: "select-task",
          taskId: "practice_task_2",
        }),
      }),
    );
    const lockedTaskBody = await lockedTaskResponse.json();

    expect(lockedTaskResponse.status).toBe(400);
    expect(lockedTaskBody.error).toEqual({
      code: "AAIS_TASK_LOCKED",
      message: "AAIS task is locked.",
    });
    expect(JSON.stringify(lockedTaskBody)).not.toContain("practice_task_2");

    const unknownScaffoldResponse = await scaffoldRoute.POST(
      new Request("http://localhost/api/learning/scaffold", {
        method: "POST",
        headers: {
          cookie,
          "x-aais-csrf": csrf,
        },
        body: JSON.stringify({
          taskId: "private-task-id",
          toolId: "stage-checklist",
        }),
      }),
    );
    const unknownScaffoldBody = await unknownScaffoldResponse.json();

    expect(unknownScaffoldResponse.status).toBe(400);
    expect(unknownScaffoldBody.error).toEqual({
      code: "AAIS_TASK_UNKNOWN",
      message: "AAIS task was not found.",
    });
    expect(JSON.stringify(unknownScaffoldBody)).not.toContain("private-task-id");
  });

  it("returns role-only actor evidence for authenticated session reads", async () => {
    const sessionRoute = await import("@/app/api/learning/session/route");

    const response = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session", {
        headers: {
          cookie: createAuthedCookie("teacher-a", "teacher"),
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.actor).toEqual({
      role: "teacher",
    });
    expect(body.actor?.id).toBeUndefined();
    expect(body.actor?.displayName).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("aais_session");
  });

  it("fails closed in production when persistent learner storage is not configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("AAIS_DATA_DIR", "");
    vi.stubEnv("AAIS_DATABASE_URL", "");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("POSTGRES_URL", "");
    vi.stubEnv("POSTGRES_PRISMA_URL", "");
    vi.stubEnv("POSTGRES_URL_NO_SSL", "");
    vi.stubEnv("DATABASE_URL_UNPOOLED", "");
    vi.stubEnv("POSTGRES_URL_NON_POOLING", "");
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
      error: {
        code: "AAIS_STORAGE_NOT_CONFIGURED",
        message: "AAIS production learner storage requires Postgres configuration.",
      },
    });
  });

  it("does not call the AI provider when production storage is not configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("AAIS_DATA_DIR", "");
    vi.stubEnv("AAIS_DATABASE_URL", "");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("POSTGRES_URL", "");
    vi.stubEnv("POSTGRES_PRISMA_URL", "");
    vi.stubEnv("POSTGRES_URL_NO_SSL", "");
    vi.stubEnv("DATABASE_URL_UNPOOLED", "");
    vi.stubEnv("POSTGRES_URL_NON_POOLING", "");
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
      error: {
        code: "AAIS_STORAGE_NOT_CONFIGURED",
        message: "AAIS production learner storage requires Postgres configuration.",
      },
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
    vi.stubEnv("AAIS_AI_PROVIDER", "");
    vi.stubEnv("AAIS_AI_ENDPOINT", "");
    vi.stubEnv("AAIS_AI_API_KEY", "");
    vi.stubEnv("AAIS_AI_MODEL", "");
    vi.stubEnv("AAIS_AI_FALLBACK_ENDPOINT", "");
    vi.stubEnv("AAIS_AI_FALLBACK_API_KEY", "");
    vi.stubEnv("AAIS_AI_FALLBACK_MODEL", "");
    vi.resetModules();
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
    expect(guideResponse.status).toBe(200);
    expect(guideBody.orchestration.graph.topologicalOrder).toEqual(["A1", "A2", "A3", "A4"]);
    expect(guideBody.turns.map((turn: { agentId: string }) => turn.agentId)).toEqual([
      "A1",
      "A2",
    ]);
    expect(guideBody.turns.map((turn: { actions: string[] }) => turn.actions)).toEqual([
      ["guide-flow", "scaffold"],
      ["model", "coach", "mention-expert"],
    ]);
    expect(guideBody.backgroundTurns.map((turn: { agentId: string }) => turn.agentId)).toEqual([
      "A3",
      "A4",
    ]);
    expect(guideBody.orchestration.runtime).toMatchObject({
      engine: "aais-langgraph-runtime",
      status: "completed",
      eventCount: 4,
      modelProvider: {
        provider: "deterministic",
        generatedTurns: 4,
        fallbackTurns: 4,
      },
    });

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
    expect(sessionBody.session.guideMessages[1].turns.map((turn: { agentId: string }) => turn.agentId)).toEqual([
      "A1",
      "A2",
    ]);
    expect(sessionBody.session.guideMessages[1].text).not.toContain("监督智能体");
    expect(sessionBody.session.guideMessages[1].text).not.toContain("反思智能体");
    expect(sessionBody.session.events.map((event: { event: string }) => event.event)).toEqual(
      expect.arrayContaining(["ai_prompt_submitted", "ai_response_completed"]),
    );
  });

  it("enforces a per-student daily guide request budget", async () => {
    vi.stubEnv("AAIS_AI_DAILY_GUIDE_LIMIT", "1");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.resetModules();
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    const s001Cookie = createAuthedCookie("S001");
    const requestBody = {
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "我今天第一次请求导学。",
      workspaceState: {
        currentStep: "guide",
      },
    };

    const firstResponse = await guideRoute.POST(
      new Request("http://localhost/api/learning/ai-guide", {
        method: "POST",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify(requestBody),
      }),
    );
    const firstBody = await firstResponse.json();

    expect(firstResponse.status).toBe(200);
    expect(firstBody.budget).toMatchObject({
      limit: 1,
      used: 1,
      remaining: 0,
    });

    const secondResponse = await guideRoute.POST(
      new Request("http://localhost/api/learning/ai-guide", {
        method: "POST",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          ...requestBody,
          learnerInput: "我今天第二次请求导学。",
        }),
      }),
    );
    const secondBody = await secondResponse.json();

    expect(secondResponse.status).toBe(429);
    expect(secondBody.error).toEqual({
      code: "AAIS_GUIDE_DAILY_BUDGET_EXCEEDED",
      message: "AAIS daily guide request budget has been reached.",
    });
    expect(secondBody.budget).toMatchObject({
      limit: 1,
      used: 1,
      remaining: 0,
    });
    const auditEvents = info.mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(auditEvents.map((event) => event.event)).toEqual([
      "ai.guide.budget.used",
      "ai.guide.budget.exceeded",
    ]);
    expect(auditEvents.every((event) => event.actorIdRedaction === "sha256-16")).toBe(true);
    expect(auditEvents.map((event) => event.metadata)).toEqual([
      expect.objectContaining({
        limit: 1,
        used: 1,
        remaining: 0,
      }),
      expect.objectContaining({
        limit: 1,
        used: 1,
        remaining: 0,
      }),
    ]);
    expect(JSON.stringify(auditEvents)).not.toContain("S001");
    expect(JSON.stringify(auditEvents)).not.toContain("我今天第一次请求导学");
    expect(JSON.stringify(auditEvents)).not.toContain("我今天第二次请求导学");
    expect(JSON.stringify(secondBody)).not.toContain("我今天第二次请求导学");
    expect(JSON.stringify(secondBody)).not.toContain("test-session-secret");
  });

  it("does not reserve daily guide budget for an invalid attachment request", async () => {
    vi.stubEnv("AAIS_AI_DAILY_GUIDE_LIMIT", "1");
    vi.stubEnv("AAIS_AI_PROVIDER", "");
    vi.stubEnv("AAIS_AI_ENDPOINT", "");
    vi.stubEnv("AAIS_AI_API_KEY", "");
    vi.stubEnv("AAIS_AI_MODEL", "");
    vi.stubEnv("AAIS_AI_FALLBACK_ENDPOINT", "");
    vi.stubEnv("AAIS_AI_FALLBACK_API_KEY", "");
    vi.stubEnv("AAIS_AI_FALLBACK_MODEL", "");
    vi.resetModules();
    const storeModule = await import("@/lib/server/aais-learning-store");
    const store = storeModule.getAaisLearningStore();
    const reserveBudget = vi.spyOn(store, "reserveDailyGuideRequest");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    const cookie = createAuthedCookie("S001");
    const csrf = createAaisCsrfToken("S001");

    const invalidResponse = await guideRoute.POST(
      new Request("http://localhost/api/learning/ai-guide", {
        method: "POST",
        headers: {
          cookie,
          "x-aais-csrf": csrf,
        },
        body: JSON.stringify({
          phase: "training",
          taskId: "training_task_1",
          learnerInput: "请看不支持的文件。",
          workspaceState: {
            currentStep: "guide",
            attachments: [{
              name: "image.png",
              mediaType: "image/png",
              sizeBytes: 1200,
              extractedText: "not allowed",
            }],
          },
        }),
      }),
    );

    expect(invalidResponse.status).toBe(400);
    expect(reserveBudget).not.toHaveBeenCalled();
    expect(info.mock.calls.map((call) => JSON.parse(String(call[0]))).filter((event) =>
      event.event === "ai.guide.budget.used"
    )).toHaveLength(0);

    const validResponse = await guideRoute.POST(
      new Request("http://localhost/api/learning/ai-guide", {
        method: "POST",
        headers: {
          cookie,
          "x-aais-csrf": csrf,
        },
        body: JSON.stringify({
          phase: "training",
          taskId: "training_task_1",
          learnerInput: "现在给我一个有效建议。",
          workspaceState: { currentStep: "guide" },
        }),
      }),
    );
    const validBody = await validResponse.json();

    expect(validResponse.status).toBe(200);
    expect(validBody.budget).toMatchObject({ limit: 1, used: 1, remaining: 0 });
    expect(reserveBudget).toHaveBeenCalledTimes(1);
    expect(info.mock.calls.map((call) => JSON.parse(String(call[0]))).filter((event) =>
      event.event === "ai.guide.budget.used"
    )).toHaveLength(1);
  });

  it("accepts sanitized guide attachments without persisting uploaded raw text", async () => {
    vi.stubEnv("AAIS_AI_PROVIDER", "");
    vi.stubEnv("AAIS_AI_ENDPOINT", "");
    vi.stubEnv("AAIS_AI_API_KEY", "");
    vi.stubEnv("AAIS_AI_MODEL", "");
    vi.stubEnv("AAIS_AI_FALLBACK_ENDPOINT", "");
    vi.stubEnv("AAIS_AI_FALLBACK_API_KEY", "");
    vi.stubEnv("AAIS_AI_FALLBACK_MODEL", "");
    vi.resetModules();
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
          learnerInput: "请阅读上传文件并给我下一步建议。",
          workspaceState: {
            currentStep: "guide",
            attachments: [
              {
                name: "planning-notes.txt",
                mediaType: "text/plain",
                sizeBytes: 52,
                extractedText: "private uploaded snippet must not persist in session JSON",
              },
            ],
          },
        }),
      }),
    );
    const guideBody = await guideResponse.json();

    expect(guideResponse.status).toBe(200);
    expect(guideBody.message.text).toContain("planning-notes.txt");

    const sessionResponse = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session", {
        headers: {
          cookie: s001Cookie,
        },
      }),
    );
    const sessionBody = await sessionResponse.json();
    const serializedSession = JSON.stringify(sessionBody.session);

    expect(serializedSession).toContain("请阅读上传文件并给我下一步建议。");
    expect(serializedSession).not.toContain("private uploaded snippet must not persist");
    expect(serializedSession).not.toContain("attachments");
  });

  it("rejects invalid guide attachment payloads", async () => {
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
          learnerInput: "请看文件。",
          workspaceState: {
            currentStep: "guide",
            attachments: [
              {
                name: "image.png",
                mediaType: "image/png",
                sizeBytes: 1200,
                extractedText: "not allowed",
              },
            ],
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: "AAIS_GUIDE_ATTACHMENT_INVALID",
      message: "AAIS guide attachment is invalid.",
    });
    expect(JSON.stringify(body)).not.toContain("image/png");
  });

  it("parses @A2 guide mentions and persists only the targeted visible answer", async () => {
    vi.stubEnv("AAIS_AI_PROVIDER", "");
    vi.stubEnv("AAIS_AI_ENDPOINT", "");
    vi.stubEnv("AAIS_AI_API_KEY", "");
    vi.stubEnv("AAIS_AI_MODEL", "");
    vi.stubEnv("AAIS_AI_FALLBACK_ENDPOINT", "");
    vi.stubEnv("AAIS_AI_FALLBACK_API_KEY", "");
    vi.stubEnv("AAIS_AI_FALLBACK_MODEL", "");
    vi.resetModules();
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
          learnerInput: "@A2 请示范专家会怎样监控理解。",
          workspaceState: {
            currentStep: "guide",
          },
        }),
      }),
    );
    const guideBody = await guideResponse.json();

    expect(guideResponse.status).toBe(200);
    expect(guideBody.turns.map((turn: { agentId: string }) => turn.agentId)).toEqual(["A2"]);
    expect(guideBody.message.text).toContain("专家智能体");
    expect(guideBody.message.text).not.toContain("导学智能体");
    expect(guideBody.backgroundTurns.map((turn: { agentId: string }) => turn.agentId)).toEqual([
      "A3",
      "A4",
    ]);

    const sessionResponse = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session", {
        headers: {
          cookie: s001Cookie,
        },
      }),
    );
    const sessionBody = await sessionResponse.json();

    expect(sessionBody.session.guideMessages[1].turns.map((turn: { agentId: string }) => turn.agentId)).toEqual([
      "A2",
    ]);
    expect(sessionBody.session.guideMessages[1].text).toContain("专家智能体");
    expect(sessionBody.session.guideMessages[1].text).not.toContain("导学智能体");
  });

  it("returns a timed provider fallback for targeted guide aborts without calling hidden agents live", async () => {
    vi.stubEnv("AAIS_AI_PROVIDER", "openai-compatible");
    vi.stubEnv("AAIS_AI_ENDPOINT", "https://ai.example.test/v1/chat/completions");
    vi.stubEnv("AAIS_AI_API_KEY", "secret-api-key");
    vi.stubEnv("AAIS_AI_MODEL", "enterprise-model");
    vi.stubEnv("AAIS_AI_MAX_RETRIES", "0");
    vi.resetModules();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw Object.assign(new Error("provider aborted"), { name: "AbortError" });
    });
    vi.stubGlobal("fetch", fetchMock);
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
          learnerInput: "@A1 请帮我明确目标。",
          workspaceState: {
            currentStep: "guide",
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body.turns.map((turn: { agentId: string }) => turn.agentId)).toEqual(["A1"]);
    expect(body.backgroundTurns.map((turn: { agentId: string }) => turn.agentId)).toEqual([
      "A3",
      "A4",
    ]);
    expect(body.message.text).toContain("导学智能体");
    expect(body.orchestration.runtime.timings).toMatchObject({
      fallback: true,
      timeoutReason: "abort-timeout",
      attempts: 1,
    });
    expect(body.orchestration.runtime.ai).toMatchObject({
      mode: "live",
      primary: {
        provider: "openai-compatible",
        thinkingMode: "provider-default",
        timeoutMs: {
          effective: 12000,
          max: 30000,
        },
      },
      redaction: {
        secrets: "omitted",
        endpoints: "omitted",
      },
    });
    expect(JSON.stringify(body)).not.toContain("secret-api-key");
    expect(JSON.stringify(body)).not.toContain("https://ai.example.test");
  });

  it("streams guide acknowledgement and agent events only when event-stream is requested", async () => {
    vi.stubEnv("AAIS_AI_PROVIDER", "");
    vi.stubEnv("AAIS_AI_ENDPOINT", "");
    vi.stubEnv("AAIS_AI_API_KEY", "");
    vi.stubEnv("AAIS_AI_MODEL", "");
    vi.stubEnv("AAIS_AI_FALLBACK_ENDPOINT", "");
    vi.stubEnv("AAIS_AI_FALLBACK_API_KEY", "");
    vi.stubEnv("AAIS_AI_FALLBACK_MODEL", "");
    vi.resetModules();
    const guideRoute = await import("@/app/api/learning/ai-guide/route");

    const response = await guideRoute.POST(
      new Request("http://localhost/api/learning/ai-guide?stream=1", {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          cookie: createAuthedCookie("S001"),
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          phase: "training",
          taskId: "training_task_1",
          learnerInput: "@A1 请帮我明确目标。",
          workspaceState: {
            currentStep: "guide",
          },
        }),
      }),
    );
    const streamText = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(streamText).toContain("event: ack");
    expect(streamText).toContain("event: agent_start");
    expect(streamText).toContain("event: agent_delta");
    expect(streamText).toContain("event: agent_done");
    expect(streamText).toContain("event: fallback");
    expect(streamText).toContain("event: background_done");
    expect(streamText).not.toContain("secret");
  });

  it("emits stream acknowledgement before the guide graph finishes", async () => {
    vi.stubEnv("AAIS_AI_PROVIDER", "");
    vi.stubEnv("AAIS_AI_ENDPOINT", "");
    vi.stubEnv("AAIS_AI_API_KEY", "");
    vi.stubEnv("AAIS_AI_MODEL", "");
    vi.stubEnv("AAIS_AI_FALLBACK_ENDPOINT", "");
    vi.stubEnv("AAIS_AI_FALLBACK_API_KEY", "");
    vi.stubEnv("AAIS_AI_FALLBACK_MODEL", "");
    vi.resetModules();
    const graphResult = createDeferredGuideResult();
    const graphMock = vi.fn(() => graphResult.promise);
    vi.doMock("@/lib/ai/orchestration/aais-learning-guide-graph", () => ({
      runAaisLearningGuideGraph: graphMock,
    }));
    const guideRoute = await import("@/app/api/learning/ai-guide/route");

    const response = await guideRoute.POST(
      new Request("http://localhost/api/learning/ai-guide?stream=1", {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          cookie: createAuthedCookie("S001"),
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          phase: "training",
          taskId: "training_task_1",
          learnerInput: "@A1 请先告诉我你已经开始处理。",
          workspaceState: {
            currentStep: "guide",
          },
        }),
      }),
    );
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Expected guide stream body.");
    }

    const decoder = new TextDecoder();
    const firstChunk = await reader.read();
    let progressText = decoder.decode(firstChunk.value);
    for (let index = 0; index < 5 && !progressText.includes("event: agent_start"); index += 1) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      progressText += decoder.decode(next.value);
    }

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(graphMock).toHaveBeenCalledTimes(1);
    expect(progressText).toContain("event: ack");
    expect(progressText).toContain("event: agent_start");
    expect(progressText).not.toContain("Mocked final answer");

    graphResult.resolve(createMockGuideGraphResult());
    let remainingText = "";
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      remainingText += decoder.decode(next.value);
    }

    expect(remainingText).toContain("Mocked final answer");
    expect(remainingText).toContain("event: background_done");
    vi.doUnmock("@/lib/ai/orchestration/aais-learning-guide-graph");
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
    const rawSessionResponse = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session", {
        headers: {
          cookie: s001Cookie,
        },
      }),
    );
    const rawSessionBody = await rawSessionResponse.json();
    const rawSessionId = rawSessionBody.session.sessionId;

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
    expect(json.learners[0].sessionKey).toMatch(/^session-[a-f0-9]{12}$/);
    expect(json.learners[0]).not.toHaveProperty("sessionId");
    expect(jsonText).not.toContain("S001");
    expect(jsonText).not.toContain("S002");
    expect(jsonText).not.toContain(rawSessionId);
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
    expect(body.analytics.pagination).toMatchObject({
      limit: 25,
      offset: 0,
      returnedLearners: 1,
      totalLearners: 1,
      hasPreviousPage: false,
      hasNextPage: false,
    });
    expect(body.analytics.learners).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("第一位学习者的低进展 API 记录");
    expect(JSON.stringify(body)).not.toContain("第二位学习者的训练 API 记录");
  });

  it("serves rule-based recommendations and records educator overrides as redacted events", async () => {
    const sessionRoute = await import("@/app/api/learning/session/route");
    const recommendationsRoute = await import("@/app/api/learning/recommendations/route");
    const { createAaisLearningStore } = await import("@/lib/server/aais-learning-store");
    const s001Cookie = createAuthedCookie("S001");
    const teacherCookie = createAuthedCookie("teacher-a", "teacher");

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
          artifactText: "推荐规则不应泄漏的低进展记录",
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
          artifactText: "推荐规则不应泄漏的低进展记录",
        }),
      }),
    );

    const studentResponse = await recommendationsRoute.GET(
      new Request("http://localhost/api/learning/recommendations", {
        headers: {
          cookie: s001Cookie,
        },
      }),
    );
    expect(studentResponse.status).toBe(403);

    const teacherResponse = await recommendationsRoute.GET(
      new Request("http://localhost/api/learning/recommendations", {
        headers: {
          cookie: teacherCookie,
        },
      }),
    );
    const body = await teacherResponse.json();
    const serialized = JSON.stringify(body);

    expect(teacherResponse.status).toBe(200);
    expect(body.policy).toMatchObject({
      version: "aais-rule-recommendations-v1",
      teacherOverride: true,
    });
    expect(body.recommendations.length).toBeGreaterThan(0);
    expect(body.recommendations[0]).toMatchObject({
      id: expect.stringMatching(/^recommendation-[a-f0-9]{12}$/),
      learnerKey: expect.stringMatching(/^learner-[a-f0-9]{12}$/),
      sessionKey: expect.stringMatching(/^session-[a-f0-9]{12}$/),
      reasons: expect.any(Array),
    });
    expect(serialized).not.toContain("S001");
    expect(serialized).not.toContain("推荐规则不应泄漏的低进展记录");

    const recommendation = body.recommendations[0];
    const overrideResponse = await recommendationsRoute.POST(
      new Request("http://localhost/api/learning/recommendations", {
        method: "POST",
        headers: {
          cookie: teacherCookie,
          "x-aais-csrf": extractCookieFromHeader(teacherCookie, getAaisCsrfCookieName()),
        },
        body: JSON.stringify({
          recommendationId: recommendation.id,
          learnerKey: recommendation.learnerKey,
          sessionKey: recommendation.sessionKey,
          ruleId: recommendation.ruleId,
          targetTaskId: recommendation.targetTaskId,
          decision: "accepted",
          note: "教师已线下处理，原文不能进入事件。",
        }),
      }),
    );
    const overrideBody = await overrideResponse.json();

    expect(overrideResponse.status).toBe(200);
    expect(overrideBody.override).toMatchObject({
      recommendationId: recommendation.id,
      learnerKey: recommendation.learnerKey,
      sessionKey: recommendation.sessionKey,
      decision: "accepted",
      event: "recommendation_override_recorded",
    });

    const session = await createAaisLearningStore({ rootDir: tempDir }).getOrCreateSession("S001");
    const overrideEvent = session.events.find((event) => event.event === "recommendation_override_recorded");
    expect(overrideEvent).toMatchObject({
      agent: "platform",
      detail: {
        recommendation_id: recommendation.id,
        decision: "accepted",
        educator_role: "teacher",
        educator_key: expect.stringMatching(/^educator-[a-f0-9]{12}$/),
        note_length: expect.any(Number),
        raw_note: "excluded",
      },
    });
    expect(JSON.stringify(overrideEvent)).not.toContain("教师已线下处理");
    expect(JSON.stringify(overrideEvent)).not.toContain("teacher-a");
  });

  it("feature-flags teacher recommendations without exposing analytics or accepting overrides", async () => {
    vi.stubEnv("AAIS_RECOMMENDATIONS_ENABLED", "false");
    const recommendationsRoute = await import("@/app/api/learning/recommendations/route");
    const teacherCookie = createAuthedCookie("teacher-a", "teacher");
    const csrf = extractCookieFromHeader(teacherCookie, getAaisCsrfCookieName());

    const response = await recommendationsRoute.GET(
      new Request("http://localhost/api/learning/recommendations", {
        headers: {
          cookie: teacherCookie,
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      recommendations: [],
      policy: {
        version: "aais-rule-recommendations-v1",
        enabled: false,
        factLayer: "disabled",
      },
      actor: {
        role: "teacher",
      },
      secrets: "redacted",
    });
    expect(JSON.stringify(body)).not.toContain("teacher-a");

    const overrideResponse = await recommendationsRoute.POST(
      new Request("http://localhost/api/learning/recommendations", {
        method: "POST",
        headers: {
          cookie: teacherCookie,
          "x-aais-csrf": csrf,
        },
        body: JSON.stringify({
          recommendationId: "recommendation-abcdef123456",
          learnerKey: "learner-abcdef123456",
          sessionKey: "session-abcdef123456",
          ruleId: "complete_reflection",
          targetTaskId: "practice_task_1",
          decision: "accepted",
        }),
      }),
    );
    const overrideBody = await overrideResponse.json();

    expect(overrideResponse.status).toBe(503);
    expect(overrideBody.error).toEqual({
      code: "AAIS_RECOMMENDATIONS_DISABLED",
      message: "AAIS recommendations are disabled for this environment.",
    });
  });

  it("authorizes cohort analytics before filter validation and validates filters before storage access", async () => {
    stubProductionWithoutDatabase();
    vi.resetModules();
    const analyticsRoute = await import("@/app/api/learning/analytics/route");
    const exportRoute = await import("@/app/api/learning/export/route");

    const anonymousResponse = await analyticsRoute.GET(
      new Request("http://localhost/api/learning/analytics?scope=cohort&phase=lecture"),
    );
    const anonymousBody = await anonymousResponse.json();

    expect(anonymousResponse.status).toBe(401);
    expect(anonymousBody.error).toEqual({
      code: "AAIS_AUTH_REQUIRED",
      message: "AAIS authentication is required.",
    });
    expect(anonymousBody.secrets).toBe("redacted");

    const studentResponse = await analyticsRoute.GET(
      new Request("http://localhost/api/learning/analytics?scope=cohort&phase=lecture", {
        headers: {
          cookie: createAuthedCookie("S001"),
        },
      }),
    );
    const studentBody = await studentResponse.json();

    expect(studentResponse.status).toBe(403);
    expect(studentBody.error).toEqual({
      code: "AAIS_COHORT_ANALYTICS_FORBIDDEN",
      message: "AAIS teacher analytics requires educator authorization.",
    });
    expect(studentBody.secrets).toBe("redacted");

    const teacherAnalyticsResponse = await analyticsRoute.GET(
      new Request("http://localhost/api/learning/analytics?scope=cohort&phase=lecture", {
        headers: {
          cookie: createAuthedCookie("teacher-a", "teacher"),
        },
      }),
    );
    const teacherAnalyticsBody = await teacherAnalyticsResponse.json();

    expect(teacherAnalyticsResponse.status).toBe(400);
    expect(teacherAnalyticsBody.error).toEqual({
      code: "AAIS_COHORT_ANALYTICS_FILTER_INVALID",
      message: "AAIS cohort analytics filter is invalid.",
    });
    expect(teacherAnalyticsBody.secrets).toBe("redacted");
    expect(JSON.stringify(teacherAnalyticsBody)).not.toContain("lecture");

    const teacherExportResponse = await exportRoute.GET(
      new Request("http://localhost/api/learning/export?scope=cohort&format=json&event=raw_dump", {
        headers: {
          cookie: createAuthedCookie("teacher-a", "teacher"),
        },
      }),
    );
    const teacherExportBody = await teacherExportResponse.json();

    expect(teacherExportResponse.status).toBe(400);
    expect(teacherExportBody.error).toEqual({
      code: "AAIS_COHORT_ANALYTICS_FILTER_INVALID",
      message: "AAIS cohort analytics filter is invalid.",
    });
    expect(teacherExportBody.secrets).toBe("redacted");
    expect(JSON.stringify(teacherExportBody)).not.toContain("raw_dump");
  });
});

function stubProductionWithoutDatabase() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("AAIS_DATA_DIR", "");
  vi.stubEnv("AAIS_DATABASE_URL", "");
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("POSTGRES_URL", "");
  vi.stubEnv("DATABASE_URL_UNPOOLED", "");
  vi.stubEnv("POSTGRES_PRISMA_URL", "");
  vi.stubEnv("POSTGRES_URL_NO_SSL", "");
  vi.stubEnv("POSTGRES_URL_NON_POOLING", "");
  vi.stubEnv("PGHOST", "");
  vi.stubEnv("PGHOST_UNPOOLED", "");
  vi.stubEnv("PGUSER", "");
  vi.stubEnv("PGDATABASE", "");
  vi.stubEnv("PGPASSWORD", "");
  vi.stubEnv("POSTGRES_HOST", "");
  vi.stubEnv("POSTGRES_HOST_NON_POOLING", "");
  vi.stubEnv("POSTGRES_USER", "");
  vi.stubEnv("POSTGRES_DATABASE", "");
  vi.stubEnv("POSTGRES_PASSWORD", "");
}

function createAuthedCookie(id: string, role: "student" | "teacher" | "admin" = "student") {
  const csrfToken = createAaisCsrfToken(id);
  const sessionToken = createAaisSessionToken({
    id,
    role,
    displayName: id,
  });
  return `aais_session=${sessionToken}; ${getAaisCsrfCookieName()}=${csrfToken}`;
}

function extractCookieFromHeader(cookieHeader: string, name: string) {
  const cookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return cookie?.slice(name.length + 1) ?? "";
}

function createDeferredGuideResult() {
  let resolve!: (value: ReturnType<typeof createMockGuideGraphResult>) => void;
  const promise = new Promise<ReturnType<typeof createMockGuideGraphResult>>((nextResolve) => {
    resolve = nextResolve;
  });
  return {
    promise,
    resolve,
  };
}

function createMockGuideGraphResult() {
  return {
    messageText: "Mocked final answer",
    visibleTurns: [
      {
        agentId: "A1",
        label: "导学智能体",
        content: "Mocked final answer",
        actions: ["respond"],
      },
    ],
    backgroundTurns: [
      {
        agentId: "A3",
        label: "监督智能体",
        content: "后台监督信号已记录。",
        actions: ["monitor"],
      },
    ],
    graph: {
      graphId: "learning-ai-guide",
      topologicalOrder: ["A1", "A3"],
    },
    runtime: {
      threadId: "mock-thread",
      timings: {
        fallback: false,
        agents: [
          {
            agentId: "A1",
            status: "completed",
          },
        ],
      },
    },
    trace: [],
  };
}
