import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aaisLearnerSessionApiWindowLimits,
  aaisLearnerSessionPersistenceLimits,
  AaisLearningStorageConfigurationError,
  createAaisLearnerSessionApiDto,
  isAaisSessionWriteConflictError,
  createAaisLearningStore,
  flushAaisPersistentLrsOutbox,
  getAaisPersistentLrsOutboxStatus,
  getAaisDatabaseConfiguration,
  probeAaisLearningStorage,
  reconcileAaisLrsDeliveryAttempt,
  requeueAaisPersistentLrsDeadLetters,
  summarizeAaisCohortAnalytics,
  type AaisDatabaseClient,
  type AaisLearnerSession,
} from "@/lib/server/aais-learning-store";
import * as lrsClient from "@/lib/server/aais-lrs-client";
import { aaisEventDefinitions, type AaisEvent } from "@/data/aais";

let tempDir: string;

async function completeTrainingTask(
  store: ReturnType<typeof createAaisLearningStore>,
  studentId: string,
) {
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
  return store.completeTask(studentId, "training_task_1");
}

async function completePilotTaskTwo(
  store: ReturnType<typeof createAaisLearningStore>,
  studentId: string,
) {
  const session = await store.getOrCreateSession(studentId);
  const task = session.tasks.find((candidate) => candidate.taskId === "practice_task_1");
  if (!task) throw new Error("Missing pilot Task 2 fixture.");
  await store.savePilotEvidence(studentId, "practice_task_1", {
    diagnosisText: "原提示词没有说明评价标准和具体输出范围。",
    revisedPromptText: "请按明确目标、范围、结构与评价标准生成课程论文大纲。",
    outputEvaluationText: "输出结构基本符合要求，但证据范围仍需收紧后再使用。",
    articulationText: "我先诊断提示词，再修订条件，最后检查生成结果是否符合目标。",
  }, {
    expectedPilotEvidenceRevision: task.pilotEvidenceRevision,
    mutationId: `task-two-evidence-${studentId}`,
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
  return store.completeTask(studentId, "practice_task_1");
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-store-"));
});

afterEach(async () => {
  delete process.env.LRS_ENDPOINT;
  delete process.env.LRS_USERNAME;
  delete process.env.LRS_PASSWORD;
  delete process.env.AAIS_RESEARCH_MODE;
  delete process.env.AAIS_RESEARCH_REQUIRED;
  delete process.env.AAIS_DATABASE_DRIVER;
  delete process.env.AAIS_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  delete process.env.POSTGRES_PRISMA_URL;
  delete process.env.POSTGRES_URL_NO_SSL;
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
  it("separates stage opening from completion evidence and gates training on orientation plus modelling", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    const initial = await store.getOrCreateSession("stage-evidence-learner");
    expect(initial.tasks[0]?.completionMissing).toEqual([
      "orientation_acknowledged",
      "expert_model_reviewed",
    ]);

    const opened = await store.selectStage("stage-evidence-learner", "launch_import");
    expect(opened.tasks[0]?.milestones.find((milestone) => milestone.id === "launch_import"))
      .toMatchObject({ status: "open", evidenceKinds: [] });
    expect(opened.events.at(-1)).toMatchObject({
      event: "stage_selected",
      detail: { lifecycle: "stage_opened", milestoneId: "launch_import" },
    });
    await expect(store.completeTask("stage-evidence-learner", "training_task_1"))
      .rejects.toMatchObject({
        completionMissing: ["orientation_acknowledged", "expert_model_reviewed"],
      });

    const oriented = await store.recordStageEvidence(
      "stage-evidence-learner",
      "training_task_1",
      "launch_import",
      "orientation_acknowledged",
    );
    expect(oriented.tasks[0]?.completionMissing).toEqual(["expert_model_reviewed"]);
    expect(oriented.events.at(-1)).toMatchObject({
      event: "milestone_evidence_recorded",
      detail: {
        lifecycle: "completion_evidence_recorded",
        evidenceKind: "orientation_acknowledged",
      },
    });
    expect(oriented.events.filter((event) => event.event === "stage_selected")).toHaveLength(1);
    expect(oriented.events.some((event) =>
      event.event === "expert_model_viewed" && event.task === "training_task_1"
    )).toBe(false);

    const modeled = await store.recordStageEvidence(
      "stage-evidence-learner",
      "training_task_1",
      "modeling",
      "expert_model_reviewed",
    );
    expect(modeled.tasks[0]?.completionMissing).toEqual([]);
    expect(modeled.events.some((event) => event.event === "expert_model_viewed")).toBe(true);
    const completed = await store.completeTask("stage-evidence-learner", "training_task_1");
    expect(completed.tasks[0]).toMatchObject({
      status: "completed",
      completionOutcome: "evidence_complete",
    });
  });

  it("keeps local audit facts out of product events and the LRS outbox", async () => {
    const database = createFakeDatabaseClient();
    database.seedEnrollment({
      user_id: "local-audit-teacher",
      course_id: "cognitive-apprenticeship",
      cohort: "local-audit",
      role: "teacher",
      status: "active",
    });
    database.seedEnrollment({
      user_id: "local-audit-boundary",
      course_id: "cognitive-apprenticeship",
      cohort: "local-audit",
      role: "student",
      status: "active",
    });
    const store = createAaisLearningStore({ database });
    const session = await store.recordStageEvidence(
      "local-audit-boundary",
      "training_task_1",
      "launch_import",
      "orientation_acknowledged",
    );
    expect(session.events.some((event) => event.event === "milestone_evidence_recorded"))
      .toBe(true);
    expect(database.outboxRows.some((row) => row.payload.event === "milestone_evidence_recorded"))
      .toBe(false);
    await store.recordStageEvidence(
      "local-audit-boundary",
      "training_task_1",
      "modeling",
      "expert_model_reviewed",
    );
    await store.completeTask("local-audit-boundary", "training_task_1");
    await store.selectTask("local-audit-boundary", "practice_task_1");
    await completePilotTaskTwo(store, "local-audit-boundary");
    await store.saveArtifact("local-audit-boundary", "practice_task_3", "稿".repeat(800));
    const taskFour = (await store.getOrCreateSession("local-audit-boundary")).tasks.find(
      (task) => task.taskId === "practice_task_3",
    );
    if (!taskFour) throw new Error("Missing local audit Task 4 fixture.");
    const audited = await store.savePilotEvidence(
      "local-audit-boundary",
      "practice_task_3",
      {
        planningText: "先确定目标和结构，再分配证据。",
        monitoringText: "每段完成后检查目标、证据和篇幅。",
        evaluationText: "依据准确性、相关性和结构完整性评价。",
        outputEvaluationText: "输出结构可用，但证据仍需复核。",
        articulationText: "我先规划，再监控，最后评价并修订。",
        reflectionOutcome: "declined",
        reflectionDeclineReason: "本地保存但不外发的原因。",
      },
      {
        expectedPilotEvidenceRevision: taskFour.pilotEvidenceRevision,
        mutationId: "local-audit-report-and-outcome",
      },
    );
    expect(audited.events.some((event) => event.event === "a4_reflection_report_generated"))
      .toBe(true);
    expect(audited.events.some((event) => event.event === "pilot_outcome_recorded"))
      .toBe(true);
    const localAuditFacts = database.eventRows.filter((row) =>
      row.event === "milestone_evidence_recorded"
      || row.event === "a4_reflection_report_generated"
      || row.event === "pilot_outcome_recorded"
    );
    expect(localAuditFacts).toEqual([]);
    const outboxPayloads = JSON.stringify(database.outboxRows.map((row) => row.payload));
    expect(outboxPayloads).not.toContain("a4_reflection_report_generated");
    expect(outboxPayloads).not.toContain("pilot_outcome_recorded");
    expect(outboxPayloads).not.toContain("analyze_task");
    expect(outboxPayloads).not.toContain("reason_length");
    expect(aaisEventDefinitions.milestone_evidence_recorded.lrsEligible).toBe(false);
    expect(aaisEventDefinitions.a4_reflection_report_generated.lrsEligible).toBe(false);
    expect(aaisEventDefinitions.pilot_outcome_recorded.lrsEligible).toBe(false);

    const analytics = await store.getEducatorCohortAnalytics({
      actorId: "local-audit-teacher",
      actorRole: "teacher",
    }, {
      phase: "practice",
      task: "practice_task_3",
    });
    expect(analytics).toMatchObject({
      learners: [{
        activePracticeTaskId: "practice_task_3",
        reflectionStatus: "evidence_present",
      }],
      integrations: {
        factLayer: "aais_events",
      },
    });
    expect(JSON.stringify(analytics)).not.toContain("先确定目标和结构，再分配证据。");
    expect(JSON.stringify(analytics)).not.toContain("本地保存但不外发的原因。");
    const cohortQuery = database.queries.find((query) =>
      /session_reflection_evidence_by_session as/i.test(query.sql)
    );
    expect(cohortQuery?.sql).toMatch(/jsonb_array_elements/i);
    expect(cohortQuery?.sql).not.toMatch(/select\s+learner_session\.payload\b/i);
    expect(JSON.stringify(cohortQuery?.params)).not.toContain("先确定目标和结构，再分配证据。");
    expect(JSON.stringify(cohortQuery?.params)).not.toContain("本地保存但不外发的原因。");

    const malformedLegacySession = structuredClone(audited);
    const malformedTask = malformedLegacySession.tasks.find((task) =>
      task.taskId === "practice_task_3"
    );
    if (!malformedTask) throw new Error("Missing malformed legacy Task 4 fixture.");
    (malformedTask as unknown as { reflectionReport: unknown }).reflectionReport = {
      version: "legacy-malformed-report",
      expertModelId: "legacy-expert",
      expertStepIds: { unexpected: true },
    };
    database.seedSessionPayload(
      "local-audit-boundary",
      malformedLegacySession,
      database.getSessionVersion("local-audit-boundary") ?? 0,
    );
    const malformedAnalytics = await store.getEducatorCohortAnalytics({
      actorId: "local-audit-teacher",
      actorRole: "teacher",
    }, {
      phase: "practice",
      task: "practice_task_3",
    });
    expect(malformedAnalytics.learners[0]?.reflectionStatus)
      .toBe("needs_reflection_evidence");
  });

  it("persists AI-free guide exchanges locally without AI quota or analytics facts", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });

    const result = await store.appendGuideExchange({
      studentId: "ai-free-local-guide",
      phase: "training",
      taskId: "training_task_1",
      question: "请用静态量规提示我下一步。",
      answer: "先写下目标、约束和一个可核查的评价依据。",
      interactionMode: "deterministic-local",
      orchestration: {
        graphId: "learning-ai-guide",
        topologicalOrder: ["A1"],
        threadId: "ai-free-local-thread",
      },
    });

    const localEvents = result.session.events.filter((event) =>
      event.event === "deterministic_guide_prompt_submitted"
      || event.event === "deterministic_guide_response_completed"
    );
    expect(localEvents).toHaveLength(2);
    expect(localEvents.every((event) =>
      event.agent === "platform"
      && event.detail.external_provider_contacted === false
      && event.detail.raw_text_included === false
      && event.detail.storage_scope === "learner_session_only"
    )).toBe(true);
    expect(result.session.events.some((event) =>
      event.event === "ai_prompt_submitted" || event.event === "ai_response_completed"
    )).toBe(false);
    expect(database.eventRows.some((row) =>
      row.event === "deterministic_guide_prompt_submitted"
      || row.event === "deterministic_guide_response_completed"
    )).toBe(false);
    expect(JSON.stringify(database.outboxRows)).not.toContain("deterministic_guide_");
    await expect(store.getDailyGuideUsage("ai-free-local-guide")).resolves.toMatchObject({
      used: 0,
    });
    const analytics = await store.getAnalytics("ai-free-local-guide");
    expect(analytics.dashboard.coachingEffect.aiInteractions).toBe(0);
  });

  it("allows only task-owned milestones with saved evidence and canonical ordering", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await expect(store.recordStageEvidence(
      "milestone-contract-learner",
      "training_task_1",
      "reflection",
      "reflection_submitted",
    )).rejects.toMatchObject({ reason: "stage_evidence_invalid" });
    await expect(store.recordStageEvidence(
      "milestone-contract-learner",
      "training_task_1",
      "modeling",
      "expert_model_reviewed",
    )).rejects.toMatchObject({ reason: "stage_evidence_invalid" });
    const opened = await store.selectStage("milestone-contract-learner", "modeling");
    expect(opened.tasks[0]?.milestones.find((milestone) => milestone.id === "modeling"))
      .toMatchObject({ status: "open", evidenceKinds: [] });
    await expect(store.recordStageEvidence(
      "milestone-contract-learner",
      "training_task_1",
      "modeling",
      "expert_model_reviewed",
    )).rejects.toMatchObject({ reason: "stage_evidence_invalid" });

    await completeTrainingTask(store, "milestone-contract-learner");
    await store.selectTask("milestone-contract-learner", "practice_task_1");
    await expect(store.recordStageEvidence(
      "milestone-contract-learner",
      "practice_task_1",
      "coaching_scaffolding",
      "guided_practice_completed",
    )).rejects.toMatchObject({ reason: "stage_evidence_invalid" });
    await expect(store.recordStageEvidence(
      "milestone-contract-learner",
      "practice_task_1",
      "summary_completion",
      "summary_acknowledged",
    )).rejects.toMatchObject({ reason: "stage_evidence_invalid" });
  });

  it("protects structured pilot evidence with revision and idempotency fences", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await completeTrainingTask(store, "pilot-revision-learner");
    await store.selectTask("pilot-revision-learner", "practice_task_1");
    const patch = { diagnosisText: "原提示词缺少目标范围、评价标准和输出约束。" };
    const first = await store.savePilotEvidence(
      "pilot-revision-learner",
      "practice_task_1",
      patch,
      {
        expectedPilotEvidenceRevision: 0,
        mutationId: "pilot-evidence-save-1",
      },
    );
    expect(first.tasks.find((task) => task.taskId === "practice_task_1")?.pilotEvidenceRevision)
      .toBe(1);

    const replay = await store.savePilotEvidence(
      "pilot-revision-learner",
      "practice_task_1",
      patch,
      {
        expectedPilotEvidenceRevision: 0,
        mutationId: "pilot-evidence-save-1",
      },
    );
    expect(replay.tasks.find((task) => task.taskId === "practice_task_1")?.pilotEvidenceRevision)
      .toBe(1);

    await expect(store.savePilotEvidence(
      "pilot-revision-learner",
      "practice_task_1",
      { diagnosisText: "同一 mutation id 的不同内容必须拒绝。" },
      {
        expectedPilotEvidenceRevision: 0,
        mutationId: "pilot-evidence-save-1",
      },
    )).rejects.toMatchObject({ reason: "mutation_replay_conflict" });

    await expect(store.savePilotEvidence(
      "pilot-revision-learner",
      "practice_task_1",
      { revisedPromptText: "另一个标签页基于旧 revision 保存。" },
      {
        expectedPilotEvidenceRevision: 0,
        mutationId: "pilot-evidence-save-2",
      },
    )).rejects.toMatchObject({ field: "pilot_evidence" });
  });

  it("uses canonical four-level scaffold content before fading into self-check", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await completeTrainingTask(store, "scaffold-level-learner");
    await store.selectTask("scaffold-level-learner", "practice_task_1");
    const results = [];
    for (let index = 0; index < 5; index += 1) {
      results.push(await store.requestScaffold(
        "scaffold-level-learner",
        "practice_task_1",
        "pause-prompt",
      ));
    }
    expect(results.map((result) => ({
      level: result.level,
      toolId: result.tool.id,
      mode: result.mode,
      fading: result.fading,
    }))).toEqual([
      { level: 1, toolId: "stage-checklist", mode: "tool-list", fading: false },
      { level: 2, toolId: "sentence-starters", mode: "tool-list", fading: false },
      { level: 3, toolId: "pause-prompt", mode: "tool-list", fading: false },
      { level: 4, toolId: "contrast-case", mode: "tool-list", fading: false },
      { level: 1, toolId: "stage-checklist", mode: "self-check", fading: true },
    ]);
    expect(new Set(results.slice(0, 4).map((result) => result.tool.body)).size).toBe(4);
    expect(results[4]?.tool.body).toContain("先不查看新的示范");
    expect(results[4]?.tool.body).not.toBe(results[0]?.tool.body);
    expect(results[4]).toMatchObject({
      fadingReason: "direct_assists_exhausted",
      remainingDirectAssists: 0,
      evidenceSnapshot: { rawTextIncluded: false },
    });
  });

  it("fades one scaffold after structured evidence improves without consuming a direct assist", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    const studentId = "evidence-aware-fading-learner";
    await completeTrainingTask(store, studentId);
    await store.selectTask(studentId, "practice_task_1");
    const first = await store.requestScaffold(studentId, "practice_task_1", "stage-checklist");
    expect(first).toMatchObject({
      mode: "tool-list",
      level: 1,
      remainingDirectAssists: 3,
      fading: false,
      evidenceSnapshot: {
        structuredFieldsCompleted: 0,
        artifactVisibleCharacterBucket: "under_8",
        completedMilestones: 0,
        rawTextIncluded: false,
      },
    });
    const task = first.session.tasks.find((candidate) => candidate.taskId === "practice_task_1");
    if (!task) throw new Error("Missing evidence-aware scaffold task.");
    const diagnosisText = "原提示词缺少目标、范围和评价标准。";
    await store.savePilotEvidence(studentId, "practice_task_1", { diagnosisText }, {
      expectedPilotEvidenceRevision: task.pilotEvidenceRevision,
      mutationId: "evidence-aware-fading-diagnosis",
    });

    const earlyFade = await store.requestScaffold(
      studentId,
      "practice_task_1",
      "sentence-starters",
    );
    expect(earlyFade).toMatchObject({
      requestCount: 2,
      mode: "self-check",
      fading: true,
      fadingReason: "evidence_improved",
      remainingDirectAssists: 3,
      evidenceSnapshot: {
        structuredFieldsCompleted: 1,
        rawTextIncluded: false,
      },
    });
    const persistedTask = earlyFade.session.tasks.find((candidate) =>
      candidate.taskId === "practice_task_1"
    );
    expect(persistedTask?.scaffoldHistory.at(-1)).toMatchObject({
      mode: "self-check",
      fadingReason: "evidence_improved",
      remainingDirectAssists: 3,
      evidenceSnapshot: { structuredFieldsCompleted: 1, rawTextIncluded: false },
    });
    expect(JSON.stringify(persistedTask?.scaffoldHistory.at(-1)?.evidenceSnapshot))
      .not.toContain(diagnosisText);
    const scaffoldEvent = earlyFade.session.events.filter((event) =>
      event.event === "scaffold_request" && event.task === "practice_task_1"
    ).at(-1);
    expect(scaffoldEvent?.detail).not.toHaveProperty("evidenceSnapshot");
    expect(scaffoldEvent?.detail).not.toHaveProperty("fadingReason");

    const reloadedStore = createAaisLearningStore({ rootDir: tempDir });
    const resumedDirect = await reloadedStore.requestScaffold(
      studentId,
      "practice_task_1",
      "pause-prompt",
    );
    expect(resumedDirect).toMatchObject({
      requestCount: 3,
      mode: "tool-list",
      level: 2,
      fading: false,
      remainingDirectAssists: 2,
    });
    expect(resumedDirect).not.toHaveProperty("fadingReason");
  });

  it("uses milestone and artifact buckets for fading while keeping snapshots task-isolated", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    const studentId = "evidence-aware-task-isolation";
    const first = await store.requestScaffold(studentId, "training_task_1", "stage-checklist");
    expect(first.evidenceSnapshot).toMatchObject({
      artifactVisibleCharacterBucket: "under_8",
      completedMilestones: 0,
    });
    await store.recordStageEvidence(
      studentId,
      "training_task_1",
      "launch_import",
      "orientation_acknowledged",
    );
    const milestoneFade = await store.requestScaffold(
      studentId,
      "training_task_1",
      "sentence-starters",
    );
    expect(milestoneFade).toMatchObject({
      mode: "self-check",
      fadingReason: "evidence_improved",
      remainingDirectAssists: 3,
      evidenceSnapshot: { completedMilestones: 1 },
    });
    await store.saveArtifact(studentId, "training_task_1", "稿".repeat(100));
    const artifactFade = await store.requestScaffold(
      studentId,
      "training_task_1",
      "pause-prompt",
    );
    expect(artifactFade).toMatchObject({
      mode: "self-check",
      fadingReason: "evidence_improved",
      remainingDirectAssists: 3,
      evidenceSnapshot: { artifactVisibleCharacterBucket: "100_799" },
    });

    await store.recordStageEvidence(
      studentId,
      "training_task_1",
      "modeling",
      "expert_model_reviewed",
    );
    await store.completeTask(studentId, "training_task_1");
    await store.selectTask(studentId, "practice_task_1");
    const taskTwo = (await store.getOrCreateSession(studentId)).tasks.find((candidate) =>
      candidate.taskId === "practice_task_1"
    );
    if (!taskTwo) throw new Error("Missing task-isolated scaffold fixture.");
    await store.savePilotEvidence(studentId, "practice_task_1", {
      diagnosisText: "任务二在第一次求助前已经有独立证据。",
    }, {
      expectedPilotEvidenceRevision: taskTwo.pilotEvidenceRevision,
      mutationId: "task-isolated-evidence-baseline",
    });
    const taskTwoFirst = await store.requestScaffold(
      studentId,
      "practice_task_1",
      "stage-checklist",
    );
    expect(taskTwoFirst).toMatchObject({
      mode: "tool-list",
      level: 1,
      fading: false,
      remainingDirectAssists: 3,
      evidenceSnapshot: { structuredFieldsCompleted: 1 },
    });
  });

  it("keeps Task 4 reflection refusal auditable while allowing an ended-incomplete close", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await completeTrainingTask(store, "reflection-decline-learner");
    await store.selectTask("reflection-decline-learner", "practice_task_1");
    await completePilotTaskTwo(store, "reflection-decline-learner");
    const before = await store.getOrCreateSession("reflection-decline-learner");
    const taskFour = before.tasks.find((task) => task.taskId === "practice_task_3");
    if (!taskFour) throw new Error("Missing pilot Task 4 fixture.");
    expect(taskFour.reflectionReport).toBeNull();
    await store.saveArtifact(
      "reflection-decline-learner",
      "practice_task_3",
      "稿".repeat(800),
    );
    await store.savePilotEvidence(
      "reflection-decline-learner",
      "practice_task_3",
      {
        planningText: "先确定受众、目标和交付结构，再开始撰写。",
        monitoringText: "每完成一节就核对目标、证据和篇幅是否一致。",
        evaluationText: "按准确性、相关性、结构完整性和可执行性评价。",
        outputEvaluationText: "生成结果结构可用，但证据边界仍需人工复核。",
        articulationText: "我先规划，再监控生成过程，最后按标准评价并修订。",
        reflectionOutcome: "declined",
        reflectionDeclineReason: "本次不填写反思，稍后可继续。",
        reflectionText: "旧反思原文仍保留，但本次明确选择暂不提交。",
        expertComparisonText: "旧对照原文仍保留，之后可以继续修订再提交。",
      },
      {
        expectedPilotEvidenceRevision: taskFour.pilotEvidenceRevision,
        mutationId: "reflection-declined",
      },
    );
    await store.recordStageEvidence(
      "reflection-decline-learner",
      "practice_task_3",
      "exploration",
      "artifact_submitted",
    );
    await store.recordStageEvidence(
      "reflection-decline-learner",
      "practice_task_3",
      "articulation",
      "strategy_articulated",
    );
    const ended = await store.completeTask(
      "reflection-decline-learner",
      "practice_task_3",
      undefined,
      { endIncomplete: true },
    );
    const endedTask = ended.tasks.find((task) => task.taskId === "practice_task_3");
    expect(endedTask).toMatchObject({
      status: "completed",
      completionOutcome: "ended_incomplete",
    });
    expect(endedTask?.completionMissing).toContain("reflect_after_task_four");
    expect(endedTask?.reflectionReport).not.toBeNull();
    expect(endedTask?.reflectionReport?.expertStepIds).toEqual([
      "analyze_task",
      "set_learning_goals",
      "draft_prompt",
      "monitor_generation",
      "evaluate_and_revise",
    ]);
    expect(JSON.stringify(endedTask?.reflectionReport)).not.toContain(
      "先确定受众、目标和交付结构",
    );
    expect(endedTask?.pilotOutcomeAudit.at(-1)).toMatchObject({
      stage: "reflection",
      outcome: "declined",
      reasonLength: 14,
      attempt: 1,
      rawReasonIncluded: false,
    });
    expect(ended.events.some((event) =>
      event.event === "a4_reflection_report_generated"
      && event.detail.storage_scope === "learner_session_only"
    )).toBe(true);
    expect(ended.events.some((event) =>
      event.event === "pilot_outcome_recorded"
      && event.detail.storage_scope === "learner_session_only"
      && event.detail.raw_reason_included === false
    )).toBe(true);
    expect(endedTask?.supervisionSignals.at(-1)).toMatchObject({
      type: "reflection_missing",
      basis: "deterministic-rule",
      recommendedAction: "invite_reflection",
    });
    expect(ended.events.at(-1)?.detail).toMatchObject({
      completionOutcome: "ended_incomplete",
    });
  });

  it("allows Task 2 articulation refusal to end incomplete without fabricating evidence", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await completeTrainingTask(store, "articulation-decline-learner");
    await store.selectTask("articulation-decline-learner", "practice_task_1");
    const session = await store.getOrCreateSession("articulation-decline-learner");
    const task = session.tasks.find((candidate) => candidate.taskId === "practice_task_1");
    if (!task) throw new Error("Missing Task 2 refusal fixture.");
    await expect(store.savePilotEvidence("articulation-decline-learner", "practice_task_1", {
      articulationOutcome: "declined",
      articulationDeclineReason: "尚未完成其他练习证据。",
    }, {
      expectedPilotEvidenceRevision: task.pilotEvidenceRevision,
      mutationId: "task-two-premature-articulation-decline",
    })).resolves.toBeDefined();
    await expect(store.completeTask(
      "articulation-decline-learner",
      "practice_task_1",
      undefined,
      { endIncomplete: true },
    )).rejects.toMatchObject({
      completionMissing: expect.arrayContaining([
        "diagnose_original_prompt",
        "submit_revised_prompt",
        "evaluate_generated_outline",
      ]),
    });
    const afterPrematureDecline = await store.getOrCreateSession("articulation-decline-learner");
    const afterPrematureTask = afterPrematureDecline.tasks.find((candidate) =>
      candidate.taskId === "practice_task_1"
    );
    if (!afterPrematureTask) throw new Error("Missing premature-decline Task 2 fixture.");
    await store.savePilotEvidence("articulation-decline-learner", "practice_task_1", {
      diagnosisText: "原提示词缺少目标、范围和评价标准。",
      revisedPromptText: "请按目标、范围、结构和评价标准生成大纲。",
      outputEvaluationText: "生成结构基本可用，但证据边界仍需修订。",
      articulationText: "旧表达原文仍保留，但本次明确选择暂不提交。",
      articulationOutcome: "declined",
      articulationDeclineReason: "本次先跳过阐述，之后仍可补交。",
    }, {
      expectedPilotEvidenceRevision: afterPrematureTask.pilotEvidenceRevision,
      mutationId: "task-two-articulation-declined",
    });
    await store.recordStageEvidence(
      "articulation-decline-learner",
      "practice_task_1",
      "coaching_scaffolding",
      "guided_practice_completed",
    );

    const ended = await store.completeTask(
      "articulation-decline-learner",
      "practice_task_1",
      undefined,
      { endIncomplete: true },
    );
    expect(ended.activeTaskId).toBe("practice_task_3");
    expect(ended.tasks.find((candidate) => candidate.taskId === "practice_task_1"))
      .toMatchObject({
        status: "completed",
        completionOutcome: "ended_incomplete",
        completionMissing: ["articulate_task_two_process"],
      });
    expect(ended.tasks.find((candidate) => candidate.taskId === "practice_task_2")?.status)
      .toBe("locked");
    expect(ended.tasks.find((candidate) => candidate.taskId === "practice_task_3")?.status)
      .toBe("active");
    expect(ended.tasks.find((candidate) => candidate.taskId === "practice_task_1")
      ?.pilotOutcomeAudit.at(-1)).toMatchObject({
        stage: "articulation",
        outcome: "declined",
        attempt: 2,
        rawReasonIncluded: false,
      });

    const endedTask = ended.tasks.find((candidate) => candidate.taskId === "practice_task_1");
    if (!endedTask) throw new Error("Missing ended Task 2 fixture.");
    const continued = await store.savePilotEvidence(
      "articulation-decline-learner",
      "practice_task_1",
      {
        articulationText: "补交说明：我先诊断提示词，再修订条件，最后按标准评价输出。",
        articulationOutcome: "submitted",
      },
      {
        expectedPilotEvidenceRevision: endedTask.pilotEvidenceRevision,
        mutationId: "task-two-articulation-continued",
      },
    );
    expect(continued.tasks.find((candidate) => candidate.taskId === "practice_task_1"))
      .toMatchObject({
        status: "completed",
        completionOutcome: "ended_incomplete",
        completionMissing: ["articulate_task_two_process"],
      });
    const upgraded = await store.recordStageEvidence(
      "articulation-decline-learner",
      "practice_task_1",
      "articulation",
      "strategy_articulated",
    );
    expect(upgraded.tasks.find((candidate) => candidate.taskId === "practice_task_1"))
      .toMatchObject({
        status: "completed",
        completionOutcome: "evidence_complete",
        completionMissing: [],
      });
    expect(continued.tasks.find((candidate) => candidate.taskId === "practice_task_1")
      ?.pilotOutcomeAudit.at(-1)).toMatchObject({
        stage: "articulation",
        outcome: "submitted",
        attempt: 3,
      });
  });

  it("uses visible characters for the authoritative 800-character Task 4 gate", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await completeTrainingTask(store, "visible-character-gate");
    await store.selectTask("visible-character-gate", "practice_task_1");
    await completePilotTaskTwo(store, "visible-character-gate");
    const taskFour = (await store.getOrCreateSession("visible-character-gate")).tasks.find(
      (candidate) => candidate.taskId === "practice_task_3",
    );
    if (!taskFour) throw new Error("Missing Task 4 visible-character fixture.");
    await store.savePilotEvidence("visible-character-gate", "practice_task_3", {
      planningText: "先确定目标、受众与结构，然后分配证据。",
      monitoringText: "每段完成后检查目标、证据、结构和篇幅。",
      evaluationText: "依据准确性、相关性和结构完整性评价。",
      outputEvaluationText: "生成结果可用，但需要进一步核对证据边界。",
      articulationText: "我先规划，再监控，最后评价并修订结果。",
      reflectionText: "我需要把检查点前置，并保留每次修订依据。",
      expertComparisonText: "专家先分析目标再设检查点；我需要补足前置分析。",
      reflectionOutcome: "submitted",
    }, {
      expectedPilotEvidenceRevision: taskFour.pilotEvidenceRevision,
      mutationId: "visible-character-evidence",
    });
    const below = await store.saveArtifact(
      "visible-character-gate",
      "practice_task_3",
      `<p>${"字".repeat(799)}</p>${"<span></span>".repeat(500)}&nbsp;`,
    );
    expect(below.tasks.find((candidate) => candidate.taskId === "practice_task_3")
      ?.completionMissing).toEqual([
        "submit_guide_draft",
        "articulate_task_four_process",
        "reflect_after_task_four",
      ]);
    expect(below.tasks.find((candidate) => candidate.taskId === "practice_task_3")
      ?.reflectionReport).toBeNull();

    const atGate = await store.saveArtifact(
      "visible-character-gate",
      "practice_task_3",
      `<p>${"字".repeat(800)}</p>${"<span></span>".repeat(500)}&nbsp;`,
    );
    expect(atGate.tasks.find((candidate) => candidate.taskId === "practice_task_3")
      ?.completionMissing).toEqual([
        "submit_guide_draft",
        "articulate_task_four_process",
        "reflect_after_task_four",
      ]);
    expect(atGate.tasks.find((candidate) => candidate.taskId === "practice_task_3")
      ?.reflectionReport).not.toBeNull();
    await expect(store.completeTask("visible-character-gate", "practice_task_3"))
      .rejects.toMatchObject({
        completionMissing: [
          "submit_guide_draft",
          "articulate_task_four_process",
          "reflect_after_task_four",
        ],
      });
    const explored = await store.recordStageEvidence(
      "visible-character-gate",
      "practice_task_3",
      "exploration",
      "artifact_submitted",
    );
    expect(explored.tasks.find((candidate) => candidate.taskId === "practice_task_3")
      ?.completionMissing).toEqual(["articulate_task_four_process", "reflect_after_task_four"]);
    await store.recordStageEvidence(
      "visible-character-gate",
      "practice_task_3",
      "articulation",
      "strategy_articulated",
    );
    const reflected = await store.recordStageEvidence(
      "visible-character-gate",
      "practice_task_3",
      "reflection",
      "reflection_submitted",
    );
    expect(reflected.tasks.find((candidate) => candidate.taskId === "practice_task_3")
      ?.completionMissing).toEqual([]);
    await expect(store.recordStageEvidence(
      "visible-character-gate",
      "practice_task_3",
      "summary_completion",
      "summary_acknowledged",
    )).rejects.toMatchObject({ reason: "stage_evidence_invalid" });
    await store.completeTask("visible-character-gate", "practice_task_3");
    const summarized = await store.recordStageEvidence(
      "visible-character-gate",
      "practice_task_3",
      "summary_completion",
      "summary_acknowledged",
    );
    expect(summarized.tasks.find((candidate) => candidate.taskId === "practice_task_3"))
      .toMatchObject({
        pilotEvidence: { summaryAcknowledged: true },
      });
    expect(summarized.tasks.find((candidate) => candidate.taskId === "practice_task_3")
      ?.milestones.find((milestone) => milestone.id === "summary_completion"))
      .toMatchObject({ status: "completed", evidenceKinds: ["summary_acknowledged"] });
  });

  it("deduplicates same-type A3 signals with a transparent five-minute cooldown", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await store.saveArtifact("a3-cooldown-learner", "training_task_1", "短文");
    await store.saveArtifact("a3-cooldown-learner", "training_task_1", "短文");
    const repeated = await store.saveArtifact(
      "a3-cooldown-learner",
      "training_task_1",
      "短文",
    );
    const task = repeated.tasks.find((candidate) => candidate.taskId === "training_task_1");
    const signalTypes = task?.supervisionSignals.map((signal) => signal.type) ?? [];
    expect(signalTypes).toEqual(["goal_missing", "plan_missing", "no_progress"]);
    expect(task?.supervisionSignals.every((signal) =>
      signal.basis === "deterministic-rule"
      && signal.ruleVersion === "aais-metacognitive-signal-v1"
      && signal.cooldownSeconds === 300
      && !("confidence" in signal)
    )).toBe(true);
    expect(repeated.events.filter((event) =>
      event.event === "monitoring_pause_detected"
      && ["goal_missing", "plan_missing", "no_progress"].includes(String(event.detail.signal))
    )).toHaveLength(3);
    expect(JSON.stringify(task?.supervisionSignals)).not.toContain("短文");
  });

  it("normalizes a legacy file payload without a session id to one stable strong id", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await store.getOrCreateSession("legacy-session-student");
    const sessionPath = path.join(tempDir, "sessions", "legacy-session-student.json");
    const legacyPayload = JSON.parse(await readFile(sessionPath, "utf8")) as Record<string, unknown>;
    delete legacyPayload.sessionId;
    await writeFile(sessionPath, `${JSON.stringify(legacyPayload, null, 2)}\n`, "utf8");

    const firstRead = await createAaisLearningStore({ rootDir: tempDir })
      .readSession("legacy-session-student");
    const secondRead = await createAaisLearningStore({ rootDir: tempDir })
      .readSession("legacy-session-student");

    expect(firstRead?.sessionId).toMatch(/^session-[a-f0-9]{32}$/);
    expect(secondRead?.sessionId).toBe(firstRead?.sessionId);
  });

  it("normalizes legacy task text revisions to safe zero values", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await store.getOrCreateSession("legacy-revision-student");
    const sessionPath = path.join(tempDir, "sessions", "legacy-revision-student.json");
    const legacyPayload = JSON.parse(await readFile(sessionPath, "utf8")) as {
      tasks: Array<Record<string, unknown>>;
    };
    delete legacyPayload.tasks[0]?.artifactRevision;
    delete legacyPayload.tasks[0]?.selfReportRevision;
    await writeFile(sessionPath, `${JSON.stringify(legacyPayload, null, 2)}\n`, "utf8");

    const normalized = await createAaisLearningStore({ rootDir: tempDir })
      .readSession("legacy-revision-student");
    const dto = createAaisLearnerSessionApiDto(normalized!);

    expect(normalized?.tasks[0]).toMatchObject({
      artifactRevision: 0,
      selfReportRevision: 0,
    });
    expect(dto.tasks[0]).toMatchObject({
      artifactRevision: 0,
      selfReportRevision: 0,
    });
  });

  it("persists attachment receipts without extracted text or raw bytes", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await store.appendGuideExchange({
      studentId: "S001",
      phase: "training",
      taskId: "training_task_1",
      question: "请阅读论文",
      answer: "已阅读",
      attachments: [{
        name: "论文.docx",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 4_096,
        status: "read",
      }],
      orchestration: {
        graphId: "learning-ai-guide",
        topologicalOrder: ["A1"],
        threadId: "thread-attachment",
      },
    });

    const reloadedStore = createAaisLearningStore({ rootDir: tempDir });
    const reloaded = await reloadedStore.getOrCreateSession("S001");
    expect(reloaded.guideMessages[0]).toMatchObject({
      kind: "user",
      attachments: [{
        name: "论文.docx",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 4_096,
        status: "read",
      }],
    });
    expect(JSON.stringify(reloaded.guideMessages[0])).not.toContain("extractedText");

    const learnerExport = await reloadedStore.exportLearnerData("S001");
    expect(learnerExport.data.session?.guideMessages[0]?.attachments).toEqual([{
      name: "论文.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 4_096,
      status: "read",
    }]);
    expect(JSON.stringify(learnerExport)).not.toContain("extractedText");
  });

  it("assigns collision-resistant ids to same-millisecond guide messages and decisions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T05:00:00.000Z"));
    const store = createAaisLearningStore({ rootDir: tempDir });

    await store.appendGuideExchange({
      studentId: "guide-id-collision-audit",
      phase: "training",
      taskId: "training_task_1",
      question: "first",
      answer: "Aa",
      orchestration: { graphId: "g", topologicalOrder: ["A1"], threadId: "t1" },
    });
    const result = await store.appendGuideExchange({
      studentId: "guide-id-collision-audit",
      phase: "training",
      taskId: "training_task_1",
      question: "second",
      answer: "BB",
      orchestration: { graphId: "g", topologicalOrder: ["A1"], threadId: "t2" },
    });
    const assistantIds = result.session.guideMessages
      .filter((message) => message.kind === "assistant")
      .map((message) => message.id);
    expect(new Set(assistantIds).size).toBe(2);
    expect(result.exchange.assistantMessageId).toBe(assistantIds[1]);

    await store.recordAiAcceptance("guide-id-collision-audit", "training_task_1", {
      accepted: true,
      expectedPilotEvidenceRevision: 0,
      messageId: assistantIds[0],
      mutationId: "guide-collision-decision-1",
    });
    const decided = await store.recordAiAcceptance(
      "guide-id-collision-audit",
      "training_task_1",
      {
        accepted: true,
        expectedPilotEvidenceRevision: 1,
        messageId: assistantIds[1],
        mutationId: "guide-collision-decision-2",
      },
    );
    const decisions = decided.events.filter((event) => event.event === "ai_acceptance_recorded");
    expect(decisions).toHaveLength(2);
    expect(new Set(decisions.map((event) => event.detail.decision_key)).size).toBe(2);
  });

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

    await expect(store.selectTask("S001", "practice_task_2")).rejects.toMatchObject({
      reason: "task_pilot_closed",
    });

    await completeTrainingTask(store, "S001");
    const practiceOne = await store.selectTask("S001", "practice_task_1");
    expect(practiceOne.activeTaskId).toBe("practice_task_1");

    await expect(store.selectTask("S001", "practice_task_2")).rejects.toMatchObject({
      reason: "task_pilot_closed",
    });

    const practiceFour = await completePilotTaskTwo(store, "S001");
    expect(practiceFour.activeTaskId).toBe("practice_task_3");
    expect(practiceFour.tasks.find((task) => task.taskId === "practice_task_2")?.status)
      .toBe("locked");
    expect(practiceFour.tasks.find((task) => task.taskId === "practice_task_3"))
      .toMatchObject({ activeMilestone: "exploration" });
    expect(practiceFour.tasks.find((task) => task.taskId === "practice_task_3")?.milestones
      .find((milestone) => milestone.id === "exploration")).toMatchObject({
        status: "open",
        evidenceKinds: [],
      });
    expect(practiceFour.events.some((event) =>
      event.event === "stage_selected"
      && event.task === "practice_task_3"
      && event.detail.lifecycle === "stage_opened"
      && event.detail.milestoneId === "exploration"
      && event.detail.origin === "system_auto_progression"
    )).toBe(true);
    expect(practiceFour.events.some((event) =>
      event.event === "task_selected" && event.task === "practice_task_3"
    )).toBe(false);
  });

  it("keeps automatic Task 2 to Task 4 activation out of product events and LRS", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    await completeTrainingTask(store, "auto-advance-lrs-boundary");
    await store.selectTask("auto-advance-lrs-boundary", "practice_task_1");
    const completed = await completePilotTaskTwo(store, "auto-advance-lrs-boundary");
    expect(completed.activeTaskId).toBe("practice_task_3");
    expect(completed.events.some((event) =>
      event.event === "task_selected" && event.task === "practice_task_3"
    )).toBe(false);
    expect(completed.events.some((event) =>
      event.event === "stage_selected"
      && event.task === "practice_task_3"
      && event.detail.origin === "system_auto_progression"
    )).toBe(true);
    expect(database.eventRows.some((row) =>
      row.task === "practice_task_3"
      && (row.event === "task_selected" || row.event === "stage_selected")
    )).toBe(false);
    expect(database.outboxRows.some((row) =>
      row.payload.task === "practice_task_3"
      && (row.payload.event === "task_selected" || row.payload.event === "stage_selected")
    )).toBe(false);
  });

  it("rejects every learner mutation targeting a locked task", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await store.getOrCreateSession("S001");

    // A brand-new learner has only training_task_1 active; every practice task is
    // locked until its prerequisite is completed. None of these mutations may act on
    // a locked task, otherwise sequencing (and cohort analytics) can be bypassed.
    await expect(store.completeTask("S001", "practice_task_3")).rejects.toThrow(
      "Task practice_task_3 is locked",
    );
    await expect(store.saveArtifact("S001", "practice_task_3", "x")).rejects.toThrow(
      "Task practice_task_3 is locked",
    );
    await expect(store.saveSelfReport("S001", "practice_task_3", "x")).rejects.toThrow(
      "Task practice_task_3 is locked",
    );
    await expect(
      store.requestScaffold("S001", "practice_task_3", "stage-checklist"),
    ).rejects.toThrow("Task practice_task_3 is locked");
    await expect(
      store.recordAiAcceptance("S001", "practice_task_3", {
        accepted: true,
        expectedPilotEvidenceRevision: 0,
        messageId: "assistant-locked-task",
        mutationId: "locked-task-ai-acceptance",
      }),
    ).rejects.toThrow("Task practice_task_3 is locked");
    await expect(store.appendGuideExchange({
      studentId: "S001",
      phase: "training",
      taskId: "practice_task_3",
      question: "locked guide question",
      answer: "must not persist",
      orchestration: { graphId: "g", topologicalOrder: ["A1"], threadId: "t" },
    })).rejects.toThrow("Task practice_task_3 is locked");

    const session = await store.getOrCreateSession("S001");
    expect(session.tasks.find((task) => task.taskId === "practice_task_3")?.status).toBe(
      "locked",
    );
    expect(
      session.tasks.filter((task) => task.status === "completed"),
    ).toHaveLength(0);
  });

  it("rejects unknown stages and scaffold tools before creating learner state", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });

    await expect(store.selectStage("stage-invalid-learner", "totally-valid-looking-typo"))
      .rejects.toMatchObject({ reason: "stage_invalid" });
    await expect(store.requestScaffold(
      "tool-invalid-learner",
      "practice_task_1",
      "definitely-not-a-tool",
    )).rejects.toMatchObject({ reason: "scaffold_tool_invalid" });

    await expect(store.readSession("stage-invalid-learner")).resolves.toBeNull();
    await expect(store.readSession("tool-invalid-learner")).resolves.toBeNull();
  });

  it("completes only the active task and makes repeated completion idempotent", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await store.getOrCreateSession("completion-invariant-learner");

    const completedTraining = await completeTrainingTask(
      store,
      "completion-invariant-learner",
    );
    const eventCount = completedTraining.events.length;
    const repeated = await store.completeTask(
      "completion-invariant-learner",
      "training_task_1",
    );
    expect(repeated.events).toHaveLength(eventCount);
    expect(repeated.events.filter((event) => event.event === "task_completed")).toHaveLength(1);
    expect(repeated.events.filter((event) =>
      event.event === "task_released" && event.task === "practice_task_1"
    )).toHaveLength(1);

    await expect(store.completeTask(
      "completion-invariant-learner",
      "practice_task_1",
    )).rejects.toMatchObject({ reason: "task_not_active" });

    await store.selectTask("completion-invariant-learner", "practice_task_1");
    const completedPractice = await completePilotTaskTwo(
      store,
      "completion-invariant-learner",
    );
    const repeatedPractice = await store.completeTask(
      "completion-invariant-learner",
      "practice_task_1",
    );
    expect(repeatedPractice.events).toHaveLength(completedPractice.events.length);
    expect(repeatedPractice.events.filter((event) =>
      event.event === "task_completed" && event.task === "practice_task_1"
    )).toHaveLength(1);
  });

  it("persists artifacts, self reports, scaffold counts, and exportable events", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await completeTrainingTask(store, "S001");
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

  it("persists a bounded inline image in the document artifact without weakening other text limits", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    const inlineImageArtifact = `<p>图片记录</p><img alt="测试截图" src="data:image/png;base64,${"A".repeat(64_000)}">`;

    const saved = await store.saveArtifact("S001", "training_task_1", inlineImageArtifact);

    expect(saved.tasks[0]?.artifactText).toBe(inlineImageArtifact);
    await expect(
      store.saveArtifact("S001", "training_task_1", "x".repeat(2 * 1024 * 1024 + 1)),
    ).rejects.toThrow("AAIS artifactText is too large");
    await expect(
      store.saveSelfReport("S001", "training_task_1", "x".repeat(20_001)),
    ).rejects.toThrow("AAIS selfReport is too large");
  });

  it("returns bounded learner-session windows with explicit truncation metadata", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    const session = await store.getOrCreateSession("dto-window-learner");
    const eventTemplate = session.events[0];
    if (!eventTemplate) throw new Error("Missing learner event fixture.");
    session.events = Array.from(
      { length: aaisLearnerSessionApiWindowLimits.events + 7 },
      (_, index) => ({
        ...eventTemplate,
        detail: { ...eventTemplate.detail, window_index: index },
      }),
    );
    session.guideMessages = Array.from(
      { length: aaisLearnerSessionApiWindowLimits.guideMessages + 6 },
      (_, index) => ({
        id: `window-message-${index}`,
        kind: index % 2 === 0 ? "user" as const : "assistant" as const,
        text: `message-${index}`,
        time: "2026-08-20T00:00:00.000Z",
      }),
    );
    session.tasks[0]!.scaffoldHistory = Array.from(
      { length: aaisLearnerSessionApiWindowLimits.scaffoldHistoryPerTask + 3 },
      (_, index) => ({
        toolId: `tool-${index}`,
        mode: "self-check" as const,
        time: "2026-08-20T00:00:00.000Z",
        level: 1 as const,
        intensity: "prompt-question" as const,
        fading: true,
      }),
    );

    const dto = createAaisLearnerSessionApiDto(session);

    expect(dto.events).toHaveLength(aaisLearnerSessionApiWindowLimits.events);
    expect(dto.events[0]?.detail).toEqual({ schemaVersion: 1 });
    expect(dto.guideMessages).toHaveLength(aaisLearnerSessionApiWindowLimits.guideMessages);
    expect(dto.guideMessages[0]?.id).toBe("window-message-6");
    expect(dto.tasks[0]?.scaffoldHistory).toHaveLength(
      aaisLearnerSessionApiWindowLimits.scaffoldHistoryPerTask,
    );
    expect(dto.tasks[0]?.scaffoldHistory[0]?.toolId).toBe("tool-3");
    expect(dto.truncation).toMatchObject({
      events: { total: 107, returned: 100, omitted: 7, truncated: true },
      guideMessages: { total: 106, returned: 100, omitted: 6, truncated: true },
      scaffoldHistory: {
        total: 23,
        returned: 20,
        omitted: 3,
        truncated: true,
        limitPerTask: 20,
      },
    });
    expect(session.events).toHaveLength(107);
    expect(session.guideMessages).toHaveLength(106);
    expect(session.tasks[0]?.scaffoldHistory).toHaveLength(23);
  });

  it("fails persistence closed when the event array would exceed its explicit limit", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    const session = await store.getOrCreateSession("event-limit-learner");
    const event = session.events[0];
    if (!event) throw new Error("Missing learner event fixture.");
    database.seedSessionPayload("event-limit-learner", {
      ...session,
      events: Array.from(
        { length: aaisLearnerSessionPersistenceLimits.maxEvents },
        (_, index) => ({ ...event, detail: { ...event.detail, limit_index: index } }),
      ),
    });

    await expect(store.selectStage("event-limit-learner", "guide", 1)).rejects.toMatchObject({
      name: "AaisLearnerSessionLimitError",
      reason: "events_limit_reached",
    });
    expect(database.getSessionVersion("event-limit-learner")).toBe(0);
  });

  it("fails guide and scaffold growth closed at their explicit array limits", async () => {
    const guideDatabase = createFakeDatabaseClient();
    const guideStore = createAaisLearningStore({ database: guideDatabase });
    const guideSession = await guideStore.getOrCreateSession("guide-limit-learner");
    guideDatabase.seedSessionPayload("guide-limit-learner", {
      ...guideSession,
      guideMessages: Array.from(
        { length: aaisLearnerSessionPersistenceLimits.maxGuideMessages },
        (_, index) => ({
          id: `limit-message-${index}`,
          kind: "user" as const,
          text: "bounded",
          time: "2026-08-20T00:00:00.000Z",
        }),
      ),
    });
    await expect(guideStore.appendGuideExchange({
      studentId: "guide-limit-learner",
      phase: "training",
      taskId: "training_task_1",
      question: "must fail without trimming old evidence",
      answer: "must fail without trimming old evidence",
      dataGeneration: 1,
      orchestration: { graphId: "g", topologicalOrder: ["A1"], threadId: "limit" },
    })).rejects.toMatchObject({
      name: "AaisLearnerSessionLimitError",
      reason: "guide_messages_limit_reached",
    });

    const scaffoldDatabase = createFakeDatabaseClient();
    const scaffoldStore = createAaisLearningStore({ database: scaffoldDatabase });
    const scaffoldSession = await scaffoldStore.getOrCreateSession("scaffold-limit-learner");
    scaffoldDatabase.seedSessionPayload("scaffold-limit-learner", {
      ...scaffoldSession,
      activeTaskId: "practice_task_1",
      activeStage: "practice",
      tasks: scaffoldSession.tasks.map((task) => ({
        ...task,
        status: task.taskId === "practice_task_1" ? "active" as const : task.status,
        scaffoldHistory: task.taskId === "practice_task_1"
          ? Array.from(
              { length: aaisLearnerSessionPersistenceLimits.maxScaffoldHistoryEntries },
              (_, index) => ({
                toolId: `limit-tool-${index}`,
                mode: "self-check" as const,
                time: "2026-08-20T00:00:00.000Z",
              }),
            )
          : task.scaffoldHistory,
      })),
    });
    await expect(scaffoldStore.requestScaffold(
      "scaffold-limit-learner",
      "practice_task_1",
      "stage-checklist",
      1,
    )).rejects.toMatchObject({
      name: "AaisLearnerSessionLimitError",
      reason: "scaffold_history_limit_reached",
    });
  });

  it("rejects an oversized serialized session payload without overwriting it", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    const session = await store.getOrCreateSession("payload-limit-learner");
    database.seedSessionPayload("payload-limit-learner", {
      ...session,
      guideMessages: [{
        id: "oversized-existing-message",
        kind: "user",
        text: "x".repeat(aaisLearnerSessionPersistenceLimits.maxBytes),
        time: "2026-08-20T00:00:00.000Z",
      }],
    });

    await expect(store.selectStage("payload-limit-learner", "guide", 1)).rejects.toMatchObject({
      name: "AaisLearnerSessionLimitError",
      reason: "payload_too_large",
    });
    expect(database.getSessionVersion("payload-limit-learner")).toBe(0);
  });

  it("atomically grants only one concurrent reservation for the final guide exchange slots", async () => {
    const database = createFakeDatabaseClient();
    const setupStore = createAaisLearningStore({ database });
    const studentId = "guide-capacity-final-slot";
    const session = await setupStore.getOrCreateSession(studentId);
    const event = session.events[0];
    if (!event) throw new Error("Missing learner event fixture.");
    database.seedSessionPayload(studentId, {
      ...session,
      guideMessages: Array.from(
        { length: aaisLearnerSessionPersistenceLimits.maxGuideMessages - 2 },
        (_value, index) => ({
          id: `capacity-message-${index}`,
          kind: "user" as const,
          text: "bounded",
          time: "2026-08-20T00:00:00.000Z",
        }),
      ),
      events: Array.from(
        { length: aaisLearnerSessionPersistenceLimits.maxEvents - 2 },
        (_value, index) => ({
          ...event,
          detail: { ...event.detail, capacity_index: index },
        }),
      ),
    });
    const stores = [
      createAaisLearningStore({ database }),
      createAaisLearningStore({ database }),
    ];
    const results = await Promise.allSettled(stores.map((store, index) =>
      store.reserveGuideExchangeCapacity({
        studentId,
        reservationId: index === 0
          ? "11112222-3333-4444-8555-666677778888"
          : "99990000-aaaa-4bbb-8ccc-ddddeeeeffff",
        dataGeneration: 1,
      })
    ));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: {
        name: "AaisLearnerSessionLimitError",
        reason: "events_limit_reached",
      },
    });
    const persisted = await setupStore.readSession(studentId);
    expect(persisted?.guideCapacityReservations).toHaveLength(1);
    expect(createAaisLearnerSessionApiDto(persisted!)).not.toHaveProperty(
      "guideCapacityReservations",
    );
  });

  it("deduplicates an autosave retry with the same mutation id", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    const mutationId = "artifact-mutation-11111111-1111-4111-8111-111111111111";

    const first = await store.saveArtifact(
      "S001",
      "training_task_1",
      "response-lost retry content",
      { mutationId },
    );
    const eventRowsAfterFirstSave = structuredClone(database.eventRows);
    const outboxRowsAfterFirstSave = structuredClone(database.outboxRows);
    const mutationWritesAfterFirstSave = database.queries.filter((query) =>
      /^with session_insert as/i.test(query.sql.trim())
    ).length;

    const replay = await store.saveArtifact(
      "S001",
      "training_task_1",
      "response-lost retry content",
      { mutationId },
    );

    expect(replay.tasks[0]?.artifactText).toBe("response-lost retry content");
    expect(replay.events).toHaveLength(first.events.length);
    expect(database.eventRows).toEqual(eventRowsAfterFirstSave);
    expect(database.outboxRows).toEqual(outboxRowsAfterFirstSave);
    expect(database.queries.filter((query) =>
      /^with session_insert as/i.test(query.sql.trim())
    )).toHaveLength(mutationWritesAfterFirstSave);
  });

  it("rejects reuse of an autosave mutation id with different content", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    const mutationId = "artifact-mutation-22222222-2222-4222-8222-222222222222";
    await store.saveArtifact("S001", "training_task_1", "first content", { mutationId });

    await expect(
      store.saveArtifact("S001", "training_task_1", "different content", { mutationId }),
    ).rejects.toThrow("mutation id was reused with different content");

    const reloaded = await createAaisLearningStore({ database }).getOrCreateSession("S001");
    expect(reloaded.tasks[0]?.artifactText).toBe("first content");
  });

  it("rejects a caller-stale artifact save before writing events or outbox rows", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    const winner = await store.saveArtifact(
      "S001",
      "training_task_1",
      "newer tab B content",
      {
        expectedArtifactRevision: 0,
        mutationId: "artifact-revision-winner-b",
      },
    );
    const eventRows = structuredClone(database.eventRows);
    const outboxRows = structuredClone(database.outboxRows);

    await expect(store.saveArtifact(
      "S001",
      "training_task_1",
      "late tab A content",
      {
        expectedArtifactRevision: 0,
        mutationId: "artifact-revision-stale-a",
      },
    )).rejects.toMatchObject({
      name: "AaisLearnerTextRevisionConflictError",
      field: "artifact",
    });

    const reloaded = await store.readSession("S001");
    expect(winner.tasks[0]).toMatchObject({
      artifactText: "newer tab B content",
      artifactRevision: 1,
    });
    expect(reloaded?.tasks[0]).toMatchObject({
      artifactText: "newer tab B content",
      artifactRevision: 1,
    });
    expect(database.eventRows).toEqual(eventRows);
    expect(database.outboxRows).toEqual(outboxRows);
  });

  it("rejects a caller-stale archive without changing the winner working copy or history", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    await store.saveArtifact("S001", "training_task_1", "newer tab B working copy", {
      expectedArtifactRevision: 0,
      mutationId: "archive-revision-winner-b",
    });
    const eventRows = structuredClone(database.eventRows);
    const outboxRows = structuredClone(database.outboxRows);

    await expect(store.archiveArtifact("S001", "training_task_1", {
      expectedArtifactRevision: 0,
      mutationId: "archive-revision-stale-a",
      document: {
        id: "stale-tab-a-history",
        taskId: "training_task_1",
        title: "Stale archive",
        html: "late tab A content",
        savedAt: "2026-08-20T01:00:00.000Z",
      },
    })).rejects.toMatchObject({
      name: "AaisLearnerTextRevisionConflictError",
      field: "artifact",
    });

    const reloaded = await store.readSession("S001");
    expect(reloaded?.tasks[0]).toMatchObject({
      artifactText: "newer tab B working copy",
      artifactRevision: 1,
    });
    expect(reloaded?.historyDocuments).toEqual([]);
    expect(database.eventRows).toEqual(eventRows);
    expect(database.outboxRows).toEqual(outboxRows);
  });

  it("rejects a caller-stale self-report without replacing the winner", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    await store.saveSelfReport("S001", "training_task_1", "newer tab B reflection", {
      expectedSelfReportRevision: 0,
    });
    const eventRows = structuredClone(database.eventRows);
    const outboxRows = structuredClone(database.outboxRows);

    await expect(store.saveSelfReport(
      "S001",
      "training_task_1",
      "late tab A reflection",
      { expectedSelfReportRevision: 0 },
    )).rejects.toMatchObject({
      name: "AaisLearnerTextRevisionConflictError",
      field: "self_report",
    });

    const reloaded = await store.readSession("S001");
    expect(reloaded?.tasks[0]).toMatchObject({
      selfReport: "newer tab B reflection",
      selfReportRevision: 1,
    });
    expect(database.eventRows).toEqual(eventRows);
    expect(database.outboxRows).toEqual(outboxRows);
  });

  it("deduplicates a self-report response retry before checking its stale caller revision", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    const options = {
      expectedSelfReportRevision: 0,
      mutationId: "self-report-response-lost-retry",
    };
    const first = await store.saveSelfReport(
      "S001",
      "training_task_1",
      "persist this reflection exactly once",
      options,
    );
    const eventRows = structuredClone(database.eventRows);
    const outboxRows = structuredClone(database.outboxRows);

    const replay = await store.saveSelfReport(
      "S001",
      "training_task_1",
      "persist this reflection exactly once",
      options,
    );

    expect(first.tasks[0]?.selfReportRevision).toBe(1);
    expect(replay.tasks[0]).toMatchObject({
      selfReport: "persist this reflection exactly once",
      selfReportRevision: 1,
    });
    expect(replay.events).toHaveLength(first.events.length);
    expect(database.eventRows).toEqual(eventRows);
    expect(database.outboxRows).toEqual(outboxRows);
  });

  it("deduplicates an archive response retry before checking its stale caller revision", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    await store.saveArtifact("S001", "training_task_1", "archive exactly once", {
      expectedArtifactRevision: 0,
      mutationId: "archive-retry-working-copy",
    });
    const archiveInput = {
      expectedArtifactRevision: 1,
      mutationId: "archive-response-lost-retry",
      document: {
        id: "archive-response-lost-document",
        taskId: "training_task_1",
        title: "Archive exactly once",
        html: "archive exactly once",
        savedAt: "2026-08-20T02:00:00.000Z",
      },
    };
    const first = await store.archiveArtifact("S001", "training_task_1", archiveInput);
    const eventRows = structuredClone(database.eventRows);
    const outboxRows = structuredClone(database.outboxRows);
    const writes = database.queries.filter((query) =>
      /^with session_insert as/i.test(query.sql.trim())
    ).length;

    const replay = await store.archiveArtifact("S001", "training_task_1", archiveInput);

    expect(first.tasks[0]?.artifactRevision).toBe(2);
    expect(replay.tasks[0]?.artifactRevision).toBe(2);
    expect(replay.historyDocuments).toHaveLength(1);
    expect(replay.events).toHaveLength(first.events.length);
    expect(database.eventRows).toEqual(eventRows);
    expect(database.outboxRows).toEqual(outboxRows);
    expect(database.queries.filter((query) =>
      /^with session_insert as/i.test(query.sql.trim())
    )).toHaveLength(writes);
  });

  it("persists working document title and history identity with the artifact", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    await store.archiveArtifact("S001", "training_task_1", {
      document: {
        id: "history-document-1",
        taskId: "training_task_1",
        title: "Original title",
        html: "original historical content",
        savedAt: "2026-08-19T07:00:00.000Z",
      },
    });

    await store.saveArtifact(
      "S001",
      "training_task_1",
      "edited historical content",
      {
        activeDocumentId: "history-document-1",
        documentTitle: "Persistent working title",
        mutationId: "artifact-mutation-33333333-3333-4333-8333-333333333333",
      },
    );

    const reloaded = await createAaisLearningStore({ database }).getOrCreateSession("S001");
    expect(reloaded.tasks[0]).toMatchObject({
      artifactText: "edited historical content",
      documentTitle: "Persistent working title",
      activeDocumentId: "history-document-1",
    });
  });

  it("archives a rich document durably before atomically clearing its working copy", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    const richDocumentHtml = `<h1>学习计划</h1><p><strong>重点记录</strong></p><img alt="测试截图" src="data:image/png;base64,${"A".repeat(64_000)}">`;
    await store.saveArtifact("S001", "training_task_1", richDocumentHtml);

    const archived = await store.archiveArtifact("S001", "training_task_1", {
      document: {
        id: "training_task_1-archive-1",
        taskId: "training_task_1",
        title: "学习计划",
        html: richDocumentHtml,
        savedAt: "2026-08-07T08:00:00.000Z",
      },
    });

    expect(archived.tasks[0]?.artifactText).toBe("");
    expect(archived.historyDocuments).toEqual([{
      id: "training_task_1-archive-1",
      taskId: "training_task_1",
      title: "学习计划",
      html: richDocumentHtml,
      savedAt: "2026-08-07T08:00:00.000Z",
    }]);

    const reloaded = await createAaisLearningStore({ rootDir: tempDir })
      .getOrCreateSession("S001");
    expect(reloaded.tasks[0]?.artifactText).toBe("");
    expect(reloaded.historyDocuments[0]).toMatchObject({
      id: "training_task_1-archive-1",
      title: "学习计划",
      html: richDocumentHtml,
    });

    const renamed = await createAaisLearningStore({ rootDir: tempDir }).archiveArtifact(
      "S001",
      "training_task_1",
      {
        activeDocumentId: "training_task_1-archive-1",
        document: {
          id: "training_task_1-replacement-id",
          taskId: "training_task_1",
          title: "最终学习计划",
          html: richDocumentHtml,
          savedAt: "2026-08-07T09:00:00.000Z",
        },
      },
    );
    expect(renamed.historyDocuments).toHaveLength(1);
    expect(renamed.historyDocuments[0]).toMatchObject({
      id: "training_task_1-archive-1",
      title: "最终学习计划",
      savedAt: "2026-08-07T09:00:00.000Z",
    });
  });

  it("never clears a working copy unless its durable history document is valid", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await store.saveArtifact("S001", "training_task_1", "must remain durable");

    await expect(
      store.archiveArtifact("S001", "training_task_1", {}),
    ).rejects.toThrow("cannot clear a working artifact without a durable history document");
    await expect(
      store.archiveArtifact("S001", "training_task_1", { document: null }),
    ).rejects.toThrow("cannot clear a working artifact without a durable history document");
    await expect(store.archiveArtifact("S001", "training_task_1", {
      activeDocumentId: "missing-history-document",
      document: {
        id: "new-history-document",
        taskId: "training_task_1",
        title: "must not be created",
        html: "must not replace the working copy",
        savedAt: "2026-08-07T08:00:00.000Z",
      },
    })).rejects.toThrow("AAIS history document was not found");

    const reloaded = await createAaisLearningStore({ rootDir: tempDir })
      .getOrCreateSession("S001");
    expect(reloaded.tasks[0]?.artifactText).toBe("must remain durable");
    expect(reloaded.historyDocuments).toEqual([]);

    const emptySession = await store.archiveArtifact("S002", "training_task_1", {
      document: null,
    });
    expect(emptySession.tasks[0]?.artifactText).toBe("");
    expect(emptySession.historyDocuments).toEqual([]);
  });

  it("rejects cross-task history document replacement without changing either task", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await store.saveArtifact("S001", "training_task_1", "task-A-working-copy");
    await store.archiveArtifact("S001", "training_task_1", {
      document: {
        id: "doc-task-a",
        taskId: "training_task_1",
        title: "Task A",
        html: "task-A-archive",
        savedAt: "2026-08-07T08:00:00.000Z",
      },
    });
    await completeTrainingTask(store, "S001");
    await store.selectTask("S001", "practice_task_1");
    await store.saveArtifact("S001", "practice_task_1", "task-B-working-copy");

    await expect(store.saveArtifact(
      "S001",
      "practice_task_1",
      "must-not-overwrite-task-a",
      { activeDocumentId: "doc-task-a" },
    )).rejects.toMatchObject({
      name: "AaisLearnerMutationError",
      reason: "history_task_mismatch",
    });

    await expect(store.archiveArtifact("S001", "practice_task_1", {
      activeDocumentId: "doc-task-a",
      document: {
        id: "doc-task-b",
        taskId: "practice_task_1",
        title: "Task B",
        html: "task-B-overwrite",
        savedAt: "2026-08-07T09:00:00.000Z",
      },
    })).rejects.toThrow("AAIS history document task does not match the active task");

    const reloaded = await createAaisLearningStore({ rootDir: tempDir })
      .getOrCreateSession("S001");
    expect(reloaded.historyDocuments).toEqual([{
      id: "doc-task-a",
      taskId: "training_task_1",
      title: "Task A",
      html: "task-A-archive",
      savedAt: "2026-08-07T08:00:00.000Z",
    }]);
    expect(reloaded.tasks.find((task) => task.taskId === "practice_task_1")?.artifactText)
      .toBe("task-B-working-copy");
  });

  it("never clears the working copy when durable document archiving is rejected", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    const workingCopy = "<p>归档失败时必须保留</p>";
    await store.saveArtifact("S001", "training_task_1", workingCopy);

    await expect(store.archiveArtifact("S001", "training_task_1", {
      document: {
        id: "training_task_1-invalid-archive",
        taskId: "training_task_1",
        title: "x".repeat(201),
        html: workingCopy,
        savedAt: "2026-08-07T08:00:00.000Z",
      },
    })).rejects.toThrow("AAIS document title is too large");

    const reloaded = await createAaisLearningStore({ rootDir: tempDir })
      .getOrCreateSession("S001");
    expect(reloaded.tasks[0]?.artifactText).toBe(workingCopy);
    expect(reloaded.historyDocuments).toEqual([]);
  });

  it("deletes only restricted research raw text while preserving unrelated learner history", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await store.saveArtifact("S001", "training_task_1", "研究作品原文");
    await store.archiveArtifact("S001", "training_task_1", {
      document: {
        id: "training_task_1-research-archive",
        taskId: "training_task_1",
        title: "研究归档",
        html: "研究作品原文",
        savedAt: "2026-08-07T08:00:00.000Z",
      },
    });
    await store.saveSelfReport("S001", "training_task_1", "研究自我报告原文");
    await store.appendGuideExchange({
      studentId: "S001",
      phase: "training",
      taskId: "training_task_1",
      question: "研究 AI 提问原文",
      answer: "研究 AI 回答原文",
      attachments: [{
        name: "研究原始文件名.docx",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 5_120,
        status: "read",
      }],
      turns: [{
        agentId: "A1",
        label: "导学智能体",
        content: "研究 AI 分步回答原文",
        actions: ["研究 AI 建议原文"],
        visualizations: [{
          id: "quadratic-research",
          type: "quadratic-function",
          expression: "y = 2x² + 3x + 4",
          coefficients: { a: 2, b: 3, c: 4 },
          domain: { xMin: -5, xMax: 4 },
          vertex: { x: -0.75, y: 2.875 },
          axisX: -0.75,
          yIntercept: 4,
        }],
      }],
      orchestration: {
        graphId: "learning-ai-guide",
        topologicalOrder: ["A1"],
        threadId: "thread-1",
      },
    });
    const before = await store.getOrCreateSession("S001");
    const eventFacts = before.events.map((event) => JSON.stringify(event));
    const taskStatuses = before.tasks.map((task) => [task.taskId, task.status]);

    await expect(store.deleteRestrictedResearchRawText("S001")).resolves.toMatchObject({
      studentId: "S001",
      storageMode: "file",
      learnerRecordFound: true,
      rawTextDeleted: true,
      unrelatedProductHistoryPreserved: true,
      secrets: "redacted",
    });

    const reloaded = await createAaisLearningStore({ rootDir: tempDir })
      .getOrCreateSession("S001");
    expect(reloaded.tasks.every((task) =>
      task.artifactText === "" && task.selfReport === ""
    )).toBe(true);
    expect(reloaded.historyDocuments).toEqual([]);
    expect(reloaded.guideMessages.every((message) => message.text === "")).toBe(true);
    expect(reloaded.guideMessages.flatMap((message) => message.turns ?? []).every((turn) =>
      turn.content === "" && turn.actions.length === 0 && !turn.visualizations
    )).toBe(true);
    expect(reloaded.events.map((event) => JSON.stringify(event))).toEqual(eventFacts);
    expect(reloaded.tasks.map((task) => [task.taskId, task.status])).toEqual(taskStatuses);
    expect(reloaded.guideMessages.map((message) => [message.id, message.kind, message.time]))
      .toEqual(before.guideMessages.map((message) => [message.id, message.kind, message.time]));
    expect(JSON.stringify(reloaded)).not.toContain("研究作品原文");
    expect(JSON.stringify(reloaded)).not.toContain("研究自我报告原文");
    expect(JSON.stringify(reloaded)).not.toContain("研究 AI 提问原文");
    expect(JSON.stringify(reloaded)).not.toContain("研究 AI 回答原文");
    expect(JSON.stringify(reloaded)).not.toContain("研究原始文件名.docx");
    expect(JSON.stringify(reloaded)).not.toContain("quadratic-research");
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
    ).toEqual(expect.arrayContaining(["AAIS session_created", "AAIS artifact_saved"]));
    expect(postedBodies.flat().map((statement: { object: { definition: { name: { "en-US": string } } } }) =>
      statement.object.definition.name["en-US"]
    )).not.toContain("AAIS task_released");
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
    await completeTrainingTask(store, "S001");
    await store.selectTask("S001", "practice_task_1");
    await store.saveArtifact("S001", "practice_task_1", "我的计划是先复述任务，再检查证据。");
    await store.saveSelfReport("S001", "practice_task_1", "我和专家相比，先列失败条件做得不够。");
    await completePilotTaskTwo(store, "S001");
    const taskFourSession = await store.getOrCreateSession("S001");
    const taskFour = taskFourSession.tasks.find((task) => task.taskId === "practice_task_3");
    if (!taskFour) throw new Error("Missing Task 4 analytics fixture.");
    await store.saveArtifact("S001", "practice_task_3", "稿".repeat(800));
    await store.savePilotEvidence("S001", "practice_task_3", {
      planningText: "先确定受众、目标和结构，再安排各部分证据。",
      monitoringText: "每完成一段就检查目标、证据、结构和篇幅。",
      evaluationText: "依据准确性、相关性和结构完整性进行评价。",
      outputEvaluationText: "生成结果结构可用，但论据范围需要进一步核对。",
      articulationText: "我先规划，再监控，最后评价并修订生成结果。",
    }, {
      expectedPilotEvidenceRevision: taskFour.pilotEvidenceRevision,
      mutationId: "analytics-a4-report",
    });
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
          activePracticeTaskId: "practice_task_3",
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
    expect(database.queries.some((query) => /create table if not exists|alter table/i.test(query.sql))).toBe(false);
    expect(database.queries.some((query) => /insert into aais_learner_sessions/i.test(query.sql))).toBe(true);
    expect(database.queries.some((query) => /insert into aais_learner_task_state/i.test(query.sql))).toBe(true);
    expect(database.queries.some((query) => /insert into aais_events/i.test(query.sql))).toBe(true);
    expect(database.queries.some((query) => /select session\.payload/i.test(query.sql))).toBe(true);
    expect(database.eventRows.map((row) => row.event)).toEqual(
      expect.arrayContaining(["session_created", "artifact_saved"]),
    );
    expect(database.taskStateRows.find((row) => row.task === "training_task_1")).toMatchObject({
      student_id: "S001",
      session_id: session.sessionId,
      phase: "training",
      status: "active",
      artifact_characters: 8,
      self_report_characters: 0,
    });
    expect(JSON.stringify(database.eventRows)).not.toContain("数据库持久化记录");
    expect(JSON.stringify(database.taskStateRows)).not.toContain("数据库持久化记录");
  });

  it.each(["session", "task", "event", "outbox"] as const)(
    "rolls back the complete learner mutation when the %s stage fails",
    async (stage) => {
      const database = createFakeDatabaseClient();
      const store = createAaisLearningStore({ database });
      await store.getOrCreateSession("S001");
      const baselineSession = JSON.parse(JSON.stringify(
        await createAaisLearningStore({ database }).getOrCreateSession("S001"),
      ));
      const baselineTaskRows = structuredClone(database.taskStateRows);
      const baselineEventRows = structuredClone(database.eventRows);
      const baselineOutboxRows = structuredClone(database.outboxRows);

      database.failNextAtomicWriteAt(stage);

      await expect(
        store.saveArtifact("S001", "training_task_1", `must roll back at ${stage}`),
      ).rejects.toThrow(`Injected atomic learner mutation failure at ${stage}`);

      const reloaded = await createAaisLearningStore({ database }).getOrCreateSession("S001");
      expect(JSON.parse(JSON.stringify(reloaded))).toEqual(baselineSession);
      expect(database.taskStateRows).toEqual(baselineTaskRows);
      expect(database.eventRows).toEqual(baselineEventRows);
      expect(database.outboxRows).toEqual(baselineOutboxRows);
    },
  );

  it("deletes all Postgres learner data in one scoped atomic statement", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    await store.saveArtifact("S001", "training_task_1", "delete this learner");
    await store.saveArtifact("S002", "training_task_1", "preserve this learner");
    await store.reserveDailyGuideRequest({ studentId: "S001", limit: 5 });

    const deletion = await store.deleteLearnerData("S001");

    expect(deletion).toMatchObject({
      storageMode: "postgres",
      learnerRecordDeleted: true,
      mirroredAnalyticsDeleted: true,
      persistentOutboxDeleted: true,
      nextGeneration: 2,
    });
    expect(database.hasSession("S001")).toBe(false);
    expect(database.hasSession("S002")).toBe(true);
    expect(database.taskStateRows.every((row) => row.student_id === "S002")).toBe(true);
    expect(database.eventRows.every((row) => row.student_id === "S002")).toBe(true);
    expect(database.outboxRows.every((row) => row.payload.student_id === "S002")).toBe(true);
    expect(database.queries.filter((query) =>
      /^select \*\s+from public\.aais_delete_learner_data/i.test(query.sql.trim())
    )).toHaveLength(1);
    expect(database.queries.some((query) => /^delete from /i.test(query.sql.trim()))).toBe(false);
  });

  it("fails privacy deletion closed when the atomic database function is not migrated", async () => {
    const baseDatabase = createFakeDatabaseClient();
    const store = createAaisLearningStore({
      database: {
        ...baseDatabase,
        async query(sql: string, params: unknown[] = []) {
          if (/^select \*\s+from public\.aais_delete_learner_data/i.test(sql.trim())) {
            throw Object.assign(new Error("function does not exist"), { code: "42883" });
          }
          return baseDatabase.query(sql, params);
        },
      },
    });
    await store.getOrCreateSession("S001");

    await expect(store.deleteLearnerData("S001", 1))
      .rejects.toBeInstanceOf(AaisLearningStorageConfigurationError);
    expect(baseDatabase.hasSession("S001")).toBe(true);
  });

  it("fences an autosave CAS retry when privacy deletion wins before the retry", async () => {
    const baseDatabase = createFakeDatabaseClient();
    const setupStore = createAaisLearningStore({ database: baseDatabase });
    const initial = await setupStore.getOrCreateSession("S001");
    expect(initial.dataGeneration).toBe(1);

    let failFirstAtomicWrite = true;
    let retryReadPaused = false;
    let releaseRetry!: () => void;
    let signalRetryReached!: () => void;
    const retryReached = new Promise<void>((resolve) => {
      signalRetryReached = resolve;
    });
    const retryRelease = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const database = {
      ...baseDatabase,
      async query(sql: string, params: unknown[] = []) {
        if (
          failFirstAtomicWrite
          && /^with generation_guard as materialized \([\s\S]*session_insert as/i.test(sql.trim())
        ) {
          failFirstAtomicWrite = false;
          return { rows: [] };
        }
        if (
          !failFirstAtomicWrite
          && !retryReadPaused
          && /^select session\.payload/i.test(sql.trim())
        ) {
          retryReadPaused = true;
          signalRetryReached();
          await retryRelease;
        }
        return baseDatabase.query(sql, params);
      },
    } as AaisDatabaseClient;
    const autosaveStore = createAaisLearningStore({ database });
    const privacyStore = createAaisLearningStore({ database });

    const pendingAutosave = autosaveStore.saveArtifact(
      "S001",
      "training_task_1",
      "must never return after deletion",
      {
        dataGeneration: 1,
        mutationId: "autosave-delete-race-11111111-1111-4111-8111-111111111111",
      },
    );
    await retryReached;
    await expect(privacyStore.deleteLearnerData("S001", 1)).resolves.toMatchObject({
      nextGeneration: 2,
    });
    releaseRetry();

    await expect(pendingAutosave).rejects.toMatchObject({
      name: "AaisLearnerDataGenerationConflictError",
    });
    await expect(privacyStore.exportLearnerData("S001")).resolves.toMatchObject({
      data: { session: null, events: [] },
    });

    await expect(autosaveStore.saveArtifact(
      "S001",
      "training_task_1",
      "new-generation content",
      { dataGeneration: 2 },
    )).resolves.toMatchObject({
      dataGeneration: 2,
    });
  });

  it.each([
    ["missing", undefined],
    ["stale", 1],
  ])("fails closed on a %s payload generation under a generation-2 tombstone", async (
    _label,
    injectedGeneration,
  ) => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    const generationOne = await store.getOrCreateSession("S001", 1);
    await store.deleteLearnerData("S001", 1);
    const injectedPayload = structuredClone(generationOne) as Record<string, unknown>;
    if (injectedGeneration === undefined) {
      delete injectedPayload.dataGeneration;
    } else {
      injectedPayload.dataGeneration = injectedGeneration;
    }
    database.seedSessionPayload("S001", injectedPayload);

    await expect(store.exportLearnerData("S001")).rejects.toMatchObject({
      name: "AaisLearnerDataIntegrityError",
    });
    await expect(store.saveArtifact(
      "S001",
      "training_task_1",
      "must not bless an injected payload",
      { dataGeneration: 2 },
    )).rejects.toMatchObject({
      name: "AaisLearnerDataIntegrityError",
    });
    await expect(store.deleteLearnerData("S001", 2)).resolves.toMatchObject({
      learnerRecordDeleted: true,
      nextGeneration: 3,
    });
    expect(database.hasSession("S001")).toBe(false);
  });

  it("fails closed when a cohort scan encounters a session orphaned from generation state", async () => {
    const database = createFakeDatabaseClient();
    database.seedEnrollment({
      user_id: "teacher-1",
      course_id: "course-a",
      cohort: "alpha",
      role: "teacher",
      status: "active",
    });
    database.seedEnrollment({
      user_id: "S001",
      course_id: "course-a",
      cohort: "alpha",
      role: "student",
      status: "active",
    });
    const store = createAaisLearningStore({ database });
    const seededSession = await store.getOrCreateSession("S001", 1);
    const analyticsKeys = summarizeAaisCohortAnalytics([seededSession]).learners[0]!;
    database.deleteLearnerDataGeneration("S001");

    await expect(store.recordRecommendationOverride({
      actorId: "teacher-1",
      actorRole: "teacher",
      learnerKey: analyticsKeys.learnerKey,
      sessionKey: analyticsKeys.sessionKey,
      recommendationId: "recommendation-orphan-check",
      ruleId: "rule-orphan-check",
      targetTaskId: null,
      decision: "dismissed",
    })).rejects.toMatchObject({
      name: "AaisLearnerDataIntegrityError",
    });
  });

  it("keeps stale archive and AI writes behind the file tombstone without resetting quota", async () => {
    const staleStore = createAaisLearningStore({ rootDir: tempDir });
    const privacyStore = createAaisLearningStore({ rootDir: tempDir });
    await staleStore.getOrCreateSession("S001", 1);
    const oldReservation = await staleStore.reserveDailyGuideRequest({
      studentId: "S001",
      limit: 1,
      dataGeneration: 1,
    });
    expect(oldReservation.status).toBe("reserved");

    await expect(privacyStore.deleteLearnerData("S001", 1)).resolves.toMatchObject({
      nextGeneration: 2,
    });
    await expect(staleStore.archiveArtifact("S001", "training_task_1", {
      dataGeneration: 1,
      document: {
        id: "stale-archive-after-delete",
        taskId: "training_task_1",
        title: "stale archive",
        html: "must never return",
        savedAt: "2026-08-19T08:00:00.000Z",
      },
    })).rejects.toMatchObject({ name: "AaisLearnerDataGenerationConflictError" });
    await expect(staleStore.appendGuideExchange({
      studentId: "S001",
      phase: "training",
      taskId: "training_task_1",
      question: "stale question",
      answer: "stale answer",
      budgetReservationId: oldReservation.reservationId ?? undefined,
      dataGeneration: 1,
      orchestration: { graphId: "g", topologicalOrder: ["A1"], threadId: "stale" },
    })).rejects.toMatchObject({ name: "AaisLearnerDataGenerationConflictError" });
    await expect(staleStore.finalizeDailyGuideRequest({
      reservationId: oldReservation.reservationId ?? "missing",
      studentId: "S001",
      outcome: "released",
      dataGeneration: 1,
    })).rejects.toMatchObject({ name: "AaisLearnerDataGenerationConflictError" });
    await expect(privacyStore.exportLearnerData("S001")).resolves.toMatchObject({
      data: { session: null, events: [] },
    });

    const nextReservation = await staleStore.reserveDailyGuideRequest({
      studentId: "S001",
      limit: 1,
      dataGeneration: 2,
    });
    expect(nextReservation).toMatchObject({ status: "exhausted", used: 1 });
  });

  it("never resurrects a file session when atomic rename races privacy deletion", async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const studentId = `rename-race-${String(attempt).padStart(2, "0")}`;
      const writer = createAaisLearningStore({ rootDir: tempDir });
      const deleter = createAaisLearningStore({ rootDir: tempDir });
      await writer.getOrCreateSession(studentId, 1);

      const [writeResult, deletionResult] = await Promise.allSettled([
        writer.saveArtifact(studentId, "training_task_1", `stale-${attempt}`, {
          dataGeneration: 1,
        }),
        deleter.deleteLearnerData(studentId, 1),
      ]);

      expect(deletionResult.status).toBe("fulfilled");
      if (writeResult.status === "rejected") {
        expect(writeResult.reason).toMatchObject({
          name: "AaisLearnerDataGenerationConflictError",
        });
      }
      await expect(deleter.exportLearnerData(studentId)).resolves.toMatchObject({
        data: { session: null, events: [] },
      });
    }
  });

  it("counts database daily guide usage from append-only event rows", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });

    await store.appendGuideExchange({
      studentId: "S001",
      phase: "training",
      taskId: "training_task_1",
      question: "今天第一次导学请求",
      answer: "导学回复",
      orchestration: {
        graphId: "learning-ai-guide",
        topologicalOrder: ["A1", "A2", "A3", "A4"],
        threadId: "thread-1",
      },
    });
    const usage = await store.getDailyGuideUsage("S001");

    expect(usage.used).toBe(1);
    expect(database.queries.some((query) =>
      /^select count\(\*\)::int as count\s+from aais_events/i.test(query.sql.trim())
    )).toBe(true);
    expect(JSON.stringify(database.eventRows)).not.toContain("今天第一次导学请求");
    expect(JSON.stringify(database.taskStateRows)).not.toContain("今天第一次导学请求");
  });

  it("checks migrated table presence without creating runtime database schema", async () => {
    const migratedDatabase = createProbeDatabaseClient({
      learnerSessionsTable: true,
      learnerTaskStateTable: true,
      lrsOutboxTable: true,
      loginRateLimitsTable: true,
      eventsTable: true,
      usersTable: true,
      userAuthTokensTable: true,
      sessionRevocationsTable: true,
    });
    const missingRateLimitDatabase = createProbeDatabaseClient({
      learnerSessionsTable: true,
      learnerTaskStateTable: true,
      lrsOutboxTable: true,
      loginRateLimitsTable: false,
      eventsTable: true,
      usersTable: true,
      userAuthTokensTable: true,
      sessionRevocationsTable: true,
    });
    const missingRateLimitRetentionDatabase = createProbeDatabaseClient({
      learnerSessionsTable: true,
      learnerTaskStateTable: true,
      lrsOutboxTable: true,
      loginRateLimitsTable: true,
      loginRateLimitsRetention: false,
      eventsTable: true,
      usersTable: true,
      userAuthTokensTable: true,
      sessionRevocationsTable: true,
    });
    const missingGuideLeaseColumnDatabase = createProbeDatabaseClient({
      learnerSessionsTable: true,
      learnerTaskStateTable: true,
      lrsOutboxTable: true,
      loginRateLimitsTable: true,
      eventsTable: true,
      aiGuideReservationLeaseColumn: false,
      usersTable: true,
      userAuthTokensTable: true,
      sessionRevocationsTable: true,
    });
    const missingGuideReservationFunctionDatabase = createProbeDatabaseClient({
      learnerSessionsTable: true,
      learnerTaskStateTable: true,
      lrsOutboxTable: true,
      loginRateLimitsTable: true,
      eventsTable: true,
      aiGuideReservationFunction: false,
      usersTable: true,
      userAuthTokensTable: true,
      sessionRevocationsTable: true,
    });
    const missingGuideDispatchConstraintDatabase = createProbeDatabaseClient({
      learnerSessionsTable: true,
      learnerTaskStateTable: true,
      lrsOutboxTable: true,
      loginRateLimitsTable: true,
      eventsTable: true,
      aiGuideDispatchConstraints: false,
      usersTable: true,
      userAuthTokensTable: true,
      sessionRevocationsTable: true,
    });
    const missingLearnerDeleteFunctionDatabase = createProbeDatabaseClient({
      learnerSessionsTable: true,
      learnerTaskStateTable: true,
      lrsOutboxTable: true,
      loginRateLimitsTable: true,
      eventsTable: true,
      learnerDataDeleteFunction: false,
      usersTable: true,
      userAuthTokensTable: true,
      sessionRevocationsTable: true,
    });
    const incompatibleGenerationDatabase = createProbeDatabaseClient({
      learnerSessionsTable: true,
      learnerDataGenerationsTable: true,
      learnerSessionGenerationCompatible: false,
      learnerTaskStateTable: true,
      lrsOutboxTable: true,
      loginRateLimitsTable: true,
      eventsTable: true,
      usersTable: true,
      userAuthTokensTable: true,
      sessionRevocationsTable: true,
    });
    const missingLearnerDeliveryFenceDatabase = createProbeDatabaseClient({
      learnerSessionsTable: true,
      learnerDeliveryFenceColumns: false,
      learnerTaskStateTable: true,
      lrsOutboxTable: true,
      loginRateLimitsTable: true,
      eventsTable: true,
      usersTable: true,
      userAuthTokensTable: true,
      sessionRevocationsTable: true,
    });
    const missingOutboxClaimColumnsDatabase = createProbeDatabaseClient({
      learnerSessionsTable: true,
      learnerTaskStateTable: true,
      lrsOutboxTable: true,
      lrsOutboxClaimColumns: false,
      loginRateLimitsTable: true,
      eventsTable: true,
      usersTable: true,
      userAuthTokensTable: true,
      sessionRevocationsTable: true,
    });
    const missingLrsDeliveryReconciliationDatabase = createProbeDatabaseClient({
      learnerSessionsTable: true,
      learnerTaskStateTable: true,
      lrsOutboxTable: true,
      lrsDeliveryReconciliation: false,
      loginRateLimitsTable: true,
      eventsTable: true,
      usersTable: true,
      userAuthTokensTable: true,
      sessionRevocationsTable: true,
    });
    const inconsistentLrsDeliveryAttemptDatabase = createProbeDatabaseClient({
      learnerSessionsTable: true,
      learnerTaskStateTable: true,
      lrsOutboxTable: true,
      lrsDeliveryAttemptsConsistent: false,
      loginRateLimitsTable: true,
      eventsTable: true,
      usersTable: true,
      userAuthTokensTable: true,
      sessionRevocationsTable: true,
    });
    const staleLrsDeliveryAttemptDatabase = createProbeDatabaseClient({
      learnerSessionsTable: true,
      learnerTaskStateTable: true,
      lrsOutboxTable: true,
      staleLrsDeliveryAttempt: true,
      loginRateLimitsTable: true,
      eventsTable: true,
      usersTable: true,
      userAuthTokensTable: true,
      sessionRevocationsTable: true,
    });
    const missingEventsDatabase = createProbeDatabaseClient({
      learnerSessionsTable: true,
      learnerTaskStateTable: true,
      lrsOutboxTable: true,
      loginRateLimitsTable: true,
      eventsTable: false,
      usersTable: true,
      userAuthTokensTable: true,
      sessionRevocationsTable: true,
    });
    const missingTaskStateDatabase = createProbeDatabaseClient({
      learnerSessionsTable: true,
      learnerTaskStateTable: false,
      lrsOutboxTable: true,
      loginRateLimitsTable: true,
      eventsTable: true,
      usersTable: true,
      userAuthTokensTable: true,
      sessionRevocationsTable: true,
    });
    const missingUsersDatabase = createProbeDatabaseClient({
      learnerSessionsTable: true,
      learnerTaskStateTable: true,
      lrsOutboxTable: true,
      loginRateLimitsTable: true,
      eventsTable: true,
      usersTable: false,
      userAuthTokensTable: true,
      sessionRevocationsTable: true,
    });
    const missingAuthVersionDatabase = createProbeDatabaseClient({
      learnerSessionsTable: true,
      learnerTaskStateTable: true,
      lrsOutboxTable: true,
      loginRateLimitsTable: true,
      eventsTable: true,
      usersTable: true,
      usersAuthVersionColumn: false,
      userAuthTokensTable: true,
      sessionRevocationsTable: true,
    });
    const missingActiveAdminInvariantDatabase = createProbeDatabaseClient({
      learnerSessionsTable: true,
      learnerTaskStateTable: true,
      lrsOutboxTable: true,
      loginRateLimitsTable: true,
      eventsTable: true,
      usersTable: true,
      activeAdminInvariant: false,
      userAuthTokensTable: true,
      sessionRevocationsTable: true,
    });
    const missingCatalogDatabase = createProbeDatabaseClient({
      learnerSessionsTable: true,
      learnerTaskStateTable: true,
      lrsOutboxTable: true,
      loginRateLimitsTable: true,
      eventsTable: true,
      usersTable: true,
      userAuthTokensTable: true,
      sessionRevocationsTable: true,
      coursesTable: false,
    });
    const missingEnrollmentScopeIndexDatabase = createProbeDatabaseClient({
      learnerSessionsTable: true,
      learnerTaskStateTable: true,
      lrsOutboxTable: true,
      loginRateLimitsTable: true,
      eventsTable: true,
      usersTable: true,
      userAuthTokensTable: true,
      sessionRevocationsTable: true,
      enrollmentScopeIndex: false,
    });

    await expect(probeAaisLearningStorage({ database: migratedDatabase })).resolves.toEqual({
      mode: "postgres",
      status: "connected",
    });
    await expect(probeAaisLearningStorage({ database: missingRateLimitDatabase })).resolves.toEqual({
      mode: "postgres",
      status: "failed",
    });
    await expect(probeAaisLearningStorage({
      database: missingRateLimitRetentionDatabase,
    })).resolves.toEqual({
      mode: "postgres",
      status: "failed",
    });
    await expect(probeAaisLearningStorage({
      database: missingGuideLeaseColumnDatabase,
    })).resolves.toEqual({
      mode: "postgres",
      status: "failed",
    });
    await expect(probeAaisLearningStorage({
      database: missingGuideReservationFunctionDatabase,
    })).resolves.toEqual({
      mode: "postgres",
      status: "failed",
    });
    await expect(probeAaisLearningStorage({
      database: missingGuideDispatchConstraintDatabase,
    })).resolves.toEqual({
      mode: "postgres",
      status: "failed",
    });
    await expect(probeAaisLearningStorage({
      database: missingLearnerDeleteFunctionDatabase,
    })).resolves.toEqual({
      mode: "postgres",
      status: "failed",
    });
    await expect(probeAaisLearningStorage({
      database: incompatibleGenerationDatabase,
    })).resolves.toEqual({
      mode: "postgres",
      status: "failed",
    });
    await expect(probeAaisLearningStorage({
      database: missingLearnerDeliveryFenceDatabase,
    })).resolves.toEqual({
      mode: "postgres",
      status: "failed",
    });
    await expect(probeAaisLearningStorage({ database: missingOutboxClaimColumnsDatabase })).resolves.toEqual({
      mode: "postgres",
      status: "failed",
    });
    await expect(probeAaisLearningStorage({
      database: missingLrsDeliveryReconciliationDatabase,
    })).resolves.toEqual({
      mode: "postgres",
      status: "failed",
    });
    await expect(probeAaisLearningStorage({
      database: inconsistentLrsDeliveryAttemptDatabase,
    })).resolves.toEqual({
      mode: "postgres",
      status: "failed",
    });
    await expect(probeAaisLearningStorage({
      database: staleLrsDeliveryAttemptDatabase,
    })).resolves.toEqual({
      mode: "postgres",
      status: "failed",
    });
    await expect(probeAaisLearningStorage({ database: missingEventsDatabase })).resolves.toEqual({
      mode: "postgres",
      status: "failed",
    });
    await expect(probeAaisLearningStorage({ database: missingTaskStateDatabase })).resolves.toEqual({
      mode: "postgres",
      status: "failed",
    });
    await expect(probeAaisLearningStorage({ database: missingUsersDatabase })).resolves.toEqual({
      mode: "postgres",
      status: "failed",
    });
    await expect(probeAaisLearningStorage({ database: missingAuthVersionDatabase })).resolves.toEqual({
      mode: "postgres",
      status: "failed",
    });
    await expect(probeAaisLearningStorage({
      database: missingActiveAdminInvariantDatabase,
    })).resolves.toEqual({
      mode: "postgres",
      status: "failed",
    });
    await expect(probeAaisLearningStorage({ database: missingCatalogDatabase })).resolves.toEqual({
      mode: "postgres",
      status: "failed",
    });
    await expect(probeAaisLearningStorage({
      database: missingEnrollmentScopeIndexDatabase,
    })).resolves.toEqual({
      mode: "postgres",
      status: "failed",
    });
    expect(migratedDatabase.queries.map((query) => query.sql).join("\n")).not.toMatch(/create table|alter table/i);
    expect(missingRateLimitDatabase.queries.map((query) => query.sql).join("\n")).not.toMatch(/create table|alter table/i);
    expect(missingEventsDatabase.queries.map((query) => query.sql).join("\n")).not.toMatch(/create table|alter table/i);
    expect(missingTaskStateDatabase.queries.map((query) => query.sql).join("\n")).not.toMatch(/create table|alter table/i);
    expect(missingCatalogDatabase.queries.map((query) => query.sql).join("\n")).not.toMatch(/create table|alter table/i);
    expect(missingUsersDatabase.queries.map((query) => query.sql).join("\n")).not.toMatch(/create table|alter table/i);
  });

  it("atomically reserves the durable daily guide budget and rejects once exhausted", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });

    const first = await store.reserveDailyGuideRequest({ studentId: "S001", limit: 2 });
    const second = await store.reserveDailyGuideRequest({ studentId: "S001", limit: 2 });
    const third = await store.reserveDailyGuideRequest({ studentId: "S001", limit: 2 });

    expect(first).toMatchObject({ status: "reserved", limit: 2, used: 1, remaining: 1 });
    expect(second).toMatchObject({ status: "reserved", limit: 2, used: 2, remaining: 0 });
    expect(third).toMatchObject({ status: "exhausted", limit: 2, used: 2, remaining: 0 });

    // A different learner has an independent daily counter.
    const other = await store.reserveDailyGuideRequest({ studentId: "S002", limit: 2 });
    expect(other).toMatchObject({ status: "reserved", used: 1 });

    // The reserve statement returns both admitted and exhausted results. It
    // must not issue a second, racy read of the usage row.
    const usageQueries = database.queries.filter((query) =>
      /aais_reserve_ai_guide_request/i.test(query.sql),
    );
    expect(usageQueries).toHaveLength(4);
    expect(usageQueries.every((query) => /^select used, granted, reservation_id/i.test(
      query.sql.trim(),
    ))).toBe(true);
    expect(usageQueries[0]?.params[6]).toBe(600);
    expect(first.reservationId).toEqual(expect.any(String));
    expect(second.reservationId).toEqual(expect.any(String));
    expect(third.reservationId).toBeNull();
  });

  it("releases each durable guide reservation at most once", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    const firstId = "11111111-1111-4111-8111-111111111111";
    const nextId = "22222222-2222-4222-8222-222222222222";
    const first = await store.reserveDailyGuideRequest({
      reservationId: firstId,
      studentId: "S001",
      limit: 1,
    });
    expect(first.status).toBe("reserved");

    const releases = await Promise.all(Array.from({ length: 20 }, () =>
      store.finalizeDailyGuideRequest({
        reservationId: firstId,
        studentId: "S001",
        outcome: "released",
      })
    ));
    expect(releases.filter((result) => result.status === "released")).toHaveLength(1);

    const next = await store.reserveDailyGuideRequest({
      reservationId: nextId,
      studentId: "S001",
      limit: 1,
    });
    expect(next).toMatchObject({ status: "reserved", used: 1, reservationId: nextId });
  });

  it.each(["postgres", "file"] as const)(
    "reclaims a crashed %s guide reservation after the ten-minute lease",
    async (storageMode) => {
      const store = storageMode === "postgres"
        ? createAaisLearningStore({ database: createFakeDatabaseClient() })
        : createAaisLearningStore({ rootDir: tempDir });
      const studentId = `lease-crash-${storageMode}`;
      const reservedAt = new Date("2026-08-19T10:00:00.000Z");
      const afterExpiry = new Date("2026-08-19T10:10:01.000Z");
      const expiredReservationId = "81818181-8181-4181-8181-818181818181";
      const replacementReservationId = "82828282-8282-4282-8282-828282828282";

      await expect(store.reserveDailyGuideRequest({
        reservationId: expiredReservationId,
        studentId,
        limit: 1,
        now: reservedAt,
      })).resolves.toMatchObject({ status: "reserved", used: 1 });

      await expect(store.finalizeDailyGuideRequest({
        reservationId: expiredReservationId,
        studentId,
        outcome: "completed",
        now: afterExpiry,
      })).resolves.toEqual({ status: "unchanged" });
      await expect(store.finalizeDailyGuideRequest({
        reservationId: expiredReservationId,
        studentId,
        outcome: "released",
        now: afterExpiry,
      })).resolves.toEqual({ status: "unchanged" });

      await expect(store.reserveDailyGuideRequest({
        reservationId: replacementReservationId,
        studentId,
        limit: 1,
        now: afterExpiry,
      })).resolves.toMatchObject({
        status: "reserved",
        reservationId: replacementReservationId,
        used: 1,
        remaining: 0,
      });
    },
  );

  it.each(["postgres", "file"] as const)(
    "does not persist an exchange after its %s reservation lease expires",
    async (storageMode) => {
      const store = storageMode === "postgres"
        ? createAaisLearningStore({ database: createFakeDatabaseClient() })
        : createAaisLearningStore({ rootDir: tempDir });
      const studentId = `lease-completion-${storageMode}`;
      const reservation = await store.reserveDailyGuideRequest({
        reservationId: "88888888-8888-4888-8888-888888888888",
        studentId,
        limit: 1,
        now: new Date("2020-01-01T00:00:00.000Z"),
      });

      await expect(store.appendGuideExchange({
        studentId,
        phase: "training",
        taskId: "training_task_1",
        question: "expired question",
        answer: "expired answer",
        budgetReservationId: reservation.reservationId ?? undefined,
        orchestration: { graphId: "g", topologicalOrder: ["A1"], threadId: "expired" },
      })).rejects.toThrow();

      const session = await store.getOrCreateSession(studentId);
      expect(session.guideMessages).toEqual([]);
      expect(session.events.some((event) => event.event === "ai_prompt_submitted")).toBe(false);
    },
  );

  it.each(["postgres", "file"] as const)(
    "reclaims an expired %s reservation exactly once under concurrency",
    async (storageMode) => {
      const store = storageMode === "postgres"
        ? createAaisLearningStore({ database: createFakeDatabaseClient() })
        : createAaisLearningStore({ rootDir: tempDir });
      const studentId = `lease-race-${storageMode}`;
      const reservedAt = new Date("2026-08-19T11:00:00.000Z");
      const afterExpiry = new Date("2026-08-19T11:10:01.000Z");

      await store.reserveDailyGuideRequest({
        reservationId: "83838383-8383-4383-8383-838383838383",
        studentId,
        limit: 1,
        now: reservedAt,
      });
      const attempts = await Promise.all(Array.from({ length: 20 }, (_value, index) =>
        store.reserveDailyGuideRequest({
          reservationId: `84848484-8484-4484-8484-${String(index).padStart(12, "0")}`,
          studentId,
          limit: 1,
          now: afterExpiry,
        })
      ));

      expect(attempts.filter((reservation) => reservation.status === "reserved")).toHaveLength(1);
      expect(attempts.filter((reservation) => reservation.status === "exhausted")).toHaveLength(19);
      expect(attempts.every((reservation) => reservation.used === 1)).toBe(true);
    },
  );

  it.each(["postgres", "file"] as const)(
    "isolates %s guide reservations at the UTC day boundary",
    async (storageMode) => {
      const store = storageMode === "postgres"
        ? createAaisLearningStore({ database: createFakeDatabaseClient() })
        : createAaisLearningStore({ rootDir: tempDir });
      const studentId = `lease-utc-${storageMode}`;
      const beforeMidnight = new Date("2026-08-19T23:58:00.000Z");
      const afterMidnight = new Date("2026-08-20T00:01:00.000Z");

      const firstDay = await store.reserveDailyGuideRequest({
        reservationId: "85858585-8585-4585-8585-858585858585",
        studentId,
        limit: 1,
        now: beforeMidnight,
      });
      const secondDay = await store.reserveDailyGuideRequest({
        reservationId: "86868686-8686-4686-8686-868686868686",
        studentId,
        limit: 1,
        now: afterMidnight,
      });

      expect(firstDay).toMatchObject({
        status: "reserved",
        used: 1,
        resetsAt: "2026-08-20T00:00:00.000Z",
      });
      expect(secondDay).toMatchObject({
        status: "reserved",
        used: 1,
        resetsAt: "2026-08-21T00:00:00.000Z",
      });
    },
  );

  it.each(["postgres", "file"] as const)(
    "makes the %s dispatch terminal concurrent, idempotent, and non-refundable",
    async (storageMode) => {
      const store = storageMode === "postgres"
        ? createAaisLearningStore({ database: createFakeDatabaseClient() })
        : createAaisLearningStore({ rootDir: tempDir });
      const studentId = `dispatch-terminal-${storageMode}`;
      const now = new Date("2026-08-20T12:00:00.000Z");
      const reservationId = storageMode === "postgres"
        ? "89898989-8989-4989-8989-898989898989"
        : "90909090-9090-4090-8090-909090909090";
      await store.getOrCreateSession(studentId, 1);
      await expect(store.reserveDailyGuideRequest({
        reservationId,
        studentId,
        limit: 1,
        dataGeneration: 1,
        now,
      })).resolves.toMatchObject({ status: "reserved", used: 1 });

      const dispatches = await Promise.all(Array.from({ length: 8 }, () =>
        store.finalizeDailyGuideRequest({
          reservationId,
          studentId,
          outcome: "dispatched",
          dataGeneration: 1,
          now,
        })
      ));
      expect(dispatches).toEqual(Array.from({ length: 8 }, () => ({
        status: "dispatched",
      })));
      await expect(store.finalizeDailyGuideRequest({
        reservationId,
        studentId,
        outcome: "released",
        dataGeneration: 1,
        now,
      })).resolves.toEqual({ status: "unchanged" });
      await expect(store.reserveDailyGuideRequest({
        reservationId: storageMode === "postgres"
          ? "91919191-9191-4191-8191-919191919191"
          : "92929292-9292-4292-8292-929292929292",
        studentId,
        limit: 1,
        dataGeneration: 1,
        now,
      })).resolves.toMatchObject({ status: "exhausted", used: 1 });
    },
  );

  it.each(["postgres", "file"] as const)(
    "keeps the %s current-day aggregate across content deletion until UTC reset",
    async (storageMode) => {
      const database = storageMode === "postgres" ? createFakeDatabaseClient() : null;
      const store = database
        ? createAaisLearningStore({ database })
        : createAaisLearningStore({ rootDir: tempDir });
      const studentId = `privacy-quota-${storageMode}`;
      const today = new Date();
      today.setUTCHours(12, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const firstReservationId = storageMode === "postgres"
        ? "93939393-9393-4393-8393-939393939393"
        : "94949494-9494-4494-8494-949494949494";
      await store.getOrCreateSession(studentId, 1);
      await store.reserveDailyGuideRequest({
        reservationId: firstReservationId,
        studentId,
        limit: 1,
        dataGeneration: 1,
        now: today,
      });
      await store.finalizeDailyGuideRequest({
        reservationId: firstReservationId,
        studentId,
        outcome: "completed",
        dataGeneration: 1,
        now: today,
      });
      await expect(store.reserveDailyGuideRequest({
        reservationId: storageMode === "postgres"
          ? "95959595-9595-4595-8595-959595959595"
          : "96969696-9696-4696-8696-969696969696",
        studentId,
        limit: 1,
        dataGeneration: 1,
        now: today,
      })).resolves.toMatchObject({ status: "exhausted", used: 1 });

      await expect(store.deleteLearnerData(studentId, 1)).resolves.toMatchObject({
        accountRetained: true,
        nextGeneration: 2,
        ...(storageMode === "postgres" ? { storageMode: "postgres" } : { storageMode: "file" }),
      });
      const recreatedStore = storageMode === "file"
        ? createAaisLearningStore({ rootDir: tempDir })
        : store;
      await recreatedStore.getOrCreateSession(studentId, 2);
      await expect(recreatedStore.reserveDailyGuideRequest({
        reservationId: storageMode === "postgres"
          ? "97979797-9797-4797-8797-979797979797"
          : "98989898-9898-4898-8898-989898989898",
        studentId,
        limit: 1,
        dataGeneration: 2,
        now: today,
      })).resolves.toMatchObject({ status: "exhausted", used: 1 });
      await expect(recreatedStore.reserveDailyGuideRequest({
        reservationId: storageMode === "postgres"
          ? "99999999-9999-4999-8999-999999999999"
          : "10101010-1010-4010-8010-101010101010",
        studentId,
        limit: 1,
        dataGeneration: 2,
        now: tomorrow,
      })).resolves.toMatchObject({ status: "reserved", used: 1 });
      if (database) {
        expect(database.getDailyGuideUsageKeys(studentId)).toEqual([
          `${studentId}\0${tomorrow.toISOString().slice(0, 10)}`,
        ]);
      }
    },
  );

  it("completes the guide reservation atomically with the learner exchange", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    const reservationId = "33333333-3333-4333-8333-333333333333";
    await store.getOrCreateSession("S001");
    await store.reserveDailyGuideRequest({ reservationId, studentId: "S001", limit: 1 });

    await store.appendGuideExchange({
      studentId: "S001",
      phase: "training",
      taskId: "training_task_1",
      question: "原子计费问题",
      answer: "原子计费回答",
      budgetReservationId: reservationId,
      orchestration: { graphId: "g", topologicalOrder: ["A1"], threadId: "t" },
    });

    await expect(store.finalizeDailyGuideRequest({
      reservationId,
      studentId: "S001",
      outcome: "released",
    })).resolves.toEqual({ status: "unchanged" });
    await expect(store.reserveDailyGuideRequest({
      reservationId: "44444444-4444-4444-8444-444444444444",
      studentId: "S001",
      limit: 1,
    })).resolves.toMatchObject({ status: "exhausted", used: 1 });
    const session = await store.getOrCreateSession("S001");
    expect(session.guideMessages.map((message) => message.text)).toEqual([
      "原子计费问题",
      "原子计费回答",
    ]);
  });

  it("retries a guide exchange CAS conflict without losing a concurrent artifact or duplicating evidence", async () => {
    const baseDatabase = createFakeDatabaseClient();
    const setupStore = createAaisLearningStore({ database: baseDatabase });
    const reservationId = "34343434-3434-4434-8434-343434343434";
    await setupStore.getOrCreateSession("S001");
    await setupStore.reserveDailyGuideRequest({
      reservationId,
      studentId: "S001",
      limit: 1,
    });

    let signalGuideWriteReached!: () => void;
    const guideWriteReached = new Promise<void>((resolve) => {
      signalGuideWriteReached = resolve;
    });
    let releaseGuideWrite!: () => void;
    const guideWriteRelease = new Promise<void>((resolve) => {
      releaseGuideWrite = resolve;
    });
    let paused = false;
    const guideDatabase: AaisDatabaseClient = {
      ...baseDatabase,
      async query(sql: string, params: unknown[] = []) {
        if (
          !paused
          && /^with generation_guard as materialized/i.test(sql.trim())
          && String(params[4] ?? "").includes('"ai_prompt_submitted"')
        ) {
          paused = true;
          signalGuideWriteReached();
          await guideWriteRelease;
        }
        return baseDatabase.query(sql, params);
      },
    };
    const guideStore = createAaisLearningStore({ database: guideDatabase });
    const autosaveStore = createAaisLearningStore({ database: baseDatabase });

    const pendingExchange = guideStore.appendGuideExchange({
      studentId: "S001",
      phase: "training",
      taskId: "training_task_1",
      question: "保留这次 provider 问题",
      answer: "保留这次 provider 回答",
      budgetReservationId: reservationId,
      dataGeneration: 1,
      orchestration: { graphId: "g", topologicalOrder: ["A1"], threadId: "cas" },
    });
    await guideWriteReached;
    await autosaveStore.saveArtifact(
      "S001",
      "training_task_1",
      "并发 autosave 必须保留",
      { dataGeneration: 1 },
    );
    releaseGuideWrite();

    const result = await pendingExchange;
    expect(result.session.tasks[0]?.artifactText).toBe("并发 autosave 必须保留");
    expect(result.session.guideMessages.map((message) => message.text)).toEqual([
      "保留这次 provider 问题",
      "保留这次 provider 回答",
    ]);
    expect(new Set(result.session.guideMessages.map((message) => message.id)).size).toBe(2);
    expect(result.session.guideMessages.map((message) => message.id)).toEqual([
      result.exchange.userMessageId,
      result.exchange.assistantMessageId,
    ]);
    const promptEvents = result.session.events.filter((event) => event.event === "ai_prompt_submitted");
    const responseEvents = result.session.events.filter((event) => event.event === "ai_response_completed");
    expect(promptEvents).toHaveLength(1);
    expect(responseEvents).toHaveLength(1);
    expect(promptEvents[0]?.detail.exchange_id_hash).toBe(
      responseEvents[0]?.detail.exchange_id_hash,
    );
    expect(baseDatabase.queries.filter((query) =>
      /^with generation_guard as materialized/i.test(query.sql.trim())
      && String(query.params[4] ?? "").includes('"ai_prompt_submitted"')
    )).toHaveLength(2);
    await expect(setupStore.reserveDailyGuideRequest({
      reservationId: "35353535-3535-4535-8535-353535353535",
      studentId: "S001",
      limit: 1,
    })).resolves.toMatchObject({ status: "exhausted", used: 1 });
  });

  it("can release the reservation after an atomic learner exchange rolls back", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    const reservationId = "55555555-5555-4555-8555-555555555555";
    await store.getOrCreateSession("S001");
    await store.reserveDailyGuideRequest({ reservationId, studentId: "S001", limit: 1 });
    database.failNextAtomicWriteAt("event");

    await expect(store.appendGuideExchange({
      studentId: "S001",
      phase: "training",
      taskId: "training_task_1",
      question: "不应提交的问题",
      answer: "不应提交的回答",
      budgetReservationId: reservationId,
      orchestration: { graphId: "g", topologicalOrder: ["A1"], threadId: "t" },
    })).rejects.toThrow("Injected atomic learner mutation failure at event");
    await expect(store.finalizeDailyGuideRequest({
      reservationId,
      studentId: "S001",
      outcome: "released",
    })).resolves.toEqual({ status: "released" });
    await expect(store.reserveDailyGuideRequest({
      reservationId: "66666666-6666-4666-8666-666666666666",
      studentId: "S001",
      limit: 1,
    })).resolves.toMatchObject({ status: "reserved", used: 1 });
    const session = await store.getOrCreateSession("S001");
    expect(session.guideMessages).toEqual([]);
  });

  it("fails closed when the durable guide reservation schema is missing", async () => {
    const missingTableError = Object.assign(new Error("relation does not exist"), {
      code: "42P01",
    });
    const database = {
      async query(sql: string) {
        if (/^insert into aais_learner_data_generations/i.test(sql.trim())) {
          return { rows: [{ data_generation: 1 }] };
        }
        if (/^select used, granted, reservation_id[\s\S]*aais_reserve_ai_guide_request/i.test(sql.trim())) {
          throw missingTableError;
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as AaisDatabaseClient;
    const store = createAaisLearningStore({ database });

    await expect(
      store.reserveDailyGuideRequest({ studentId: "S001", limit: 3 }),
    ).rejects.toThrow("AAIS production learner storage requires Postgres configuration");
  });

  it("reserves the file-mode budget immediately and completes it with the exchange", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });

    const first = await store.reserveDailyGuideRequest({ studentId: "S001", limit: 1 });
    expect(first).toMatchObject({ status: "reserved", limit: 1, used: 1, remaining: 0 });

    const concurrent = await store.reserveDailyGuideRequest({ studentId: "S001", limit: 1 });
    expect(concurrent).toMatchObject({ status: "exhausted", used: 1 });

    await store.appendGuideExchange({
      studentId: "S001",
      phase: "training",
      taskId: "training_task_1",
      question: "问题",
      answer: "回答",
      budgetReservationId: first.reservationId ?? undefined,
      orchestration: { graphId: "g", topologicalOrder: ["A1"], threadId: "t" },
    });

    const afterExchange = await store.reserveDailyGuideRequest({ studentId: "S001", limit: 1 });
    expect(afterExchange).toMatchObject({ status: "exhausted", limit: 1, used: 1, remaining: 0 });
  });

  it("admits only one concurrent file-mode reservation at a limit of one", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    const reservations = await Promise.all(Array.from({ length: 20 }, (_value, index) =>
      store.reserveDailyGuideRequest({
        reservationId: `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`,
        studentId: "S001",
        limit: 1,
      })
    ));

    expect(reservations.filter((reservation) => reservation.status === "reserved")).toHaveLength(1);
    expect(reservations.filter((reservation) => reservation.status === "exhausted")).toHaveLength(19);
  });

  it("serializes concurrent Postgres first-use reservations before the daily row exists", async () => {
    const database = createFakeDatabaseClient();
    const stores = Array.from({ length: 20 }, () => createAaisLearningStore({ database }));
    const now = new Date("2026-08-19T12:00:00.000Z");
    const reservations = await Promise.all(stores.map((store, index) =>
      store.reserveDailyGuideRequest({
        reservationId: `87878787-8787-4787-8787-${String(index).padStart(12, "0")}`,
        studentId: "lease-first-insert-postgres",
        limit: 1,
        now,
      })
    ));

    expect(reservations.filter((reservation) => reservation.status === "reserved")).toHaveLength(1);
    expect(reservations.filter((reservation) => reservation.status === "exhausted")).toHaveLength(19);
    expect(reservations.every((reservation) => reservation.used === 1)).toBe(true);
    expect(database.queries.filter((query) =>
      /aais_reserve_ai_guide_request/i.test(query.sql)
    )).toHaveLength(20);
  });

  it("handles concurrent first-session creation without returning a write conflict", async () => {
    const database = createFakeDatabaseClient();
    const storeA = createAaisLearningStore({ database });
    const storeB = createAaisLearningStore({ database });

    const [sessionA, sessionB] = await Promise.all([
      storeA.getOrCreateSession("S001"),
      storeB.getOrCreateSession("S001"),
    ]);

    expect(sessionA.sessionId).toBe(sessionB.sessionId);
    expect(sessionA.events.map((event) => event.event)).toContain("session_created");
    expect(sessionB.events.map((event) => event.event)).toContain("session_created");
  });

  it("retries a learner-session write conflict and preserves independent text saves", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const database = createFakeDatabaseClient();
    const storeA = createAaisLearningStore({ database });
    const storeB = createAaisLearningStore({ database });
    await storeA.getOrCreateSession("S001");

    await Promise.all([
      storeA.saveArtifact("S001", "training_task_1", "并发保存的作品"),
      storeB.saveSelfReport("S001", "training_task_1", "并发保存的反思"),
    ]);

    const session = await createAaisLearningStore({ database }).getOrCreateSession("S001");
    expect(session.tasks[0]).toMatchObject({
      artifactText: "并发保存的作品",
      selfReport: "并发保存的反思",
    });
    expect(session.events.map((event) => event.event)).toEqual(
      expect.arrayContaining(["artifact_saved", "self_report_saved"]),
    );
    const conflictLogs = info.mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(conflictLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "aais.session.write_conflict",
          learnerId: expect.stringMatching(/^learner:[a-f0-9]{16}$/),
          learnerIdRedaction: "sha256-16",
          resolution: "retrying",
          storage: "postgres",
          secrets: "redacted",
        }),
      ]),
    );
    expect(JSON.stringify(conflictLogs)).not.toContain("S001");
  });

  it("uses file-session compare-and-swap to preserve independent concurrent text saves", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const storeA = createAaisLearningStore({ rootDir: tempDir });
    const storeB = createAaisLearningStore({ rootDir: tempDir });
    await storeA.getOrCreateSession("S001");

    await Promise.all([
      storeA.saveArtifact("S001", "training_task_1", "文件并发保存的作品"),
      storeB.saveSelfReport("S001", "training_task_1", "文件并发保存的反思"),
    ]);

    const session = await createAaisLearningStore({ rootDir: tempDir }).getOrCreateSession("S001");
    expect(session.tasks[0]).toMatchObject({
      artifactText: "文件并发保存的作品",
      selfReport: "文件并发保存的反思",
    });
    expect(session.events.map((event) => event.event)).toEqual(
      expect.arrayContaining(["artifact_saved", "self_report_saved"]),
    );
    const conflictLogs = info.mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(conflictLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "aais.session.write_conflict",
        resolution: "retrying",
        storage: "file",
        secrets: "redacted",
      }),
    ]));
    expect(JSON.stringify(conflictLogs)).not.toContain("S001");
  });

  it("fails a same-field learner-session write conflict instead of silently overwriting text", async () => {
    const database = createFakeDatabaseClient();
    const storeA = createAaisLearningStore({ database });
    const storeB = createAaisLearningStore({ database });
    await storeA.getOrCreateSession("S001");

    const results = await Promise.allSettled([
      storeA.saveArtifact("S001", "training_task_1", "第一个并发版本"),
      storeB.saveArtifact("S001", "training_task_1", "第二个并发版本"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(isAaisSessionWriteConflictError(rejected.reason)).toBe(true);
    }

    const session = await createAaisLearningStore({ database }).getOrCreateSession("S001");
    expect([
      "第一个并发版本",
      "第二个并发版本",
    ]).toContain(session.tasks[0].artifactText);
  });

  it("persists LRS outbox rows in Postgres storage and can replay them", async () => {
    const database = createFakeDatabaseClient();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const store = createAaisLearningStore({ database });

    await store.getOrCreateSession("S001");
    await store.saveArtifact("S001", "training_task_1", "数据库 outbox 记录");

    expect(database.outboxRows.map((row) => row.status)).toContain("pending");
    expect(database.outboxRows.map((row) => row.payload.event)).toEqual(
      expect.arrayContaining(["session_created", "artifact_saved"]),
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

  it("only enqueues product LRS facts during learner saves and leaves provider delivery to cron", async () => {
    vi.stubEnv("LRS_ENDPOINT", "https://lrs.example.test/xapi");
    vi.stubEnv("LRS_USERNAME", "test-user");
    vi.stubEnv("LRS_PASSWORD", "test-password");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });

    await store.saveArtifact("S001", "training_task_1", "enqueue without network");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(database.queries.some((query) =>
      /^with candidate as \(\s*select id\s+from aais_lrs_outbox/i.test(query.sql.trim())
    )).toBe(false);
    expect(database.outboxRows.length).toBeGreaterThan(0);
    expect(database.outboxRows.every((row) => row.status === "pending")).toBe(true);
  });

  it("claims each persistent outbox row only once across concurrent flushers", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    await store.saveArtifact("S001", "training_task_1", "claim exactly once");

    let notifyFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      notifyFetchStarted = resolve;
    });
    let releaseFetch!: (response: Response) => void;
    const deferredResponse = new Promise<Response>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async () => {
      notifyFetchStarted();
      return deferredResponse;
    });
    const config = {
      endpoint: "https://lrs.example.test/xapi",
      username: "test-user",
      password: "test-password",
    };

    const firstFlush = flushAaisPersistentLrsOutbox({
      database,
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await fetchStarted;

    const concurrentFlush = await flushAaisPersistentLrsOutbox({
      database,
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(concurrentFlush).toMatchObject({ status: "sent", sent: 0, batches: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseFetch(new Response(null, { status: 204 }));
    const firstResult = await firstFlush;
    expect(firstResult.sent).toBe(database.outboxRows.length);
    expect(database.outboxRows.every((row) => row.status === "sent")).toBe(true);
    expect(database.outboxRows.every((row) => row.delivery_claim_id === null)).toBe(true);
  });

  it("never completes privacy deletion while an old-generation LRS request can still start", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    await store.saveArtifact("S001", "training_task_1", "privacy delivery fence");

    let signalFetchReady!: () => void;
    const fetchReady = new Promise<void>((resolve) => {
      signalFetchReady = resolve;
    });
    let releaseExternalSend!: () => void;
    const externalSendRelease = new Promise<void>((resolve) => {
      releaseExternalSend = resolve;
    });
    const externallyStartedBodies: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      signalFetchReady();
      await externalSendRelease;
      externallyStartedBodies.push(String(init?.body));
      return new Response(null, { status: 204 });
    });

    const flush = flushAaisPersistentLrsOutbox({
      database,
      config: {
        endpoint: "https://lrs.example.test/xapi",
        username: "test-user",
        password: "test-password",
      },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await fetchReady;

    expect(database.getLearnerDeliveryFence("S001")).toMatchObject({
      state: "in_flight",
    });
    await expect(store.deleteLearnerData("S001", 1)).rejects.toMatchObject({
      name: "AaisLearnerDataDeliveryFenceError",
      reason: "in_flight",
    });
    expect(externallyStartedBodies).toEqual([]);
    expect(database.hasSession("S001")).toBe(true);

    releaseExternalSend();
    await expect(flush).resolves.toMatchObject({ status: "sent" });
    expect(externallyStartedBodies).toHaveLength(1);
    expect(database.getLearnerDeliveryFence("S001")).toEqual({
      state: "idle",
      claimId: null,
    });
    await expect(store.deleteLearnerData("S001", 1)).resolves.toMatchObject({
      nextGeneration: 2,
      learnerRecordDeleted: true,
    });
  });

  it.each([408, 409, 425, 429, 500, 503])(
    "keeps an ambiguous LRS HTTP %i response fenced until exact reconciliation",
    async (httpStatus) => {
      const database = createFakeDatabaseClient();
      const store = createAaisLearningStore({ database });
      await store.saveArtifact("S001", "training_task_1", `ambiguous HTTP ${httpStatus}`);
      const fetchMock = vi.fn<typeof fetch>(async () =>
        new Response(null, { status: httpStatus }));

      await expect(flushAaisPersistentLrsOutbox({
        database,
        config: {
          endpoint: "https://lrs.example.test/xapi",
          username: "test-user",
          password: "test-password",
        },
        fetchImpl: fetchMock as unknown as typeof fetch,
      })).resolves.toMatchObject({
        status: "partial",
        failed: database.outboxRows.length,
      });

      const fence = database.getLearnerDeliveryFence("S001");
      expect(fence).toMatchObject({ state: "uncertain", claimId: expect.any(String) });
      expect(database.outboxRows.every((row) =>
        row.status === "sending"
        && row.delivery_claim_id === fence.claimId
        && row.xapi_statement !== null
      )).toBe(true);
      await expect(store.deleteLearnerData("S001", 1)).rejects.toMatchObject({
        name: "AaisLearnerDataDeliveryFenceError",
        reason: "reconciliation_required",
      });

      const retryFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
      await expect(flushAaisPersistentLrsOutbox({
        database,
        config: {
          endpoint: "https://lrs.example.test/xapi",
          username: "test-user",
          password: "test-password",
        },
        fetchImpl: retryFetch as unknown as typeof fetch,
      })).resolves.toMatchObject({ sent: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(retryFetch).not.toHaveBeenCalled();
    },
  );

  it.each([400, 422])(
    "retries an explicit contract rejection HTTP %i with the same frozen statement ids",
    async (httpStatus) => {
      const database = createFakeDatabaseClient();
      const store = createAaisLearningStore({ database });
      await store.saveArtifact("S001", "training_task_1", `known HTTP ${httpStatus}`);
      const postedBodies: string[] = [];
      const firstFetch = vi.fn<typeof fetch>(async (_url, init) => {
        postedBodies.push(String(init?.body));
        return new Response(null, { status: httpStatus });
      });

      await expect(flushAaisPersistentLrsOutbox({
        database,
        config: {
          endpoint: "https://lrs.example.test/xapi",
          username: "test-user",
          password: "test-password",
        },
        fetchImpl: firstFetch as unknown as typeof fetch,
      })).resolves.toMatchObject({ status: "partial", sent: 0 });
      expect(database.getLearnerDeliveryFence("S001")).toEqual({ state: "idle", claimId: null });
      expect(database.outboxRows.every((row) =>
        row.status === "retry" && row.delivery_claim_id === null && row.xapi_statement
      )).toBe(true);

      const retryFetch = vi.fn<typeof fetch>(async (_url, init) => {
        postedBodies.push(String(init?.body));
        return new Response(null, { status: 204 });
      });
      await flushAaisPersistentLrsOutbox({
        database,
        config: {
          endpoint: "https://lrs.example.test/xapi",
          username: "test-user",
          password: "test-password",
        },
        fetchImpl: retryFetch as unknown as typeof fetch,
      });
      expect(retryFetch).toHaveBeenCalled();
      expect(postedBodies.at(-1)).toBe(postedBodies[0]);
    },
  );

  it("keeps privacy deletion blocked only when the LRS produced no HTTP response", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    await store.saveArtifact("S001", "training_task_1", "unknown LRS acknowledgement");
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError("simulated transport failure");
    });
    const workerStartedAt = Date.now();

    await expect(flushAaisPersistentLrsOutbox({
      database,
      config: {
        endpoint: "https://lrs.example.test/xapi",
        username: "test-user",
        password: "test-password",
      },
      fetchImpl: fetchMock as unknown as typeof fetch,
    })).resolves.toMatchObject({ status: "partial", sent: 0 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fence = database.getLearnerDeliveryFence("S001");
    expect(fence).toMatchObject({ state: "uncertain", claimId: expect.any(String) });
    expect(database.outboxRows.every((row) =>
      row.status === "sending" && row.delivery_claim_id === fence.claimId
    )).toBe(true);
    expect(database.getLrsDeliveryAttempt(String(fence.claimId))).toMatchObject({
      state: "uncertain",
      requestTimeoutMs: 5_000,
    });
    expect(new Date(
      database.getLrsDeliveryAttempt(String(fence.claimId))?.reconcileAfter ?? "",
    ).getTime()).toBeGreaterThanOrEqual(workerStartedAt + 155_000);
    await expect(store.deleteLearnerData("S001", 1)).rejects.toMatchObject({
      name: "AaisLearnerDataDeliveryFenceError",
      reason: "reconciliation_required",
    });

    const retryFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    await expect(flushAaisPersistentLrsOutbox({
      database,
      config: {
        endpoint: "https://lrs.example.test/xapi",
        username: "test-user",
        password: "test-password",
      },
      fetchImpl: retryFetch as unknown as typeof fetch,
    })).resolves.toMatchObject({ sent: 0 });
    expect(retryFetch).not.toHaveBeenCalled();
  });

  it("reconciles an abandoned LRS claim only with a stale, exact statement set and is idempotent", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    await store.saveArtifact("S001", "training_task_1", "operator reconciliation");
    await flushAaisPersistentLrsOutbox({
      database,
      config: {
        endpoint: "https://lrs.example.test/xapi",
        username: "test-user",
        password: "test-password",
      },
      fetchImpl: vi.fn<typeof fetch>(async () => {
        throw new TypeError("simulated no-response transport failure");
      }) as unknown as typeof fetch,
    });
    const fence = database.getLearnerDeliveryFence("S001");
    const claimId = String(fence.claimId);
    database.simulatePersistedLrsWorkerCrash(claimId);
    expect(database.getLearnerDeliveryFence("S001")).toMatchObject({
      state: "in_flight",
      claimId,
    });
    expect(database.getLrsDeliveryAttempt(claimId)).toMatchObject({ state: "in_flight" });
    const statementIds = database.outboxRows.map((row) =>
      String((row.xapi_statement as { id?: unknown } | null)?.id ?? "")
    );
    const baseTime = Date.now();
    const earlyTime = new Date(baseTime + 10_000).toISOString();
    const staleTime = new Date(baseTime + 160_000).toISOString();

    await expect(reconcileAaisLrsDeliveryAttempt({
      actorId: "admin-operator",
      claimId,
      database,
      evidence: {
        observedAt: earlyTime,
        statements: statementIds.map((statementId) => ({ statementId, status: "absent" })),
      },
      now: () => new Date(earlyTime),
    })).rejects.toMatchObject({ name: "AaisLrsDeliveryReconciliationConflictError" });
    await expect(reconcileAaisLrsDeliveryAttempt({
      actorId: "admin-operator",
      claimId,
      database,
      evidence: {
        observedAt: staleTime,
        statements: statementIds.slice(0, -1).map((statementId) => ({
          statementId,
          status: "absent",
        })),
      },
      now: () => new Date(staleTime),
    })).rejects.toMatchObject({ name: "AaisLrsDeliveryReconciliationConflictError" });
    expect(database.getLearnerDeliveryFence("S001")).toMatchObject({
      state: "in_flight",
      claimId,
    });

    const evidence = {
      observedAt: staleTime,
      statements: statementIds.map((statementId, index) => ({
        statementId,
        status: index === 0 ? "stored" as const : "absent" as const,
      })),
    };
    const first = await reconcileAaisLrsDeliveryAttempt({
      actorId: "admin-operator",
      claimId,
      database,
      evidence,
      now: () => new Date(staleTime),
    });
    expect(first).toMatchObject({
      status: "reconciled",
      result: statementIds.length === 1 ? "stored" : "mixed",
      statementCount: statementIds.length,
      stored: 1,
      absent: Math.max(0, statementIds.length - 1),
      privacyFence: "idle",
      secrets: "redacted",
    });
    expect(database.getLearnerDeliveryFence("S001")).toEqual({ state: "idle", claimId: null });
    expect(database.outboxRows[0]?.status).toBe("sent");
    expect(database.outboxRows.slice(1).every((row) => row.status === "retry")).toBe(true);

    await expect(reconcileAaisLrsDeliveryAttempt({
      actorId: "another-admin",
      claimId,
      database,
      evidence,
      now: () => new Date(baseTime + 161_000),
    })).resolves.toEqual(first);
    await expect(reconcileAaisLrsDeliveryAttempt({
      actorId: "admin-operator",
      claimId,
      database,
      evidence: {
        ...evidence,
        statements: evidence.statements.map((statement) => ({
          ...statement,
          status: "stored" as const,
        })),
      },
      now: () => new Date(baseTime + 161_000),
    })).rejects.toMatchObject({ name: "AaisLrsDeliveryReconciliationConflictError" });

    await expect(store.deleteLearnerData("S001", 1)).resolves.toMatchObject({
      learnerRecordDeleted: true,
      nextGeneration: 2,
    });
  });

  it("dead-letters operator-confirmed absent statements at the persisted attempt limit", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    await store.saveArtifact("S001", "training_task_1", "absent at final attempt");
    await flushAaisPersistentLrsOutbox({
      database,
      config: {
        endpoint: "https://lrs.example.test/xapi",
        username: "test-user",
        password: "test-password",
      },
      fetchImpl: vi.fn<typeof fetch>(async () =>
        new Response(null, { status: 503 })) as unknown as typeof fetch,
      maxAttempts: 1,
    });
    const fence = database.getLearnerDeliveryFence("S001");
    const claimId = String(fence.claimId);
    const observedAt = new Date(Date.now() + 160_000).toISOString();
    const statementIds = database.outboxRows.map((row) =>
      String((row.xapi_statement as { id?: unknown } | null)?.id ?? "")
    );

    await expect(reconcileAaisLrsDeliveryAttempt({
      actorId: "admin-operator",
      claimId,
      database,
      evidence: {
        observedAt,
        statements: statementIds.map((statementId) => ({
          statementId,
          status: "absent",
        })),
      },
      now: () => new Date(observedAt),
    })).resolves.toMatchObject({
      result: "absent",
      stored: 0,
      absent: statementIds.length,
      privacyFence: "idle",
    });
    expect(database.outboxRows.every((row) =>
      row.status === "dead_letter" && row.attempts === 1
    )).toBe(true);
    expect(database.getLearnerDeliveryFence("S001")).toEqual({ state: "idle", claimId: null });
  });

  it("does not reclaim an expired row lease while its learner delivery fence is active", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    await store.saveArtifact("S001", "training_task_1", "lease recovery");

    let notifyFirstFetchStarted!: () => void;
    const firstFetchStarted = new Promise<void>((resolve) => {
      notifyFirstFetchStarted = resolve;
    });
    let releaseFirstFetch!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      releaseFirstFetch = resolve;
    });
    const firstFetch = vi.fn<typeof fetch>(async () => {
      notifyFirstFetchStarted();
      return firstResponse;
    });
    const secondFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const config = {
      endpoint: "https://lrs.example.test/xapi",
      username: "test-user",
      password: "test-password",
    };

    const staleFlush = flushAaisPersistentLrsOutbox({
      database,
      config,
      fetchImpl: firstFetch as unknown as typeof fetch,
    });
    await firstFetchStarted;
    for (const row of database.outboxRows) {
      row.lease_expires_at = Date.now() - 1;
    }

    const replacementFlush = await flushAaisPersistentLrsOutbox({
      database,
      config,
      fetchImpl: secondFetch as unknown as typeof fetch,
    });
    expect(replacementFlush).toMatchObject({ sent: 0, batches: 0 });
    expect(secondFetch).not.toHaveBeenCalled();

    releaseFirstFetch(new Response(null, { status: 204 }));
    const staleResult = await staleFlush;
    expect(staleResult.sent).toBe(database.outboxRows.length);
    expect(database.outboxRows.every((row) => row.status === "sent")).toBe(true);
    expect(database.outboxRows.every((row) => row.delivery_claim_id === null)).toBe(true);
    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(secondFetch).not.toHaveBeenCalled();
  });

  it("stages and then delivers a newer coalesced payload after an older delivery finishes", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    await store.saveArtifact("S001", "training_task_1", "a");
    for (const row of database.outboxRows) {
      if (row.payload.event !== "artifact_saved") {
        row.status = "sent";
      }
    }

    let notifyFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      notifyFetchStarted = resolve;
    });
    let releaseFetch!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      releaseFetch = resolve;
    });
    const firstFetch = vi.fn<typeof fetch>(async () => {
      notifyFetchStarted();
      return firstResponse;
    });
    const config = {
      endpoint: "https://lrs.example.test/xapi",
      username: "test-user",
      password: "test-password",
    };
    const firstFlush = flushAaisPersistentLrsOutbox({
      database,
      config,
      fetchImpl: firstFetch as unknown as typeof fetch,
      limit: 1,
      maxBatchSize: 1,
    });
    await fetchStarted;

    await store.saveArtifact("S001", "training_task_1", "newest payload");
    for (const row of database.outboxRows) {
      if (row.payload.event !== "artifact_saved") {
        row.status = "sent";
      }
    }
    const newestArtifactRow = database.outboxRows.find((row) =>
      row.pending_payload?.event === "artifact_saved"
      && row.pending_payload.detail.characters === 13
    );
    expect(newestArtifactRow).toMatchObject({
      status: "sending",
      delivery_claim_id: expect.any(String),
      pending_payload: {
        detail: {
          characters: 13,
          merged_events: 1,
        },
      },
    });

    releaseFetch(new Response(null, { status: 204 }));
    const firstResult = await firstFlush;
    expect(firstResult.sent).toBe(2);
    expect(firstFetch).toHaveBeenCalledTimes(2);
    expect(newestArtifactRow).toMatchObject({
      status: "sent",
      delivery_claim_id: null,
      pending_payload: null,
      payload: {
        detail: {
          characters: 13,
          merged_events: 1,
        },
      },
    });
    expect(newestArtifactRow?.payload.detail).toMatchObject({
      characters: 13,
      merged_events: 1,
    });

    const eventExtension = "https://www.aais.site/xapi/extensions/aais-event";
    const detailExtension = "https://www.aais.site/xapi/extensions/aais-detail";
    const firstStatements = JSON.parse(String(firstFetch.mock.calls[0]?.[1]?.body)) as Array<{
      id: string;
      context: { extensions: Record<string, unknown> };
    }>;
    const replayStatements = JSON.parse(String(firstFetch.mock.calls[1]?.[1]?.body)) as Array<{
      id: string;
      context: { extensions: Record<string, unknown> };
    }>;
    const firstArtifactStatement = firstStatements.find((statement) =>
      statement.context.extensions[eventExtension] === "artifact_saved"
    );
    const replayArtifactStatement = replayStatements.find((statement) =>
      statement.context.extensions[eventExtension] === "artifact_saved"
    );
    expect(firstArtifactStatement?.id).not.toBe(replayArtifactStatement?.id);
    const firstDetail = firstArtifactStatement?.context.extensions[detailExtension] as Record<string, unknown>;
    const replayDetail = replayArtifactStatement?.context.extensions[detailExtension] as Record<string, unknown>;
    expect(Number(firstDetail.merged_events) + Number(replayDetail.merged_events)).toBe(2);
  });

  it("starts a fresh coalescing count after a prior window row was sent", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    const config = {
      endpoint: "https://lrs.example.test/xapi",
      username: "test-user",
      password: "test-password",
    };
    const firstFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const secondFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));

    await store.saveArtifact("S001", "training_task_1", "a");
    await flushAaisPersistentLrsOutbox({
      database,
      config,
      fetchImpl: firstFetch as unknown as typeof fetch,
    });
    await store.saveArtifact("S001", "training_task_1", "ab");
    const secondArtifactRow = database.outboxRows.find((row) =>
      row.payload.event === "artifact_saved"
      && row.payload.detail.characters === 2
    );
    expect(secondArtifactRow?.payload.detail.merged_events).toBe(1);
    await flushAaisPersistentLrsOutbox({
      database,
      config,
      fetchImpl: secondFetch as unknown as typeof fetch,
    });

    const eventExtension = "https://www.aais.site/xapi/extensions/aais-event";
    const detailExtension = "https://www.aais.site/xapi/extensions/aais-detail";
    const readArtifactDetail = (fetchMock: typeof firstFetch) => {
      const statements = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Array<{
        context: { extensions: Record<string, unknown> };
      }>;
      return statements.find((statement) =>
        statement.context.extensions[eventExtension] === "artifact_saved"
      )?.context.extensions[detailExtension] as Record<string, unknown>;
    };
    expect(
      Number(readArtifactDetail(firstFetch).merged_events)
      + Number(readArtifactDetail(secondFetch).merged_events),
    ).toBe(2);
  });

  it("keeps stage navigation in the learner session and out of the LRS outbox", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T06:00:00.000Z"));
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });

    await store.selectStage("S001", "guide");
    await store.selectStage("S001", "assessment");

    const stageRows = database.outboxRows.filter((row) => row.payload.event === "stage_selected");
    expect(stageRows).toHaveLength(0);
    const persisted = await store.readSession("S001");
    expect(persisted?.events.filter((event) => event.event === "stage_selected")
      .map((event) => event.detail.stageId)).toEqual([
      "guide",
      "assessment",
    ]);
  });

  it("does not reopen an outbox row when an exact event is replayed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T06:30:00.000Z"));
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    const config = {
      endpoint: "https://lrs.example.test/xapi",
      username: "test-user",
      password: "test-password",
    };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));

    const firstSelection = await store.selectStage("S001", "guide");
    await flushAaisPersistentLrsOutbox({
      database,
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const eventCountAfterFirstWrite = database.eventRows.length;
    const outboxAfterFirstWrite = structuredClone(database.outboxRows);
    const versionAfterFirstWrite = database.getSessionVersion("S001");
    const mutationQueriesAfterFirstWrite = database.queries.filter((query) =>
      /^with generation_guard as materialized/i.test(query.sql.trim())
      && /session_insert as/i.test(query.sql)
    ).length;

    const replay = await store.selectStage("S001", "guide");

    expect(replay.updatedAt).toBe(firstSelection.updatedAt);
    expect(replay.events).toHaveLength(firstSelection.events.length);
    expect(database.getSessionVersion("S001")).toBe(versionAfterFirstWrite);
    expect(database.queries.filter((query) =>
      /^with generation_guard as materialized/i.test(query.sql.trim())
      && /session_insert as/i.test(query.sql)
    )).toHaveLength(mutationQueriesAfterFirstWrite);
    expect(database.eventRows).toHaveLength(eventCountAfterFirstWrite);
    expect(database.outboxRows).toEqual(outboxAfterFirstWrite);
    expect(database.outboxRows.every((row) => row.status === "sent")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("replays the frozen xAPI body after integration metadata changes", async () => {
    const beforeProductPseudonymSecret = Buffer.from(
      Array.from({ length: 32 }, (_, index) => index + 65),
    ).toString("base64url");
    const afterProductPseudonymSecret = Buffer.from(
      Array.from({ length: 32 }, (_, index) => 255 - index),
    ).toString("base64url");
    vi.stubEnv("AAIS_PRODUCT_PSEUDONYM_SECRET", beforeProductPseudonymSecret);
    vi.stubEnv("AAIS_LRS_COHORT_ID", "cohort-before");
    vi.stubEnv("AAIS_LRS_ROLE", "learner-before");
    vi.stubEnv("AAIS_LRS_COURSE_ID", "course-before");
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    const config = {
      endpoint: "https://lrs.example.test/xapi",
      username: "test-user",
      password: "test-password",
    };
    const bodies: unknown[] = [];
    const firstFetch = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as unknown);
      return new Response(null, { status: 401 });
    });

    await store.saveArtifact("S001", "training_task_1", "freeze this delivery");
    const firstResult = await flushAaisPersistentLrsOutbox({
      database,
      config,
      fetchImpl: firstFetch as unknown as typeof fetch,
    });
    expect(firstResult.status).toBe("partial");
    expect(database.outboxRows.every((row) => row.xapi_statement !== null)).toBe(true);

    vi.stubEnv("AAIS_LRS_COHORT_ID", "cohort-after");
    vi.stubEnv("AAIS_LRS_ROLE", "teacher-after");
    vi.stubEnv("AAIS_LRS_COURSE_ID", "course-after");
    vi.stubEnv("AAIS_PRODUCT_PSEUDONYM_SECRET", afterProductPseudonymSecret);
    const secondFetch = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as unknown);
      return new Response(null, { status: 204 });
    });
    const secondResult = await flushAaisPersistentLrsOutbox({
      database,
      config,
      fetchImpl: secondFetch as unknown as typeof fetch,
    });

    expect(secondResult.status).toBe("sent");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it("isolates a poison outbox row while delivering healthy rows in the same batch", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    await store.saveArtifact("S001", "training_task_1", "healthy delivery");
    const poison = database.outboxRows.find((row) => row.payload.event === "artifact_saved");
    expect(poison).toBeDefined();
    if (!poison) {
      throw new Error("Missing seeded poison row.");
    }
    poison.payload = {
      ...poison.payload,
      event: "totally_unmapped_event",
    } as unknown as AaisEvent;
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));

    const result = await flushAaisPersistentLrsOutbox({
      database,
      config: {
        endpoint: "https://lrs.example.test/xapi",
        username: "test-user",
        password: "test-password",
      },
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxBatchSize: database.outboxRows.length,
    });

    expect(result).toMatchObject({ status: "partial", failed: 1 });
    expect(poison).toMatchObject({ status: "retry", attempts: 1 });
    expect(database.outboxRows.filter((row) => row !== poison).every((row) => row.status === "sent")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const posted = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as unknown[];
    expect(posted).toHaveLength(database.outboxRows.length - 1);
  });

  it("bisects deterministic LRS rejections without retrying healthy statements", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    await store.saveArtifact("S001", "training_task_1", "remote poison isolation");
    let rejectedStatementId: string | null = null;
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const statements = JSON.parse(String(init?.body)) as Array<{ id: string }>;
      rejectedStatementId ??= statements[0]?.id ?? null;
      return new Response(null, {
        status: statements.some((statement) => statement.id === rejectedStatementId) ? 400 : 204,
      });
    });

    const result = await flushAaisPersistentLrsOutbox({
      database,
      config: {
        endpoint: "https://lrs.example.test/xapi",
        username: "test-user",
        password: "test-password",
      },
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxBatchSize: database.outboxRows.length,
    });

    const rejectedRow = database.outboxRows.find((row) =>
      (row.xapi_statement as { id?: string } | null)?.id === rejectedStatementId
    );
    expect(result).toMatchObject({ status: "partial", failed: 1 });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(rejectedRow).toMatchObject({ status: "retry", attempts: 1 });
    expect(database.outboxRows.filter((row) => row !== rejectedRow).every((row) => row.status === "sent")).toBe(true);
  });

  it("bounds a slow 413 bisection tree, starts no fetch after budget, and resumes frozen rows", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    await store.saveArtifact("S001", "training_task_1", "bounded remote poison tree");
    const rowCount = database.outboxRows.length;
    const requestStartedAt: number[] = [];
    const postedBodies: string[] = [];
    const startedAt = Date.now();
    const slowRejection = vi.fn<typeof fetch>(async (_url, init) => {
      requestStartedAt.push(Date.now());
      postedBodies.push(String(init?.body));
      await new Promise<void>((resolve) => setTimeout(resolve, 12));
      return new Response(null, { status: 413 });
    });

    const result = await flushAaisPersistentLrsOutbox({
      database,
      config: {
        endpoint: "https://lrs.example.test/xapi",
        username: "test-user",
        password: "test-password",
      },
      fetchImpl: slowRejection as unknown as typeof fetch,
      maxBatchSize: rowCount,
      runtimeBudgetMs: 80,
      finalizeGuardMs: 15,
      requestTimeoutMs: 20,
    });
    const completedAt = Date.now();

    expect(result).toMatchObject({
      status: "partial",
      stoppedReason: "budget_exhausted",
      hasMore: true,
    });
    expect(result.deferred).toBeGreaterThan(0);
    expect(slowRejection.mock.calls.length).toBeGreaterThan(0);
    expect(slowRejection.mock.calls.length).toBeLessThan(2 * rowCount - 1);
    expect(requestStartedAt.every((time) => time - startedAt < 80)).toBe(true);
    expect(completedAt - startedAt).toBeLessThan(500);
    expect(database.getLearnerDeliveryFence("S001")).toEqual({ state: "idle", claimId: null });
    expect(database.outboxRows.every((row) =>
      row.status === "retry"
      && row.delivery_claim_id === null
      && row.xapi_statement !== null
    )).toBe(true);

    const callsAtCompletion = slowRejection.mock.calls.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(slowRejection).toHaveBeenCalledTimes(callsAtCompletion);

    const resumedFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    await expect(flushAaisPersistentLrsOutbox({
      database,
      config: {
        endpoint: "https://lrs.example.test/xapi",
        username: "test-user",
        password: "test-password",
      },
      fetchImpl: resumedFetch as unknown as typeof fetch,
      maxBatchSize: rowCount,
    })).resolves.toMatchObject({ status: "sent", sent: rowCount });
    expect(resumedFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(resumedFetch.mock.calls[0]?.[1]?.body))).toEqual(
      JSON.parse(postedBodies[0] ?? "[]"),
    );
  });

  it("does not bisect an ambiguous batch response or release its claim", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    await store.saveArtifact("S001", "training_task_1", "transient batch failure");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));

    const result = await flushAaisPersistentLrsOutbox({
      database,
      config: {
        endpoint: "https://lrs.example.test/xapi",
        username: "test-user",
        password: "test-password",
      },
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxBatchSize: database.outboxRows.length,
    });

    expect(result).toMatchObject({
      status: "partial",
      failed: database.outboxRows.length,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fence = database.getLearnerDeliveryFence("S001");
    expect(fence).toMatchObject({ state: "uncertain", claimId: expect.any(String) });
    expect(database.outboxRows.every((row) =>
      row.status === "sending"
      && row.attempts === 0
      && row.delivery_claim_id === fence.claimId
    )).toBe(true);
  });

  it("keeps legacy product events, analytics, exports, and LRS disabled on a research deployment", async () => {
    vi.stubEnv("AAIS_RESEARCH_REQUIRED", "true");
    vi.stubEnv("LRS_ENDPOINT", "https://legacy-mixed.example/xapi");
    vi.stubEnv("LRS_USERNAME", "legacy-user");
    vi.stubEnv("LRS_PASSWORD", "legacy-password");
    const database = createFakeDatabaseClient();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const store = createAaisLearningStore({ database });

    await store.getOrCreateSession("S001");
    await store.saveArtifact("S001", "training_task_1", "restricted study artifact");

    expect(database.eventRows).toEqual([]);
    expect(database.outboxRows).toEqual([]);
    expect(database.queries.some((query) => /^insert into aais_events/i.test(query.sql.trim()))).toBe(false);
    expect(database.queries.some((query) => /^insert into aais_lrs_outbox/i.test(query.sql.trim()))).toBe(false);
    expect(database.queries.some((query) => /insert into aais_learner_sessions/i.test(query.sql))).toBe(true);
    expect(database.queries.some((query) => /insert into aais_learner_task_state/i.test(query.sql))).toBe(true);

    await expect(flushAaisPersistentLrsOutbox({
      database,
      config: {
        endpoint: "https://legacy-mixed.example/xapi",
        username: "legacy-user",
        password: "legacy-password",
      },
      fetchImpl: fetchMock as unknown as typeof fetch,
    })).resolves.toEqual({
      status: "not_configured",
      sent: 0,
      failed: 0,
      deferred: 0,
      batches: 0,
      stoppedReason: "not_configured",
      hasMore: false,
      secrets: "redacted",
    });
    await expect(getAaisPersistentLrsOutboxStatus({ database })).resolves.toMatchObject({
      mode: "research-isolated",
      storage: "disabled",
      configured: false,
      total: 0,
    });
    await expect(store.exportEvents("S001", "json")).rejects.toThrow(
      "Legacy product analytics and event exports are disabled",
    );
    await expect(store.getAnalytics("S001")).rejects.toThrow(
      "Legacy product analytics and event exports are disabled",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dead-letters an unmappable outbox event instead of stalling every flush", async () => {
    // An event with no xAPI verb mapping makes buildAaisXapiStatement throw. The
    // persistent flush must treat that as a delivery failure (retry -> dead_letter),
    // not let the throw stall the whole outbox forever.
    const row = {
      id: "outbox-poison",
      status: "pending",
      attempts: 0,
      deliveryClaimId: null as string | null,
      leaseExpiresAt: null as number | null,
      payload: {
        student_id: "S001",
        session_id: "session-poison",
        phase: "practice",
        task: "practice_task_1",
        agent: "platform",
        event: "totally_unmapped_event",
        time: "2026-07-10T00:00:00.000Z",
        detail: {},
      },
    };
    let fetchCalled = false;
    const database = {
      async query(sql: string, params: unknown[] = []) {
        const trimmed = sql.trim();
        if (/^with candidate as \(\s*select id\s+from aais_lrs_outbox/i.test(trimmed)) {
          const processedIds = new Set((params[3] as string[]) ?? []);
          if (
            processedIds.has(row.id)
            || (row.status !== "pending" && row.status !== "retry")
          ) {
            return { rows: [] };
          }
          row.status = "sending";
          row.deliveryClaimId = String(params[1]);
          row.leaseExpiresAt = Date.now() + Number(params[2]) * 1_000;
          return {
            rows: [{ id: row.id, payload: row.payload, attempts: row.attempts }],
          };
        }
        if (/^update aais_lrs_outbox\s+set status = \$1/i.test(trimmed)) {
          if (row.status !== "sending" || row.deliveryClaimId !== String(params[2])) {
            return { rows: [] };
          }
          row.status = String(params[0]);
          row.attempts += 1;
          row.deliveryClaimId = null;
          row.leaseExpiresAt = null;
          return { rows: [{ id: row.id, status: row.status }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as AaisDatabaseClient;
    const fetchImpl = (async () => {
      fetchCalled = true;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const flushOnce = () =>
      flushAaisPersistentLrsOutbox({
        database,
        config: { endpoint: "https://lrs.example.test/xapi", username: "u", password: "p" },
        fetchImpl,
        maxAttempts: 3,
      });

    // Flush must resolve (never reject) and move the poison row off 'pending'.
    const first = await flushOnce();
    expect(first).toMatchObject({ status: "partial", failed: 1 });
    expect(row).toMatchObject({ status: "retry", attempts: 1 });

    // Repeated flushes progress it to dead_letter instead of blocking forever.
    await flushOnce();
    await flushOnce();
    expect(row).toMatchObject({ status: "dead_letter", attempts: 3 });

    // The failure happened while building the statement, before any HTTP call.
    expect(fetchCalled).toBe(false);
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
      fetchImpl: vi.fn<typeof fetch>(async () => new Response(null, { status: 422 })) as unknown as typeof fetch,
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
      fetchImpl: vi.fn<typeof fetch>(async () => new Response(null, { status: 422 })) as unknown as typeof fetch,
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
    expect(planningRows).toHaveLength(0);
    expect(artifactEditRows[0].payload.detail).toMatchObject({
      characters: 3,
      merged_events: 3,
      source: "debounced_server_save",
    });
    expect(artifactRows[0].payload.detail).toMatchObject({
      characters: 3,
      merged_events: 3,
    });
  });

  it("emits A3 supervision and A2 coaching when artifact autosaves show low progress", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });

    await store.saveArtifact("S001", "training_task_1", "我先写一点");
    const session = await store.saveArtifact("S001", "training_task_1", "我先写一点");

    expect(session.events.map((event) => event.event)).toEqual(
      expect.arrayContaining(["monitoring_pause_detected", "coaching_push"]),
    );
    expect(session.events.findLast((event) => event.event === "monitoring_pause_detected")?.agent).toBe("A3");
    expect(session.events.findLast((event) => event.event === "coaching_push")?.agent).toBe("A2");
  });

  it("emits A3 supervision and A2 coaching when artifact autosaves regress significantly", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    const originalArtifact = "计划".repeat(60);

    await store.saveArtifact("S001", "training_task_1", originalArtifact);
    const session = await store.saveArtifact("S001", "training_task_1", "计划调整");

    const monitoring = session.events.findLast((event) => event.event === "monitoring_pause_detected");
    const coaching = session.events.findLast((event) => event.event === "coaching_push");
    expect(monitoring?.agent).toBe("A3");
    expect(coaching?.agent).toBe("A2");
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
    expect(afterCooldown.events.filter((event) =>
      event.event === "monitoring_pause_detected"
      && event.detail.signal === "low_progress_artifact_autosave"
    )).toHaveLength(2);
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
    const guideExchange = await store.appendGuideExchange({
      studentId: "S001",
      phase: "practice",
      taskId: "training_task_1",
      question: "请给我一个可核验的建议",
      answer: "先列出一个可核验的下一步。",
      orchestration: {
        graphId: "learning-ai-guide",
        topologicalOrder: ["A2"],
        threadId: "acceptance-evidence",
      },
    });
    const assistantMessageId = guideExchange.exchange.assistantMessageId;
    expect(assistantMessageId).toBeTruthy();
    expect(guideExchange.session.guideMessages).toEqual([
      expect.objectContaining({ taskId: "training_task_1", phase: "training" }),
      expect.objectContaining({ taskId: "training_task_1", phase: "training" }),
    ]);

    const session = await store.recordAiAcceptance("S001", "training_task_1", {
      accepted: false,
      expectedPilotEvidenceRevision: 0,
      messageId: assistantMessageId,
      mutationId: "ai-acceptance-decision-1",
      reason: "需要自己先解释依据",
    });
    const duplicate = await store.recordAiAcceptance("S001", "training_task_1", {
      accepted: false,
      expectedPilotEvidenceRevision: 0,
      messageId: assistantMessageId,
      mutationId: "ai-acceptance-decision-1",
      reason: "需要自己先解释依据",
    });
    await expect(store.recordAiAcceptance("S001", "training_task_1", {
      accepted: false,
      expectedPilotEvidenceRevision: 1,
      messageId: assistantMessageId,
      mutationId: "ai-acceptance-decision-1",
      reason: "同一 mutation id 不得绑定不同理由",
    })).rejects.toMatchObject({ reason: "mutation_replay_conflict" });
    const unchanged = await store.recordAiAcceptance("S001", "training_task_1", {
      accepted: false,
      expectedPilotEvidenceRevision: 1,
      messageId: assistantMessageId,
      mutationId: "ai-acceptance-same-decision",
      reason: "新的提交仍然维持不采纳决定",
    });
    const changed = await store.recordAiAcceptance("S001", "training_task_1", {
      accepted: true,
      expectedPilotEvidenceRevision: 1,
      messageId: assistantMessageId,
      mutationId: "ai-acceptance-decision-2",
      reason: "改为采纳",
    });

    expect(session.tasks.find((task) => task.taskId === "training_task_1")
      ?.pilotEvidenceRevision).toBe(1);
    expect(duplicate.tasks.find((task) => task.taskId === "training_task_1")
      ?.pilotEvidenceRevision).toBe(1);
    expect(unchanged.tasks.find((task) => task.taskId === "training_task_1")
      ?.pilotEvidenceRevision).toBe(1);
    expect(changed.tasks.find((task) => task.taskId === "training_task_1")
      ?.pilotEvidenceRevision).toBe(2);
    await expect(store.savePilotEvidence("S001", "training_task_1", {
      diagnosisText: "旧标签页在 AI 采纳决策后尝试覆盖证据。",
    }, {
      expectedPilotEvidenceRevision: 1,
      mutationId: "stale-after-ai-acceptance",
    })).rejects.toMatchObject({ field: "pilot_evidence" });

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
    expect(unchanged.events.filter((candidate) => candidate.event === "ai_acceptance_recorded")).toHaveLength(1);
    expect(unchanged.events.filter((candidate) => candidate.event === "ai_acceptance_mutation_bound")).toHaveLength(2);
    expect(changed.events.filter((candidate) => candidate.event === "ai_acceptance_recorded")).toHaveLength(2);
    expect(changed.events.findLast((candidate) => candidate.event === "ai_acceptance_recorded")?.detail)
      .toMatchObject({
        accepted: true,
        decision_key: event?.detail.decision_key,
        revision: 2,
        supersedes_previous: true,
      });
    expect((await store.getAnalytics("S001")).dashboard.coachingEffect).toMatchObject({
      aiInteractions: 3,
      aiAcceptanceDecisions: 1,
    });
    expect(JSON.stringify(event)).not.toContain("需要自己先解释依据");
    expect(JSON.stringify(changed.events)).not.toContain("assistant-decision-1");
  });

  it("rejects a late AI acceptance from a stale tab without superseding the newer decision", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    const guideExchange = await store.appendGuideExchange({
      studentId: "late-ai-acceptance",
      phase: "training",
      taskId: "training_task_1",
      question: "请给我一个可评价的建议",
      answer: "先检查目标和证据。",
      orchestration: { graphId: "g", topologicalOrder: ["A2"], threadId: "late-tab" },
    });
    const assistantMessageId = guideExchange.exchange.assistantMessageId;

    const newer = await store.recordAiAcceptance(
      "late-ai-acceptance",
      "training_task_1",
      {
        accepted: true,
        expectedPilotEvidenceRevision: 0,
        messageId: assistantMessageId,
        mutationId: "newer-tab-acceptance",
        reason: "新标签页确认采纳",
      },
    );
    await expect(store.recordAiAcceptance(
      "late-ai-acceptance",
      "training_task_1",
      {
        accepted: false,
        expectedPilotEvidenceRevision: 0,
        messageId: assistantMessageId,
        mutationId: "late-stale-tab-rejection",
        reason: "旧标签页迟到的不采纳请求",
      },
    )).rejects.toMatchObject({ field: "pilot_evidence" });

    const current = await store.getOrCreateSession("late-ai-acceptance");
    expect(newer.tasks[0]?.pilotEvidenceRevision).toBe(1);
    expect(current.tasks[0]?.pilotEvidence).toMatchObject({ outputEvaluation: "accepted" });
    expect(current.tasks[0]?.pilotEvidenceRevision).toBe(1);
    expect(current.events.filter((event) => event.event === "ai_acceptance_recorded"))
      .toHaveLength(1);
  });

  it("rejects missing, fabricated, user, and cross-task AI acceptance targets without writes", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    const trainingExchange = await store.appendGuideExchange({
      studentId: "S001",
      phase: "practice",
      taskId: "training_task_1",
      question: "训练问题",
      answer: "训练回答",
      orchestration: { graphId: "g", topologicalOrder: ["A2"], threadId: "training" },
    });
    const trainingAssistantId = trainingExchange.exchange.assistantMessageId;
    await completeTrainingTask(store, "S001");
    await store.selectTask("S001", "practice_task_1");
    const practiceExchange = await store.appendGuideExchange({
      studentId: "S001",
      phase: "training",
      taskId: "practice_task_1",
      question: "练习问题",
      answer: "练习回答",
      orchestration: { graphId: "g", topologicalOrder: ["A2"], threadId: "practice" },
    });
    const practiceUserId = practiceExchange.exchange.userMessageId;
    const before = await store.getOrCreateSession("S001");
    const beforeAcceptanceEvents = before.events.filter(
      (event) => event.event === "ai_acceptance_recorded",
    );

    for (const messageId of [undefined, "assistant-fabricated", practiceUserId, trainingAssistantId]) {
      await expect(store.recordAiAcceptance("S001", "practice_task_1", {
        accepted: true,
        expectedPilotEvidenceRevision: 0,
        messageId,
        mutationId: `invalid-ai-target-${String(messageId)}`,
      })).rejects.toThrow("AAIS AI acceptance target was not found.");
    }

    const after = await store.getOrCreateSession("S001");
    expect(after.events.filter((event) => event.event === "ai_acceptance_recorded"))
      .toEqual(beforeAcceptanceEvents);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it("does not create a learner session for a fabricated AI acceptance target", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });

    await expect(store.recordAiAcceptance("acceptance-fabrication", "training_task_1", {
      accepted: true,
      expectedPilotEvidenceRevision: 0,
      messageId: "assistant-fabricated",
      mutationId: "fabricated-ai-target",
    })).rejects.toThrow("AAIS AI acceptance target was not found.");

    expect(database.hasSession("acceptance-fabrication")).toBe(false);
  });

  it("summarizes cohort analytics for teacher dashboards without raw learner text", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await completeTrainingTask(store, "S001");
    await store.selectTask("S001", "practice_task_1");
    await store.saveArtifact("S001", "practice_task_1", "第一位学习者的长过程记录");
    await store.requestScaffold("S001", "practice_task_1", "pause-prompt");
    await store.getOrCreateSession("S002");

    const analytics = summarizeAaisCohortAnalytics([
      await store.getOrCreateSession("S001"),
      await store.getOrCreateSession("S002"),
    ]);

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
    await completeTrainingTask(store, "S001");
    await store.selectTask("S001", "practice_task_1");
    await store.saveArtifact("S001", "practice_task_1", "第一位学习者的低进展风险记录");
    await store.saveArtifact("S001", "practice_task_1", "第一位学习者的低进展风险记录");
    await store.requestScaffold("S001", "practice_task_1", "pause-prompt");
    await store.requestScaffold("S001", "practice_task_1", "stage-checklist");
    await store.requestScaffold("S001", "practice_task_1", "sentence-starters");
    await store.requestScaffold("S001", "practice_task_1", "contrast-case");
    await store.requestScaffold("S001", "practice_task_1", "pause-prompt");

    await completeTrainingTask(store, "S002");
    await store.selectTask("S002", "practice_task_1");
    await store.saveSelfReport("S002", "practice_task_1", "第二位学习者已经完成反思");
    await store.selectStage("S002", "comparison");

    const analytics = summarizeAaisCohortAnalytics([
      await store.getOrCreateSession("S001"),
      await store.getOrCreateSession("S002"),
    ]);

    expect(analytics.dashboard.cohort.riskBreakdown).toEqual({
      high: 1,
      medium: 1,
      low: 0,
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
        riskLevel: "medium",
        priorityReasons: ["reflection_missing"],
      },
    ]);
    expect(JSON.stringify(analytics)).not.toContain("第一位学习者的低进展风险记录");
    expect(JSON.stringify(analytics)).not.toContain("第二位学习者已经完成反思");
  });

  it("counts A2 AI acceptance as an interaction for cohort risk after coaching", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await completeTrainingTask(store, "S001");
    await store.selectTask("S001", "practice_task_1");
    await store.saveArtifact("S001", "practice_task_1", "低进展记录");
    await store.saveArtifact("S001", "practice_task_1", "低进展记录");
    const guideExchange = await store.appendGuideExchange({
      studentId: "S001",
      phase: "training",
      taskId: "practice_task_1",
      question: "如何重组计划？",
      answer: "先说明目标，再拆分下一步。",
      orchestration: { graphId: "g", topologicalOrder: ["A2"], threadId: "risk" },
    });
    const assistantMessageId = guideExchange.exchange.assistantMessageId;
    await store.recordAiAcceptance("S001", "practice_task_1", {
      accepted: true,
      expectedPilotEvidenceRevision: 0,
      messageId: assistantMessageId,
      mutationId: "cohort-risk-ai-acceptance",
      reason: "采纳提示后重新组织计划",
    });

    const analytics = summarizeAaisCohortAnalytics([
      await store.getOrCreateSession("S001"),
    ]);

    expect(analytics.dashboard.cohort.aiInteractions).toBe(3);
    expect(analytics.dashboard.cohort.aiAcceptanceDecisions).toBe(1);
    expect(analytics.learners[0]).toMatchObject({
      coachingSignals: 2,
      aiInteractions: 3,
      aiAcceptanceDecisions: 1,
      priorityReasons: ["reflection_missing", "a2_coaching_signals"],
    });
    expect(analytics.learners[0].priorityReasons).not.toContain("no_ai_interaction_after_coaching");
    expect(JSON.stringify(analytics)).not.toContain("采纳提示后重新组织计划");
  });

  it("filters cohort analytics by enterprise join keys without raw event payloads", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    const rawSession = await completeTrainingTask(store, "S001");
    const rawSessionId = rawSession.sessionId;
    await store.selectTask("S001", "practice_task_1");
    await store.saveArtifact("S001", "practice_task_1", "第一位学习者的低进展记录");
    await store.saveArtifact("S001", "practice_task_1", "第一位学习者的低进展记录");
    await store.getOrCreateSession("S002");
    await store.saveArtifact("S002", "training_task_1", "第二位学习者的训练记录");

    const analytics = summarizeAaisCohortAnalytics([
      await store.getOrCreateSession("S001"),
      await store.getOrCreateSession("S002"),
    ], {
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
    expect(analytics.learners[0]).toMatchObject({
      sessionKey: expect.stringMatching(/^session-v2-[a-f0-9]{32}$/),
    });
    expect(analytics.learners[0]).not.toHaveProperty("sessionId");
    expect(JSON.stringify(analytics)).not.toContain("S001");
    expect(JSON.stringify(analytics)).not.toContain(rawSessionId);
    expect(JSON.stringify(analytics)).not.toContain("第一位学习者的低进展记录");
    expect(JSON.stringify(analytics)).not.toContain("第二位学习者的训练记录");
  });

  it("summarizes database cohort analytics from aais_events without scanning session blobs", async () => {
    const database = createFakeDatabaseClient();
    database.seedEnrollment({
      user_id: "teacher-a",
      course_id: "course-a",
      cohort: "alpha",
      role: "teacher",
      status: "active",
    });
    for (const userId of ["S001", "S002"]) {
      database.seedEnrollment({
        user_id: userId,
        course_id: "course-a",
        cohort: "alpha",
        role: "student",
        status: "active",
      });
    }
    const store = createAaisLearningStore({ database });
    const rawSession = await completeTrainingTask(store, "S001");
    await store.selectTask("S001", "practice_task_1");
    await store.saveArtifact("S001", "practice_task_1", "第一位学习者的数据库低进展记录");
    await store.saveArtifact("S001", "practice_task_1", "第一位学习者的数据库低进展记录");
    await store.getOrCreateSession("S002");

    database.queries.length = 0;
    const analytics = await store.getEducatorCohortAnalytics({
      actorId: "teacher-a",
      actorRole: "teacher",
    }, {
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
          trainingCompleted: 1,
          coachingSignals: 1,
          aiInteractions: 0,
        },
      },
      learners: [
        {
          trainingCompleted: true,
          activePracticeTaskId: "practice_task_1",
          coachingSignals: 1,
          aiInteractions: 0,
        },
      ],
      integrations: {
        factLayer: "aais_events",
      },
    });
    expect(analytics.learners[0].learnerKey).toMatch(/^learner-v2-[a-f0-9]{32}$/);
    expect(analytics.learners[0].sessionKey).toMatch(/^session-v2-[a-f0-9]{32}$/);
    expect(JSON.stringify(analytics)).not.toContain("S001");
    expect(JSON.stringify(analytics)).not.toContain(rawSession.sessionId);
    expect(JSON.stringify(analytics)).not.toContain("第一位学习者的数据库低进展记录");
    expect(database.queries.some((query) =>
      /matching_sessions as/i.test(query.sql) && /from aais_events/i.test(query.sql)
    )).toBe(true);
    expect(database.queries.some((query) =>
      /^select payload(?:,\s*version)? from aais_learner_sessions order by/i.test(query.sql.trim())
    )).toBe(false);
  });

  it("keeps SQL cohort analytics flat for 500 simulated learners", async () => {
    const database = createFakeDatabaseClient();
    database.seedEventRows(createFakeCohortPerformanceRows(500));
    database.seedEnrollment({
      user_id: "teacher-a",
      course_id: "cognitive-apprenticeship",
      cohort: "perf-cohort",
      role: "teacher",
      status: "active",
    });
    for (let index = 0; index < 500; index += 1) {
      database.seedEnrollment({
        user_id: `S-perf-${String(index).padStart(3, "0")}`,
        course_id: "cognitive-apprenticeship",
        cohort: "perf-cohort",
        role: "student",
        status: "active",
      });
    }
    const store = createAaisLearningStore({ database });
    const durations: number[] = [];
    let analytics: Awaited<ReturnType<typeof store.getEducatorCohortAnalytics>> | null = null;

    for (let run = 0; run < 5; run += 1) {
      const startedAt = performance.now();
      analytics = await store.getEducatorCohortAnalytics({
        actorId: "teacher-a",
        actorRole: "teacher",
      }, {
        phase: "practice",
        agent: "A2",
        event: "coaching_push",
      });
      durations.push(performance.now() - startedAt);
    }

    const p95 = [...durations].sort((left, right) => left - right)[Math.ceil(durations.length * 0.95) - 1] ?? 0;
    expect(p95).toBeLessThan(500);
    expect(analytics?.dashboard.cohort.learnerCount).toBe(500);
    expect(analytics?.integrations.factLayer).toBe("aais_events");
    expect(database.queries.filter((query) =>
      /matching_sessions as/i.test(query.sql) && /from aais_events/i.test(query.sql)
    )).toHaveLength(5);
    expect(database.queries.some((query) =>
      /^select payload(?:,\s*version)? from aais_learner_sessions order by/i.test(query.sql.trim())
    )).toBe(false);
  });

  it("paginates cohort learner rows while preserving full aggregate totals", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    const sessions = await Promise.all([
      store.getOrCreateSession("S001"),
      store.getOrCreateSession("S002"),
      store.getOrCreateSession("S003"),
    ]);

    const analytics = summarizeAaisCohortAnalytics(sessions, {}, {
      limit: 2,
      offset: 1,
    });

    expect(analytics.dashboard.cohort.learnerCount).toBe(3);
    expect(analytics.learners).toHaveLength(2);
    expect(analytics.pagination).toEqual({
      limit: 2,
      offset: 1,
      returnedLearners: 2,
      totalLearners: 3,
      hasPreviousPage: true,
      hasNextPage: false,
    });
  });

  it("summarizes pseudonymous cohort session keys instead of internal learner session ids", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    const rawSession = await completeTrainingTask(store, "S001");
    await store.selectTask("S001", "practice_task_1");
    await store.saveArtifact("S001", "practice_task_1", "第一位学习者的导出隐私记录");

    const body = summarizeAaisCohortAnalytics([
      await store.getOrCreateSession("S001"),
    ]);
    const serialized = JSON.stringify(body);

    expect(body.learners[0]).toMatchObject({
      learnerKey: expect.stringMatching(/^learner-v2-[a-f0-9]{32}$/),
      sessionKey: expect.stringMatching(/^session-v2-[a-f0-9]{32}$/),
    });
    expect(body.learners[0]).not.toHaveProperty("sessionId");
    expect(serialized).not.toContain(rawSession.sessionId);
    expect(serialized).not.toContain("S001");
    expect(serialized).not.toContain("第一位学习者的导出隐私记录");
  });

  it("fails closed for the default production store when Postgres is not configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("AAIS_DATABASE_URL", "");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("POSTGRES_URL", "");
    vi.stubEnv("POSTGRES_PRISMA_URL", "");
    vi.stubEnv("POSTGRES_URL_NO_SSL", "");
    vi.stubEnv("DATABASE_URL_UNPOOLED", "");
    vi.stubEnv("POSTGRES_URL_NON_POOLING", "");
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

  it("uses the Vercel Postgres no-SSL URL alias when it is the configured fallback", () => {
    vi.stubEnv("POSTGRES_URL_NO_SSL", "postgres://aais:no-ssl@no-ssl.neon.tech/aais");

    expect(getAaisDatabaseConfiguration()).toMatchObject({
      sourceEnv: "POSTGRES_URL_NO_SSL",
      url: "postgres://aais:no-ssl@no-ssl.neon.tech/aais",
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

type FakeAaisEventRow = {
  id: string;
  student_id: string;
  session_id: string;
  phase: string;
  task: string;
  agent: string;
  event: string;
  event_time: string;
  detail: Record<string, unknown>;
};

type FakeLearnerTaskStateRow = {
  student_id: string;
  session_id: string;
  task: string;
  phase: string;
  status: string;
  artifact_characters: number;
  self_report_characters: number;
  scaffold_requests: number;
  updated_at: string;
};

type FakeEnrollmentRow = {
  user_id: string;
  course_id: string;
  cohort: string;
  role: "student" | "teacher" | "admin";
  status: "active" | "withdrawn";
};

function summarizeFakeSqlCohortRows(
  events: FakeAaisEventRow[],
  params: unknown[],
  sessionPayloads?: Map<string, { payload: unknown; version: number }>,
) {
  const [phase, task, agent, eventName, cohort, role, courseId] = params.map(readNullableFakeFilter);
  const matchingSessionKeys = new Set(
    events
      .filter((event) => matchesFakeSqlCohortFilters(event, {
        phase,
        task,
        agent,
        eventName,
        cohort,
        role,
        courseId,
      }))
      .map(createFakeSessionKey),
  );
  const groups = new Map<string, {
    student_id: string;
    session_id: string;
    all: FakeAaisEventRow[];
    filtered: FakeAaisEventRow[];
  }>();
  for (const event of events) {
    const key = createFakeSessionKey(event);
    if (!matchingSessionKeys.has(key)) {
      continue;
    }
    const group = groups.get(key) ?? {
      student_id: event.student_id,
      session_id: event.session_id,
      all: [],
      filtered: [],
    };
    group.all.push(event);
    if (matchesFakeSqlCohortFilters(event, {
      phase,
      task,
      agent,
      eventName,
      cohort,
      role,
      courseId,
    })) {
      group.filtered.push(event);
    }
    groups.set(key, group);
  }

  return Array.from(groups.values())
    .map((group) => {
      const allEvents = [...group.all].sort(compareFakeAaisEventsDesc);
      const storedSessionRow = sessionPayloads?.get(group.student_id);
      const storedSession = storedSessionRow
        ? readFakeLearnerSession(storedSessionRow.payload)
        : null;
      const localReflectionEvidenceCount = storedSession?.sessionId === group.session_id
        && (!agent || agent === "A4")
        && (!eventName || [
          "expert_trace_compared",
          "a4_reflection_report_generated",
        ].includes(eventName))
        ? storedSession.tasks.filter((candidate) =>
            (!phase || candidate.phase === phase)
            && (!task || candidate.taskId === task)
            && hasFakeValidReflectionReport(candidate.reflectionReport)
          ).length
        : 0;
      const activePracticeEvent = allEvents.find((event) =>
        event.phase === "practice"
        && event.task
        && fakeActivePracticeTaskEvents.has(event.event)
      );
      const aiAcceptanceDecisionKeys = new Set(
        group.filtered
          .filter((event) => event.event === "ai_acceptance_recorded")
          .map((event) => readFakeDetailText(event.detail, "decision_key") || event.id),
      );
      return {
        student_id: group.student_id,
        session_id: group.session_id,
        updated_at: allEvents[0]?.event_time ?? new Date(0).toISOString(),
        training_completed: group.all.some((event) =>
          event.phase === "training" && event.event === "task_completed"
        ),
        active_practice_task_id: activePracticeEvent?.task ?? null,
        completed_practice_tasks: new Set(
          group.all
            .filter((event) => event.phase === "practice" && event.event === "task_completed")
            .map((event) => event.task),
        ).size,
        scaffold_requests: countFakeEvents(group.filtered, ["scaffold_request"]),
        coaching_signals: countFakeEvents(group.filtered, ["coaching_push", "monitoring_pause_detected"]),
        ai_prompt_response_events: countFakeEvents(group.filtered, [
          "ai_prompt_submitted",
          "ai_response_completed",
        ]),
        ai_acceptance_decisions: aiAcceptanceDecisionKeys.size,
        self_report_count: countFakeEvents(group.filtered, ["self_report_saved"]),
        expert_trace_count: Math.max(
          countFakeEvents(group.filtered, ["expert_trace_compared"]),
          localReflectionEvidenceCount,
        ),
      };
    })
    .sort((left, right) =>
      Date.parse(String(right.updated_at)) - Date.parse(String(left.updated_at))
      || String(left.student_id).localeCompare(String(right.student_id))
    );
}

const fakeActivePracticeTaskEvents = new Set([
  "task_selected",
  "task_completed",
  "artifact_saved",
  "artifact_edited",
  "self_report_saved",
  "scaffold_request",
  "coaching_push",
  "monitoring_pause_detected",
  "ai_prompt_submitted",
  "ai_response_completed",
  "ai_acceptance_recorded",
  "expert_trace_compared",
]);

function readNullableFakeFilter(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function matchesFakeSqlCohortFilters(
  event: FakeAaisEventRow,
  filters: {
    phase: string | null | undefined;
    task: string | null | undefined;
    agent: string | null | undefined;
    eventName: string | null | undefined;
    cohort: string | null | undefined;
    role: string | null | undefined;
    courseId: string | null | undefined;
  },
) {
  return (!filters.phase || event.phase === filters.phase)
    && (!filters.task || event.task === filters.task)
    && (!filters.agent || event.agent === filters.agent)
    && (!filters.eventName || event.event === filters.eventName)
    && (!filters.cohort || readFakeDetailText(event.detail, "cohort") === filters.cohort)
    && (!filters.role || readFakeDetailText(event.detail, "role") === filters.role)
    && (
      !filters.courseId
      || readFakeDetailText(event.detail, "course_id") === filters.courseId
      || readFakeDetailText(event.detail, "courseId") === filters.courseId
    );
}

function createFakeSessionKey(event: FakeAaisEventRow) {
  return `${event.student_id}\0${event.session_id}`;
}

function compareFakeAaisEventsDesc(left: FakeAaisEventRow, right: FakeAaisEventRow) {
  return Date.parse(right.event_time) - Date.parse(left.event_time)
    || right.id.localeCompare(left.id);
}

function countFakeEvents(events: FakeAaisEventRow[], names: string[]) {
  const wanted = new Set(names);
  return events.filter((event) => wanted.has(event.event)).length;
}

function createFakeCohortPerformanceRows(learnerCount: number) {
  const rows: FakeAaisEventRow[] = [];
  const baseTime = Date.UTC(2026, 0, 1, 0, 0, 0);
  for (let index = 0; index < learnerCount; index += 1) {
    const studentId = `S-perf-${String(index).padStart(3, "0")}`;
    const sessionId = `session-perf-${String(index).padStart(3, "0")}`;
    const detail = {
      cohort: "perf-cohort",
      role: "learner",
      course_id: "cognitive-apprenticeship",
    };
    rows.push(
      createFakeAaisEventRow({
        id: `${studentId}-training-complete`,
        studentId,
        sessionId,
        phase: "training",
        task: "training_task_1",
        agent: "A1",
        event: "task_completed",
        eventTime: new Date(baseTime + index * 1_000).toISOString(),
        detail,
      }),
      createFakeAaisEventRow({
        id: `${studentId}-practice-selected`,
        studentId,
        sessionId,
        phase: "practice",
        task: "practice_task_1",
        agent: "A1",
        event: "task_selected",
        eventTime: new Date(baseTime + index * 1_000 + 100).toISOString(),
        detail,
      }),
      createFakeAaisEventRow({
        id: `${studentId}-coaching-push`,
        studentId,
        sessionId,
        phase: "practice",
        task: "practice_task_1",
        agent: "A2",
        event: "coaching_push",
        eventTime: new Date(baseTime + index * 1_000 + 200).toISOString(),
        detail,
      }),
    );
  }
  return rows;
}

function createFakeAaisEventRow(input: {
  id: string;
  studentId: string;
  sessionId: string;
  phase: string;
  task: string;
  agent: string;
  event: string;
  eventTime: string;
  detail: Record<string, unknown>;
}): FakeAaisEventRow {
  return {
    id: input.id,
    student_id: input.studentId,
    session_id: input.sessionId,
    phase: input.phase,
    task: input.task,
    agent: input.agent,
    event: input.event,
    event_time: input.eventTime,
    detail: input.detail,
  };
}

function getFakeAccessibleStudentIds(
  enrollments: FakeEnrollmentRow[],
  actorId: string,
  actorRole: string,
  filters: { cohort?: unknown; role?: unknown; courseId?: unknown } = {},
) {
  const educatorScopes = enrollments.filter((row) =>
    row.user_id === actorId
    && row.role === actorRole
    && row.status === "active"
  );
  const activeStudentRows = new Map<string, FakeEnrollmentRow[]>();
  for (const row of enrollments) {
    if (row.role === "student" && row.status === "active") {
      activeStudentRows.set(row.user_id, [
        ...(activeStudentRows.get(row.user_id) ?? []),
        row,
      ]);
    }
  }
  return new Set(Array.from(activeStudentRows)
    .filter(([, rows]) => rows.length === 1)
    .filter(([, rows]) => {
      const row = rows[0];
      return Boolean(row)
        && educatorScopes.some((scope) =>
          scope.course_id === row?.course_id && scope.cohort === row?.cohort
        )
        && (!filters.cohort || filters.cohort === row?.cohort)
        && (!filters.role || filters.role === row?.role)
        && (!filters.courseId || filters.courseId === row?.course_id);
    })
    .map(([studentId]) => studentId));
}

function readFakeDetailText(detail: Record<string, unknown>, key: string) {
  const value = detail[key];
  return typeof value === "string" && value ? value : null;
}

function readFakeLearnerSession(payload: unknown) {
  return (typeof payload === "string" ? JSON.parse(payload) : payload) as AaisLearnerSession;
}

function hasFakeValidReflectionReport(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const report = value as Record<string, unknown>;
  return typeof report.version === "string"
    && report.version.trim().length > 0
    && typeof report.expertModelId === "string"
    && report.expertModelId.trim().length > 0
    && Array.isArray(report.expertStepIds)
    && report.expertStepIds.length > 0;
}

function createFakeDatabaseClient() {
  const learnerDataGenerations = new Map<string, number>();
  const learnerDeliveryFences = new Map<string, {
    state: "idle" | "in_flight" | "uncertain";
    claimId: string | null;
  }>();
  const lrsDeliveryAttempts = new Map<string, {
    state: "in_flight" | "uncertain" | "acknowledged" | "rejected"
      | "partially_acknowledged" | "not_dispatched" | "reconciled";
    statements: Array<{
      outboxId: string;
      studentId: string;
      dataGeneration: number;
      statementId: string;
      frozenStatement: unknown;
    }>;
    reconcileAfter: string;
    requestTimeoutMs: number;
    maxAttempts: number;
    evidenceSha256?: string;
    observedAt?: string;
    reconciledAt?: string;
    result?: "stored" | "absent" | "mixed";
    storedCount?: number;
    absentCount?: number;
  }>();
  const sessions = new Map<string, {
    payload: unknown;
    version: number;
  }>();
  const outbox = new Map<string, {
    id: string;
    payload: AaisEvent;
    status: string;
    attempts: number;
    delivery_claim_id: string | null;
    lease_expires_at: number | null;
    pending_payload: AaisEvent | null;
    xapi_statement: unknown | null;
  }>();
  const events = new Map<string, FakeAaisEventRow>();
  const taskState = new Map<string, FakeLearnerTaskStateRow>();
  const enrollments: FakeEnrollmentRow[] = [];
  const dailyGuideUsage = new Map<string, number>();
  const guideReservations = new Map<string, {
    id: string;
    student_id: string;
    usage_day: string;
    state: "reserved" | "dispatched" | "completed" | "released";
    expires_at: string;
  }>();
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let atomicWriteFailureStage: "session" | "task" | "event" | "outbox" | null = null;

  return {
    eventRows: Array.from(events.values()),
    outboxRows: Array.from(outbox.values()),
    taskStateRows: Array.from(taskState.values()),
    queries,
    hasSession(studentId: string) {
      return sessions.has(studentId);
    },
    getSessionVersion(studentId: string) {
      return sessions.get(studentId)?.version ?? null;
    },
    getDailyGuideUsageKeys(studentId: string) {
      return Array.from(dailyGuideUsage.keys()).filter((key) =>
        key.startsWith(`${studentId}\0`)
      );
    },
    seedSessionPayload(studentId: string, payload: unknown, version = 0) {
      sessions.set(studentId, { payload, version });
    },
    deleteLearnerDataGeneration(studentId: string) {
      learnerDataGenerations.delete(studentId);
      learnerDeliveryFences.delete(studentId);
    },
    getLearnerDeliveryFence(studentId: string) {
      return learnerDeliveryFences.get(studentId) ?? { state: "idle", claimId: null };
    },
    getLrsDeliveryAttempt(claimId: string) {
      return lrsDeliveryAttempts.get(claimId) ?? null;
    },
    simulatePersistedLrsWorkerCrash(claimId: string) {
      const attempt = lrsDeliveryAttempts.get(claimId);
      if (attempt && attempt.state === "uncertain") {
        attempt.state = "in_flight";
      }
      for (const [studentId, fence] of learnerDeliveryFences) {
        if (fence.claimId === claimId && fence.state === "uncertain") {
          learnerDeliveryFences.set(studentId, { state: "in_flight", claimId });
        }
      }
    },
    failNextAtomicWriteAt(stage: "session" | "task" | "event" | "outbox") {
      atomicWriteFailureStage = stage;
    },
    seedEventRows(rows: FakeAaisEventRow[]) {
      for (const row of rows) {
        events.set(row.id, row);
      }
      this.eventRows = Array.from(events.values());
    },
    seedEnrollment(row: FakeEnrollmentRow) {
      enrollments.push(structuredClone(row));
    },
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      if (/^(create|alter) table/i.test(sql.trim())) {
        return { rows: [] };
      }
      if (/^insert into aais_learner_data_generations/i.test(sql.trim())) {
        const studentId = String(params[0]);
        const dataGeneration = learnerDataGenerations.get(studentId) ?? 1;
        learnerDataGenerations.set(studentId, dataGeneration);
        if (!learnerDeliveryFences.has(studentId)) {
          learnerDeliveryFences.set(studentId, { state: "idle", claimId: null });
        }
        return { rows: [{ data_generation: dataGeneration }] };
      }
      if (/^with expected as materialized \(/i.test(sql.trim())) {
        const expected = JSON.parse(String(params[0])) as Array<{
          student_id: string;
          data_generation: number;
        }>;
        const attemptStatements = JSON.parse(String(params[1])) as Array<{
          outbox_id: string;
          student_id: string;
          data_generation: number;
          statement_id: string;
          frozen_statement: unknown;
        }>;
        const rowIds = attemptStatements.map((statement) => statement.outbox_id);
        const claimId = String(params[2]);
        const validClaimRows = rowIds.filter((id) => {
          const row = outbox.get(id);
          return Boolean(
            row
            && row.delivery_claim_id === claimId
            && row.status === "sending"
            && expected.some((candidate) => candidate.student_id === row.payload.student_id)
            && attemptStatements.some((statement) =>
              statement.outbox_id === id
              && statement.student_id === row.payload.student_id
              && JSON.stringify(statement.frozen_statement) === JSON.stringify(row.xapi_statement)
            ),
          );
        });
        if (validClaimRows.length !== rowIds.length) {
          return { rows: [] };
        }
        const acquired: Array<{ student_id: string }> = [];
        for (const candidate of expected) {
          const fence = learnerDeliveryFences.get(candidate.student_id) ?? {
            state: "idle" as const,
            claimId: null,
          };
          if (
            learnerDataGenerations.get(candidate.student_id) === Number(candidate.data_generation)
            && fence.state === "idle"
          ) {
            learnerDeliveryFences.set(candidate.student_id, {
              state: "in_flight",
              claimId,
            });
            acquired.push({ student_id: candidate.student_id });
          }
        }
        if (acquired.length === expected.length) {
          lrsDeliveryAttempts.set(claimId, {
            state: "in_flight",
            statements: attemptStatements.map((statement) => ({
              outboxId: statement.outbox_id,
              studentId: statement.student_id,
              dataGeneration: statement.data_generation,
              statementId: statement.statement_id,
              frozenStatement: structuredClone(statement.frozen_statement),
            })),
            reconcileAfter: new Date(Math.max(
              new Date(String(params[6])).getTime(),
              Date.now() + Number(params[7]),
            )).toISOString(),
            requestTimeoutMs: Number(params[4]),
            maxAttempts: Number(params[5]),
          });
        }
        return { rows: acquired };
      }
      if (
        /^with locked_attempt as materialized \(/i.test(sql.trim())
        && /set state = 'uncertain'/i.test(sql)
      ) {
        const claimId = String(params[0]);
        const attempt = lrsDeliveryAttempts.get(claimId);
        if (!attempt || (attempt.state !== "in_flight" && attempt.state !== "uncertain")) {
          return { rows: [] };
        }
        attempt.state = "uncertain";
        const finalized: Array<{ student_id: string }> = [];
        for (const [studentId, fence] of learnerDeliveryFences) {
          if (fence.claimId === claimId && (fence.state === "in_flight" || fence.state === "uncertain")) {
            learnerDeliveryFences.set(studentId, { state: "uncertain", claimId });
            finalized.push({ student_id: studentId });
          }
        }
        return { rows: finalized };
      }
      if (
        /^with provided as materialized \(/i.test(sql.trim())
        && /candidate\.statement_id, candidate\.status/i.test(sql)
      ) {
        const claimId = String(params[0]);
        const evidence = JSON.parse(String(params[1])) as Array<{
          statement_id: string;
          status: "stored" | "absent";
        }>;
        const evidenceSha256 = String(params[2]);
        const observedAt = String(params[3]);
        const reconciledAt = String(params[4]);
        const attempt = lrsDeliveryAttempts.get(claimId);
        if (!attempt) {
          return { rows: [] };
        }
        if (attempt.state === "reconciled") {
          return attempt.evidenceSha256 === evidenceSha256
              && attempt.observedAt === observedAt
            ? { rows: [{
                claim_id: claimId,
                result: attempt.result,
                statement_count: attempt.statements.length,
                stored_count: attempt.storedCount,
                absent_count: attempt.absentCount,
                reconciled_at: attempt.reconciledAt,
              }] }
            : { rows: [] };
        }
        const exactIds = new Set(attempt.statements.map((statement) => statement.statementId));
        const suppliedIds = new Set(evidence.map((statement) => statement.statement_id));
        if (
          (attempt.state !== "in_flight" && attempt.state !== "uncertain")
          || new Date(observedAt).getTime() <= new Date(attempt.reconcileAfter).getTime()
          || new Date(observedAt).getTime() > new Date(reconciledAt).getTime()
          || evidence.length !== attempt.statements.length
          || suppliedIds.size !== evidence.length
          || [...exactIds].some((statementId) => !suppliedIds.has(statementId))
        ) {
          return { rows: [] };
        }
        const evidenceById = new Map(
          evidence.map((statement) => [statement.statement_id, statement.status]),
        );
        const candidateRows = attempt.statements.map((statement) => ({
          statement,
          row: outbox.get(statement.outboxId),
          status: evidenceById.get(statement.statementId),
        }));
        if (candidateRows.some(({ statement, row, status }) =>
          !row
          || !status
          || row.status !== "sending"
          || row.delivery_claim_id !== claimId
          || JSON.stringify(row.xapi_statement) !== JSON.stringify(statement.frozenStatement)
        )) {
          return { rows: [] };
        }
        for (const statement of attempt.statements) {
          const fence = learnerDeliveryFences.get(statement.studentId);
          if (
            learnerDataGenerations.get(statement.studentId) !== statement.dataGeneration
            || !fence
            || fence.claimId !== claimId
            || (fence.state !== "in_flight" && fence.state !== "uncertain")
          ) {
            return { rows: [] };
          }
        }
        let storedCount = 0;
        let absentCount = 0;
        for (const { row, status } of candidateRows) {
          if (!row || !status) continue;
          if (status === "stored") {
            storedCount += 1;
            const pending = row.pending_payload;
            row.payload = pending ?? row.payload;
            row.status = pending ? "pending" : "sent";
            row.attempts = pending ? 0 : row.attempts;
            row.xapi_statement = pending ? null : row.xapi_statement;
            row.pending_payload = null;
          } else {
            absentCount += 1;
            row.attempts += 1;
            row.status = row.attempts >= attempt.maxAttempts ? "dead_letter" : "retry";
          }
          row.delivery_claim_id = null;
          row.lease_expires_at = null;
        }
        for (const statement of attempt.statements) {
          learnerDeliveryFences.set(statement.studentId, { state: "idle", claimId: null });
        }
        attempt.state = "reconciled";
        attempt.evidenceSha256 = evidenceSha256;
        attempt.observedAt = observedAt;
        attempt.reconciledAt = reconciledAt;
        attempt.storedCount = storedCount;
        attempt.absentCount = absentCount;
        attempt.result = storedCount === attempt.statements.length
          ? "stored"
          : absentCount === attempt.statements.length ? "absent" : "mixed";
        this.outboxRows = Array.from(outbox.values());
        return { rows: [{
          claim_id: claimId,
          result: attempt.result,
          statement_count: attempt.statements.length,
          stored_count: storedCount,
          absent_count: absentCount,
          reconciled_at: reconciledAt,
        }] };
      }
      if (
        /^with provided as materialized \(/i.test(sql.trim())
        && /candidate\.outbox_id, candidate\.disposition/i.test(sql)
      ) {
        const claimId = String(params[0]);
        const outcomes = JSON.parse(String(params[1])) as Array<{
          outbox_id: string;
          disposition: "sent" | "failed" | "not_dispatched";
        }>;
        const attempt = lrsDeliveryAttempts.get(claimId);
        if (!attempt || attempt.state !== "in_flight") {
          return { rows: [] };
        }
        const candidateRows = outcomes.map((outcome) => ({
          outcome,
          row: outbox.get(outcome.outbox_id),
        }));
        if (candidateRows.some(({ row }) =>
          !row || row.status !== "sending" || row.delivery_claim_id !== claimId
        )) {
          return { rows: [] };
        }
        const maxAttempts = Number(params[2]);
        const returned: Array<Record<string, unknown>> = [];
        for (const { outcome, row } of candidateRows) {
          if (!row) continue;
          if (outcome.disposition === "sent") {
            const pending = row.pending_payload;
            row.payload = pending ?? row.payload;
            row.status = pending ? "pending" : "sent";
            row.attempts = pending ? 0 : row.attempts;
            row.xapi_statement = pending ? null : row.xapi_statement;
            row.pending_payload = null;
          } else if (outcome.disposition === "failed") {
            row.attempts += 1;
            row.status = row.attempts >= maxAttempts ? "dead_letter" : "retry";
          } else {
            row.status = "retry";
          }
          row.delivery_claim_id = null;
          row.lease_expires_at = null;
          returned.push({
            id: row.id,
            status: row.status,
            disposition: outcome.disposition,
          });
        }
        const sentCount = outcomes.filter((outcome) => outcome.disposition === "sent").length;
        const failedCount = outcomes.filter((outcome) => outcome.disposition === "failed").length;
        const notDispatchedCount = outcomes.length - sentCount - failedCount;
        attempt.state = sentCount === outcomes.length
          ? "acknowledged"
          : failedCount === outcomes.length
            ? "rejected"
            : notDispatchedCount === outcomes.length
              ? "not_dispatched"
              : "partially_acknowledged";
        let generationCount = 0;
        for (const [studentId, fence] of learnerDeliveryFences) {
          if (fence.state === "in_flight" && fence.claimId === claimId) {
            learnerDeliveryFences.set(studentId, { state: "idle", claimId: null });
            generationCount += 1;
          }
        }
        this.outboxRows = Array.from(outbox.values());
        return {
          rows: returned.map((row) => ({
            ...row,
            attempt_state: attempt.state,
            generation_count: generationCount,
          })),
        };
      }
      if (
        /^update aais_learner_data_generations\s+set lrs_delivery_state = 'idle'/i.test(sql.trim())
      ) {
        const claimId = String(params[0]);
        const released: Array<{ student_id: string }> = [];
        for (const [studentId, fence] of learnerDeliveryFences) {
          if (fence.state === "in_flight" && fence.claimId === claimId) {
            learnerDeliveryFences.set(studentId, { state: "idle", claimId: null });
            released.push({ student_id: studentId });
          }
        }
        return { rows: released };
      }
      if (
        /^update aais_learner_data_generations\s+set lrs_delivery_state = case/i.test(sql.trim())
      ) {
        const claimId = String(params[0]);
        const uncertainStudents = new Set((params[1] as string[]) ?? []);
        const claimedStudents = new Set((params[2] as string[]) ?? []);
        const finalized: Array<{ student_id: string; lrs_delivery_state: string }> = [];
        for (const studentId of claimedStudents) {
          const fence = learnerDeliveryFences.get(studentId);
          if (fence?.state !== "in_flight" || fence.claimId !== claimId) {
            continue;
          }
          const state = uncertainStudents.has(studentId) ? "uncertain" : "idle";
          learnerDeliveryFences.set(studentId, {
            state,
            claimId: state === "uncertain" ? claimId : null,
          });
          finalized.push({ student_id: studentId, lrs_delivery_state: state });
        }
        return { rows: finalized };
      }
      if (/^select exists \([\s\S]*from aais_enrollments educator/i.test(sql.trim())) {
        return {
          rows: [{
            authorized: enrollments.some((row) =>
              row.user_id === String(params[0])
              && row.role === String(params[1])
              && row.status === "active"
            ),
          }],
        };
      }
      if (/^select exists \([\s\S]*learner_scope/i.test(sql.trim())) {
        return {
          rows: [{
            authorized: getFakeAccessibleStudentIds(
              enrollments,
              String(params[1]),
              String(params[2]),
            ).has(String(params[0])),
          }],
        };
      }
      if (/^with unambiguous_active_learner_scope as materialized/i.test(sql.trim())
        && /matching_sessions as/i.test(sql)) {
        const accessible = getFakeAccessibleStudentIds(
          enrollments,
          String(params[0]),
          String(params[1]),
          {
            cohort: params[6],
            role: params[7],
            courseId: params[8],
          },
        );
        return {
          rows: summarizeFakeSqlCohortRows(
            Array.from(events.values()).filter((event) => accessible.has(event.student_id)),
            [params[2], params[3], params[4], params[5], null, null, null],
            sessions,
          ),
        };
      }
      if (/^with unambiguous_active_learner_scope as materialized/i.test(sql.trim())
        && /select\s+session\.student_id,[\s\S]*as session_id/i.test(sql)) {
        const accessible = getFakeAccessibleStudentIds(
          enrollments,
          String(params[0]),
          String(params[1]),
        );
        return {
          rows: Array.from(sessions.entries())
            .filter(([studentId]) => accessible.has(studentId))
            .map(([, row]) => readFakeLearnerSession(row.payload))
            .map((session) => ({
              student_id: session.studentId,
              session_id: session.sessionId,
              created_at: session.createdAt,
            })),
        };
      }
      if (/^with unambiguous_active_learner_scope as materialized/i.test(sql.trim())
        && /select session\.payload/i.test(sql)) {
        const [studentId, actorId, actorRole] = params.map(String);
        const row = sessions.get(studentId);
        if (
          !row
          || !getFakeAccessibleStudentIds(enrollments, actorId, actorRole).has(studentId)
        ) {
          return { rows: [] };
        }
        return {
          rows: [{
            payload: row.payload,
            version: row.version,
            data_generation: learnerDataGenerations.get(studentId),
          }],
        };
      }
      if (/^with generation_guard as materialized \(\s*select data_generation[\s\S]*session_insert as/i.test(sql.trim())) {
        const failAt = (stage: "session" | "task" | "event" | "outbox") => {
          if (atomicWriteFailureStage === stage) {
            atomicWriteFailureStage = null;
            throw new Error(`Injected atomic learner mutation failure at ${stage}.`);
          }
        };
        const stagedSessions = new Map(
          Array.from(sessions.entries(), ([key, row]) => [key, structuredClone(row)]),
        );
        const stagedTaskState = new Map(
          Array.from(taskState.entries(), ([key, row]) => [key, structuredClone(row)]),
        );
        const stagedEvents = new Map(
          Array.from(events.entries(), ([key, row]) => [key, structuredClone(row)]),
        );
        const stagedOutbox = new Map(
          Array.from(outbox.entries(), ([key, row]) => [key, structuredClone(row)]),
        );
        const stagedGuideReservations = new Map(
          Array.from(guideReservations.entries(), ([key, row]) => [key, structuredClone(row)]),
        );
        const studentId = String(params[0]);
        if (
          params[10] !== null
          && !getFakeAccessibleStudentIds(
            enrollments,
            String(params[10]),
            String(params[11]),
          ).has(studentId)
        ) {
          return { rows: [] };
        }
        if ((learnerDataGenerations.get(studentId) ?? 1) !== Number(params[9])) {
          return { rows: [] };
        }
        const budgetReservationId = params[8] === null || params[8] === undefined
          ? null
          : String(params[8]);
        if (budgetReservationId) {
          const reservation = stagedGuideReservations.get(budgetReservationId);
          if (
            !reservation
            || reservation.student_id !== studentId
            || (
              reservation.state !== "dispatched"
              && (
                reservation.state !== "reserved"
                || reservation.expires_at <= new Date().toISOString()
              )
            )
          ) {
            return { rows: [] };
          }
          reservation.state = "completed";
        }
        const expectedVersion = params[2] === null ? null : Number(params[2]);
        const currentSession = stagedSessions.get(studentId);
        let nextVersion: number;
        if (expectedVersion === null) {
          if (currentSession) {
            return { rows: [] };
          }
          nextVersion = 0;
        } else {
          if (!currentSession || currentSession.version !== expectedVersion) {
            return { rows: [] };
          }
          nextVersion = currentSession.version + 1;
        }
        stagedSessions.set(studentId, {
          payload: params[1],
          version: nextVersion,
        });
        failAt("session");

        const taskRows = JSON.parse(String(params[3])) as Array<{
          task: string;
          phase: string;
          status: string;
          artifact_characters: number;
          self_report_characters: number;
          scaffold_requests: number;
          updated_at: string;
        }>;
        const sessionPayload = JSON.parse(String(params[1])) as { sessionId: string };
        for (const row of taskRows) {
          const key = `${studentId}\0${row.task}`;
          stagedTaskState.set(key, {
            student_id: studentId,
            session_id: sessionPayload.sessionId,
            ...row,
          });
        }
        failAt("task");

        const eventRows = JSON.parse(String(params[4])) as FakeAaisEventRow[];
        const newlyWrittenEventIds = new Set<string>();
        for (const row of eventRows) {
          if (!stagedEvents.has(row.id)) {
            stagedEvents.set(row.id, row);
            newlyWrittenEventIds.add(row.id);
          }
        }
        failAt("event");

        const coalescibleEvents = new Set((params[6] as string[]) ?? []);
        const outboxFacts = JSON.parse(String(params[5])) as Array<{
          id: string;
          source_event_id: string;
          ordinal: number;
          coalescible: boolean;
          payload: AaisEvent;
        }>;
        const groupedOutboxFacts = new Map<string, typeof outboxFacts>();
        for (const fact of outboxFacts) {
          if (!newlyWrittenEventIds.has(fact.source_event_id)) {
            continue;
          }
          groupedOutboxFacts.set(fact.id, [...(groupedOutboxFacts.get(fact.id) ?? []), fact]);
        }
        const outboxRows = Array.from(groupedOutboxFacts.entries()).map(([id, facts]) => {
          const latest = [...facts].sort((left, right) => right.ordinal - left.ordinal)[0];
          if (!latest) {
            throw new Error("Missing fake outbox fact.");
          }
          const payload = structuredClone(latest.payload);
          if (latest.coalescible) {
            payload.detail = {
              ...payload.detail,
              merged_events: facts.length,
              coalescing_window_seconds: Number(params[7]),
            };
          }
          return { id, payload };
        });
        for (const row of outboxRows) {
          const existing = stagedOutbox.get(row.id);
          const payload = structuredClone(row.payload);
          const protectedDelivery = existing
            && ["sending", "retry", "dead_letter"].includes(existing.status);
          if (protectedDelivery) {
            let pendingPayload = existing.pending_payload;
            if (coalescibleEvents.has(payload.event)) {
              pendingPayload = payload;
              pendingPayload.detail = {
                ...pendingPayload.detail,
                merged_events: Number(existing.pending_payload?.detail.merged_events ?? 0)
                  + Number(payload.detail.merged_events ?? 1),
                coalescing_window_seconds: Number(params[7]),
              };
            }
            stagedOutbox.set(row.id, {
              ...existing,
              status: existing.status === "dead_letter" ? "retry" : existing.status,
              pending_payload: pendingPayload,
            });
            continue;
          }
          if (
            existing?.status === "pending"
            && coalescibleEvents.has(payload.event)
          ) {
            payload.detail = {
              ...payload.detail,
              merged_events: Number(existing.payload.detail.merged_events ?? 0)
                + Number(payload.detail.merged_events ?? 1),
              coalescing_window_seconds: Number(params[7]),
            };
          }
          stagedOutbox.set(row.id, {
            id: row.id,
            payload,
            status: "pending",
            attempts: 0,
            delivery_claim_id: null,
            lease_expires_at: null,
            pending_payload: null,
            xapi_statement: null,
          });
        }
        failAt("outbox");

        sessions.clear();
        for (const [key, row] of stagedSessions) sessions.set(key, row);
        taskState.clear();
        for (const [key, row] of stagedTaskState) taskState.set(key, row);
        events.clear();
        for (const [key, row] of stagedEvents) events.set(key, row);
        outbox.clear();
        for (const [key, row] of stagedOutbox) outbox.set(key, row);
        guideReservations.clear();
        for (const [key, row] of stagedGuideReservations) guideReservations.set(key, row);
        this.taskStateRows = Array.from(taskState.values());
        this.eventRows = Array.from(events.values());
        this.outboxRows = Array.from(outbox.values());
        return {
          rows: [{
            version: nextVersion,
            task_count: taskRows.length,
            event_count: newlyWrittenEventIds.size,
            outbox_count: outboxRows.length,
          }],
        };
      }
      if (/^select \*\s+from public\.aais_delete_learner_data/i.test(sql.trim())) {
        const studentId = String(params[0]);
        const expectedGeneration = Number(params[1]);
        const currentGeneration = learnerDataGenerations.get(studentId) ?? 1;
        if (currentGeneration !== expectedGeneration) {
          return { rows: [] };
        }
        const deliveryFence = learnerDeliveryFences.get(studentId) ?? {
          state: "idle" as const,
          claimId: null,
        };
        if (deliveryFence.state !== "idle") {
          throw Object.assign(new Error(
            deliveryFence.state === "in_flight"
              ? "AAIS_LRS_DELIVERY_IN_FLIGHT"
              : "AAIS_LRS_DELIVERY_RECONCILIATION_REQUIRED",
          ), { code: "P0001" });
        }
        const nextGeneration = currentGeneration + 1;
        learnerDataGenerations.set(studentId, nextGeneration);
        let outboxCount = 0;
        let taskCount = 0;
        let eventCount = 0;
        let guideUsageCount = 0;
        const retainedUsageDay = String(params[2]).slice(0, 10);
        for (const [id, row] of outbox) {
          if (row.payload.student_id === studentId) {
            outbox.delete(id);
            outboxCount += 1;
          }
        }
        for (const [key, row] of taskState) {
          if (row.student_id === studentId) {
            taskState.delete(key);
            taskCount += 1;
          }
        }
        for (const [key] of dailyGuideUsage) {
          if (
            key.startsWith(`${studentId}\0`)
            && key !== `${studentId}\0${retainedUsageDay}`
          ) {
            dailyGuideUsage.delete(key);
            guideUsageCount += 1;
          }
        }
        for (const [id, reservation] of guideReservations) {
          if (reservation.student_id === studentId) {
            guideReservations.delete(id);
          }
        }
        for (const [id, row] of events) {
          if (row.student_id === studentId) {
            events.delete(id);
            eventCount += 1;
          }
        }
        const sessionCount = sessions.delete(studentId) ? 1 : 0;
        this.taskStateRows = Array.from(taskState.values());
        this.eventRows = Array.from(events.values());
        this.outboxRows = Array.from(outbox.values());
        return {
          rows: [{
            next_generation: nextGeneration,
            outbox_count: outboxCount,
            task_count: taskCount,
            guide_usage_count: guideUsageCount,
            event_count: eventCount,
            session_count: sessionCount,
          }],
        };
      }
      if (/^with matching_sessions as/i.test(sql.trim())) {
        return {
          rows: summarizeFakeSqlCohortRows(Array.from(events.values()), params),
        };
      }
      if (/^select count\(\*\)::int as count\s+from aais_events/i.test(sql.trim())) {
        const [studentId, start, end] = params.map(String);
        return {
          rows: [{
            count: Array.from(events.values()).filter((event) =>
              event.student_id === studentId
              && event.event === "ai_prompt_submitted"
              && event.event_time >= start
              && event.event_time < end
            ).length,
          }],
        };
      }
      if (/^select payload from aais_lrs_outbox/i.test(sql.trim())) {
        const row = outbox.get(String(params[0]));
        return { rows: row ? [{ payload: row.payload }] : [] };
      }
      if (/^select session\.payload, session\.version, generation\.data_generation[\s\S]*order by session\.updated_at desc/i.test(sql.trim())) {
        return {
          rows: Array.from(sessions.entries()).map(([studentId, row]) => ({
            payload: row.payload,
            version: row.version,
            data_generation: learnerDataGenerations.get(studentId),
          })),
        };
      }
      if (/^select session\.payload/i.test(sql.trim()) || /^select payload/i.test(sql.trim())) {
        const row = sessions.get(String(params[0]));
        return {
          rows: row
            ? [{
                payload: row.payload,
                version: row.version,
                data_generation: learnerDataGenerations.get(String(params[0])),
              }]
            : [],
        };
      }
      if (/^select id, payload, attempts/i.test(sql.trim())) {
        return {
          rows: Array.from(outbox.values())
            .filter((row) => row.status === "pending" || row.status === "retry")
            .map((row) => ({
              id: row.id,
              payload: row.payload,
              attempts: row.attempts,
              xapi_statement: row.xapi_statement,
            })),
        };
      }
      if (/^with candidate as \(\s*select id\s+from aais_lrs_outbox/i.test(sql.trim())) {
        const limit = Number(params[0]);
        const claimId = String(params[1]);
        const leaseDurationMs = Number(params[2]) * 1_000;
        const processedIds = new Set((params[3] as string[]) ?? []);
        const now = Date.now();
        const claimed = Array.from(outbox.values())
          .filter((row) =>
            !processedIds.has(row.id)
            && (learnerDeliveryFences.get(row.payload.student_id)?.state ?? "idle") === "idle"
            && (
              row.status === "pending"
              || row.status === "retry"
              || (row.status === "sending" && Number(row.lease_expires_at) <= now)
            )
          )
          .slice(0, limit);
        for (const row of claimed) {
          row.status = "sending";
          row.delivery_claim_id = claimId;
          row.lease_expires_at = now + leaseDurationMs;
        }
        this.outboxRows = Array.from(outbox.values());
        return {
          rows: claimed.map((row) => ({
            id: row.id,
            payload: row.payload,
            attempts: row.attempts,
            xapi_statement: row.xapi_statement,
            learner_data_generation: learnerDataGenerations.get(row.payload.student_id),
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
        const studentId = String(params[0]);
        if (
          sessions.has(studentId)
          || (learnerDataGenerations.get(studentId) ?? 1) !== Number(params[2])
        ) {
          return { rows: [] };
        }
        sessions.set(studentId, {
          payload: params[1],
          version: 0,
        });
        return { rows: [{ version: 0 }] };
      }
      if (/^update aais_learner_sessions/i.test(sql.trim())) {
        const studentId = String(params[0]);
        const row = sessions.get(studentId);
        const expectedVersion = Number(params[2]);
        if (
          !row
          || row.version !== expectedVersion
          || (learnerDataGenerations.get(studentId) ?? 1) !== Number(params[3])
        ) {
          return { rows: [] };
        }
        row.payload = params[1];
        row.version += 1;
        return { rows: [{ version: row.version }] };
      }
      if (/^insert into aais_events/i.test(sql.trim())) {
        const id = String(params[0]);
        if (!events.has(id)) {
          events.set(id, {
            id,
            student_id: String(params[1]),
            session_id: String(params[2]),
            phase: String(params[3]),
            task: String(params[4]),
            agent: String(params[5]),
            event: String(params[6]),
            event_time: String(params[7]),
            detail: JSON.parse(String(params[8])) as Record<string, unknown>,
          });
        }
        this.eventRows = Array.from(events.values());
        return { rows: [] };
      }
      if (/^insert into aais_learner_task_state/i.test(sql.trim())) {
        const key = `${String(params[0])}\0${String(params[2])}`;
        taskState.set(key, {
          student_id: String(params[0]),
          session_id: String(params[1]),
          task: String(params[2]),
          phase: String(params[3]),
          status: String(params[4]),
          artifact_characters: Number(params[5]),
          self_report_characters: Number(params[6]),
          scaffold_requests: Number(params[7]),
          updated_at: String(params[8]),
        });
        this.taskStateRows = Array.from(taskState.values());
        return { rows: [] };
      }
      if (/^insert into aais_lrs_outbox/i.test(sql.trim())) {
        const existing = outbox.get(String(params[0]));
        outbox.set(String(params[0]), {
          id: String(params[0]),
          payload: JSON.parse(String(params[1])) as AaisEvent,
          status: "pending",
          attempts: existing?.attempts ?? 0,
          delivery_claim_id: null,
          lease_expires_at: null,
          pending_payload: null,
          xapi_statement: null,
        });
        this.outboxRows = Array.from(outbox.values());
        return { rows: [] };
      }
      if (/^update aais_lrs_outbox\s+set xapi_statement = coalesce/i.test(sql.trim())) {
        const row = outbox.get(String(params[0]));
        const claimId = String(params[1]);
        if (row?.status !== "sending" || row.delivery_claim_id !== claimId) {
          return { rows: [] };
        }
        row.xapi_statement ??= JSON.parse(String(params[2]));
        this.outboxRows = Array.from(outbox.values());
        return { rows: [{ xapi_statement: row.xapi_statement }] };
      }
      if (/^update aais_lrs_outbox\s+set payload = coalesce\(pending_payload, payload\)/i.test(sql.trim())) {
        const row = outbox.get(String(params[0]));
        const claimId = params[1] === undefined ? null : String(params[1]);
        if (
          row
          && (claimId === null || (row.status === "sending" && row.delivery_claim_id === claimId))
        ) {
          const pendingPayload = row.pending_payload;
          row.payload = pendingPayload ?? row.payload;
          if (pendingPayload) {
            row.xapi_statement = null;
          }
          row.status = pendingPayload ? "pending" : "sent";
          row.attempts = pendingPayload ? 0 : row.attempts;
          row.pending_payload = null;
          row.delivery_claim_id = null;
          row.lease_expires_at = null;
          this.outboxRows = Array.from(outbox.values());
          return { rows: [{ id: row.id, status: row.status }] };
        }
        this.outboxRows = Array.from(outbox.values());
        return { rows: [] };
      }
      if (
        /^update aais_lrs_outbox\s+set status = 'retry'/i.test(sql.trim())
        && /delivery_claim_id = null/i.test(sql)
        && params.length >= 2
      ) {
        const row = outbox.get(String(params[0]));
        const claimId = String(params[1]);
        if (row?.status === "sending" && row.delivery_claim_id === claimId) {
          row.status = "retry";
          row.delivery_claim_id = null;
          row.lease_expires_at = null;
          this.outboxRows = Array.from(outbox.values());
          return { rows: [{ id: row.id }] };
        }
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
      if (/^update aais_lrs_outbox\s+set status =/i.test(sql.trim())) {
        const conditionalClaimUpdate = /delivery_claim_id = null/i.test(sql);
        const row = outbox.get(String(params[conditionalClaimUpdate ? 1 : 2]));
        const claimId = conditionalClaimUpdate ? String(params[2]) : null;
        if (
          row
          && (
            !conditionalClaimUpdate
            || (row.status === "sending" && row.delivery_claim_id === claimId)
          )
        ) {
          row.status = String(params[0]);
          row.attempts = conditionalClaimUpdate ? row.attempts + 1 : Number(params[1]);
          row.delivery_claim_id = null;
          row.lease_expires_at = null;
          this.outboxRows = Array.from(outbox.values());
          return { rows: [{ id: row.id }] };
        }
        this.outboxRows = Array.from(outbox.values());
        return { rows: [] };
      }
      if (/^select used, granted, reservation_id[\s\S]*aais_reserve_ai_guide_request/i.test(sql.trim())) {
        if ((learnerDataGenerations.get(String(params[0])) ?? 1) !== Number(params[5])) {
          return { rows: [] };
        }
        const key = `${String(params[0])}\0${String(params[1]).slice(0, 10)}`;
        const now = String(params[2]);
        const limit = Number(params[3]);
        const reservationId = String(params[4]);
        for (const usageKey of dailyGuideUsage.keys()) {
          if (
            usageKey.startsWith(`${String(params[0])}\0`)
            && usageKey.slice(usageKey.indexOf("\0") + 1) < String(params[1]).slice(0, 10)
          ) {
            dailyGuideUsage.delete(usageKey);
          }
        }
        for (const [id, reservation] of guideReservations) {
          if (
            reservation.student_id === String(params[0])
            && reservation.usage_day < String(params[1]).slice(0, 10)
          ) {
            guideReservations.delete(id);
          }
        }
        let expiredCount = 0;
        for (const reservation of guideReservations.values()) {
          if (
            reservation.student_id === String(params[0])
            && reservation.usage_day === String(params[1]).slice(0, 10)
            && reservation.state === "reserved"
            && reservation.expires_at <= now
          ) {
            reservation.state = "released";
            expiredCount += 1;
          }
        }
        const adjustedUsed = Math.max(0, (dailyGuideUsage.get(key) ?? 0) - expiredCount);
        const granted = adjustedUsed < limit;
        const used = adjustedUsed + (granted ? 1 : 0);
        dailyGuideUsage.set(key, used);
        if (granted) {
          guideReservations.set(reservationId, {
            id: reservationId,
            student_id: String(params[0]),
            usage_day: String(params[1]).slice(0, 10),
            state: "reserved",
            expires_at: new Date(
              Date.parse(now) + Number(params[6]) * 1000,
            ).toISOString(),
          });
        }
        return {
          rows: [{
            used,
            granted,
            reservation_id: granted ? reservationId : null,
          }],
        };
      }
      if (/^with generation_guard as materialized \([\s\S]*dispatched as/i.test(sql.trim())) {
        if ((learnerDataGenerations.get(String(params[1])) ?? 1) !== Number(params[2])) {
          return { rows: [] };
        }
        const reservation = guideReservations.get(String(params[0]));
        if (!reservation || reservation.student_id !== String(params[1])) {
          return { rows: [] };
        }
        if (reservation.state === "dispatched" || reservation.state === "completed") {
          return { rows: [{ state: reservation.state }] };
        }
        if (
          reservation.state !== "reserved"
          || reservation.expires_at <= String(params[3])
        ) {
          return { rows: [] };
        }
        reservation.state = "dispatched";
        return { rows: [{ state: reservation.state }] };
      }
      if (/^select reservation\.state\s+from aais_ai_guide_reservations/i.test(sql.trim())) {
        const reservation = guideReservations.get(String(params[0]));
        if (
          !reservation
          || reservation.student_id !== String(params[1])
          || (learnerDataGenerations.get(String(params[1])) ?? 1) !== Number(params[2])
          || (reservation.state !== "dispatched" && reservation.state !== "completed")
        ) {
          return { rows: [] };
        }
        return { rows: [{ state: reservation.state }] };
      }
      if (/^with generation_guard as materialized \([\s\S]*released as/i.test(sql.trim())) {
        if ((learnerDataGenerations.get(String(params[1])) ?? 1) !== Number(params[2])) {
          return { rows: [] };
        }
        const reservation = guideReservations.get(String(params[0]));
        if (
          !reservation
          || reservation.student_id !== String(params[1])
          || reservation.state !== "reserved"
          || reservation.expires_at <= String(params[3])
        ) {
          return { rows: [] };
        }
        reservation.state = "released";
        const key = `${reservation.student_id}\0${reservation.usage_day}`;
        const used = Math.max(0, (dailyGuideUsage.get(key) ?? 0) - 1);
        dailyGuideUsage.set(key, used);
        return { rows: [{ used }] };
      }
      if (/^with generation_guard as materialized \([\s\S]*update aais_ai_guide_reservations/i.test(sql.trim())) {
        if ((learnerDataGenerations.get(String(params[1])) ?? 1) !== Number(params[2])) {
          return { rows: [] };
        }
        const reservation = guideReservations.get(String(params[0]));
        if (
          !reservation
          || reservation.student_id !== String(params[1])
          || (
            reservation.state !== "dispatched"
            && (
              reservation.state !== "reserved"
              || reservation.expires_at <= String(params[3])
            )
          )
        ) {
          return { rows: [] };
        }
        reservation.state = "completed";
        return { rows: [{ id: reservation.id }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

function createProbeDatabaseClient(input: {
  learnerSessionsTable: boolean;
  learnerDataGenerationsTable?: boolean;
  learnerDeliveryFenceColumns?: boolean;
  learnerSessionGenerationCompatible?: boolean;
  learnerTaskStateTable: boolean;
  lrsOutboxTable: boolean;
  lrsOutboxClaimColumns?: boolean;
  lrsDeliveryReconciliation?: boolean;
  lrsDeliveryAttemptsConsistent?: boolean;
  staleLrsDeliveryAttempt?: boolean;
  loginRateLimitsTable: boolean;
  loginRateLimitsRetention?: boolean;
  eventsTable: boolean;
  aiGuideDailyUsageTable?: boolean;
  aiGuideReservationsTable?: boolean;
  aiGuideReservationLeaseColumn?: boolean;
  aiGuideDispatchConstraints?: boolean;
  aiGuideReservationFunction?: boolean;
  learnerDataDeleteFunction?: boolean;
  usersTable: boolean;
  usersAuthVersionColumn?: boolean;
  activeAdminInvariant?: boolean;
  userAuthTokensTable: boolean;
  sessionRevocationsTable: boolean;
  coursesTable?: boolean;
  courseTasksTable?: boolean;
  enrollmentsTable?: boolean;
  enrollmentScopeIndex?: boolean;
}) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  return {
    queries,
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      if (/to_regclass/i.test(sql)) {
        return {
          rows: [{
            learner_sessions_table: input.learnerSessionsTable ? "aais_learner_sessions" : null,
            learner_data_generations_table: input.learnerDataGenerationsTable === false
              ? null
              : "aais_learner_data_generations",
            learner_lrs_delivery_fence_columns: input.learnerDeliveryFenceColumns !== false,
            learner_session_generation_compatible:
              input.learnerSessionGenerationCompatible !== false,
            learner_task_state_table: input.learnerTaskStateTable ? "aais_learner_task_state" : null,
            lrs_outbox_table: input.lrsOutboxTable ? "aais_lrs_outbox" : null,
            lrs_outbox_claim_columns: input.lrsOutboxClaimColumns !== false,
            lrs_delivery_attempts_table: input.lrsDeliveryReconciliation === false
              ? null
              : "aais_lrs_delivery_attempts",
            lrs_delivery_attempt_statements_table: input.lrsDeliveryReconciliation === false
              ? null
              : "aais_lrs_delivery_attempt_statements",
            lrs_delivery_attempt_columns: input.lrsDeliveryReconciliation !== false,
            lrs_delivery_attempt_statement_columns: input.lrsDeliveryReconciliation !== false,
            lrs_delivery_reconciliation_constraints: input.lrsDeliveryReconciliation !== false,
            lrs_delivery_reconciliation_index: input.lrsDeliveryReconciliation === false
              ? null
              : "aais_lrs_delivery_attempts_reconciliation_idx",
            lrs_delivery_attempt_student_index: input.lrsDeliveryReconciliation === false
              ? null
              : "aais_lrs_delivery_attempt_statements_student_idx",
            lrs_delivery_attempts_consistent:
              input.lrsDeliveryReconciliation !== false
              && input.lrsDeliveryAttemptsConsistent !== false,
            lrs_delivery_reconciliation_clear:
              input.lrsDeliveryReconciliation !== false
              && input.staleLrsDeliveryAttempt !== true,
            login_rate_limits_table: input.loginRateLimitsTable ? "aais_login_rate_limits" : null,
            login_rate_limits_expires_column: input.loginRateLimitsRetention !== false,
            login_rate_limits_expires_index: input.loginRateLimitsRetention !== false,
            events_table: input.eventsTable ? "aais_events" : null,
            ai_guide_daily_usage_table: input.aiGuideDailyUsageTable === false ? null : "aais_ai_guide_daily_usage",
            ai_guide_reservations_table: input.aiGuideReservationsTable === false ? null : "aais_ai_guide_reservations",
            ai_guide_reservation_lease_column: input.aiGuideReservationLeaseColumn !== false,
            ai_guide_reservation_dispatch_state_constraint:
              input.aiGuideDispatchConstraints !== false,
            ai_guide_reservation_dispatch_finalized_constraint:
              input.aiGuideDispatchConstraints !== false,
            ai_guide_reservation_function: input.aiGuideReservationFunction !== false,
            learner_data_delete_function: input.learnerDataDeleteFunction !== false,
            users_table: input.usersTable ? "aais_users" : null,
            users_auth_version_column: input.usersAuthVersionColumn !== false,
            active_admin_invariant_lock_table: input.activeAdminInvariant === false
              ? null
              : "aais_active_admin_invariant_lock",
            active_admin_update_trigger: input.activeAdminInvariant !== false,
            active_admin_delete_trigger: input.activeAdminInvariant !== false,
            user_auth_tokens_table: input.userAuthTokensTable ? "aais_user_auth_tokens" : null,
            session_revocations_table: input.sessionRevocationsTable ? "aais_session_revocations" : null,
            courses_table: input.coursesTable === false ? null : "aais_courses",
            course_tasks_table: input.courseTasksTable === false ? null : "aais_course_tasks",
            enrollments_table: input.enrollmentsTable === false ? null : "aais_enrollments",
            enrollment_scope_index: input.enrollmentScopeIndex === false
              ? null
              : "aais_enrollments_user_scope_idx",
          }],
        };
      }
      return { rows: [{ ok: 1 }] };
    },
  };
}
