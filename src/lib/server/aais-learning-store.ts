import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { neon } from "@neondatabase/serverless";
import { Pool } from "pg";
import {
  aaisEventDefinitions,
  aaisLearningProgram,
  createAaisEvent,
  escapeAaisCsvField,
  exportAaisEventsAsCsv,
  exportAaisEventsAsJson,
  scaffoldTools,
  type AaisAgentId,
  type AaisEventName,
  type AaisEvent,
  type AaisPhase,
} from "@/data/aais";
import {
  enqueueAaisLrsEvents,
  sendAaisEventsToLrs,
} from "@/lib/server/aais-lrs-client";

export type AaisDatabaseClient = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end?(): Promise<void>;
};

export type AaisDatabaseSourceEnv =
  | "AAIS_DATABASE_URL"
  | "DATABASE_URL"
  | "POSTGRES_URL"
  | "POSTGRES_PRISMA_URL"
  | "POSTGRES_URL_NO_SSL"
  | "DATABASE_URL_UNPOOLED"
  | "POSTGRES_URL_NON_POOLING"
  | "PG*"
  | "POSTGRES_*";

export type AaisDatabaseConfiguration = {
  url: string;
  sourceEnv: AaisDatabaseSourceEnv;
};

export type AaisLearningStorageProbe = {
  mode: "postgres" | "file";
  status: "connected" | "not_configured" | "failed";
};

export class AaisLearningStorageConfigurationError extends Error {
  constructor() {
    super("AAIS production learner storage requires Postgres configuration.");
    this.name = "AaisLearningStorageConfigurationError";
  }
}

export function isAaisLearningStorageConfigurationError(
  error: unknown,
): error is AaisLearningStorageConfigurationError {
  return error instanceof AaisLearningStorageConfigurationError;
}

export type AaisTaskStatus = "locked" | "available" | "active" | "completed";

export type AaisTaskRecord = {
  taskId: string;
  phase: AaisPhase;
  status: AaisTaskStatus;
  artifactText: string;
  selfReport: string;
  scaffoldRequests: number;
  scaffoldHistory: Array<{
    toolId: string;
    mode: "tool-list" | "self-check";
    time: string;
  }>;
};

export type AaisGuideMessageRecord = {
  id: string;
  kind: "user" | "assistant";
  text: string;
  time: string;
  turns?: AaisGuideTurnRecord[];
  orchestration?: {
    graphId: string;
    topologicalOrder: string[];
    threadId: string;
  };
};

export type AaisGuideTurnRecord = {
  agentId: AaisAgentId;
  label: string;
  content: string;
  actions: string[];
};

export type AaisLearnerSession = {
  schemaVersion: 1;
  studentId: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  activeTaskId: string;
  activeStage: string;
  tasks: AaisTaskRecord[];
  guideMessages: AaisGuideMessageRecord[];
  events: AaisEvent[];
};

type StoreInput = {
  rootDir?: string;
  database?: AaisDatabaseClient;
};

type ScaffoldResult = {
  mode: "tool-list" | "self-check";
  requestCount: number;
  tool: {
    id: string;
    label: string;
    body: string;
  };
  session: AaisLearnerSession;
};

export type AaisCohortAnalyticsFilters = {
  phase?: AaisPhase;
  task?: string;
  agent?: AaisAgentId | "platform";
  event?: AaisEventName;
  cohort?: string;
  role?: string;
  courseId?: string;
};

type AaisCohortRiskLevel = "high" | "medium" | "low";

type AaisCohortPriorityReason =
  | "training_incomplete"
  | "reflection_missing"
  | "a2_coaching_signals"
  | "high_scaffold_dependency"
  | "no_ai_interaction_after_coaching";

export type AaisAgentEvidenceCapability = {
  enabled: true;
  agentContract: {
    version: "aais-a1-a4-ca-v2";
    requiredAgents: ["A1", "A2", "A3", "A4"];
    caModules: {
      A1: ["Scaffolding", "Fading"];
      A2: ["Modelling", "Coaching"];
      A3: ["Scaffolding"];
      A4: ["Articulation", "Reflection"];
    };
    roles: {
      A1: "frontend-direct-dialogue";
      A2: "frontend-direct-dialogue";
      A3: "backend-a1-signal";
      A4: "backend-a1-reflection";
    };
    xapiExtensions: {
      agentRole: true;
      agentCaModules: true;
      agentFamily: true;
      agentPhaseScope: true;
      pseudonymousSessionId: true;
    };
    complete: true;
  };
  agentResponsibilities: {
    A1: ["scaffold_request", "scaffold_self_check_started"];
    A2: ["expert_model_viewed", "coaching_push", "ai_acceptance_recorded"];
    A3: [
      "artifact_edited",
      "artifact_saved",
      "planning_submitted",
      "monitoring_pause_detected",
    ];
    A4: ["articulation_submitted", "expert_trace_compared", "self_report_saved"];
  };
  triggers: [
    "monitoring_pause_detected",
    "coaching_push",
    "ai_acceptance_recorded",
  ];
  signals: [
    "low_progress_artifact_autosave",
    "artifact_regression_autosave",
  ];
  coaching: {
    interruption: "low";
    cooldownSeconds: number;
  };
  artifactRegression: {
    minimumPreviousCharacters: number;
    minimumDropCharacters: number;
    rawTextExcluded: true;
  };
  aiAcceptance: {
    decisionKeyed: true;
    revisions: true;
    rawMessageIdsExcluded: true;
    rationaleTextExcluded: true;
  };
  redaction: "raw-learner-text-excluded";
};

export type AaisA3SupervisionCapability = AaisAgentEvidenceCapability;
export type AaisA2MonitoringCapability = AaisAgentEvidenceCapability;

const aaisLrsOutboxCoalescingPolicy = {
  windowSeconds: 30,
  events: ["artifact_saved", "artifact_edited", "planning_submitted"] as const,
  strategy: "latest-write-wins" as const,
};
const aaisA2CoachingCooldownMs = 10 * 60 * 1000;
const aaisA2ArtifactRegressionMinimumPreviousCharacters = 80;
const aaisA2ArtifactRegressionMinimumDropCharacters = 40;

const taskOrder = [
  ...aaisLearningProgram.training.tasks,
  ...aaisLearningProgram.practice.tasks,
].map((task) => ({
  taskId: task.id,
  phase: task.phase,
}));

const ensureLearnerSessionsTableSql = `create table if not exists aais_learner_sessions (
        student_id text primary key,
        payload jsonb not null,
        updated_at timestamptz not null default now()
      )`;

const ensureLrsOutboxTableSql = `create table if not exists aais_lrs_outbox (
        id text primary key,
        payload jsonb not null,
        status text not null default 'pending',
        attempts integer not null default 0,
        last_error text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`;

export function createAaisLearningStore(input: StoreInput = {}) {
  const rootDir = input.rootDir ?? getDefaultDataDir();
  const database = input.database ?? getConfiguredDatabaseClient();
  let databaseSchemaReady = false;

  async function getOrCreateSession(studentId: string): Promise<AaisLearnerSession> {
    const safeStudentId = requireSafeId(studentId, "student id");
    const existing = await readSession(safeStudentId);
    if (existing) {
      return normalizeSession(existing);
    }
    const now = new Date().toISOString();
    const sessionId = createAaisSessionId(safeStudentId, now);
    const session: AaisLearnerSession = {
      schemaVersion: 1,
      studentId: safeStudentId,
      sessionId,
      createdAt: now,
      updatedAt: now,
      activeTaskId: "training_task_1",
      activeStage: "home",
      tasks: taskOrder.map((task, index) => ({
        taskId: task.taskId,
        phase: task.phase,
        status: index === 0 ? "active" : "locked",
        artifactText: "",
        selfReport: "",
        scaffoldRequests: 0,
        scaffoldHistory: [],
      })),
      guideMessages: [],
      events: [
        createAaisEvent({
          studentId: safeStudentId,
          sessionId,
          phase: "training",
          task: "training_task_1",
          agent: "platform",
          event: "session_created",
          detail: {
            schemaVersion: 1,
          },
          now: () => new Date(now),
        }),
        createAaisEvent({
          studentId: safeStudentId,
          sessionId,
          phase: "training",
          task: "training_task_1",
          agent: "A1",
          event: "task_released",
          detail: {
            taskId: "training_task_1",
            releaseReason: "initial_training_task",
          },
          now: () => new Date(now),
        }),
      ],
    };
    await writeSessionAndMirrorEvents(session, session.events);
    return session;
  }

  async function selectStage(studentId: string, stageId: string) {
    const session = await getOrCreateSession(studentId);
    const task = requireTask(session, session.activeTaskId);
    const updated = touch({
      ...session,
      activeStage: requireSafeText(stageId, "stage id"),
      events: [
        ...session.events,
        createAaisEvent({
          studentId: session.studentId,
          sessionId: session.sessionId,
          phase: task.phase,
          task: task.taskId,
          agent: "platform",
          event: "stage_selected",
          detail: {
            stageId,
          },
        }),
        ...createStageEvidenceEvents(session, task, stageId),
      ],
    });
    await writeSessionAndMirrorEvents(updated, updated.events.slice(session.events.length));
    return updated;
  }

  async function selectTask(studentId: string, taskId: string) {
    const session = await getOrCreateSession(studentId);
    const selected = requireTask(session, taskId);
    if (selected.status === "locked") {
      throw new Error(`Task ${taskId} is locked`);
    }

    const tasks = session.tasks.map((task): AaisTaskRecord => {
      if (task.taskId === taskId) {
        return {
          ...task,
          status: task.status === "completed" ? "completed" : "active" as const,
        };
      }
      if (task.status === "active") {
        return {
          ...task,
          status: "available" as const,
        };
      }
      return task;
    });
    const updated = touch({
      ...session,
      activeTaskId: taskId,
      activeStage: selected.phase === "practice" ? "practice" : "training",
      tasks,
      events: [
        ...session.events,
        createAaisEvent({
          studentId: session.studentId,
          sessionId: session.sessionId,
          phase: selected.phase,
          task: taskId,
          agent: "platform",
          event: "task_selected",
          detail: {
            taskId,
          },
        }),
      ],
    });
    await writeSessionAndMirrorEvents(updated, updated.events.slice(session.events.length));
    return updated;
  }

  async function completeTask(studentId: string, taskId: string) {
    const session = await getOrCreateSession(studentId);
    const completed = requireTask(session, taskId);
    const nextTaskId = getNextTaskId(taskId);
    const tasks = session.tasks.map((task) => {
      if (task.taskId === taskId) {
        return {
          ...task,
          status: "completed" as const,
        };
      }
      if (task.taskId === nextTaskId && task.status === "locked") {
        return {
          ...task,
          status: "available" as const,
        };
      }
      return task;
    });
    const updated = touch({
      ...session,
      tasks,
      events: [
        ...session.events,
        createAaisEvent({
          studentId: session.studentId,
          sessionId: session.sessionId,
          phase: completed.phase,
          task: taskId,
          agent: "platform",
          event: "task_completed",
          detail: {
            taskId,
            unlockedTaskId: nextTaskId,
          },
        }),
        ...createTaskReleaseEvents(session, nextTaskId),
      ],
    });
    await writeSessionAndMirrorEvents(updated, updated.events.slice(session.events.length));
    return updated;
  }

  async function saveArtifact(studentId: string, taskId: string, artifactText: string) {
    return saveTaskText({
      studentId,
      taskId,
      field: "artifactText",
      value: artifactText,
      event: "artifact_saved",
    });
  }

  async function saveSelfReport(studentId: string, taskId: string, selfReport: string) {
    return saveTaskText({
      studentId,
      taskId,
      field: "selfReport",
      value: selfReport,
      event: "self_report_saved",
    });
  }

  async function requestScaffold(
    studentId: string,
    taskId: string,
    toolId: string,
  ): Promise<ScaffoldResult> {
    const session = await getOrCreateSession(studentId);
    const task = requireTask(session, taskId);
    if (task.phase !== "practice") {
      throw new Error("A1 scaffolding is only available in practice tasks");
    }
    const tool = scaffoldTools.find((candidate) => candidate.id === toolId) ?? scaffoldTools[0];
    const requestCount = task.scaffoldRequests + 1;
    const mode: AaisTaskRecord["scaffoldHistory"][number]["mode"] =
      requestCount >= 5 ? "self-check" : "tool-list";
    const now = new Date().toISOString();
    const tasks = session.tasks.map((candidate): AaisTaskRecord =>
      candidate.taskId === taskId
        ? {
            ...candidate,
            scaffoldRequests: requestCount,
            scaffoldHistory: [
              ...candidate.scaffoldHistory,
              {
                toolId: tool.id,
                mode,
                time: now,
              },
            ],
          }
        : candidate,
    );
    const updated = touch({
      ...session,
      tasks,
      events: [
        ...session.events,
        createAaisEvent({
          studentId: session.studentId,
          sessionId: session.sessionId,
          phase: "practice",
          task: taskId,
          agent: "A1",
          event: "scaffold_request",
          detail: {
            request_count: requestCount,
            tool_id: tool.id,
            mode,
          },
          now: () => new Date(now),
        }),
        ...(mode === "self-check"
          ? [
              createAaisEvent({
                studentId: session.studentId,
                sessionId: session.sessionId,
                phase: "practice",
                task: taskId,
                agent: "A1",
                event: "scaffold_self_check_started",
                detail: {
                  request_count: requestCount,
                  tool_id: tool.id,
                },
                now: () => new Date(now),
              }),
            ]
          : []),
      ],
    });
    await writeSessionAndMirrorEvents(updated, updated.events.slice(session.events.length));
    return {
      mode,
      requestCount,
      tool,
      session: updated,
    };
  }

  async function recordAiAcceptance(
    studentId: string,
    taskId: string,
    input: {
      accepted: boolean;
      messageId?: string;
      reason?: string;
    },
  ) {
    const session = await getOrCreateSession(studentId);
    const task = requireTask(session, taskId);
    const reason = requireSafeText(input.reason ?? "", "AI acceptance reason");
    const decisionKey = input.messageId
      ? createAiAcceptanceDecisionKey(session, task, requireSafeId(input.messageId, "AI message id"))
      : null;
    const existingDecisionEvents = decisionKey
      ? session.events.filter((event) =>
          event.event === "ai_acceptance_recorded"
          && event.task === task.taskId
          && event.detail.decision_key === decisionKey
        )
      : [];
    const latestDecision = existingDecisionEvents.at(-1);
    if (latestDecision?.detail.accepted === input.accepted) {
      return session;
    }
    const event = createAaisEvent({
      studentId: session.studentId,
      sessionId: session.sessionId,
      phase: task.phase,
      task: task.taskId,
      agent: "A2",
      event: "ai_acceptance_recorded",
      detail: {
        accepted: input.accepted,
        reason_length: reason.trim().length,
        ...(decisionKey
          ? {
              decision_key: decisionKey,
              message_id_hash: decisionKey,
              revision: existingDecisionEvents.length + 1,
              supersedes_previous: existingDecisionEvents.length > 0,
            }
          : {}),
      },
    });
    const updated = touch({
      ...session,
      events: [...session.events, event],
    });
    await writeSessionAndMirrorEvents(updated, [event]);
    return updated;
  }

  async function appendGuideExchange(input: {
    studentId: string;
    phase: AaisPhase;
    taskId: string;
    question: string;
    answer: string;
    turns?: AaisGuideTurnRecord[];
    orchestration: {
      graphId: string;
      topologicalOrder: string[];
      threadId: string;
    };
  }) {
    const session = await getOrCreateSession(input.studentId);
    const task = requireTask(session, input.taskId);
    const now = new Date().toISOString();
    const userMessage: AaisGuideMessageRecord = {
      id: `user-${hashForId([input.studentId, input.taskId, input.question, now].join("|"))}`,
      kind: "user",
      text: input.question,
      time: now,
    };
    const assistantMessage: AaisGuideMessageRecord = {
      id: `assistant-${hashForId([input.studentId, input.taskId, input.answer, now].join("|"))}`,
      kind: "assistant",
      text: input.answer,
      time: now,
      ...(input.turns?.length ? { turns: input.turns } : {}),
      orchestration: input.orchestration,
    };
    const updated = touch({
      ...session,
      guideMessages: [...session.guideMessages, userMessage, assistantMessage],
      events: [
        ...session.events,
        createAaisEvent({
          studentId: session.studentId,
          sessionId: session.sessionId,
          phase: input.phase,
          task: task.taskId,
          agent: "A2",
          event: "ai_prompt_submitted",
          detail: {
            prompt_length: input.question.length,
          },
          now: () => new Date(now),
        }),
        createAaisEvent({
          studentId: session.studentId,
          sessionId: session.sessionId,
          phase: input.phase,
          task: task.taskId,
          agent: "A1",
          event: "ai_response_completed",
          detail: {
            graphId: input.orchestration.graphId,
            node_count: input.orchestration.topologicalOrder.length,
            response_length: input.answer.length,
          },
          now: () => new Date(now),
        }),
      ],
    });
    await writeSessionAndMirrorEvents(updated, updated.events.slice(session.events.length));
    return updated;
  }

  async function exportEvents(studentId: string, format: "json" | "csv") {
    const session = await getOrCreateSession(studentId);
    if (format === "json") {
      return {
        fileName: `aais-${session.studentId}-events.json`,
        contentType: "application/json;charset=utf-8",
        body: exportAaisEventsAsJson(session.events),
      };
    }
    return {
      fileName: `aais-${session.studentId}-events.csv`,
      contentType: "text/csv;charset=utf-8",
      body: exportAaisEventsAsCsv(session.events),
    };
  }

  async function exportCohortAnalytics(format: "json" | "csv", filters: AaisCohortAnalyticsFilters = {}) {
    const analytics = await getCohortAnalytics(filters);
    const exported = buildAaisCohortAnalyticsExport(analytics);
    if (format === "json") {
      return {
        fileName: "aais-cohort-analytics.json",
        contentType: "application/json;charset=utf-8",
        body: JSON.stringify(exported, null, 2),
      };
    }
    return {
      fileName: "aais-cohort-analytics.csv",
      contentType: "text/csv;charset=utf-8",
      body: exportAaisCohortAnalyticsAsCsv(exported.learners),
    };
  }

  async function getAnalytics(studentId: string) {
    const session = await getOrCreateSession(studentId);
    return summarizeAaisLearningAnalytics(session);
  }

  async function getCohortAnalytics(filters: AaisCohortAnalyticsFilters = {}) {
    const sessions = await readAllSessions();
    return summarizeAaisCohortAnalytics(sessions, filters);
  }

  async function saveTaskText(input: {
    studentId: string;
    taskId: string;
    field: "artifactText" | "selfReport";
    value: string;
    event: "artifact_saved" | "self_report_saved";
  }) {
    const session = await getOrCreateSession(input.studentId);
    const task = requireTask(session, input.taskId);
    const value = requireSafeText(input.value, input.field);
    const previousTask = task;
    const tasks = session.tasks.map((candidate) =>
      candidate.taskId === input.taskId
        ? {
            ...candidate,
            [input.field]: value,
          }
        : candidate,
    );
    const now = new Date();
    const artifactEditEvent = input.field === "artifactText"
      ? createAaisEvent({
          studentId: session.studentId,
          sessionId: session.sessionId,
          phase: task.phase,
          task: task.taskId,
          agent: "A3",
          event: "artifact_edited",
          detail: {
            characters: value.length,
            source: "debounced_server_save",
          },
          now: () => now,
        })
      : null;
    const primaryEvent = createAaisEvent({
      studentId: session.studentId,
      sessionId: session.sessionId,
      phase: task.phase,
      task: task.taskId,
      agent: input.field === "artifactText" ? "A3" : "A4",
      event: input.event,
      detail: {
        characters: value.length,
      },
      now: () => now,
    });
    const evidenceEvents = createTaskTextEvidenceEvents({
      session,
      task,
      event: input.event,
      value,
    });
    const monitoringEvents = input.field === "artifactText"
      ? createArtifactMonitoringEvents({
          session,
          task,
          previousValue: previousTask.artifactText,
          nextValue: value,
        })
      : [];
    const newEvents = [
      ...(artifactEditEvent ? [artifactEditEvent] : []),
      primaryEvent,
      ...evidenceEvents,
      ...monitoringEvents,
    ];
    const updated = touch({
      ...session,
      tasks,
      events: [...session.events, ...newEvents],
    });
    await writeSessionAndMirrorEvents(updated, newEvents);
    return updated;
  }

  async function readSession(studentId: string) {
    if (database) {
      await ensureDatabaseSchema();
      const result = await database.query(
        "select payload from aais_learner_sessions where student_id = $1 limit 1",
        [requireSafeId(studentId, "student id")],
      );
      return parseDatabaseSessionPayload(result.rows[0]?.payload);
    }
    try {
      const raw = await readFile(getSessionPath(studentId), "utf8");
      return JSON.parse(raw) as AaisLearnerSession;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async function writeSession(session: AaisLearnerSession) {
    if (database) {
      await ensureDatabaseSchema();
      await database.query(
        `insert into aais_learner_sessions (student_id, payload, updated_at)
         values ($1, $2::jsonb, now())
         on conflict (student_id)
         do update set payload = excluded.payload, updated_at = now()`,
        [session.studentId, JSON.stringify(session)],
      );
      return;
    }
    await mkdir(getSessionsDir(), { recursive: true });
    const target = getSessionPath(session.studentId);
    const tempPath = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
    await rename(tempPath, target);
  }

  async function readAllSessions() {
    if (database) {
      await ensureDatabaseSchema();
      const result = await database.query(
        "select payload from aais_learner_sessions order by updated_at desc",
      );
      return result.rows
        .map((row) => parseDatabaseSessionPayload(row.payload))
        .filter((session): session is AaisLearnerSession => Boolean(session))
        .map(normalizeSession);
    }
    try {
      const fileNames = await readdir(getSessionsDir());
      const sessions = await Promise.all(
        fileNames
          .filter((fileName) => fileName.endsWith(".json"))
          .map(async (fileName) => {
            const raw = await readFile(path.join(getSessionsDir(), fileName), "utf8");
            return normalizeSession(JSON.parse(raw) as AaisLearnerSession);
          }),
      );
      return sessions;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async function ensureDatabaseSchema() {
    if (databaseSchemaReady || !database) {
      return;
    }
    await database.query(ensureLearnerSessionsTableSql);
    await database.query(ensureLrsOutboxTableSql);
    databaseSchemaReady = true;
  }

  async function writeSessionAndMirrorEvents(session: AaisLearnerSession, events: AaisEvent[]) {
    await writeSession(session);
    if (!events.length) {
      return;
    }
    if (database) {
      await writeLrsOutboxEvents(database, events);
      void flushAaisPersistentLrsOutbox({ database }).catch(() => undefined);
      return;
    }
    enqueueAaisLrsEvents(events);
  }

  function getSessionsDir() {
    return path.join(rootDir, "sessions");
  }

  function getSessionPath(studentId: string) {
    return path.join(getSessionsDir(), `${requireSafeId(studentId, "student id")}.json`);
  }

  return {
    appendGuideExchange,
    completeTask,
    exportCohortAnalytics,
    exportEvents,
    getCohortAnalytics,
    getAnalytics,
    getOrCreateSession,
    recordAiAcceptance,
    requestScaffold,
    saveArtifact,
    saveSelfReport,
    selectStage,
    selectTask,
  };
}

export function summarizeAaisLearningAnalytics(session: AaisLearnerSession) {
  const practiceTasks = session.tasks.filter((task) => task.phase === "practice");
  const activePracticeTask = practiceTasks.find((task) => task.taskId === session.activeTaskId)
    ?? practiceTasks.find((task) => task.status === "active")
    ?? practiceTasks.find((task) => task.status === "available")
    ?? practiceTasks[0];
  const scaffoldRequests = session.events.filter((event) => event.event === "scaffold_request");
  const explicitSelfCheckEvents = session.events.filter((event) => event.event === "scaffold_self_check_started");
  const selfCheckRequests = explicitSelfCheckEvents.length
    ? explicitSelfCheckEvents
    : session.events.filter((event) =>
        event.event === "scaffold_request" && event.detail.mode === "self-check"
      );
  const selfReportEvents = session.events.filter((event) => event.event === "self_report_saved");
  const expertTraceEvents = session.events.filter((event) => event.event === "expert_trace_compared");
  const coachingEvents = session.events.filter((event) =>
    event.event === "coaching_push" || event.event === "monitoring_pause_detected"
  );
  const aiAcceptanceDecisionCount = countUniqueAiAcceptanceDecisions(session.events);
  const aiPromptResponseEvents = session.events.filter((event) =>
    event.event === "ai_prompt_submitted"
    || event.event === "ai_response_completed"
  );

  return {
    dashboard: {
      trainingToPractice: {
        trainingCompleted: session.tasks.some((task) =>
          task.phase === "training" && task.status === "completed"
        ),
        activePracticeTaskId: activePracticeTask?.taskId ?? null,
        completedPracticeTasks: practiceTasks.filter((task) => task.status === "completed").length,
        availablePracticeTasks: practiceTasks.filter((task) =>
          task.status === "available" || task.status === "active" || task.status === "completed"
        ).length,
      },
      scaffoldDependency: {
        totalRequests: scaffoldRequests.length,
        selfCheckRequests: selfCheckRequests.length,
        status: selfCheckRequests.length
          ? "self_check_triggered"
          : scaffoldRequests.length
            ? "tool_support_active"
            : "no_scaffold_requested",
      },
      reflectionQuality: {
        selfReportCount: selfReportEvents.length,
        expertTraceComparisonCount: expertTraceEvents.length,
        status: selfReportEvents.length && expertTraceEvents.length
          ? "evidence_present"
          : "needs_reflection_evidence",
      },
      coachingEffect: {
        monitoringSignals: coachingEvents.length,
        aiInteractions: aiPromptResponseEvents.length + aiAcceptanceDecisionCount,
        aiAcceptanceDecisions: aiAcceptanceDecisionCount,
        status: coachingEvents.length ? "coaching_observed" : "no_coaching_signal",
      },
    },
    integrations: {
      factLayer: "lrs",
      joinKeys: ["session_id", "phase", "task", "agent", "event", "cohort", "role", "course_id"],
    },
    privacy: {
      actorMode: "pseudonymous",
      rawPromptStorage: "excluded_from_lrs",
      minimumNecessaryFields: true,
    },
  };
}

export function getAaisAgentEvidenceCapability(): AaisAgentEvidenceCapability {
  return {
    enabled: true,
    agentContract: {
      version: "aais-a1-a4-ca-v2",
      requiredAgents: ["A1", "A2", "A3", "A4"],
      caModules: {
        A1: ["Scaffolding", "Fading"],
        A2: ["Modelling", "Coaching"],
        A3: ["Scaffolding"],
        A4: ["Articulation", "Reflection"],
      },
      roles: {
        A1: "frontend-direct-dialogue",
        A2: "frontend-direct-dialogue",
        A3: "backend-a1-signal",
        A4: "backend-a1-reflection",
      },
      xapiExtensions: {
        agentRole: true,
        agentCaModules: true,
        agentFamily: true,
        agentPhaseScope: true,
        pseudonymousSessionId: true,
      },
      complete: true,
    },
    agentResponsibilities: {
      A1: ["scaffold_request", "scaffold_self_check_started"],
      A2: ["expert_model_viewed", "coaching_push", "ai_acceptance_recorded"],
      A3: [
        "artifact_edited",
        "artifact_saved",
        "planning_submitted",
        "monitoring_pause_detected",
      ],
      A4: ["articulation_submitted", "expert_trace_compared", "self_report_saved"],
    },
    triggers: [
      "monitoring_pause_detected",
      "coaching_push",
      "ai_acceptance_recorded",
    ],
    signals: [
      "low_progress_artifact_autosave",
      "artifact_regression_autosave",
    ],
    coaching: {
      interruption: "low",
      cooldownSeconds: aaisA2CoachingCooldownMs / 1000,
    },
    artifactRegression: {
      minimumPreviousCharacters: aaisA2ArtifactRegressionMinimumPreviousCharacters,
      minimumDropCharacters: aaisA2ArtifactRegressionMinimumDropCharacters,
      rawTextExcluded: true,
    },
    aiAcceptance: {
      decisionKeyed: true,
      revisions: true,
      rawMessageIdsExcluded: true,
      rationaleTextExcluded: true,
    },
    redaction: "raw-learner-text-excluded",
  };
}

export function getAaisA3SupervisionCapability(): AaisA3SupervisionCapability {
  return getAaisAgentEvidenceCapability();
}

export function getAaisA2MonitoringCapability(): AaisA2MonitoringCapability {
  return getAaisAgentEvidenceCapability();
}

export function summarizeAaisCohortAnalytics(
  sessions: AaisLearnerSession[],
  filters: AaisCohortAnalyticsFilters = {},
) {
  const appliedFilters = normalizeCohortAnalyticsFilters(filters);
  const hasFilters = Object.keys(appliedFilters).length > 0;
  const normalizedSessions = sessions
    .map(normalizeSession)
    .map((session) => {
      if (!hasFilters) {
        return session;
      }
      return {
        ...session,
        events: session.events.filter((event) => matchesCohortAnalyticsFilters(event, appliedFilters)),
      };
    })
    .filter((session) => !hasFilters || session.events.length > 0);
  const learnerSummaries = normalizedSessions.map((session) => {
    const analytics = summarizeAaisLearningAnalytics(session);
    const learnerSummary = {
      learnerKey: createPseudonymousAnalyticsLearnerKey(session.studentId),
      sessionKey: createPseudonymousAnalyticsSessionKey(session.sessionId),
      updatedAt: session.updatedAt,
      trainingCompleted: analytics.dashboard.trainingToPractice.trainingCompleted,
      activePracticeTaskId: analytics.dashboard.trainingToPractice.activePracticeTaskId,
      completedPracticeTasks: analytics.dashboard.trainingToPractice.completedPracticeTasks,
      scaffoldRequests: analytics.dashboard.scaffoldDependency.totalRequests,
      coachingSignals: analytics.dashboard.coachingEffect.monitoringSignals,
      aiInteractions: analytics.dashboard.coachingEffect.aiInteractions,
      aiAcceptanceDecisions: analytics.dashboard.coachingEffect.aiAcceptanceDecisions,
      reflectionStatus: analytics.dashboard.reflectionQuality.status,
    };
    return {
      ...learnerSummary,
      ...summarizeCohortLearnerRisk(learnerSummary),
    };
  });
  const riskBreakdown = countCohortRiskLevels(learnerSummaries);
  return {
    filters: {
      applied: appliedFilters,
    },
    dashboard: {
      cohort: {
        learnerCount: learnerSummaries.length,
        trainingCompleted: learnerSummaries.filter((learner) => learner.trainingCompleted).length,
        completedPracticeTasks: learnerSummaries.reduce(
          (total, learner) => total + learner.completedPracticeTasks,
          0,
        ),
        scaffoldRequests: learnerSummaries.reduce((total, learner) => total + learner.scaffoldRequests, 0),
        coachingSignals: learnerSummaries.reduce((total, learner) => total + learner.coachingSignals, 0),
        aiInteractions: learnerSummaries.reduce((total, learner) => total + learner.aiInteractions, 0),
        aiAcceptanceDecisions: learnerSummaries.reduce(
          (total, learner) => total + learner.aiAcceptanceDecisions,
          0,
        ),
        riskBreakdown,
      },
    },
    learners: learnerSummaries,
    integrations: {
      factLayer: "lrs",
      joinKeys: ["session_id", "phase", "task", "agent", "event", "cohort", "role", "course_id"],
    },
    privacy: {
      actorMode: "pseudonymous",
      rawPromptStorage: "excluded_from_lrs",
      minimumNecessaryFields: true,
    },
  };
}

function buildAaisCohortAnalyticsExport(analytics: ReturnType<typeof summarizeAaisCohortAnalytics>) {
  return {
    schemaVersion: 1,
    exportScope: "cohort" as const,
    generatedAt: new Date().toISOString(),
    filters: analytics.filters,
    dashboard: analytics.dashboard,
    learners: analytics.learners.map((learner) => ({
      learnerKey: learner.learnerKey,
      sessionKey: learner.sessionKey,
      updatedAt: learner.updatedAt,
      trainingCompleted: learner.trainingCompleted,
      activePracticeTaskId: learner.activePracticeTaskId,
      completedPracticeTasks: learner.completedPracticeTasks,
      scaffoldRequests: learner.scaffoldRequests,
      coachingSignals: learner.coachingSignals,
      aiInteractions: learner.aiInteractions,
      aiAcceptanceDecisions: learner.aiAcceptanceDecisions,
      reflectionStatus: learner.reflectionStatus,
      riskLevel: learner.riskLevel,
      priorityReasons: learner.priorityReasons,
    })),
    integrations: analytics.integrations,
    privacy: {
      ...analytics.privacy,
      rawLearnerText: "excluded" as const,
    },
    secrets: "redacted" as const,
  };
}

function exportAaisCohortAnalyticsAsCsv(
  learners: ReturnType<typeof buildAaisCohortAnalyticsExport>["learners"],
) {
  const header = [
    "learner_key",
    "risk_level",
    "priority_reasons",
    "training_completed",
    "active_practice_task_id",
    "completed_practice_tasks",
    "scaffold_requests",
    "coaching_signals",
    "ai_interactions",
    "ai_acceptance_decisions",
    "reflection_status",
    "updated_at",
    "session_key",
  ];
  const rows = learners.map((learner) => [
    learner.learnerKey,
    learner.riskLevel,
    learner.priorityReasons.join("|"),
    String(learner.trainingCompleted),
    learner.activePracticeTaskId ?? "",
    String(learner.completedPracticeTasks),
    String(learner.scaffoldRequests),
    String(learner.coachingSignals),
    String(learner.aiInteractions),
    String(learner.aiAcceptanceDecisions),
    learner.reflectionStatus,
    learner.updatedAt,
    learner.sessionKey,
  ].map(escapeAaisCsvField).join(","));
  return [header.join(","), ...rows].join("\n");
}

function summarizeCohortLearnerRisk(learner: {
  trainingCompleted: boolean;
  scaffoldRequests: number;
  coachingSignals: number;
  aiInteractions: number;
  reflectionStatus: string;
}): {
  riskLevel: AaisCohortRiskLevel;
  priorityReasons: AaisCohortPriorityReason[];
} {
  const priorityReasons: AaisCohortPriorityReason[] = [];
  if (!learner.trainingCompleted) {
    priorityReasons.push("training_incomplete");
  }
  if (learner.reflectionStatus !== "evidence_present") {
    priorityReasons.push("reflection_missing");
  }
  if (learner.coachingSignals > 0) {
    priorityReasons.push("a2_coaching_signals");
  }
  if (learner.scaffoldRequests >= 5) {
    priorityReasons.push("high_scaffold_dependency");
  }
  if (learner.coachingSignals > 0 && learner.aiInteractions === 0) {
    priorityReasons.push("no_ai_interaction_after_coaching");
  }

  return {
    riskLevel: selectCohortRiskLevel(priorityReasons),
    priorityReasons,
  };
}

function selectCohortRiskLevel(priorityReasons: AaisCohortPriorityReason[]): AaisCohortRiskLevel {
  if (
    priorityReasons.length >= 3
    || (priorityReasons.includes("reflection_missing") && priorityReasons.includes("a2_coaching_signals"))
    || priorityReasons.includes("high_scaffold_dependency")
  ) {
    return "high";
  }
  return priorityReasons.length ? "medium" : "low";
}

function countCohortRiskLevels(learners: Array<{ riskLevel: AaisCohortRiskLevel }>) {
  return learners.reduce(
    (counts, learner) => ({
      ...counts,
      [learner.riskLevel]: counts[learner.riskLevel] + 1,
    }),
    {
      high: 0,
      medium: 0,
      low: 0,
    },
  );
}

function countUniqueAiAcceptanceDecisions(events: AaisEvent[]) {
  const decisionKeys = new Set<string>();
  let legacyDecisionCount = 0;
  for (const event of events) {
    if (event.event !== "ai_acceptance_recorded") {
      continue;
    }
    const decisionKey = typeof event.detail.decision_key === "string"
      ? event.detail.decision_key
      : "";
    if (decisionKey) {
      decisionKeys.add(decisionKey);
      continue;
    }
    legacyDecisionCount += 1;
  }
  return decisionKeys.size + legacyDecisionCount;
}

export function normalizeCohortAnalyticsFilters(
  filters: AaisCohortAnalyticsFilters = {},
): AaisCohortAnalyticsFilters {
  const applied: AaisCohortAnalyticsFilters = {};
  if (filters.phase) {
    if (filters.phase !== "training" && filters.phase !== "practice") {
      throw new Error("Invalid AAIS cohort analytics phase filter.");
    }
    applied.phase = filters.phase;
  }
  if (filters.task) {
    applied.task = requireSafeId(filters.task, "cohort analytics task filter");
  }
  if (filters.agent) {
    if (!isAaisAnalyticsAgent(filters.agent)) {
      throw new Error("Invalid AAIS cohort analytics agent filter.");
    }
    applied.agent = filters.agent;
  }
  if (filters.event) {
    if (!Object.hasOwn(aaisEventDefinitions, filters.event)) {
      throw new Error("Invalid AAIS cohort analytics event filter.");
    }
    applied.event = filters.event;
  }
  if (filters.cohort) {
    applied.cohort = requireSafeId(filters.cohort, "cohort analytics cohort filter");
  }
  if (filters.role) {
    applied.role = requireSafeId(filters.role, "cohort analytics role filter");
  }
  if (filters.courseId) {
    applied.courseId = requireSafeId(filters.courseId, "cohort analytics course filter");
  }
  return applied;
}

function matchesCohortAnalyticsFilters(event: AaisEvent, filters: AaisCohortAnalyticsFilters) {
  return (!filters.phase || event.phase === filters.phase)
    && (!filters.task || event.task === filters.task)
    && (!filters.agent || event.agent === filters.agent)
    && (!filters.event || event.event === filters.event)
    && (!filters.cohort || event.detail.cohort === filters.cohort)
    && (!filters.role || event.detail.role === filters.role)
    && (!filters.courseId || event.detail.course_id === filters.courseId || event.detail.courseId === filters.courseId);
}

function isAaisAnalyticsAgent(value: string): value is AaisAgentId | "platform" {
  return value === "A1" || value === "A2" || value === "A3" || value === "A4" || value === "platform";
}

export async function flushAaisPersistentLrsOutbox(input: {
  database?: AaisDatabaseClient;
  config?: {
    endpoint: string;
    username: string;
    password: string;
  } | null;
  fetchImpl?: typeof fetch;
  limit?: number;
  maxBatchSize?: number;
  maxAttempts?: number;
} = {}) {
  const database = input.database ?? getConfiguredDatabaseClient();
  if (!database) {
    return {
      status: "not_configured" as const,
      sent: 0,
      secrets: "redacted" as const,
    };
  }
  await database.query(ensureLrsOutboxTableSql);
  const result = await database.query(
    `select id, payload, attempts
     from aais_lrs_outbox
     where status in ('pending', 'retry')
     order by created_at asc
     limit $1`,
    [input.limit ?? 50],
  );
  let sent = 0;
  let failed = 0;
  let batches = 0;
  for (const batch of chunkOutboxRows(result.rows, input.maxBatchSize ?? 50)) {
    const events = batch.map((row) => normalizeOutboxPayload(row.payload));
    const delivery = await sendAaisEventsToLrs(events, {
      config: input.config,
      fetchImpl: input.fetchImpl,
      maxBatchSize: events.length,
    });
    if (delivery.status === "not_configured") {
      return {
        status: "not_configured" as const,
        sent,
        batches,
        secrets: "redacted" as const,
      };
    }
    if (delivery.status === "sent") {
      batches += 1;
      sent += batch.length;
      await Promise.all(batch.map((row) =>
        database.query(
          "update aais_lrs_outbox set status = 'sent', updated_at = now() where id = $1",
          [row.id],
        )
      ));
      continue;
    }
    batches += 1;
    failed += batch.length;
    await Promise.all(batch.map((row) => {
      const attempts = Number(row.attempts ?? 0) + 1;
      const status = attempts >= (input.maxAttempts ?? 3) ? "dead_letter" : "retry";
      return database.query(
        "update aais_lrs_outbox set status = $1, attempts = $2, last_error = 'redacted', updated_at = now() where id = $3",
        [status, attempts, row.id],
      );
    }));
  }
  return {
    status: failed ? "partial" as const : "sent" as const,
    sent,
    failed,
    batches,
    secrets: "redacted" as const,
  };
}

export async function requeueAaisPersistentLrsDeadLetters(input: {
  database?: AaisDatabaseClient;
  limit?: number;
} = {}) {
  const database = input.database ?? getConfiguredDatabaseClient();
  if (!database) {
    return {
      status: "not_configured" as const,
      requeued: 0,
      secrets: "redacted" as const,
    };
  }
  await database.query(ensureLrsOutboxTableSql);
  const result = await database.query(
    `update aais_lrs_outbox
     set status = 'retry', attempts = 0, last_error = null, updated_at = now()
     where id in (
       select id
       from aais_lrs_outbox
       where status = 'dead_letter'
       order by updated_at asc
       limit $1
     )
     returning id`,
    [input.limit ?? 50],
  );
  const requeued = result.rows.length;
  return {
    status: requeued > 0 ? "requeued" as const : "empty" as const,
    requeued,
    secrets: "redacted" as const,
  };
}

export async function getAaisPersistentLrsOutboxStatus(input: {
  database?: AaisDatabaseClient;
} = {}) {
  const database = input.database ?? getConfiguredDatabaseClient();
  if (!database) {
    return {
      mode: "memory" as const,
      storage: "process" as const,
      configured: false,
      pending: 0,
      retry: 0,
      sent: 0,
      deadLetter: 0,
      total: 0,
      coalescing: getLrsOutboxCoalescingStatus(false),
      recovery: getLrsOutboxRecoveryStatus(false),
      secrets: "redacted" as const,
    };
  }
  await database.query(ensureLrsOutboxTableSql);
  const result = await database.query(
    "select status, count(*)::int as count from aais_lrs_outbox group by status",
  );
  const counts = Object.fromEntries(
    result.rows.map((row) => [String(row.status), Number(row.count ?? 0)]),
  );
  const pending = counts.pending ?? 0;
  const retry = counts.retry ?? 0;
  const sent = counts.sent ?? 0;
  const deadLetter = counts.dead_letter ?? 0;
  return {
    mode: "persistent" as const,
    storage: "postgres" as const,
    configured: true,
    pending,
    retry,
    sent,
    deadLetter,
    total: pending + retry + sent + deadLetter,
    coalescing: getLrsOutboxCoalescingStatus(true),
    recovery: getLrsOutboxRecoveryStatus(true),
    secrets: "redacted" as const,
  };
}

async function writeLrsOutboxEvents(database: AaisDatabaseClient, events: AaisEvent[]) {
  await database.query(ensureLrsOutboxTableSql);
  for (const event of events) {
    const id = createAaisLrsOutboxId(event);
    const payload = await createOutboxPayload(database, id, event);
    await database.query(
      `insert into aais_lrs_outbox (id, payload, status, attempts, updated_at)
       values ($1, $2::jsonb, 'pending', 0, now())
       on conflict (id)
       do update set payload = excluded.payload, status = 'pending', updated_at = now()`,
      [id, JSON.stringify(payload)],
    );
  }
}

async function createOutboxPayload(database: AaisDatabaseClient, id: string, event: AaisEvent) {
  if (!isCoalescibleLrsEvent(event)) {
    return event;
  }
  const result = await database.query(
    "select payload from aais_lrs_outbox where id = $1 limit 1",
    [id],
  );
  const existing = normalizeNullableOutboxPayload(result.rows[0]?.payload);
  const mergedEvents = Number(existing?.detail?.merged_events ?? 0) + 1;
  return {
    ...event,
    detail: {
      ...event.detail,
      merged_events: mergedEvents,
      coalescing_window_seconds: aaisLrsOutboxCoalescingPolicy.windowSeconds,
    },
  };
}

function createAaisLrsOutboxId(event: AaisEvent) {
  const time = Date.parse(event.time);
  const coalescingWindowMs = aaisLrsOutboxCoalescingPolicy.windowSeconds * 1000;
  const coalescingKey = isCoalescibleLrsEvent(event)
    ? Math.floor((Number.isFinite(time) ? time : Date.now()) / coalescingWindowMs)
    : event.time;
  return createHash("sha256")
    .update(JSON.stringify([
      event.student_id,
      event.session_id,
      event.phase,
      event.task,
      event.agent,
      event.event,
      coalescingKey,
    ]))
    .digest("hex")
    .slice(0, 32);
}

function isCoalescibleLrsEvent(event: AaisEvent) {
  return (aaisLrsOutboxCoalescingPolicy.events as readonly string[]).includes(event.event);
}

function getLrsOutboxCoalescingStatus(enabled: boolean) {
  return {
    enabled,
    windowSeconds: aaisLrsOutboxCoalescingPolicy.windowSeconds,
    events: [...aaisLrsOutboxCoalescingPolicy.events],
    strategy: aaisLrsOutboxCoalescingPolicy.strategy,
  };
}

function getLrsOutboxRecoveryStatus(enabled: boolean) {
  return {
    deadLetterRequeue: enabled,
    action: "POST /api/learning/lrs/outbox/flush?action=requeue-dead-letter",
    auth: ["admin-session-csrf", "bearer-token"],
    redaction: "payloads-excluded" as const,
  };
}

function normalizeOutboxPayload(value: unknown): AaisEvent {
  const parsed = normalizeNullableOutboxPayload(value);
  if (!parsed) {
    throw new Error("Invalid AAIS LRS outbox payload.");
  }
  return parsed;
}

function normalizeNullableOutboxPayload(value: unknown): AaisEvent | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    return JSON.parse(value) as AaisEvent;
  }
  return value as AaisEvent;
}

function chunkOutboxRows<T>(rows: T[], batchSize: number) {
  const size = Math.min(50, Math.max(1, Math.floor(batchSize)));
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

let cachedStore:
  | {
      rootDir: string;
      store: ReturnType<typeof createAaisLearningStore>;
    }
  | undefined;

let cachedDatabase:
  | {
      url: string;
      client: AaisDatabaseClient;
    }
  | undefined;

export function getAaisLearningStore() {
  if (isProductionRuntime() && !getAaisDatabaseConfiguration()) {
    throw new AaisLearningStorageConfigurationError();
  }
  const rootDir = getDefaultDataDir();
  if (!cachedStore || cachedStore.rootDir !== rootDir) {
    cachedStore = {
      rootDir,
      store: createAaisLearningStore({ rootDir }),
    };
  }
  return cachedStore.store;
}

export async function probeAaisLearningStorage(input: {
  database?: AaisDatabaseClient;
} = {}): Promise<AaisLearningStorageProbe> {
  const database = input.database ?? getConfiguredDatabaseClient();
  if (!database) {
    return {
      mode: "file",
      status: "not_configured",
    };
  }
  try {
    await database.query(ensureLearnerSessionsTableSql);
    await database.query("select 1 as ok");
    return {
      mode: "postgres",
      status: "connected",
    };
  } catch {
    return {
      mode: "postgres",
      status: "failed",
    };
  }
}

function getDefaultDataDir() {
  if (process.env.AAIS_DATA_DIR) {
    return process.env.AAIS_DATA_DIR;
  }
  if (process.env.VERCEL) {
    return path.join("/tmp", ".aais-data");
  }
  return path.join(process.cwd(), ".aais-data");
}

function isProductionRuntime() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}

function getConfiguredDatabaseClient() {
  const config = getAaisDatabaseConfiguration();
  if (!config) {
    return undefined;
  }
  if (!cachedDatabase || cachedDatabase.url !== config.url) {
    cachedDatabase = {
      url: config.url,
      client: createConfiguredDatabaseClient(config.url),
    };
  }
  return cachedDatabase.client;
}

function createConfiguredDatabaseClient(databaseUrl: string): AaisDatabaseClient {
  if (shouldUseNeonServerlessDriver(databaseUrl)) {
    return createNeonServerlessDatabaseClient(databaseUrl);
  }
  return new Pool({ connectionString: databaseUrl }) as AaisDatabaseClient;
}

function createNeonServerlessDatabaseClient(databaseUrl: string): AaisDatabaseClient {
  const sql = neon(databaseUrl);
  return {
    async query(query, params = []) {
      const result = await sql.query(query, params);
      return normalizeDatabaseQueryResult(result);
    },
    async end() {},
  };
}

function normalizeDatabaseQueryResult(result: unknown): { rows: Array<Record<string, unknown>> } {
  if (Array.isArray(result)) {
    return { rows: result as Array<Record<string, unknown>> };
  }
  if (result && typeof result === "object" && "rows" in result && Array.isArray(result.rows)) {
    return { rows: result.rows as Array<Record<string, unknown>> };
  }
  return { rows: [] };
}

function shouldUseNeonServerlessDriver(databaseUrl: string) {
  const configuredDriver = process.env.AAIS_DATABASE_DRIVER?.trim().toLowerCase();
  if (configuredDriver === "pg") {
    return false;
  }
  if (configuredDriver === "neon-serverless") {
    return true;
  }
  try {
    return new URL(databaseUrl).hostname.toLowerCase().endsWith(".neon.tech");
  } catch {
    return false;
  }
}

export function getAaisDatabaseConfiguration(): AaisDatabaseConfiguration | null {
  const candidates: AaisDatabaseSourceEnv[] = [
    "AAIS_DATABASE_URL",
    "DATABASE_URL",
    "POSTGRES_URL",
    "POSTGRES_PRISMA_URL",
    "POSTGRES_URL_NO_SSL",
    "DATABASE_URL_UNPOOLED",
    "POSTGRES_URL_NON_POOLING",
  ];
  for (const sourceEnv of candidates) {
    const url = process.env[sourceEnv]?.trim();
    if (url) {
      return {
        url,
        sourceEnv,
      };
    }
  }
  const rawPgConfig = getRawPgDatabaseConfiguration();
  if (rawPgConfig) {
    return rawPgConfig;
  }
  return null;
}

function getRawPgDatabaseConfiguration(): AaisDatabaseConfiguration | null {
  const pgConfig = buildRawPgDatabaseConfiguration({
    host: process.env.PGHOST?.trim() || process.env.PGHOST_UNPOOLED?.trim(),
    user: process.env.PGUSER?.trim(),
    database: process.env.PGDATABASE?.trim(),
    password: process.env.PGPASSWORD?.trim(),
    port: process.env.PGPORT?.trim(),
    sslmode: process.env.PGSSLMODE?.trim(),
    sourceEnv: "PG*",
  });
  if (pgConfig) {
    return pgConfig;
  }
  return buildRawPgDatabaseConfiguration({
    host: process.env.POSTGRES_HOST?.trim() || process.env.POSTGRES_HOST_NON_POOLING?.trim(),
    user: process.env.POSTGRES_USER?.trim(),
    database: process.env.POSTGRES_DATABASE?.trim(),
    password: process.env.POSTGRES_PASSWORD?.trim(),
    port: process.env.POSTGRES_PORT?.trim(),
    sslmode: process.env.POSTGRES_SSLMODE?.trim(),
    sourceEnv: "POSTGRES_*",
  });
}

function buildRawPgDatabaseConfiguration(input: {
  host?: string;
  user?: string;
  database?: string;
  password?: string;
  port?: string;
  sslmode?: string;
  sourceEnv: Extract<AaisDatabaseSourceEnv, "PG*" | "POSTGRES_*">;
}): AaisDatabaseConfiguration | null {
  const { host, user, database, password } = input;
  if (!host || !user || !database || !password) {
    return null;
  }
  const url = new URL("postgres://localhost");
  url.hostname = host;
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  if (input.port) {
    url.port = input.port;
  }
  url.searchParams.set("sslmode", input.sslmode || "require");
  return {
    url: url.toString(),
    sourceEnv: input.sourceEnv,
  };
}

function parseDatabaseSessionPayload(payload: unknown) {
  if (!payload) {
    return null;
  }
  if (typeof payload === "string") {
    return JSON.parse(payload) as AaisLearnerSession;
  }
  return payload as AaisLearnerSession;
}

function normalizeSession(session: AaisLearnerSession): AaisLearnerSession {
  const sessionId = session.sessionId ?? createAaisSessionId(session.studentId, session.createdAt);
  return {
    ...session,
    schemaVersion: 1,
    sessionId,
    tasks: taskOrder.map((task, index) => {
      const existing = session.tasks?.find((candidate) => candidate.taskId === task.taskId);
      return {
        taskId: task.taskId,
        phase: task.phase,
        status: existing?.status ?? (index === 0 ? "active" : "locked"),
        artifactText: existing?.artifactText ?? "",
        selfReport: existing?.selfReport ?? "",
        scaffoldRequests: existing?.scaffoldRequests ?? 0,
        scaffoldHistory: existing?.scaffoldHistory ?? [],
      };
    }),
    guideMessages: session.guideMessages ?? [],
    events: (session.events ?? []).map((event) => ({
      ...event,
      session_id: event.session_id ?? sessionId,
    })),
  };
}

function touch(session: AaisLearnerSession): AaisLearnerSession {
  return {
    ...session,
    updatedAt: new Date().toISOString(),
  };
}

function requireTask(session: AaisLearnerSession, taskId: string) {
  const safeTaskId = requireSafeId(taskId, "task id");
  const task = session.tasks.find((candidate) => candidate.taskId === safeTaskId);
  if (!task) {
    throw new Error(`Unknown task ${taskId}`);
  }
  return task;
}

function getNextTaskId(taskId: string) {
  const index = taskOrder.findIndex((task) => task.taskId === taskId);
  return index >= 0 ? taskOrder[index + 1]?.taskId : undefined;
}

function createTaskReleaseEvents(session: AaisLearnerSession, nextTaskId: string | undefined) {
  if (!nextTaskId) {
    return [];
  }
  const nextTask = taskOrder.find((task) => task.taskId === nextTaskId);
  if (!nextTask) {
    return [];
  }
  return [
    createAaisEvent({
      studentId: session.studentId,
      sessionId: session.sessionId,
      phase: nextTask.phase,
      task: nextTask.taskId,
      agent: "A1",
      event: "task_released",
      detail: {
        taskId: nextTask.taskId,
        releaseReason: "previous_task_completed",
      },
    }),
  ];
}

function createStageEvidenceEvents(
  session: AaisLearnerSession,
  task: AaisTaskRecord,
  stageId: string,
) {
  const stageEventMap: Record<string, {
    agent: AaisAgentId;
    event: AaisEventName;
    detail: Record<string, unknown>;
  }> = {
    guide: {
      agent: "A2",
      event: "expert_model_viewed",
      detail: {
        stageId,
      },
    },
    assessment: {
      agent: "A1",
      event: "understanding_check_completed",
      detail: {
        stageId,
        resultRecorded: false,
      },
    },
    reflection: {
      agent: "A4",
      event: "articulation_submitted",
      detail: {
        stageId,
        source: "reflection_stage",
      },
    },
    comparison: {
      agent: "A4",
      event: "expert_trace_compared",
      detail: {
        stageId,
        taskId: task.taskId,
      },
    },
  };
  const mapped = stageEventMap[stageId];
  if (!mapped) {
    return [];
  }
  return [
    createAaisEvent({
      studentId: session.studentId,
      sessionId: session.sessionId,
      phase: task.phase,
      task: task.taskId,
      agent: mapped.agent,
      event: mapped.event,
      detail: mapped.detail,
    }),
  ];
}

function createTaskTextEvidenceEvents(input: {
  session: AaisLearnerSession;
  task: AaisTaskRecord;
  event: "artifact_saved" | "self_report_saved";
  value: string;
}) {
  if (!input.value.trim()) {
    return [];
  }
  const event: AaisEventName = input.event === "artifact_saved"
    ? "planning_submitted"
    : "articulation_submitted";
  const agent: AaisAgentId = input.event === "artifact_saved" ? "A3" : "A4";
  return [
    createAaisEvent({
      studentId: input.session.studentId,
      sessionId: input.session.sessionId,
      phase: input.task.phase,
      task: input.task.taskId,
      agent,
      event,
      detail: {
        characters: input.value.length,
        sourceEvent: input.event,
      },
    }),
  ];
}

function createArtifactMonitoringEvents(input: {
  session: AaisLearnerSession;
  task: AaisTaskRecord;
  previousValue: string;
  nextValue: string;
}) {
  const previousLength = input.previousValue.trim().length;
  const nextLength = input.nextValue.trim().length;
  const now = new Date();
  const regressionDrop = previousLength - nextLength;
  if (
    isSignificantArtifactRegression(previousLength, nextLength)
    && !hasRecentAgentCoaching(input.session, input.task.taskId, now, "artifact_regression_autosave")
  ) {
    return createA3SupervisionAndA2CoachingEvents({
      session: input.session,
      task: input.task,
      now,
      reason: "artifact_regression_autosave",
      previousLength,
      nextLength,
      detail: {
        delta_characters: -regressionDrop,
        recovery_hint: "review_or_replan_before_continuing",
      },
    });
  }
  if (
    !previousLength
    || nextLength > previousLength + 2
    || hasRecentAgentCoaching(input.session, input.task.taskId, now, "low_progress_artifact_autosave")
  ) {
    return [];
  }
  return createA3SupervisionAndA2CoachingEvents({
    session: input.session,
    task: input.task,
    now,
    reason: "low_progress_artifact_autosave",
    previousLength,
    nextLength,
  });
}

function isSignificantArtifactRegression(previousLength: number, nextLength: number) {
  return previousLength >= aaisA2ArtifactRegressionMinimumPreviousCharacters
    && previousLength - nextLength >= aaisA2ArtifactRegressionMinimumDropCharacters;
}

function createA3SupervisionAndA2CoachingEvents(input: {
  session: AaisLearnerSession;
  task: AaisTaskRecord;
  now: Date;
  reason: "low_progress_artifact_autosave" | "artifact_regression_autosave";
  previousLength: number;
  nextLength: number;
  detail?: Record<string, unknown>;
}) {
  return [
    createAaisEvent({
      studentId: input.session.studentId,
      sessionId: input.session.sessionId,
      phase: input.task.phase,
      task: input.task.taskId,
      agent: "A3",
      event: "monitoring_pause_detected",
      detail: {
        signal: input.reason,
        previous_characters: input.previousLength,
        current_characters: input.nextLength,
        cooldown_seconds: aaisA2CoachingCooldownMs / 1000,
        ...(input.detail ?? {}),
      },
      now: () => input.now,
    }),
    createAaisEvent({
      studentId: input.session.studentId,
      sessionId: input.session.sessionId,
      phase: input.task.phase,
      task: input.task.taskId,
      agent: "A2",
      event: "coaching_push",
      detail: {
        reason: input.reason,
        interruption: "low",
        cooldown_seconds: aaisA2CoachingCooldownMs / 1000,
        ...(input.detail ?? {}),
      },
      now: () => input.now,
    }),
  ];
}

function hasRecentAgentCoaching(
  session: AaisLearnerSession,
  taskId: string,
  now: Date,
  reason: "low_progress_artifact_autosave" | "artifact_regression_autosave",
) {
  const nowMs = now.getTime();
  return session.events.some((event) =>
    event.task === taskId
    && (event.event === "monitoring_pause_detected" || event.event === "coaching_push")
    && (
      event.detail.reason === reason
      || event.detail.signal === reason
    )
    && isWithinAgentCoachingCooldown(event.time, nowMs)
  );
}

function isWithinAgentCoachingCooldown(eventTime: string, nowMs: number) {
  const eventMs = Date.parse(eventTime);
  return Number.isFinite(eventMs) && nowMs - eventMs < aaisA2CoachingCooldownMs;
}

function requireSafeId(value: string, label: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`Invalid AAIS ${label}.`);
  }
  return value;
}

function requireSafeText(value: string, label: string) {
  if (typeof value !== "string") {
    throw new Error(`Invalid AAIS ${label}.`);
  }
  if (value.length > 20000) {
    throw new Error(`AAIS ${label} is too large.`);
  }
  return value;
}

function hashForId(seed: string) {
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}

function createPseudonymousAnalyticsLearnerKey(studentId: string) {
  return `learner-${createHash("sha256").update(`aais-analytics:${studentId}`).digest("hex").slice(0, 12)}`;
}

function createPseudonymousAnalyticsSessionKey(sessionId: string) {
  return `session-${createHash("sha256").update(`aais-analytics-session:${sessionId}`).digest("hex").slice(0, 12)}`;
}

function createAiAcceptanceDecisionKey(
  session: AaisLearnerSession,
  task: AaisTaskRecord,
  messageId: string,
) {
  return createHash("sha256")
    .update(JSON.stringify([
      "aais-ai-acceptance",
      session.sessionId,
      task.taskId,
      messageId,
    ]))
    .digest("hex")
    .slice(0, 16);
}

function createAaisSessionId(studentId: string, createdAt: string) {
  return `session-${hashForId(`${studentId}|${createdAt}`)}`;
}
