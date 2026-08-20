import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
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
  buildAaisXapiStatement,
  enqueueAaisLrsEvents,
  getLrsConfigurationStatus,
  sendAaisXapiStatementsToLrs,
  type AaisXapiStatement,
} from "@/lib/server/aais-lrs-client";
import { requiresAaisResearchDataPlaneIsolation } from "@/lib/server/aais-research-contract";
import {
  createAaisNeonQueryClient,
  createAaisPostgresPool,
} from "@/lib/server/aais-postgres-pool";
import {
  aaisRecommendationPolicy,
  buildAaisLearnerRecommendations,
  type AaisLearnerRecommendation,
  type AaisRecommendationOverrideDecision,
} from "@/lib/server/aais-recommendations";
import {
  normalizeAaisGuideAttachmentMetadata,
  type AaisGuideAttachmentMetadata,
} from "@/lib/ai/aais-guide-attachments";
import { createAaisProductPseudonym } from "@/lib/server/aais-product-pseudonym";
import { requiresAaisDurableStorage } from "@/lib/server/aais-runtime";

export type AaisDatabaseClient = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end?(): Promise<void>;
};

type AaisDatabaseStatement = {
  sql: string;
  params: unknown[];
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

export class AaisLearnerSessionNotFoundError extends Error {
  constructor() {
    super("AAIS learner session was not found.");
    this.name = "AaisLearnerSessionNotFoundError";
  }
}

export function isAaisLearnerSessionNotFoundError(
  error: unknown,
): error is AaisLearnerSessionNotFoundError {
  return error instanceof AaisLearnerSessionNotFoundError;
}

export class AaisEducatorScopeAuthorizationError extends Error {
  constructor() {
    super("AAIS educator has no active enrollment scope for this request.");
    this.name = "AaisEducatorScopeAuthorizationError";
  }
}

export function isAaisEducatorScopeAuthorizationError(
  error: unknown,
): error is AaisEducatorScopeAuthorizationError {
  return error instanceof AaisEducatorScopeAuthorizationError;
}

export class AaisLearnerDataIntegrityError extends Error {
  constructor() {
    super("AAIS learner session generation integrity check failed.");
    this.name = "AaisLearnerDataIntegrityError";
  }
}

export function isAaisLearnerDataIntegrityError(
  error: unknown,
): error is AaisLearnerDataIntegrityError {
  return error instanceof AaisLearnerDataIntegrityError;
}

export class AaisLegacyResearchDataAccessDisabledError extends Error {
  constructor() {
    super("Legacy product analytics and event exports are disabled on an AAIS research deployment.");
    this.name = "AaisLegacyResearchDataAccessDisabledError";
  }
}

export function isAaisLegacyResearchDataAccessDisabledError(
  error: unknown,
): error is AaisLegacyResearchDataAccessDisabledError {
  return error instanceof AaisLegacyResearchDataAccessDisabledError;
}

export class AaisSessionWriteConflictError extends Error {
  constructor() {
    super("AAIS learner session write conflict.");
    this.name = "AaisSessionWriteConflictError";
  }
}

export type AaisLearnerTextRevisionField = "artifact" | "self_report";

export class AaisLearnerTextRevisionConflictError extends Error {
  readonly field: AaisLearnerTextRevisionField;

  constructor(field: AaisLearnerTextRevisionField) {
    super(`AAIS learner ${field} revision is stale.`);
    this.name = "AaisLearnerTextRevisionConflictError";
    this.field = field;
  }
}

export function isAaisLearnerTextRevisionConflictError(
  error: unknown,
): error is AaisLearnerTextRevisionConflictError {
  return error instanceof AaisLearnerTextRevisionConflictError;
}

export class AaisLearnerDataGenerationConflictError extends Error {
  constructor() {
    super("AAIS learner data generation is stale.");
    this.name = "AaisLearnerDataGenerationConflictError";
  }
}

export function isAaisLearnerDataGenerationConflictError(
  error: unknown,
): error is AaisLearnerDataGenerationConflictError {
  return error instanceof AaisLearnerDataGenerationConflictError;
}

export type AaisLearnerDataDeliveryFenceReason =
  | "in_flight"
  | "reconciliation_required";

export class AaisLearnerDataDeliveryFenceError extends Error {
  readonly reason: AaisLearnerDataDeliveryFenceReason;

  constructor(reason: AaisLearnerDataDeliveryFenceReason) {
    super(
      reason === "in_flight"
        ? "AAIS learner LRS delivery is still in flight."
        : "AAIS learner LRS delivery acknowledgement requires reconciliation.",
    );
    this.name = "AaisLearnerDataDeliveryFenceError";
    this.reason = reason;
  }
}

export function isAaisLearnerDataDeliveryFenceError(
  error: unknown,
): error is AaisLearnerDataDeliveryFenceError {
  return error instanceof AaisLearnerDataDeliveryFenceError;
}

export type AaisLrsDeliveryReconciliationStatus = "stored" | "absent";

export type AaisLrsDeliveryReconciliationEvidence = {
  observedAt: string;
  statements: Array<{
    statementId: string;
    status: AaisLrsDeliveryReconciliationStatus;
  }>;
};

export type AaisLrsDeliveryReconciliationResult = {
  claimId: string;
  status: "reconciled";
  result: "stored" | "absent" | "mixed";
  statementCount: number;
  stored: number;
  absent: number;
  reconciledAt: string;
  privacyFence: "idle";
  secrets: "redacted";
};

export type AaisPendingLrsDeliveryAttempt = {
  claimId: string;
  state: "in_flight" | "uncertain";
  startedAt: string;
  reconcileAfter: string;
  statementCount: number;
  statementIds: string[];
};

export class AaisLrsDeliveryReconciliationConflictError extends Error {
  constructor() {
    super("AAIS LRS delivery reconciliation is incomplete, premature, or conflicts with the current attempt.");
    this.name = "AaisLrsDeliveryReconciliationConflictError";
  }
}

export class AaisLrsDeliveryReconciliationStoreError extends Error {
  constructor() {
    super("AAIS LRS delivery reconciliation requires the Postgres attempt ledger.");
    this.name = "AaisLrsDeliveryReconciliationStoreError";
  }
}

export function isAaisLrsDeliveryReconciliationConflictError(
  error: unknown,
): error is AaisLrsDeliveryReconciliationConflictError {
  return error instanceof AaisLrsDeliveryReconciliationConflictError;
}

export function isAaisLrsDeliveryReconciliationStoreError(
  error: unknown,
): error is AaisLrsDeliveryReconciliationStoreError {
  return error instanceof AaisLrsDeliveryReconciliationStoreError;
}

export function isAaisSessionWriteConflictError(
  error: unknown,
): error is AaisSessionWriteConflictError {
  return error instanceof AaisSessionWriteConflictError;
}

export class AaisAiAcceptanceTargetError extends Error {
  constructor() {
    super("AAIS AI acceptance target was not found.");
    this.name = "AaisAiAcceptanceTargetError";
  }
}

export function isAaisAiAcceptanceTargetError(
  error: unknown,
): error is AaisAiAcceptanceTargetError {
  return error instanceof AaisAiAcceptanceTargetError;
}

export type AaisLearnerMutationErrorReason =
  | "history_document_required"
  | "history_limit_reached"
  | "history_not_found"
  | "history_too_large"
  | "history_task_mismatch"
  | "mutation_replay_conflict"
  | "scaffold_practice_only"
  | "scaffold_tool_invalid"
  | "stage_invalid"
  | "task_locked"
  | "task_not_active"
  | "task_unknown";

export class AaisLearnerMutationError extends Error {
  readonly reason: AaisLearnerMutationErrorReason;

  constructor(reason: AaisLearnerMutationErrorReason, message?: string) {
    super(message ?? `AAIS learner mutation was rejected: ${reason}.`);
    this.name = "AaisLearnerMutationError";
    this.reason = reason;
  }
}

export function isAaisLearnerMutationError(
  error: unknown,
): error is AaisLearnerMutationError {
  return error instanceof AaisLearnerMutationError;
}

export type AaisLearnerSessionLimitReason =
  | "events_limit_reached"
  | "guide_messages_limit_reached"
  | "payload_too_large"
  | "scaffold_history_limit_reached";

export class AaisLearnerSessionLimitError extends Error {
  readonly reason: AaisLearnerSessionLimitReason;

  constructor(reason: AaisLearnerSessionLimitReason) {
    super(`AAIS learner session persistence limit was reached: ${reason}.`);
    this.name = "AaisLearnerSessionLimitError";
    this.reason = reason;
  }
}

export function isAaisLearnerSessionLimitError(
  error: unknown,
): error is AaisLearnerSessionLimitError {
  return error instanceof AaisLearnerSessionLimitError;
}

export class AaisRecommendationOverrideTargetError extends Error {
  constructor() {
    super("AAIS recommendation override target was not found.");
    this.name = "AaisRecommendationOverrideTargetError";
  }
}

export function isAaisRecommendationOverrideTargetError(
  error: unknown,
): error is AaisRecommendationOverrideTargetError {
  return error instanceof AaisRecommendationOverrideTargetError;
}

export type AaisTaskStatus = "locked" | "available" | "active" | "completed";

export type AaisTaskRecord = {
  taskId: string;
  phase: AaisPhase;
  status: AaisTaskStatus;
  artifactText: string;
  documentTitle: string;
  activeDocumentId: string | null;
  artifactRevision: number;
  selfReport: string;
  selfReportRevision: number;
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
  // Optional only for backwards compatibility with records written before
  // guide exchanges were bound to a task. Every new exchange sets both fields.
  taskId?: string;
  phase?: AaisPhase;
  attachments?: AaisGuideAttachmentMetadata[];
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

export type AaisHistoryDocumentRecord = {
  id: string;
  taskId: string;
  title: string;
  html: string;
  savedAt: string;
};

export type AaisLearnerSession = {
  schemaVersion: 1;
  dataGeneration: number;
  studentId: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  activeTaskId: string;
  activeStage: string;
  tasks: AaisTaskRecord[];
  historyDocuments: AaisHistoryDocumentRecord[];
  guideMessages: AaisGuideMessageRecord[];
  guideCapacityReservations?: AaisGuideCapacityReservation[];
  events: AaisEvent[];
};

type AaisGuideCapacityReservation = {
  id: string;
  reservedBytes: number;
  expiresAt: string;
};

type AaisSessionWindowMetadata = {
  limit: number;
  total: number;
  returned: number;
  omitted: number;
  truncated: boolean;
};

export type AaisLearnerSessionApiDto = Omit<
  AaisLearnerSession,
  "events" | "guideCapacityReservations" | "guideMessages" | "tasks"
> & {
  tasks: AaisTaskRecord[];
  guideMessages: AaisGuideMessageRecord[];
  events: AaisEvent[];
  truncation: {
    events: AaisSessionWindowMetadata;
    guideMessages: AaisSessionWindowMetadata;
    scaffoldHistory: AaisSessionWindowMetadata & {
      limitPerTask: number;
    };
  };
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

export type AaisLearnerDataExport = {
  schemaVersion: 1;
  exportScope: "learner-data";
  generatedAt: string;
  studentId: string;
  data: {
    session: AaisLearnerSession | null;
    events: AaisEvent[];
  };
  privacy: {
    ownerScoped: true;
    includesRawLearnerText: true;
    cohortPseudonymization: "not-applied-to-owner-export";
    secrets: "redacted";
  };
  secrets: "redacted";
};

export type AaisLearnerDataDeletionResult = {
  studentId: string;
  nextGeneration: number;
  deletedAt: string;
  storageMode: "postgres" | "file";
  learnerRecordDeleted: boolean;
  mirroredAnalyticsDeleted: boolean;
  persistentOutboxDeleted: boolean;
  accountRetained: true;
  antiAbuseGuideUsage: {
    retained: true;
    scope: "content-free-account-daily-aggregate";
    rawLearnerContent: false;
    quotaEffectEndsAt: string;
    cleanup: "next-quota-maintenance-after-utc-reset";
  };
  secrets: "redacted";
};

export type AaisRestrictedResearchRawTextDeletionResult = {
  studentId: string;
  deletedAt: string;
  storageMode: "postgres" | "file";
  learnerRecordFound: boolean;
  rawTextDeleted: true;
  unrelatedProductHistoryPreserved: true;
  secrets: "redacted";
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

export type AaisEducatorCohortAccess = {
  actorId: string;
  actorRole: "teacher" | "admin";
};

export type AaisCohortLearnerPaginationInput = {
  limit?: number;
  offset?: number;
};

type AaisCohortRiskLevel = "high" | "medium" | "low";
type AaisCohortFactLayer = "lrs" | "aais_events";

type AaisCohortPriorityReason =
  | "training_incomplete"
  | "reflection_missing"
  | "a2_coaching_signals"
  | "high_scaffold_dependency"
  | "no_ai_interaction_after_coaching";

type AaisCohortLearnerSummary = {
  learnerKey: string;
  sessionKey: string;
  updatedAt: string;
  trainingCompleted: boolean;
  activePracticeTaskId: string | null;
  completedPracticeTasks: number;
  scaffoldRequests: number;
  coachingSignals: number;
  aiInteractions: number;
  aiAcceptanceDecisions: number;
  reflectionStatus: string;
  riskLevel: AaisCohortRiskLevel;
  priorityReasons: AaisCohortPriorityReason[];
  recommendationOverrideDecisions: Record<string, AaisRecommendationOverrideDecision>;
};

type AaisCohortLearnerProfile = Omit<
  AaisCohortLearnerSummary,
  "learnerKey" | "sessionKey" | "recommendationOverrideDecisions"
>;

type AaisRecommendationKeyVersion = "legacy" | "v2";

type AaisRecommendationVariant = {
  version: AaisRecommendationKeyVersion;
  learnerKey: string;
  sessionKey: string;
  recommendation: AaisLearnerRecommendation;
};

type AaisRecommendationOverrideEvidence = {
  recommendationId: string;
  ruleId: string;
  targetTaskId: string | null;
  learnerKey: string | null;
  sessionKey: string | null;
  decision: AaisRecommendationOverrideDecision;
  eventTime: string;
  eventId: string;
};

const aaisSessionStorageVersion = Symbol("aaisSessionStorageVersion");
const aaisFileSessionFingerprint = Symbol("aaisFileSessionFingerprint");

const aaisFileLearnerMutationQueues = new Map<string, Promise<void>>();
type AaisFileGuideBudgetState = {
  reservations: Map<string, {
    studentId: string;
    usageDay: string;
    state: "reserved" | "dispatched" | "completed" | "released";
    expiresAt: string;
  }>;
  dailyUsage: Map<string, number>;
  queue: Promise<void>;
};
const aaisFileGuideBudgetStates = new Map<string, AaisFileGuideBudgetState>();

type AaisStorageVersionedSession = AaisLearnerSession & {
  [aaisSessionStorageVersion]?: number;
  [aaisFileSessionFingerprint]?: string;
};

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
const aaisProductLrsLeaseDurationSeconds = 120;
const aaisProductLrsInvocationBudgetMs = 20_000;
const aaisProductLrsFinalizeGuardMs = 3_000;
const aaisProductLrsRequestTimeoutMs = 5_000;
const aaisProductLrsPlatformMaxDurationMs = 120_000;
// Match the shared Postgres/Neon query timeout so a statement that was issued
// immediately before platform termination cannot still be committing when an
// operator becomes eligible to reconcile the same frozen attempt.
const aaisProductLrsDeliverySafetyMarginMs = 35_000;
const aaisGuideReservationLeaseDurationSeconds = 600;
const aaisGuideCapacityReservationLeaseSeconds = 60 * 60;
const aaisGuideExchangeCapacityReservationBytes = 256 * 1024;
const aaisA2CoachingCooldownMs = 10 * 60 * 1000;
const aaisA2ArtifactRegressionMinimumPreviousCharacters = 80;
const aaisA2ArtifactRegressionMinimumDropCharacters = 40;
const aaisArtifactMaxCharacters = 2 * 1024 * 1024;
const aaisHistoryDocumentMaxCount = 50;
const aaisHistoryDocumentsMaxCharacters = 16 * 1024 * 1024;
export const aaisLearnerSessionPersistenceLimits = {
  maxBytes: 32 * 1024 * 1024,
  maxEvents: 10_000,
  maxGuideMessages: 500,
  maxScaffoldHistoryEntries: 1_000,
} as const;
export const aaisLearnerSessionApiWindowLimits = {
  events: 100,
  guideMessages: 100,
  scaffoldHistoryPerTask: 20,
} as const;
const defaultAaisCohortLearnerPageLimit = 25;
const maxAaisCohortLearnerPageLimit = 100;
const selectableAaisStageIds = new Set([
  "assessment",
  "comparison",
  "guide",
  "reflection",
]);

const taskOrder = [
  ...aaisLearningProgram.training.tasks,
  ...aaisLearningProgram.practice.tasks,
].map((task) => ({
  taskId: task.id,
  phase: task.phase,
}));

export function createAaisLearnerSessionApiDto(
  session: AaisLearnerSession,
): AaisLearnerSessionApiDto {
  const { guideCapacityReservations: _internalCapacity, ...publicSession } = session;
  void _internalCapacity;
  const guideMessages = takeNewest(
    session.guideMessages,
    aaisLearnerSessionApiWindowLimits.guideMessages,
  );
  const events = takeNewest(session.events, aaisLearnerSessionApiWindowLimits.events);
  let totalScaffoldHistory = 0;
  let returnedScaffoldHistory = 0;
  const tasks = session.tasks.map((task) => {
    totalScaffoldHistory += task.scaffoldHistory.length;
    const scaffoldHistory = takeNewest(
      task.scaffoldHistory,
      aaisLearnerSessionApiWindowLimits.scaffoldHistoryPerTask,
    );
    returnedScaffoldHistory += scaffoldHistory.length;
    return {
      ...task,
      artifactRevision: normalizeAaisTextRevision(task.artifactRevision),
      selfReportRevision: normalizeAaisTextRevision(task.selfReportRevision),
      scaffoldHistory,
    };
  });
  return {
    ...publicSession,
    tasks,
    guideMessages,
    events,
    truncation: {
      events: createSessionWindowMetadata(
        session.events.length,
        events.length,
        aaisLearnerSessionApiWindowLimits.events,
      ),
      guideMessages: createSessionWindowMetadata(
        session.guideMessages.length,
        guideMessages.length,
        aaisLearnerSessionApiWindowLimits.guideMessages,
      ),
      scaffoldHistory: {
        ...createSessionWindowMetadata(
          totalScaffoldHistory,
          returnedScaffoldHistory,
          session.tasks.length * aaisLearnerSessionApiWindowLimits.scaffoldHistoryPerTask,
        ),
        limitPerTask: aaisLearnerSessionApiWindowLimits.scaffoldHistoryPerTask,
      },
    },
  };
}

export function createAaisLearningStore(input: StoreInput = {}) {
  const rootDir = input.rootDir ?? getDefaultDataDir();
  const database = input.database ?? getConfiguredDatabaseClient();
  const fileGuideBudgetStateKey = path.resolve(/*turbopackIgnore: true*/ rootDir);
  const fileGuideBudgetState = aaisFileGuideBudgetStates.get(fileGuideBudgetStateKey) ?? (() => {
    const created: AaisFileGuideBudgetState = {
      reservations: new Map(),
      dailyUsage: new Map(),
      queue: Promise.resolve(),
    };
    aaisFileGuideBudgetStates.set(fileGuideBudgetStateKey, created);
    return created;
  })();
  const fileGuideReservations = fileGuideBudgetState.reservations;
  const fileDailyGuideUsage = fileGuideBudgetState.dailyUsage;

  async function withFileGuideBudgetLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = fileGuideBudgetState.queue;
    let release!: () => void;
    fileGuideBudgetState.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  async function withFileLearnerMutationLock<T>(
    studentId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const lockKey = `${path.resolve(/*turbopackIgnore: true*/ rootDir)}\0${requireSafeId(studentId, "student id")}`;
    const previous = aaisFileLearnerMutationQueues.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.then(() => gate);
    aaisFileLearnerMutationQueues.set(lockKey, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (aaisFileLearnerMutationQueues.get(lockKey) === current) {
        aaisFileLearnerMutationQueues.delete(lockKey);
      }
    }
  }

  async function getOrCreateLearnerDataGeneration(studentId: string) {
    const safeStudentId = requireSafeId(studentId, "student id");
    if (database) {
      const result = await database.query(
        `insert into aais_learner_data_generations (
           student_id, data_generation, deleted_at, updated_at
         )
         values ($1, 1, null, now())
         on conflict (student_id) do update
         set updated_at = aais_learner_data_generations.updated_at
         returning data_generation`,
        [safeStudentId],
      );
      return readLearnerDataGeneration(result.rows[0]?.data_generation);
    }
    return withFileLearnerMutationLock(safeStudentId, async () => {
      const existing = await readFileLearnerGenerationUnlocked(safeStudentId);
      if (existing) {
        return existing.dataGeneration;
      }
      await writeFileLearnerGenerationUnlocked(safeStudentId, {
        dataGeneration: 1,
        deletedAt: null,
      });
      return 1;
    });
  }

  async function assertLearnerDataGeneration(studentId: string, expectedGeneration: number) {
    const expected = requireLearnerDataGeneration(expectedGeneration);
    const current = await getOrCreateLearnerDataGeneration(studentId);
    if (current !== expected) {
      throw new AaisLearnerDataGenerationConflictError();
    }
    return current;
  }

  async function resolveMutationDataGeneration(
    studentId: string,
    expectedGeneration?: number,
  ) {
    const current = await getOrCreateLearnerDataGeneration(studentId);
    if (expectedGeneration !== undefined && requireLearnerDataGeneration(expectedGeneration) !== current) {
      throw new AaisLearnerDataGenerationConflictError();
    }
    return expectedGeneration === undefined ? current : expectedGeneration;
  }

  async function readFileLearnerGenerationUnlocked(studentId: string) {
    try {
      const raw = await readFile(getGenerationPath(studentId), "utf8");
      const parsed = JSON.parse(raw) as {
        dataGeneration?: unknown;
        deletedAt?: unknown;
      };
      return {
        dataGeneration: readLearnerDataGeneration(parsed.dataGeneration),
        deletedAt: typeof parsed.deletedAt === "string" ? parsed.deletedAt : null,
      };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async function writeFileLearnerGenerationUnlocked(
    studentId: string,
    generation: { dataGeneration: number; deletedAt: string | null },
  ) {
    await mkdir(getGenerationsDir(), { recursive: true });
    const target = getGenerationPath(studentId);
    const tempPath = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(generation, null, 2)}\n`, "utf8");
    await rename(tempPath, target);
  }

  async function getOrCreateSession(
    studentId: string,
    expectedGeneration?: number,
  ): Promise<AaisLearnerSession> {
    const safeStudentId = requireSafeId(studentId, "student id");
    const dataGeneration = await resolveMutationDataGeneration(safeStudentId, expectedGeneration);
    const existing = await readSession(safeStudentId);
    if (existing) {
      return normalizeSession(existing, dataGeneration);
    }
    const now = new Date().toISOString();
    const sessionId = createNewAaisSessionId();
    const session: AaisLearnerSession = {
      schemaVersion: 1,
      dataGeneration,
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
        documentTitle: "",
        activeDocumentId: null,
        artifactRevision: 0,
        selfReport: "",
        selfReportRevision: 0,
        scaffoldRequests: 0,
        scaffoldHistory: [],
      })),
      historyDocuments: [],
      guideMessages: [],
      guideCapacityReservations: [],
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
    try {
      await writeSessionAndMirrorEvents(session, session.events);
    } catch (error) {
      if (isAaisSessionWriteConflictError(error)) {
        recordAaisSessionWriteConflict({
          studentId: safeStudentId,
          operation: "session_created",
          attempt: 0,
          resolution: "retrying",
          storage: database ? "postgres" : "file",
        });
        const createdByConcurrentRequest = await readSession(safeStudentId);
        if (createdByConcurrentRequest) {
          return normalizeSession(createdByConcurrentRequest, dataGeneration);
        }
      }
      throw error;
    }
    return session;
  }

  async function selectStage(studentId: string, stageId: string, dataGeneration?: number) {
    if (!selectableAaisStageIds.has(stageId)) {
      throw new AaisLearnerMutationError("stage_invalid");
    }
    const expectedGeneration = await resolveMutationDataGeneration(studentId, dataGeneration);
    const session = await getOrCreateSession(studentId, expectedGeneration);
    if (session.activeStage === stageId) {
      return session;
    }
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

  async function selectTask(studentId: string, taskId: string, dataGeneration?: number) {
    const expectedGeneration = await resolveMutationDataGeneration(studentId, dataGeneration);
    const session = await getOrCreateSession(studentId, expectedGeneration);
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

  async function completeTask(studentId: string, taskId: string, dataGeneration?: number) {
    const expectedGeneration = await resolveMutationDataGeneration(studentId, dataGeneration);
    const session = await getOrCreateSession(studentId, expectedGeneration);
    const completed = requireUnlockedTask(session, taskId);
    if (completed.status === "completed") {
      return session;
    }
    if (completed.status !== "active" || session.activeTaskId !== completed.taskId) {
      throw new AaisLearnerMutationError("task_not_active");
    }
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
        ...createTaskReleaseEvents(
          session,
          tasks.find((task) => task.taskId === nextTaskId)?.status === "available"
            && session.tasks.find((task) => task.taskId === nextTaskId)?.status === "locked"
            ? nextTaskId
            : undefined,
        ),
      ],
    });
    await writeSessionAndMirrorEvents(updated, updated.events.slice(session.events.length));
    return updated;
  }

  async function saveArtifact(
    studentId: string,
    taskId: string,
    artifactText: string,
    options: {
      activeDocumentId?: string | null;
      documentTitle?: string;
      mutationId?: string;
      expectedArtifactRevision?: number;
      dataGeneration?: number;
    } = {},
  ) {
    return saveTaskText({
      studentId,
      taskId,
      field: "artifactText",
      value: artifactText,
      event: "artifact_saved",
      activeDocumentId: options.activeDocumentId,
      documentTitle: options.documentTitle,
      mutationId: options.mutationId,
      expectedRevision: options.expectedArtifactRevision,
      dataGeneration: options.dataGeneration,
    });
  }

  async function archiveArtifact(
    studentId: string,
    taskId: string,
    input: {
      activeDocumentId?: string | null;
      document?: AaisHistoryDocumentRecord | null;
      mutationId?: string;
      expectedArtifactRevision?: number;
      dataGeneration?: number;
    },
  ) {
    const safeTaskId = requireSafeId(taskId, "task id");
    const activeDocumentId = input.activeDocumentId
      ? requireSafeId(input.activeDocumentId, "history document id")
      : null;
    const document = input.document
      ? requireSafeHistoryDocument(input.document)
      : null;
    const dataGeneration = await resolveMutationDataGeneration(studentId, input.dataGeneration);
    const mutationId = input.mutationId
      ? requireSafeId(input.mutationId, "mutation id")
      : null;
    const mutationKey = mutationId ? createAaisMutationKey(mutationId) : null;
    const expectedArtifactRevision = input.expectedArtifactRevision === undefined
      ? undefined
      : requireAaisTextRevision(input.expectedArtifactRevision, "expected artifact revision");
    const mutationPayloadHash = mutationKey
      ? createAaisArchiveMutationPayloadHash({
          activeDocumentId,
          document,
          expectedArtifactRevision,
          taskId: safeTaskId,
        })
      : null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = await getOrCreateSession(studentId, dataGeneration);
      const priorMutation = mutationKey
        ? session.events.find((event) => event.detail.mutation_key === mutationKey)
        : null;
      if (priorMutation) {
        if (priorMutation.detail.mutation_payload_hash !== mutationPayloadHash) {
          throw new AaisLearnerMutationError(
            "mutation_replay_conflict",
            "AAIS mutation id was reused with different content.",
          );
        }
        return session;
      }
      const task = requireUnlockedTask(session, safeTaskId);
      if (
        expectedArtifactRevision !== undefined
        && task.artifactRevision !== expectedArtifactRevision
      ) {
        throw new AaisLearnerTextRevisionConflictError("artifact");
      }
      const existingDocument = session.historyDocuments.find((candidate) =>
        candidate.id === (activeDocumentId ?? document?.id)
      ) ?? null;
      if (activeDocumentId && !existingDocument) {
        throw new AaisLearnerMutationError(
          "history_not_found",
          "AAIS history document was not found.",
        );
      }
      if (
        (document && document.taskId !== safeTaskId)
        || (existingDocument && existingDocument.taskId !== safeTaskId)
      ) {
        throw new AaisLearnerMutationError(
          "history_task_mismatch",
          "AAIS history document task does not match the active task.",
        );
      }
      if (!document) {
        if (task.artifactText.length > 0) {
          throw new AaisLearnerMutationError(
            "history_document_required",
            "AAIS cannot clear a working artifact without a durable history document.",
          );
        }
        return session;
      }
      const nextDocument = {
        ...document,
        ...(existingDocument
          ? { id: existingDocument.id, taskId: existingDocument.taskId }
          : {}),
      };
      const historyDocuments = existingDocument
        ? session.historyDocuments.map((candidate) =>
            candidate.id === existingDocument.id ? nextDocument : candidate
          )
        : [nextDocument, ...session.historyDocuments];
      assertSafeHistoryCollection(historyDocuments);

      const event = createAaisEvent({
        studentId: session.studentId,
        sessionId: session.sessionId,
        phase: task.phase,
        task: task.taskId,
        agent: "A3",
        event: "artifact_saved",
        detail: {
          characters: document.html.length,
          destination: "history",
          ...(mutationKey
            ? {
                mutation_key: mutationKey,
                mutation_payload_hash: mutationPayloadHash,
              }
            : {}),
        },
      });
      const updated = touch({
        ...session,
        tasks: session.tasks.map((candidate) =>
          candidate.taskId === safeTaskId
            ? {
                ...candidate,
                artifactText: "",
                documentTitle: "",
                activeDocumentId: null,
                artifactRevision: incrementAaisTextRevision(candidate.artifactRevision),
              }
            : candidate
        ),
        historyDocuments,
        events: [...session.events, event],
      });
      try {
        await writeSessionAndMirrorEvents(updated, [event]);
        return updated;
      } catch (error) {
        if (isAaisSessionWriteConflictError(error) && attempt === 0) {
          recordAaisSessionWriteConflict({
            studentId: session.studentId,
            operation: "archive_artifact",
            attempt,
            resolution: "retrying",
            storage: database ? "postgres" : "file",
          });
          continue;
        }
        throw error;
      }
    }
    throw new AaisSessionWriteConflictError();
  }

  async function saveSelfReport(
    studentId: string,
    taskId: string,
    selfReport: string,
    dataGenerationOrOptions?: number | {
      dataGeneration?: number;
      expectedSelfReportRevision?: number;
      mutationId?: string;
    },
  ) {
    const options = typeof dataGenerationOrOptions === "number"
      ? { dataGeneration: dataGenerationOrOptions }
      : dataGenerationOrOptions ?? {};
    return saveTaskText({
      studentId,
      taskId,
      field: "selfReport",
      value: selfReport,
      event: "self_report_saved",
      expectedRevision: options.expectedSelfReportRevision,
      mutationId: options.mutationId,
      dataGeneration: options.dataGeneration,
    });
  }

  async function requestScaffold(
    studentId: string,
    taskId: string,
    toolId: string | undefined,
    dataGeneration?: number,
  ): Promise<ScaffoldResult> {
    const programTask = taskOrder.find((candidate) => candidate.taskId === taskId);
    if (!programTask) {
      throw new AaisLearnerMutationError("task_unknown");
    }
    if (programTask.phase !== "practice") {
      throw new AaisLearnerMutationError(
        "scaffold_practice_only",
        "A1 scaffolding is only available in practice tasks",
      );
    }
    const requestedToolId = toolId ?? "stage-checklist";
    const tool = scaffoldTools.find((candidate) => candidate.id === requestedToolId);
    if (!tool) {
      throw new AaisLearnerMutationError("scaffold_tool_invalid");
    }
    const expectedGeneration = await resolveMutationDataGeneration(studentId, dataGeneration);
    const session = await getOrCreateSession(studentId, expectedGeneration);
    const task = requireUnlockedTask(session, taskId);
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
      dataGeneration?: number;
    },
  ) {
    const safeStudentId = requireSafeId(studentId, "student id");
    const dataGeneration = await resolveMutationDataGeneration(safeStudentId, input.dataGeneration);
    const existingSession = await readSession(safeStudentId);
    if (!existingSession) {
      throw new AaisAiAcceptanceTargetError();
    }
    const session = normalizeSession(existingSession, dataGeneration);
    const task = requireUnlockedTask(session, taskId);
    const messageId = requireAiAcceptanceMessageId(input.messageId);
    const reason = requireSafeText(input.reason ?? "", "AI acceptance reason");
    const targetMessage = session.guideMessages.find((message) =>
      message.id === messageId
      && message.kind === "assistant"
      && message.taskId === task.taskId
      && message.phase === task.phase
    );
    if (!targetMessage) {
      throw new AaisAiAcceptanceTargetError();
    }
    const decisionKey = createAiAcceptanceDecisionKey(session, task, targetMessage.id);
    const existingDecisionEvents = session.events.filter((event) =>
      event.event === "ai_acceptance_recorded"
      && event.task === task.taskId
      && event.detail.decision_key === decisionKey
    );
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
        decision_key: decisionKey,
        message_id_hash: decisionKey,
        revision: existingDecisionEvents.length + 1,
        supersedes_previous: existingDecisionEvents.length > 0,
      },
    });
    const updated = touch({
      ...session,
      events: [...session.events, event],
    });
    await writeSessionAndMirrorEvents(updated, [event]);
    return updated;
  }

  async function reserveGuideExchangeCapacity(input: {
    studentId: string;
    reservationId: string;
    dataGeneration?: number;
    now?: Date;
  }) {
    const studentId = requireSafeId(input.studentId, "student id");
    const reservationId = requireSafeId(input.reservationId, "guide capacity reservation id");
    const dataGeneration = await resolveMutationDataGeneration(
      studentId,
      input.dataGeneration,
    );
    const now = input.now ?? new Date();
    const expiresAt = new Date(
      now.getTime() + aaisGuideCapacityReservationLeaseSeconds * 1000,
    ).toISOString();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const session = await getOrCreateSession(studentId, dataGeneration);
      const reservations = normalizeGuideCapacityReservations(
        session.guideCapacityReservations,
      );
      if (reservations.some((reservation) => reservation.id === reservationId)) {
        return session;
      }
      const updated = touch({
        ...session,
        guideCapacityReservations: [
          ...reservations,
          {
            id: reservationId,
            reservedBytes: aaisGuideExchangeCapacityReservationBytes,
            expiresAt,
          },
        ],
      });
      try {
        await writeSession(updated);
        return updated;
      } catch (error) {
        if (!isAaisSessionWriteConflictError(error) || attempt === 2) {
          throw error;
        }
        recordAaisSessionWriteConflict({
          studentId,
          operation: "reserve_guide_exchange_capacity",
          attempt,
          resolution: "retrying",
          storage: database ? "postgres" : "file",
        });
      }
    }
    throw new AaisSessionWriteConflictError();
  }

  async function releaseGuideExchangeCapacity(input: {
    studentId: string;
    reservationId: string;
    dataGeneration?: number;
  }) {
    const studentId = requireSafeId(input.studentId, "student id");
    const reservationId = requireSafeId(input.reservationId, "guide capacity reservation id");
    const dataGeneration = await resolveMutationDataGeneration(
      studentId,
      input.dataGeneration,
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await readSession(studentId);
      if (!existing) {
        return { status: "unchanged" as const };
      }
      const session = normalizeSession(existing, dataGeneration);
      const reservations = normalizeGuideCapacityReservations(
        session.guideCapacityReservations,
      );
      if (!reservations.some((reservation) => reservation.id === reservationId)) {
        return { status: "unchanged" as const };
      }
      const updated = touch({
        ...session,
        guideCapacityReservations: reservations.filter((reservation) =>
          reservation.id !== reservationId
        ),
      });
      try {
        await writeSession(updated);
        return { status: "released" as const };
      } catch (error) {
        if (!isAaisSessionWriteConflictError(error) || attempt === 2) {
          throw error;
        }
        recordAaisSessionWriteConflict({
          studentId,
          operation: "release_guide_exchange_capacity",
          attempt,
          resolution: "retrying",
          storage: database ? "postgres" : "file",
        });
      }
    }
    throw new AaisSessionWriteConflictError();
  }

  async function appendGuideExchange(input: {
    studentId: string;
    phase: AaisPhase;
    taskId: string;
    question: string;
    answer: string;
    budgetReservationId?: string;
    capacityReservationId?: string;
    dataGeneration?: number;
    attachments?: AaisGuideAttachmentMetadata[];
    turns?: AaisGuideTurnRecord[];
    orchestration: {
      graphId: string;
      topologicalOrder: string[];
      threadId: string;
    };
  }) {
    const dataGeneration = await resolveMutationDataGeneration(input.studentId, input.dataGeneration);
    const now = new Date().toISOString();
    const attachments = normalizeAaisGuideAttachmentMetadata(input.attachments);
    const userMessageId = `user-${randomUUID()}`;
    const assistantMessageId = `assistant-${randomUUID()}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const session = await getOrCreateSession(input.studentId, dataGeneration);
      const task = requireUnlockedTask(session, input.taskId);
      const existingUserMessage = session.guideMessages.some((message) =>
        message.id === userMessageId
      );
      const existingAssistantMessage = session.guideMessages.some((message) =>
        message.id === assistantMessageId
      );
      if (existingUserMessage && existingAssistantMessage) {
        return session;
      }
      if (existingUserMessage || existingAssistantMessage) {
        throw new Error("AAIS guide exchange persistence was partially applied.");
      }
      const capacityReservations = normalizeGuideCapacityReservations(
        session.guideCapacityReservations,
      );
      if (
        input.capacityReservationId
        && !capacityReservations.some((reservation) =>
          reservation.id === input.capacityReservationId
        )
      ) {
        throw new AaisLearnerSessionLimitError("payload_too_large");
      }
      const userMessage: AaisGuideMessageRecord = {
        id: userMessageId,
        kind: "user",
        text: input.question,
        time: now,
        taskId: task.taskId,
        phase: task.phase,
        ...(attachments.length ? { attachments } : {}),
      };
      const assistantMessage: AaisGuideMessageRecord = {
        id: assistantMessageId,
        kind: "assistant",
        text: input.answer,
        time: now,
        taskId: task.taskId,
        phase: task.phase,
        ...(input.turns?.length ? { turns: input.turns } : {}),
        orchestration: input.orchestration,
      };
      const newEvents = [
        createAaisEvent({
          studentId: session.studentId,
          sessionId: session.sessionId,
          phase: task.phase,
          task: task.taskId,
          agent: "A2",
          event: "ai_prompt_submitted",
          detail: {
            prompt_length: input.question.length,
            exchange_id_hash: hashAaisGuideExchangeId(userMessageId, assistantMessageId),
          },
          now: () => new Date(now),
        }),
        createAaisEvent({
          studentId: session.studentId,
          sessionId: session.sessionId,
          phase: task.phase,
          task: task.taskId,
          agent: "A1",
          event: "ai_response_completed",
          detail: {
            graphId: input.orchestration.graphId,
            node_count: input.orchestration.topologicalOrder.length,
            response_length: input.answer.length,
            exchange_id_hash: hashAaisGuideExchangeId(userMessageId, assistantMessageId),
          },
          now: () => new Date(now),
        }),
      ];
      const updated = touch({
        ...session,
        guideMessages: [...session.guideMessages, userMessage, assistantMessage],
        guideCapacityReservations: input.capacityReservationId
          ? capacityReservations.filter((reservation) =>
              reservation.id !== input.capacityReservationId
            )
          : capacityReservations,
        events: [...session.events, ...newEvents],
      });
      try {
        await writeSessionAndMirrorEvents(
          updated,
          newEvents,
          input.budgetReservationId,
        );
        return updated;
      } catch (error) {
        if (!isAaisSessionWriteConflictError(error) || attempt === 2) {
          throw error;
        }
        recordAaisSessionWriteConflict({
          studentId: session.studentId,
          operation: "append_guide_exchange",
          attempt,
          resolution: "retrying",
          storage: database ? "postgres" : "file",
        });
      }
    }
    throw new AaisSessionWriteConflictError();
  }

  async function exportEvents(studentId: string, format: "json" | "csv") {
    assertLegacyResearchDataAccessAllowed();
    const session = await readSession(requireSafeId(studentId, "student id"));
    if (!session) {
      throw new AaisLearnerSessionNotFoundError();
    }
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

  async function exportLearnerData(studentId: string): Promise<AaisLearnerDataExport> {
    const safeStudentId = requireSafeId(studentId, "student id");
    const session = await readSession(safeStudentId);
    return {
      schemaVersion: 1,
      exportScope: "learner-data",
      generatedAt: new Date().toISOString(),
      studentId: safeStudentId,
      data: {
        session: session ? normalizeSession(session) : null,
        events: session?.events ?? [],
      },
      privacy: {
        ownerScoped: true,
        includesRawLearnerText: true,
        cohortPseudonymization: "not-applied-to-owner-export",
        secrets: "redacted",
      },
      secrets: "redacted",
    };
  }

  async function deleteLearnerData(
    studentId: string,
    expectedGeneration?: number,
  ): Promise<AaisLearnerDataDeletionResult> {
    const safeStudentId = requireSafeId(studentId, "student id");
    const dataGeneration = await resolveMutationDataGeneration(
      safeStudentId,
      expectedGeneration,
    );
    const deletedAt = new Date().toISOString();
    const antiAbuseGuideUsage = createAntiAbuseGuideUsageRetention(deletedAt);
    if (database) {
      let result: { rows: Array<Record<string, unknown>> };
      try {
        result = await database.query(
          `select *
             from public.aais_delete_learner_data(
               $1,
               $2::bigint,
               $3::timestamptz
             )`,
          [safeStudentId, dataGeneration, deletedAt],
        );
      } catch (error) {
        const deliveryFenceReason = getAaisLearnerDataDeliveryFenceReason(error);
        if (deliveryFenceReason) {
          throw new AaisLearnerDataDeliveryFenceError(deliveryFenceReason);
        }
        if (isMissingAaisRelationError(error)) {
          throw new AaisLearningStorageConfigurationError();
        }
        throw error;
      }
      if (!result.rows.length) {
        throw new AaisLearnerDataGenerationConflictError();
      }
      return {
        studentId: safeStudentId,
        nextGeneration: readLearnerDataGeneration(result.rows[0]?.next_generation),
        deletedAt,
        storageMode: "postgres",
        learnerRecordDeleted: Number(result.rows[0]?.session_count ?? 0) > 0,
        mirroredAnalyticsDeleted: true,
        persistentOutboxDeleted: true,
        accountRetained: true,
        antiAbuseGuideUsage,
        secrets: "redacted",
      };
    }
    const existing = await readSession(safeStudentId);
    const fileDeletion = await withFileLearnerMutationLock(safeStudentId, async () => {
      const generation = await readFileLearnerGenerationUnlocked(safeStudentId);
      const currentGeneration = generation?.dataGeneration ?? 1;
      if (currentGeneration !== dataGeneration) {
        throw new AaisLearnerDataGenerationConflictError();
      }
      const nextGeneration = currentGeneration + 1;
      await writeFileLearnerGenerationUnlocked(safeStudentId, {
        dataGeneration: nextGeneration,
        deletedAt,
      });
      await rm(getSessionPath(safeStudentId), { force: true });
      return nextGeneration;
    });
    await withFileGuideBudgetLock(async () => {
      for (const [reservationId, reservation] of fileGuideReservations) {
        if (reservation.studentId === safeStudentId) {
          fileGuideReservations.delete(reservationId);
        }
      }
      const retainedUsageKey = `${safeStudentId}\0${deletedAt.slice(0, 10)}`;
      for (const usageKey of fileDailyGuideUsage.keys()) {
        if (
          usageKey.startsWith(`${safeStudentId}\0`)
          && usageKey !== retainedUsageKey
        ) {
          fileDailyGuideUsage.delete(usageKey);
        }
      }
    });
    return {
      studentId: safeStudentId,
      nextGeneration: fileDeletion,
      deletedAt,
      storageMode: "file",
      learnerRecordDeleted: Boolean(existing),
      mirroredAnalyticsDeleted: true,
      persistentOutboxDeleted: false,
      accountRetained: true,
      antiAbuseGuideUsage,
      secrets: "redacted",
    };
  }

  async function deleteRestrictedResearchRawText(
    studentId: string,
  ): Promise<AaisRestrictedResearchRawTextDeletionResult> {
    const safeStudentId = requireSafeId(studentId, "student id");
    const storageMode = database ? "postgres" : "file";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await readSession(safeStudentId);
      if (!existing) {
        return {
          studentId: safeStudentId,
          deletedAt: new Date().toISOString(),
          storageMode,
          learnerRecordFound: false,
          rawTextDeleted: true,
          unrelatedProductHistoryPreserved: true,
          secrets: "redacted",
        };
      }
      const redacted = redactRestrictedResearchRawText(normalizeSession(existing));
      try {
        // This restricted erasure intentionally writes only the learner-session
        // payload. Product events, task state, analytics, and outbox history are
        // outside the approved research raw-text scope and remain untouched.
        await writeSession(redacted);
        return {
          studentId: safeStudentId,
          deletedAt: new Date().toISOString(),
          storageMode,
          learnerRecordFound: true,
          rawTextDeleted: true,
          unrelatedProductHistoryPreserved: true,
          secrets: "redacted",
        };
      } catch (error) {
        if (!isAaisSessionWriteConflictError(error) || attempt === 2) {
          throw error;
        }
      }
    }
    throw new AaisSessionWriteConflictError();
  }

  async function getAnalytics(studentId: string) {
    assertLegacyResearchDataAccessAllowed();
    const session = await readSession(requireSafeId(studentId, "student id"));
    if (!session) {
      throw new AaisLearnerSessionNotFoundError();
    }
    return summarizeAaisLearningAnalytics(session);
  }

  async function getDailyGuideUsage(studentId: string, now = new Date()) {
    const safeStudentId = requireSafeId(studentId, "student id");
    const dayRange = getAaisUtcDayRange(now);
    if (database) {
      const result = await database.query(
        `select count(*)::int as count
         from aais_events
         where student_id = $1
           and event = 'ai_prompt_submitted'
           and event_time >= $2::timestamptz
           and event_time < $3::timestamptz`,
        [safeStudentId, dayRange.start, dayRange.end],
      );
      return {
        ...dayRange,
        used: Number(result.rows[0]?.count ?? 0),
      };
    }
    const session = await readSession(safeStudentId);
    return {
      ...dayRange,
      used: (session?.events ?? []).filter((event) =>
        event.event === "ai_prompt_submitted"
        && event.time >= dayRange.start
        && event.time < dayRange.end
      ).length,
    };
  }

  async function reserveDailyGuideRequest(input: {
    reservationId?: string;
    studentId: string;
    limit: number;
    now?: Date;
    dataGeneration?: number;
  }): Promise<AaisDailyGuideReservation> {
    const safeStudentId = requireSafeId(input.studentId, "student id");
    const reservationId = requireSafeId(input.reservationId ?? randomUUID(), "guide reservation id");
    const now = input.now ?? new Date();
    const dayRange = getAaisUtcDayRange(now);
    const limit = Math.max(1, Math.floor(input.limit));
    const dataGeneration = await resolveMutationDataGeneration(
      safeStudentId,
      input.dataGeneration,
    );
    if (database) {
      try {
        const reserved = await database.query(
          `select used, granted, reservation_id
           from public.aais_reserve_ai_guide_request(
             $1,
             $2::date,
             $3::timestamptz,
             $4::integer,
             $5::uuid,
             $6::bigint,
             $7::integer
           )`,
          [
            safeStudentId,
            dayRange.start,
            now.toISOString(),
            limit,
            reservationId,
            dataGeneration,
            aaisGuideReservationLeaseDurationSeconds,
          ],
        );
        if (reserved.rows[0]?.granted === true) {
          return buildDailyGuideReservation(
            "reserved",
            limit,
            Number(reserved.rows[0]?.used) || 1,
            dayRange.end,
            String(reserved.rows[0]?.reservation_id ?? reservationId),
          );
        }
        if (!reserved.rows.length) {
          await assertLearnerDataGeneration(safeStudentId, dataGeneration);
          throw new AaisLearningStorageConfigurationError();
        }
        return buildDailyGuideReservation(
          "exhausted",
          limit,
          Number(reserved.rows[0]?.used ?? limit) || limit,
          dayRange.end,
          null,
        );
      } catch (error) {
        if (isMissingAaisRelationError(error)) {
          throw new AaisLearningStorageConfigurationError();
        }
        throw error;
      }
    }
    return withFileGuideBudgetLock(async () => {
      await assertLearnerDataGeneration(safeStudentId, dataGeneration);
      const usageKey = `${safeStudentId}\0${dayRange.start.slice(0, 10)}`;
      for (const existingUsageKey of fileDailyGuideUsage.keys()) {
        if (
          existingUsageKey.startsWith(`${safeStudentId}\0`)
          && existingUsageKey !== usageKey
        ) {
          fileDailyGuideUsage.delete(existingUsageKey);
        }
      }
      for (const reservation of fileGuideReservations.values()) {
        if (
          reservation.studentId === safeStudentId
          && reservation.usageDay === dayRange.start.slice(0, 10)
          && reservation.state === "reserved"
          && reservation.expiresAt <= now.toISOString()
        ) {
          reservation.state = "released";
          const expiredUsageKey = `${reservation.studentId}\0${reservation.usageDay}`;
          fileDailyGuideUsage.set(
            expiredUsageKey,
            Math.max(0, (fileDailyGuideUsage.get(expiredUsageKey) ?? 0) - 1),
          );
        }
      }
      const existingReservation = fileGuideReservations.get(reservationId);
      if (existingReservation) {
        if (existingReservation.studentId !== safeStudentId) {
          throw new Error("AAIS guide reservation belongs to a different learner.");
        }
        const used = fileDailyGuideUsage.get(usageKey) ?? 0;
        return buildDailyGuideReservation(
          existingReservation.state === "released" ? "exhausted" : "reserved",
          limit,
          used,
          dayRange.end,
          existingReservation.state === "released" ? null : reservationId,
        );
      }
      let used = fileDailyGuideUsage.get(usageKey);
      if (used === undefined) {
        const persistedUsage = await getDailyGuideUsage(safeStudentId, now);
        used = persistedUsage.used;
      }
      if (used >= limit) {
        fileDailyGuideUsage.set(usageKey, used);
        return buildDailyGuideReservation("exhausted", limit, used, dayRange.end, null);
      }
      const nextUsed = used + 1;
      fileDailyGuideUsage.set(usageKey, nextUsed);
      fileGuideReservations.set(reservationId, {
        studentId: safeStudentId,
        usageDay: dayRange.start.slice(0, 10),
        state: "reserved",
        expiresAt: new Date(
          now.getTime() + aaisGuideReservationLeaseDurationSeconds * 1000,
        ).toISOString(),
      });
      return buildDailyGuideReservation(
        "reserved",
        limit,
        nextUsed,
        dayRange.end,
        reservationId,
      );
    });
  }

  async function finalizeDailyGuideRequest(input: {
    reservationId: string;
    studentId: string;
    outcome: "completed" | "dispatched" | "released";
    dataGeneration?: number;
    now?: Date;
  }) {
    const reservationId = requireSafeId(input.reservationId, "guide reservation id");
    const studentId = requireSafeId(input.studentId, "student id");
    const now = input.now ?? new Date();
    const dataGeneration = await resolveMutationDataGeneration(
      studentId,
      input.dataGeneration,
    );
    if (database) {
      try {
        if (input.outcome === "dispatched") {
          const result = await database.query(
            `with generation_guard as materialized (
               select data_generation
               from aais_learner_data_generations
               where student_id = $2
                 and data_generation = $3::bigint
               for update
             ), dispatched as (
               update aais_ai_guide_reservations
               set state = 'dispatched', finalized_at = $4::timestamptz
               from generation_guard
               where id = $1::uuid
                 and student_id = $2
                 and state = 'reserved'
                 and expires_at > $4::timestamptz
               returning state
             )
             select state from dispatched
             union all
             select reservation.state
             from aais_ai_guide_reservations reservation, generation_guard
             where reservation.id = $1::uuid
               and reservation.student_id = $2
               and reservation.state in ('dispatched', 'completed')
               and not exists (select 1 from dispatched)
             limit 1`,
            [reservationId, studentId, dataGeneration, now.toISOString()],
          );
          if (result.rows.length) {
            return { status: "dispatched" as const };
          }
          const observed = await database.query(
            `select reservation.state
               from aais_ai_guide_reservations reservation
               join aais_learner_data_generations generation
                 on generation.student_id = reservation.student_id
              where reservation.id = $1::uuid
                and reservation.student_id = $2
                and generation.data_generation = $3::bigint
                and reservation.state in ('dispatched', 'completed')
              limit 1`,
            [reservationId, studentId, dataGeneration],
          );
          if (observed.rows.length) {
            return { status: "dispatched" as const };
          }
          await assertLearnerDataGeneration(studentId, dataGeneration);
          return { status: "unchanged" as const };
        }
        if (input.outcome === "released") {
          const result = await database.query(
            `with generation_guard as materialized (
               select data_generation
               from aais_learner_data_generations
               where student_id = $2
                 and data_generation = $3::bigint
               for update
             ), released as (
               update aais_ai_guide_reservations
               set state = 'released', finalized_at = $4::timestamptz
               from generation_guard
               where id = $1::uuid
                 and student_id = $2
                 and state = 'reserved'
                 and expires_at > $4::timestamptz
               returning student_id, usage_day
             )
             update aais_ai_guide_daily_usage usage
             set used = greatest(0, usage.used - 1), updated_at = $4::timestamptz
             from released
             where usage.student_id = released.student_id
               and usage.usage_day = released.usage_day
             returning usage.used`,
            [reservationId, studentId, dataGeneration, now.toISOString()],
          );
          if (!result.rows.length) {
            await assertLearnerDataGeneration(studentId, dataGeneration);
          }
          return { status: result.rows.length ? "released" as const : "unchanged" as const };
        }
        const result = await database.query(
          `with generation_guard as materialized (
             select data_generation
             from aais_learner_data_generations
             where student_id = $2
               and data_generation = $3::bigint
             for update
           )
           update aais_ai_guide_reservations
           set state = 'completed', finalized_at = $4::timestamptz
           from generation_guard
           where id = $1::uuid
             and student_id = $2
             and (
               state = 'dispatched'
               or (state = 'reserved' and expires_at > $4::timestamptz)
             )
           returning id`,
          [reservationId, studentId, dataGeneration, now.toISOString()],
        );
        if (!result.rows.length) {
          await assertLearnerDataGeneration(studentId, dataGeneration);
        }
        return { status: result.rows.length ? "completed" as const : "unchanged" as const };
      } catch (error) {
        if (isMissingAaisRelationError(error)) {
          throw new AaisLearningStorageConfigurationError();
        }
        throw error;
      }
    }
    return withFileGuideBudgetLock(async () => {
      await assertLearnerDataGeneration(studentId, dataGeneration);
      const reservation = fileGuideReservations.get(reservationId);
      if (!reservation || reservation.studentId !== studentId) {
        return { status: "unchanged" as const };
      }
      if (input.outcome === "dispatched") {
        if (reservation.state === "dispatched" || reservation.state === "completed") {
          return { status: "dispatched" as const };
        }
        if (
          reservation.state !== "reserved"
          || reservation.expiresAt <= now.toISOString()
        ) {
          return { status: "unchanged" as const };
        }
        reservation.state = "dispatched";
        return { status: "dispatched" as const };
      }
      if (input.outcome === "released") {
        if (
          reservation.state !== "reserved"
          || reservation.expiresAt <= now.toISOString()
        ) {
          return { status: "unchanged" as const };
        }
        reservation.state = "released";
        const usageKey = `${studentId}\0${reservation.usageDay}`;
        fileDailyGuideUsage.set(
          usageKey,
          Math.max(0, (fileDailyGuideUsage.get(usageKey) ?? 0) - 1),
        );
        return { status: "released" as const };
      }
      if (
        reservation.state !== "dispatched"
        && (
          reservation.state !== "reserved"
          || reservation.expiresAt <= now.toISOString()
        )
      ) {
        return { status: "unchanged" as const };
      }
      reservation.state = "completed";
      return { status: "completed" as const };
    });
  }

  async function getEducatorCohortAnalytics(
    access: AaisEducatorCohortAccess,
    filters: AaisCohortAnalyticsFilters = {},
    pagination?: AaisCohortLearnerPaginationInput,
  ) {
    assertLegacyResearchDataAccessAllowed();
    const normalizedAccess = normalizeEducatorCohortAccess(access);
    if (!database) {
      throw new AaisLearningStorageConfigurationError();
    }
    await assertActiveEducatorEnrollmentScope(database, normalizedAccess);
    const rows = await readAuthorizedSqlCohortAnalyticsRows(
      database,
      normalizedAccess,
      filters,
    );
    return summarizeAaisSqlCohortAnalytics(rows, filters, pagination);
  }

  async function exportEducatorCohortAnalytics(
    format: "json" | "csv",
    access: AaisEducatorCohortAccess,
    filters: AaisCohortAnalyticsFilters = {},
  ) {
    const analytics = await getEducatorCohortAnalytics(access, filters);
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

  async function recordRecommendationOverride(input: {
    actorId: string;
    actorRole: "teacher" | "admin";
    learnerKey: string;
    sessionKey: string;
    recommendationId: string;
    ruleId: string;
    targetTaskId: string | null;
    decision: AaisRecommendationOverrideDecision;
    note?: string;
  }) {
    const access = normalizeEducatorCohortAccess({
      actorId: input.actorId,
      actorRole: input.actorRole,
    });
    if (!database) {
      throw new AaisLearningStorageConfigurationError();
    }
    await assertActiveEducatorEnrollmentScope(database, access);
    const session = await readAuthorizedSessionByAnalyticsKeys(
      database,
      access,
      input.learnerKey,
      input.sessionKey,
    );
    if (!session) {
      throw new AaisRecommendationOverrideTargetError();
    }
    const safeRecommendationId = requireSafeId(input.recommendationId, "recommendation id");
    const safeRuleId = requireSafeId(input.ruleId, "recommendation rule id");
    const requestedTargetTaskId = input.targetTaskId === null
      ? null
      : requireSafeId(input.targetTaskId, "recommendation target task id");
    const analytics = summarizeAaisCohortAnalytics([session]);
    const currentLearner = analytics.learners[0];
    if (!currentLearner) {
      throw new AaisRecommendationOverrideTargetError();
    }
    const variants = buildRecommendationVariants(
      session.studentId,
      session.sessionId,
      currentLearner,
    );
    const submittedVariant = variants.find((variant) =>
      variant.recommendation.id === safeRecommendationId
      && variant.learnerKey === input.learnerKey
      && variant.sessionKey === input.sessionKey
      && variant.recommendation.ruleId === safeRuleId
      && variant.recommendation.targetTaskId === requestedTargetTaskId
    );
    const currentVariant = submittedVariant
      ? variants.find((variant) =>
          variant.version === "v2"
          && createRecommendationSemanticKey(
            variant.recommendation.ruleId,
            variant.recommendation.targetTaskId,
          ) === createRecommendationSemanticKey(
            submittedVariant.recommendation.ruleId,
            submittedVariant.recommendation.targetTaskId,
          )
        )
      : undefined;
    const currentRecommendation = currentVariant?.recommendation;
    if (
      !submittedVariant
      || !currentVariant
      || !currentRecommendation
    ) {
      throw new AaisRecommendationOverrideTargetError();
    }
    const targetTaskId = currentRecommendation.targetTaskId ?? session.activeTaskId;
    const targetTask = session.tasks.find((task) => task.taskId === targetTaskId);
    if (!targetTask) {
      throw new AaisRecommendationOverrideTargetError();
    }
    const note = typeof input.note === "string" ? input.note : "";
    const educatorKey = createPseudonymousEducatorKey(input.actorId);
    const educatorKeyAliases = new Set([
      educatorKey,
      createLegacyPseudonymousEducatorKey(input.actorId),
    ]);
    const semanticVariants = variants.filter((variant) =>
      createRecommendationSemanticKey(
        variant.recommendation.ruleId,
        variant.recommendation.targetTaskId,
      ) === createRecommendationSemanticKey(
        currentRecommendation.ruleId,
        currentRecommendation.targetTaskId,
      )
    );
    const existingOverrideEvents = session.events.filter((candidate) => {
      if (
        candidate.event !== "recommendation_override_recorded"
        || candidate.detail.rule_id !== currentRecommendation.ruleId
        || candidate.task !== targetTask.taskId
        || typeof candidate.detail.educator_key !== "string"
        || !educatorKeyAliases.has(candidate.detail.educator_key)
      ) {
        return false;
      }
      return semanticVariants.some((variant) =>
        candidate.detail.recommendation_id === variant.recommendation.id
        && (
          candidate.detail.learner_key === undefined
          || candidate.detail.learner_key === variant.learnerKey
        )
        && (
          candidate.detail.session_key === undefined
          || candidate.detail.session_key === variant.sessionKey
        )
      );
    });
    const latestOverride = existingOverrideEvents.at(-1);
    if (latestOverride?.detail.decision === input.decision) {
      return {
        event: latestOverride,
        session,
      };
    }
    const event = createAaisEvent({
      studentId: session.studentId,
      sessionId: session.sessionId,
      phase: targetTask.phase,
      task: targetTask.taskId,
      agent: "platform",
      event: "recommendation_override_recorded",
      detail: {
        recommendation_id: currentRecommendation.id,
        rule_id: currentRecommendation.ruleId,
        target_task_id: currentRecommendation.targetTaskId,
        policy_version: aaisRecommendationPolicy.version,
        source_key_version: submittedVariant.version,
        decision: input.decision,
        educator_role: input.actorRole,
        educator_key: educatorKey,
        learner_key: currentVariant.learnerKey,
        session_key: currentVariant.sessionKey,
        note_length: note.trim().length,
        raw_note: "excluded",
        revision: existingOverrideEvents.length + 1,
        supersedes_previous: existingOverrideEvents.length > 0,
      },
    });
    const updated = touch({
      ...session,
      events: [...session.events, event],
    });
    await writeSessionAndMirrorEvents(updated, [event], undefined, access);
    return {
      event,
      session: updated,
    };
  }

  async function saveTaskText(input: {
    studentId: string;
    taskId: string;
    field: "artifactText" | "selfReport";
    value: string;
    event: "artifact_saved" | "self_report_saved";
    activeDocumentId?: string | null;
    documentTitle?: string;
    mutationId?: string;
    expectedRevision?: number;
    dataGeneration?: number;
  }) {
    let baseFieldValue: string | null = null;
    const value = input.field === "artifactText"
      ? requireSafeArtifactText(input.value)
      : requireSafeText(input.value, input.field);
    const mutationId = input.mutationId
      ? requireSafeId(input.mutationId, "mutation id")
      : null;
    const documentTitle = input.field === "artifactText" && input.documentTitle !== undefined
      ? requireSafeDocumentTitle(input.documentTitle)
      : undefined;
    const activeDocumentId = input.field === "artifactText" && input.activeDocumentId !== undefined
      ? input.activeDocumentId === null
        ? null
        : requireSafeId(input.activeDocumentId, "history document id")
      : undefined;
    const mutationKey = mutationId ? createAaisMutationKey(mutationId) : null;
    const mutationPayloadHash = mutationKey
      ? createAaisMutationPayloadHash({
          taskId: input.taskId,
          field: input.field,
          value,
          activeDocumentId,
          documentTitle,
        })
      : null;
    const expectedRevision = input.expectedRevision === undefined
      ? undefined
      : requireAaisTextRevision(input.expectedRevision, `expected ${input.field} revision`);
    const dataGeneration = await resolveMutationDataGeneration(
      input.studentId,
      input.dataGeneration,
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = await getOrCreateSession(input.studentId, dataGeneration);
      const priorMutation = mutationKey
        ? session.events.find((event) => event.detail.mutation_key === mutationKey)
        : null;
      if (priorMutation) {
        if (priorMutation.detail.mutation_payload_hash !== mutationPayloadHash) {
          throw new AaisLearnerMutationError(
            "mutation_replay_conflict",
            "AAIS mutation id was reused with different content.",
          );
        }
        return session;
      }
      const task = requireUnlockedTask(session, input.taskId);
      const currentRevision = input.field === "artifactText"
        ? task.artifactRevision
        : task.selfReportRevision;
      if (expectedRevision !== undefined && currentRevision !== expectedRevision) {
        throw new AaisLearnerTextRevisionConflictError(
          input.field === "artifactText" ? "artifact" : "self_report",
        );
      }
      if (activeDocumentId) {
        const activeDocument = session.historyDocuments.find((document) =>
          document.id === activeDocumentId
        );
        if (!activeDocument) {
          throw new AaisLearnerMutationError(
            "history_not_found",
            "AAIS history document was not found.",
          );
        }
        if (activeDocument.taskId !== task.taskId) {
          throw new AaisLearnerMutationError(
            "history_task_mismatch",
            "AAIS history document task does not match the active task.",
          );
        }
      }
      baseFieldValue ??= task[input.field];
      if (attempt > 0 && task[input.field] !== baseFieldValue && task[input.field] !== value) {
        recordAaisSessionWriteConflict({
          studentId: session.studentId,
          operation: input.event,
          attempt,
          resolution: "merge_failed",
          storage: database ? "postgres" : "file",
        });
        throw new AaisSessionWriteConflictError();
      }
      const { updated, newEvents } = createTaskTextUpdate({
        session,
        task,
        input,
        value,
        activeDocumentId,
        documentTitle,
        mutationKey,
        mutationPayloadHash,
      });
      try {
        await writeSessionAndMirrorEvents(updated, newEvents);
        return updated;
      } catch (error) {
        if (isAaisSessionWriteConflictError(error) && attempt === 0) {
          recordAaisSessionWriteConflict({
            studentId: session.studentId,
            operation: input.event,
            attempt,
            resolution: "retrying",
            storage: database ? "postgres" : "file",
          });
          continue;
        }
        throw error;
      }
    }
    throw new AaisSessionWriteConflictError();
  }

  function createTaskTextUpdate(input: {
    session: AaisLearnerSession;
    task: AaisTaskRecord;
    input: {
      taskId: string;
      field: "artifactText" | "selfReport";
      event: "artifact_saved" | "self_report_saved";
    };
    value: string;
    activeDocumentId: string | null | undefined;
    documentTitle: string | undefined;
    mutationKey: string | null;
    mutationPayloadHash: string | null;
  }) {
    const { session, task, value } = input;
    const previousTask = task;
    const tasks = session.tasks.map((candidate) =>
      candidate.taskId === input.input.taskId
        ? {
            ...candidate,
            [input.input.field]: value,
            ...(input.input.field === "artifactText"
              ? { artifactRevision: incrementAaisTextRevision(candidate.artifactRevision) }
              : { selfReportRevision: incrementAaisTextRevision(candidate.selfReportRevision) }),
            ...(input.input.field === "artifactText"
              ? {
                  ...(input.documentTitle === undefined
                    ? {}
                    : { documentTitle: input.documentTitle }),
                  ...(input.activeDocumentId === undefined
                    ? {}
                    : { activeDocumentId: input.activeDocumentId }),
                }
              : {}),
          }
        : candidate,
    );
    const now = new Date();
    const artifactEditEvent = input.input.field === "artifactText"
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
      agent: input.input.field === "artifactText" ? "A3" : "A4",
      event: input.input.event,
      detail: {
        characters: value.length,
        ...(input.mutationKey
          ? {
              mutation_key: input.mutationKey,
              mutation_payload_hash: input.mutationPayloadHash,
            }
          : {}),
      },
      now: () => now,
    });
    const evidenceEvents = createTaskTextEvidenceEvents({
      session,
      task,
      event: input.input.event,
      value,
    });
    const monitoringEvents = input.input.field === "artifactText"
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
    return {
      updated,
      newEvents,
    };
  }

  async function readSession(studentId: string) {
    if (database) {
      const result = await database.query(
        `select session.payload, session.version, generation.data_generation
         from aais_learner_sessions session
         left join aais_learner_data_generations generation
           on generation.student_id = session.student_id
         where session.student_id = $1
         limit 1`,
        [requireSafeId(studentId, "student id")],
      );
      return parseDatabaseSessionPayload(
        result.rows[0]?.payload,
        result.rows[0]?.version,
        result.rows[0]?.data_generation,
      );
    }
    try {
      const raw = await readFile(getSessionPath(studentId), "utf8");
      const session = JSON.parse(raw) as AaisLearnerSession;
      const generation = await readFileLearnerGenerationUnlocked(studentId);
      const currentGeneration = generation?.dataGeneration ?? 1;
      if ((session.dataGeneration ?? 1) !== currentGeneration) {
        return null;
      }
      return setFileSessionFingerprint(
        normalizeSession(session, currentGeneration),
        createFileSessionFingerprint(raw),
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async function writeSession(session: AaisLearnerSession) {
    const serializedSession = serializeAaisLearnerSession(session);
    if (database) {
      const expectedVersion = getSessionStorageVersion(session);
      if (expectedVersion === null) {
        const insertResult = await database.query(
          `insert into aais_learner_sessions (student_id, payload, version, updated_at)
           select $1, $2::jsonb, 0, now()
           where exists (
             select 1
             from aais_learner_data_generations
             where student_id = $1
               and data_generation = $3::bigint
             for update
           )
           on conflict (student_id) do nothing
           returning version`,
          [session.studentId, serializedSession, session.dataGeneration],
        );
        const insertedVersion = readDatabaseSessionVersion(insertResult.rows[0]?.version);
        if (insertedVersion === null) {
          await assertLearnerDataGeneration(session.studentId, session.dataGeneration);
          throw new AaisSessionWriteConflictError();
        }
        setSessionStorageVersion(session, insertedVersion);
        return;
      }
      const updateResult = await database.query(
        `update aais_learner_sessions
         set payload = $2::jsonb, version = version + 1, updated_at = now()
         where student_id = $1 and version = $3
           and exists (
             select 1
             from aais_learner_data_generations
             where student_id = $1
               and data_generation = $4::bigint
             for update
           )
         returning version`,
        [session.studentId, serializedSession, expectedVersion, session.dataGeneration],
      );
      const nextVersion = readDatabaseSessionVersion(updateResult.rows[0]?.version);
      if (nextVersion === null) {
        await assertLearnerDataGeneration(session.studentId, session.dataGeneration);
        throw new AaisSessionWriteConflictError();
      }
      setSessionStorageVersion(session, nextVersion);
      return;
    }
    await withFileLearnerMutationLock(session.studentId, async () => {
      const generation = await readFileLearnerGenerationUnlocked(session.studentId);
      if ((generation?.dataGeneration ?? 1) !== session.dataGeneration) {
        throw new AaisLearnerDataGenerationConflictError();
      }
      await mkdir(getSessionsDir(), { recursive: true });
      const target = getSessionPath(session.studentId);
      const expectedFingerprint = getFileSessionFingerprint(session);
      let currentFingerprint: string | null = null;
      try {
        currentFingerprint = createFileSessionFingerprint(await readFile(target, "utf8"));
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
      if (
        (expectedFingerprint === null && currentFingerprint !== null)
        || (expectedFingerprint !== null && currentFingerprint !== expectedFingerprint)
      ) {
        throw new AaisSessionWriteConflictError();
      }
      const tempPath = `${target}.${process.pid}.${randomUUID()}.tmp`;
      const serialized = `${serializedSession}\n`;
      await writeFile(tempPath, serialized, "utf8");
      await rename(tempPath, target);
      setFileSessionFingerprint(session, createFileSessionFingerprint(serialized));
    });
  }

  async function writeSessionAndMirrorEvents(
    session: AaisLearnerSession,
    events: AaisEvent[],
    budgetReservationId?: string,
    educatorAccess?: AaisEducatorCohortAccess,
  ) {
    serializeAaisLearnerSession(session);
    if (educatorAccess && !database) {
      throw new AaisLearningStorageConfigurationError();
    }
    if (!database) {
      if (budgetReservationId) {
        await withFileGuideBudgetLock(async () => {
          await assertLearnerDataGeneration(session.studentId, session.dataGeneration);
          const reservation = fileGuideReservations.get(budgetReservationId);
          if (
            !reservation
            || reservation.studentId !== session.studentId
            || (
              reservation.state !== "dispatched"
              && (
                reservation.state !== "reserved"
                || reservation.expiresAt <= new Date().toISOString()
              )
            )
          ) {
            throw new Error("AAIS guide reservation could not be completed.");
          }
          await writeSession(session);
          reservation.state = "completed";
        });
      } else {
        await writeSession(session);
      }
      if (events.length && !requiresAaisResearchDataPlaneIsolation()) {
        enqueueAaisLrsEvents(events);
      }
      return;
    }

    const persistLegacyEvents = events.length > 0 && !requiresAaisResearchDataPlaneIsolation();
    const statement = createAtomicLearnerMutationStatement({
      session,
      events: persistLegacyEvents ? events : [],
      budgetReservationId,
      educatorAccess,
    });
    let result: { rows: Array<Record<string, unknown>> };
    try {
      result = await database.query(statement.sql, statement.params);
    } catch (error) {
      if (isDatabaseSessionWriteConflict(error)) {
        throw new AaisSessionWriteConflictError();
      }
      throw error;
    }
    const nextVersion = readDatabaseSessionVersion(result.rows[0]?.version);
    if (nextVersion === null) {
      await assertLearnerDataGeneration(session.studentId, session.dataGeneration);
      if (educatorAccess) {
        await assertEducatorCanAccessLearner(database, educatorAccess, session.studentId);
      }
      throw new AaisSessionWriteConflictError();
    }
    setSessionStorageVersion(session, nextVersion);

    // The mutation transaction only appends to the product outbox. External LRS
    // delivery is owned by the bounded cron worker so a learner request can
    // never start an unobserved, fire-and-forget provider call.
  }

  function getSessionsDir() {
    return path.join(/*turbopackIgnore: true*/ rootDir, "sessions");
  }

  function getGenerationsDir() {
    return path.join(/*turbopackIgnore: true*/ rootDir, "learner-data-generations");
  }

  function getSessionPath(studentId: string) {
    return path.join(
      /*turbopackIgnore: true*/ getSessionsDir(),
      `${requireSafeId(studentId, "student id")}.json`,
    );
  }

  function getGenerationPath(studentId: string) {
    return path.join(
      /*turbopackIgnore: true*/ getGenerationsDir(),
      `${requireSafeId(studentId, "student id")}.json`,
    );
  }

  return {
    appendGuideExchange,
    archiveArtifact,
    completeTask,
    deleteLearnerData,
    deleteRestrictedResearchRawText,
    exportEducatorCohortAnalytics,
    exportEvents,
    exportLearnerData,
    getDailyGuideUsage,
    getEducatorCohortAnalytics,
    getAnalytics,
    getOrCreateSession,
    readSession,
    releaseGuideExchangeCapacity,
    recordRecommendationOverride,
    recordAiAcceptance,
    finalizeDailyGuideRequest,
    reserveGuideExchangeCapacity,
    reserveDailyGuideRequest,
    requestScaffold,
    saveArtifact,
    saveSelfReport,
    selectStage,
    selectTask,
  };
}

function assertLegacyResearchDataAccessAllowed() {
  if (requiresAaisResearchDataPlaneIsolation()) {
    throw new AaisLegacyResearchDataAccessDisabledError();
  }
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
  pagination?: AaisCohortLearnerPaginationInput,
) {
  const appliedFilters = normalizeCohortAnalyticsFilters(filters);
  const hasFilters = Object.keys(appliedFilters).length > 0;
  const normalizedSessions = sessions
    .map((session) => normalizeSession(session))
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
  const learnerSummaries = normalizedSessions.map((session): AaisCohortLearnerSummary => {
    const analytics = summarizeAaisLearningAnalytics(session);
    const learnerProfile = {
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
    return createCompatibleCohortLearnerSummary({
      studentId: session.studentId,
      sessionId: session.sessionId,
      learnerProfile: {
        ...learnerProfile,
        ...summarizeCohortLearnerRisk(learnerProfile),
      },
      storedDecisions: readLatestRecommendationOverrideDecisions(session.events),
      overrideEvidence: readRecommendationOverrideEvidenceFromEvents(session.events),
    });
  });
  return buildAaisCohortAnalyticsSummary(learnerSummaries, appliedFilters, "lrs", pagination);
}

function normalizeEducatorCohortAccess(
  access: AaisEducatorCohortAccess,
): AaisEducatorCohortAccess {
  const actorId = requireSafeId(access.actorId, "educator actor id");
  if (access.actorRole !== "teacher" && access.actorRole !== "admin") {
    throw new AaisEducatorScopeAuthorizationError();
  }
  return {
    actorId,
    actorRole: access.actorRole,
  };
}

async function assertActiveEducatorEnrollmentScope(
  database: AaisDatabaseClient,
  access: AaisEducatorCohortAccess,
) {
  try {
    const result = await database.query(
      `select exists (
         select 1
         from aais_enrollments educator
         where educator.user_id = $1
           and educator.role = $2
           and educator.status = 'active'
       ) as authorized`,
      [access.actorId, access.actorRole],
    );
    if (!readSqlBoolean(result.rows[0]?.authorized)) {
      throw new AaisEducatorScopeAuthorizationError();
    }
  } catch (error) {
    if (isMissingAaisRelationError(error)) {
      throw new AaisLearningStorageConfigurationError();
    }
    throw error;
  }
}

async function assertEducatorCanAccessLearner(
  database: AaisDatabaseClient,
  access: AaisEducatorCohortAccess,
  studentId: string,
) {
  try {
    const result = await database.query(
      `select exists (
         select 1
         from (
           select
             enrollment.user_id as student_id,
             min(enrollment.course_id) as course_id,
             min(enrollment.cohort) as cohort
           from aais_enrollments enrollment
           where enrollment.role = 'student'
             and enrollment.status = 'active'
           group by enrollment.user_id
           having count(*) = 1
         ) learner_scope
         inner join aais_enrollments learner
           on learner.user_id = learner_scope.student_id
          and learner.course_id = learner_scope.course_id
          and learner.cohort = learner_scope.cohort
         inner join aais_enrollments educator
           on educator.course_id = learner.course_id
          and educator.cohort = learner.cohort
         where learner.user_id = $1
           and learner.role = 'student'
           and learner.status = 'active'
           and educator.user_id = $2
           and educator.role = $3
           and educator.status = 'active'
       ) as authorized`,
      [requireSafeId(studentId, "student id"), access.actorId, access.actorRole],
    );
    if (!readSqlBoolean(result.rows[0]?.authorized)) {
      throw new AaisEducatorScopeAuthorizationError();
    }
  } catch (error) {
    if (isMissingAaisRelationError(error)) {
      throw new AaisLearningStorageConfigurationError();
    }
    throw error;
  }
}

async function readAuthorizedSqlCohortAnalyticsRows(
  database: AaisDatabaseClient,
  access: AaisEducatorCohortAccess,
  filters: AaisCohortAnalyticsFilters = {},
) {
  const appliedFilters = normalizeCohortAnalyticsFilters(filters);
  const params = [
    access.actorId,
    access.actorRole,
    appliedFilters.phase ?? null,
    appliedFilters.task ?? null,
    appliedFilters.agent ?? null,
    appliedFilters.event ?? null,
    appliedFilters.cohort ?? null,
    appliedFilters.role ?? null,
    appliedFilters.courseId ?? null,
  ];
  try {
    const result = await database.query(
      `with unambiguous_active_learner_scope as materialized (
         select
           learner.user_id as student_id,
           min(learner.course_id) as course_id,
           min(learner.cohort) as cohort,
           min(learner.role) as role
         from aais_enrollments learner
         where learner.role = 'student'
           and learner.status = 'active'
         group by learner.user_id
         having count(*) = 1
       ),
       educator_scope as materialized (
         select educator.course_id, educator.cohort
         from aais_enrollments educator
         where educator.user_id = $1
           and educator.role = $2
           and educator.status = 'active'
       ),
       authorized_learners as materialized (
         select learner.student_id
         from unambiguous_active_learner_scope learner
         inner join educator_scope scope
           on scope.course_id = learner.course_id
          and scope.cohort = learner.cohort
         where ($7::text is null or learner.cohort = $7)
           and ($8::text is null or learner.role = $8)
           and ($9::text is null or learner.course_id = $9)
       ),
       matching_sessions as (
         select distinct e.student_id, e.session_id
         from aais_events e
         inner join authorized_learners learner
           on learner.student_id = e.student_id
         where ($3::text is null or e.phase = $3)
           and ($4::text is null or e.task = $4)
           and ($5::text is null or e.agent = $5)
           and ($6::text is null or e.event = $6)
       ),
       all_session_events as (
         select e.*
         from aais_events e
         inner join matching_sessions m
           on m.student_id = e.student_id
          and m.session_id = e.session_id
       ),
       filtered_session_events as (
         select e.*
         from all_session_events e
         where ($3::text is null or e.phase = $3)
           and ($4::text is null or e.task = $4)
           and ($5::text is null or e.agent = $5)
           and ($6::text is null or e.event = $6)
       ),
       status_by_session as (
         select
           student_id,
           session_id,
           max(event_time) as updated_at,
           bool_or(phase = 'training' and event = 'task_completed') as training_completed,
           (
             array_agg(task order by event_time desc, id desc)
             filter (
               where phase = 'practice'
                 and task is not null
                 and task <> ''
                 and event in (
                   'task_selected',
                   'task_completed',
                   'artifact_saved',
                   'artifact_edited',
                   'self_report_saved',
                   'scaffold_request',
                   'coaching_push',
                   'monitoring_pause_detected',
                   'ai_prompt_submitted',
                   'ai_response_completed',
                   'ai_acceptance_recorded',
                   'expert_trace_compared'
                 )
             )
           )[1] as active_practice_task_id,
           count(distinct task) filter (
             where phase = 'practice'
               and event = 'task_completed'
           )::int as completed_practice_tasks
         from all_session_events
         group by student_id, session_id
       ),
       counts_by_session as (
         select
           student_id,
           session_id,
           count(*) filter (where event = 'scaffold_request')::int as scaffold_requests,
           count(*) filter (
             where event in ('coaching_push', 'monitoring_pause_detected')
           )::int as coaching_signals,
           count(*) filter (
             where event in ('ai_prompt_submitted', 'ai_response_completed')
           )::int as ai_prompt_response_events,
           count(distinct coalesce(nullif(detail->>'decision_key', ''), id)) filter (
             where event = 'ai_acceptance_recorded'
           )::int as ai_acceptance_decisions,
           count(*) filter (where event = 'self_report_saved')::int as self_report_count,
           count(*) filter (where event = 'expert_trace_compared')::int as expert_trace_count
         from filtered_session_events
         group by student_id, session_id
       ),
       latest_recommendation_overrides as (
         select distinct on (student_id, session_id, detail->>'recommendation_id')
           student_id,
           session_id,
           detail->>'recommendation_id' as recommendation_id,
           detail->>'decision' as decision
         from all_session_events
         where event = 'recommendation_override_recorded'
           and coalesce(detail->>'recommendation_id', '') <> ''
           and detail->>'decision' in ('accepted', 'dismissed', 'deferred')
         order by
           student_id,
           session_id,
           detail->>'recommendation_id',
           event_time desc,
           id desc
       ),
       recommendation_overrides_by_session as (
         select
           student_id,
           session_id,
           jsonb_object_agg(recommendation_id, decision) as decisions
         from latest_recommendation_overrides
         group by student_id, session_id
       ),
       recommendation_override_evidence_by_session as (
         select
           student_id,
           session_id,
           jsonb_agg(
             jsonb_build_object(
               'recommendationId', detail->>'recommendation_id',
               'ruleId', detail->>'rule_id',
               'targetTaskId', task,
               'learnerKey', detail->>'learner_key',
               'sessionKey', detail->>'session_key',
               'decision', detail->>'decision',
               'eventTime', event_time,
               'eventId', id
             )
             order by event_time asc, id asc
           ) as evidence
         from all_session_events
         where event = 'recommendation_override_recorded'
           and coalesce(detail->>'recommendation_id', '') <> ''
           and coalesce(detail->>'rule_id', '') <> ''
           and detail->>'decision' in ('accepted', 'dismissed', 'deferred')
         group by student_id, session_id
       )
       select
         s.student_id,
         s.session_id,
         s.updated_at,
         s.training_completed,
         s.active_practice_task_id,
         s.completed_practice_tasks,
         coalesce(c.scaffold_requests, 0)::int as scaffold_requests,
         coalesce(c.coaching_signals, 0)::int as coaching_signals,
         coalesce(c.ai_prompt_response_events, 0)::int as ai_prompt_response_events,
         coalesce(c.ai_acceptance_decisions, 0)::int as ai_acceptance_decisions,
         coalesce(c.self_report_count, 0)::int as self_report_count,
         coalesce(c.expert_trace_count, 0)::int as expert_trace_count,
         coalesce(o.decisions, '{}'::jsonb) as recommendation_override_decisions,
         coalesce(evidence.evidence, '[]'::jsonb) as recommendation_override_evidence
       from status_by_session s
       left join counts_by_session c
         on c.student_id = s.student_id
        and c.session_id = s.session_id
       left join recommendation_overrides_by_session o
         on o.student_id = s.student_id
        and o.session_id = s.session_id
       left join recommendation_override_evidence_by_session evidence
         on evidence.student_id = s.student_id
        and evidence.session_id = s.session_id
       order by s.updated_at desc, s.student_id asc`,
      params,
    );
    return result.rows;
  } catch (error) {
    if (isMissingAaisRelationError(error)) {
      throw new AaisLearningStorageConfigurationError();
    }
    throw error;
  }
}

async function readAuthorizedSessionByAnalyticsKeys(
  database: AaisDatabaseClient,
  access: AaisEducatorCohortAccess,
  learnerKey: string,
  sessionKey: string,
) {
  const safeLearnerKey = requireSafeAnalyticsKey(learnerKey, "learner key", "learner");
  const safeSessionKey = requireSafeAnalyticsKey(sessionKey, "session key", "session");
  try {
    const identityResult = await database.query(
      `with unambiguous_active_learner_scope as materialized (
         select
           learner.user_id as student_id,
           min(learner.course_id) as course_id,
           min(learner.cohort) as cohort
         from aais_enrollments learner
         where learner.role = 'student'
           and learner.status = 'active'
         group by learner.user_id
         having count(*) = 1
       )
       select
         session.student_id,
         session.payload->>'sessionId' as session_id,
         session.payload->>'createdAt' as created_at
       from aais_learner_sessions session
       where exists (
         select 1
         from unambiguous_active_learner_scope learner_scope
         inner join aais_enrollments learner
           on learner.user_id = learner_scope.student_id
          and learner.course_id = learner_scope.course_id
          and learner.cohort = learner_scope.cohort
         inner join aais_enrollments educator
           on educator.course_id = learner.course_id
          and educator.cohort = learner.cohort
         where learner.user_id = session.student_id
           and learner.role = 'student'
           and learner.status = 'active'
           and educator.user_id = $1
           and educator.role = $2
           and educator.status = 'active'
       )
       order by session.updated_at desc`,
      [access.actorId, access.actorRole],
    );
    const matches = identityResult.rows.map((row) => {
      const studentId = requireSafeId(readSqlText(row.student_id), "student id");
      const persistedSessionId = readNullableSqlText(row.session_id);
      const sessionId = persistedSessionId
        ? requireSafeId(persistedSessionId, "session id")
        : deriveLegacyAaisSessionId(studentId, readSqlText(row.created_at));
      return { studentId, sessionId };
    }).filter((candidate) => {
      const currentPairMatches =
        createPseudonymousAnalyticsLearnerKey(candidate.studentId) === safeLearnerKey
        && createPseudonymousAnalyticsSessionKey(candidate.sessionId) === safeSessionKey;
      const legacyPairMatches =
        createLegacyPseudonymousAnalyticsLearnerKey(candidate.studentId) === safeLearnerKey
        && createLegacyPseudonymousAnalyticsSessionKey(candidate.sessionId) === safeSessionKey;
      return currentPairMatches || legacyPairMatches;
    });
    if (matches.length !== 1) {
      return null;
    }
    const candidate = matches[0]!;
    const payloadResult = await database.query(
      `with unambiguous_active_learner_scope as materialized (
         select
           learner.user_id as student_id,
           min(learner.course_id) as course_id,
           min(learner.cohort) as cohort
         from aais_enrollments learner
         where learner.role = 'student'
           and learner.status = 'active'
         group by learner.user_id
         having count(*) = 1
       )
       select session.payload, session.version, generation.data_generation
       from aais_learner_sessions session
       left join aais_learner_data_generations generation
         on generation.student_id = session.student_id
       where session.student_id = $1
         and exists (
           select 1
           from unambiguous_active_learner_scope learner_scope
           inner join aais_enrollments learner
             on learner.user_id = learner_scope.student_id
            and learner.course_id = learner_scope.course_id
            and learner.cohort = learner_scope.cohort
           inner join aais_enrollments educator
             on educator.course_id = learner.course_id
            and educator.cohort = learner.cohort
           where learner.user_id = session.student_id
             and learner.role = 'student'
             and learner.status = 'active'
             and educator.user_id = $2
             and educator.role = $3
             and educator.status = 'active'
         )
       limit 1`,
      [candidate.studentId, access.actorId, access.actorRole],
    );
    const session = parseDatabaseSessionPayload(
      payloadResult.rows[0]?.payload,
      payloadResult.rows[0]?.version,
      payloadResult.rows[0]?.data_generation,
    );
    if (!session) {
      return null;
    }
    if (
      session.studentId !== candidate.studentId
      || session.sessionId !== candidate.sessionId
    ) {
      throw new AaisLearnerDataIntegrityError();
    }
    return session;
  } catch (error) {
    if (isMissingAaisRelationError(error)) {
      throw new AaisLearningStorageConfigurationError();
    }
    throw error;
  }
}

function summarizeAaisSqlCohortAnalytics(
  rows: Array<Record<string, unknown>>,
  filters: AaisCohortAnalyticsFilters = {},
  pagination?: AaisCohortLearnerPaginationInput,
) {
  const appliedFilters = normalizeCohortAnalyticsFilters(filters);
  const learnerSummaries = rows.map((row): AaisCohortLearnerSummary => {
    const scaffoldRequests = readSqlInteger(row.scaffold_requests);
    const coachingSignals = readSqlInteger(row.coaching_signals);
    const aiAcceptanceDecisions = readSqlInteger(row.ai_acceptance_decisions);
    const aiInteractions = readSqlInteger(row.ai_prompt_response_events) + aiAcceptanceDecisions;
    const selfReportCount = readSqlInteger(row.self_report_count);
    const expertTraceCount = readSqlInteger(row.expert_trace_count);
    const studentId = readSqlText(row.student_id);
    const sessionId = readSqlText(row.session_id);
    const learnerProfile = {
      updatedAt: readSqlTimestamp(row.updated_at),
      trainingCompleted: readSqlBoolean(row.training_completed),
      activePracticeTaskId: readNullableSqlText(row.active_practice_task_id),
      completedPracticeTasks: readSqlInteger(row.completed_practice_tasks),
      scaffoldRequests,
      coachingSignals,
      aiInteractions,
      aiAcceptanceDecisions,
      reflectionStatus: selfReportCount > 0 && expertTraceCount > 0
        ? "evidence_present"
        : "needs_reflection_evidence",
    };
    return createCompatibleCohortLearnerSummary({
      studentId,
      sessionId,
      learnerProfile: {
        ...learnerProfile,
        ...summarizeCohortLearnerRisk(learnerProfile),
      },
      storedDecisions: readRecommendationOverrideDecisionMap(
        row.recommendation_override_decisions,
      ),
      overrideEvidence: readRecommendationOverrideEvidence(
        row.recommendation_override_evidence,
      ),
    });
  });
  return buildAaisCohortAnalyticsSummary(learnerSummaries, appliedFilters, "aais_events", pagination);
}

function buildAaisCohortAnalyticsSummary(
  learnerSummaries: AaisCohortLearnerSummary[],
  appliedFilters: AaisCohortAnalyticsFilters,
  factLayer: AaisCohortFactLayer,
  paginationInput?: AaisCohortLearnerPaginationInput,
) {
  const riskBreakdown = countCohortRiskLevels(learnerSummaries);
  const pagination = paginationInput
    ? normalizeAaisCohortLearnerPagination(paginationInput, learnerSummaries.length)
    : null;
  const pageLearners = pagination
    ? learnerSummaries.slice(pagination.offset, pagination.offset + pagination.limit)
    : learnerSummaries;
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
    learners: pageLearners,
    ...(pagination ? { pagination } : {}),
    integrations: {
      factLayer,
      joinKeys: ["session_id", "phase", "task", "agent", "event", "cohort", "role", "course_id"],
    },
    privacy: {
      actorMode: "pseudonymous",
      rawPromptStorage: "excluded_from_lrs",
      minimumNecessaryFields: true,
    },
  };
}

export function normalizeAaisCohortLearnerPagination(
  input: AaisCohortLearnerPaginationInput = {},
  totalLearners = 0,
) {
  const limit = normalizeAaisCohortPaginationNumber(
    input.limit,
    "limit",
    defaultAaisCohortLearnerPageLimit,
    1,
    maxAaisCohortLearnerPageLimit,
  );
  const offset = normalizeAaisCohortPaginationNumber(
    input.offset,
    "offset",
    0,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const boundedOffset = Math.min(offset, Math.max(0, totalLearners));
  const returnedLearners = Math.max(0, Math.min(limit, totalLearners - boundedOffset));
  return {
    limit,
    offset: boundedOffset,
    returnedLearners,
    totalLearners,
    hasPreviousPage: boundedOffset > 0,
    hasNextPage: boundedOffset + returnedLearners < totalLearners,
  };
}

function normalizeAaisCohortPaginationNumber(
  value: number | undefined,
  label: "limit" | "offset",
  fallback: number,
  min: number,
  max: number,
) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`Invalid AAIS cohort analytics ${label}.`);
  }
  return Math.min(value, max);
}

function readSqlInteger(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function readSqlText(value: unknown) {
  if (typeof value !== "string" || !value) {
    throw new Error("Invalid AAIS SQL analytics row.");
  }
  return value;
}

function readNullableSqlText(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function readSqlBoolean(value: unknown) {
  return value === true || value === "true";
}

function readSqlTimestamp(value: unknown) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string" && value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return new Date(0).toISOString();
}

function readLatestRecommendationOverrideDecisions(events: AaisEvent[]) {
  const decisions: Record<string, AaisRecommendationOverrideDecision> = {};
  for (const event of events) {
    if (event.event !== "recommendation_override_recorded") {
      continue;
    }
    const recommendationId = event.detail.recommendation_id;
    const decision = event.detail.decision;
    if (
      typeof recommendationId === "string"
      && /^recommendation-[a-f0-9]{12}$/.test(recommendationId)
      && isRecommendationOverrideDecision(decision)
    ) {
      decisions[recommendationId] = decision;
    }
  }
  return decisions;
}

function readRecommendationOverrideDecisionMap(value: unknown) {
  let candidate: unknown = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value);
    } catch {
      candidate = null;
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return {};
  }
  const decisions: Record<string, AaisRecommendationOverrideDecision> = {};
  for (const [recommendationId, decision] of Object.entries(candidate)) {
    if (
      /^recommendation-[a-f0-9]{12}$/.test(recommendationId)
      && isRecommendationOverrideDecision(decision)
    ) {
      decisions[recommendationId] = decision;
    }
  }
  return decisions;
}

function readRecommendationOverrideEvidenceFromEvents(
  events: AaisEvent[],
): AaisRecommendationOverrideEvidence[] {
  return events.flatMap((event, index) => {
    if (event.event !== "recommendation_override_recorded") {
      return [];
    }
    const evidence = normalizeRecommendationOverrideEvidence({
      recommendationId: event.detail.recommendation_id,
      ruleId: event.detail.rule_id,
      targetTaskId: event.task,
      learnerKey: event.detail.learner_key,
      sessionKey: event.detail.session_key,
      decision: event.detail.decision,
      eventTime: event.time,
      eventId: `session-event-${String(index).padStart(12, "0")}`,
    });
    return evidence ? [evidence] : [];
  });
}

function readRecommendationOverrideEvidence(
  value: unknown,
): AaisRecommendationOverrideEvidence[] {
  let candidate = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value);
    } catch {
      candidate = null;
    }
  }
  if (!Array.isArray(candidate)) {
    return [];
  }
  return candidate.flatMap((entry) => {
    const evidence = normalizeRecommendationOverrideEvidence(entry);
    return evidence ? [evidence] : [];
  });
}

function normalizeRecommendationOverrideEvidence(
  value: unknown,
): AaisRecommendationOverrideEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const recommendationId = candidate.recommendationId ?? candidate.recommendation_id;
  const ruleId = candidate.ruleId ?? candidate.rule_id;
  const targetTaskId = candidate.targetTaskId ?? candidate.target_task_id;
  const learnerKey = candidate.learnerKey ?? candidate.learner_key;
  const sessionKey = candidate.sessionKey ?? candidate.session_key;
  const decision = candidate.decision;
  const eventTime = candidate.eventTime ?? candidate.event_time;
  const eventId = candidate.eventId ?? candidate.event_id;
  if (
    typeof recommendationId !== "string"
    || !/^recommendation-[a-f0-9]{12}$/.test(recommendationId)
    || typeof ruleId !== "string"
    || !ruleId
    || (targetTaskId !== null && typeof targetTaskId !== "string")
    || (learnerKey !== null && learnerKey !== undefined && typeof learnerKey !== "string")
    || (sessionKey !== null && sessionKey !== undefined && typeof sessionKey !== "string")
    || !isRecommendationOverrideDecision(decision)
    || typeof eventTime !== "string"
    || !eventTime
    || typeof eventId !== "string"
    || !eventId
  ) {
    return null;
  }
  return {
    recommendationId,
    ruleId,
    targetTaskId,
    learnerKey: typeof learnerKey === "string" ? learnerKey : null,
    sessionKey: typeof sessionKey === "string" ? sessionKey : null,
    decision,
    eventTime,
    eventId,
  };
}

function createCompatibleCohortLearnerSummary(input: {
  studentId: string;
  sessionId: string;
  learnerProfile: AaisCohortLearnerProfile;
  storedDecisions: Record<string, AaisRecommendationOverrideDecision>;
  overrideEvidence: AaisRecommendationOverrideEvidence[];
}): AaisCohortLearnerSummary {
  const currentLearner: AaisCohortLearnerSummary = {
    ...input.learnerProfile,
    learnerKey: createPseudonymousAnalyticsLearnerKey(input.studentId),
    sessionKey: createPseudonymousAnalyticsSessionKey(input.sessionId),
    recommendationOverrideDecisions: {},
  };
  if (
    Object.keys(input.storedDecisions).length === 0
    && input.overrideEvidence.length === 0
  ) {
    return currentLearner;
  }
  const variants = buildRecommendationVariants(input.studentId, input.sessionId, currentLearner);
  const currentBySemanticKey = new Map(variants
    .filter((variant) => variant.version === "v2")
    .map((variant) => [
      createRecommendationSemanticKey(
        variant.recommendation.ruleId,
        variant.recommendation.targetTaskId,
      ),
      variant.recommendation.id,
    ]));
  const compatibleDecisions: Record<string, AaisRecommendationOverrideDecision> = {};

  // Compatibility fallback for rows returned by older query adapters. Current
  // v2 decisions intentionally win when both aliases exist but chronology is
  // unavailable. The production query supplies ordered evidence below.
  for (const version of ["legacy", "v2"] as const) {
    for (const variant of variants.filter((candidate) => candidate.version === version)) {
      const decision = input.storedDecisions[variant.recommendation.id];
      const currentId = currentBySemanticKey.get(createRecommendationSemanticKey(
        variant.recommendation.ruleId,
        variant.recommendation.targetTaskId,
      ));
      if (decision && currentId) {
        compatibleDecisions[currentId] = decision;
      }
    }
  }

  const latestEvidenceBySemanticKey = new Map<
    string,
    AaisRecommendationOverrideEvidence
  >();
  for (const evidence of [...input.overrideEvidence].sort(compareRecommendationEvidence)) {
    const matchedVariant = variants.find((variant) =>
      variant.recommendation.id === evidence.recommendationId
      && variant.recommendation.ruleId === evidence.ruleId
      && variant.recommendation.targetTaskId === evidence.targetTaskId
      && (evidence.learnerKey === null || evidence.learnerKey === variant.learnerKey)
      && (evidence.sessionKey === null || evidence.sessionKey === variant.sessionKey)
    );
    if (!matchedVariant) {
      continue;
    }
    latestEvidenceBySemanticKey.set(createRecommendationSemanticKey(
      matchedVariant.recommendation.ruleId,
      matchedVariant.recommendation.targetTaskId,
    ), evidence);
  }
  for (const [semanticKey, evidence] of latestEvidenceBySemanticKey) {
    const currentId = currentBySemanticKey.get(semanticKey);
    if (currentId) {
      compatibleDecisions[currentId] = evidence.decision;
    }
  }
  return {
    ...currentLearner,
    recommendationOverrideDecisions: compatibleDecisions,
  };
}

function createRecommendationSemanticKey(ruleId: string, targetTaskId: string | null) {
  return JSON.stringify([aaisRecommendationPolicy.version, ruleId, targetTaskId]);
}

function compareRecommendationEvidence(
  left: AaisRecommendationOverrideEvidence,
  right: AaisRecommendationOverrideEvidence,
) {
  return left.eventTime.localeCompare(right.eventTime) || left.eventId.localeCompare(right.eventId);
}

function buildRecommendationVariants(
  studentId: string,
  sessionId: string,
  currentLearner: AaisCohortLearnerSummary,
): AaisRecommendationVariant[] {
  const keyPairs: Array<{
    version: AaisRecommendationKeyVersion;
    learnerKey: string;
    sessionKey: string;
  }> = [
    {
      version: "v2",
      learnerKey: createPseudonymousAnalyticsLearnerKey(studentId),
      sessionKey: createPseudonymousAnalyticsSessionKey(sessionId),
    },
    {
      version: "legacy",
      learnerKey: createLegacyPseudonymousAnalyticsLearnerKey(studentId),
      sessionKey: createLegacyPseudonymousAnalyticsSessionKey(sessionId),
    },
  ];
  return keyPairs.flatMap((keyPair) => {
    const learner = {
      ...currentLearner,
      learnerKey: keyPair.learnerKey,
      sessionKey: keyPair.sessionKey,
      recommendationOverrideDecisions: {},
    };
    return buildAaisLearnerRecommendations({
      learners: [learner],
      integrations: { factLayer: "aais_events" },
    }, { includeResolved: true }).recommendations.map((recommendation) => ({
      ...keyPair,
      recommendation,
    }));
  });
}

function isRecommendationOverrideDecision(
  value: unknown,
): value is AaisRecommendationOverrideDecision {
  return value === "accepted" || value === "dismissed" || value === "deferred";
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

type AaisProductLrsRuntimeBudget = {
  now: () => number;
  invocationBudgetDeadlineMs: number;
  dispatchDeadlineMs: number;
  requestTimeoutMs: number;
  reconcileAfter: string;
};

function createAaisProductLrsRuntimeBudget(input: {
  runtimeBudgetMs?: number;
  finalizeGuardMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
}): AaisProductLrsRuntimeBudget {
  const now = input.now ?? Date.now;
  const startedAtMs = now();
  if (!Number.isFinite(startedAtMs)) {
    throw new Error("Invalid AAIS product LRS worker clock.");
  }
  const runtimeBudgetMs = normalizeAaisProductLrsDuration(
    input.runtimeBudgetMs,
    aaisProductLrsInvocationBudgetMs,
    3,
    aaisProductLrsInvocationBudgetMs,
  );
  const finalizeGuardMs = normalizeAaisProductLrsDuration(
    input.finalizeGuardMs,
    aaisProductLrsFinalizeGuardMs,
    1,
    Math.max(1, runtimeBudgetMs - 2),
  );
  const dispatchWindowMs = runtimeBudgetMs - finalizeGuardMs;
  const requestTimeoutMs = normalizeAaisProductLrsDuration(
    input.requestTimeoutMs,
    aaisProductLrsRequestTimeoutMs,
    1,
    Math.min(60_000, dispatchWindowMs),
  );
  const invocationBudgetDeadlineMs = startedAtMs + runtimeBudgetMs;
  return {
    now,
    invocationBudgetDeadlineMs,
    dispatchDeadlineMs: invocationBudgetDeadlineMs - finalizeGuardMs,
    requestTimeoutMs,
    reconcileAfter: new Date(
      startedAtMs
        + aaisProductLrsPlatformMaxDurationMs
        + aaisProductLrsDeliverySafetyMarginMs,
    ).toISOString(),
  };
}

function normalizeAaisProductLrsDuration(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = value === undefined ? fallback : Math.floor(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("Invalid AAIS product LRS worker duration.");
  }
  return Math.min(maximum, Math.max(minimum, parsed));
}

function canStartAaisProductLrsRequest(runtime: AaisProductLrsRuntimeBudget) {
  return runtime.now() + runtime.requestTimeoutMs <= runtime.dispatchDeadlineMs;
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
  runtimeBudgetMs?: number;
  finalizeGuardMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
} = {}) {
  const runtime = createAaisProductLrsRuntimeBudget({
    runtimeBudgetMs: input.runtimeBudgetMs,
    finalizeGuardMs: input.finalizeGuardMs,
    requestTimeoutMs: input.requestTimeoutMs,
    now: input.now,
  });
  if (requiresAaisResearchDataPlaneIsolation()) {
    return {
      status: "not_configured" as const,
      sent: 0,
      failed: 0,
      deferred: 0,
      batches: 0,
      stoppedReason: "not_configured" as const,
      hasMore: false,
      secrets: "redacted" as const,
    };
  }
  const database = input.database ?? getConfiguredDatabaseClient();
  if (!database) {
    return {
      status: "not_configured" as const,
      sent: 0,
      failed: 0,
      deferred: 0,
      batches: 0,
      stoppedReason: "not_configured" as const,
      hasMore: false,
      secrets: "redacted" as const,
    };
  }
  if (
    input.config === null
    || (input.config === undefined && !getLrsConfigurationStatus().configured)
  ) {
    return {
      status: "not_configured" as const,
      sent: 0,
      failed: 0,
      deferred: 0,
      batches: 0,
      stoppedReason: "not_configured" as const,
      hasMore: false,
      secrets: "redacted" as const,
    };
  }

  const limit = Math.min(500, Math.max(0, Math.floor(input.limit ?? 50)));
  const maxBatchSize = Math.min(50, Math.max(1, Math.floor(input.maxBatchSize ?? 50)));
  const maxAttempts = Math.min(100, Math.max(1, Math.floor(input.maxAttempts ?? 3)));
  const processedIds: string[] = [];
  let selected = 0;
  let sent = 0;
  let failed = 0;
  let deferred = 0;
  let batches = 0;
  let stoppedReason: "budget_exhausted" | "drained" | "limit_reached" | "not_configured" | null = null;
  let hasMore = false;
  while (selected < limit) {
    if (!canStartAaisProductLrsRequest(runtime)) {
      stoppedReason = "budget_exhausted";
      hasMore = true;
      break;
    }
    const claimId = randomUUID();
    const claimResult = await database.query(
      `with candidate as (
        select id
        from aais_lrs_outbox o
        where not (o.id = any($4::text[]))
          and exists (
            select 1
            from aais_learner_data_generations generation
            where generation.student_id = o.payload->>'student_id'
              and generation.lrs_delivery_state = 'idle'
          )
          and (
            o.status in ('pending', 'retry')
            or (o.status = 'sending' and o.lease_expires_at <= now())
          )
        order by o.created_at, o.id
        for update skip locked
        limit $1
      )
      update aais_lrs_outbox o
      set status = 'sending',
        delivery_claim_id = $2::uuid,
        lease_expires_at = now() + ($3::integer * interval '1 second'),
        updated_at = now()
      from candidate
      where o.id = candidate.id
      returning o.id, o.payload, o.attempts, o.xapi_statement,
        (
          select generation.data_generation
          from aais_learner_data_generations generation
          where generation.student_id = o.payload->>'student_id'
        ) as learner_data_generation`,
      [Math.min(maxBatchSize, limit - selected), claimId, aaisProductLrsLeaseDurationSeconds, processedIds],
    );
    const batch = claimResult.rows;
    if (!batch.length) {
      stoppedReason = "drained";
      break;
    }
    processedIds.push(...batch.map((row) => String(row.id)));
    selected += batch.length;

    const materialized = await Promise.all(batch.map(async (row) => {
      try {
        const event = normalizeOutboxPayload(row.payload);
        const studentId = requireSafeId(event.student_id, "outbox student id");
        const dataGeneration = readLearnerDataGeneration(row.learner_data_generation);
        const statement = row.xapi_statement
          ? normalizeFrozenAaisXapiStatement(row.xapi_statement)
          : buildAaisXapiStatement(event);
        const frozen = await database.query(
          `update aais_lrs_outbox
           set xapi_statement = coalesce(xapi_statement, $3::jsonb), updated_at = now()
           where id = $1 and delivery_claim_id = $2::uuid and status = 'sending'
           returning xapi_statement`,
          [row.id, claimId, JSON.stringify(statement)],
        );
        if (!frozen.rows.length) {
          return { status: "stale" as const, row };
        }
        return {
          status: "ready" as const,
          row,
          statement: normalizeFrozenAaisXapiStatement(frozen.rows[0]?.xapi_statement),
          studentId,
          dataGeneration,
        };
      } catch {
        return { status: "poison" as const, row };
      }
    }));
    const readyRows = materialized.filter((item) => item.status === "ready");
    const poisonRows = materialized.filter((item) => item.status === "poison").map((item) => item.row);
    if (poisonRows.length) {
      const retryResults = await markAaisOutboxRowsFailed({
        database,
        rows: poisonRows,
        claimId,
        maxAttempts,
      });
      failed += retryResults;
      if (!readyRows.length) {
        batches += 1;
      }
    }
    if (!readyRows.length) {
      continue;
    }

    if (!canStartAaisProductLrsRequest(runtime)) {
      await releaseAaisOutboxRowsWithoutDelivery({
        database,
        rows: readyRows,
        claimId,
      });
      deferred += readyRows.length;
      stoppedReason = "budget_exhausted";
      hasMore = true;
      break;
    }

    const deliveryFenceAcquired = await acquireAaisLrsDeliveryFence({
      database,
      rows: readyRows,
      claimId,
      maxAttempts,
      runtime,
    });
    if (!deliveryFenceAcquired) {
      failed += await releaseAaisOutboxRowsWithoutDelivery({
        database,
        rows: readyRows,
        claimId,
      });
      continue;
    }

    const delivery = await deliverMaterializedAaisOutboxRows({
      rows: readyRows,
      config: input.config,
      fetchImpl: input.fetchImpl,
      runtime,
    });
    batches += delivery.batches;
    if (delivery.uncertainRows.length) {
      await finalizeUncertainAaisLrsDeliveryAttempt({
        database,
        claimId,
        rows: readyRows,
      });
      failed += readyRows.length;
      if (delivery.deferredRows.length) {
        stoppedReason = "budget_exhausted";
        hasMore = true;
        deferred += delivery.deferredRows.length;
        break;
      }
      continue;
    }
    const sentIds = new Set(delivery.sentRows.map(({ row }) => String(row.id)));
    const failedIds = new Set(delivery.failedRows.map(({ row }) => String(row.id)));
    const notConfiguredIds = new Set(
      delivery.notConfiguredRows.map(({ row }) => String(row.id)),
    );
    const deferredIds = new Set(
      delivery.deferredRows.map(({ row }) => String(row.id)),
    );
    const finalized = await finalizeResolvedAaisLrsDeliveryAttempt({
      database,
      claimId,
      rows: readyRows,
      sentIds,
      failedIds,
      notConfiguredIds,
      deferredIds,
      maxAttempts,
    });
    sent += finalized.sent;
    failed += finalized.failed;
    deferred += finalized.deferred;
    for (const row of finalized.rows) {
      if (row.status !== "pending") {
        continue;
      }
      const processedIndex = processedIds.indexOf(row.id);
      if (processedIndex >= 0) {
        processedIds.splice(processedIndex, 1);
      }
      selected = Math.max(0, selected - 1);
    }
    if (delivery.notConfiguredRows.length) {
      return {
        status: "not_configured" as const,
        sent,
        failed,
        deferred,
        batches,
        stoppedReason: "not_configured" as const,
        hasMore: true,
        secrets: "redacted" as const,
      };
    }
    if (delivery.deferredRows.length) {
      stoppedReason = "budget_exhausted";
      hasMore = true;
      break;
    }
  }
  if (!stoppedReason) {
    stoppedReason = "limit_reached";
    hasMore = limit > 0;
  }
  return {
    status: failed || deferred ? "partial" as const : "sent" as const,
    sent,
    failed,
    deferred,
    batches,
    stoppedReason,
    hasMore,
    secrets: "redacted" as const,
  };
}

export async function reconcileAaisLrsDeliveryAttempt(input: {
  actorId: string;
  claimId: string;
  database?: AaisDatabaseClient | null;
  evidence: AaisLrsDeliveryReconciliationEvidence;
  now?: () => Date;
}): Promise<AaisLrsDeliveryReconciliationResult> {
  const actorId = requireAaisLrsReconciliationActorId(input.actorId);
  const claimId = requireAaisLrsReconciliationUuid(input.claimId, "claim id");
  const reconciledAt = (input.now ?? (() => new Date()))();
  if (!Number.isFinite(reconciledAt.getTime())) {
    throw new Error("Invalid AAIS LRS reconciliation time.");
  }
  const evidence = requireAaisLrsReconciliationEvidence(input.evidence, reconciledAt);
  const normalizedStatements = [...evidence.statements]
    .sort((left, right) => left.statementId.localeCompare(right.statementId));
  const evidenceSha256 = sha256CanonicalJson({
    schema: "aais.product-lrs-delivery-reconciliation.v1",
    claimId,
    observedAt: evidence.observedAt,
    statements: normalizedStatements,
  });
  const database = input.database === undefined
    ? getConfiguredDatabaseClient()
    : input.database;
  if (!database) {
    throw new AaisLrsDeliveryReconciliationStoreError();
  }
  const result = await database.query(
    `with provided as materialized (
       select candidate.statement_id, candidate.status
       from jsonb_to_recordset($2::jsonb)
         as candidate(statement_id uuid, status text)
     ), locked_attempt as materialized (
       select attempt.*
       from public.aais_lrs_delivery_attempts attempt
       where attempt.claim_id = $1::uuid
       for update
     ), existing_reconciliation as materialized (
       select attempt.claim_id, attempt.reconciliation_result as result,
              attempt.statement_count, attempt.stored_count,
              attempt.absent_count, attempt.reconciled_at
       from locked_attempt attempt
       where attempt.state = 'reconciled'
         and attempt.reconciliation_evidence_sha256 = $3
         and attempt.reconciliation_observed_at = $4::timestamptz
     ), expected_statements as materialized (
       select statement.outbox_id, statement.student_id,
              statement.data_generation, statement.statement_id,
              statement.frozen_statement, provided.status
       from public.aais_lrs_delivery_attempt_statements statement
       inner join provided on provided.statement_id = statement.statement_id
       where statement.claim_id = $1::uuid
         and provided.status in ('stored', 'absent')
     ), locked_generations as materialized (
       select generation.student_id
       from public.aais_learner_data_generations generation
       inner join (
         select distinct student_id, data_generation from expected_statements
       ) expected
         on expected.student_id = generation.student_id
        and expected.data_generation = generation.data_generation
       where generation.lrs_delivery_claim_id = $1::uuid
         and generation.lrs_delivery_state in ('in_flight', 'uncertain')
       for update of generation
     ), locked_outbox as materialized (
       select outbox.id, outbox.pending_payload, expected.status
       from public.aais_lrs_outbox outbox
       inner join expected_statements expected on expected.outbox_id = outbox.id
       cross join (
         select count(*)::integer as generation_count from locked_generations
       ) generation_lock_barrier
       where generation_lock_barrier.generation_count >= 0
         and outbox.status = 'sending'
         and outbox.delivery_claim_id = $1::uuid
         and outbox.xapi_statement = expected.frozen_statement
         and outbox.xapi_statement->>'id' = expected.statement_id::text
       for update of outbox
     ), valid_transition as materialized (
       select attempt.claim_id, attempt.statement_count, attempt.max_attempts
       from locked_attempt attempt
       where attempt.state in ('in_flight', 'uncertain')
         and attempt.reconcile_after < $4::timestamptz
         and $4::timestamptz <= $5::timestamptz
         and attempt.statement_count = (select count(*) from provided)
         and attempt.statement_count = (select count(*) from expected_statements)
         and attempt.statement_count = (select count(*) from locked_outbox)
         and (select count(*) from provided) =
             (select count(distinct statement_id) from provided)
         and (select count(*) from locked_generations) = (
           select count(*) from (
             select distinct student_id, data_generation from expected_statements
           ) students
         )
     ), updated_outbox as (
       update public.aais_lrs_outbox outbox
       set payload = case
             when locked.status = 'stored'
               then coalesce(outbox.pending_payload, outbox.payload)
             else outbox.payload
           end,
           status = case
             when locked.status = 'stored' and outbox.pending_payload is null then 'sent'
             when locked.status = 'stored' then 'pending'
             when outbox.attempts + 1 >= valid.max_attempts then 'dead_letter'
             else 'retry'
           end,
           attempts = case
             when locked.status = 'stored' and outbox.pending_payload is not null then 0
             when locked.status = 'absent' then outbox.attempts + 1
             else outbox.attempts
           end,
           xapi_statement = case
             when locked.status = 'stored' and outbox.pending_payload is not null then null
             else outbox.xapi_statement
           end,
           pending_payload = case
             when locked.status = 'stored' then null
             else outbox.pending_payload
           end,
           delivery_claim_id = null,
           lease_expires_at = null,
           last_error = case
             when locked.status = 'stored' then null
             else 'operator_confirmed_absent'
           end,
           updated_at = $5::timestamptz
       from locked_outbox locked, valid_transition valid
       where outbox.id = locked.id
       returning outbox.id, locked.status
     ), updated_statements as (
       update public.aais_lrs_delivery_attempt_statements statement
       set reconciliation_status = expected.status
       from expected_statements expected
       where statement.claim_id = $1::uuid
         and statement.outbox_id = expected.outbox_id
         and (select count(*) from updated_outbox) =
             (select statement_count from valid_transition)
       returning statement.statement_id, statement.reconciliation_status
     ), updated_attempt as (
       update public.aais_lrs_delivery_attempts attempt
       set state = 'reconciled',
           completed_at = $5::timestamptz,
           reconciliation_result = case
             when (select count(*) from updated_statements
                   where reconciliation_status = 'stored') = attempt.statement_count
               then 'stored'
             when (select count(*) from updated_statements
                   where reconciliation_status = 'absent') = attempt.statement_count
               then 'absent'
             else 'mixed'
           end,
           reconciliation_evidence_sha256 = $3,
           reconciliation_observed_at = $4::timestamptz,
           reconciled_at = $5::timestamptz,
           reconciled_by = $6,
           stored_count = (select count(*)::integer from updated_statements
                           where reconciliation_status = 'stored'),
           absent_count = (select count(*)::integer from updated_statements
                           where reconciliation_status = 'absent')
       from valid_transition valid
       where attempt.claim_id = valid.claim_id
         and (select count(*) from updated_statements) = attempt.statement_count
       returning attempt.claim_id, attempt.reconciliation_result as result,
                 attempt.statement_count, attempt.stored_count,
                 attempt.absent_count, attempt.reconciled_at
     ), updated_generations as (
       update public.aais_learner_data_generations generation
       set lrs_delivery_state = 'idle',
           lrs_delivery_claim_id = null,
           lrs_delivery_started_at = null,
           updated_at = $5::timestamptz
       from (
         select distinct student_id, data_generation from expected_statements
       ) expected, updated_attempt
       where generation.student_id = expected.student_id
         and generation.data_generation = expected.data_generation
         and generation.lrs_delivery_claim_id = updated_attempt.claim_id
         and generation.lrs_delivery_state in ('in_flight', 'uncertain')
       returning generation.student_id
     ), transitioned as materialized (
       select attempt.*
       from updated_attempt attempt
       where (select count(*) from updated_generations) = (
         select count(*) from (
           select distinct student_id, data_generation from expected_statements
         ) students
       )
     )
     select existing.claim_id, existing.result, existing.statement_count,
            existing.stored_count, existing.absent_count, existing.reconciled_at
     from existing_reconciliation existing
     union all
     select transitioned.claim_id, transitioned.result,
            transitioned.statement_count, transitioned.stored_count,
            transitioned.absent_count, transitioned.reconciled_at
     from transitioned`,
    [
      claimId,
      JSON.stringify(normalizedStatements.map((statement) => ({
        statement_id: statement.statementId,
        status: statement.status,
      }))),
      evidenceSha256,
      evidence.observedAt,
      reconciledAt.toISOString(),
      actorId,
    ],
  ).catch((error: unknown) => {
    if (isAaisLrsReconciliationSchemaDatabaseError(error)) {
      throw new AaisLrsDeliveryReconciliationStoreError();
    }
    throw error;
  });
  if (result.rows.length !== 1) {
    throw new AaisLrsDeliveryReconciliationConflictError();
  }
  return parseAaisLrsReconciliationResult(result.rows[0] ?? {}, claimId);
}

export async function listAaisPendingLrsDeliveryAttempts(input: {
  database?: AaisDatabaseClient | null;
  limit?: number;
} = {}): Promise<AaisPendingLrsDeliveryAttempt[]> {
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Invalid AAIS pending LRS delivery attempt limit.");
  }
  const database = input.database === undefined
    ? getConfiguredDatabaseClient()
    : input.database;
  if (!database) {
    throw new AaisLrsDeliveryReconciliationStoreError();
  }
  const result = await database.query(
    `select attempt.claim_id, attempt.state, attempt.started_at,
            attempt.reconcile_after, attempt.statement_count,
            coalesce(
              array_agg(statement.statement_id::text order by statement.statement_id::text)
                filter (where statement.statement_id is not null),
              array[]::text[]
            ) as statement_ids
       from public.aais_lrs_delivery_attempts attempt
       left join public.aais_lrs_delivery_attempt_statements statement
         on statement.claim_id = attempt.claim_id
      where attempt.state in ('in_flight', 'uncertain')
      group by attempt.claim_id, attempt.state, attempt.started_at,
               attempt.reconcile_after, attempt.statement_count
      order by attempt.reconcile_after asc, attempt.started_at asc,
               attempt.claim_id asc
      limit $1`,
    [limit],
  ).catch((error: unknown) => {
    if (isAaisLrsReconciliationSchemaDatabaseError(error)) {
      throw new AaisLrsDeliveryReconciliationStoreError();
    }
    throw error;
  });
  return result.rows.map(parseAaisPendingLrsDeliveryAttempt);
}

type MaterializedAaisOutboxRow = {
  status: "ready";
  row: Record<string, unknown>;
  statement: AaisXapiStatement;
  studentId: string;
  dataGeneration: number;
};

async function acquireAaisLrsDeliveryFence(input: {
  database: AaisDatabaseClient;
  rows: MaterializedAaisOutboxRow[];
  claimId: string;
  maxAttempts: number;
  runtime: AaisProductLrsRuntimeBudget;
}) {
  const expectedGenerations = new Map<string, number>();
  for (const row of input.rows) {
    const existing = expectedGenerations.get(row.studentId);
    if (existing !== undefined && existing !== row.dataGeneration) {
      return false;
    }
    expectedGenerations.set(row.studentId, row.dataGeneration);
  }
  const expected = Array.from(expectedGenerations, ([studentId, dataGeneration]) => ({
    student_id: studentId,
    data_generation: dataGeneration,
  }));
  const attemptStatements = input.rows.map(({ row, statement, studentId, dataGeneration }) => ({
    outbox_id: String(row.id),
    student_id: studentId,
    data_generation: dataGeneration,
    statement_id: statement.id,
    statement_sha256: sha256CanonicalJson(statement),
    frozen_statement: statement,
  }));
  const statementSetSha256 = sha256CanonicalJson(
    attemptStatements
      .map((statement) => [statement.statement_id, statement.statement_sha256])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  );
  // Use both clocks: the application invocation start and the database's
  // attempt clock. The later value wins, so clock skew cannot make operator
  // reconciliation eligible while this platform invocation (or its final DB
  // statement) can still be alive.
  const acquired = await input.database.query(
    `with expected as materialized (
       select candidate.student_id, candidate.data_generation
       from jsonb_to_recordset($1::jsonb)
         as candidate(student_id text, data_generation bigint)
     ), statements as materialized (
       select candidate.outbox_id, candidate.student_id,
              candidate.data_generation, candidate.statement_id,
              candidate.statement_sha256, candidate.frozen_statement
       from jsonb_to_recordset($2::jsonb) as candidate(
         outbox_id text,
         student_id text,
         data_generation bigint,
         statement_id uuid,
         statement_sha256 text,
         frozen_statement jsonb
       )
     ), valid_claim as materialized (
       select count(*)::integer as row_count
       from aais_lrs_outbox outbox
       inner join statements statement on statement.outbox_id = outbox.id
       inner join expected
         on expected.student_id = statement.student_id
        and expected.data_generation = statement.data_generation
       where outbox.delivery_claim_id = $3::uuid
         and outbox.status = 'sending'
         and outbox.payload->>'student_id' = statement.student_id
         and outbox.xapi_statement = statement.frozen_statement
         and outbox.xapi_statement->>'id' = statement.statement_id::text
     ), locked_generations as materialized (
       select generation.student_id
       from aais_learner_data_generations generation
       inner join expected on expected.student_id = generation.student_id
       where generation.data_generation = expected.data_generation
         and generation.lrs_delivery_state = 'idle'
       for update of generation
     ), attempt_clock as materialized (
       select clock_timestamp() as started_at
     ), fenced_generation as (
     update aais_learner_data_generations generation
     set lrs_delivery_state = 'in_flight',
       lrs_delivery_claim_id = $3::uuid,
       lrs_delivery_started_at = now(),
       updated_at = now()
     from expected
     where generation.student_id = expected.student_id
       and generation.data_generation = expected.data_generation
       and generation.lrs_delivery_state = 'idle'
       and (select row_count from valid_claim) = (select count(*) from statements)
       and (select count(*) from statements) between 1 and 50
       and (select count(*) from locked_generations) = (select count(*) from expected)
     returning generation.student_id
     ), inserted_attempt as (
       insert into public.aais_lrs_delivery_attempts (
         claim_id,
         state,
         statement_count,
         statement_set_sha256,
         started_at,
         request_timeout_ms,
         max_attempts,
         reconcile_after
       )
       select
         $3::uuid,
         'in_flight',
         count(*)::integer,
         $4,
         attempt_clock.started_at,
         $5::integer,
         $6::integer,
         greatest(
           $7::timestamptz,
           attempt_clock.started_at + ($8::integer * interval '1 millisecond')
         )
       from statements
       cross join attempt_clock
       where (select count(*) from fenced_generation) = (select count(*) from expected)
       group by attempt_clock.started_at
       returning claim_id
     ), inserted_statements as (
       insert into public.aais_lrs_delivery_attempt_statements (
         claim_id,
         outbox_id,
         student_id,
         data_generation,
         statement_id,
         statement_sha256,
         frozen_statement
       )
       select
         inserted.claim_id,
         statement.outbox_id,
         statement.student_id,
         statement.data_generation,
         statement.statement_id,
         statement.statement_sha256,
         statement.frozen_statement
       from statements statement
       cross join inserted_attempt inserted
       returning claim_id
     )
     select fenced.student_id
     from fenced_generation fenced
     where (select count(*) from inserted_statements) = (select count(*) from statements)`,
    [
      JSON.stringify(expected),
      JSON.stringify(attemptStatements),
      input.claimId,
      statementSetSha256,
      input.runtime.requestTimeoutMs,
      input.maxAttempts,
      input.runtime.reconcileAfter,
      aaisProductLrsPlatformMaxDurationMs + aaisProductLrsDeliverySafetyMarginMs,
    ],
  );
  const acquiredStudents = new Set(acquired.rows.map((row) => String(row.student_id)));
  if (
    acquiredStudents.size === expected.length
    && expected.every((row) => acquiredStudents.has(row.student_id))
  ) {
    return true;
  }
  await input.database.query(
    `update aais_learner_data_generations
     set lrs_delivery_state = 'idle',
       lrs_delivery_claim_id = null,
       lrs_delivery_started_at = null,
       updated_at = now()
     where lrs_delivery_claim_id = $1::uuid
       and lrs_delivery_state = 'in_flight'`,
    [input.claimId],
  );
  return false;
}

async function releaseAaisOutboxRowsWithoutDelivery(input: {
  database: AaisDatabaseClient;
  rows: MaterializedAaisOutboxRow[];
  claimId: string;
}) {
  const released = await Promise.all(input.rows.map(({ row }) =>
    input.database.query(
      `update aais_lrs_outbox
       set status = 'retry', delivery_claim_id = null, lease_expires_at = null,
         last_error = 'redacted', updated_at = now()
       where id = $1 and delivery_claim_id = $2::uuid and status = 'sending'
       returning id`,
      [row.id, input.claimId],
    )
  ));
  return released.reduce((count, result) => count + result.rows.length, 0);
}

async function finalizeUncertainAaisLrsDeliveryAttempt(input: {
  database: AaisDatabaseClient;
  claimId: string;
  rows: MaterializedAaisOutboxRow[];
}) {
  const claimedStudents = Array.from(new Set(input.rows.map((row) => row.studentId)));
  const result = await input.database.query(
    `with locked_attempt as materialized (
       select attempt.claim_id, attempt.state
       from public.aais_lrs_delivery_attempts attempt
       where attempt.claim_id = $1::uuid
         and attempt.state in ('in_flight', 'uncertain')
       for update
     ), expected_students as materialized (
       select distinct statement.student_id, statement.data_generation
       from public.aais_lrs_delivery_attempt_statements statement
       where statement.claim_id = $1::uuid
     ), locked_generations as materialized (
       select generation.student_id
       from public.aais_learner_data_generations generation
       inner join expected_students expected
         on expected.student_id = generation.student_id
        and expected.data_generation = generation.data_generation
       where generation.lrs_delivery_claim_id = $1::uuid
         and generation.lrs_delivery_state in ('in_flight', 'uncertain')
       for update of generation
     ), updated_attempt as (
       update public.aais_lrs_delivery_attempts attempt
       set state = 'uncertain'
       from locked_attempt
       where attempt.claim_id = locked_attempt.claim_id
         and (select count(*) from locked_generations) =
             (select count(*) from expected_students)
       returning attempt.claim_id
     ), updated_generations as (
       update public.aais_learner_data_generations generation
       set lrs_delivery_state = 'uncertain',
           updated_at = now()
       from expected_students expected, updated_attempt
       where generation.student_id = expected.student_id
         and generation.data_generation = expected.data_generation
         and generation.lrs_delivery_claim_id = updated_attempt.claim_id
         and generation.lrs_delivery_state in ('in_flight', 'uncertain')
       returning generation.student_id
     )
     select student_id from updated_generations`,
    [input.claimId],
  );
  const finalizedStudents = new Set(result.rows.map((row) => String(row.student_id)));
  if (
    finalizedStudents.size !== claimedStudents.length
    || claimedStudents.some((studentId) => !finalizedStudents.has(studentId))
  ) {
    throw new Error("AAIS uncertain LRS delivery attempt could not be fenced.");
  }
}

async function finalizeResolvedAaisLrsDeliveryAttempt(input: {
  database: AaisDatabaseClient;
  claimId: string;
  rows: MaterializedAaisOutboxRow[];
  sentIds: Set<string>;
  failedIds: Set<string>;
  notConfiguredIds: Set<string>;
  deferredIds: Set<string>;
  maxAttempts: number;
}) {
  const outcomes = input.rows.map(({ row }) => {
    const outboxId = String(row.id);
    const matching = [
      input.sentIds.has(outboxId),
      input.failedIds.has(outboxId),
      input.notConfiguredIds.has(outboxId),
      input.deferredIds.has(outboxId),
    ].filter(Boolean).length;
    if (matching !== 1) {
      throw new Error("AAIS LRS delivery result did not cover the frozen claim exactly once.");
    }
    return {
      outbox_id: outboxId,
      disposition: input.sentIds.has(outboxId)
        ? "sent"
        : input.failedIds.has(outboxId) ? "failed" : "not_dispatched",
      deferred: input.deferredIds.has(outboxId),
    };
  });
  const claimedStudents = new Set(input.rows.map((row) => row.studentId));
  const result = await input.database.query(
    `with provided as materialized (
       select candidate.outbox_id, candidate.disposition
       from jsonb_to_recordset($2::jsonb)
         as candidate(outbox_id text, disposition text)
     ), locked_attempt as materialized (
       select attempt.claim_id, attempt.statement_count
       from public.aais_lrs_delivery_attempts attempt
       where attempt.claim_id = $1::uuid
         and attempt.state = 'in_flight'
       for update
     ), expected_statements as materialized (
       select statement.outbox_id, statement.student_id,
              statement.data_generation, statement.statement_id,
              statement.frozen_statement, provided.disposition
       from public.aais_lrs_delivery_attempt_statements statement
       inner join provided on provided.outbox_id = statement.outbox_id
       where statement.claim_id = $1::uuid
         and provided.disposition in ('sent', 'failed', 'not_dispatched')
     ), locked_generations as materialized (
       select generation.student_id
       from public.aais_learner_data_generations generation
       inner join (
         select distinct student_id, data_generation from expected_statements
       ) expected
         on expected.student_id = generation.student_id
        and expected.data_generation = generation.data_generation
       where generation.lrs_delivery_state = 'in_flight'
         and generation.lrs_delivery_claim_id = $1::uuid
       for update of generation
     ), locked_outbox as materialized (
       select outbox.id, outbox.pending_payload, outbox.attempts,
              expected.disposition
       from public.aais_lrs_outbox outbox
       inner join expected_statements expected on expected.outbox_id = outbox.id
       cross join (
         select count(*)::integer as generation_count from locked_generations
       ) generation_lock_barrier
       where generation_lock_barrier.generation_count >= 0
         and outbox.status = 'sending'
         and outbox.delivery_claim_id = $1::uuid
         and outbox.xapi_statement = expected.frozen_statement
         and outbox.xapi_statement->>'id' = expected.statement_id::text
       for update of outbox
     ), valid_transition as materialized (
       select attempt.claim_id, attempt.statement_count
       from locked_attempt attempt
       where attempt.statement_count = (select count(*) from provided)
         and attempt.statement_count = (select count(*) from expected_statements)
         and attempt.statement_count = (select count(*) from locked_outbox)
         and (select count(*) from provided) =
             (select count(distinct outbox_id) from provided)
         and (select count(*) from locked_generations) = (
           select count(*) from (
             select distinct student_id, data_generation from expected_statements
           ) students
         )
     ), updated_outbox as (
       update public.aais_lrs_outbox outbox
       set payload = case
             when locked.disposition = 'sent'
               then coalesce(outbox.pending_payload, outbox.payload)
             else outbox.payload
           end,
           status = case
             when locked.disposition = 'sent' and outbox.pending_payload is null then 'sent'
             when locked.disposition = 'sent' then 'pending'
             when locked.disposition = 'not_dispatched' then 'retry'
             when outbox.attempts + 1 >= $3::integer then 'dead_letter'
             else 'retry'
           end,
           attempts = case
             when locked.disposition = 'sent' and outbox.pending_payload is not null then 0
             when locked.disposition = 'failed' then outbox.attempts + 1
             else outbox.attempts
           end,
           xapi_statement = case
             when locked.disposition = 'sent' and outbox.pending_payload is not null then null
             else outbox.xapi_statement
           end,
           pending_payload = case
             when locked.disposition = 'sent' then null
             else outbox.pending_payload
           end,
           delivery_claim_id = null,
           lease_expires_at = null,
           last_error = case when locked.disposition = 'sent' then null else 'redacted' end,
           updated_at = now()
       from locked_outbox locked, valid_transition valid
       where outbox.id = locked.id
       returning outbox.id, outbox.status, locked.disposition
     ), updated_attempt as (
       update public.aais_lrs_delivery_attempts attempt
       set state = case
             when (select count(*) from updated_outbox where disposition = 'sent') =
                  attempt.statement_count then 'acknowledged'
             when (select count(*) from updated_outbox where disposition = 'failed') =
                  attempt.statement_count then 'rejected'
             when (select count(*) from updated_outbox where disposition = 'not_dispatched') =
                  attempt.statement_count then 'not_dispatched'
             else 'partially_acknowledged'
           end,
           completed_at = now()
       from valid_transition valid
       where attempt.claim_id = valid.claim_id
         and (select count(*) from updated_outbox) = attempt.statement_count
       returning attempt.claim_id, attempt.state
     ), updated_generations as (
       update public.aais_learner_data_generations generation
       set lrs_delivery_state = 'idle',
           lrs_delivery_claim_id = null,
           lrs_delivery_started_at = null,
           updated_at = now()
       from (
         select distinct student_id, data_generation from expected_statements
       ) expected, updated_attempt
       where generation.student_id = expected.student_id
         and generation.data_generation = expected.data_generation
         and generation.lrs_delivery_claim_id = updated_attempt.claim_id
         and generation.lrs_delivery_state = 'in_flight'
       returning generation.student_id
     )
     select updated.id, updated.status, updated.disposition,
            attempt.state as attempt_state,
            (select count(*) from updated_generations)::integer as generation_count
     from updated_outbox updated
     cross join updated_attempt attempt`,
    [input.claimId, JSON.stringify(outcomes), input.maxAttempts],
  );
  if (
    result.rows.length !== input.rows.length
    || Number(result.rows[0]?.generation_count ?? 0) !== claimedStudents.size
  ) {
    throw new Error("AAIS resolved LRS delivery attempt could not be finalized atomically.");
  }
  const rows = result.rows.map((row) => ({
    id: String(row.id),
    status: String(row.status),
    disposition: String(row.disposition),
  }));
  return {
    sent: rows.filter((row) => row.disposition === "sent").length,
    failed: rows.filter((row) => row.disposition === "failed").length,
    deferred: outcomes.filter((row) => row.deferred).length,
    rows,
  };
}

async function deliverMaterializedAaisOutboxRows(input: {
  rows: MaterializedAaisOutboxRow[];
  config?: {
    endpoint: string;
    username: string;
    password: string;
  } | null;
  fetchImpl?: typeof fetch;
  runtime: AaisProductLrsRuntimeBudget;
}): Promise<{
  sentRows: MaterializedAaisOutboxRow[];
  failedRows: MaterializedAaisOutboxRow[];
  uncertainRows: MaterializedAaisOutboxRow[];
  notConfiguredRows: MaterializedAaisOutboxRow[];
  deferredRows: MaterializedAaisOutboxRow[];
  batches: number;
}> {
  if (!input.rows.length) {
    return {
      sentRows: [],
      failedRows: [],
      uncertainRows: [],
      notConfiguredRows: [],
      deferredRows: [],
      batches: 0,
    };
  }
  // A request may start only when its entire provider timeout fits before the
  // dispatch deadline. This is checked at every recursive bisection node, so a
  // fast 400/413/422 tree cannot keep creating HTTP work after the invocation
  // has entered its finalization guard.
  if (!canStartAaisProductLrsRequest(input.runtime)) {
    return {
      sentRows: [],
      failedRows: [],
      uncertainRows: [],
      notConfiguredRows: [],
      deferredRows: input.rows,
      batches: 0,
    };
  }
  let delivery: Awaited<ReturnType<typeof sendAaisXapiStatementsToLrs>> | {
    status: "error";
    sent: 0;
  };
  let acknowledgementUnknown = false;
  try {
    delivery = await sendAaisXapiStatementsToLrs(
      input.rows.map((item) => item.statement),
      {
        config: input.config,
        fetchImpl: input.fetchImpl,
        maxBatchSize: input.rows.length,
        timeoutMs: input.runtime.requestTimeoutMs,
      },
    );
  } catch {
    delivery = { status: "error", sent: 0 };
    acknowledgementUnknown = true;
  }
  if (delivery.status === "sent") {
    return {
      sentRows: input.rows,
      failedRows: [],
      uncertainRows: [],
      notConfiguredRows: [],
      deferredRows: [],
      batches: 1,
    };
  }
  if (delivery.status === "not_configured") {
    return {
      sentRows: [],
      failedRows: [],
      uncertainRows: [],
      notConfiguredRows: input.rows,
      deferredRows: [],
      batches: 0,
    };
  }
  const httpStatus = "httpStatus" in delivery ? Number(delivery.httpStatus) : 0;
  const knownRejection = [400, 401, 403, 404, 405, 413, 415, 422].includes(httpStatus);
  acknowledgementUnknown = !knownRejection;
  const isolatableStatus = "httpStatus" in delivery
    && [400, 413, 422].includes(Number(delivery.httpStatus));
  if (!isolatableStatus || input.rows.length === 1) {
    return {
      sentRows: [],
      failedRows: acknowledgementUnknown ? [] : input.rows,
      uncertainRows: acknowledgementUnknown ? input.rows : [],
      notConfiguredRows: [],
      deferredRows: [],
      batches: 1,
    };
  }

  const midpoint = Math.ceil(input.rows.length / 2);
  const left = await deliverMaterializedAaisOutboxRows({
    ...input,
    rows: input.rows.slice(0, midpoint),
  });
  if (left.uncertainRows.length) {
    return {
      sentRows: [],
      failedRows: [],
      uncertainRows: input.rows,
      notConfiguredRows: [],
      deferredRows: [],
      batches: 1 + left.batches,
    };
  }
  if (left.notConfiguredRows.length) {
    return {
      sentRows: left.sentRows,
      failedRows: left.failedRows,
      uncertainRows: [],
      notConfiguredRows: [
        ...left.notConfiguredRows,
        ...input.rows.slice(midpoint),
      ],
      deferredRows: left.deferredRows,
      batches: 1 + left.batches,
    };
  }
  if (left.deferredRows.length) {
    return {
      sentRows: left.sentRows,
      failedRows: left.failedRows,
      uncertainRows: [],
      notConfiguredRows: [],
      deferredRows: [
        ...left.deferredRows,
        ...input.rows.slice(midpoint),
      ],
      batches: 1 + left.batches,
    };
  }
  const right = await deliverMaterializedAaisOutboxRows({
    ...input,
    rows: input.rows.slice(midpoint),
  });
  if (right.uncertainRows.length) {
    return {
      sentRows: [],
      failedRows: [],
      uncertainRows: input.rows,
      notConfiguredRows: [],
      deferredRows: [],
      batches: 1 + left.batches + right.batches,
    };
  }
  return {
    sentRows: [...left.sentRows, ...right.sentRows],
    failedRows: [...left.failedRows, ...right.failedRows],
    uncertainRows: [...left.uncertainRows, ...right.uncertainRows],
    notConfiguredRows: [...left.notConfiguredRows, ...right.notConfiguredRows],
    deferredRows: [...left.deferredRows, ...right.deferredRows],
    batches: 1 + left.batches + right.batches,
  };
}

async function markAaisOutboxRowsFailed(input: {
  database: AaisDatabaseClient;
  rows: Array<Record<string, unknown>>;
  claimId: string;
  maxAttempts: number;
}) {
  const results = await Promise.all(input.rows.map((row) => {
    const attempts = Number(row.attempts ?? 0) + 1;
    const status = attempts >= input.maxAttempts ? "dead_letter" : "retry";
    return input.database.query(
      `update aais_lrs_outbox
       set status = $1, attempts = attempts + 1, last_error = 'redacted',
         delivery_claim_id = null, lease_expires_at = null, updated_at = now()
       where id = $2 and delivery_claim_id = $3::uuid and status = 'sending'
       returning id`,
      [status, row.id, input.claimId],
    );
  }));
  return results.reduce((count, result) => count + result.rows.length, 0);
}

export async function requeueAaisPersistentLrsDeadLetters(input: {
  database?: AaisDatabaseClient;
  limit?: number;
} = {}) {
  if (requiresAaisResearchDataPlaneIsolation()) {
    return {
      status: "not_configured" as const,
      requeued: 0,
      secrets: "redacted" as const,
    };
  }
  const database = input.database ?? getConfiguredDatabaseClient();
  if (!database) {
    return {
      status: "not_configured" as const,
      requeued: 0,
      secrets: "redacted" as const,
    };
  }
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
  if (requiresAaisResearchDataPlaneIsolation()) {
    return {
      mode: "research-isolated" as const,
      storage: "disabled" as const,
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
  const result = await database.query(
    "select status, count(*)::int as count from aais_lrs_outbox group by status",
  );
  const counts = Object.fromEntries(
    result.rows.map((row) => [String(row.status), Number(row.count ?? 0)]),
  );
  const pending = (counts.pending ?? 0) + (counts.sending ?? 0);
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

function createAtomicLearnerMutationStatement(input: {
  session: AaisLearnerSession;
  events: AaisEvent[];
  budgetReservationId?: string;
  educatorAccess?: AaisEducatorCohortAccess;
}): AaisDatabaseStatement {
  const { session, events } = input;
  const taskRows = session.tasks.map((task) => ({
    task: task.taskId,
    phase: task.phase,
    status: task.status,
    artifact_characters: task.artifactText.length,
    self_report_characters: task.selfReport.length,
    scaffold_requests: task.scaffoldRequests,
    updated_at: session.updatedAt,
  }));
  const uniqueEvents = Array.from(events.reduce((rows, event, ordinal) => {
    const id = createAaisEventRowId(event);
    if (!rows.has(id)) {
      rows.set(id, { id, event, ordinal });
    }
    return rows;
  }, new Map<string, { id: string; event: AaisEvent; ordinal: number }>()).values());
  const eventRows = uniqueEvents.map(({ id, event }) => ({
    id,
    student_id: event.student_id,
    session_id: event.session_id,
    phase: event.phase,
    task: event.task,
    agent: event.agent,
    event: event.event,
    event_time: event.time,
    detail: event.detail,
  }));
  const outboxRows = uniqueEvents.map(({ id: sourceEventId, event, ordinal }) => ({
    id: createAaisLrsOutboxId(event),
    source_event_id: sourceEventId,
    ordinal,
    coalescible: isCoalescibleLrsEvent(event),
    payload: event,
  }));

  return {
    sql: `with generation_guard as materialized (
      select data_generation
      from aais_learner_data_generations
      where student_id = $1
        and data_generation = $10::bigint
      for update
    ), educator_guard as materialized (
      select 1
      from aais_enrollments learner
      inner join aais_enrollments educator
        on educator.course_id = learner.course_id
       and educator.cohort = learner.cohort
      where $11::text is not null
        and learner.user_id = $1
        and learner.role = 'student'
        and learner.status = 'active'
        and 1 = (
          select count(*)
          from aais_enrollments learner_scope
          where learner_scope.user_id = $1
            and learner_scope.role = 'student'
            and learner_scope.status = 'active'
        )
        and educator.user_id = $11
        and educator.role = $12
        and educator.status = 'active'
      for share of learner, educator
    ), session_insert as (
      insert into aais_learner_sessions (student_id, payload, version, updated_at)
      select $1, $2::jsonb, 0, now()
      from generation_guard
      where $3::integer is null
        and ($11::text is null or exists (select 1 from educator_guard))
        and (
          $9::uuid is null
          or exists (
            select 1
            from aais_ai_guide_reservations reservation
            where reservation.id = $9::uuid
              and reservation.student_id = $1
              and (
                reservation.state = 'dispatched'
                or (
                  reservation.state = 'reserved'
                  and reservation.expires_at > now()
                )
              )
            for update
          )
        )
      on conflict (student_id) do nothing
      returning version
    ),
    session_update as (
      update aais_learner_sessions
      set payload = $2::jsonb, version = version + 1, updated_at = now()
      where student_id = $1
        and $3::integer is not null
        and version = $3::integer
        and exists (select 1 from generation_guard)
        and ($11::text is null or exists (select 1 from educator_guard))
        and (
          $9::uuid is null
          or exists (
            select 1
            from aais_ai_guide_reservations reservation
            where reservation.id = $9::uuid
              and reservation.student_id = $1
              and (
                reservation.state = 'dispatched'
                or (
                  reservation.state = 'reserved'
                  and reservation.expires_at > now()
                )
              )
            for update
          )
        )
      returning version
    ),
    committed_version as materialized (
      select version from session_insert
      union all
      select version from session_update
    ),
    completed_guide_reservation as (
      update aais_ai_guide_reservations reservation
      set state = 'completed', finalized_at = now()
      from committed_version
      where $9::uuid is not null
        and reservation.id = $9::uuid
        and reservation.student_id = $1
        and (
          reservation.state = 'dispatched'
          or (
            reservation.state = 'reserved'
            and reservation.expires_at > now()
          )
        )
      returning reservation.id
    ),
    task_input as materialized (
      select *
      from jsonb_to_recordset($4::jsonb) as task_row (
        task text,
        phase text,
        status text,
        artifact_characters integer,
        self_report_characters integer,
        scaffold_requests integer,
        updated_at timestamptz
      )
    ),
    written_tasks as (
      insert into aais_learner_task_state (
        student_id,
        session_id,
        task,
        phase,
        status,
        artifact_characters,
        self_report_characters,
        scaffold_requests,
        updated_at
      )
      select
        $1,
        $2::jsonb->>'sessionId',
        task_row.task,
        task_row.phase,
        task_row.status,
        task_row.artifact_characters,
        task_row.self_report_characters,
        task_row.scaffold_requests,
        task_row.updated_at
      from task_input task_row
      cross join committed_version
      on conflict (student_id, task)
      do update set
        session_id = excluded.session_id,
        phase = excluded.phase,
        status = excluded.status,
        artifact_characters = excluded.artifact_characters,
        self_report_characters = excluded.self_report_characters,
        scaffold_requests = excluded.scaffold_requests,
        updated_at = excluded.updated_at
      returning 1
    ),
    event_input as materialized (
      select *
      from jsonb_to_recordset($5::jsonb) as event_row (
        id text,
        student_id text,
        session_id text,
        phase text,
        task text,
        agent text,
        event text,
        event_time timestamptz,
        detail jsonb
      )
    ),
    written_events as (
      insert into aais_events (
        id,
        student_id,
        session_id,
        phase,
        task,
        agent,
        event,
        event_time,
        detail
      )
      select
        event_row.id,
        event_row.student_id,
        event_row.session_id,
        event_row.phase,
        event_row.task,
        event_row.agent,
        event_row.event,
        event_row.event_time,
        event_row.detail
      from event_input event_row
      cross join committed_version
      on conflict do nothing
      returning id
    ),
    outbox_fact_input as materialized (
      select *
      from jsonb_to_recordset($6::jsonb) as outbox_row (
        id text,
        source_event_id text,
        ordinal integer,
        coalescible boolean,
        payload jsonb
      )
    ),
    new_outbox_facts as materialized (
      select outbox_row.*
      from outbox_fact_input outbox_row
      join written_events written_event
        on written_event.id = outbox_row.source_event_id
    ),
    ranked_outbox_facts as materialized (
      select
        outbox_row.*,
        row_number() over (
          partition by outbox_row.id
          order by outbox_row.ordinal desc
        ) as latest_rank,
        count(*) over (partition by outbox_row.id) as delta_count
      from new_outbox_facts outbox_row
    ),
    outbox_input as materialized (
      select
        id,
        case
          when coalescible then
            jsonb_set(
              payload,
              '{detail}',
              coalesce(payload->'detail', '{}'::jsonb)
              || jsonb_build_object(
                'merged_events', delta_count,
                'coalescing_window_seconds', $8::integer
              )
            )
          else payload
        end as payload
      from ranked_outbox_facts
      where latest_rank = 1
    ),
    written_outbox as (
      insert into aais_lrs_outbox (id, payload, status, attempts, last_error, updated_at)
      select outbox_row.id, outbox_row.payload, 'pending', 0, null, now()
      from outbox_input outbox_row
      cross join committed_version
      on conflict (id)
      do update set
        xapi_statement = case
          when aais_lrs_outbox.status in ('sending', 'retry', 'dead_letter') then
            aais_lrs_outbox.xapi_statement
          else null
        end,
        payload = case
          when aais_lrs_outbox.status in ('sending', 'retry', 'dead_letter') then
            aais_lrs_outbox.payload
          when excluded.payload->>'event' = any($7::text[]) then
            jsonb_set(
              excluded.payload,
              '{detail}',
              coalesce(excluded.payload->'detail', '{}'::jsonb)
              || jsonb_build_object(
                'merged_events',
                (
                  case
                    when aais_lrs_outbox.status = 'pending'
                      and coalesce(aais_lrs_outbox.payload #>> '{detail,merged_events}', '') ~ '^[0-9]+$'
                    then (aais_lrs_outbox.payload #>> '{detail,merged_events}')::integer
                    else 0
                  end
                ) + (
                  case
                    when coalesce(excluded.payload #>> '{detail,merged_events}', '') ~ '^[0-9]+$'
                    then (excluded.payload #>> '{detail,merged_events}')::integer
                    else 1
                  end
                ),
                'coalescing_window_seconds', $8::integer
              )
            )
          else excluded.payload
        end,
        pending_payload = case
          when aais_lrs_outbox.status in ('sending', 'retry', 'dead_letter')
            and excluded.payload->>'event' = any($7::text[]) then
            jsonb_set(
              excluded.payload,
              '{detail}',
              coalesce(excluded.payload->'detail', '{}'::jsonb)
              || jsonb_build_object(
                'merged_events',
                (
                  case
                    when coalesce(aais_lrs_outbox.pending_payload #>> '{detail,merged_events}', '') ~ '^[0-9]+$'
                    then (aais_lrs_outbox.pending_payload #>> '{detail,merged_events}')::integer
                    else 0
                  end
                ) + (
                  case
                    when coalesce(excluded.payload #>> '{detail,merged_events}', '') ~ '^[0-9]+$'
                    then (excluded.payload #>> '{detail,merged_events}')::integer
                    else 1
                  end
                ),
                'coalescing_window_seconds', $8::integer
              )
            )
          when aais_lrs_outbox.status in ('sending', 'retry', 'dead_letter') then
            aais_lrs_outbox.pending_payload
          else null
        end,
        status = case
          when aais_lrs_outbox.status = 'dead_letter' then 'retry'
          when aais_lrs_outbox.status in ('sending', 'retry') then aais_lrs_outbox.status
          else 'pending'
        end,
        attempts = case
          when aais_lrs_outbox.status in ('sending', 'retry', 'dead_letter') then aais_lrs_outbox.attempts
          else 0
        end,
        last_error = case
          when aais_lrs_outbox.status in ('sending', 'retry', 'dead_letter') then aais_lrs_outbox.last_error
          else null
        end,
        delivery_claim_id = case
          when aais_lrs_outbox.status = 'sending' then aais_lrs_outbox.delivery_claim_id
          else null
        end,
        lease_expires_at = case
          when aais_lrs_outbox.status = 'sending' then aais_lrs_outbox.lease_expires_at
          else null
        end,
        updated_at = now()
      returning 1
    )
    select
      committed_version.version,
      (select count(*)::integer from written_tasks) as task_count,
      (select count(*)::integer from written_events) as event_count,
      (select count(*)::integer from written_outbox) as outbox_count,
      (select count(*)::integer from completed_guide_reservation) as completed_reservation_count,
      1 / case
        when $9::uuid is null
          or (select count(*) from completed_guide_reservation) = 1
        then 1
        else 0
      end as reservation_guard
    from committed_version`,
    params: [
      session.studentId,
      JSON.stringify(session),
      getSessionStorageVersion(session),
      JSON.stringify(taskRows),
      JSON.stringify(eventRows),
      JSON.stringify(outboxRows),
      [...aaisLrsOutboxCoalescingPolicy.events],
      aaisLrsOutboxCoalescingPolicy.windowSeconds,
      input.budgetReservationId ?? null,
      session.dataGeneration,
      input.educatorAccess?.actorId ?? null,
      input.educatorAccess?.actorRole ?? null,
    ],
  };
}

function createAaisEventRowId(event: AaisEvent) {
  return createHash("sha256")
    .update(JSON.stringify([
      event.student_id,
      event.session_id,
      event.phase,
      event.task,
      event.agent,
      event.event,
      event.time,
      event.detail,
    ]))
    .digest("hex")
    .slice(0, 32);
}

function createAaisMutationKey(mutationId: string) {
  return createHash("sha256")
    .update(`aais-learner-mutation:${mutationId}`)
    .digest("hex")
    .slice(0, 32);
}

function createAaisMutationPayloadHash(input: {
  activeDocumentId?: string | null;
  documentTitle?: string;
  taskId: string;
  field: "artifactText" | "selfReport";
  value: string;
}) {
  return createHash("sha256")
    .update(JSON.stringify([
      input.taskId,
      input.field,
      input.value,
      input.documentTitle,
      input.activeDocumentId,
    ]))
    .digest("hex");
}

function createAaisArchiveMutationPayloadHash(input: {
  activeDocumentId: string | null;
  document: AaisHistoryDocumentRecord | null;
  expectedArtifactRevision: number | undefined;
  taskId: string;
}) {
  return createHash("sha256")
    .update(JSON.stringify([
      input.taskId,
      "archiveArtifact",
      input.activeDocumentId,
      input.document,
      input.expectedArtifactRevision,
    ]))
    .digest("hex");
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
      ...(isCoalescibleLrsEvent(event) ? [] : [event.detail]),
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

function normalizeFrozenAaisXapiStatement(value: unknown): AaisXapiStatement {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (
    typeof parsed !== "object"
    || parsed === null
    || !("id" in parsed)
    || typeof parsed.id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(parsed.id)
    || !("actor" in parsed)
    || typeof parsed.actor !== "object"
    || parsed.actor === null
    || !("verb" in parsed)
    || typeof parsed.verb !== "object"
    || parsed.verb === null
    || !("object" in parsed)
    || typeof parsed.object !== "object"
    || parsed.object === null
    || !("context" in parsed)
    || typeof parsed.context !== "object"
    || parsed.context === null
    || !("timestamp" in parsed)
    || typeof parsed.timestamp !== "string"
  ) {
    throw new Error("Invalid frozen AAIS xAPI statement.");
  }
  return parsed as AaisXapiStatement;
}

function sha256CanonicalJson(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeJsonValue(value)), "utf8")
    .digest("hex");
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalizeJsonValue(nested)]),
  );
}

function requireAaisLrsReconciliationActorId(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error("Invalid AAIS LRS reconciliation actor.");
  }
  return value;
}

function requireAaisLrsReconciliationUuid(value: unknown, label: string) {
  if (
    typeof value !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
  ) {
    throw new Error(`Invalid AAIS LRS reconciliation ${label}.`);
  }
  return value.toLowerCase();
}

function requireAaisLrsReconciliationEvidence(
  value: unknown,
  reconciledAt: Date,
): AaisLrsDeliveryReconciliationEvidence {
  if (
    !isAaisLrsPlainRecord(value)
    || Object.keys(value).length !== 2
    || !Object.hasOwn(value, "observedAt")
    || !Object.hasOwn(value, "statements")
    || typeof value.observedAt !== "string"
    || !Array.isArray(value.statements)
    || value.statements.length < 1
    || value.statements.length > 50
  ) {
    throw new Error("Invalid AAIS LRS reconciliation evidence.");
  }
  const observedAt = new Date(value.observedAt);
  if (
    !Number.isFinite(observedAt.getTime())
    || observedAt.toISOString() !== value.observedAt
    || observedAt.getTime() > reconciledAt.getTime()
  ) {
    throw new Error("Invalid AAIS LRS reconciliation observation time.");
  }
  const seen = new Set<string>();
  const statements = value.statements.map((statement) => {
    if (
      !isAaisLrsPlainRecord(statement)
      || Object.keys(statement).length !== 2
      || !Object.hasOwn(statement, "statementId")
      || !Object.hasOwn(statement, "status")
      || (statement.status !== "stored" && statement.status !== "absent")
    ) {
      throw new Error("Invalid AAIS LRS statement reconciliation evidence.");
    }
    const statementId = requireAaisLrsReconciliationUuid(
      statement.statementId,
      "statement id",
    );
    if (seen.has(statementId)) {
      throw new Error("Duplicate AAIS LRS statement reconciliation evidence.");
    }
    seen.add(statementId);
    return {
      statementId,
      status: statement.status as AaisLrsDeliveryReconciliationStatus,
    };
  });
  return {
    observedAt: value.observedAt,
    statements,
  };
}

function parseAaisLrsReconciliationResult(
  row: Record<string, unknown>,
  claimId: string,
): AaisLrsDeliveryReconciliationResult {
  const result = row.result;
  const statementCount = Number(row.statement_count);
  const stored = Number(row.stored_count);
  const absent = Number(row.absent_count);
  const reconciledAt = new Date(String(row.reconciled_at ?? ""));
  if (
    String(row.claim_id ?? "").toLowerCase() !== claimId
    || (result !== "stored" && result !== "absent" && result !== "mixed")
    || !Number.isSafeInteger(statementCount)
    || statementCount < 1
    || statementCount > 50
    || !Number.isSafeInteger(stored)
    || !Number.isSafeInteger(absent)
    || stored < 0
    || absent < 0
    || stored + absent !== statementCount
    || !Number.isFinite(reconciledAt.getTime())
  ) {
    throw new AaisLrsDeliveryReconciliationConflictError();
  }
  return {
    claimId,
    status: "reconciled",
    result,
    statementCount,
    stored,
    absent,
    reconciledAt: reconciledAt.toISOString(),
    privacyFence: "idle",
    secrets: "redacted",
  };
}

function parseAaisPendingLrsDeliveryAttempt(
  row: Record<string, unknown>,
): AaisPendingLrsDeliveryAttempt {
  const claimId = requireAaisLrsReconciliationUuid(row.claim_id, "claim id");
  const state = row.state;
  const startedAt = new Date(String(row.started_at ?? ""));
  const reconcileAfter = new Date(String(row.reconcile_after ?? ""));
  const statementCount = Number(row.statement_count);
  if (
    (state !== "in_flight" && state !== "uncertain")
    || !Number.isFinite(startedAt.getTime())
    || !Number.isFinite(reconcileAfter.getTime())
    || reconcileAfter.getTime() <= startedAt.getTime()
    || !Number.isSafeInteger(statementCount)
    || statementCount < 1
    || statementCount > 50
    || !Array.isArray(row.statement_ids)
    || row.statement_ids.length !== statementCount
  ) {
    throw new Error("Invalid AAIS pending LRS delivery attempt row.");
  }
  const statementIds = row.statement_ids
    .map((statementId) => requireAaisLrsReconciliationUuid(statementId, "statement id"))
    .sort((left, right) => left.localeCompare(right));
  if (new Set(statementIds).size !== statementIds.length) {
    throw new Error("Invalid AAIS pending LRS delivery attempt statement set.");
  }
  return {
    claimId,
    state,
    startedAt: startedAt.toISOString(),
    reconcileAfter: reconcileAfter.toISOString(),
    statementCount,
    statementIds,
  };
}

function isAaisLrsPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isAaisLrsReconciliationSchemaDatabaseError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }
  return ["42P01", "42703", "42883"].includes(
    String((error as { code?: unknown }).code ?? ""),
  );
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

function takeNewest<T>(values: T[], limit: number) {
  return values.length <= limit ? [...values] : values.slice(values.length - limit);
}

function createSessionWindowMetadata(total: number, returned: number, limit: number) {
  return {
    limit,
    total,
    returned,
    omitted: Math.max(0, total - returned),
    truncated: returned < total,
  };
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
  if (requiresAaisDurableStorage() && !getAaisDatabaseConfiguration()) {
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
    const tableCheck = await database.query(
      `select
         to_regclass('public.aais_learner_sessions') as learner_sessions_table,
         to_regclass('public.aais_learner_data_generations') as learner_data_generations_table,
         (
           select count(*) = 3
             from information_schema.columns
            where table_schema = 'public'
              and table_name = 'aais_learner_data_generations'
              and (
                (column_name = 'lrs_delivery_state' and data_type = 'text' and is_nullable = 'NO')
                or (column_name = 'lrs_delivery_claim_id' and data_type = 'uuid')
                or (
                  column_name = 'lrs_delivery_started_at'
                  and data_type = 'timestamp with time zone'
                )
              )
         ) as learner_lrs_delivery_fence_columns,
         not exists (
           select 1
           from aais_learner_sessions session
           left join aais_learner_data_generations generation
             on generation.student_id = session.student_id
           where case
             when jsonb_typeof(session.payload->'dataGeneration') = 'number'
               and (session.payload->>'dataGeneration') ~ '^[1-9][0-9]*$'
             then (session.payload->>'dataGeneration')::numeric = generation.data_generation
             else false
           end is not true
         ) as learner_session_generation_compatible,
         to_regclass('public.aais_learner_task_state') as learner_task_state_table,
         to_regclass('public.aais_lrs_outbox') as lrs_outbox_table,
         (
           select count(*) = 4
             from information_schema.columns
            where table_schema = 'public'
              and table_name = 'aais_lrs_outbox'
              and column_name in ('delivery_claim_id', 'lease_expires_at', 'pending_payload', 'xapi_statement')
         ) as lrs_outbox_claim_columns,
         to_regclass('public.aais_lrs_delivery_attempts') as lrs_delivery_attempts_table,
         to_regclass('public.aais_lrs_delivery_attempt_statements')
           as lrs_delivery_attempt_statements_table,
         (
           select count(*) = 16
             and count(*) filter (where
               (column_name = 'claim_id' and data_type = 'uuid' and is_nullable = 'NO')
               or (column_name = 'state' and data_type = 'text' and is_nullable = 'NO')
               or (column_name = 'statement_count' and data_type = 'integer' and is_nullable = 'NO')
               or (column_name = 'statement_set_sha256' and data_type = 'text' and is_nullable = 'NO')
               or (column_name = 'started_at' and data_type = 'timestamp with time zone' and is_nullable = 'NO')
               or (column_name = 'request_timeout_ms' and data_type = 'integer' and is_nullable = 'NO')
               or (column_name = 'max_attempts' and data_type = 'integer' and is_nullable = 'NO')
               or (column_name = 'reconcile_after' and data_type = 'timestamp with time zone' and is_nullable = 'NO')
               or (column_name = 'completed_at' and data_type = 'timestamp with time zone' and is_nullable = 'YES')
               or (column_name = 'reconciliation_result' and data_type = 'text' and is_nullable = 'YES')
               or (column_name = 'reconciliation_evidence_sha256' and data_type = 'text' and is_nullable = 'YES')
               or (column_name = 'reconciliation_observed_at' and data_type = 'timestamp with time zone' and is_nullable = 'YES')
               or (column_name = 'reconciled_at' and data_type = 'timestamp with time zone' and is_nullable = 'YES')
               or (column_name = 'reconciled_by' and data_type = 'text' and is_nullable = 'YES')
               or (column_name = 'stored_count' and data_type = 'integer' and is_nullable = 'YES')
               or (column_name = 'absent_count' and data_type = 'integer' and is_nullable = 'YES')
             ) = 16
           from information_schema.columns
           where table_schema = 'public'
             and table_name = 'aais_lrs_delivery_attempts'
         ) as lrs_delivery_attempt_columns,
         (
           select count(*) = 8
             and count(*) filter (where
               (column_name = 'claim_id' and data_type = 'uuid' and is_nullable = 'NO')
               or (column_name = 'outbox_id' and data_type = 'text' and is_nullable = 'NO')
               or (column_name = 'student_id' and data_type = 'text' and is_nullable = 'NO')
               or (column_name = 'data_generation' and data_type = 'bigint' and is_nullable = 'NO')
               or (column_name = 'statement_id' and data_type = 'uuid' and is_nullable = 'NO')
               or (column_name = 'statement_sha256' and data_type = 'text' and is_nullable = 'NO')
               or (column_name = 'frozen_statement' and data_type = 'jsonb' and is_nullable = 'NO')
               or (column_name = 'reconciliation_status' and data_type = 'text' and is_nullable = 'YES')
             ) = 8
           from information_schema.columns
           where table_schema = 'public'
             and table_name = 'aais_lrs_delivery_attempt_statements'
         ) as lrs_delivery_attempt_statement_columns,
         (
           select count(*) = 11
           from pg_constraint constraint_row
           where constraint_row.conname in (
             'aais_lrs_delivery_attempts_pkey',
             'aais_lrs_delivery_attempts_state_check',
             'aais_lrs_delivery_attempts_snapshot_check',
             'aais_lrs_delivery_attempts_completion_check',
             'aais_lrs_delivery_attempts_reconciliation_check',
             'aais_lrs_delivery_attempt_statements_pkey',
             'aais_lrs_delivery_attempt_statements_attempt_fkey',
             'aais_lrs_delivery_attempt_statements_outbox_fkey',
             'aais_lrs_delivery_attempt_statements_identity_key',
             'aais_lrs_delivery_attempt_statements_snapshot_check',
             'aais_lrs_delivery_attempt_statements_reconciliation_check'
           )
             and constraint_row.conrelid in (
               'public.aais_lrs_delivery_attempts'::regclass,
               'public.aais_lrs_delivery_attempt_statements'::regclass
             )
             and (
               constraint_row.contype <> 'f'
               or constraint_row.confdeltype = 'c'
             )
         ) as lrs_delivery_reconciliation_constraints,
         to_regclass('public.aais_lrs_delivery_attempts_reconciliation_idx')
           as lrs_delivery_reconciliation_index,
         to_regclass('public.aais_lrs_delivery_attempt_statements_student_idx')
           as lrs_delivery_attempt_student_index,
         not exists (
           select 1
           from public.aais_learner_data_generations generation
           where generation.lrs_delivery_state <> 'idle'
             and not exists (
               select 1
               from public.aais_lrs_delivery_attempts attempt
               join public.aais_lrs_delivery_attempt_statements statement
                 on statement.claim_id = attempt.claim_id
                and statement.student_id = generation.student_id
                and statement.data_generation = generation.data_generation
               where attempt.claim_id = generation.lrs_delivery_claim_id
                 and attempt.state in ('in_flight', 'uncertain')
             )
         )
         and not exists (
           select 1
           from public.aais_lrs_delivery_attempts attempt
           where attempt.state in ('in_flight', 'uncertain')
             and (
               attempt.statement_count <> (
                 select count(*)
                 from public.aais_lrs_delivery_attempt_statements statement
                 where statement.claim_id = attempt.claim_id
               )
               or exists (
                 select 1
                 from public.aais_lrs_delivery_attempt_statements statement
                 left join public.aais_lrs_outbox outbox
                   on outbox.id = statement.outbox_id
                  and outbox.status = 'sending'
                  and outbox.delivery_claim_id = attempt.claim_id
                  and outbox.xapi_statement = statement.frozen_statement
                 left join public.aais_learner_data_generations generation
                   on generation.student_id = statement.student_id
                  and generation.data_generation = statement.data_generation
                  and generation.lrs_delivery_claim_id = attempt.claim_id
                  and generation.lrs_delivery_state in ('in_flight', 'uncertain')
                 where statement.claim_id = attempt.claim_id
                   and (outbox.id is null or generation.student_id is null)
               )
             )
         ) as lrs_delivery_attempts_consistent,
         not exists (
           select 1
           from public.aais_lrs_delivery_attempts attempt
           where attempt.state in ('in_flight', 'uncertain')
             and attempt.reconcile_after <= clock_timestamp()
         ) as lrs_delivery_reconciliation_clear,
         to_regclass('public.aais_login_rate_limits') as login_rate_limits_table,
         exists (
           select 1
             from information_schema.columns
            where table_schema = 'public'
              and table_name = 'aais_login_rate_limits'
              and column_name = 'expires_at'
              and data_type = 'timestamp with time zone'
              and is_nullable = 'NO'
         ) as login_rate_limits_expires_column,
         exists (
           select 1
             from pg_indexes
            where schemaname = 'public'
              and indexname = 'aais_login_rate_limits_expires_idx'
              and indexdef ilike '%(expires_at, rate_limit_key)%'
         ) as login_rate_limits_expires_index,
         to_regclass('public.aais_events') as events_table,
         to_regclass('public.aais_ai_guide_daily_usage') as ai_guide_daily_usage_table,
         to_regclass('public.aais_ai_guide_reservations') as ai_guide_reservations_table,
         exists (
           select 1
             from information_schema.columns
            where table_schema = 'public'
              and table_name = 'aais_ai_guide_reservations'
              and column_name = 'expires_at'
              and data_type = 'timestamp with time zone'
              and is_nullable = 'NO'
         ) as ai_guide_reservation_lease_column,
         exists (
           select 1
             from pg_constraint reservation_constraint
            where reservation_constraint.conrelid =
                  'public.aais_ai_guide_reservations'::regclass
              and reservation_constraint.conname =
                  'aais_ai_guide_reservations_state_check'
              and reservation_constraint.contype = 'c'
              and position(
                '''dispatched''' in pg_get_constraintdef(reservation_constraint.oid)
              ) > 0
         ) as ai_guide_reservation_dispatch_state_constraint,
         exists (
           select 1
             from pg_constraint reservation_constraint
            where reservation_constraint.conrelid =
                  'public.aais_ai_guide_reservations'::regclass
              and reservation_constraint.conname =
                  'aais_ai_guide_reservations_finalized_check'
              and reservation_constraint.contype = 'c'
              and position(
                '''dispatched''' in pg_get_constraintdef(reservation_constraint.oid)
              ) > 0
              and position(
                'finalized_at' in pg_get_constraintdef(reservation_constraint.oid)
              ) > 0
         ) as ai_guide_reservation_dispatch_finalized_constraint,
         exists (
           select 1
             from pg_proc proc
             join pg_namespace namespace on namespace.oid = proc.pronamespace
            where proc.oid = to_regprocedure(
              'public.aais_reserve_ai_guide_request(text,date,timestamp with time zone,integer,uuid,bigint,integer)'
            )
              and namespace.nspname = 'public'
              and proc.provolatile = 'v'
              and proc.prosecdef = false
         ) as ai_guide_reservation_function,
         exists (
           select 1
             from pg_proc proc
             join pg_namespace namespace on namespace.oid = proc.pronamespace
            where proc.oid = to_regprocedure(
              'public.aais_delete_learner_data(text,bigint,timestamp with time zone)'
            )
              and namespace.nspname = 'public'
              and proc.provolatile = 'v'
              and proc.prosecdef = false
         ) as learner_data_delete_function,
         to_regclass('public.aais_users') as users_table,
         exists (
           select 1
             from information_schema.columns
            where table_schema = 'public'
              and table_name = 'aais_users'
              and column_name = 'auth_version'
         ) as users_auth_version_column,
         to_regclass('public.aais_active_admin_invariant_lock') as active_admin_invariant_lock_table,
         exists (
           select 1
             from pg_trigger user_trigger
             join pg_class user_table on user_table.oid = user_trigger.tgrelid
             join pg_namespace user_schema on user_schema.oid = user_table.relnamespace
             join pg_proc trigger_function on trigger_function.oid = user_trigger.tgfoid
            where user_schema.nspname = 'public'
              and user_table.relname = 'aais_users'
              and user_trigger.tgname = 'aais_users_active_admin_update_guard'
              and user_trigger.tgisinternal = false
              and user_trigger.tgenabled <> 'D'
              and (user_trigger.tgtype & 1) = 0
              and (user_trigger.tgtype & 2) = 0
              and (user_trigger.tgtype & 16) = 16
              and user_trigger.tgoldtable = 'old_accounts'
              and user_trigger.tgnewtable = 'new_accounts'
              and trigger_function.proname = 'aais_enforce_active_admin_after_update'
              and trigger_function.provolatile = 'v'
              and trigger_function.prosecdef = false
         ) as active_admin_update_trigger,
         exists (
           select 1
             from pg_trigger user_trigger
             join pg_class user_table on user_table.oid = user_trigger.tgrelid
             join pg_namespace user_schema on user_schema.oid = user_table.relnamespace
             join pg_proc trigger_function on trigger_function.oid = user_trigger.tgfoid
            where user_schema.nspname = 'public'
              and user_table.relname = 'aais_users'
              and user_trigger.tgname = 'aais_users_active_admin_delete_guard'
              and user_trigger.tgisinternal = false
              and user_trigger.tgenabled <> 'D'
              and (user_trigger.tgtype & 1) = 0
              and (user_trigger.tgtype & 2) = 0
              and (user_trigger.tgtype & 8) = 8
              and user_trigger.tgoldtable = 'old_accounts'
              and user_trigger.tgnewtable is null
              and trigger_function.proname = 'aais_enforce_active_admin_after_delete'
              and trigger_function.provolatile = 'v'
              and trigger_function.prosecdef = false
         ) as active_admin_delete_trigger,
         to_regclass('public.aais_user_auth_tokens') as user_auth_tokens_table,
         to_regclass('public.aais_session_revocations') as session_revocations_table,
         to_regclass('public.aais_courses') as courses_table,
         to_regclass('public.aais_course_tasks') as course_tasks_table,
         to_regclass('public.aais_enrollments') as enrollments_table,
         to_regclass('public.aais_enrollments_user_scope_idx') as enrollment_scope_index`,
    );
    await database.query("select 1 as ok");
    const row = tableCheck.rows[0];
    if (
      row?.learner_sessions_table !== "aais_learner_sessions"
      || row?.learner_data_generations_table !== "aais_learner_data_generations"
      || row?.learner_lrs_delivery_fence_columns !== true
      || row?.learner_session_generation_compatible !== true
      || row?.learner_task_state_table !== "aais_learner_task_state"
      || row?.lrs_outbox_table !== "aais_lrs_outbox"
      || row?.lrs_outbox_claim_columns !== true
      || row?.lrs_delivery_attempts_table !== "aais_lrs_delivery_attempts"
      || row?.lrs_delivery_attempt_statements_table !== "aais_lrs_delivery_attempt_statements"
      || row?.lrs_delivery_attempt_columns !== true
      || row?.lrs_delivery_attempt_statement_columns !== true
      || row?.lrs_delivery_reconciliation_constraints !== true
      || row?.lrs_delivery_reconciliation_index !== "aais_lrs_delivery_attempts_reconciliation_idx"
      || row?.lrs_delivery_attempt_student_index !== "aais_lrs_delivery_attempt_statements_student_idx"
      || row?.lrs_delivery_attempts_consistent !== true
      || row?.lrs_delivery_reconciliation_clear !== true
      || row?.login_rate_limits_table !== "aais_login_rate_limits"
      || row?.login_rate_limits_expires_column !== true
      || row?.login_rate_limits_expires_index !== true
      || row?.events_table !== "aais_events"
      || row?.ai_guide_daily_usage_table !== "aais_ai_guide_daily_usage"
      || row?.ai_guide_reservations_table !== "aais_ai_guide_reservations"
      || row?.ai_guide_reservation_lease_column !== true
      || row?.ai_guide_reservation_dispatch_state_constraint !== true
      || row?.ai_guide_reservation_dispatch_finalized_constraint !== true
      || row?.ai_guide_reservation_function !== true
      || row?.learner_data_delete_function !== true
      || row?.users_table !== "aais_users"
      || row?.users_auth_version_column !== true
      || row?.active_admin_invariant_lock_table !== "aais_active_admin_invariant_lock"
      || row?.active_admin_update_trigger !== true
      || row?.active_admin_delete_trigger !== true
      || row?.user_auth_tokens_table !== "aais_user_auth_tokens"
      || row?.session_revocations_table !== "aais_session_revocations"
      || row?.courses_table !== "aais_courses"
      || row?.course_tasks_table !== "aais_course_tasks"
      || row?.enrollments_table !== "aais_enrollments"
      || row?.enrollment_scope_index !== "aais_enrollments_user_scope_idx"
    ) {
      return {
        mode: "postgres",
        status: "failed",
      };
    }
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
  return path.join(/*turbopackIgnore: true*/ process.cwd(), ".aais-data");
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
    return createAaisNeonQueryClient(databaseUrl);
  }
  return createAaisPostgresPool(databaseUrl) as AaisDatabaseClient;
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

function parseDatabaseSessionPayload(
  payload: unknown,
  version?: unknown,
  dataGeneration?: unknown,
) {
  if (!payload) {
    return null;
  }
  const storageVersion = readDatabaseSessionVersion(version);
  let session: AaisLearnerSession;
  if (typeof payload === "string") {
    session = JSON.parse(payload) as AaisLearnerSession;
  } else {
    session = payload as AaisLearnerSession;
  }
  let payloadGeneration: number;
  let persistedGeneration: number;
  try {
    payloadGeneration = requireLearnerDataGeneration(session.dataGeneration);
    persistedGeneration = readLearnerDataGeneration(dataGeneration);
  } catch {
    throw new AaisLearnerDataIntegrityError();
  }
  if (payloadGeneration !== persistedGeneration) {
    throw new AaisLearnerDataIntegrityError();
  }
  const normalized = normalizeSession(session, payloadGeneration);
  return setSessionStorageVersion(normalized, storageVersion);
}

function normalizeSession(
  session: AaisLearnerSession,
  dataGeneration = session.dataGeneration ?? 1,
): AaisLearnerSession {
  const sessionId = session.sessionId
    ?? deriveLegacyAaisSessionId(session.studentId, session.createdAt);
  return {
    ...session,
    schemaVersion: 1,
    dataGeneration: requireLearnerDataGeneration(dataGeneration),
    sessionId,
    tasks: taskOrder.map((task, index) => {
      const existing = session.tasks?.find((candidate) => candidate.taskId === task.taskId);
      return {
        taskId: task.taskId,
        phase: task.phase,
        status: existing?.status ?? (index === 0 ? "active" : "locked"),
        artifactText: existing?.artifactText ?? "",
        documentTitle: existing?.documentTitle ?? "",
        activeDocumentId: existing?.activeDocumentId ?? null,
        artifactRevision: normalizeAaisTextRevision(existing?.artifactRevision),
        selfReport: existing?.selfReport ?? "",
        selfReportRevision: normalizeAaisTextRevision(existing?.selfReportRevision),
        scaffoldRequests: existing?.scaffoldRequests ?? 0,
        scaffoldHistory: existing?.scaffoldHistory ?? [],
      };
    }),
    historyDocuments: session.historyDocuments ?? [],
    guideMessages: (session.guideMessages ?? []).map(normalizeGuideMessageRecord),
    guideCapacityReservations: normalizeGuideCapacityReservations(
      session.guideCapacityReservations,
    ),
    events: (session.events ?? []).map((event) => ({
      ...event,
      session_id: event.session_id ?? sessionId,
    })),
  };
}

function normalizeGuideCapacityReservations(
  reservations: AaisGuideCapacityReservation[] | undefined,
) {
  const now = Date.now();
  return (reservations ?? []).filter((reservation) =>
    typeof reservation?.id === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(reservation.id)
    && reservation.reservedBytes === aaisGuideExchangeCapacityReservationBytes
    && Number.isFinite(Date.parse(reservation.expiresAt))
    && Date.parse(reservation.expiresAt) > now
  );
}

function normalizeGuideMessageRecord(
  message: AaisGuideMessageRecord,
): AaisGuideMessageRecord {
  const messageWithoutAttachments = { ...message };
  delete messageWithoutAttachments.attachments;
  if (message.kind !== "user") {
    return messageWithoutAttachments;
  }
  try {
    const attachments = normalizeAaisGuideAttachmentMetadata(message.attachments);
    return attachments.length
      ? { ...messageWithoutAttachments, attachments }
      : messageWithoutAttachments;
  } catch {
    // Malformed legacy metadata must neither break session loading nor expose
    // an arbitrary attachment-shaped payload to the learner client.
    return messageWithoutAttachments;
  }
}

function redactRestrictedResearchRawText(
  session: AaisLearnerSession,
): AaisLearnerSession {
  return touch({
    ...session,
    tasks: session.tasks.map((task) => ({
      ...task,
      artifactText: "",
      documentTitle: "",
      activeDocumentId: null,
      selfReport: "",
    })),
    historyDocuments: [],
    guideMessages: session.guideMessages.map((message) => {
      const messageWithoutAttachments = { ...message };
      delete messageWithoutAttachments.attachments;
      return {
        ...messageWithoutAttachments,
        text: "",
        turns: message.turns?.map((turn) => ({
          ...turn,
          content: "",
          actions: [],
        })),
      };
    }),
  });
}

function touch(session: AaisLearnerSession): AaisLearnerSession {
  return {
    ...session,
    updatedAt: new Date().toISOString(),
  };
}

function readDatabaseSessionVersion(value: unknown) {
  const version = Number(value);
  return Number.isInteger(version) && version >= 0 ? version : null;
}

function readLearnerDataGeneration(value: unknown) {
  const generation = Number(value);
  return requireLearnerDataGeneration(generation);
}

function requireLearnerDataGeneration(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error("Invalid AAIS learner data generation.");
  }
  return Number(value);
}

function normalizeAaisTextRevision(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function requireAaisTextRevision(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Invalid AAIS ${label}.`);
  }
  return Number(value);
}

function incrementAaisTextRevision(revision: number) {
  const current = requireAaisTextRevision(revision, "text revision");
  if (current >= Number.MAX_SAFE_INTEGER) {
    throw new AaisSessionWriteConflictError();
  }
  return current + 1;
}

function isDatabaseSessionWriteConflict(error: unknown) {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && error.code === "40001",
  );
}

function setSessionStorageVersion<T extends AaisLearnerSession>(
  session: T,
  version: number | null,
) {
  if (version === null) {
    return session;
  }
  Object.defineProperty(session, aaisSessionStorageVersion, {
    value: version,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return session;
}

function getSessionStorageVersion(session: AaisLearnerSession) {
  const version = (session as AaisStorageVersionedSession)[aaisSessionStorageVersion];
  return readDatabaseSessionVersion(version);
}

function setFileSessionFingerprint<T extends AaisLearnerSession>(
  session: T,
  fingerprint: string,
) {
  Object.defineProperty(session, aaisFileSessionFingerprint, {
    value: fingerprint,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return session;
}

function getFileSessionFingerprint(session: AaisLearnerSession) {
  const fingerprint = (session as AaisStorageVersionedSession)[aaisFileSessionFingerprint];
  return typeof fingerprint === "string" && /^[a-f0-9]{64}$/.test(fingerprint)
    ? fingerprint
    : null;
}

function createFileSessionFingerprint(serialized: string) {
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

function recordAaisSessionWriteConflict(input: {
  studentId: string;
  operation: string;
  attempt: number;
  resolution: "retrying" | "merge_failed";
  storage: "file" | "postgres";
}) {
  console.info(JSON.stringify({
    event: "aais.session.write_conflict",
    learnerId: `learner:${createHash("sha256")
      .update(`aais-session-conflict:${input.studentId}`)
      .digest("hex")
      .slice(0, 16)}`,
    learnerIdRedaction: "sha256-16",
    operation: input.operation,
    attempt: input.attempt,
    resolution: input.resolution,
    storage: input.storage,
    secrets: "redacted",
  }));
}

function requireTask(session: AaisLearnerSession, taskId: string) {
  const safeTaskId = requireSafeId(taskId, "task id");
  const task = session.tasks.find((candidate) => candidate.taskId === safeTaskId);
  if (!task) {
    throw new AaisLearnerMutationError("task_unknown", `Unknown task ${taskId}`);
  }
  return task;
}

function requireUnlockedTask(session: AaisLearnerSession, taskId: string) {
  const task = requireTask(session, taskId);
  if (task.status === "locked") {
    throw new AaisLearnerMutationError("task_locked", `Task ${taskId} is locked`);
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

function requireAiAcceptanceMessageId(value: unknown) {
  if (typeof value !== "string") {
    throw new AaisAiAcceptanceTargetError();
  }
  try {
    return requireSafeId(value, "AI message id");
  } catch {
    throw new AaisAiAcceptanceTargetError();
  }
}

function requireSafeAnalyticsKey(value: string, label: string, prefix: "learner" | "session") {
  if (!new RegExp(`^(?:${prefix}-[a-f0-9]{12}|${prefix}-v2-[a-f0-9]{32})$`).test(value)) {
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

function requireSafeArtifactText(value: string) {
  if (typeof value !== "string") {
    throw new Error("Invalid AAIS artifactText.");
  }
  if (value.length > aaisArtifactMaxCharacters) {
    throw new Error("AAIS artifactText is too large.");
  }
  return value;
}

function requireSafeHistoryDocument(
  document: AaisHistoryDocumentRecord,
): AaisHistoryDocumentRecord {
  const title = requireSafeDocumentTitle(document.title);
  const savedAt = new Date(document.savedAt);
  if (Number.isNaN(savedAt.getTime())) {
    throw new Error("Invalid AAIS document savedAt.");
  }
  return {
    id: requireSafeId(document.id, "history document id"),
    taskId: requireSafeId(document.taskId, "task id"),
    title,
    html: requireSafeArtifactText(document.html),
    savedAt: savedAt.toISOString(),
  };
}

function requireSafeDocumentTitle(value: string) {
  const title = requireSafeText(value, "document title");
  if (title.length > 200) {
    throw new Error("AAIS document title is too large.");
  }
  return title;
}

function assertSafeHistoryCollection(documents: AaisHistoryDocumentRecord[]) {
  if (documents.length > aaisHistoryDocumentMaxCount) {
    throw new AaisLearnerMutationError(
      "history_limit_reached",
      "AAIS document history has reached its limit.",
    );
  }
  const characters = documents.reduce(
    (total, document) => total + document.title.length + document.html.length,
    0,
  );
  if (characters > aaisHistoryDocumentsMaxCharacters) {
    throw new AaisLearnerMutationError(
      "history_too_large",
      "AAIS document history is too large.",
    );
  }
}

function serializeAaisLearnerSession(session: AaisLearnerSession) {
  const capacityReservations = normalizeGuideCapacityReservations(
    session.guideCapacityReservations,
  );
  if (
    session.events.length + capacityReservations.length * 2
    > aaisLearnerSessionPersistenceLimits.maxEvents
  ) {
    throw new AaisLearnerSessionLimitError("events_limit_reached");
  }
  if (
    session.guideMessages.length + capacityReservations.length * 2
    > aaisLearnerSessionPersistenceLimits.maxGuideMessages
  ) {
    throw new AaisLearnerSessionLimitError("guide_messages_limit_reached");
  }
  const scaffoldHistoryEntries = session.tasks.reduce(
    (total, task) => total + task.scaffoldHistory.length,
    0,
  );
  if (
    scaffoldHistoryEntries
    > aaisLearnerSessionPersistenceLimits.maxScaffoldHistoryEntries
  ) {
    throw new AaisLearnerSessionLimitError("scaffold_history_limit_reached");
  }
  const serialized = JSON.stringify(session);
  if (
    Buffer.byteLength(serialized, "utf8")
      + capacityReservations.reduce(
        (total, reservation) => total + reservation.reservedBytes,
        0,
      )
    > aaisLearnerSessionPersistenceLimits.maxBytes
  ) {
    throw new AaisLearnerSessionLimitError("payload_too_large");
  }
  return serialized;
}

function getAaisUtcDayRange(now: Date) {
  const start = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  ));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

function createAntiAbuseGuideUsageRetention(deletedAt: string) {
  return {
    retained: true as const,
    scope: "content-free-account-daily-aggregate" as const,
    rawLearnerContent: false as const,
    quotaEffectEndsAt: getAaisUtcDayRange(new Date(deletedAt)).end,
    cleanup: "next-quota-maintenance-after-utc-reset" as const,
  };
}

export type AaisDailyGuideReservation = {
  status: "reserved" | "exhausted";
  reservationId: string | null;
  limit: number;
  used: number;
  remaining: number;
  resetsAt: string;
};

function buildDailyGuideReservation(
  status: AaisDailyGuideReservation["status"],
  limit: number,
  used: number,
  resetsAt: string,
  reservationId: string | null,
): AaisDailyGuideReservation {
  return {
    status,
    reservationId,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    resetsAt,
  };
}

function isMissingAaisRelationError(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "42P01" || code === "42703" || code === "42883";
}

function getAaisLearnerDataDeliveryFenceReason(
  error: unknown,
): AaisLearnerDataDeliveryFenceReason | null {
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return null;
  }
  const message = String((error as { message?: unknown }).message ?? "");
  if (message.includes("AAIS_LRS_DELIVERY_IN_FLIGHT")) {
    return "in_flight";
  }
  if (
    message.includes("AAIS_LRS_DELIVERY_RECONCILIATION_REQUIRED")
    || message.includes("AAIS_LRS_DELIVERY_FENCE_INVALID")
  ) {
    return "reconciliation_required";
  }
  return null;
}

function hashAaisGuideExchangeId(userMessageId: string, assistantMessageId: string) {
  return createHash("sha256")
    .update(`aais-guide-exchange:${userMessageId}:${assistantMessageId}`)
    .digest("hex")
    .slice(0, 24);
}

function createPseudonymousAnalyticsLearnerKey(studentId: string) {
  return `learner-v2-${createAaisProductPseudonym("analytics-learner", studentId)}`;
}

function createPseudonymousAnalyticsSessionKey(sessionId: string) {
  return `session-v2-${createAaisProductPseudonym("analytics-session", sessionId)}`;
}

function createLegacyPseudonymousAnalyticsLearnerKey(studentId: string) {
  return `learner-${createHash("sha256")
    .update(`aais-analytics:${studentId}`)
    .digest("hex")
    .slice(0, 12)}`;
}

function createLegacyPseudonymousAnalyticsSessionKey(sessionId: string) {
  return `session-${createHash("sha256")
    .update(`aais-analytics-session:${sessionId}`)
    .digest("hex")
    .slice(0, 12)}`;
}

function createPseudonymousEducatorKey(actorId: string) {
  return `educator-v2-${createAaisProductPseudonym("analytics-educator", actorId)}`;
}

function createLegacyPseudonymousEducatorKey(actorId: string) {
  return `educator-${createHash("sha256")
    .update(`aais-educator:${actorId}`)
    .digest("hex")
    .slice(0, 12)}`;
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

function createNewAaisSessionId() {
  return `session-${randomUUID()}`;
}

function deriveLegacyAaisSessionId(studentId: string, createdAt: string) {
  const digest = createHash("sha256")
    .update("AAIS:legacy-session:v1\0", "utf8")
    .update(studentId, "utf8")
    .update("\0", "utf8")
    .update(createdAt, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `session-${digest}`;
}
