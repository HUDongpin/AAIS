import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { guideStreamHeartbeatIntervalMs } from "@/components/pages/learning/learning-page-constants";
import {
  runAaisLearningGuideGraph,
  type AaisGuideInput,
} from "@/lib/ai/orchestration/aais-learning-guide-graph";
import {
  studentRuntimeMaxRetries,
  studentRuntimeMaxTimeoutMs,
} from "@/lib/ai/aais-ai-runtime-config";
import {
  AaisLearnerDataGenerationConflictError,
  getAaisLearningStore,
  isAaisGuideMutationInProgressError,
  isAaisLearnerDataGenerationConflictError,
  isAaisLearnerMutationError,
  isAaisLearnerSessionLimitError,
  isAaisLearningStorageConfigurationError,
  isAaisSessionWriteConflictError,
  type AaisGuideInteractionMode,
  type AaisGuideMutationReceipt,
  type AaisGuideMutationRuntimeSummary,
  type AaisCompletedGuideMutationReplay,
  type AaisPersistedGuideExchange,
} from "@/lib/server/aais-learning-store";
import { isAaisCsrfError, requireAaisCsrf } from "@/lib/server/aais-csrf";
import { isAaisAuthError, requireAaisSessionActor } from "@/lib/server/aais-request-auth";
import {
  selectAaisGuideReplyAgentIds,
} from "@/lib/ai/aais-guide-targets";
import {
  normalizeAaisGuideAttachments,
  toAaisGuideAttachmentMetadata,
} from "@/lib/ai/aais-guide-attachments";
import {
  AaisApiRouteError,
  createAaisApiErrorBody,
  createAaisApiErrorResponse,
  isAaisApiRouteError,
} from "@/lib/server/aais-api-error";
import { recordAaisAuditEvent } from "@/lib/server/aais-audit-log";
import {
  AaisRequestBodyError,
  readAaisBoundedJson,
} from "@/lib/server/aais-request-json";
import {
  AaisResearchConfigurationError,
  AaisResearchDisabledError,
  isAaisResearchModeEnabled,
  requiresAaisResearchDataPlaneIsolation,
} from "@/lib/server/aais-research-contract";
import { getAaisResearchErrorResponseInput } from "@/lib/server/aais-research-api";
import {
  acquireAaisResearchRawTextWriteLeaseIfRequired,
  type AaisResearchRawTextWriteLease,
} from "@/lib/server/aais-research-raw-text";
import {
  AaisResearchAuthorizationError,
  AaisResearchVisitInactiveError,
  AaisResearchVisitNotFoundError,
} from "@/lib/server/aais-research-store";
import type { AaisPhase, Locale } from "@/data/aais";
import {
  classifyAaisLearnerInput,
  isAaisRevisionPolicyActionable,
  pilotClosedTaskIds,
  selectActionableAaisSupervisionSignals,
  type AaisLearningMilestoneId,
} from "@/lib/server/aais-learning-loop";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type AaisGuideRequestBody = {
  dataGeneration: number;
  locale?: Locale;
  studentId?: string;
  phase?: AaisPhase;
  taskId?: string;
  learnerInput: string;
  mutationId?: string;
  targetAgentIds?: string[];
  workspaceState?: {
    currentStep?: string;
    artifactText?: string;
    helpRequestsUsed?: number;
    attachments?: unknown;
  };
};

const defaultDailyGuideLimit = 1_000;
const maxDailyGuideLimit = 1_000;
const maxGuideLearnerInputCharacters = 20_000;
const maxGuideWorkspaceArtifactCharacters = 2 * 1024 * 1024;
const maxGuideWorkspaceStepCharacters = 128;
const maxGuideHelpRequests = 4;
const maxGuideTargetAgents = 1;
const maxGuideRequestBodyBytes = 16 * 1024 * 1024;
const maxGuideConversationHistoryMessages = 12;
const maxGuideConversationHistoryCharacters = 16_000;
// Exactly one learner-visible agent runs per request and may traverse the
// primary and fallback providers serially, so the route needs one complete
// two-provider retry chain.
const maxGuideLiveProviderCandidates = 2;
const guideRouteFinalizeGuardMs = 10_000;
export const guideProviderMaximumRetryBudgetMs = studentRuntimeMaxTimeoutMs
  * (studentRuntimeMaxRetries + 1)
  * maxGuideLiveProviderCandidates;
export const guideRouteMaximumDeadlineMs = 250_000;
export const guideRouteTotalDeadlineMs = Math.min(
  guideRouteMaximumDeadlineMs,
  guideProviderMaximumRetryBudgetMs + guideRouteFinalizeGuardMs,
);

export async function POST(request: Request) {
  let guideRunDeadline: AaisGuideRunDeadline | null = createGuideRunDeadline(request.signal);
  try {
    const actor = await requireAaisSessionActor(request);
    const studentId = actor.id;
    requireAaisCsrf(request, studentId);
    const body = requireGuideRequestBody(await readAaisBoundedJson(request, {
      maxBytes: maxGuideRequestBodyBytes,
    }));
    const inputClassification = classifyAaisLearnerInput(body.learnerInput);
    if (!inputClassification.recognizable) {
      throw new AaisApiRouteError({
        code: "AAIS_GUIDE_INPUT_UNRECOGNIZABLE",
        message: "AAIS guide input is blank or cannot be recognized. Please enter a clear learning request.",
        status: 400,
      });
    }
    if (inputClassification.explicitHelpRequested && !body.mutationId) {
      throw new AaisApiRouteError({
        code: "AAIS_GUIDE_MUTATION_ID_REQUIRED",
        message: "A stable mutationId is required for scaffolded guide requests.",
        status: 409,
      });
    }
    const targetAgentIds = selectAaisGuideReplyAgentIds(body.learnerInput);
    const attachments = normalizeGuideAttachments(body.workspaceState?.attachments);
    const attachmentMetadata = attachments.map(toAaisGuideAttachmentMetadata);
    const researchIsolationRequired = requiresAaisResearchDataPlaneIsolation();
    if (researchIsolationRequired && !isAaisResearchModeEnabled()) {
      throw new AaisApiRouteError({
        code: "AAIS_RESEARCH_MODE_REQUIRED",
        message: "AAIS research collection is required but not enabled.",
        status: 503,
      });
    }
    if (researchIsolationRequired && attachments.length) {
      throw new AaisApiRouteError({
        code: "AAIS_RESEARCH_ATTACHMENT_PROHIBITED",
        message: "Attachments are disabled for this research study.",
        status: 400,
      });
    }
    const store = getAaisLearningStore();
    let rawTextWriteLease = await acquireAaisResearchRawTextWriteLeaseIfRequired(actor);
    let guideBudgetReservation: AaisGuideBudgetReservation | null = null;
    let guideBudgetCommitted = false;
    let guideBudgetDispatched = false;
    let guideCapacityReserved = false;
    let guideMutationReceipt: AaisGuideMutationReceipt | null = null;
    let guideMutationCompleted = false;
    try {
      let session = await store.readSession(studentId);
      if (!session) {
        throw new AaisApiRouteError({
          code: "AAIS_LEARNER_SESSION_NOT_FOUND",
          message: "AAIS learner session was not found.",
          status: 404,
        });
      }
      if (session.dataGeneration !== body.dataGeneration) {
        throw new AaisLearnerDataGenerationConflictError();
      }
      guideRunDeadline.signal.throwIfAborted();
      let task = requireGuideTask(session, body.taskId);
      const locale = body.locale === "en-US" ? "en-US" : "zh-CN";
      const interactionMode: AaisGuideInteractionMode =
        task.pilotEvidence.aiUseMode === "ai-free"
          ? "deterministic-local"
          : "ai-provider";
      if (body.mutationId) {
        const claim = await store.claimGuideMutation({
          studentId,
          mutationId: body.mutationId,
          payloadHash: createCanonicalGuideMutationPayloadHash({
            attachments,
            dataGeneration: body.dataGeneration,
            interactionMode,
            learnerInput: body.learnerInput,
            locale,
            phase: task.phase,
            targetAgentIds,
            taskId: task.taskId,
          }),
          dataGeneration: body.dataGeneration,
        });
        if (claim.status === "completed") {
          return isGuideStreamRequest(request)
            ? createCompletedGuideReplayStreamResponse(claim.replay)
            : NextResponse.json(createCompletedGuideReplayJsonBody(claim.replay), {
                headers: {
                  "cache-control": "private, no-store",
                },
              });
        }
        guideMutationReceipt = claim.receipt;
        session = claim.session;
        task = requireGuideTask(session, task.taskId);
      }
      if (inputClassification.explicitHelpRequested) {
        const scaffold = await store.requestScaffold(
          studentId,
          task.taskId,
          undefined,
          body.dataGeneration,
          {
            mutationId: deriveGuideScaffoldMutationId(body.mutationId!),
            sourceText: body.learnerInput,
          },
        );
        session = scaffold.session;
        task = requireGuideTask(session, task.taskId);
      }
      guideBudgetReservation = await reserveDailyGuideBudget(
        studentId,
        body.dataGeneration,
        store,
        interactionMode,
      );
      const budget = guideBudgetReservation.budget;
      guideRunDeadline.signal.throwIfAborted();
      await store.reserveGuideExchangeCapacity({
        studentId,
        reservationId: guideBudgetReservation.reservationId,
        dataGeneration: body.dataGeneration,
      });
      guideCapacityReserved = true;
      const taskGuideMessages = session.guideMessages.filter((message) =>
        message.taskId === task.taskId && message.phase === task.phase
      );
      const actionableSupervisionSignals = selectActionableAaisSupervisionSignals({
        taskId: task.taskId,
        artifactText: task.artifactText,
        pilotEvidence: task.pilotEvidence,
        supervisionSignals: task.supervisionSignals,
        guideMessages: taskGuideMessages,
        events: session.events,
      });
      const revisionPolicyActionable = isAaisRevisionPolicyActionable({
        taskId: task.taskId,
        pilotEvidence: task.pilotEvidence,
        guideMessages: taskGuideMessages,
        events: session.events,
      });
      const input: AaisGuideInput = {
        locale,
        studentId,
        phase: task.phase,
        taskId: task.taskId,
        learnerInput: body.learnerInput,
        conversationHistory: buildBoundedGuideConversationHistory(
          taskGuideMessages,
        ),
        targetAgentIds,
        workspaceState: {
          currentStep: task.activeMilestone ?? body.workspaceState?.currentStep ?? "smart-guide",
          artifactText: task.artifactText,
          helpRequestsUsed: task.scaffoldRequests,
          aiUseMode: task.pilotEvidence.aiUseMode,
          outputEvaluation: revisionPolicyActionable
            ? "revision_required"
            : task.pilotEvidence.outputEvaluation === "revision_required"
              ? "pending"
              : task.pilotEvidence.outputEvaluation,
          scaffoldLevel: task.scaffoldState.currentLevel,
          scaffoldIntensity: task.scaffoldState.intensity,
          scaffoldFading: task.scaffoldState.fading,
          directAnswerRequested: inputClassification.directAnswerRequested,
          taskMode: mapMilestoneToTaskMode(task.activeMilestone),
          supervisionSignals: actionableSupervisionSignals.slice(-10).map((signal) => ({
            id: signal.id,
            type: signal.type,
            basis: signal.basis,
            evidence: signal.evidence,
            recommendedAction: signal.recommendedAction,
          })),
          ...(attachments.length ? { attachments } : {}),
        },
      };

      if (isGuideStreamRequest(request)) {
        const response = createGuideStreamResponse({
          input,
          store,
          question: body.learnerInput,
          budget,
          attachmentMetadata,
          rawTextWriteLease,
          runDeadline: guideRunDeadline,
          reservationId: guideBudgetReservation.reservationId,
          interactionMode,
          metered: guideBudgetReservation.metered,
          dataGeneration: body.dataGeneration,
          guideMutationReceipt,
        });
        guideRunDeadline = null;
        rawTextWriteLease = null;
        guideCapacityReserved = false;
        guideBudgetReservation = null;
        guideMutationReceipt = null;
        return response;
      }

      guideRunDeadline.signal.throwIfAborted();
      if (guideBudgetReservation.metered) {
        await dispatchGuideBudgetReservation({
          store,
          studentId,
          reservation: guideBudgetReservation,
        });
        guideBudgetDispatched = true;
      }
      const result = await runGuideGraphWithSignal(input, guideRunDeadline.signal);
      guideRunDeadline.signal.throwIfAborted();
      const persistedExchange = await store.appendGuideExchange({
        studentId,
        phase: task.phase,
        taskId: task.taskId,
        question: body.learnerInput,
        answer: result.messageText,
        interactionMode,
        ...(attachmentMetadata.length ? { attachments: attachmentMetadata } : {}),
        turns: result.visibleTurns,
        orchestration: createPersistedGuideOrchestration(result),
        ...(guideMutationReceipt
          ? {
              guideMutation: {
                receipt: guideMutationReceipt,
                runtime: createGuideMutationRuntimeSummary(result),
                budget,
              },
            }
          : {}),
        ...(guideBudgetReservation.metered
          ? { budgetReservationId: guideBudgetReservation.reservationId }
          : {}),
        capacityReservationId: guideBudgetReservation.reservationId,
        dataGeneration: body.dataGeneration,
      });
      guideCapacityReserved = false;
      guideMutationCompleted = guideMutationReceipt !== null;
      if (guideBudgetReservation.metered) {
        guideBudgetCommitted = true;
        recordGuideBudgetAudit({
          studentId,
          event: "ai.guide.budget.used",
          outcome: "success",
          budget,
        });
      }

      return NextResponse.json(
        {
          ...createGuideJsonBody(result, persistedExchange.exchange),
          budget,
        },
        {
          headers: {
            "cache-control": "private, no-store",
          },
        },
      );
    } finally {
      if (guideBudgetReservation && guideCapacityReserved) {
        await releaseGuideCapacityReservation({
          store,
          studentId,
          reservation: guideBudgetReservation,
        });
      }
      if (
        guideBudgetReservation?.metered
        && !guideBudgetCommitted
        && !guideBudgetDispatched
      ) {
        await releaseGuideBudgetReservation({
          store,
          studentId,
          reservation: guideBudgetReservation,
        });
      }
      if (guideMutationReceipt && !guideMutationCompleted) {
        await store.releaseGuideMutation({
          studentId,
          receipt: guideMutationReceipt,
          dataGeneration: body.dataGeneration,
        });
      }
      await rawTextWriteLease?.release();
    }
  } catch (error) {
    return createAaisApiErrorResponse(getErrorResponseInput(error));
  } finally {
    guideRunDeadline?.dispose();
  }
}

function requireGuideRequestBody(value: unknown): AaisGuideRequestBody {
  if (!isRecord(value)) {
    throw new AaisApiRouteError({
      code: "AAIS_GUIDE_BODY_INVALID",
      message: "AAIS guide request body must be an object.",
      status: 400,
    });
  }

  const learnerInput = requireGuideString(value.learnerInput, {
    field: "learnerInput",
    required: true,
    maxCharacters: maxGuideLearnerInputCharacters,
    oversizedStatus: 413,
  });
  const dataGeneration = requireGuideDataGeneration(value.dataGeneration);
  if (learnerInput === undefined || !learnerInput.trim()) {
    throw new AaisApiRouteError({
      code: "AAIS_GUIDE_INPUT_REQUIRED",
      message: "learnerInput is required",
      status: 400,
    });
  }

  const locale = requireGuideOptionalEnum(value.locale, "locale", ["zh-CN", "en-US"]);
  const phase = requireGuideOptionalEnum(value.phase, "phase", ["training", "practice"]);
  const studentId = requireGuideOptionalSafeId(value.studentId, "studentId");
  const mutationId = requireGuideOptionalSafeId(value.mutationId, "mutationId");
  const taskId = requireGuideOptionalSafeId(value.taskId, "taskId");
  const targetAgentIds = requireGuideTargetAgentIds(value.targetAgentIds);
  const workspaceState = requireGuideWorkspaceState(value.workspaceState);

  return {
    dataGeneration,
    learnerInput,
    ...(locale ? { locale } : {}),
    ...(phase ? { phase } : {}),
    ...(studentId ? { studentId } : {}),
    ...(mutationId ? { mutationId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(targetAgentIds ? { targetAgentIds } : {}),
    ...(workspaceState ? { workspaceState } : {}),
  };
}

function deriveGuideScaffoldMutationId(mutationId: string) {
  return `guide-scaffold-${createHash("sha256").update(mutationId).digest("hex").slice(0, 32)}`;
}

function createCanonicalGuideMutationPayloadHash(input: {
  attachments: ReturnType<typeof normalizeAaisGuideAttachments>;
  dataGeneration: number;
  interactionMode: AaisGuideInteractionMode;
  learnerInput: string;
  locale: Locale;
  phase: AaisPhase;
  targetAgentIds: string[];
  taskId: string;
}) {
  const attachmentDigests = input.attachments.map((attachment) => ({
    name: attachment.name,
    mediaType: attachment.mediaType,
    sizeBytes: attachment.sizeBytes,
    extractedTextHash: createHash("sha256")
      .update(attachment.extractedText)
      .digest("hex"),
  }));
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    dataGeneration: input.dataGeneration,
    taskId: input.taskId,
    phase: input.phase,
    locale: input.locale,
    interactionMode: input.interactionMode,
    learnerInput: input.learnerInput,
    targetAgentIds: input.targetAgentIds,
    attachments: attachmentDigests,
  })).digest("hex");
}

function requireGuideDataGeneration(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new AaisApiRouteError({
      code: "AAIS_LEARNER_DATA_GENERATION_REQUIRED",
      message: "A current learner data generation is required.",
      status: 409,
    });
  }
  return Number(value);
}

function requireGuideWorkspaceState(value: unknown): AaisGuideRequestBody["workspaceState"] {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw invalidGuideField("workspaceState");
  }
  const currentStep = requireGuideString(value.currentStep, {
    field: "workspaceState.currentStep",
    maxCharacters: maxGuideWorkspaceStepCharacters,
  });
  const artifactText = requireGuideString(value.artifactText, {
    field: "workspaceState.artifactText",
    maxCharacters: maxGuideWorkspaceArtifactCharacters,
    oversizedStatus: 413,
  });
  let helpRequestsUsed: number | undefined;
  if (value.helpRequestsUsed !== undefined) {
    if (
      typeof value.helpRequestsUsed !== "number"
      || !Number.isInteger(value.helpRequestsUsed)
      || value.helpRequestsUsed < 0
      || value.helpRequestsUsed > maxGuideHelpRequests
    ) {
      throw invalidGuideField("workspaceState.helpRequestsUsed");
    }
    helpRequestsUsed = value.helpRequestsUsed;
  }
  return {
    ...(currentStep !== undefined ? { currentStep } : {}),
    ...(artifactText !== undefined ? { artifactText } : {}),
    ...(helpRequestsUsed !== undefined ? { helpRequestsUsed } : {}),
    ...(value.attachments !== undefined ? { attachments: value.attachments } : {}),
  };
}

function requireGuideTargetAgentIds(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > maxGuideTargetAgents) {
    throw invalidGuideField("targetAgentIds");
  }
  const normalized: string[] = [];
  for (const targetId of value) {
    if (typeof targetId !== "string") {
      throw invalidGuideField("targetAgentIds");
    }
    const canonicalId = targetId.toUpperCase().replace(/\s+/g, "");
    if ((canonicalId !== "A1" && canonicalId !== "A2") || normalized.includes(canonicalId)) {
      throw invalidGuideField("targetAgentIds");
    }
    normalized.push(canonicalId);
  }
  return normalized;
}

function requireGuideOptionalEnum<T extends string>(
  value: unknown,
  field: string,
  values: readonly T[],
): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw invalidGuideField(field);
  }
  return value as T;
}

function requireGuideOptionalSafeId(value: unknown, field: string) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw invalidGuideField(field);
  }
  return value;
}

function requireGuideString(
  value: unknown,
  input: {
    field: string;
    required?: boolean;
    maxCharacters: number;
    oversizedStatus?: 400 | 413;
  },
): string | undefined {
  if (value === undefined && !input.required) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw invalidGuideField(input.field);
  }
  if (value.length > input.maxCharacters) {
    throw new AaisApiRouteError({
      code: "AAIS_GUIDE_INPUT_TOO_LARGE",
      message: "AAIS guide request input is too large.",
      status: input.oversizedStatus ?? 400,
    });
  }
  return value;
}

function invalidGuideField(field: string) {
  return new AaisApiRouteError({
    code: "AAIS_GUIDE_FIELD_INVALID",
    message: `AAIS guide request field ${field} is invalid.`,
    status: 400,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeGuideAttachments(value: unknown) {
  try {
    return normalizeAaisGuideAttachments(value);
  } catch {
    throw new AaisApiRouteError({
      code: "AAIS_GUIDE_ATTACHMENT_INVALID",
      message: "AAIS guide attachment is invalid.",
      status: 400,
    });
  }
}

function requireGuideTask(
  session: Awaited<ReturnType<ReturnType<typeof getAaisLearningStore>["getOrCreateSession"]>>,
  requestedTaskId: string | undefined,
) {
  const taskId = requestedTaskId ?? session.activeTaskId;
  const task = session.tasks.find((candidate) => candidate.taskId === taskId);
  if (!task) {
    throw new AaisApiRouteError({
      code: "AAIS_TASK_UNKNOWN",
      message: "AAIS task was not found.",
      status: 400,
    });
  }
  if (pilotClosedTaskIds.has(task.taskId)) {
    throw new AaisApiRouteError({
      code: "AAIS_TASK_PILOT_CLOSED",
      message: "AAIS task is closed for the current pilot.",
      status: 409,
    });
  }
  if (task.status === "locked") {
    throw new AaisApiRouteError({
      code: "AAIS_TASK_LOCKED",
      message: "AAIS task is locked.",
      status: 400,
    });
  }
  return task;
}

function mapMilestoneToTaskMode(milestoneId: AaisLearningMilestoneId) {
  if (milestoneId === "modeling") {
    return "modeling" as const;
  }
  if (milestoneId === "exploration") {
    return "exploration" as const;
  }
  if (milestoneId === "articulation" || milestoneId === "reflection") {
    return "reflection" as const;
  }
  return "coaching" as const;
}

function buildBoundedGuideConversationHistory(
  messages: Array<{ kind: "user" | "assistant"; text: string }>,
) {
  const selected: Array<{ kind: "user" | "assistant"; text: string }> = [];
  let remainingCharacters = maxGuideConversationHistoryCharacters;
  for (
    let index = messages.length - 1;
    index >= 0
      && selected.length < maxGuideConversationHistoryMessages
      && remainingCharacters > 0;
    index -= 1
  ) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    const text = message.text.length <= remainingCharacters
      ? message.text
      : message.text.slice(0, remainingCharacters);
    selected.push({ kind: message.kind, text });
    remainingCharacters -= text.length;
  }
  return selected.reverse();
}

function getErrorResponseInput(error: unknown) {
  if (error instanceof AaisRequestBodyError) {
    return {
      code: error.reason === "too_large"
        ? "AAIS_GUIDE_BODY_TOO_LARGE"
        : "AAIS_GUIDE_BODY_INVALID",
      message: error.reason === "too_large"
        ? "AAIS guide request body is too large."
        : "AAIS guide request body is invalid.",
      status: error.status,
    };
  }
  if (isAaisApiRouteError(error)) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
    };
  }
  if (isAaisAuthError(error)) {
    return {
      code: "AAIS_AUTH_REQUIRED",
      message: "AAIS authentication is required.",
      status: 401,
    };
  }
  if (isAaisCsrfError(error)) {
    return {
      code: "AAIS_CSRF_REQUIRED",
      message: "AAIS CSRF token is required.",
      status: 403,
    };
  }
  if (isAaisGuideMutationInProgressError(error)) {
    return {
      code: "AAIS_GUIDE_MUTATION_IN_PROGRESS",
      message: "This guide request is already in progress. Retry with the same mutationId.",
      status: 503,
      headers: {
        "retry-after": String(error.retryAfterSeconds),
      },
    };
  }
  if (isAaisLearnerMutationError(error) && error.reason === "mutation_replay_conflict") {
    return {
      code: "AAIS_MUTATION_ID_CONFLICT",
      message: "AAIS mutation id is already bound to different content.",
      status: 409,
    };
  }
  if (
    error instanceof AaisResearchAuthorizationError
    || error instanceof AaisResearchVisitInactiveError
    || error instanceof AaisResearchVisitNotFoundError
    || error instanceof AaisResearchConfigurationError
    || error instanceof AaisResearchDisabledError
  ) {
    return getAaisResearchErrorResponseInput(error, "/api/learning/ai-guide");
  }
  if (isAaisLearningStorageConfigurationError(error)) {
    return {
      code: "AAIS_STORAGE_NOT_CONFIGURED",
      message: "AAIS production learner storage requires Postgres configuration.",
      status: 503,
    };
  }
  if (isAaisSessionWriteConflictError(error)) {
    return {
      code: "AAIS_SESSION_WRITE_CONFLICT",
      message: "AAIS learner session write conflict.",
      status: 409,
    };
  }
  if (isAaisLearnerDataGenerationConflictError(error)) {
    return {
      code: "AAIS_LEARNER_DATA_GENERATION_STALE",
      message: "AAIS learner data changed after this request started. Reload the session.",
      status: 409,
    };
  }
  if (isAaisLearnerSessionLimitError(error)) {
    return {
      code: "AAIS_SESSION_PERSISTENCE_LIMIT_REACHED",
      message: "AAIS learner session has reached its persistence limit.",
      status: 413,
    };
  }
  if (error instanceof AaisGuideDailyBudgetError) {
    return {
      code: "AAIS_GUIDE_DAILY_BUDGET_EXCEEDED",
      message: "AAIS daily guide request budget has been reached.",
      status: 429,
      extra: {
        budget: error.budget,
        secrets: "redacted",
      },
    };
  }
  if (error instanceof AaisGuideRouteDeadlineError) {
    return {
      code: "AAIS_GUIDE_DEADLINE_EXCEEDED",
      message: "AAIS guide request exceeded its bounded runtime.",
      status: 504,
    };
  }
  return {
    code: "AAIS_GUIDE_REQUEST_FAILED",
    message: "AAIS guide request failed.",
    status: 500,
    cause: error,
    route: "/api/learning/ai-guide",
  };
}

function createGuideJsonBody(
  result: Awaited<ReturnType<typeof runAaisLearningGuideGraph>>,
  exchange: AaisPersistedGuideExchange,
) {
  const runtime = createGuideMutationRuntimeSummary(result);
  return {
    message: {
      text: result.messageText,
    },
    exchange,
    turns: result.visibleTurns,
    orchestration: {
      graph: {
        graphId: result.graph.graphId,
        topologicalOrder: createVisibleGuideTopologicalOrder(result),
      },
      runtime: {
        engine: runtime.engine,
        status: runtime.status,
        timings: {
          visibleMs: runtime.visibleMs,
          attempts: runtime.attempts,
          fallback: runtime.fallback,
          timeoutReason: runtime.timeoutReason,
        },
      },
    },
  };
}

function createCompletedGuideReplayJsonBody(replay: AaisCompletedGuideMutationReplay) {
  return {
    message: { text: replay.messageText },
    exchange: replay.exchange,
    turns: replay.turns,
    orchestration: {
      graph: {
        graphId: replay.orchestration.graphId,
        topologicalOrder: replay.orchestration.topologicalOrder,
      },
      runtime: {
        engine: replay.runtime.engine,
        status: replay.runtime.status,
        timings: {
          visibleMs: replay.runtime.visibleMs,
          attempts: replay.runtime.attempts,
          fallback: replay.runtime.fallback,
          timeoutReason: replay.runtime.timeoutReason,
        },
      },
    },
    budget: replay.budget,
  };
}

function createGuideMutationRuntimeSummary(
  result: Awaited<ReturnType<typeof runAaisLearningGuideGraph>>,
): AaisGuideMutationRuntimeSummary {
  const visibleTimings = getVisibleGuideTimings(result);
  const elapsedValues = visibleTimings
    .map((timing) => Number(timing.elapsedMs))
    .filter((elapsed) => Number.isFinite(elapsed) && elapsed >= 0);
  const attempts = visibleTimings.reduce((total, timing) => {
    const value = Number(timing.attempts);
    return total + (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  }, 0);
  const timeoutReason = visibleTimings.find((timing) =>
    typeof timing.timeoutReason === "string" && timing.timeoutReason
  )?.timeoutReason;
  const agentStatuses: AaisGuideMutationRuntimeSummary["agentStatuses"] = [];
  for (const turn of result.visibleTurns) {
    if ((turn.agentId === "A1" || turn.agentId === "A2") && !agentStatuses.some((entry) =>
      entry.agentId === turn.agentId
    )) {
      agentStatuses.push({
        agentId: turn.agentId,
        status: visibleTimings.find((timing) => timing.agentId === turn.agentId)?.status
          ?? "completed",
      });
    }
  }
  return {
    engine: typeof result.runtime.engine === "string" && result.runtime.engine
      ? result.runtime.engine
      : "aais-guide-runtime",
    status: typeof result.runtime.status === "string" && result.runtime.status
      ? result.runtime.status
      : "completed",
    visibleMs: elapsedValues.length ? Math.max(...elapsedValues) : 0,
    attempts,
    fallback: visibleTimings.some((timing) => timing.fallback === true),
    timeoutReason: typeof timeoutReason === "string" ? timeoutReason : null,
    agentStatuses,
  };
}

function getVisibleGuideTimings(
  result: Awaited<ReturnType<typeof runAaisLearningGuideGraph>>,
) {
  const visibleAgentIds = new Set(result.visibleTurns.map((turn) => turn.agentId));
  return result.runtime.timings.agents.filter((timing) => visibleAgentIds.has(timing.agentId));
}

function createVisibleGuideTopologicalOrder(
  result: Awaited<ReturnType<typeof runAaisLearningGuideGraph>>,
) {
  const visibleAgentIds = new Set(result.visibleTurns.map((turn) => turn.agentId));
  return result.graph.topologicalOrder.filter((agentId) => visibleAgentIds.has(agentId));
}

function createPersistedGuideOrchestration(
  result: Awaited<ReturnType<typeof runAaisLearningGuideGraph>>,
) {
  return {
    graphId: result.graph.graphId,
    topologicalOrder: createVisibleGuideTopologicalOrder(result),
    threadId: result.runtime.threadId,
  };
}

function isGuideStreamRequest(request: Request) {
  const acceptsStream = request.headers.get("accept")?.includes("text/event-stream") ?? false;
  const streamParam = new URL(request.url).searchParams.get("stream") === "1";
  return acceptsStream || streamParam;
}

type AaisGuideRunDeadline = {
  signal: AbortSignal;
  abort(reason?: Error): void;
  dispose(): void;
};

class AaisGuideRouteDeadlineError extends Error {
  constructor() {
    super("AAIS guide request exceeded its bounded runtime.");
    this.name = "AaisGuideRouteDeadlineError";
  }
}

function createGuideAbortError() {
  const error = new Error("AAIS guide request was cancelled.");
  error.name = "AbortError";
  return error;
}

function createGuideRunDeadline(requestSignal: AbortSignal): AaisGuideRunDeadline {
  const controller = new AbortController();
  const abort = (reason: Error = createGuideAbortError()) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };
  const abortFromRequest = () => abort(createGuideAbortError());
  const deadlineTimer = setTimeout(() => {
    abort(new AaisGuideRouteDeadlineError());
  }, guideRouteTotalDeadlineMs);

  if (requestSignal.aborted) {
    abortFromRequest();
  } else {
    requestSignal.addEventListener("abort", abortFromRequest, { once: true });
  }

  return {
    signal: controller.signal,
    abort,
    dispose() {
      clearTimeout(deadlineTimer);
      requestSignal.removeEventListener("abort", abortFromRequest);
    },
  };
}

async function runGuideGraphWithSignal(
  input: Parameters<typeof runAaisLearningGuideGraph>[0],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  let abortListener: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(
      signal.reason instanceof Error ? signal.reason : createGuideAbortError(),
    );
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) {
      abortListener();
    }
  });
  try {
    signal.throwIfAborted();
    return await Promise.race([
      runAaisLearningGuideGraph(input, { signal }),
      aborted,
    ]);
  } finally {
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

function createCompletedGuideReplayStreamResponse(
  replay: AaisCompletedGuideMutationReplay,
) {
  const events: string[] = [];
  const send = (event: string, data: Record<string, unknown>) => {
    events.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send("ack", {
    status: "accepted",
    graphId: replay.orchestration.graphId,
    budget: replay.budget,
  });
  for (const turn of replay.turns) {
    send("agent_start", { agentId: turn.agentId });
    send("agent_delta", {
      agentId: turn.agentId,
      content: turn.content,
      ...(turn.visualizations?.length ? { visualizations: turn.visualizations } : {}),
    });
    send("agent_done", {
      agentId: turn.agentId,
      status: replay.runtime.agentStatuses.find((status) =>
        status.agentId === turn.agentId
      )?.status ?? "completed",
    });
  }
  if (replay.runtime.fallback) {
    send("fallback", { timeoutReason: replay.runtime.timeoutReason });
  }
  send("done", {
    status: "completed",
    exchange: replay.exchange,
  });
  return new Response(events.join(""), {
    status: 200,
    headers: {
      "content-type": "text/event-stream;charset=utf-8",
      "cache-control": "private, no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

function createGuideStreamResponse(input: {
  input: Parameters<typeof runAaisLearningGuideGraph>[0];
  store: ReturnType<typeof getAaisLearningStore>;
  question: string;
  budget: AaisGuideDailyBudget;
  attachmentMetadata: ReturnType<typeof toAaisGuideAttachmentMetadata>[];
  rawTextWriteLease: AaisResearchRawTextWriteLease | null;
  runDeadline: AaisGuideRunDeadline;
  reservationId: string;
  interactionMode: AaisGuideInteractionMode;
  metered: boolean;
  dataGeneration: number;
  guideMutationReceipt: AaisGuideMutationReceipt | null;
}) {
  const encoder = new TextEncoder();
  const runDeadline = input.runDeadline;
  let downstreamCancelled = false;

  const execute = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    let budgetCommitted = false;
    let budgetDispatched = false;
    let capacityConsumed = false;
    let guideMutationCompleted = false;
    const enqueue = (payload: string) => {
      if (downstreamCancelled || runDeadline.signal.aborted) {
        return false;
      }
      try {
        controller.enqueue(encoder.encode(payload));
        return true;
      } catch {
        downstreamCancelled = true;
        runDeadline.abort(createGuideAbortError());
        return false;
      }
    };
    const send = (event: string, data: Record<string, unknown>) => enqueue(
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    );
    const heartbeatTimer = setInterval(() => {
      enqueue(": aais-heartbeat\n\n");
    }, guideStreamHeartbeatIntervalMs);
    try {
        runDeadline.signal.throwIfAborted();
        const targetAgentIds = selectAaisGuideReplyAgentIds(input.input.learnerInput);
        if (input.metered) {
          await dispatchGuideBudgetReservation({
            store: input.store,
            studentId: input.input.studentId,
            reservation: {
              reservationId: input.reservationId,
              budget: input.budget,
              dataGeneration: input.dataGeneration,
              metered: true,
            },
          });
          budgetDispatched = true;
        }
        send("ack", {
          status: "accepted",
          graphId: "learning-ai-guide",
          budget: input.budget,
        });
        for (const agentId of targetAgentIds) {
          send("agent_start", { agentId });
        }

        const result = await runGuideGraphWithSignal(input.input, runDeadline.signal);
        runDeadline.signal.throwIfAborted();
        const persistedExchange = await input.store.appendGuideExchange({
          studentId: input.input.studentId,
          phase: input.input.phase,
          taskId: input.input.taskId,
          question: input.question,
          answer: result.messageText,
          interactionMode: input.interactionMode,
          ...(input.attachmentMetadata.length
            ? { attachments: input.attachmentMetadata }
            : {}),
          turns: result.visibleTurns,
          orchestration: createPersistedGuideOrchestration(result),
          ...(input.guideMutationReceipt
            ? {
                guideMutation: {
                  receipt: input.guideMutationReceipt,
                  runtime: createGuideMutationRuntimeSummary(result),
                  budget: input.budget,
                },
              }
            : {}),
          ...(input.metered ? { budgetReservationId: input.reservationId } : {}),
          capacityReservationId: input.reservationId,
          dataGeneration: input.dataGeneration,
        });
        capacityConsumed = true;
        guideMutationCompleted = input.guideMutationReceipt !== null;
        if (input.metered) {
          budgetCommitted = true;
          recordGuideBudgetAudit({
            studentId: input.input.studentId,
            event: "ai.guide.budget.used",
            outcome: "success",
            budget: input.budget,
          });
        }

        for (const turn of result.visibleTurns) {
          send("agent_delta", {
            agentId: turn.agentId,
            content: turn.content,
            ...(turn.visualizations?.length
              ? { visualizations: turn.visualizations }
              : {}),
          });
          send("agent_done", {
            agentId: turn.agentId,
            status: result.runtime.timings.agents.find((agent) => agent.agentId === turn.agentId)?.status,
          });
        }
        const visibleTimings = getVisibleGuideTimings(result);
        if (visibleTimings.some((timing) => timing.fallback)) {
          send("fallback", {
            timeoutReason: visibleTimings.find((timing) => timing.timeoutReason)?.timeoutReason ?? null,
          });
        }
        send("done", {
          status: "completed",
          exchange: persistedExchange.exchange,
        });
      } catch {
        if (!runDeadline.signal.aborted && !downstreamCancelled) {
          send("error", {
            ...createAaisApiErrorBody(
              "AAIS_GUIDE_STREAM_FAILED",
              "AAIS guide stream failed.",
            ),
          });
        }
      } finally {
        clearInterval(heartbeatTimer);
        if (!capacityConsumed) {
          await releaseGuideCapacityReservation({
            store: input.store,
            studentId: input.input.studentId,
            reservation: {
              reservationId: input.reservationId,
              budget: input.budget,
              dataGeneration: input.dataGeneration,
              metered: input.metered,
            },
          });
        }
        if (input.metered && !budgetCommitted && !budgetDispatched) {
          await releaseGuideBudgetReservation({
            store: input.store,
            studentId: input.input.studentId,
            reservation: {
              reservationId: input.reservationId,
              budget: input.budget,
              dataGeneration: input.dataGeneration,
              metered: true,
            },
          });
        }
        if (input.guideMutationReceipt && !guideMutationCompleted) {
          try {
            await input.store.releaseGuideMutation({
              studentId: input.input.studentId,
              receipt: input.guideMutationReceipt,
              dataGeneration: input.dataGeneration,
            });
          } catch {
            // The bounded lease still allows a same-payload retry after a
            // process-level cleanup failure.
          }
        }
        try {
          await input.rawTextWriteLease?.release();
        } catch {
          send("error", {
            ...createAaisApiErrorBody(
              "AAIS_RESEARCH_RAW_TEXT_LEASE_RELEASE_FAILED",
              "AAIS research write coordination failed.",
            ),
          });
        }
        runDeadline.dispose();
        try {
          controller.close();
        } catch {
          // The consumer may already have cancelled the stream.
        }
      }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void execute(controller);
    },
    cancel() {
      downstreamCancelled = true;
      runDeadline.abort(createGuideAbortError());
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream;charset=utf-8",
      "cache-control": "private, no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

type AaisGuideDailyBudget = {
  limit: number;
  used: number;
  remaining: number;
  resetsAt: string;
};

type AaisGuideBudgetReservation = {
  reservationId: string;
  budget: AaisGuideDailyBudget;
  dataGeneration: number;
  metered: boolean;
};

class AaisGuideDailyBudgetError extends Error {
  constructor(readonly budget: AaisGuideDailyBudget) {
    super("AAIS daily guide request budget has been reached.");
    this.name = "AaisGuideDailyBudgetError";
  }
}

async function reserveDailyGuideBudget(
  studentId: string,
  dataGeneration: number,
  store: ReturnType<typeof getAaisLearningStore>,
  interactionMode: AaisGuideInteractionMode,
): Promise<AaisGuideBudgetReservation> {
  const limit = readDailyGuideLimit();
  if (interactionMode === "deterministic-local") {
    const usage = await store.getDailyGuideUsage(studentId);
    return {
      reservationId: randomUUID(),
      budget: {
        limit,
        used: usage.used,
        remaining: Math.max(0, limit - usage.used),
        resetsAt: usage.end,
      },
      dataGeneration,
      metered: false,
    };
  }
  const reservationId = randomUUID();
  const reservation = await store.reserveDailyGuideRequest({
    reservationId,
    studentId,
    limit,
    dataGeneration,
  });
  const budget: AaisGuideDailyBudget = {
    limit: reservation.limit,
    used: reservation.used,
    remaining: reservation.remaining,
    resetsAt: reservation.resetsAt,
  };
  if (reservation.status === "exhausted") {
    recordGuideBudgetAudit({
      studentId,
      event: "ai.guide.budget.exceeded",
      outcome: "failure",
      budget,
    });
    throw new AaisGuideDailyBudgetError(budget);
  }
  if (!reservation.reservationId) {
    throw new Error("AAIS guide budget reservation was not created.");
  }
  return {
    reservationId: reservation.reservationId,
    budget,
    dataGeneration,
    metered: true,
  };
}

async function releaseGuideBudgetReservation(input: {
  store: ReturnType<typeof getAaisLearningStore>;
  studentId: string;
  reservation: AaisGuideBudgetReservation;
}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const released = await input.store.finalizeDailyGuideRequest({
        reservationId: input.reservation.reservationId,
        studentId: input.studentId,
        outcome: "released",
        dataGeneration: input.reservation.dataGeneration,
      });
      if (released.status === "released") {
        recordGuideBudgetAudit({
          studentId: input.studentId,
          event: "ai.guide.budget.released",
          outcome: "success",
          budget: input.reservation.budget,
        });
      }
      return;
    } catch {
      if (attempt === 1) {
        recordGuideBudgetAudit({
          studentId: input.studentId,
          event: "ai.guide.budget.release_failed",
          outcome: "failure",
          budget: input.reservation.budget,
        });
      }
    }
  }
}

async function releaseGuideCapacityReservation(input: {
  store: ReturnType<typeof getAaisLearningStore>;
  studentId: string;
  reservation: AaisGuideBudgetReservation;
}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await input.store.releaseGuideExchangeCapacity({
        studentId: input.studentId,
        reservationId: input.reservation.reservationId,
        dataGeneration: input.reservation.dataGeneration,
      });
      return;
    } catch {
      // A bounded retry handles a lost CAS response. An expired reservation is
      // ignored by capacity accounting even if both cleanup attempts fail.
    }
  }
}

async function dispatchGuideBudgetReservation(input: {
  store: ReturnType<typeof getAaisLearningStore>;
  studentId: string;
  reservation: AaisGuideBudgetReservation;
}) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const dispatched = await input.store.finalizeDailyGuideRequest({
        reservationId: input.reservation.reservationId,
        studentId: input.studentId,
        outcome: "dispatched",
        dataGeneration: input.reservation.dataGeneration,
      });
      if (dispatched.status !== "dispatched") {
        throw new Error("AAIS guide budget reservation could not be dispatched.");
      }
      recordGuideBudgetAudit({
        studentId: input.studentId,
        event: "ai.guide.budget.dispatched",
        outcome: "success",
        budget: input.reservation.budget,
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("AAIS guide budget reservation dispatch failed.");
}

function readDailyGuideLimit() {
  const configured = Number(process.env.AAIS_AI_DAILY_GUIDE_LIMIT);
  if (!Number.isFinite(configured) || configured <= 0) {
    return defaultDailyGuideLimit;
  }
  return Math.min(maxDailyGuideLimit, Math.floor(configured));
}

function recordGuideBudgetAudit(input: {
  studentId: string;
  event:
    | "ai.guide.budget.used"
    | "ai.guide.budget.dispatched"
    | "ai.guide.budget.exceeded"
    | "ai.guide.budget.released"
    | "ai.guide.budget.release_failed";
  outcome: "success" | "failure";
  budget: AaisGuideDailyBudget;
}) {
  recordAaisAuditEvent({
    event: input.event,
    actorId: input.studentId,
    outcome: input.outcome,
    metadata: {
      limit: input.budget.limit,
      used: input.budget.used,
      remaining: input.budget.remaining,
      resetsAt: input.budget.resetsAt,
    },
  });
}
