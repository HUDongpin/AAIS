import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAaisCsrfToken as createUncachedAaisCsrfToken,
  getAaisCsrfCookieName,
} from "@/lib/server/aais-csrf";
import {
  createAaisOidcActorId,
  getAaisOidcSessionPolicyFingerprint,
} from "@/lib/server/aais-oidc";
import { createAaisSessionToken } from "@/lib/server/aais-session";

// This suite exercises learning-route contracts rather than the session
// revocation store. Production-mode cases deliberately remove the learner
// database so they can assert downstream storage/input behavior; keep the
// independently tested revocation lookup satisfied instead of letting that
// prerequisite turn every request into an unrelated 401.
vi.mock("@/lib/server/aais-session-revocations", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/server/aais-session-revocations")
  >("@/lib/server/aais-session-revocations");
  return {
    ...actual,
    isAaisSessionTokenRevoked: vi.fn(async () => false),
  };
});

let tempDir: string;
const testCsrfTokens = new Map<string, string>();

beforeEach(async () => {
  testCsrfTokens.clear();
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-api-"));
  process.env.AAIS_DATA_DIR = tempDir;
  process.env.AAIS_SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
  vi.resetModules();
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env.AAIS_DATA_DIR;
  delete process.env.AAIS_SESSION_SECRET;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock("@/lib/ai/orchestration/aais-learning-guide-graph");
  await rm(tempDir, { force: true, recursive: true });
});

describe("AAIS learning API routes", () => {
  it("loads and mutates a durable session through the session route", async () => {
    const sessionRoute = await import("@/app/api/learning/session/route");
    const s001Csrf = createAaisCsrfToken("S001");
    const s001Cookie = createAuthedCookie("S001", "student", s001Csrf);

    let response = await sessionRoute.POST(
      new Request("http://localhost/api/learning/session", {
        method: "POST",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": s001Csrf,
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
          "x-aais-csrf": s001Csrf,
        },
        body: JSON.stringify({
          dataGeneration: 1,
          action: "save-artifact",
          taskId: "training_task_1",
          artifactText: "训练任务过程记录",
          expectedArtifactRevision: 0,
          mutationId: "route-artifact-save-initial",
        }),
      }),
    );
    body = await response.json();
    expect(body.session.tasks[0].artifactText).toBe("训练任务过程记录");

    response = await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": s001Csrf,
        },
        body: JSON.stringify({
          dataGeneration: 1,
          action: "archive-artifact",
          taskId: "training_task_1",
          expectedArtifactRevision: 1,
        }),
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "AAIS_SESSION_REQUIRED_FIELD",
      },
    });

    response = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session", {
        headers: { cookie: s001Cookie },
      }),
    );
    body = await response.json();
    expect(body.session.tasks[0].artifactText).toBe("训练任务过程记录");
    expect(body.session.historyDocuments).toEqual([]);

    response = await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": s001Csrf,
        },
        body: JSON.stringify({
          dataGeneration: 1,
          action: "archive-artifact",
          taskId: "training_task_1",
          expectedArtifactRevision: 1,
          document: {
            id: "training_task_1-api-archive",
            taskId: "training_task_1",
            title: "训练记录",
            html: "训练任务过程记录",
            savedAt: "2026-08-07T08:00:00.000Z",
          },
          mutationId: "route-artifact-archive-initial",
        }),
      }),
    );
    body = await response.json();
    expect(body.session.tasks[0].artifactText).toBe("");
    expect(body.session.tasks[0].artifactRevision).toBe(2);
    expect(body.session.historyDocuments).toEqual([{
      id: "training_task_1-api-archive",
      taskId: "training_task_1",
      title: "训练记录",
      html: "训练任务过程记录",
      savedAt: "2026-08-07T08:00:00.000Z",
    }]);

    const archiveReplay = await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": s001Csrf,
        },
        body: JSON.stringify({
          dataGeneration: 1,
          action: "archive-artifact",
          taskId: "training_task_1",
          expectedArtifactRevision: 1,
          document: {
            id: "training_task_1-api-archive",
            taskId: "training_task_1",
            title: "训练记录",
            html: "训练任务过程记录",
            savedAt: "2026-08-07T08:00:00.000Z",
          },
          mutationId: "route-artifact-archive-initial",
        }),
      }),
    );
    expect(archiveReplay.status).toBe(200);
    const archiveReplayBody = await archiveReplay.json();
    expect(archiveReplayBody.session.tasks[0].artifactRevision).toBe(2);
    expect(archiveReplayBody.session.historyDocuments).toHaveLength(1);

    const staleArchive = await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": s001Csrf,
        },
        body: JSON.stringify({
          dataGeneration: 1,
          action: "archive-artifact",
          taskId: "training_task_1",
          expectedArtifactRevision: 1,
          document: {
            id: "stale-training-task-archive",
            taskId: "training_task_1",
            title: "迟到旧归档",
            html: "迟到旧正文",
            savedAt: "2026-08-07T09:00:00.000Z",
          },
          mutationId: "route-stale-artifact-archive",
        }),
      }),
    );
    expect(staleArchive.status).toBe(409);
    await expect(staleArchive.json()).resolves.toMatchObject({
      error: { code: "AAIS_ARTIFACT_REVISION_CONFLICT" },
    });

    response = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session", {
        headers: {
          cookie: s001Cookie,
        },
      }),
    );
    body = await response.json();
    expect(body.session.tasks[0].artifactText).toBe("");
    expect(body.session.historyDocuments[0].title).toBe("训练记录");

    const phoebeCsrf = createAaisCsrfToken("Phoebe");
    response = await sessionRoute.POST(
      new Request("http://localhost/api/learning/session", {
        method: "POST",
        headers: {
          cookie: createAuthedCookie("Phoebe", "student", phoebeCsrf),
          "x-aais-csrf": phoebeCsrf,
        },
      }),
    );
    body = await response.json();
    expect(body.session.studentId).toBe("Phoebe");
  });

  it("opens Task 4 exploration on Task 2 completion and derives exploration guide mode", async () => {
    const studentId = "route-task-two-to-four";
    const csrf = createAaisCsrfToken(studentId);
    const cookie = createAuthedCookie(studentId, "student", csrf);
    await initializeLearnerSession(studentId, cookie, csrf);
    const { getAaisLearningStore } = await import("@/lib/server/aais-learning-store");
    const store = getAaisLearningStore();
    await store.recordStageEvidence(
      studentId,
      "training_task_1",
      "launch_import",
      "orientation_acknowledged",
    );
    await store.recordStageEvidence(
      studentId,
      "training_task_1",
      "modeling",
      "expert_model_reviewed",
    );
    await store.completeTask(studentId, "training_task_1");
    await store.selectTask(studentId, "practice_task_1");
    await store.savePilotEvidence(studentId, "practice_task_1", {
      diagnosisText: "原提示词缺少目标范围、证据标准和输出约束。",
      revisedPromptText: "请按目标、范围、证据和格式约束生成课程论文大纲。",
      outputEvaluationText: "结构基本完整，但证据范围仍需人工复核和修订。",
      articulationText: "我先诊断，再修订提示词，最后按标准评价生成结果。",
    }, {
      expectedPilotEvidenceRevision: 0,
      mutationId: "route-task-two-evidence",
    });
    await store.recordStageEvidence(
      studentId,
      "practice_task_1",
      "coaching_scaffolding",
      "guided_practice_completed",
    );
    await store.recordStageEvidence(
      studentId,
      "practice_task_1",
      "articulation",
      "strategy_articulated",
    );

    const sessionRoute = await import("@/app/api/learning/session/route");
    const invalidSummary = await sessionRoute.PATCH(new Request(
      "http://localhost/api/learning/session",
      {
        method: "PATCH",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          action: "record-stage-evidence",
          taskId: "practice_task_1",
          stageId: "summary_completion",
          evidenceKind: "summary_acknowledged",
          dataGeneration: 1,
          mutationId: "invalid-summary-stage-evidence",
        }),
      },
    ));
    expect(invalidSummary.status).toBe(400);
    await expect(invalidSummary.json()).resolves.toMatchObject({
      error: { code: "AAIS_STAGE_EVIDENCE_INVALID" },
    });

    const completedResponse = await sessionRoute.PATCH(new Request(
      "http://localhost/api/learning/session",
      {
        method: "PATCH",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          action: "complete-task",
          taskId: "practice_task_1",
          dataGeneration: 1,
          mutationId: "complete-task-two-route",
        }),
      },
    ));
    expect(completedResponse.status).toBe(200);
    const completedBody = await completedResponse.json();
    const taskFour = completedBody.session.tasks.find((task: { taskId: string }) =>
      task.taskId === "practice_task_3"
    );
    expect(completedBody.session.activeTaskId).toBe("practice_task_3");
    expect(completedBody.session.activeStage).toBe("exploration");
    expect(taskFour).toMatchObject({ status: "active", activeMilestone: "exploration" });
    expect(taskFour.milestones.find((milestone: { id: string }) => milestone.id === "exploration"))
      .toMatchObject({ status: "open", evidenceKinds: [] });
    expect(completedBody.session.tasks.find((task: { taskId: string }) =>
      task.taskId === "practice_task_2"
    )).toMatchObject({ status: "locked" });

    const graphMock = vi.fn(async (input: unknown) => {
      void input;
      return createMockGuideGraphResult();
    });
    vi.doMock("@/lib/ai/orchestration/aais-learning-guide-graph", () => ({
      runAaisLearningGuideGraph: graphMock,
    }));
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    const guideResponse = await guideRoute.POST(new Request(
      "http://localhost/api/learning/ai-guide",
      {
        method: "POST",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          dataGeneration: 1,
          taskId: "practice_task_3",
          learnerInput: "我准备开始独立探索。",
          workspaceState: { currentStep: "modeling" },
        }),
      },
    ));
    expect(guideResponse.status).toBe(200);
    expect(graphMock).toHaveBeenCalledTimes(1);
    expect(graphMock.mock.calls[0]?.[0]).toMatchObject({
      taskId: "practice_task_3",
      workspaceState: {
        currentStep: "exploration",
        taskMode: "exploration",
      },
    });
  });

  it("refuses an incomplete Task 2 exit until all non-articulation evidence and milestones exist", async () => {
    const studentId = "route-task-two-incomplete";
    const csrf = createAaisCsrfToken(studentId);
    const cookie = createAuthedCookie(studentId, "student", csrf);
    await initializeLearnerSession(studentId, cookie, csrf);
    const { getAaisLearningStore } = await import("@/lib/server/aais-learning-store");
    const store = getAaisLearningStore();
    await store.recordStageEvidence(
      studentId,
      "training_task_1",
      "launch_import",
      "orientation_acknowledged",
    );
    await store.recordStageEvidence(
      studentId,
      "training_task_1",
      "modeling",
      "expert_model_reviewed",
    );
    await store.completeTask(studentId, "training_task_1");
    await store.selectTask(studentId, "practice_task_1");
    const sessionRoute = await import("@/app/api/learning/session/route");
    let stableActionCounter = 0;
    const patch = (body: Record<string, unknown>) => sessionRoute.PATCH(new Request(
      "http://localhost/api/learning/session",
      {
        method: "PATCH",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          ...body,
          dataGeneration: 1,
          mutationId: body.mutationId ?? `route-stable-action-${++stableActionCounter}`,
        }),
      },
    ));

    const declinedOnly = await patch({
      action: "save-pilot-evidence",
      taskId: "practice_task_1",
      pilotEvidence: {
        articulationOutcome: "declined",
        articulationDeclineReason: "本次暂不提交表达。",
      },
      expectedPilotEvidenceRevision: 0,
      mutationId: "route-task-two-decline-only",
    });
    expect(declinedOnly.status).toBe(200);
    const rejectedCompletion = await patch({
      action: "complete-task",
      taskId: "practice_task_1",
      endIncomplete: true,
    });
    expect(rejectedCompletion.status).toBe(409);
    await expect(rejectedCompletion.json()).resolves.toMatchObject({
      error: {
        code: "AAIS_TASK_COMPLETION_EVIDENCE_MISSING",
      },
      details: {
        completionMissing: expect.arrayContaining([
          "diagnose_original_prompt",
          "submit_revised_prompt",
          "evaluate_generated_outline",
        ]),
      },
    });

    const coreEvidence = await patch({
      action: "save-pilot-evidence",
      taskId: "practice_task_1",
      pilotEvidence: {
        diagnosisText: "原提示词缺少目标范围、证据标准和输出约束。",
        revisedPromptText: "请按目标、范围、证据和格式约束生成课程论文大纲。",
        outputEvaluationText: "结构基本完整，但证据范围仍需人工复核和修订。",
        articulationOutcome: "declined",
      },
      expectedPilotEvidenceRevision: 1,
      mutationId: "route-task-two-core-evidence",
    });
    expect(coreEvidence.status).toBe(200);
    const coached = await patch({
      action: "record-stage-evidence",
      taskId: "practice_task_1",
      stageId: "coaching_scaffolding",
      evidenceKind: "guided_practice_completed",
    });
    expect(coached.status).toBe(200);
    const ended = await patch({
      action: "complete-task",
      taskId: "practice_task_1",
      endIncomplete: true,
    });
    expect(ended.status).toBe(200);
    const endedBody = await ended.json();
    expect(endedBody.session.tasks.find((task: { taskId: string }) =>
      task.taskId === "practice_task_1"
    )).toMatchObject({
      status: "completed",
      completionOutcome: "ended_incomplete",
      completionMissing: ["articulate_task_two_process"],
    });
  });

  it("bounds session and scaffold response histories with explicit truncation metadata", async () => {
    const sessionRoute = await import("@/app/api/learning/session/route");
    const scaffoldRoute = await import("@/app/api/learning/scaffold/route");
    const studentId = "bounded-session-response";
    const csrf = createAaisCsrfToken(studentId);
    const cookie = createAuthedCookie(studentId, "student", csrf);
    await initializeLearnerSession(studentId, cookie, csrf);

    const sessionPath = path.join(tempDir, "sessions", `${studentId}.json`);
    const persisted = JSON.parse(await readFile(sessionPath, "utf8")) as {
      activeTaskId: string;
      activeStage: string;
      events: Array<Record<string, unknown>>;
      guideMessages: Array<Record<string, unknown>>;
      tasks: Array<{
        taskId: string;
        status: string;
        scaffoldRequests: number;
        scaffoldHistory: Array<Record<string, unknown>>;
      }>;
    };
    const eventTemplate = persisted.events[0];
    if (!eventTemplate) {
      throw new Error("Expected a learner event fixture.");
    }
    persisted.events = Array.from({ length: 107 }, (_value, index) => ({
      ...eventTemplate,
      detail: { window_index: index },
    }));
    persisted.guideMessages = Array.from({ length: 106 }, (_value, index) => ({
      id: `api-window-message-${index}`,
      kind: index % 2 === 0 ? "user" : "assistant",
      text: `message-${index}`,
      time: "2026-08-20T00:00:00.000Z",
    }));
    persisted.activeTaskId = "practice_task_1";
    persisted.activeStage = "guide";
    persisted.tasks = persisted.tasks.map((task) => task.taskId === "practice_task_1"
      ? {
          ...task,
          status: "active",
          scaffoldRequests: 22,
          scaffoldHistory: Array.from({ length: 22 }, (_value, index) => ({
            toolId: `api-window-tool-${index}`,
            mode: "self-check",
            time: "2026-08-20T00:00:00.000Z",
          })),
        }
      : task);
    await writeFile(sessionPath, `${JSON.stringify(persisted)}\n`, "utf8");

    const sessionResponse = await sessionRoute.GET(new Request(
      "http://localhost/api/learning/session",
      { headers: { cookie } },
    ));
    const sessionBody = await sessionResponse.json();
    expect(sessionResponse.status).toBe(200);
    expect(sessionBody.session.events).toHaveLength(100);
    expect(sessionBody.session.events[0].detail).toEqual({});
    expect(sessionBody.session.guideMessages).toHaveLength(100);
    expect(sessionBody.session.guideMessages[0].id).toBe("api-window-message-6");
    expect(sessionBody.session.tasks.find(
      (task: { taskId: string }) => task.taskId === "practice_task_1",
    ).scaffoldHistory).toHaveLength(20);
    expect(sessionBody.session.truncation).toMatchObject({
      events: { total: 107, returned: 100, omitted: 7, truncated: true },
      guideMessages: { total: 106, returned: 100, omitted: 6, truncated: true },
      scaffoldHistory: {
        total: 22,
        returned: 20,
        omitted: 2,
        truncated: true,
        limitPerTask: 20,
      },
    });

    const scaffoldResponse = await scaffoldRoute.POST(new Request(
      "http://localhost/api/learning/scaffold",
      {
        method: "POST",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          dataGeneration: 1,
          taskId: "practice_task_1",
          toolId: "stage-checklist",
          mutationId: "bounded-session-scaffold",
        }),
      },
    ));
    const scaffoldBody = await scaffoldResponse.json();
    expect(scaffoldResponse.status).toBe(200);
    expect(scaffoldBody.session.events).toHaveLength(100);
    expect(scaffoldBody.session.guideMessages).toHaveLength(100);
    expect(scaffoldBody.session.tasks.find(
      (task: { taskId: string }) => task.taskId === "practice_task_1",
    ).scaffoldHistory).toHaveLength(20);
    expect(scaffoldBody.session.truncation).toMatchObject({
      events: { total: 109, returned: 100, omitted: 9, truncated: true },
      guideMessages: { total: 106, returned: 100, omitted: 6, truncated: true },
      scaffoldHistory: {
        total: 23,
        returned: 20,
        omitted: 3,
        truncated: true,
        limitPerTask: 20,
      },
    });
  });

  it("returns and refreshes learner-local evidence-aware scaffold fading metadata", async () => {
    const scaffoldRoute = await import("@/app/api/learning/scaffold/route");
    const sessionRoute = await import("@/app/api/learning/session/route");
    const { getAaisLearningStore } = await import("@/lib/server/aais-learning-store");
    const studentId = "route-evidence-aware-fading";
    const csrf = createAaisCsrfToken(studentId);
    const cookie = createAuthedCookie(studentId, "student", csrf);
    await initializeLearnerSession(studentId, cookie, csrf);
    let scaffoldMutationCounter = 0;
    const requestScaffold = () => scaffoldRoute.POST(new Request(
      "http://localhost/api/learning/scaffold",
      {
        method: "POST",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          dataGeneration: 1,
          taskId: "training_task_1",
          toolId: "stage-checklist",
          mutationId: `evidence-aware-scaffold-${++scaffoldMutationCounter}`,
        }),
      },
    ));

    const firstResponse = await requestScaffold();
    const firstBody = await firstResponse.json();
    expect(firstResponse.status).toBe(200);
    expect(firstBody).toMatchObject({
      mode: "tool-list",
      fading: false,
      remainingDirectAssists: 3,
      evidenceSnapshot: {
        schemaVersion: 1,
        completedMilestones: 0,
        rawTextIncluded: false,
      },
    });
    await getAaisLearningStore().recordStageEvidence(
      studentId,
      "training_task_1",
      "launch_import",
      "orientation_acknowledged",
    );

    const fadedResponse = await requestScaffold();
    const fadedBody = await fadedResponse.json();
    expect(fadedResponse.status).toBe(200);
    expect(fadedBody).toMatchObject({
      requestCount: 2,
      mode: "self-check",
      fading: true,
      fadingReason: "evidence_improved",
      remainingDirectAssists: 3,
      evidenceSnapshot: {
        completedMilestones: 1,
        rawTextIncluded: false,
      },
    });
    const refreshedResponse = await sessionRoute.GET(new Request(
      "http://localhost/api/learning/session",
      { headers: { cookie } },
    ));
    const refreshedBody = await refreshedResponse.json();
    const refreshedTask = refreshedBody.session.tasks.find((task: { taskId: string }) =>
      task.taskId === "training_task_1"
    );
    expect(refreshedTask).toMatchObject({
      scaffoldState: { fading: true, remainingDirectAssists: 3 },
      scaffoldHistory: expect.arrayContaining([
        expect.objectContaining({
          fadingReason: "evidence_improved",
          evidenceSnapshot: {
            schemaVersion: 1,
            structuredFieldsCompleted: 0,
            artifactVisibleCharacterBucket: "under_8",
            completedMilestones: 1,
            rawTextIncluded: false,
          },
        }),
      ]),
    });
    const latestScaffoldEvent = fadedBody.session.events.filter((event: { event: string }) =>
      event.event === "scaffold_request"
    ).at(-1);
    expect(latestScaffoldEvent.detail).not.toHaveProperty("evidenceSnapshot");
    expect(latestScaffoldEvent.detail).not.toHaveProperty("fadingReason");
  });

  it("rejects a full guide session before dispatching the graph or consuming quota", async () => {
    const graphMock = vi.fn(async (input: unknown) => {
      void input;
      return createMockGuideGraphResult();
    });
    vi.doMock("@/lib/ai/orchestration/aais-learning-guide-graph", () => ({
      runAaisLearningGuideGraph: graphMock,
    }));
    const sessionRoute = await import("@/app/api/learning/session/route");
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    const studentId = "full-guide-capacity";
    const csrf = createAaisCsrfToken(studentId);
    const cookie = createAuthedCookie(studentId, "student", csrf);
    await initializeLearnerSession(studentId, cookie, csrf);
    const sessionPath = path.join(tempDir, "sessions", `${studentId}.json`);
    const persisted = JSON.parse(await readFile(sessionPath, "utf8"));
    persisted.guideMessages = Array.from({ length: 499 }, (_value, index) => ({
      id: `full-guide-message-${index}`,
      kind: "user",
      text: "bounded",
      time: "2026-08-20T00:00:00.000Z",
    }));
    await writeFile(sessionPath, `${JSON.stringify(persisted)}\n`, "utf8");

    const response = await guideRoute.POST(new Request(
      "http://localhost/api/learning/ai-guide",
      {
        method: "POST",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          dataGeneration: 1,
          taskId: "training_task_1",
          learnerInput: "容量已满时不能调用 provider",
          workspaceState: { currentStep: "guide" },
        }),
      },
    ));
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "AAIS_SESSION_PERSISTENCE_LIMIT_REACHED" },
    });
    expect(graphMock).not.toHaveBeenCalled();

    const sessionResponse = await sessionRoute.GET(new Request(
      "http://localhost/api/learning/session",
      { headers: { cookie } },
    ));
    const sessionBody = await sessionResponse.json();
    expect(sessionBody.session.guideMessages).toHaveLength(0);
    expect(sessionBody.session.truncation.guideMessages).toMatchObject({
      total: 0,
      returned: 0,
      truncated: false,
    });
    expect(sessionBody.session).not.toHaveProperty("guideCapacityReservations");

    persisted.guideMessages = persisted.guideMessages.slice(0, 497);
    await writeFile(sessionPath, `${JSON.stringify(persisted)}\n`, "utf8");
    const retryResponse = await guideRoute.POST(new Request(
      "http://localhost/api/learning/ai-guide",
      {
        method: "POST",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          dataGeneration: 1,
          taskId: "training_task_1",
          learnerInput: "释放预留额度后这次可以调用 provider",
          workspaceState: { currentStep: "guide" },
        }),
      },
    ));
    expect(retryResponse.status).toBe(200);
    expect(graphMock).toHaveBeenCalledTimes(1);
    vi.doUnmock("@/lib/ai/orchestration/aais-learning-guide-graph");
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

  it("keeps an authenticated GET read-only when the learner has no session", async () => {
    const sessionRoute = await import("@/app/api/learning/session/route");
    const response = await sessionRoute.GET(new Request(
      "http://localhost/api/learning/session",
      { headers: { cookie: createAuthedCookie("read-only-learner") } },
    ));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "AAIS_LEARNER_SESSION_NOT_FOUND" },
    });
    await expect(readFile(
      path.join(tempDir, "sessions", "read-only-learner.json"),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(
      path.join(tempDir, "learner-data-generations", "read-only-learner.json"),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports unexpected learner storage failures as server errors", async () => {
    vi.doMock("@/lib/server/aais-learning-store", async () => {
      const actual = await vi.importActual<typeof import("@/lib/server/aais-learning-store")>(
        "@/lib/server/aais-learning-store",
      );
      return {
        ...actual,
        getAaisLearningStore: () => ({
          readSession: async () => {
            throw new Error("database connection dropped with private detail");
          },
        }),
      };
    });
    vi.resetModules();
    try {
      const sessionRoute = await import("@/app/api/learning/session/route");
      const response = await sessionRoute.GET(new Request(
        "http://localhost/api/learning/session",
        { headers: { cookie: createAuthedCookie("storage-error-learner") } },
      ));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(body).toMatchObject({
        error: {
          code: "AAIS_SESSION_REQUEST_FAILED",
          message: "AAIS session request failed.",
        },
      });
      expect(JSON.stringify(body)).not.toContain("database connection dropped");
    } finally {
      vi.doUnmock("@/lib/server/aais-learning-store");
      vi.resetModules();
    }
  });

  it.each([
    ["null body", null, "AAIS_GUIDE_BODY_INVALID"],
    ["array body", [], "AAIS_GUIDE_BODY_INVALID"],
    ["non-string learner input", { learnerInput: 17 }, "AAIS_GUIDE_FIELD_INVALID"],
    ["unrecognizable learner input", { learnerInput: "%%%%%%" }, "AAIS_GUIDE_INPUT_UNRECOGNIZABLE"],
    [
      "non-object workspace",
      { learnerInput: "valid", workspaceState: [] },
      "AAIS_GUIDE_FIELD_INVALID",
    ],
    [
      "fractional help count",
      { learnerInput: "valid", workspaceState: { helpRequestsUsed: 1.5 } },
      "AAIS_GUIDE_FIELD_INVALID",
    ],
    [
      "help count above the scaffold contract",
      { learnerInput: "valid", workspaceState: { helpRequestsUsed: 5 } },
      "AAIS_GUIDE_FIELD_INVALID",
    ],
    [
      "unknown target",
      { learnerInput: "valid", targetAgentIds: ["A3"] },
      "AAIS_GUIDE_FIELD_INVALID",
    ],
    [
      "too many targets",
      { learnerInput: "valid", targetAgentIds: ["A1", "A2"] },
      "AAIS_GUIDE_FIELD_INVALID",
    ],
  ])("rejects %s as a structured guide validation error before storage", async (_label, requestBody, code) => {
    stubProductionWithoutDatabase();
    const authenticatedActor = createProductionOidcCookie("input-validation-learner", "student");
    vi.resetModules();
    const guideRoute = await import("@/app/api/learning/ai-guide/route");

    const response = await guideRoute.POST(
      new Request("http://localhost/api/learning/ai-guide", {
        method: "POST",
        headers: {
          cookie: authenticatedActor.cookie,
          "x-aais-csrf": authenticatedActor.csrfToken,
        },
        body: JSON.stringify(
          requestBody && typeof requestBody === "object" && !Array.isArray(requestBody)
            ? { ...requestBody, dataGeneration: 1 }
            : requestBody,
        ),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatchObject({ code });
    expect(body.error.code).not.toBe("AAIS_STORAGE_NOT_CONFIGURED");
  });

  it.each([
    ["learner input", { learnerInput: "x".repeat(20_001) }],
    [
      "workspace artifact",
      {
        learnerInput: "valid",
        workspaceState: { artifactText: "x".repeat(2 * 1024 * 1024 + 1) },
      },
    ],
  ])("rejects oversized %s before storage or provider work", async (_label, requestBody) => {
    stubProductionWithoutDatabase();
    const authenticatedActor = createProductionOidcCookie("oversized-guide-learner", "student");
    vi.resetModules();
    const guideRoute = await import("@/app/api/learning/ai-guide/route");

    const response = await guideRoute.POST(
      new Request("http://localhost/api/learning/ai-guide", {
        method: "POST",
        headers: {
          cookie: authenticatedActor.cookie,
          "x-aais-csrf": authenticatedActor.csrfToken,
        },
        body: JSON.stringify({ ...requestBody, dataGeneration: 1 }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body.error).toEqual({
      code: "AAIS_GUIDE_INPUT_TOO_LARGE",
      message: "AAIS guide request input is too large.",
    });
  });

  it("does not echo raw task ids in learner session or scaffold errors", async () => {
    const sessionRoute = await import("@/app/api/learning/session/route");
    const scaffoldRoute = await import("@/app/api/learning/scaffold/route");
    const cookie = createAuthedCookie("S001");
    const csrf = createAaisCsrfToken("S001");
    await initializeLearnerSession("S001", cookie, csrf);

    const lockedTaskResponse = await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie,
          "x-aais-csrf": csrf,
        },
        body: JSON.stringify({
          dataGeneration: 1,
          action: "select-task",
          taskId: "practice_task_2",
          mutationId: "select-pilot-closed-task",
        }),
      }),
    );
    const lockedTaskBody = await lockedTaskResponse.json();

    expect(lockedTaskResponse.status).toBe(409);
    expect(lockedTaskBody.error).toEqual({
      code: "AAIS_TASK_PILOT_CLOSED",
      message: "AAIS task is closed for the current pilot.",
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
          dataGeneration: 1,
          taskId: "private-task-id",
          toolId: "stage-checklist",
          mutationId: "unknown-scaffold-task",
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

  it("rejects invalid fresh mutations before creating a session or generation", async () => {
    const sessionRoute = await import("@/app/api/learning/session/route");
    const scaffoldRoute = await import("@/app/api/learning/scaffold/route");
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    const { getAaisLearningStore } = await import("@/lib/server/aais-learning-store");
    const actorId = "failed-mutation-bootstrap-audit";
    const cookie = createAuthedCookie(actorId);
    const csrf = createAaisCsrfToken(actorId);

    const invalidStage = await sessionRoute.PATCH(new Request(
      "http://localhost/api/learning/session",
      {
        method: "PATCH",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          action: "select-stage",
          stageId: "totally-valid-looking-typo",
          dataGeneration: 1,
        }),
      },
    ));
    const invalidTool = await scaffoldRoute.POST(new Request(
      "http://localhost/api/learning/scaffold",
      {
        method: "POST",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          taskId: "practice_task_1",
          toolId: "definitely-not-a-tool",
          dataGeneration: 1,
        }),
      },
    ));
    const missingGuideSession = await guideRoute.POST(new Request(
      "http://localhost/api/learning/ai-guide",
      {
        method: "POST",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          learnerInput: "This request must not bootstrap learner state.",
          taskId: "training_task_1",
          dataGeneration: 1,
        }),
      },
    ));

    expect(invalidStage.status).toBe(400);
    await expect(invalidStage.json()).resolves.toMatchObject({
      error: { code: "AAIS_STAGE_INVALID" },
    });
    expect(invalidTool.status).toBe(400);
    await expect(invalidTool.json()).resolves.toMatchObject({
      error: { code: "AAIS_SCAFFOLD_TOOL_INVALID" },
    });
    expect(missingGuideSession.status).toBe(404);
    await expect(missingGuideSession.json()).resolves.toMatchObject({
      error: { code: "AAIS_LEARNER_SESSION_NOT_FOUND" },
    });
    await expect(getAaisLearningStore().readSession(actorId)).resolves.toBeNull();
    await expect(readFile(
      path.join(tempDir, "learner-data-generations", `${actorId}.json`),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects malformed session task ids before reading or mutating an existing session", async () => {
    const actorId = "session-task-id-boundary";
    const csrf = createAaisCsrfToken(actorId);
    const cookie = createAuthedCookie(actorId, "student", csrf);
    await initializeLearnerSession(actorId, cookie, csrf);
    const sessionPath = path.join(tempDir, "sessions", `${actorId}.json`);
    const before = await readFile(sessionPath, "utf8");
    const { getAaisLearningStore } = await import("@/lib/server/aais-learning-store");
    const store = getAaisLearningStore();
    const readSession = vi.spyOn(store, "readSession");
    const selectTask = vi.spyOn(store, "selectTask");
    const sessionRoute = await import("@/app/api/learning/session/route");

    const missingResponse = await sessionRoute.PATCH(new Request(
      "http://localhost/api/learning/session",
      {
        method: "PATCH",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          action: "select-task",
          dataGeneration: 1,
        }),
      },
    ));
    expect(missingResponse.status).toBe(400);
    await expect(missingResponse.json()).resolves.toMatchObject({
      error: { code: "AAIS_SESSION_REQUIRED_FIELD" },
    });

    for (const action of [
      "select-task",
      "complete-task",
      "save-artifact",
      "archive-artifact",
      "save-self-report",
      "record-ai-acceptance",
    ]) {
      const response = await sessionRoute.PATCH(new Request(
        "http://localhost/api/learning/session",
        {
          method: "PATCH",
          headers: { cookie, "x-aais-csrf": csrf },
          body: JSON.stringify({
            action,
            taskId: "../../bad",
            dataGeneration: 1,
          }),
        },
      ));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "AAIS_SESSION_FIELD_INVALID",
          message: "AAIS session field taskId is invalid.",
        },
      });
    }
    expect(readSession).not.toHaveBeenCalled();
    expect(selectTask).not.toHaveBeenCalled();
    await expect(readFile(sessionPath, "utf8")).resolves.toBe(before);
  });

  it("rejects malformed scaffold task and tool ids before reading or mutating the session", async () => {
    const actorId = "scaffold-id-boundary";
    const csrf = createAaisCsrfToken(actorId);
    const cookie = createAuthedCookie(actorId, "student", csrf);
    await initializeLearnerSession(actorId, cookie, csrf);
    const sessionPath = path.join(tempDir, "sessions", `${actorId}.json`);
    const before = await readFile(sessionPath, "utf8");
    const { getAaisLearningStore } = await import("@/lib/server/aais-learning-store");
    const store = getAaisLearningStore();
    const readSession = vi.spyOn(store, "readSession");
    const requestScaffold = vi.spyOn(store, "requestScaffold");
    const scaffoldRoute = await import("@/app/api/learning/scaffold/route");

    const missingResponse = await scaffoldRoute.POST(new Request(
      "http://localhost/api/learning/scaffold",
      {
        method: "POST",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({ dataGeneration: 1 }),
      },
    ));
    expect(missingResponse.status).toBe(400);
    await expect(missingResponse.json()).resolves.toMatchObject({
      error: {
        code: "AAIS_SCAFFOLD_REQUIRED_FIELD",
        message: "taskId is required.",
      },
    });

    for (const input of [
      { taskId: "../../bad", toolId: "stage-checklist" },
      { taskId: "practice_task_1", toolId: "../../bad" },
    ]) {
      const response = await scaffoldRoute.POST(new Request(
        "http://localhost/api/learning/scaffold",
        {
          method: "POST",
          headers: { cookie, "x-aais-csrf": csrf },
          body: JSON.stringify({
            ...input,
            dataGeneration: 1,
          }),
        },
      ));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "AAIS_SCAFFOLD_FIELD_INVALID" },
      });
    }
    expect(readSession).not.toHaveBeenCalled();
    expect(requestScaffold).not.toHaveBeenCalled();
    await expect(readFile(sessionPath, "utf8")).resolves.toBe(before);
  });

  it("maps learner mutation validation and replay conflicts to stable 4xx responses", async () => {
    const sessionRoute = await import("@/app/api/learning/session/route");
    const actorId = "session-input-contract-audit";
    const cookie = createAuthedCookie(actorId);
    const csrf = createAaisCsrfToken(actorId);
    await initializeLearnerSession(actorId, cookie, csrf);

    const oversized = await sessionRoute.PATCH(new Request(
      "http://localhost/api/learning/session",
      {
        method: "PATCH",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          action: "save-artifact",
          taskId: "training_task_1",
          artifactText: "x".repeat(2 * 1024 * 1024 + 1),
          dataGeneration: 1,
        }),
      },
    ));
    const invalidArchive = await sessionRoute.PATCH(new Request(
      "http://localhost/api/learning/session",
      {
        method: "PATCH",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          action: "archive-artifact",
          taskId: "training_task_1",
          document: {
            id: "invalid-date-document",
            taskId: "training_task_1",
            title: "Invalid date",
            html: "content",
            savedAt: "not-a-date",
          },
          dataGeneration: 1,
        }),
      },
    ));
    const mutationId = "route-replay-conflict-11111111-1111-4111-8111-111111111111";
    const firstSave = await sessionRoute.PATCH(new Request(
      "http://localhost/api/learning/session",
      {
        method: "PATCH",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          action: "save-artifact",
          taskId: "training_task_1",
          artifactText: "first durable value",
          expectedArtifactRevision: 0,
          mutationId,
          dataGeneration: 1,
        }),
      },
    ));
    const identicalReplay = await sessionRoute.PATCH(new Request(
      "http://localhost/api/learning/session",
      {
        method: "PATCH",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          action: "save-artifact",
          taskId: "training_task_1",
          artifactText: "first durable value",
          expectedArtifactRevision: 0,
          mutationId,
          dataGeneration: 1,
        }),
      },
    ));
    const replayConflict = await sessionRoute.PATCH(new Request(
      "http://localhost/api/learning/session",
      {
        method: "PATCH",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          action: "save-artifact",
          taskId: "training_task_1",
          artifactText: "different value",
          expectedArtifactRevision: 0,
          mutationId,
          dataGeneration: 1,
        }),
      },
    ));
    const missingHistory = await sessionRoute.PATCH(new Request(
      "http://localhost/api/learning/session",
      {
        method: "PATCH",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          action: "save-artifact",
          taskId: "training_task_1",
          artifactText: "must not replace the working copy",
          expectedArtifactRevision: 1,
          activeDocumentId: "missing-history-document",
          mutationId: "route-artifact-missing-history",
          dataGeneration: 1,
        }),
      },
    ));
    const staleSave = await sessionRoute.PATCH(new Request(
      "http://localhost/api/learning/session",
      {
        method: "PATCH",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          action: "save-artifact",
          taskId: "training_task_1",
          artifactText: "late stale request",
          expectedArtifactRevision: 0,
          mutationId: "route-stale-artifact-revision",
          dataGeneration: 1,
        }),
      },
    ));
    const missingRevision = await sessionRoute.PATCH(new Request(
      "http://localhost/api/learning/session",
      {
        method: "PATCH",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          action: "save-artifact",
          taskId: "training_task_1",
          artifactText: "missing revision",
          mutationId: "route-missing-artifact-revision",
          dataGeneration: 1,
        }),
      },
    ));
    const invalidRevision = await sessionRoute.PATCH(new Request(
      "http://localhost/api/learning/session",
      {
        method: "PATCH",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          action: "save-artifact",
          taskId: "training_task_1",
          artifactText: "invalid revision",
          expectedArtifactRevision: -1,
          mutationId: "route-invalid-artifact-revision",
          dataGeneration: 1,
        }),
      },
    ));
    const firstSelfReport = await sessionRoute.PATCH(new Request(
      "http://localhost/api/learning/session",
      {
        method: "PATCH",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          action: "save-self-report",
          taskId: "training_task_1",
          selfReport: "newer self report",
          expectedSelfReportRevision: 0,
          mutationId: "route-self-report-winner",
          dataGeneration: 1,
        }),
      },
    ));
    const staleSelfReport = await sessionRoute.PATCH(new Request(
      "http://localhost/api/learning/session",
      {
        method: "PATCH",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          action: "save-self-report",
          taskId: "training_task_1",
          selfReport: "stale self report",
          expectedSelfReportRevision: 0,
          mutationId: "route-self-report-stale",
          dataGeneration: 1,
        }),
      },
    ));

    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: "AAIS_SESSION_FIELD_TOO_LARGE" },
    });
    expect(invalidArchive.status).toBe(400);
    await expect(invalidArchive.json()).resolves.toMatchObject({
      error: { code: "AAIS_SESSION_FIELD_INVALID" },
    });
    expect(firstSave.status).toBe(200);
    expect(identicalReplay.status).toBe(200);
    const identicalReplayBody = await identicalReplay.json();
    expect(identicalReplayBody.session.tasks[0]).toMatchObject({
      artifactText: "first durable value",
      artifactRevision: 1,
    });
    expect(replayConflict.status).toBe(409);
    await expect(replayConflict.json()).resolves.toMatchObject({
      error: { code: "AAIS_MUTATION_ID_CONFLICT" },
    });
    expect(missingHistory.status).toBe(404);
    await expect(missingHistory.json()).resolves.toMatchObject({
      error: { code: "AAIS_HISTORY_DOCUMENT_NOT_FOUND" },
    });
    expect(staleSave.status).toBe(409);
    await expect(staleSave.json()).resolves.toMatchObject({
      error: { code: "AAIS_ARTIFACT_REVISION_CONFLICT" },
    });
    expect(missingRevision.status).toBe(409);
    await expect(missingRevision.json()).resolves.toMatchObject({
      error: { code: "AAIS_SESSION_TEXT_REVISION_REQUIRED" },
    });
    expect(invalidRevision.status).toBe(400);
    await expect(invalidRevision.json()).resolves.toMatchObject({
      error: { code: "AAIS_SESSION_FIELD_INVALID" },
    });
    expect(firstSelfReport.status).toBe(200);
    expect(staleSelfReport.status).toBe(409);
    await expect(staleSelfReport.json()).resolves.toMatchObject({
      error: { code: "AAIS_SELF_REPORT_REVISION_CONFLICT" },
    });
    const current = await sessionRoute.GET(new Request(
      "http://localhost/api/learning/session",
      { headers: { cookie } },
    ));
    const currentBody = await current.json();
    expect(currentBody.session.tasks[0].artifactText).toBe("first durable value");
  });

  it("returns role-only actor evidence for authenticated session reads", async () => {
    const sessionRoute = await import("@/app/api/learning/session/route");
    const cookie = createAuthedCookie("teacher-a", "teacher");
    await sessionRoute.POST(new Request("http://localhost/api/learning/session", {
      method: "POST",
      headers: {
        cookie,
        "x-aais-csrf": createAaisCsrfToken("teacher-a"),
      },
    }));

    const response = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session", {
        headers: {
          cookie,
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
    const authenticatedActor = createProductionOidcCookie("storage-check", "student");
    vi.resetModules();
    const sessionRoute = await import("@/app/api/learning/session/route");

    const response = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session", {
        headers: {
          cookie: authenticatedActor.cookie,
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
    const authenticatedActor = createProductionOidcCookie("provider-storage-check", "student");
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
          cookie: authenticatedActor.cookie,
          "x-aais-csrf": authenticatedActor.csrfToken,
        },
        body: JSON.stringify({
          dataGeneration: 1,
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
    await initializeLearnerSession(
      "Phoebe",
      phoebeCookie,
      createAaisCsrfToken("Phoebe"),
    );

    const response = await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie: phoebeCookie,
          "x-aais-csrf": createAaisCsrfToken("Phoebe"),
        },
        body: JSON.stringify({
          dataGeneration: 1,
          studentId: "S001",
          action: "save-artifact",
          taskId: "training_task_1",
          artifactText: "Phoebe 的过程记录",
          expectedArtifactRevision: 0,
          mutationId: "route-phoebe-artifact-save",
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
          dataGeneration: 1,
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
    await initializeLearnerSession(
      "S001",
      s001Cookie,
      createAaisCsrfToken("S001"),
    );

    const guideResponse = await guideRoute.POST(
      new Request("http://localhost/api/learning/ai-guide", {
        method: "POST",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          dataGeneration: 1,
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
    expect(guideBody.orchestration.graph.topologicalOrder).toEqual(["A1"]);
    expect(guideBody.turns.map((turn: { agentId: string }) => turn.agentId)).toEqual([
      "A1",
    ]);
    expect(guideBody.turns.map((turn: { actions: string[] }) => turn.actions)).toEqual([
      ["guide-flow", "scaffold"],
    ]);
    expect(guideBody.backgroundTurns).toBeUndefined();
    expect(guideBody.orchestration.runtime).toEqual({
      engine: "aais-langgraph-runtime",
      status: "completed",
      timings: {
        visibleMs: expect.any(Number),
        attempts: expect.any(Number),
        fallback: true,
        timeoutReason: null,
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

    expect(guideBody.exchange).toEqual({
      userMessageId: sessionBody.session.guideMessages[0].id,
      assistantMessageId: sessionBody.session.guideMessages[1].id,
    });
    expect(guideBody.exchange.userMessageId).toMatch(/^user-[0-9a-f-]{36}$/);
    expect(guideBody.exchange.assistantMessageId).toMatch(/^assistant-[0-9a-f-]{36}$/);
    expect(sessionBody.session.guideMessages.map((message: { kind: string }) => message.kind)).toEqual([
      "user",
      "assistant",
    ]);
    expect(sessionBody.session.guideMessages).toEqual([
      expect.objectContaining({
        kind: "user",
        taskId: "training_task_1",
        phase: "training",
      }),
      expect.objectContaining({
        kind: "assistant",
        taskId: "training_task_1",
        phase: "training",
      }),
    ]);
    expect(sessionBody.session.guideMessages[1].turns.map((turn: { agentId: string }) => turn.agentId)).toEqual([
      "A1",
    ]);
    expect(sessionBody.session.guideMessages[1]).not.toHaveProperty("orchestration");
    expect(JSON.stringify(guideBody)).not.toMatch(/"A3"|"A4"|监督智能体|反思智能体/);
    expect(JSON.stringify(sessionBody.session.guideMessages)).not.toMatch(/"A3"|"A4"/);
    expect(sessionBody.session.guideMessages[1].text).not.toContain("监督智能体");
    expect(sessionBody.session.guideMessages[1].text).not.toContain("反思智能体");
    expect(sessionBody.session.events.map((event: { event: string }) => event.event)).toEqual(
      expect.arrayContaining(["ai_prompt_submitted", "ai_response_completed"]),
    );
  });

  it("uses the durable per-task A1 help count and does not consume a failed request", async () => {
    const observedHelpCounts: number[] = [];
    let failNext = true;
    const graphMock = vi.fn(async (input: { workspaceState: { helpRequestsUsed?: number } }) => {
      observedHelpCounts.push(input.workspaceState.helpRequestsUsed ?? -1);
      if (failNext) {
        failNext = false;
        throw new Error("provider failed before persistence");
      }
      return createMockGuideGraphResult();
    });
    vi.doMock("@/lib/ai/orchestration/aais-learning-guide-graph", () => ({
      runAaisLearningGuideGraph: graphMock,
    }));
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    const sessionRoute = await import("@/app/api/learning/session/route");
    const studentId = "durable-guide-help-counter";
    const csrf = createAaisCsrfToken(studentId);
    const cookie = createAuthedCookie(studentId, "student", csrf);
    await initializeLearnerSession(studentId, cookie, csrf);

    const sendHelp = () => guideRoute.POST(new Request(
      "http://localhost/api/learning/ai-guide",
      {
        method: "POST",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          dataGeneration: 1,
          taskId: "training_task_1",
          learnerInput: "请给我一个下一步提示",
          workspaceState: {
            currentStep: "guide",
            // The server must not trust a stale or forged client counter.
            helpRequestsUsed: 4,
          },
        }),
      },
    ));

    const failedResponse = await sendHelp();
    expect(failedResponse.status).toBe(500);
    const afterFailure = await sessionRoute.GET(new Request(
      "http://localhost/api/learning/session",
      { headers: { cookie } },
    ));
    const afterFailureBody = await afterFailure.json();
    expect(afterFailureBody.session.tasks[0].scaffoldRequests).toBe(0);

    const confirmedCounts: number[] = [];
    for (let ordinal = 0; ordinal < 5; ordinal += 1) {
      const response = await sendHelp();
      const body = await response.json();
      expect(response.status).toBe(200);
      confirmedCounts.push(body.workspaceState.helpRequestsUsed);
    }

    expect(observedHelpCounts).toEqual([0, 0, 1, 2, 3, 4]);
    expect(confirmedCounts).toEqual([1, 2, 3, 4, 4]);

    const sessionResponse = await sessionRoute.GET(new Request(
      "http://localhost/api/learning/session",
      { headers: { cookie } },
    ));
    const sessionBody = await sessionResponse.json();
    expect(sessionBody.session.tasks[0].scaffoldRequests).toBe(5);
    expect(sessionBody.session.events.filter(
      (event: { event: string }) => event.event === "scaffold_request",
    )).toHaveLength(5);
    expect(sessionBody.session.events.filter(
      (event: { event: string }) => event.event === "scaffold_self_check_started",
    )).toHaveLength(1);
    vi.doUnmock("@/lib/ai/orchestration/aais-learning-guide-graph");
  });

  it("rejects a concurrently stale A1 result before it can consume the next scaffold slot", async () => {
    const firstGraph = createDeferredGuideResult();
    const secondGraph = createDeferredGuideResult();
    const observedHelpCounts: number[] = [];
    const graphMock = vi.fn((input: { workspaceState: { helpRequestsUsed?: number } }) => {
      observedHelpCounts.push(input.workspaceState.helpRequestsUsed ?? -1);
      if (observedHelpCounts.length === 1) {
        return firstGraph.promise;
      }
      if (observedHelpCounts.length === 2) {
        return secondGraph.promise;
      }
      return Promise.resolve(createMockGuideGraphResult());
    });
    vi.doMock("@/lib/ai/orchestration/aais-learning-guide-graph", () => ({
      runAaisLearningGuideGraph: graphMock,
    }));
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    const sessionRoute = await import("@/app/api/learning/session/route");
    const studentId = "concurrent-guide-help-counter";
    const csrf = createAaisCsrfToken(studentId);
    const cookie = createAuthedCookie(studentId, "student", csrf);
    await initializeLearnerSession(studentId, cookie, csrf);

    const sendHelp = (learnerInput: string) => guideRoute.POST(new Request(
      "http://localhost/api/learning/ai-guide",
      {
        method: "POST",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          dataGeneration: 1,
          taskId: "training_task_1",
          learnerInput,
          workspaceState: { currentStep: "guide" },
        }),
      },
    ));

    const firstResponsePromise = sendHelp("first concurrent request");
    await vi.waitFor(() => expect(graphMock).toHaveBeenCalledTimes(1));
    const secondResponsePromise = sendHelp("second concurrent request");
    await vi.waitFor(() => expect(graphMock).toHaveBeenCalledTimes(2));
    expect(observedHelpCounts).toEqual([0, 0]);

    firstGraph.resolve(createMockGuideGraphResult());
    const firstResponse = await firstResponsePromise;
    expect(firstResponse.status).toBe(200);

    secondGraph.resolve(createMockGuideGraphResult());
    const secondResponse = await secondResponsePromise;
    expect(secondResponse.status).toBe(409);
    await expect(secondResponse.json()).resolves.toMatchObject({
      error: { code: "AAIS_SESSION_WRITE_CONFLICT" },
    });

    const afterConflict = await sessionRoute.GET(new Request(
      "http://localhost/api/learning/session",
      { headers: { cookie } },
    ));
    const afterConflictBody = await afterConflict.json();
    expect(afterConflictBody.session.tasks[0].scaffoldRequests).toBe(1);
    expect(afterConflictBody.session.guideMessages).toHaveLength(2);

    const retryResponse = await sendHelp("retry after stale result");
    expect(retryResponse.status).toBe(200);
    expect(observedHelpCounts).toEqual([0, 0, 1]);
    vi.doUnmock("@/lib/ai/orchestration/aais-learning-guide-graph");
  });

  it("canonicalizes a forged A2 target without a Professor mention back to A1", async () => {
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
    const studentId = "forged-a2-target-learner";
    const cookie = createAuthedCookie(studentId);
    const csrf = createAaisCsrfToken(studentId);
    await initializeLearnerSession(studentId, cookie, csrf);

    const guideResponse = await guideRoute.POST(
      new Request("http://localhost/api/learning/ai-guide", {
        method: "POST",
        headers: {
          cookie,
          "x-aais-csrf": csrf,
        },
        body: JSON.stringify({
          dataGeneration: 1,
          phase: "training",
          taskId: "training_task_1",
          learnerInput: "教授，请帮我看看下一步。",
          targetAgentIds: ["A2"],
          workspaceState: {
            currentStep: "guide",
          },
        }),
      }),
    );
    const guideBody = await guideResponse.json();

    expect(guideResponse.status).toBe(200);
    expect(guideBody.turns.map((turn: { agentId: string }) => turn.agentId)).toEqual(["A1"]);
    expect(guideBody.orchestration.graph.topologicalOrder).toEqual(["A1"]);
    expect(guideBody.message.text).toContain("小张");
    expect(guideBody.message.text).not.toContain("教授");
    expect(guideBody.backgroundTurns).toBeUndefined();
    expect(JSON.stringify(guideBody)).not.toMatch(/"A2"|"A3"|"A4"|监督智能体|反思智能体/);

    const sessionResponse = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session", {
        headers: { cookie },
      }),
    );
    const sessionBody = await sessionResponse.json();
    expect(sessionBody.session.guideMessages[1].turns.map(
      (turn: { agentId: string }) => turn.agentId,
    )).toEqual(["A1"]);
    expect(sessionBody.session.guideMessages[1]).not.toHaveProperty("orchestration");
  });

  it("accepts freshly returned canonical A1 and A2 message ids while rejecting them across tasks", async () => {
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
    const { createAaisLearningStore } = await import("@/lib/server/aais-learning-store");
    const studentId = "canonical-acceptance-route-learner";
    const cookie = createAuthedCookie(studentId);
    const csrf = createAaisCsrfToken(studentId);
    await initializeLearnerSession(studentId, cookie, csrf);

    const sendGuide = async (learnerInput: string) => {
      const response = await guideRoute.POST(new Request("http://localhost/api/learning/ai-guide", {
        method: "POST",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          dataGeneration: 1,
          phase: "training",
          taskId: "training_task_1",
          learnerInput,
          workspaceState: { currentStep: "guide" },
        }),
      }));
      expect(response.status).toBe(200);
      return response.json();
    };
    const recordAcceptance = (input: {
      accepted: boolean;
      expectedPilotEvidenceRevision: number;
      messageId: string;
      mutationId: string;
      taskId?: string;
    }) => sessionRoute.PATCH(new Request("http://localhost/api/learning/session", {
      method: "PATCH",
      headers: { cookie, "x-aais-csrf": csrf },
      body: JSON.stringify({
        dataGeneration: 1,
        action: "record-ai-acceptance",
        reason: input.accepted ? "采纳导学建议" : "需要修订专家建议",
        taskId: input.taskId ?? "training_task_1",
        ...input,
      }),
    }));

    const a1Body = await sendGuide("请帮我明确下一步目标。");
    expect(a1Body.turns.map((turn: { agentId: string }) => turn.agentId)).toEqual(["A1"]);
    expect(a1Body.exchange).toMatchObject({
      userMessageId: expect.stringMatching(/^user-/),
      assistantMessageId: expect.stringMatching(/^assistant-/),
    });
    const acceptedA1 = await recordAcceptance({
      accepted: true,
      expectedPilotEvidenceRevision: 0,
      messageId: a1Body.exchange.assistantMessageId,
      mutationId: "accept-returned-a1-message",
    });
    expect(acceptedA1.status).toBe(200);
    const acceptedA1Body = await acceptedA1.json();
    expect(acceptedA1Body.session.tasks.find(
      (task: { taskId: string }) => task.taskId === "training_task_1",
    )).toMatchObject({ pilotEvidenceRevision: 1 });

    const a2Body = await sendGuide("@教授 请检查这个方案是否符合目标。");
    expect(a2Body.turns.map((turn: { agentId: string }) => turn.agentId)).toEqual(["A2"]);
    const rejectedA2 = await recordAcceptance({
      accepted: false,
      expectedPilotEvidenceRevision: 1,
      messageId: a2Body.exchange.assistantMessageId,
      mutationId: "reject-returned-a2-message",
    });
    expect(rejectedA2.status).toBe(200);
    const rejectedA2Body = await rejectedA2.json();
    expect(rejectedA2Body.session.tasks.find(
      (task: { taskId: string }) => task.taskId === "training_task_1",
    )).toMatchObject({
      pilotEvidence: expect.objectContaining({ outputEvaluation: "revision_required" }),
      pilotEvidenceRevision: 2,
    });

    const seedStore = createAaisLearningStore({ rootDir: tempDir });
    await seedStore.recordStageEvidence(
      studentId,
      "training_task_1",
      "launch_import",
      "orientation_acknowledged",
    );
    await seedStore.recordStageEvidence(
      studentId,
      "training_task_1",
      "modeling",
      "expert_model_reviewed",
    );
    await seedStore.completeTask(studentId, "training_task_1");
    await seedStore.selectTask(studentId, "practice_task_1");
    const crossTask = await recordAcceptance({
      accepted: true,
      expectedPilotEvidenceRevision: 0,
      messageId: a2Body.exchange.assistantMessageId,
      mutationId: "reject-cross-task-returned-a2-message",
      taskId: "practice_task_1",
    });
    expect(crossTask.status).toBe(400);
    await expect(crossTask.json()).resolves.toMatchObject({
      error: { code: "AAIS_AI_ACCEPTANCE_TARGET_INVALID" },
    });
  });

  it("rejects fabricated, user, missing, and cross-task AI acceptance message ids", async () => {
    const { createAaisLearningStore } = await import("@/lib/server/aais-learning-store");
    const seedStore = createAaisLearningStore({ rootDir: tempDir });
    const trainingExchange = await seedStore.appendGuideExchange({
      studentId: "acceptance-route-learner",
      phase: "practice",
      taskId: "training_task_1",
      question: "training question",
      answer: "training answer",
      orchestration: { graphId: "g", topologicalOrder: ["A2"], threadId: "training" },
    });
    const trainingAssistantId = trainingExchange.exchange.assistantMessageId;
    await seedStore.recordStageEvidence(
      "acceptance-route-learner",
      "training_task_1",
      "launch_import",
      "orientation_acknowledged",
    );
    await seedStore.recordStageEvidence(
      "acceptance-route-learner",
      "training_task_1",
      "modeling",
      "expert_model_reviewed",
    );
    await seedStore.completeTask("acceptance-route-learner", "training_task_1");
    await seedStore.selectTask("acceptance-route-learner", "practice_task_1");
    const practiceExchange = await seedStore.appendGuideExchange({
      studentId: "acceptance-route-learner",
      phase: "training",
      taskId: "practice_task_1",
      question: "practice question",
      answer: "practice answer",
      orchestration: { graphId: "g", topologicalOrder: ["A2"], threadId: "practice" },
    });
    const practiceUserId = practiceExchange.exchange.userMessageId;
    const practiceAssistantId = practiceExchange.exchange.assistantMessageId;
    expect(trainingAssistantId).toBeTruthy();
    expect(practiceUserId).toBeTruthy();
    expect(practiceAssistantId).toBeTruthy();

    const sessionRoute = await import("@/app/api/learning/session/route");
    const cookie = createAuthedCookie("acceptance-route-learner");
    const csrf = createAaisCsrfToken("acceptance-route-learner");
    for (const messageId of [undefined, "assistant-fabricated", practiceUserId, trainingAssistantId]) {
      const response = await sessionRoute.PATCH(
        new Request("http://localhost/api/learning/session", {
          method: "PATCH",
          headers: { cookie, "x-aais-csrf": csrf },
          body: JSON.stringify({
            dataGeneration: 1,
            action: "record-ai-acceptance",
            taskId: "practice_task_1",
            accepted: true,
            expectedPilotEvidenceRevision: 0,
            mutationId: `invalid-ai-target-${String(messageId)}`,
            ...(messageId ? { messageId } : {}),
          }),
        }),
      );
      const body = await response.json();
      expect(response.status).toBe(400);
      expect(body.error).toEqual({
        code: "AAIS_AI_ACCEPTANCE_TARGET_INVALID",
        message: "AAIS AI acceptance requires an assistant message from the same task.",
      });
    }

    const afterRejected = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session", { headers: { cookie } }),
    );
    const afterRejectedBody = await afterRejected.json();
    expect(afterRejectedBody.session.events.filter(
      (event: { event: string }) => event.event === "ai_acceptance_recorded",
    )).toEqual([]);

    for (const { body: missingFenceBody, expectedCode, expectedStatus } of [
      {
        body: { expectedPilotEvidenceRevision: 0 },
        expectedCode: "AAIS_SESSION_FIELD_INVALID",
        expectedStatus: 400,
      },
      {
        body: { mutationId: "missing-expected-ai-acceptance" },
        expectedCode: "AAIS_SESSION_TEXT_REVISION_REQUIRED",
        expectedStatus: 409,
      },
    ]) {
      const missingFenceResponse = await sessionRoute.PATCH(
        new Request("http://localhost/api/learning/session", {
          method: "PATCH",
          headers: { cookie, "x-aais-csrf": csrf },
          body: JSON.stringify({
            dataGeneration: 1,
            action: "record-ai-acceptance",
            taskId: "practice_task_1",
            accepted: true,
            messageId: practiceAssistantId,
            ...missingFenceBody,
          }),
        }),
      );
      expect(missingFenceResponse.status).toBe(expectedStatus);
      await expect(missingFenceResponse.json()).resolves.toMatchObject({
        error: { code: expectedCode },
      });
    }

    const validRequestBody = {
      dataGeneration: 1,
      action: "record-ai-acceptance",
      taskId: "practice_task_1",
      accepted: true,
      expectedPilotEvidenceRevision: 0,
      messageId: practiceAssistantId,
      mutationId: "valid-ai-acceptance-route",
    };
    const sendAcceptance = (body: Record<string, unknown>) => sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify(body),
      }),
    );
    const validResponse = await sendAcceptance(validRequestBody);
    const validBody = await validResponse.json();
    expect(validResponse.status).toBe(200);
    expect(validBody.session.tasks.find(
      (task: { taskId: string }) => task.taskId === "practice_task_1",
    )?.pilotEvidenceRevision).toBe(1);
    expect(validBody.session.events.filter(
      (event: { event: string }) => event.event === "ai_acceptance_recorded",
    )).toHaveLength(1);

    const replayResponse = await sendAcceptance(validRequestBody);
    const replayBody = await replayResponse.json();
    expect(replayResponse.status).toBe(200);
    expect(replayBody.session.tasks.find(
      (task: { taskId: string }) => task.taskId === "practice_task_1",
    )?.pilotEvidenceRevision).toBe(1);
    expect(replayBody.session.events.filter(
      (event: { event: string }) => event.event === "ai_acceptance_recorded",
    )).toHaveLength(1);

    const changedReplayResponse = await sendAcceptance({
      ...validRequestBody,
      accepted: false,
      expectedPilotEvidenceRevision: 1,
    });
    expect(changedReplayResponse.status).toBe(409);
    await expect(changedReplayResponse.json()).resolves.toMatchObject({
      error: { code: "AAIS_MUTATION_ID_CONFLICT" },
    });

    const lateStaleResponse = await sendAcceptance({
      ...validRequestBody,
      accepted: false,
      mutationId: "late-stale-ai-acceptance-route",
    });
    expect(lateStaleResponse.status).toBe(409);
    await expect(lateStaleResponse.json()).resolves.toMatchObject({
      error: { code: "AAIS_PILOT_EVIDENCE_REVISION_CONFLICT" },
    });
    const currentResponse = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session", { headers: { cookie } }),
    );
    const currentBody = await currentResponse.json();
    const currentTask = currentBody.session.tasks.find(
      (task: { taskId: string }) => task.taskId === "practice_task_1",
    );
    expect(currentTask).toMatchObject({
      pilotEvidence: { outputEvaluation: "accepted" },
      pilotEvidenceRevision: 1,
    });
  });

  it("carries persisted learner context and explicit English preference into later guide turns", async () => {
    vi.stubEnv("AAIS_AI_PROVIDER", "");
    vi.stubEnv("AAIS_AI_ENDPOINT", "");
    vi.stubEnv("AAIS_AI_API_KEY", "");
    vi.stubEnv("AAIS_AI_MODEL", "");
    vi.stubEnv("AAIS_AI_FALLBACK_ENDPOINT", "");
    vi.stubEnv("AAIS_AI_FALLBACK_API_KEY", "");
    vi.stubEnv("AAIS_AI_FALLBACK_MODEL", "");
    vi.resetModules();
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    await initializeLearnerSession("context-learner");
    await initializeLearnerSession("english-learner");

    const sendGuideTurn = async (studentId: string, learnerInput: string) => {
      const response = await guideRoute.POST(
        new Request("http://localhost/api/learning/ai-guide", {
          method: "POST",
          headers: {
            cookie: createAuthedCookie(studentId),
            "x-aais-csrf": createAaisCsrfToken(studentId),
          },
          body: JSON.stringify({
          dataGeneration: 1,
            locale: "zh-CN",
            phase: "training",
            taskId: "training_task_1",
            learnerInput,
            targetAgentIds: ["A1"],
            workspaceState: {
              currentStep: "guide",
            },
          }),
        }),
      );
      const body = await response.json();
      expect(response.status).toBe(200);
      return body;
    };

    await sendGuideTurn("context-learner", "@A1 我的卡点是高性能虚拟滚动列表。");
    const recalledContext = await sendGuideTurn("context-learner", "@A1 我刚才说的卡点是什么？");
    expect(recalledContext.turns[0].content).toContain("高性能虚拟滚动列表");

    await sendGuideTurn("english-learner", "@A1 I mean answer all questions in English.");
    const continuedEnglish = await sendGuideTurn("english-learner", "@A1 I do not have the target yet.");
    expect(continuedEnglish.turns[0].content).toContain("direct assists remain");
    expect(continuedEnglish.turns[0].content).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it("passes only current-task, task-bound guide history to the provider", async () => {
    const { createAaisLearningStore } = await import("@/lib/server/aais-learning-store");
    const seedStore = createAaisLearningStore({ rootDir: tempDir });
    await seedStore.appendGuideExchange({
      studentId: "task-history-learner",
      phase: "practice",
      taskId: "training_task_1",
      question: "training-only question",
      answer: "training-only answer",
      orchestration: { graphId: "g", topologicalOrder: ["A1"], threadId: "training" },
    });
    await seedStore.recordStageEvidence(
      "task-history-learner",
      "training_task_1",
      "launch_import",
      "orientation_acknowledged",
    );
    await seedStore.recordStageEvidence(
      "task-history-learner",
      "training_task_1",
      "modeling",
      "expert_model_reviewed",
    );
    await seedStore.completeTask("task-history-learner", "training_task_1");
    await seedStore.selectTask("task-history-learner", "practice_task_1");
    await seedStore.appendGuideExchange({
      studentId: "task-history-learner",
      phase: "training",
      taskId: "practice_task_1",
      question: "practice question",
      answer: "practice answer",
      orchestration: { graphId: "g", topologicalOrder: ["A1"], threadId: "practice" },
    });

    const sessionPath = path.join(tempDir, "sessions", "task-history-learner.json");
    const rawSession = JSON.parse(await readFile(sessionPath, "utf8"));
    rawSession.guideMessages.push({
      id: "legacy-assistant-without-task",
      kind: "assistant",
      text: "legacy unbound answer",
      time: "2026-08-19T00:00:00.000Z",
    });
    await writeFile(sessionPath, `${JSON.stringify(rawSession, null, 2)}\n`, "utf8");

    const graphMock = vi.fn(async (input: unknown) => {
      void input;
      return createMockGuideGraphResult();
    });
    vi.doMock("@/lib/ai/orchestration/aais-learning-guide-graph", () => ({
      runAaisLearningGuideGraph: graphMock,
    }));
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    const response = await guideRoute.POST(
      new Request("http://localhost/api/learning/ai-guide", {
        method: "POST",
        headers: {
          cookie: createAuthedCookie("task-history-learner"),
          "x-aais-csrf": createAaisCsrfToken("task-history-learner"),
        },
        body: JSON.stringify({
          dataGeneration: 1,
          phase: "training",
          taskId: "practice_task_1",
          learnerInput: "current request",
          workspaceState: { currentStep: "guide" },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(graphMock).toHaveBeenCalledTimes(1);
    expect(graphMock.mock.calls[0]?.[0]).toMatchObject({
      phase: "practice",
      taskId: "practice_task_1",
      conversationHistory: [
        { kind: "user", text: "practice question" },
        { kind: "assistant", text: "practice answer" },
      ],
    });
    expect(JSON.stringify(graphMock.mock.calls[0]?.[0])).not.toContain("training-only");
    expect(JSON.stringify(graphMock.mock.calls[0]?.[0])).not.toContain("legacy unbound");
  });

  it("passes an actionable A3 signal until one guide reply succeeds, then stops reusing it", async () => {
    const { createAaisLearningStore } = await import("@/lib/server/aais-learning-store");
    const studentId = "a3-one-shot-route-learner";
    const cookie = createAuthedCookie(studentId);
    const csrf = createAaisCsrfToken(studentId);
    await initializeLearnerSession(studentId, cookie, csrf);
    const seedStore = createAaisLearningStore({ rootDir: tempDir });
    const signaled = await seedStore.saveArtifact(
      studentId,
      "training_task_1",
      "目前只有初稿内容",
    );
    const signalIds = signaled.tasks[0]?.supervisionSignals.map((signal) => signal.id) ?? [];
    expect(signalIds.length).toBeGreaterThan(0);

    const graphMock = vi.fn()
      .mockRejectedValueOnce(new Error("provider failed before persistence"))
      .mockResolvedValue(createMockGuideGraphResult());
    vi.doMock("@/lib/ai/orchestration/aais-learning-guide-graph", () => ({
      runAaisLearningGuideGraph: graphMock,
    }));
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    const send = (learnerInput: string) => guideRoute.POST(new Request(
      "http://localhost/api/learning/ai-guide",
      {
        method: "POST",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          dataGeneration: 1,
          taskId: "training_task_1",
          learnerInput,
          workspaceState: { currentStep: "modeling" },
        }),
      },
    ));

    const failed = await send("我准备继续完善这份草稿。第一个请求会失败。");
    expect(failed.status).toBe(500);
    const succeeded = await send("我准备继续完善这份草稿。现在再试一次。");
    expect(succeeded.status).toBe(200);
    const afterConsumption = await send("我已经收到本轮回应，继续普通讨论。");
    expect(afterConsumption.status).toBe(200);

    const graphInputs = graphMock.mock.calls.map(([input]) => input as {
      workspaceState: { supervisionSignals: Array<{ id: string }> };
    });
    expect(graphInputs[0]?.workspaceState.supervisionSignals.map((signal) => signal.id))
      .toEqual(signalIds);
    expect(graphInputs[1]?.workspaceState.supervisionSignals.map((signal) => signal.id))
      .toEqual(signalIds);
    expect(graphInputs[2]?.workspaceState.supervisionSignals).toEqual([]);

    const persisted = await seedStore.readSession(studentId);
    expect(persisted?.tasks[0]?.supervisionSignals.map((signal) => signal.id)).toEqual(signalIds);
    vi.doUnmock("@/lib/ai/orchestration/aais-learning-guide-graph");
  });

  it("passes revision-required policy for one successful reply without clearing its audit history", async () => {
    const { createAaisLearningStore } = await import("@/lib/server/aais-learning-store");
    const studentId = "revision-one-shot-route-learner";
    const cookie = createAuthedCookie(studentId);
    const csrf = createAaisCsrfToken(studentId);
    await initializeLearnerSession(studentId, cookie, csrf);
    const seedStore = createAaisLearningStore({ rootDir: tempDir });
    const original = await seedStore.appendGuideExchange({
      studentId,
      phase: "training",
      taskId: "training_task_1",
      question: "请评价目前这份输出。",
      answer: "这是一份待学习者评价的输出。",
      orchestration: { graphId: "g", topologicalOrder: ["A1"], threadId: "revision" },
    });
    await seedStore.recordAiAcceptance(studentId, "training_task_1", {
      accepted: false,
      messageId: original.exchange.assistantMessageId,
      reason: "与课程目标不一致，需要修改。",
      expectedPilotEvidenceRevision: 0,
      mutationId: "revision-one-shot-decision",
    });

    const graphMock = vi.fn(async (input: unknown) => {
      void input;
      return createMockGuideGraphResult();
    });
    vi.doMock("@/lib/ai/orchestration/aais-learning-guide-graph", () => ({
      runAaisLearningGuideGraph: graphMock,
    }));
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    const send = (learnerInput: string) => guideRoute.POST(new Request(
      "http://localhost/api/learning/ai-guide",
      {
        method: "POST",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          dataGeneration: 1,
          taskId: "training_task_1",
          learnerInput,
          workspaceState: { currentStep: "modeling" },
        }),
      },
    ));

    expect((await send("我会指出不一致并修改这一版。")).status).toBe(200);
    expect((await send("修改后继续讨论下一步安排。")).status).toBe(200);
    const graphInputs = graphMock.mock.calls.map(([input]) => input as {
      workspaceState: { outputEvaluation: string };
    });
    expect(graphInputs.map((input) => input.workspaceState.outputEvaluation)).toEqual([
      "revision_required",
      "pending",
    ]);

    const persisted = await seedStore.readSession(studentId);
    expect(persisted?.tasks[0]?.pilotEvidence.outputEvaluation).toBe("revision_required");
    expect(persisted?.events.filter((event) => event.event === "ai_acceptance_recorded"))
      .toHaveLength(1);
    vi.doUnmock("@/lib/ai/orchestration/aais-learning-guide-graph");
  });

  it("bounds model conversation history by message count and total characters", async () => {
    const { createAaisLearningStore } = await import("@/lib/server/aais-learning-store");
    const studentId = "bounded-guide-history-learner";
    const seedStore = createAaisLearningStore({ rootDir: tempDir });
    await seedStore.getOrCreateSession(studentId);
    for (let index = 0; index < 20; index += 1) {
      await seedStore.appendGuideExchange({
        studentId,
        phase: "training",
        taskId: "training_task_1",
        question: `question-${index}-${"q".repeat(1_500)}`,
        answer: `answer-${index}-${"a".repeat(1_500)}`,
        orchestration: { graphId: "g", topologicalOrder: ["A1"], threadId: `t-${index}` },
      });
    }
    const graphMock = vi.fn(async (input: unknown) => {
      void input;
      return createMockGuideGraphResult();
    });
    vi.doMock("@/lib/ai/orchestration/aais-learning-guide-graph", () => ({
      runAaisLearningGuideGraph: graphMock,
    }));
    const guideRoute = await import("@/app/api/learning/ai-guide/route");

    const response = await guideRoute.POST(new Request(
      "http://localhost/api/learning/ai-guide",
      {
        method: "POST",
        headers: {
          cookie: createAuthedCookie(studentId),
          "x-aais-csrf": createAaisCsrfToken(studentId),
        },
        body: JSON.stringify({
          dataGeneration: 1,
          taskId: "training_task_1",
          learnerInput: "current bounded request",
        }),
      },
    ));

    expect(response.status).toBe(200);
    const input = graphMock.mock.calls[0]?.[0] as {
      conversationHistory: Array<{ kind: string; text: string }>;
    };
    expect(input.conversationHistory.length).toBeLessThanOrEqual(12);
    expect(input.conversationHistory.reduce((sum, message) => sum + message.text.length, 0))
      .toBeLessThanOrEqual(16_000);
    expect(JSON.stringify(input.conversationHistory)).toContain("answer-19-");
    expect(JSON.stringify(input.conversationHistory)).not.toContain("question-0-");
  });

  it.each([
    ["", 1_000, 999],
    ["1001", 1_000, 999],
  ])(
    "uses the 1,000-request daily default and clamps a configured value of %s",
    async (configuredLimit, expectedLimit, expectedRemaining) => {
      vi.stubEnv("AAIS_AI_DAILY_GUIDE_LIMIT", configuredLimit);
      const graphMock = vi.fn(async () => createMockGuideGraphResult());
      vi.doMock("@/lib/ai/orchestration/aais-learning-guide-graph", () => ({
        runAaisLearningGuideGraph: graphMock,
      }));
      vi.resetModules();
      const guideRoute = await import("@/app/api/learning/ai-guide/route");
      const studentId = `daily-guide-limit-${configuredLimit || "default"}`;
      const csrf = createAaisCsrfToken(studentId);
      const cookie = createAuthedCookie(studentId, "student", csrf);
      await initializeLearnerSession(studentId, cookie, csrf);

      const response = await guideRoute.POST(new Request(
        "http://localhost/api/learning/ai-guide",
        {
          method: "POST",
          headers: {
            cookie,
            "x-aais-csrf": csrf,
          },
          body: JSON.stringify({
            dataGeneration: 1,
            taskId: "training_task_1",
            learnerInput: "验证每日智能导学额度。",
          }),
        },
      ));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        budget: {
          limit: expectedLimit,
          used: 1,
          remaining: expectedRemaining,
        },
      });
    },
  );

  it("enforces a per-student daily guide request budget", async () => {
    vi.stubEnv("AAIS_AI_DAILY_GUIDE_LIMIT", "1");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.resetModules();
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    vi.setSystemTime(new Date("2026-07-13T06:00:00.999Z"));
    const s001CsrfToken = createAaisCsrfToken("S001");
    const s001Cookie = createAuthedCookie("S001", "student", s001CsrfToken);
    await initializeLearnerSession("S001", s001Cookie, s001CsrfToken);
    vi.setSystemTime(new Date("2026-07-13T06:00:01.001Z"));
    const requestBody = {
      dataGeneration: 1,
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
          "x-aais-csrf": s001CsrfToken,
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
          "x-aais-csrf": s001CsrfToken,
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
      "ai.guide.budget.dispatched",
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

  it("keeps persisted AI-free guide turns deterministic and outside the daily AI budget", async () => {
    vi.stubEnv("AAIS_AI_DAILY_GUIDE_LIMIT", "1");
    const graphMock = vi.fn(async (input: {
      workspaceState: { aiUseMode?: string };
    }) => {
      void input;
      return createMockGuideGraphResult();
    });
    vi.doMock("@/lib/ai/orchestration/aais-learning-guide-graph", () => ({
      runAaisLearningGuideGraph: graphMock,
    }));
    const providerFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", providerFetch);
    vi.resetModules();
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    const sessionRoute = await import("@/app/api/learning/session/route");
    const analyticsRoute = await import("@/app/api/learning/analytics/route");
    const { getAaisLearningStore } = await import("@/lib/server/aais-learning-store");
    const studentId = "ai-free-budget-route";
    const csrf = createAaisCsrfToken(studentId);
    const cookie = createAuthedCookie(studentId, "student", csrf);
    await initializeLearnerSession(studentId, cookie, csrf);
    let guideMutationCounter = 0;
    const guideRequest = (learnerInput: string, stream = false) => new Request(
      `http://localhost/api/learning/ai-guide${stream ? "?stream=1" : ""}`,
      {
        method: "POST",
        headers: {
          ...(stream ? { accept: "text/event-stream" } : {}),
          cookie,
          "x-aais-csrf": csrf,
        },
        body: JSON.stringify({
          dataGeneration: 1,
          taskId: "training_task_1",
          learnerInput,
          mutationId: `ai-free-guide-${++guideMutationCounter}`,
          workspaceState: { currentStep: "guide" },
        }),
      },
    );

    const meteredResponse = await guideRoute.POST(guideRequest("先使用一次 AI 支持。"));
    expect(meteredResponse.status).toBe(200);
    await expect(meteredResponse.json()).resolves.toMatchObject({
      budget: { limit: 1, used: 1, remaining: 0 },
    });

    const modeResponse = await sessionRoute.PATCH(new Request(
      "http://localhost/api/learning/session",
      {
        method: "PATCH",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          action: "save-pilot-evidence",
          dataGeneration: 1,
          taskId: "training_task_1",
          expectedPilotEvidenceRevision: 0,
          mutationId: "persist-ai-free-before-guide",
          pilotEvidence: { aiUseMode: "ai-free" },
        }),
      },
    ));
    expect(modeResponse.status).toBe(200);

    const localResponse = await guideRoute.POST(guideRequest("使用本地量规提示我下一步。"));
    expect(localResponse.status).toBe(200);
    await expect(localResponse.json()).resolves.toMatchObject({
      budget: { limit: 1, used: 1, remaining: 0 },
    });

    const localStreamResponse = await guideRoute.POST(
      guideRequest("再给一次不使用外部 provider 的本地提示。", true),
    );
    expect(localStreamResponse.status).toBe(200);
    const streamText = await localStreamResponse.text();
    expect(streamText).toContain("event: done");
    expect(streamText).toContain('\"budget\":{\"limit\":1,\"used\":1,\"remaining\":0');

    const sessionResponse = await sessionRoute.GET(new Request(
      "http://localhost/api/learning/session",
      { headers: { cookie } },
    ));
    const sessionBody = await sessionResponse.json();
    expect(sessionBody.session.events.filter((event: { event: string }) =>
      event.event === "ai_prompt_submitted" || event.event === "ai_response_completed"
    )).toHaveLength(2);
    const localEvents = sessionBody.session.events.filter((event: { event: string }) =>
      event.event === "deterministic_guide_prompt_submitted"
      || event.event === "deterministic_guide_response_completed"
    );
    expect(localEvents).toHaveLength(0);
    const rawLocalEvents = (await getAaisLearningStore().readSession(studentId))?.events.filter(
      (event) => event.event === "deterministic_guide_prompt_submitted"
        || event.event === "deterministic_guide_response_completed",
    ) ?? [];
    expect(rawLocalEvents).toHaveLength(4);
    expect(rawLocalEvents.every((event) =>
      event.detail.external_provider_contacted === false
      && event.detail.raw_text_included === false
      && event.detail.storage_scope === "learner_session_only"
    )).toBe(true);
    await expect(getAaisLearningStore().getDailyGuideUsage(studentId)).resolves.toMatchObject({
      used: 1,
    });
    const analyticsResponse = await analyticsRoute.GET(new Request(
      "http://localhost/api/learning/analytics",
      { headers: { cookie } },
    ));
    await expect(analyticsResponse.json()).resolves.toMatchObject({
      analytics: {
        dashboard: {
          coachingEffect: { aiInteractions: 2 },
        },
      },
    });
    expect(graphMock).toHaveBeenCalledTimes(3);
    expect(graphMock.mock.calls.slice(1).every(([input]) =>
      input.workspaceState.aiUseMode === "ai-free"
    )).toBe(true);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("persists bounded guide attachment metadata without uploaded raw text", async () => {
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
    await initializeLearnerSession(
      "S001",
      s001Cookie,
      createAaisCsrfToken("S001"),
    );

    const guideResponse = await guideRoute.POST(
      new Request("http://localhost/api/learning/ai-guide", {
        method: "POST",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          dataGeneration: 1,
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
    expect(sessionBody.session.guideMessages[0]).toMatchObject({
      kind: "user",
      attachments: [{
        name: "planning-notes.txt",
        mediaType: "text/plain",
        sizeBytes: 52,
        status: "read",
      }],
    });
    expect(sessionBody.session.guideMessages[0].attachments[0]).not.toHaveProperty("extractedText");
  });

  it("rejects attachments before provider or session persistence in research mode", async () => {
    vi.stubEnv("AAIS_RESEARCH_MODE", "true");
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
          dataGeneration: 1,
          phase: "training",
          taskId: "training_task_1",
          learnerInput: "请看文件。",
          workspaceState: {
            currentStep: "guide",
            attachments: [{
              name: "private-notes.txt",
              mediaType: "text/plain",
              sizeBytes: 18,
              extractedText: "private raw text",
            }],
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: "AAIS_RESEARCH_ATTACHMENT_PROHIBITED",
      message: "Attachments are disabled for this research study.",
    });
    expect(JSON.stringify(body)).not.toContain("private-notes");
    expect(JSON.stringify(body)).not.toContain("private raw text");
  });

  it("blocks direct AI provider input when research is required but mode is disabled", async () => {
    vi.stubEnv("AAIS_RESEARCH_REQUIRED", "true");
    vi.stubEnv("AAIS_RESEARCH_MODE", "false");
    vi.resetModules();
    const graphMock = vi.fn();
    vi.doMock("@/lib/ai/orchestration/aais-learning-guide-graph", () => ({
      runAaisLearningGuideGraph: graphMock,
    }));
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    const rawInput = "required sentinel must not reach the provider";

    const response = await guideRoute.POST(
      new Request("http://localhost/api/learning/ai-guide", {
        method: "POST",
        headers: {
          cookie: createAuthedCookie("S001"),
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          dataGeneration: 1,
          phase: "training",
          taskId: "training_task_1",
          learnerInput: rawInput,
          workspaceState: {
            currentStep: "guide",
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toEqual({
      code: "AAIS_RESEARCH_MODE_REQUIRED",
      message: "AAIS research collection is required but not enabled.",
    });
    expect(graphMock).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain(rawInput);
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
          dataGeneration: 1,
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

  it("parses @教授 guide mentions and persists only the targeted visible answer", async () => {
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
    await initializeLearnerSession(
      "S001",
      s001Cookie,
      createAaisCsrfToken("S001"),
    );

    const guideResponse = await guideRoute.POST(
      new Request("http://localhost/api/learning/ai-guide", {
        method: "POST",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          dataGeneration: 1,
          phase: "training",
          taskId: "training_task_1",
          learnerInput: "@教授 请示范专家会怎样监控理解。",
          workspaceState: {
            currentStep: "guide",
          },
        }),
      }),
    );
    const guideBody = await guideResponse.json();

    expect(guideResponse.status).toBe(200);
    expect(guideBody.turns.map((turn: { agentId: string }) => turn.agentId)).toEqual(["A2"]);
    expect(guideBody.message.text).toContain("教授");
    expect(guideBody.message.text).not.toContain("小张");
    expect(guideBody.backgroundTurns).toBeUndefined();
    expect(guideBody.orchestration.graph.topologicalOrder).toEqual(["A2"]);
    expect(JSON.stringify(guideBody)).not.toMatch(/"A3"|"A4"|监督智能体|反思智能体/);

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
    expect(sessionBody.session.guideMessages[1].text).toContain("教授");
    expect(sessionBody.session.guideMessages[1].text).not.toContain("小张");
  });

  it("returns and persists the verified function graph scaffold in JSON mode", async () => {
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
    const cookie = createAuthedCookie("S001");
    const csrf = createAaisCsrfToken("S001");
    await initializeLearnerSession("S001", cookie, csrf);

    const response = await guideRoute.POST(
      new Request("http://localhost/api/learning/ai-guide", {
        method: "POST",
        headers: {
          cookie,
          "x-aais-csrf": csrf,
        },
        body: JSON.stringify({
          dataGeneration: 1,
          phase: "training",
          taskId: "training_task_1",
          learnerInput: "给我看 y = 2x² + 3x + 4 的图像",
          workspaceState: { currentStep: "guide" },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.turns[0]).toMatchObject({
      agentId: "A1",
      content: expect.stringContaining("计算不是看图的前置条件"),
      visualizations: [{
        type: "quadratic-function",
        expression: "y = 2x² + 3x + 4",
        vertex: { x: -0.75, y: 2.875 },
      }],
    });

    const sessionResponse = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session", {
        headers: { cookie },
      }),
    );
    const sessionBody = await sessionResponse.json();
    expect(sessionBody.session.guideMessages[1].turns[0].visualizations[0]).toMatchObject({
      type: "quadratic-function",
      coefficients: { a: 2, b: 3, c: 4 },
      vertex: { x: -0.75, y: 2.875 },
    });
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
    await initializeLearnerSession("S001");
    const response = await guideRoute.POST(
      new Request("http://localhost/api/learning/ai-guide", {
        method: "POST",
        headers: {
          cookie: createAuthedCookie("S001"),
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          dataGeneration: 1,
          phase: "training",
          taskId: "training_task_1",
          learnerInput: "请帮我明确目标。",
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
    expect(body.backgroundTurns).toBeUndefined();
    expect(body.orchestration.graph.topologicalOrder).toEqual(["A1"]);
    expect(body.message.text).toContain("小张");
    expect(body.orchestration.runtime.timings).toMatchObject({
      fallback: true,
      timeoutReason: "abort-timeout",
      attempts: 1,
    });
    expect(body.orchestration.runtime.timings.agents).toBeUndefined();
    expect(body.orchestration.runtime.ai).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/"A3"|"A4"|监督智能体|反思智能体/);
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
    const sessionRoute = await import("@/app/api/learning/session/route");
    await initializeLearnerSession("S001");

    const response = await guideRoute.POST(
      new Request("http://localhost/api/learning/ai-guide?stream=1", {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          cookie: createAuthedCookie("S001"),
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          dataGeneration: 1,
          phase: "training",
          taskId: "training_task_1",
          learnerInput: "请帮我明确目标。",
          workspaceState: {
            currentStep: "guide",
            attachments: [{
              name: "stream-notes.txt",
              mediaType: "text/plain",
              sizeBytes: 18,
              extractedText: "stream-only private source",
            }],
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
    expect(streamText).toContain('event: agent_start\ndata: {"agentId":"A1"}');
    expect(streamText).not.toContain('event: agent_start\ndata: {"agentId":"A2"}');
    expect(streamText).not.toContain('event: agent_delta\ndata: {"agentId":"A2"');
    expect(streamText).not.toContain('event: agent_done\ndata: {"agentId":"A2"');
    expect(streamText).toContain("event: fallback");
    expect(streamText).toContain("event: done");
    expect(streamText).not.toContain("event: background_done");
    expect(streamText).not.toMatch(/"A3"|"A4"|监督智能体|反思智能体/);
    expect(streamText).not.toContain("secret");
    const sessionResponse = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session", {
        headers: { cookie: createAuthedCookie("S001") },
      }),
    );
    const sessionBody = await sessionResponse.json();
    const acknowledgementBlock = streamText.match(/event: ack\ndata: ([^\n]+)\n\n/)?.[1];
    const doneBlock = streamText.match(/event: done\ndata: ([^\n]+)\n\n/)?.[1];
    expect(acknowledgementBlock).toBeTruthy();
    expect(doneBlock).toBeTruthy();
    expect(JSON.parse(acknowledgementBlock!)).not.toHaveProperty("exchange");
    expect(JSON.parse(doneBlock!).exchange).toEqual({
      userMessageId: sessionBody.session.guideMessages[0].id,
      assistantMessageId: sessionBody.session.guideMessages[1].id,
    });
    expect(sessionBody.session.guideMessages[0].attachments).toEqual([{
      name: "stream-notes.txt",
      mediaType: "text/plain",
      sizeBytes: 18,
      status: "read",
    }]);
    expect(JSON.stringify(sessionBody.session)).not.toContain("stream-only private source");
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
    await initializeLearnerSession("S001");
    const { guideStreamHeartbeatIntervalMs } = await import(
      "@/components/pages/learning/learning-page-constants"
    );
    vi.useFakeTimers();

    const response = await guideRoute.POST(
      new Request("http://localhost/api/learning/ai-guide?stream=1", {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          cookie: createAuthedCookie("S001"),
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          dataGeneration: 1,
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

    const heartbeatChunk = reader.read();
    await vi.advanceTimersByTimeAsync(guideStreamHeartbeatIntervalMs);
    expect(new TextDecoder().decode((await heartbeatChunk).value)).toBe(": aais-heartbeat\n\n");

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
    expect(remainingText).toContain("event: done");
    expect(remainingText).not.toContain("event: background_done");
    expect(remainingText).not.toMatch(/"A3"|"A4"|监督智能体|反思智能体/);
    vi.doUnmock("@/lib/ai/orchestration/aais-learning-guide-graph");
  });

  it("bounds the maximum provider retry chain without persisting or refunding a dispatched stream", async () => {
    vi.resetModules();
    let graphSignal: AbortSignal | undefined;
    const graphMock = vi.fn((
      _input: unknown,
      options?: { signal?: AbortSignal },
    ) => {
      graphSignal = options?.signal;
      return new Promise<never>((_resolve, reject) => {
        const rejectFromAbort = () => reject(graphSignal?.reason);
        if (graphSignal?.aborted) {
          rejectFromAbort();
        } else {
          graphSignal?.addEventListener("abort", rejectFromAbort, { once: true });
        }
      });
    });
    vi.doMock("@/lib/ai/orchestration/aais-learning-guide-graph", () => ({
      runAaisLearningGuideGraph: graphMock,
    }));
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    const sessionRoute = await import("@/app/api/learning/session/route");
    const studentId = "S-guide-route-deadline";
    const csrf = createAaisCsrfToken(studentId);
    const cookie = createAuthedCookie(studentId, "student", csrf);
    vi.stubEnv("AAIS_AI_DAILY_GUIDE_LIMIT", "1");
    await initializeLearnerSession(studentId, cookie, csrf);
    vi.useFakeTimers();

    const requestBody = JSON.stringify({
      dataGeneration: 1,
      taskId: "training_task_1",
      learnerInput: "最长 provider 重试链也必须受 route deadline 约束。",
      workspaceState: { currentStep: "guide" },
    });
    const response = await guideRoute.POST(new Request(
      "http://localhost/api/learning/ai-guide?stream=1",
      {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          cookie,
          "x-aais-csrf": csrf,
        },
        body: requestBody,
      },
    ));
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Expected a guide stream reader.");
    }
    const acknowledgement = await reader.read();
    expect(new TextDecoder().decode(acknowledgement.value)).toContain("event: ack");
    await Promise.resolve();

    expect(guideRoute.guideProviderMaximumRetryBudgetMs).toBe(240_000);
    expect(guideRoute.guideRouteTotalDeadlineMs).toBe(
      guideRoute.guideProviderMaximumRetryBudgetMs + 10_000,
    );
    expect(guideRoute.guideRouteTotalDeadlineMs).toBeLessThanOrEqual(
      guideRoute.guideRouteMaximumDeadlineMs,
    );
    expect(guideRoute.maxDuration * 1_000).toBeGreaterThan(
      guideRoute.guideRouteTotalDeadlineMs,
    );

    await vi.advanceTimersByTimeAsync(guideRoute.guideProviderMaximumRetryBudgetMs);
    expect(graphSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(
      guideRoute.guideRouteTotalDeadlineMs
        - guideRoute.guideProviderMaximumRetryBudgetMs
        + 1,
    );
    expect(graphSignal?.aborted).toBe(true);

    let streamText = "";
    let streamClosed = false;
    for (let chunkCount = 0; chunkCount < 40; chunkCount += 1) {
      const chunk = await reader.read();
      if (chunk.done) {
        streamClosed = true;
        break;
      }
      streamText += new TextDecoder().decode(chunk.value);
    }
    expect(streamClosed).toBe(true);
    expect(streamText).not.toContain("event: done");

    const sessionResponse = await sessionRoute.GET(new Request(
      "http://localhost/api/learning/session",
      { headers: { cookie } },
    ));
    const sessionBody = await sessionResponse.json();
    expect(sessionBody.session.guideMessages).toEqual([]);

    const retryResponse = await guideRoute.POST(new Request(
      "http://localhost/api/learning/ai-guide",
      {
        method: "POST",
        headers: { cookie, "x-aais-csrf": csrf },
        body: requestBody,
      },
    ));
    expect(retryResponse.status).toBe(429);
    expect(graphMock).toHaveBeenCalledTimes(1);
    vi.doUnmock("@/lib/ai/orchestration/aais-learning-guide-graph");
  });

  it("rejects a JSON guide append when privacy deletion wins after graph start", async () => {
    vi.resetModules();
    const graphResult = createDeferredGuideResult();
    const graphMock = vi.fn(() => graphResult.promise);
    vi.doMock("@/lib/ai/orchestration/aais-learning-guide-graph", () => ({
      runAaisLearningGuideGraph: graphMock,
    }));
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    const privacyRoute = await import("@/app/api/learning/privacy/route");
    const cookie = createAuthedCookie("S-guide-json-delete-race");
    const csrf = createAaisCsrfToken("S-guide-json-delete-race");
    await initializeLearnerSession("S-guide-json-delete-race", cookie, csrf);

    const pendingGuideResponse = guideRoute.POST(new Request(
      "http://localhost/api/learning/ai-guide",
      {
        method: "POST",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          dataGeneration: 1,
          phase: "training",
          taskId: "training_task_1",
          learnerInput: "JSON response that must not survive deletion",
          workspaceState: { currentStep: "guide" },
        }),
      },
    ));
    await vi.waitFor(() => expect(graphMock).toHaveBeenCalledTimes(1));

    const deletionResponse = await privacyRoute.DELETE(new Request(
      "http://localhost/api/learning/privacy",
      {
        method: "DELETE",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({ dataGeneration: 1 }),
      },
    ));
    await expect(deletionResponse.json()).resolves.toMatchObject({
      deletion: { nextGeneration: 2 },
    });
    graphResult.resolve(createMockGuideGraphResult());

    const guideResponse = await pendingGuideResponse;
    expect(guideResponse.status).toBe(409);
    await expect(guideResponse.json()).resolves.toMatchObject({
      error: { code: "AAIS_LEARNER_DATA_GENERATION_STALE" },
    });
    const exportResponse = await privacyRoute.GET(new Request(
      "http://localhost/api/learning/privacy",
      { headers: { cookie } },
    ));
    await expect(exportResponse.json()).resolves.toMatchObject({
      data: { session: null, events: [] },
    });
    vi.doUnmock("@/lib/ai/orchestration/aais-learning-guide-graph");
  });

  it("keeps a concurrent autosave when a deferred guide graph completes", async () => {
    vi.resetModules();
    const graphResult = createDeferredGuideResult();
    const graphMock = vi.fn(() => graphResult.promise);
    vi.doMock("@/lib/ai/orchestration/aais-learning-guide-graph", () => ({
      runAaisLearningGuideGraph: graphMock,
    }));
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    const sessionRoute = await import("@/app/api/learning/session/route");
    const studentId = "S-guide-autosave-race";
    const csrf = createAaisCsrfToken(studentId);
    const cookie = createAuthedCookie(studentId, "student", csrf);
    await initializeLearnerSession(studentId, cookie, csrf);

    const pendingGuideResponse = guideRoute.POST(new Request(
      "http://localhost/api/learning/ai-guide",
      {
        method: "POST",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          dataGeneration: 1,
          phase: "training",
          taskId: "training_task_1",
          learnerInput: "保留这次延迟 provider 回答",
          workspaceState: { currentStep: "guide" },
        }),
      },
    ));
    await vi.waitFor(() => expect(graphMock).toHaveBeenCalledTimes(1));

    const autosaveResponse = await sessionRoute.PATCH(new Request(
      "http://localhost/api/learning/session",
      {
        method: "PATCH",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          dataGeneration: 1,
          action: "save-artifact",
          taskId: "training_task_1",
          artifactText: "并发 autosave 必须保留",
          expectedArtifactRevision: 0,
          mutationId: "route-concurrent-autosave",
        }),
      },
    ));
    expect(autosaveResponse.status).toBe(200);
    graphResult.resolve(createMockGuideGraphResult());

    const guideResponse = await pendingGuideResponse;
    expect(guideResponse.status).toBe(200);
    await expect(guideResponse.json()).resolves.toMatchObject({
      message: { text: "Mocked final answer" },
    });
    const sessionResponse = await sessionRoute.GET(new Request(
      "http://localhost/api/learning/session",
      { headers: { cookie } },
    ));
    const sessionBody = await sessionResponse.json();
    expect(sessionResponse.status).toBe(200);
    expect(sessionBody.session.tasks[0].artifactText).toBe("并发 autosave 必须保留");
    expect(sessionBody.session.guideMessages.map(
      (message: { text: string }) => message.text,
    )).toEqual([
      "保留这次延迟 provider 回答",
      "Mocked final answer",
    ]);
    expect(sessionBody.session.events.filter(
      (event: { event: string }) => event.event === "ai_prompt_submitted",
    )).toHaveLength(1);
    expect(sessionBody.session.events.filter(
      (event: { event: string }) => event.event === "ai_response_completed",
    )).toHaveLength(1);
    expect(graphMock).toHaveBeenCalledTimes(1);
    vi.doUnmock("@/lib/ai/orchestration/aais-learning-guide-graph");
  });

  it("emits a safe SSE error and skips append when deletion wins after acknowledgement", async () => {
    vi.resetModules();
    const graphResult = createDeferredGuideResult();
    const graphMock = vi.fn(() => graphResult.promise);
    vi.doMock("@/lib/ai/orchestration/aais-learning-guide-graph", () => ({
      runAaisLearningGuideGraph: graphMock,
    }));
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    const privacyRoute = await import("@/app/api/learning/privacy/route");
    const cookie = createAuthedCookie("S-guide-stream-delete-race");
    const csrf = createAaisCsrfToken("S-guide-stream-delete-race");
    await initializeLearnerSession("S-guide-stream-delete-race", cookie, csrf);
    const response = await guideRoute.POST(new Request(
      "http://localhost/api/learning/ai-guide?stream=1",
      {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          cookie,
          "x-aais-csrf": csrf,
        },
        body: JSON.stringify({
          dataGeneration: 1,
          phase: "training",
          taskId: "training_task_1",
          learnerInput: "SSE response that must not survive deletion",
          workspaceState: { currentStep: "guide" },
        }),
      },
    ));
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Expected guide stream body.");
    }
    const decoder = new TextDecoder();
    const firstChunk = await reader.read();
    const acknowledgement = decoder.decode(firstChunk.value);
    expect(acknowledgement).toContain("event: ack");
    await vi.waitFor(() => expect(graphMock).toHaveBeenCalledTimes(1));

    const deletionResponse = await privacyRoute.DELETE(new Request(
      "http://localhost/api/learning/privacy",
      {
        method: "DELETE",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({ dataGeneration: 1 }),
      },
    ));
    expect(deletionResponse.status).toBe(200);
    graphResult.resolve(createMockGuideGraphResult());

    let remaining = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      remaining += decoder.decode(chunk.value);
    }
    expect(remaining).toContain("event: error");
    expect(remaining).not.toContain("event: done");
    expect(remaining).not.toContain('"exchange"');
    expect(remaining).not.toContain("Mocked final answer");
    const exportResponse = await privacyRoute.GET(new Request(
      "http://localhost/api/learning/privacy",
      { headers: { cookie } },
    ));
    await expect(exportResponse.json()).resolves.toMatchObject({
      data: { session: null, events: [] },
    });
    vi.doUnmock("@/lib/ai/orchestration/aais-learning-guide-graph");
  });

  it("cancels the provider and skips persistence without refunding dispatched cost", async () => {
    vi.stubEnv("AAIS_AI_PROVIDER", "openai-compatible");
    vi.stubEnv("AAIS_AI_ENDPOINT", "https://ai.example.test/v1/chat/completions");
    vi.stubEnv("AAIS_AI_API_KEY", "secret-api-key");
    vi.stubEnv("AAIS_AI_MODEL", "enterprise-model");
    vi.stubEnv("AAIS_AI_MAX_RETRIES", "3");
    vi.stubEnv("AAIS_AI_DAILY_GUIDE_LIMIT", "1");
    vi.resetModules();
    let notifyProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      notifyProviderStarted = resolve;
    });
    let notifyProviderAborted!: () => void;
    const providerAborted = new Promise<void>((resolve) => {
      notifyProviderAborted = resolve;
    });
    const providerFetch = vi.fn<typeof fetch>((_url, init) => {
      notifyProviderStarted();
      const signal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          notifyProviderAborted();
          reject(signal.reason);
        }, { once: true });
      });
    });
    vi.stubGlobal("fetch", providerFetch);
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    const sessionRoute = await import("@/app/api/learning/session/route");
    const csrf = createAaisCsrfToken("S-stream-cancel");
    const cookie = createAuthedCookie("S-stream-cancel", "student", csrf);

    const baselineResponse = await sessionRoute.POST(new Request(
      "http://localhost/api/learning/session",
      {
        method: "POST",
        headers: {
          cookie,
          "x-aais-csrf": csrf,
        },
      },
    ));
    const baseline = await baselineResponse.json();
    const response = await guideRoute.POST(new Request(
      "http://localhost/api/learning/ai-guide?stream=1",
      {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          cookie,
          "x-aais-csrf": csrf,
        },
        body: JSON.stringify({
          dataGeneration: 1,
          taskId: "training_task_1",
          learnerInput: "@A1 取消前不要保存这条问题。",
          workspaceState: { currentStep: "guide" },
        }),
      },
    ));
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Expected a guide stream reader.");
    }
    const firstChunk = await reader.read();
    expect(new TextDecoder().decode(firstChunk.value)).toContain("event: ack");
    await providerStarted;

    await reader.cancel();
    await providerAborted;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect((providerFetch.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
    const afterCancelResponse = await sessionRoute.GET(new Request(
      "http://localhost/api/learning/session",
      { headers: { cookie } },
    ));
    const afterCancel = await afterCancelResponse.json();
    expect(afterCancel.session.guideMessages).toEqual(baseline.session.guideMessages);
    expect(afterCancel.session.events.filter((event: { event: string }) =>
      event.event === "ai_prompt_submitted" || event.event === "ai_response_completed"
    )).toEqual([]);

    vi.stubEnv("AAIS_AI_PROVIDER", "");
    vi.stubEnv("AAIS_AI_ENDPOINT", "");
    vi.stubEnv("AAIS_AI_API_KEY", "");
    vi.stubEnv("AAIS_AI_MODEL", "");
    const retryResponse = await guideRoute.POST(new Request(
      "http://localhost/api/learning/ai-guide",
      {
        method: "POST",
        headers: {
          cookie,
          "x-aais-csrf": csrf,
        },
        body: JSON.stringify({
          dataGeneration: 1,
          taskId: "training_task_1",
          learnerInput: "@A1 已 dispatch 的成本不能通过取消退款。",
          workspaceState: { currentStep: "guide" },
        }),
      },
    ));
    expect(retryResponse.status).toBe(429);
    await expect(retryResponse.json()).resolves.toMatchObject({
      error: { code: "AAIS_GUIDE_DAILY_BUDGET_EXCEEDED" },
      budget: { limit: 1, used: 1, remaining: 0 },
    });
  });

  it("keeps dispatched cost after graph failure without persisting a guide exchange", async () => {
    vi.stubEnv("AAIS_AI_DAILY_GUIDE_LIMIT", "1");
    const graphMock = vi.fn(async () => {
      throw new Error("injected graph failure");
    });
    vi.doMock("@/lib/ai/orchestration/aais-learning-guide-graph", () => ({
      runAaisLearningGuideGraph: graphMock,
    }));
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    const sessionRoute = await import("@/app/api/learning/session/route");
    const studentId = "S-guide-graph-failure";
    const csrf = createAaisCsrfToken(studentId);
    const cookie = createAuthedCookie(studentId, "student", csrf);
    await initializeLearnerSession(studentId, cookie, csrf);
    const requestBody = JSON.stringify({
      dataGeneration: 1,
      taskId: "training_task_1",
      learnerInput: "失败的 graph 不应落消息，但已 dispatch 成本不能退款。",
      workspaceState: { currentStep: "guide" },
    });

    const firstResponse = await guideRoute.POST(new Request(
      "http://localhost/api/learning/ai-guide",
      {
        method: "POST",
        headers: { cookie, "x-aais-csrf": csrf },
        body: requestBody,
      },
    ));
    expect(firstResponse.status).toBe(500);
    const sessionResponse = await sessionRoute.GET(new Request(
      "http://localhost/api/learning/session",
      { headers: { cookie } },
    ));
    const sessionBody = await sessionResponse.json();
    expect(sessionBody.session.guideMessages).toEqual([]);
    expect(sessionBody.session.events.filter(
      (event: { event: string }) =>
        event.event === "ai_prompt_submitted" || event.event === "ai_response_completed",
    )).toEqual([]);
    expect(sessionBody.session).not.toHaveProperty("guideCapacityReservations");

    const secondResponse = await guideRoute.POST(new Request(
      "http://localhost/api/learning/ai-guide",
      {
        method: "POST",
        headers: { cookie, "x-aais-csrf": csrf },
        body: requestBody,
      },
    ));
    expect(secondResponse.status).toBe(429);
    expect(graphMock).toHaveBeenCalledTimes(1);
    vi.doUnmock("@/lib/ai/orchestration/aais-learning-guide-graph");
  });

  it("exports the persisted event log as CSV through the export route", async () => {
    const sessionRoute = await import("@/app/api/learning/session/route");
    const exportRoute = await import("@/app/api/learning/export/route");
    const s001Cookie = createAuthedCookie("S001");
    await initializeLearnerSession(
      "S001",
      s001Cookie,
      createAaisCsrfToken("S001"),
    );

    await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          dataGeneration: 1,
          action: "save-artifact",
          taskId: "training_task_1",
          artifactText: "可导出的过程记录",
          expectedArtifactRevision: 0,
          mutationId: "route-export-artifact-save",
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
    expect(cookieResponse.status).toBe(404);
    expect(cookieResponse.headers.get("content-disposition")).toBeNull();
    await expect(cookieResponse.json()).resolves.toMatchObject({
      error: {
        code: "AAIS_LEARNER_SESSION_NOT_FOUND",
      },
      secrets: "redacted",
    });
  });

  it("rejects explicit invalid analytics and export query values without creating learner state", async () => {
    const [{ GET: getAnalytics }, { GET: exportEvents }, { getAaisLearningStore }] = await Promise.all([
      import("@/app/api/learning/analytics/route"),
      import("@/app/api/learning/export/route"),
      import("@/lib/server/aais-learning-store"),
    ]);
    const actorId = "invalid-query-learner";
    const headers = { cookie: createAuthedCookie(actorId) };

    const invalidScopeAnalytics = await getAnalytics(new Request(
      "http://localhost/api/learning/analytics?scope=cohrot",
      { headers },
    ));
    const invalidScopeExport = await exportEvents(new Request(
      "http://localhost/api/learning/export?scope=cohrot",
      { headers },
    ));
    const invalidFormatExport = await exportEvents(new Request(
      "http://localhost/api/learning/export?format=xml",
      { headers },
    ));

    expect(invalidScopeAnalytics.status).toBe(400);
    await expect(invalidScopeAnalytics.json()).resolves.toMatchObject({
      error: { code: "AAIS_ANALYTICS_QUERY_INVALID" },
      secrets: "redacted",
    });
    for (const response of [invalidScopeExport, invalidFormatExport]) {
      expect(response.status).toBe(400);
      expect(response.headers.get("content-disposition")).toBeNull();
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "AAIS_EXPORT_QUERY_INVALID" },
        secrets: "redacted",
      });
    }
    await expect(getAaisLearningStore().readSession(actorId)).resolves.toBeNull();
  });

  it("fails closed for cohort exports when enrollment-backed storage is unavailable", async () => {
    const exportRoute = await import("@/app/api/learning/export/route");
    const studentResponse = await exportRoute.GET(
      new Request("http://localhost/api/learning/export?scope=cohort&format=json", {
        headers: {
          cookie: createAuthedCookie("S001"),
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
    expect(teacherCsvResponse.status).toBe(503);
    expect(teacherCsvResponse.headers.get("content-disposition")).toBeNull();
    await expect(teacherCsvResponse.json()).resolves.toMatchObject({
      error: {
        code: "AAIS_STORAGE_NOT_CONFIGURED",
      },
      secrets: "redacted",
    });

    const teacherJsonResponse = await exportRoute.GET(
      new Request("http://localhost/api/learning/export?scope=cohort&format=json&phase=practice&agent=A2&event=coaching_push", {
        headers: {
          cookie: createAuthedCookie("teacher-a", "teacher"),
        },
      }),
    );
    expect(teacherJsonResponse.status).toBe(503);
    expect(teacherJsonResponse.headers.get("content-disposition")).toBeNull();
    await expect(teacherJsonResponse.json()).resolves.toMatchObject({
      error: {
        code: "AAIS_STORAGE_NOT_CONFIGURED",
      },
      secrets: "redacted",
    });
  });

  it("serves authenticated learning analytics for dashboards and BI integration", async () => {
    const sessionRoute = await import("@/app/api/learning/session/route");
    const analyticsRoute = await import("@/app/api/learning/analytics/route");
    const s001Cookie = createAuthedCookie("S001");
    await initializeLearnerSession(
      "S001",
      s001Cookie,
      createAaisCsrfToken("S001"),
    );

    let analyticsMutationCounter = 0;
    for (const evidence of [
      {
        stageId: "launch_import",
        evidenceKind: "orientation_acknowledged",
      },
      {
        stageId: "modeling",
        evidenceKind: "expert_model_reviewed",
      },
    ]) {
      const evidenceResponse = await sessionRoute.PATCH(
        new Request("http://localhost/api/learning/session", {
          method: "PATCH",
          headers: {
            cookie: s001Cookie,
            "x-aais-csrf": createAaisCsrfToken("S001"),
          },
          body: JSON.stringify({
            dataGeneration: 1,
            action: "record-stage-evidence",
            taskId: "training_task_1",
            ...evidence,
            mutationId: `analytics-evidence-${++analyticsMutationCounter}`,
          }),
        }),
      );
      expect(evidenceResponse.status).toBe(200);
    }

    await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          dataGeneration: 1,
          action: "complete-task",
          taskId: "training_task_1",
          mutationId: "analytics-complete-training",
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

  it("rejects completing a locked task through the session route", async () => {
    const sessionRoute = await import("@/app/api/learning/session/route");
    const s001Cookie = createAuthedCookie("S001");
    await initializeLearnerSession(
      "S001",
      s001Cookie,
      createAaisCsrfToken("S001"),
    );

    // A brand-new learner may not complete practice_task_3 (locked) directly —
    // this would otherwise bypass server-side sequencing and inflate analytics.
    const response = await sessionRoute.PATCH(
      new Request("http://localhost/api/learning/session", {
        method: "PATCH",
        headers: {
          cookie: s001Cookie,
          "x-aais-csrf": createAaisCsrfToken("S001"),
        },
        body: JSON.stringify({
          dataGeneration: 1,
          action: "complete-task",
          taskId: "practice_task_3",
          mutationId: "complete-locked-task",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: "AAIS_TASK_LOCKED",
      message: "AAIS task is locked.",
    });

    // The locked task must remain uncompleted after the rejected request.
    const sessionResponse = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session", {
        headers: { cookie: s001Cookie },
      }),
    );
    const sessionBody = await sessionResponse.json();
    expect(
      sessionBody.session.tasks.find(
        (task: { taskId: string }) => task.taskId === "practice_task_3",
      )?.status,
    ).toBe("locked");
  });

  it("rejects guide requests for locked tasks before running the guide graph or recording facts", async () => {
    const graphMock = vi.fn();
    vi.doMock("@/lib/ai/orchestration/aais-learning-guide-graph", () => ({
      runAaisLearningGuideGraph: graphMock,
    }));
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    const sessionRoute = await import("@/app/api/learning/session/route");
    const cookie = createAuthedCookie("locked-guide-learner");
    await initializeLearnerSession(
      "locked-guide-learner",
      cookie,
      createAaisCsrfToken("locked-guide-learner"),
    );

    const response = await guideRoute.POST(
      new Request("http://localhost/api/learning/ai-guide", {
        method: "POST",
        headers: {
          cookie,
          "x-aais-csrf": createAaisCsrfToken("locked-guide-learner"),
        },
        body: JSON.stringify({
          dataGeneration: 1,
          phase: "training",
          taskId: "practice_task_3",
          learnerInput: "locked task audit",
          workspaceState: { currentStep: "guide" },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: "AAIS_TASK_LOCKED",
      message: "AAIS task is locked.",
    });
    expect(graphMock).not.toHaveBeenCalled();

    const sessionResponse = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session", { headers: { cookie } }),
    );
    const sessionBody = await sessionResponse.json();
    expect(sessionBody.session.guideMessages).toEqual([]);
    expect(sessionBody.session.events.filter((event: { event: string }) =>
      event.event === "ai_prompt_submitted" || event.event === "ai_response_completed"
    )).toEqual([]);
  });

  it("derives guide event phase from the server task instead of the request body", async () => {
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    const sessionRoute = await import("@/app/api/learning/session/route");
    const cookie = createAuthedCookie("canonical-phase-learner");
    await initializeLearnerSession(
      "canonical-phase-learner",
      cookie,
      createAaisCsrfToken("canonical-phase-learner"),
    );

    const response = await guideRoute.POST(
      new Request("http://localhost/api/learning/ai-guide", {
        method: "POST",
        headers: {
          cookie,
          "x-aais-csrf": createAaisCsrfToken("canonical-phase-learner"),
        },
        body: JSON.stringify({
          dataGeneration: 1,
          phase: "practice",
          taskId: "training_task_1",
          learnerInput: "phase spoof audit",
          workspaceState: { currentStep: "guide" },
        }),
      }),
    );
    expect(response.status).toBe(200);

    const sessionResponse = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session", { headers: { cookie } }),
    );
    const sessionBody = await sessionResponse.json();
    const guideEvents = sessionBody.session.events.filter((event: { event: string }) =>
      event.event === "ai_prompt_submitted" || event.event === "ai_response_completed"
    );
    expect(guideEvents).toHaveLength(2);
    expect(guideEvents.map((event: { phase: string }) => event.phase)).toEqual([
      "training",
      "training",
    ]);
  });

  it("requires educator authorization and enrollment-backed storage for cohort analytics", async () => {
    const analyticsRoute = await import("@/app/api/learning/analytics/route");
    const s001Cookie = createAuthedCookie("S001");

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

    expect(teacherResponse.status).toBe(503);
    expect(body).toMatchObject({
      error: {
        code: "AAIS_STORAGE_NOT_CONFIGURED",
      },
      secrets: "redacted",
    });
    expect(JSON.stringify(body)).not.toContain("test-session-secret");
  });

  it("does not let cohort filters widen access without enrollment-backed storage", async () => {
    const analyticsRoute = await import("@/app/api/learning/analytics/route");

    const teacherResponse = await analyticsRoute.GET(
      new Request("http://localhost/api/learning/analytics?scope=cohort&phase=practice&agent=A2&event=coaching_push", {
        headers: {
          cookie: createAuthedCookie("teacher-a", "teacher"),
        },
      }),
    );
    const body = await teacherResponse.json();

    expect(teacherResponse.status).toBe(503);
    expect(body).toMatchObject({
      error: {
        code: "AAIS_STORAGE_NOT_CONFIGURED",
      },
      secrets: "redacted",
    });
    expect(JSON.stringify(body)).not.toContain("practice");
  });

  it("fails closed for educator recommendations without enrollment-backed storage", async () => {
    const recommendationsRoute = await import("@/app/api/learning/recommendations/route");
    const s001Cookie = createAuthedCookie("S001");
    const teacherCookie = createAuthedCookie("teacher-a", "teacher");

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

    expect(teacherResponse.status).toBe(503);
    expect(body).toMatchObject({
      error: {
        code: "AAIS_STORAGE_NOT_CONFIGURED",
      },
      secrets: "redacted",
    });

    const overrideResponse = await recommendationsRoute.POST(
      new Request("http://localhost/api/learning/recommendations", {
        method: "POST",
        headers: {
          cookie: teacherCookie,
          "x-aais-csrf": extractCookieFromHeader(teacherCookie, getAaisCsrfCookieName()),
        },
        body: JSON.stringify({
          dataGeneration: 1,
          recommendationId: "recommendation-abcdef123456",
          learnerKey: "learner-abcdef123456",
          sessionKey: "session-abcdef123456",
          ruleId: "complete_reflection",
          targetTaskId: "practice_task_1",
          decision: "accepted",
          note: "教师已线下处理，原文不能进入事件。",
        }),
      }),
    );
    const overrideBody = await overrideResponse.json();

    expect(overrideResponse.status).toBe(503);
    expect(overrideBody).toMatchObject({
      error: {
        code: "AAIS_STORAGE_NOT_CONFIGURED",
      },
      secrets: "redacted",
    });
    expect(JSON.stringify(overrideBody)).not.toContain("教师已线下处理");
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
          dataGeneration: 1,
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
    const studentActor = createProductionOidcCookie("filter-student", "student");
    const teacherActor = createProductionOidcCookie("filter-teacher", "teacher");
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
          cookie: studentActor.cookie,
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
          cookie: teacherActor.cookie,
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
          cookie: teacherActor.cookie,
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

  it("replays stable navigation and scaffold receipts without duplicate learner mutations", async () => {
    const sessionRoute = await import("@/app/api/learning/session/route");
    const scaffoldRoute = await import("@/app/api/learning/scaffold/route");
    const { getAaisLearningStore } = await import("@/lib/server/aais-learning-store");
    const studentId = "route-stable-replay-hardening";
    const csrf = createAaisCsrfToken(studentId);
    const cookie = createAuthedCookie(studentId, "student", csrf);
    await initializeLearnerSession(studentId, cookie, csrf);
    const store = getAaisLearningStore();
    await store.recordStageEvidence(
      studentId, "training_task_1", "launch_import", "orientation_acknowledged",
    );
    await store.recordStageEvidence(
      studentId, "training_task_1", "modeling", "expert_model_reviewed",
    );
    await store.completeTask(studentId, "training_task_1");
    const patch = (body: Record<string, unknown>) => sessionRoute.PATCH(new Request(
      "http://localhost/api/learning/session",
      {
        method: "PATCH",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({ dataGeneration: 1, ...body }),
      },
    ));
    const selection = {
      action: "select-task",
      taskId: "practice_task_1",
      mutationId: "route-select-task-response-lost",
    };
    expect((await patch(selection)).status).toBe(200);
    const selectionReplay = await patch(selection);
    expect(selectionReplay.status).toBe(200);
    const selectionBody = await selectionReplay.json();
    expect(selectionBody.session.events.filter((event: { event: string }) =>
      event.event === "task_selected"
    )).toHaveLength(1);
    const scaffold = (toolId: string, mutationId?: string) => scaffoldRoute.POST(new Request(
      "http://localhost/api/learning/scaffold",
      {
        method: "POST",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          dataGeneration: 1,
          taskId: "practice_task_1",
          toolId,
          ...(mutationId ? { mutationId } : {}),
        }),
      },
    ));
    expect((await scaffold("stage-checklist", "route-scaffold-response-lost")).status).toBe(200);
    const replayedScaffold = await scaffold("stage-checklist", "route-scaffold-response-lost");
    const replayedBody = await replayedScaffold.json();
    expect(replayedScaffold.status).toBe(200);
    expect(replayedBody.requestCount).toBe(1);
    expect(replayedBody.session.tasks.find((task: { taskId: string }) =>
      task.taskId === "practice_task_1"
    ).scaffoldRequests).toBe(1);
    const conflict = await scaffold("sentence-starters", "route-scaffold-response-lost");
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "AAIS_MUTATION_ID_CONFLICT" },
    });
    const legacyMissingFence = await scaffold("stage-checklist");
    expect(legacyMissingFence.status).toBe(400);
    await expect(legacyMissingFence.json()).resolves.toMatchObject({
      error: { code: "AAIS_SCAFFOLD_MUTATION_ID_REQUIRED" },
    });
    expect((await patch({
      action: "select-stage",
      stageId: "coaching_scaffolding",
      mutationId: "route-stage-payload-conflict",
    })).status).toBe(200);
    const stageConflict = await patch({
      action: "select-stage",
      stageId: "articulation",
      mutationId: "route-stage-payload-conflict",
    });
    expect(stageConflict.status).toBe(409);
    await expect(stageConflict.json()).resolves.toMatchObject({
      error: { code: "AAIS_MUTATION_ID_CONFLICT" },
    });

    const graphMock = vi.fn(async () => createMockGuideGraphResult());
    vi.doMock("@/lib/ai/orchestration/aais-learning-guide-graph", () => ({
      runAaisLearningGuideGraph: graphMock,
    }));
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    const scaffoldedGuideRequest = () => new Request(
      "http://localhost/api/learning/ai-guide",
      {
        method: "POST",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          dataGeneration: 1,
          learnerInput: "我卡住了，想要一个支架提示。",
          mutationId: "guide-explicit-help-response-lost",
          taskId: "practice_task_1",
          workspaceState: { currentStep: "coaching_scaffolding" },
        }),
      },
    );
    const firstGuide = await guideRoute.POST(scaffoldedGuideRequest());
    expect(firstGuide.status).toBe(200);
    const firstGuideBody = await firstGuide.json();
    const replayedGuide = await guideRoute.POST(scaffoldedGuideRequest());
    expect(replayedGuide.status).toBe(200);
    const replayedGuideBody = await replayedGuide.json();
    expect(replayedGuideBody).toEqual(firstGuideBody);
    expect(graphMock).toHaveBeenCalledTimes(1);
    const rawAfterGuideReplay = await getAaisLearningStore().readSession(studentId);
    expect(rawAfterGuideReplay?.tasks.find((task) => task.taskId === "practice_task_1")
      ?.scaffoldRequests).toBe(2);
    expect(rawAfterGuideReplay?.events.filter((event) => event.event === "scaffold_request"))
      .toHaveLength(2);
    expect(rawAfterGuideReplay?.guideMessages).toHaveLength(2);
    expect(rawAfterGuideReplay?.guideMutationReservations).toEqual([]);
    expect((await getAaisLearningStore().getDailyGuideUsage(studentId)).used).toBe(1);
    const learnerSession = await sessionRoute.GET(new Request(
      "http://localhost/api/learning/session",
      { headers: { cookie } },
    ));
    const learnerSessionBody = await learnerSession.json();
    expect(learnerSessionBody.session).not.toHaveProperty("guideMutationReservations");
    expect(JSON.stringify(learnerSessionBody.session)).not.toContain("guideMutation");
  });

  it("replays a completed SSE guide exchange without a second provider or budget use", async () => {
    const studentId = "guide-sse-completed-replay";
    const csrf = createAaisCsrfToken(studentId);
    const cookie = createAuthedCookie(studentId, "student", csrf);
    const store = await initializePracticeGuideLearner(studentId, cookie, csrf);
    const graphMock = vi.fn(async () => createMockGuideGraphResult());
    vi.doMock("@/lib/ai/orchestration/aais-learning-guide-graph", () => ({
      runAaisLearningGuideGraph: graphMock,
    }));
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    const request = () => new Request("http://localhost/api/learning/ai-guide?stream=1", {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        cookie,
        "x-aais-csrf": csrf,
      },
      body: JSON.stringify({
        dataGeneration: 1,
        learnerInput: "我卡住了，请给一个逐步提示。",
        mutationId: "guide-sse-lost-done",
        taskId: "practice_task_1",
      }),
    });

    const first = await guideRoute.POST(request());
    expect(first.status).toBe(200);
    const firstStream = await first.text();
    expect(firstStream).toContain("event: done");
    const replayed = await guideRoute.POST(request());
    expect(replayed.status).toBe(200);
    const replayedStream = await replayed.text();
    expect(replayedStream).toBe(firstStream);
    expect(graphMock).toHaveBeenCalledTimes(1);
    const raw = await store.readSession(studentId);
    expect(raw?.guideMessages).toHaveLength(2);
    expect(raw?.guideMutationReservations).toEqual([]);
    expect(raw?.tasks.find((task) => task.taskId === "practice_task_1")?.scaffoldRequests)
      .toBe(1);
    expect((await store.getDailyGuideUsage(studentId)).used).toBe(1);
  });

  it("rejects an in-flight duplicate with retryable 503 and replays after completion", async () => {
    const studentId = "guide-concurrent-mutation";
    const csrf = createAaisCsrfToken(studentId);
    const cookie = createAuthedCookie(studentId, "student", csrf);
    const store = await initializePracticeGuideLearner(studentId, cookie, csrf);
    const deferred = createDeferredGuideResult();
    const graphMock = vi.fn(() => deferred.promise);
    vi.doMock("@/lib/ai/orchestration/aais-learning-guide-graph", () => ({
      runAaisLearningGuideGraph: graphMock,
    }));
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    const request = () => new Request("http://localhost/api/learning/ai-guide", {
      method: "POST",
      headers: { cookie, "x-aais-csrf": csrf },
      body: JSON.stringify({
        dataGeneration: 1,
        learnerInput: "我卡住了，请给我支架。",
        mutationId: "guide-concurrent-once",
        taskId: "practice_task_1",
      }),
    });

    const firstPromise = guideRoute.POST(request());
    await vi.waitFor(() => expect(graphMock).toHaveBeenCalledTimes(1));
    const concurrent = await guideRoute.POST(request());
    expect(concurrent.status).toBe(503);
    expect(concurrent.headers.get("retry-after")).toMatch(/^\d+$/);
    await expect(concurrent.json()).resolves.toMatchObject({
      error: { code: "AAIS_GUIDE_MUTATION_IN_PROGRESS" },
    });
    const conflictingInFlight = await guideRoute.POST(new Request(
      "http://localhost/api/learning/ai-guide",
      {
        method: "POST",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          dataGeneration: 1,
          learnerInput: "同一个 mutationId 的不同问题。",
          mutationId: "guide-concurrent-once",
          taskId: "practice_task_1",
        }),
      },
    ));
    expect(conflictingInFlight.status).toBe(409);
    await expect(conflictingInFlight.json()).resolves.toMatchObject({
      error: { code: "AAIS_MUTATION_ID_CONFLICT" },
    });
    expect(graphMock).toHaveBeenCalledTimes(1);
    deferred.resolve(createMockGuideGraphResult());
    const first = await firstPromise;
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const replayed = await guideRoute.POST(request());
    expect(replayed.status).toBe(200);
    await expect(replayed.json()).resolves.toEqual(firstBody);
    expect(graphMock).toHaveBeenCalledTimes(1);
    const raw = await store.readSession(studentId);
    expect(raw?.guideMessages).toHaveLength(2);
    expect(raw?.tasks.find((task) => task.taskId === "practice_task_1")?.scaffoldRequests)
      .toBe(1);
  });

  it("allows the same guide mutation to retry after failure but fences a changed attachment", async () => {
    const studentId = "guide-failure-and-payload-fence";
    const csrf = createAaisCsrfToken(studentId);
    const cookie = createAuthedCookie(studentId, "student", csrf);
    const store = await initializePracticeGuideLearner(studentId, cookie, csrf);
    const graphMock = vi.fn()
      .mockRejectedValueOnce(new Error("provider failed before completion"))
      .mockResolvedValue(createMockGuideGraphResult());
    vi.doMock("@/lib/ai/orchestration/aais-learning-guide-graph", () => ({
      runAaisLearningGuideGraph: graphMock,
    }));
    const guideRoute = await import("@/app/api/learning/ai-guide/route");
    const request = (extractedText: string) => new Request(
      "http://localhost/api/learning/ai-guide",
      {
        method: "POST",
        headers: { cookie, "x-aais-csrf": csrf },
        body: JSON.stringify({
          dataGeneration: 1,
          learnerInput: "我卡住了，请结合资料给提示。",
          mutationId: "guide-failure-retry-once",
          taskId: "practice_task_1",
          workspaceState: {
            attachments: [{
              name: "notes.txt",
              mediaType: "text/plain",
              sizeBytes: extractedText.length,
              extractedText,
            }],
          },
        }),
      },
    );

    const failed = await guideRoute.POST(request("canonical attachment"));
    expect(failed.status).toBe(500);
    const afterFailure = await store.readSession(studentId);
    expect(afterFailure?.guideMessages).toHaveLength(0);
    expect(afterFailure?.guideMutationReservations).toMatchObject([
      { status: "released" },
    ]);
    const retried = await guideRoute.POST(request("canonical attachment"));
    expect(retried.status).toBe(200);
    await retried.json();
    expect(graphMock).toHaveBeenCalledTimes(2);
    const conflict = await guideRoute.POST(request("changed attachment"));
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "AAIS_MUTATION_ID_CONFLICT" },
    });
    expect(graphMock).toHaveBeenCalledTimes(2);
    const raw = await store.readSession(studentId);
    expect(raw?.guideMessages).toHaveLength(2);
    expect(raw?.guideMutationReservations).toEqual([]);
    expect(raw?.tasks.find((task) => task.taskId === "practice_task_1")?.scaffoldRequests)
      .toBe(1);
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

function createProductionOidcCookie(
  subject: string,
  role: "student" | "teacher" | "admin",
) {
  const issuer = "https://identity.example.test";
  vi.stubEnv("AAIS_OIDC_ISSUER", issuer);
  vi.stubEnv("AAIS_OIDC_CLIENT_ID", "aais-route-test-client");
  vi.stubEnv("AAIS_OIDC_CLIENT_SECRET", "aais-route-test-client-secret");
  vi.stubEnv("AAIS_OIDC_REDIRECT_URI", "https://aais.example.test/api/auth/oidc/callback");
  vi.stubEnv("AAIS_OIDC_AUTHORIZATION_ENDPOINT", `${issuer}/authorize`);
  vi.stubEnv("AAIS_OIDC_TOKEN_ENDPOINT", `${issuer}/token`);
  vi.stubEnv("AAIS_OIDC_JWKS_URI", `${issuer}/jwks`);
  vi.stubEnv("AAIS_OIDC_TEACHER_GROUPS", "aais-teachers");
  vi.stubEnv("AAIS_OIDC_ADMIN_GROUPS", "aais-admins");
  const actorId = createAaisOidcActorId(issuer, subject);
  const csrfToken = createAaisCsrfToken(actorId);
  const policyFingerprint = getAaisOidcSessionPolicyFingerprint();
  if (!policyFingerprint) {
    throw new Error("Expected the test OIDC policy to be configured.");
  }
  const sessionToken = createAaisSessionToken({
    id: actorId,
    role,
    displayName: subject,
  }, new Date(), {
    authSource: "oidc",
    oidcPolicyFingerprint: policyFingerprint,
    ttlSeconds: 15 * 60,
  });
  return {
    actorId,
    csrfToken,
    cookie: `aais_session=${sessionToken}; ${getAaisCsrfCookieName()}=${csrfToken}`,
  };
}

function createAuthedCookie(
  id: string,
  role: "student" | "teacher" | "admin" = "student",
  csrfToken = createAaisCsrfToken(id),
) {
  const sessionToken = createAaisSessionToken({
    id,
    role,
    displayName: id,
  }, new Date(), { authSource: "development" });
  return `aais_session=${sessionToken}; ${getAaisCsrfCookieName()}=${csrfToken}`;
}

function createAaisCsrfToken(actorId: string) {
  const existingToken = testCsrfTokens.get(actorId);
  if (existingToken) {
    return existingToken;
  }
  const token = createUncachedAaisCsrfToken(actorId);
  testCsrfTokens.set(actorId, token);
  return token;
}

async function initializeLearnerSession(
  actorId: string,
  cookie = createAuthedCookie(actorId),
  csrfToken = createAaisCsrfToken(actorId),
) {
  const { POST } = await import("@/app/api/learning/session/route");
  const response = await POST(new Request("http://localhost/api/learning/session", {
    method: "POST",
    headers: {
      cookie,
      "x-aais-csrf": csrfToken,
    },
  }));
  if (!response.ok) {
    throw new Error(`Failed to initialize test learner session: ${response.status}.`);
  }
}

async function initializePracticeGuideLearner(
  actorId: string,
  cookie: string,
  csrfToken: string,
) {
  await initializeLearnerSession(actorId, cookie, csrfToken);
  const { getAaisLearningStore } = await import("@/lib/server/aais-learning-store");
  const store = getAaisLearningStore();
  await store.recordStageEvidence(
    actorId,
    "training_task_1",
    "launch_import",
    "orientation_acknowledged",
  );
  await store.recordStageEvidence(
    actorId,
    "training_task_1",
    "modeling",
    "expert_model_reviewed",
  );
  await store.completeTask(actorId, "training_task_1");
  await store.selectTask(actorId, "practice_task_1");
  return store;
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
