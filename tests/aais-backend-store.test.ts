import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isAaisSessionWriteConflictError,
  createAaisLearningStore,
  flushAaisPersistentLrsOutbox,
  getAaisPersistentLrsOutboxStatus,
  getAaisDatabaseConfiguration,
  probeAaisLearningStorage,
  requeueAaisPersistentLrsDeadLetters,
  type AaisDatabaseClient,
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

  it("rejects every learner mutation targeting a locked task", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await store.getOrCreateSession("S001");

    // A brand-new learner has only training_task_1 active; every practice task is
    // locked until its prerequisite is completed. None of these mutations may act on
    // a locked task, otherwise sequencing (and cohort analytics) can be bypassed.
    await expect(store.completeTask("S001", "practice_task_2")).rejects.toThrow(
      "Task practice_task_2 is locked",
    );
    await expect(store.saveArtifact("S001", "practice_task_2", "x")).rejects.toThrow(
      "Task practice_task_2 is locked",
    );
    await expect(store.saveSelfReport("S001", "practice_task_2", "x")).rejects.toThrow(
      "Task practice_task_2 is locked",
    );
    await expect(
      store.requestScaffold("S001", "practice_task_2", "stage-checklist"),
    ).rejects.toThrow("Task practice_task_2 is locked");
    await expect(
      store.recordAiAcceptance("S001", "practice_task_2", { accepted: true }),
    ).rejects.toThrow("Task practice_task_2 is locked");

    const session = await store.getOrCreateSession("S001");
    expect(session.tasks.find((task) => task.taskId === "practice_task_2")?.status).toBe(
      "locked",
    );
    expect(
      session.tasks.filter((task) => task.status === "completed"),
    ).toHaveLength(0);
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
      turn.content === "" && turn.actions.length === 0
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
    expect(database.queries.some((query) => /create table if not exists|alter table/i.test(query.sql))).toBe(false);
    expect(database.queries.some((query) => /insert into aais_learner_sessions/i.test(query.sql))).toBe(true);
    expect(database.queries.some((query) => /insert into aais_learner_task_state/i.test(query.sql))).toBe(true);
    expect(database.queries.some((query) => /insert into aais_events/i.test(query.sql))).toBe(true);
    expect(database.queries.some((query) => /select payload/i.test(query.sql))).toBe(true);
    expect(database.eventRows.map((row) => row.event)).toEqual(
      expect.arrayContaining(["session_created", "task_released", "artifact_saved"]),
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

    await expect(probeAaisLearningStorage({ database: migratedDatabase })).resolves.toEqual({
      mode: "postgres",
      status: "connected",
    });
    await expect(probeAaisLearningStorage({ database: missingRateLimitDatabase })).resolves.toEqual({
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
    await expect(probeAaisLearningStorage({ database: missingCatalogDatabase })).resolves.toEqual({
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

    // The guarded upsert only increments while under the limit — the exhausted
    // attempt must not have advanced the counter past the cap.
    const usageQueries = database.queries.filter((query) =>
      /aais_ai_guide_daily_usage/i.test(query.sql),
    );
    expect(usageQueries.some((query) => /where aais_ai_guide_daily_usage\.used < \$4/i.test(query.sql))).toBe(
      true,
    );
  });

  it("degrades to prompt-event counting when the durable usage table is missing", async () => {
    const missingTableError = Object.assign(new Error("relation does not exist"), {
      code: "42P01",
    });
    const database = {
      async query(sql: string) {
        if (/^insert into aais_ai_guide_daily_usage/i.test(sql.trim())) {
          throw missingTableError;
        }
        if (/^select count\(\*\)::int as count\s+from aais_events/i.test(sql.trim())) {
          return { rows: [{ count: 0 }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as AaisDatabaseClient;
    const store = createAaisLearningStore({ database });

    const reservation = await store.reserveDailyGuideRequest({ studentId: "S001", limit: 3 });
    expect(reservation).toMatchObject({ status: "reserved", limit: 3, used: 1, remaining: 2 });
  });

  it("falls back to per-process prompt-event counting when no database is configured", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });

    const first = await store.reserveDailyGuideRequest({ studentId: "S001", limit: 1 });
    expect(first).toMatchObject({ status: "reserved", limit: 1, used: 1, remaining: 0 });

    // Nothing has been persisted yet (the prompt event is written when the exchange
    // is appended), so a follow-up reservation still sees head-room until an exchange
    // lands. Simulate a completed exchange, then confirm the cap holds.
    await store.appendGuideExchange({
      studentId: "S001",
      phase: "training",
      taskId: "training_task_1",
      question: "问题",
      answer: "回答",
      orchestration: { graphId: "g", topologicalOrder: ["A1"], threadId: "t" },
    });

    const afterExchange = await store.reserveDailyGuideRequest({ studentId: "S001", limit: 1 });
    expect(afterExchange).toMatchObject({ status: "exhausted", limit: 1, used: 1, remaining: 0 });
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
          secrets: "redacted",
        }),
      ]),
    );
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
    expect(database.queries.some((query) => /^insert into aais_learner_sessions/i.test(query.sql.trim()))).toBe(true);
    expect(database.queries.some((query) => /^insert into aais_learner_task_state/i.test(query.sql.trim()))).toBe(true);

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
        if (/^select id, payload, attempts/i.test(trimmed)) {
          return {
            rows: row.status === "pending" || row.status === "retry"
              ? [{ id: row.id, payload: row.payload, attempts: row.attempts }]
              : [],
          };
        }
        if (/^update aais_lrs_outbox set status = \$1/i.test(trimmed)) {
          row.status = String(params[0]);
          row.attempts = Number(params[1]);
          return { rows: [] };
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
    const rawSession = await store.completeTask("S001", "training_task_1");
    const rawSessionId = rawSession.sessionId;
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
    expect(analytics.learners[0]).toMatchObject({
      sessionKey: expect.stringMatching(/^session-[a-f0-9]{12}$/),
    });
    expect(analytics.learners[0]).not.toHaveProperty("sessionId");
    expect(JSON.stringify(analytics)).not.toContain("S001");
    expect(JSON.stringify(analytics)).not.toContain(rawSessionId);
    expect(JSON.stringify(analytics)).not.toContain("第一位学习者的低进展记录");
    expect(JSON.stringify(analytics)).not.toContain("第二位学习者的训练记录");
  });

  it("summarizes database cohort analytics from aais_events without scanning session blobs", async () => {
    const database = createFakeDatabaseClient();
    const store = createAaisLearningStore({ database });
    const rawSession = await store.completeTask("S001", "training_task_1");
    await store.selectTask("S001", "practice_task_1");
    await store.saveArtifact("S001", "practice_task_1", "第一位学习者的数据库低进展记录");
    await store.saveArtifact("S001", "practice_task_1", "第一位学习者的数据库低进展记录");
    await store.getOrCreateSession("S002");

    database.queries.length = 0;
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
    expect(analytics.learners[0].learnerKey).toMatch(/^learner-[a-f0-9]{12}$/);
    expect(analytics.learners[0].sessionKey).toMatch(/^session-[a-f0-9]{12}$/);
    expect(JSON.stringify(analytics)).not.toContain("S001");
    expect(JSON.stringify(analytics)).not.toContain(rawSession.sessionId);
    expect(JSON.stringify(analytics)).not.toContain("第一位学习者的数据库低进展记录");
    expect(database.queries.some((query) =>
      /with matching_sessions as/i.test(query.sql) && /from aais_events/i.test(query.sql)
    )).toBe(true);
    expect(database.queries.some((query) =>
      /^select payload(?:,\s*version)? from aais_learner_sessions order by/i.test(query.sql.trim())
    )).toBe(false);
  });

  it("keeps SQL cohort analytics flat for 500 simulated learners", async () => {
    const database = createFakeDatabaseClient();
    database.seedEventRows(createFakeCohortPerformanceRows(500));
    const store = createAaisLearningStore({ database });
    const durations: number[] = [];
    let analytics: Awaited<ReturnType<typeof store.getCohortAnalytics>> | null = null;

    for (let run = 0; run < 5; run += 1) {
      const startedAt = performance.now();
      analytics = await store.getCohortAnalytics({
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
      /with matching_sessions as/i.test(query.sql) && /from aais_events/i.test(query.sql)
    )).toHaveLength(5);
    expect(database.queries.some((query) =>
      /^select payload(?:,\s*version)? from aais_learner_sessions order by/i.test(query.sql.trim())
    )).toBe(false);
  });

  it("paginates cohort learner rows while preserving full aggregate totals", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await store.getOrCreateSession("S001");
    await store.getOrCreateSession("S002");
    await store.getOrCreateSession("S003");

    const analytics = await store.getCohortAnalytics({}, {
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

  it("exports pseudonymous cohort session keys instead of internal learner session ids", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    const rawSession = await store.completeTask("S001", "training_task_1");
    await store.selectTask("S001", "practice_task_1");
    await store.saveArtifact("S001", "practice_task_1", "第一位学习者的导出隐私记录");

    const exported = await store.exportCohortAnalytics("json");
    const body = JSON.parse(exported.body);
    const serialized = JSON.stringify(body);

    expect(body.learners[0]).toMatchObject({
      learnerKey: expect.stringMatching(/^learner-[a-f0-9]{12}$/),
      sessionKey: expect.stringMatching(/^session-[a-f0-9]{12}$/),
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

function summarizeFakeSqlCohortRows(events: FakeAaisEventRow[], params: unknown[]) {
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
        expert_trace_count: countFakeEvents(group.filtered, ["expert_trace_compared"]),
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

function readFakeDetailText(detail: Record<string, unknown>, key: string) {
  const value = detail[key];
  return typeof value === "string" && value ? value : null;
}

function createFakeDatabaseClient() {
  const sessions = new Map<string, {
    payload: unknown;
    version: number;
  }>();
  const outbox = new Map<string, {
    id: string;
    payload: AaisEvent;
    status: string;
    attempts: number;
  }>();
  const events = new Map<string, FakeAaisEventRow>();
  const taskState = new Map<string, FakeLearnerTaskStateRow>();
  const dailyGuideUsage = new Map<string, number>();
  const queries: Array<{ sql: string; params: unknown[] }> = [];

  return {
    eventRows: Array.from(events.values()),
    outboxRows: Array.from(outbox.values()),
    taskStateRows: Array.from(taskState.values()),
    queries,
    seedEventRows(rows: FakeAaisEventRow[]) {
      for (const row of rows) {
        events.set(row.id, row);
      }
      this.eventRows = Array.from(events.values());
    },
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      if (/^(create|alter) table/i.test(sql.trim())) {
        return { rows: [] };
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
      if (/^select payload(?:,\s*version)? from aais_learner_sessions order by/i.test(sql.trim())) {
        return {
          rows: Array.from(sessions.values()).map((row) => ({
            payload: row.payload,
            version: row.version,
          })),
        };
      }
      if (/^select payload/i.test(sql.trim())) {
        const row = sessions.get(String(params[0]));
        return {
          rows: row
            ? [{
                payload: row.payload,
                version: row.version,
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
        if (sessions.has(studentId)) {
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
        if (!row || row.version !== expectedVersion) {
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
      if (/^insert into aais_ai_guide_daily_usage/i.test(sql.trim())) {
        const key = `${String(params[0])}\0${String(params[1]).slice(0, 10)}`;
        const limit = Number(params[3]);
        const existing = dailyGuideUsage.get(key);
        if (existing === undefined) {
          dailyGuideUsage.set(key, 1);
          return { rows: [{ used: 1 }] };
        }
        if (existing < limit) {
          const used = existing + 1;
          dailyGuideUsage.set(key, used);
          return { rows: [{ used }] };
        }
        return { rows: [] };
      }
      if (/^select used\s+from aais_ai_guide_daily_usage/i.test(sql.trim())) {
        const used = dailyGuideUsage.get(`${String(params[0])}\0${String(params[1]).slice(0, 10)}`);
        return { rows: used === undefined ? [] : [{ used }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

function createProbeDatabaseClient(input: {
  learnerSessionsTable: boolean;
  learnerTaskStateTable: boolean;
  lrsOutboxTable: boolean;
  loginRateLimitsTable: boolean;
  eventsTable: boolean;
  usersTable: boolean;
  userAuthTokensTable: boolean;
  sessionRevocationsTable: boolean;
  coursesTable?: boolean;
  courseTasksTable?: boolean;
  enrollmentsTable?: boolean;
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
            learner_task_state_table: input.learnerTaskStateTable ? "aais_learner_task_state" : null,
            lrs_outbox_table: input.lrsOutboxTable ? "aais_lrs_outbox" : null,
            login_rate_limits_table: input.loginRateLimitsTable ? "aais_login_rate_limits" : null,
            events_table: input.eventsTable ? "aais_events" : null,
            users_table: input.usersTable ? "aais_users" : null,
            user_auth_tokens_table: input.userAuthTokensTable ? "aais_user_auth_tokens" : null,
            session_revocations_table: input.sessionRevocationsTable ? "aais_session_revocations" : null,
            courses_table: input.coursesTable === false ? null : "aais_courses",
            course_tasks_table: input.courseTasksTable === false ? null : "aais_course_tasks",
            enrollments_table: input.enrollmentsTable === false ? null : "aais_enrollments",
          }],
        };
      }
      return { rows: [{ ok: 1 }] };
    },
  };
}
