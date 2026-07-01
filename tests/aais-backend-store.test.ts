import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAaisLearningStore,
  flushAaisPersistentLrsOutbox,
  getAaisPersistentLrsOutboxStatus,
  getAaisDatabaseConfiguration,
  requeueAaisPersistentLrsDeadLetters,
} from "@/lib/server/aais-learning-store";
import * as lrsClient from "@/lib/server/aais-lrs-client";
import type { AaisEvent } from "@/data/aais";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-store-"));
});

afterEach(async () => {
  delete process.env.LRS_ENDPOINT;
  delete process.env.LRS_USERNAME;
  delete process.env.LRS_PASSWORD;
  delete process.env.AAIS_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  delete process.env.POSTGRES_PRISMA_URL;
  delete process.env.DATABASE_URL_UNPOOLED;
  delete process.env.POSTGRES_URL_NON_POOLING;
  delete process.env.PGHOST;
  delete process.env.PGHOST_UNPOOLED;
  delete process.env.PGPORT;
  delete process.env.PGUSER;
  delete process.env.PGDATABASE;
  delete process.env.PGPASSWORD;
  delete process.env.POSTGRES_HOST;
  delete process.env.POSTGRES_HOST_NON_POOLING;
  delete process.env.POSTGRES_PORT;
  delete process.env.POSTGRES_USER;
  delete process.env.POSTGRES_DATABASE;
  delete process.env.POSTGRES_PASSWORD;
  delete process.env.POSTGRES_SSLMODE;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(tempDir, { force: true, recursive: true });
});

describe("AAIS backend learning store", () => {
  it("creates a durable learner session with training and locked practice tasks", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });

    const session = await store.getOrCreateSession("S001");

    expect(session.studentId).toBe("S001");
    expect(session.activeTaskId).toBe("training_task_1");
    expect(session.tasks.map((task) => [task.taskId, task.status])).toEqual([
      ["training_task_1", "active"],
      ["practice_task_1", "locked"],
      ["practice_task_2", "locked"],
      ["practice_task_3", "locked"],
    ]);
    expect(session.events[0]).toMatchObject({
      student_id: "S001",
      session_id: session.sessionId,
      event: "session_created",
      agent: "platform",
    });
    expect(session.events.map((event) => event.event)).toContain("task_released");
  });

  it("enforces training-to-practice task sequencing on the server", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });

    await expect(store.selectTask("S001", "practice_task_2")).rejects.toThrow(
      "Task practice_task_2 is locked",
    );

    await store.completeTask("S001", "training_task_1");
    const practiceOne = await store.selectTask("S001", "practice_task_1");
    expect(practiceOne.activeTaskId).toBe("practice_task_1");

    await expect(store.selectTask("S001", "practice_task_2")).rejects.toThrow(
      "Task practice_task_2 is locked",
    );

    await store.completeTask("S001", "practice_task_1");
    const practiceTwo = await store.selectTask("S001", "practice_task_2");
    expect(practiceTwo.activeTaskId).toBe("practice_task_2");
  });

  it("persists artifacts, self reports, scaffold counts, and exportable events", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await store.completeTask("S001", "training_task_1");
    await store.selectTask("S001", "practice_task_1");

    await store.saveArtifact("S001", "practice_task_1", "我的任务理解和计划");
    await store.saveSelfReport("S001", "practice_task_1", "我和专家的差异是先后顺序不同");
    const fourth = await store.requestScaffold("S001", "practice_task_1", "pause-prompt");
    await store.requestScaffold("S001", "practice_task_1", "stage-checklist");
    await store.requestScaffold("S001", "practice_task_1", "sentence-starters");
    await store.requestScaffold("S001", "practice_task_1", "contrast-case");
    const fifth = await store.requestScaffold("S001", "practice_task_1", "pause-prompt");

    expect(fourth.mode).toBe("tool-list");
    expect(fifth.mode).toBe("self-check");

    const reloaded = createAaisLearningStore({ rootDir: tempDir });
    const session = await reloaded.getOrCreateSession("S001");
    const task = session.tasks.find((candidate) => candidate.taskId === "practice_task_1");

    expect(task?.artifactText).toBe("我的任务理解和计划");
    expect(task?.selfReport).toBe("我和专家的差异是先后顺序不同");
    expect(task?.scaffoldRequests).toBe(5);
    expect(session.events.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        "artifact_saved",
        "self_report_saved",
        "scaffold_request",
      ]),
    );

    const csv = await reloaded.exportEvents("S001", "csv");
    expect(csv.contentType).toBe("text/csv;charset=utf-8");
    expect(csv.body).toContain("student_id,session_id,phase,task,agent,event,time,detail");
    expect(csv.body).toContain("practice_task_1");
  });

  it("persists first and mirrors learning events to LRS through the async delivery queue", async () => {
    process.env.LRS_ENDPOINT = "https://lrs.example.test/xapi";
    process.env.LRS_USERNAME = "test-user";
    process.env.LRS_PASSWORD = "test-password";
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const store = createAaisLearningStore({ rootDir: tempDir });

    await store.getOrCreateSession("Phoebe");
    await store.saveArtifact("Phoebe", "training_task_1", "我先复述任务要求。");

    const persisted = await createAaisLearningStore({ rootDir: tempDir }).getOrCreateSession("Phoebe");
    expect(persisted.tasks[0]?.artifactText).toBe("我先复述任务要求。");
    await lrsClient.flushAaisLrsDeliveryQueue();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://lrs.example.test/xapi/statements",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const postedBodies = fetchMock.mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body)),
    );
    expect(
      postedBodies.flat().map((statement: { object: { definition: { name: { "en-US": string } } } }) =>
        statement.object.definition.name["en-US"],
      ),
    ).toEqual(expect.arrayContaining(["AAIS session_created", "AAIS task_released", "AAIS artifact_saved"]));
    expect(lrsClient.getAaisLrsDeliveryQueueStatus()).toMatchObject({
      pendingBatches: 0,
      retryBatches: 0,
      deadLetterBatches: 0,
      secrets: "redacted",
    });
  });

  it("summarizes learning analytics for teaching decisions and LMS/HRIS/BI joins", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await store.getOrCreateSession("S001");
    await store.selectStage("S001", "guide");
    await store.selectStage("S001", "assessment");
    await store.completeTask("S001", "training_task_1");
    await store.selectTask("S001", "practice_task_1");
    await store.saveArtifact("S001", "practice_task_1", "我的计划是先复述任务，再检查证据。");
    await store.saveSelfReport("S001", "practice_task_1", "我和专家相比，先列失败条件做得不够。");
    await store.selectStage("S001", "comparison");
    await store.requestScaffold("S001", "practice_task_1", "pause-prompt");
    await store.requestScaffold("S001", "practice_task_1", "stage-checklist");
    await store.requestScaffold("S001", "practice_task_1", "sentence-starters");
    await store.requestScaffold("S001", "practice_task_1", "contrast-case");
    await store.requestScaffold("S001", "practice_task_1", "pause-prompt");

    const analytics = await store.getAnalytics("S001");

    expect(analytics).toMatchObject({
      dashboard: {
        trainingToPractice: {
          trainingCompleted: true,
          activePracticeTaskId: "practice_task_1",
        },
        scaffoldDependency: {
          totalRequests: 5,
          selfCheckRequests: 1,
          status: "self_check_triggered",
        },
        reflectionQuality: {
          selfReportCount: 1,
          expertTraceComparisonCount: 1,
          status: "evidence_present",
        },
      },
      integrations: {
        factLayer: "lrs",
        joinKeys: ["session_id", "phase", "task", "agent", "event", "cohort", "role", "course_id"],
      },
      privacy: {
        actorMode: "pseudonymous",
        rawPromptStorage: "excluded_from_lrs",
      },
    });
  });

  it("can persist learner sessions through a database client", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });

    await store.getOrCreateSession("S001");
    await store.saveArtifact("S001", "training_task_1", "数据库持久化记录");

    const reloaded = createAaisLearningStore({ database });
    const session = await reloaded.getOrCreateSession("S001");

    expect(session.tasks[0].artifactText).toBe("数据库持久化记录");
    expect(database.queries.some((query) => /create table if not exists/i.test(query.sql))).toBe(true);
    expect(database.queries.some((query) => /insert into aais_learner_sessions/i.test(query.sql))).toBe(true);
    expect(database.queries.some((query) => /select payload/i.test(query.sql))).toBe(true);
  });

  it("persists LRS outbox rows in Postgres storage and can replay them", async () => {
    const database = createFakeDatabaseClient();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const store = createAaisLearningStore({ database });

    await store.getOrCreateSession("S001");
    await store.saveArtifact("S001", "training_task_1", "数据库 outbox 记录");

    expect(database.outboxRows.map((row) => row.status)).toContain("pending");
    expect(database.outboxRows.map((row) => row.payload.event)).toEqual(
      expect.arrayContaining(["session_created", "task_released", "artifact_saved"]),
    );

    const result = await flushAaisPersistentLrsOutbox({
      database,
      config: {
        endpoint: "https://lrs.example.test/xapi",
        username: "test-user",
        password: "test-password",
      },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      status: "sent",
      sent: database.outboxRows.length,
      batches: 1,
    });
    expect(database.outboxRows.every((row) => row.status === "sent")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const postedStatements = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(postedStatements).toHaveLength(database.outboxRows.length);
    expect(JSON.stringify(result)).not.toContain("test-password");
  });

  it("summarizes persistent LRS outbox status without exposing payloads", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });

    await store.getOrCreateSession("S001");
    await store.saveArtifact("S001", "training_task_1", "outbox payload text must not leak");
    await flushAaisPersistentLrsOutbox({
      database,
      config: {
        endpoint: "https://lrs.example.test/xapi",
        username: "test-user",
        password: "test-password",
      },
      fetchImpl: vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })) as unknown as typeof fetch,
      maxAttempts: 1,
    });

    const status = await getAaisPersistentLrsOutboxStatus({ database });

    expect(status).toEqual({
      mode: "persistent",
      storage: "postgres",
      configured: true,
      pending: 0,
      retry: 0,
      sent: 0,
      deadLetter: database.outboxRows.length,
      total: database.outboxRows.length,
      coalescing: {
        enabled: true,
        windowSeconds: 30,
        events: ["artifact_saved", "artifact_edited", "planning_submitted"],
        strategy: "latest-write-wins",
      },
      recovery: {
        deadLetterRequeue: true,
        action: "POST /api/learning/lrs/outbox/flush?action=requeue-dead-letter",
        auth: ["admin-session-csrf", "bearer-token"],
        redaction: "payloads-excluded",
      },
      secrets: "redacted",
    });
    expect(JSON.stringify(status)).not.toContain("outbox payload text must not leak");
    expect(JSON.stringify(status)).not.toContain("test-password");
  });

  it("requeues persistent LRS dead-letter rows without exposing payloads", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });

    await store.getOrCreateSession("S001");
    await store.saveArtifact("S001", "training_task_1", "dead-letter learner payload must not leak");
    await flushAaisPersistentLrsOutbox({
      database,
      config: {
        endpoint: "https://lrs.example.test/xapi",
        username: "test-user",
        password: "test-password",
      },
      fetchImpl: vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })) as unknown as typeof fetch,
      maxAttempts: 1,
    });

    expect(database.outboxRows.every((row) => row.status === "dead_letter")).toBe(true);
    expect(database.outboxRows.every((row) => row.attempts === 1)).toBe(true);

    const requeue = await requeueAaisPersistentLrsDeadLetters({
      database,
      limit: 2,
    });

    expect(requeue).toEqual({
      status: "requeued",
      requeued: 2,
      secrets: "redacted",
    });
    expect(database.outboxRows.filter((row) => row.status === "retry")).toHaveLength(2);
    expect(database.outboxRows.filter((row) => row.status === "retry").every((row) => row.attempts === 0)).toBe(true);
    expect(JSON.stringify(requeue)).not.toContain("dead-letter learner payload must not leak");
    expect(JSON.stringify(requeue)).not.toContain("test-password");
  });

  it("coalesces rapid artifact autosaves into the latest LRS outbox facts", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });

    await store.saveArtifact("S001", "training_task_1", "a");
    await store.saveArtifact("S001", "training_task_1", "ab");
    await store.saveArtifact("S001", "training_task_1", "abc");

    const artifactEditRows = database.outboxRows.filter((row) => row.payload.event === "artifact_edited");
    const artifactRows = database.outboxRows.filter((row) => row.payload.event === "artifact_saved");
    const planningRows = database.outboxRows.filter((row) => row.payload.event === "planning_submitted");
    expect(artifactEditRows).toHaveLength(1);
    expect(artifactRows).toHaveLength(1);
    expect(planningRows).toHaveLength(1);
    expect(artifactEditRows[0].payload.detail).toMatchObject({
      characters: 3,
      merged_events: 3,
      source: "debounced_server_save",
    });
    expect(artifactRows[0].payload.detail).toMatchObject({
      characters: 3,
      merged_events: 3,
    });
    expect(planningRows[0].payload.detail).toMatchObject({
      characters: 3,
      merged_events: 3,
      sourceEvent: "artifact_saved",
    });
  });

  it("emits A2 monitoring and coaching when artifact autosaves show low progress", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });

    await store.saveArtifact("S001", "training_task_1", "我先写一点");
    const session = await store.saveArtifact("S001", "training_task_1", "我先写一点");

    expect(session.events.map((event) => event.event)).toEqual(
      expect.arrayContaining(["monitoring_pause_detected", "coaching_push"]),
    );
  });

  it("emits A2 monitoring and coaching when artifact autosaves regress significantly", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    const originalArtifact = "计划".repeat(60);

    await store.saveArtifact("S001", "training_task_1", originalArtifact);
    const session = await store.saveArtifact("S001", "training_task_1", "计划调整");

    const monitoring = session.events.findLast((event) => event.event === "monitoring_pause_detected");
    const coaching = session.events.findLast((event) => event.event === "coaching_push");
    expect(monitoring?.detail).toMatchObject({
      signal: "artifact_regression_autosave",
      previous_characters: 120,
      current_characters: 4,
      delta_characters: -116,
      recovery_hint: "review_or_replan_before_continuing",
      cooldown_seconds: 600,
    });
    expect(coaching?.detail).toMatchObject({
      reason: "artifact_regression_autosave",
      interruption: "low",
      delta_characters: -116,
      recovery_hint: "review_or_replan_before_continuing",
      cooldown_seconds: 600,
    });
    expect(JSON.stringify(session.events)).not.toContain(originalArtifact);
  });

  it("throttles repeated A2 low-progress coaching within a short cooldown window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T08:00:00.000Z"));
    const store = createAaisLearningStore({ rootDir: tempDir });

    await store.saveArtifact("S001", "training_task_1", "我先写一点");
    await store.saveArtifact("S001", "training_task_1", "我先写一点");
    const immediate = await store.saveArtifact("S001", "training_task_1", "我先写一点");

    expect(immediate.events.filter((event) => event.event === "coaching_push")).toHaveLength(1);

    vi.setSystemTime(new Date("2026-06-30T08:11:00.000Z"));
    const afterCooldown = await store.saveArtifact("S001", "training_task_1", "我先写一点");

    expect(afterCooldown.events.filter((event) => event.event === "coaching_push")).toHaveLength(2);
    expect(afterCooldown.events.filter((event) => event.event === "monitoring_pause_detected")).toHaveLength(2);
    expect(afterCooldown.events.findLast((event) => event.event === "coaching_push")?.detail)
      .toMatchObject({
        reason: "low_progress_artifact_autosave",
        interruption: "low",
        cooldown_seconds: 600,
      });
    vi.useRealTimers();
  });

  it("records learner AI acceptance decisions as A2 evidence", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });

    const session = await store.recordAiAcceptance("S001", "training_task_1", {
      accepted: false,
      messageId: "assistant-decision-1",
      reason: "需要自己先解释依据",
    });
    const duplicate = await store.recordAiAcceptance("S001", "training_task_1", {
      accepted: false,
      messageId: "assistant-decision-1",
      reason: "重复点击不应增加证据",
    });
    const changed = await store.recordAiAcceptance("S001", "training_task_1", {
      accepted: true,
      messageId: "assistant-decision-1",
      reason: "改为采纳",
    });

    const event = session.events.find((candidate) => candidate.event === "ai_acceptance_recorded");
    expect(event).toMatchObject({
      agent: "A2",
      detail: {
        accepted: false,
        decision_key: expect.stringMatching(/^[a-f0-9]{16}$/),
        message_id_hash: expect.stringMatching(/^[a-f0-9]{16}$/),
        reason_length: 9,
        revision: 1,
        supersedes_previous: false,
      },
    });
    expect(duplicate.events.filter((candidate) => candidate.event === "ai_acceptance_recorded")).toHaveLength(1);
    expect(changed.events.filter((candidate) => candidate.event === "ai_acceptance_recorded")).toHaveLength(2);
    expect(changed.events.findLast((candidate) => candidate.event === "ai_acceptance_recorded")?.detail)
      .toMatchObject({
        accepted: true,
        decision_key: event?.detail.decision_key,
        revision: 2,
        supersedes_previous: true,
      });
    expect((await store.getAnalytics("S001")).dashboard.coachingEffect).toMatchObject({
      aiInteractions: 1,
      aiAcceptanceDecisions: 1,
    });
    expect(JSON.stringify(event)).not.toContain("需要自己先解释依据");
    expect(JSON.stringify(changed.events)).not.toContain("assistant-decision-1");
  });

  it("summarizes cohort analytics for teacher dashboards without raw learner text", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await store.completeTask("S001", "training_task_1");
    await store.selectTask("S001", "practice_task_1");
    await store.saveArtifact("S001", "practice_task_1", "第一位学习者的长过程记录");
    await store.requestScaffold("S001", "practice_task_1", "pause-prompt");
    await store.getOrCreateSession("S002");

    const analytics = await store.getCohortAnalytics();

    expect(analytics).toMatchObject({
      dashboard: {
        cohort: {
          learnerCount: 2,
          trainingCompleted: 1,
          scaffoldRequests: 1,
        },
      },
      integrations: {
        factLayer: "lrs",
      },
      privacy: {
        actorMode: "pseudonymous",
      },
    });
    expect(analytics.learners).toHaveLength(2);
    expect(JSON.stringify(analytics)).not.toContain("第一位学习者的长过程记录");
  });

  it("adds deterministic cohort risk bands and priority reasons for teacher action queues", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await store.completeTask("S001", "training_task_1");
    await store.selectTask("S001", "practice_task_1");
    await store.saveArtifact("S001", "practice_task_1", "第一位学习者的低进展风险记录");
    await store.saveArtifact("S001", "practice_task_1", "第一位学习者的低进展风险记录");
    await store.requestScaffold("S001", "practice_task_1", "pause-prompt");
    await store.requestScaffold("S001", "practice_task_1", "stage-checklist");
    await store.requestScaffold("S001", "practice_task_1", "sentence-starters");
    await store.requestScaffold("S001", "practice_task_1", "contrast-case");
    await store.requestScaffold("S001", "practice_task_1", "pause-prompt");

    await store.completeTask("S002", "training_task_1");
    await store.selectTask("S002", "practice_task_1");
    await store.saveSelfReport("S002", "practice_task_1", "第二位学习者已经完成反思");
    await store.selectStage("S002", "comparison");

    const analytics = await store.getCohortAnalytics();

    expect(analytics.dashboard.cohort.riskBreakdown).toEqual({
      high: 1,
      medium: 0,
      low: 1,
    });
    expect(analytics.learners.map((learner) => ({
      riskLevel: learner.riskLevel,
      priorityReasons: learner.priorityReasons,
    }))).toEqual([
      {
        riskLevel: "high",
        priorityReasons: [
          "reflection_missing",
          "a2_coaching_signals",
          "high_scaffold_dependency",
          "no_ai_interaction_after_coaching",
        ],
      },
      {
        riskLevel: "low",
        priorityReasons: [],
      },
    ]);
    expect(JSON.stringify(analytics)).not.toContain("第一位学习者的低进展风险记录");
    expect(JSON.stringify(analytics)).not.toContain("第二位学习者已经完成反思");
  });

  it("counts A2 AI acceptance as an interaction for cohort risk after coaching", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await store.completeTask("S001", "training_task_1");
    await store.selectTask("S001", "practice_task_1");
    await store.saveArtifact("S001", "practice_task_1", "低进展记录");
    await store.saveArtifact("S001", "practice_task_1", "低进展记录");
    await store.recordAiAcceptance("S001", "practice_task_1", {
      accepted: true,
      reason: "采纳提示后重新组织计划",
    });

    const analytics = await store.getCohortAnalytics();

    expect(analytics.dashboard.cohort.aiInteractions).toBe(1);
    expect(analytics.dashboard.cohort.aiAcceptanceDecisions).toBe(1);
    expect(analytics.learners[0]).toMatchObject({
      coachingSignals: 2,
      aiInteractions: 1,
      aiAcceptanceDecisions: 1,
      priorityReasons: ["reflection_missing", "a2_coaching_signals"],
    });
    expect(analytics.learners[0].priorityReasons).not.toContain("no_ai_interaction_after_coaching");
    expect(JSON.stringify(analytics)).not.toContain("采纳提示后重新组织计划");
  });

  it("filters cohort analytics by enterprise join keys without raw event payloads", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await store.completeTask("S001", "training_task_1");
    await store.selectTask("S001", "practice_task_1");
    await store.saveArtifact("S001", "practice_task_1", "第一位学习者的低进展记录");
    await store.saveArtifact("S001", "practice_task_1", "第一位学习者的低进展记录");
    await store.getOrCreateSession("S002");
    await store.saveArtifact("S002", "training_task_1", "第二位学习者的训练记录");

    const analytics = await store.getCohortAnalytics({
      phase: "practice",
      agent: "A2",
      event: "coaching_push",
    });

    expect(analytics).toMatchObject({
      filters: {
        applied: {
          phase: "practice",
          agent: "A2",
          event: "coaching_push",
        },
      },
      dashboard: {
        cohort: {
          learnerCount: 1,
          coachingSignals: 1,
          aiInteractions: 0,
        },
      },
      learners: [
        {
          trainingCompleted: true,
          coachingSignals: 1,
          aiInteractions: 0,
        },
      ],
      integrations: {
        joinKeys: ["session_id", "phase", "task", "agent", "event", "cohort", "role", "course_id"],
      },
    });
    expect(analytics.learners[0].learnerKey).toMatch(/^learner-/);
    expect(JSON.stringify(analytics)).not.toContain("S001");
    expect(JSON.stringify(analytics)).not.toContain("第一位学习者的低进展记录");
    expect(JSON.stringify(analytics)).not.toContain("第二位学习者的训练记录");
  });

  it("fails closed for the default production store when Postgres is not configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("AAIS_DATABASE_URL", "");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("POSTGRES_URL", "");
    vi.stubEnv("DATABASE_URL_UNPOOLED", "");
    vi.stubEnv("PGHOST", "");
    vi.stubEnv("PGUSER", "");
    vi.stubEnv("PGDATABASE", "");
    vi.stubEnv("PGPASSWORD", "");
    vi.resetModules();
    const { getAaisLearningStore } = await import("@/lib/server/aais-learning-store");

    expect(() => getAaisLearningStore()).toThrow(
      "AAIS production learner storage requires Postgres configuration.",
    );

    const explicitFileStore = createAaisLearningStore({ rootDir: tempDir });
    const session = await explicitFileStore.getOrCreateSession("S001");
    expect(session.studentId).toBe("S001");
  });

  it("uses explicit AAIS_DATABASE_URL ahead of Vercel fallback database variables", () => {
    vi.stubEnv("AAIS_DATABASE_URL", "postgres://aais:primary@primary.neon.tech/aais");
    vi.stubEnv("DATABASE_URL", "postgres://aais:fallback@fallback.neon.tech/aais");

    expect(getAaisDatabaseConfiguration()).toMatchObject({
      sourceEnv: "AAIS_DATABASE_URL",
      url: "postgres://aais:primary@primary.neon.tech/aais",
    });
  });

  it("uses legacy Vercel Postgres Neon URL aliases as fallback database variables", () => {
    vi.stubEnv("POSTGRES_URL_NON_POOLING", "postgres://aais:legacy@legacy.neon.tech/aais");

    expect(getAaisDatabaseConfiguration()).toMatchObject({
      sourceEnv: "POSTGRES_URL_NON_POOLING",
      url: "postgres://aais:legacy@legacy.neon.tech/aais",
    });
  });

  it("builds a Neon database configuration from Vercel raw PG environment pieces", () => {
    vi.stubEnv("PGHOST", "ep-prod.us-east-1.aws.neon.tech");
    vi.stubEnv("PGPORT", "6543");
    vi.stubEnv("PGUSER", "aais");
    vi.stubEnv("PGDATABASE", "aais_prod");
    vi.stubEnv("PGPASSWORD", "database-secret-that-must-not-leak");

    const config = getAaisDatabaseConfiguration();

    expect(config?.sourceEnv).toBe("PG*");
    const url = new URL(config?.url ?? "");
    expect(url.protocol).toBe("postgres:");
    expect(url.username).toBe("aais");
    expect(url.password).toBe("database-secret-that-must-not-leak");
    expect(url.hostname).toBe("ep-prod.us-east-1.aws.neon.tech");
    expect(url.port).toBe("6543");
    expect(url.pathname).toBe("/aais_prod");
    expect(url.searchParams.get("sslmode")).toBe("require");
  });

  it("builds a Neon database configuration from legacy Vercel Postgres raw environment pieces", () => {
    vi.stubEnv("POSTGRES_HOST", "ep-prod.us-east-1.aws.neon.tech");
    vi.stubEnv("POSTGRES_PORT", "6543");
    vi.stubEnv("POSTGRES_USER", "aais");
    vi.stubEnv("POSTGRES_DATABASE", "aais_prod");
    vi.stubEnv("POSTGRES_PASSWORD", "database-secret-that-must-not-leak");

    const config = getAaisDatabaseConfiguration();

    expect(config?.sourceEnv).toBe("POSTGRES_*");
    const url = new URL(config?.url ?? "");
    expect(url.protocol).toBe("postgres:");
    expect(url.username).toBe("aais");
    expect(url.password).toBe("database-secret-that-must-not-leak");
    expect(url.hostname).toBe("ep-prod.us-east-1.aws.neon.tech");
    expect(url.port).toBe("6543");
    expect(url.pathname).toBe("/aais_prod");
    expect(url.searchParams.get("sslmode")).toBe("require");
  });
});

function createFakeDatabaseClient() {
  const sessions = new Map<string, unknown>();
  const outbox = new Map<string, {
    id: string;
    payload: AaisEvent;
    status: string;
    attempts: number;
  }>();
  const queries: Array<{ sql: string; params: unknown[] }> = [];

  return {
    outboxRows: Array.from(outbox.values()),
    queries,
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      if (/^create table/i.test(sql.trim())) {
        return { rows: [] };
      }
      if (/^select payload from aais_lrs_outbox/i.test(sql.trim())) {
        const row = outbox.get(String(params[0]));
        return { rows: row ? [{ payload: row.payload }] : [] };
      }
      if (/^select payload from aais_learner_sessions order by/i.test(sql.trim())) {
        return { rows: Array.from(sessions.values()).map((payload) => ({ payload })) };
      }
      if (/^select payload/i.test(sql.trim())) {
        const payload = sessions.get(String(params[0]));
        return { rows: payload ? [{ payload }] : [] };
      }
      if (/^select id, payload, attempts/i.test(sql.trim())) {
        return {
          rows: Array.from(outbox.values())
            .filter((row) => row.status === "pending" || row.status === "retry")
            .map((row) => ({
              id: row.id,
              payload: row.payload,
              attempts: row.attempts,
            })),
        };
      }
      if (/^select status, count\(\*\)::int as count from aais_lrs_outbox group by status/i.test(sql.trim())) {
        const counts = new Map<string, number>();
        for (const row of outbox.values()) {
          counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
        }
        return {
          rows: Array.from(counts.entries()).map(([status, count]) => ({ status, count })),
        };
      }
      if (/^insert into aais_learner_sessions/i.test(sql.trim())) {
        sessions.set(String(params[0]), params[1]);
        return { rows: [] };
      }
      if (/^insert into aais_lrs_outbox/i.test(sql.trim())) {
        const existing = outbox.get(String(params[0]));
        outbox.set(String(params[0]), {
          id: String(params[0]),
          payload: JSON.parse(String(params[1])) as AaisEvent,
          status: "pending",
          attempts: existing?.attempts ?? 0,
        });
        this.outboxRows = Array.from(outbox.values());
        return { rows: [] };
      }
      if (/^update aais_lrs_outbox set status = 'sent'/i.test(sql.trim())) {
        const row = outbox.get(String(params[0]));
        if (row) {
          row.status = "sent";
        }
        this.outboxRows = Array.from(outbox.values());
        return { rows: [] };
      }
      if (/^update aais_lrs_outbox\s+set status = 'retry', attempts = 0/i.test(sql.trim())) {
        const rows = Array.from(outbox.values())
          .filter((row) => row.status === "dead_letter")
          .slice(0, Number(params[0]));
        for (const row of rows) {
          row.status = "retry";
          row.attempts = 0;
        }
        this.outboxRows = Array.from(outbox.values());
        return { rows: rows.map((row) => ({ id: row.id })) };
      }
      if (/^update aais_lrs_outbox set status =/i.test(sql.trim())) {
        const row = outbox.get(String(params[2]));
        if (row) {
          row.status = String(params[0]);
          row.attempts = Number(params[1]);
        }
        this.outboxRows = Array.from(outbox.values());
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}
