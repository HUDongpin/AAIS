import { createHash, randomUUID } from "node:crypto";
import { after, NextResponse } from "next/server";
import { guideStreamHeartbeatIntervalMs } from "@/components/pages/learning/learning-page-constants";
import {
  runAaisLearningGuideGraph,
  type AaisGuideInput,
} from "@/lib/ai/orchestration/aais-learning-guide-graph";
import {
  preflightConfiguredAaisModelProvider,
  type AaisProviderDispatchFence,
  type AaisModelProvider,
} from "@/lib/ai/aais-ai-provider";
import {
  isAaisGuideDeliveryError,
  type AaisGuideDeliveryReceiptV1,
  type AaisGuidePublicErrorCode,
  type AaisGuidePublicErrorV1,
  type AaisGuideRuntimeDeliveryReceiptV1,
} from "@/lib/ai/aais-guide-delivery";
import {
  AaisLearnerDataGenerationConflictError,
  getAaisLearningStore,
  isAaisLearnerDataGenerationConflictError,
  isAaisLearnerSessionLimitError,
  isAaisLearningStorageConfigurationError,
  isAaisSessionWriteConflictError,
  type AaisGuideMessageRecord,
  type AaisPersistedGuideDelivery,
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
  createAaisApiErrorResponse,
  isAaisApiRouteError,
} from "@/lib/server/aais-api-error";
import { recordAaisAuditEvent } from "@/lib/server/aais-audit-log";
import {
  projectAaisGuideProviderAttemptsForDiagnostic,
  recordAaisAiGuideDiagnostic,
} from "@/lib/server/aais-ai-guide-diagnostics";
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type AaisGuideRequestBody = {
  dataGeneration: number;
  operationId?: string;
  locale?: Locale;
  studentId?: string;
  phase?: AaisPhase;
  taskId?: string;
  learnerInput: string;
  targetAgentIds?: string[];
  workspaceState?: {
    currentStep?: string;
    artifactText?: string;
    helpRequestsUsed?: number;
    attachments?: unknown;
  };
};

const defaultDailyGuideLimit = 40;
const maxDailyGuideLimit = 200;
const maxGuideLearnerInputCharacters = 20_000;
const maxGuideWorkspaceArtifactCharacters = 2 * 1024 * 1024;
const maxGuideWorkspaceStepCharacters = 128;
const maxGuideHelpRequests = 4;
const maxGuideTargetAgents = 1;
const maxGuideRequestBodyBytes = 16 * 1024 * 1024;
const maxGuideConversationHistoryMessages = 12;
const maxGuideConversationHistoryCharacters = 16_000;
export const guideRouteFinalizeGuardMs = 6_000;
export const guideRouteTotalDeadlineMs = 30_000;
export const guideProviderMaximumRetryBudgetMs = guideRouteTotalDeadlineMs
  - guideRouteFinalizeGuardMs;
export const guideRouteMaximumDeadlineMs = guideRouteTotalDeadlineMs;
const guideDeliveryBudgetDispositions = new WeakMap<
  object,
  "released" | "dispatched-uncertain"
>();

export async function POST(request: Request) {
  const requestStartedAt = Date.now();
  const requestAttemptId = randomUUID();
  const transport = isGuideStreamRequest(request) ? "sse" as const : "json" as const;
  let operationId: string = requestAttemptId;
  let diagnosticId: string = requestAttemptId;
  let guideRunDeadline: AaisGuideRunDeadline | null = createGuideRunDeadline(
    request.signal,
    requestStartedAt + guideRouteTotalDeadlineMs,
  );
  try {
    const actor = await awaitGuideRunDeadline(
      requireAaisSessionActor(request),
      guideRunDeadline,
    );
    const studentId = actor.id;
    requireAaisCsrf(request, studentId);
    const body = requireGuideRequestBody(await awaitGuideRunDeadline(
      readAaisBoundedJson(request, {
        maxBytes: maxGuideRequestBodyBytes,
      }),
      guideRunDeadline,
    ));
    operationId = body.operationId ?? randomUUID();
    diagnosticId = createGuideDiagnosticId(operationId);
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
    let rawTextWriteLease: AaisResearchRawTextWriteLease | null = null;
    let guideBudgetReservation: AaisGuideBudgetReservation | null = null;
    let guideBudgetCommitted = false;
    let guideBudgetDispatched = false;
    let guideCapacityReserved = false;
    try {
      const session = await awaitGuideRunDeadline(
        store.readSession(studentId),
        guideRunDeadline,
      );
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
      const task = requireGuideTask(session, body.taskId);
      const helpRequestsUsed = countPersistedLiveA1Scaffolds(
        session.guideMessages,
        task.taskId,
      );
      const payloadDigest = createGuidePayloadDigest({
        body,
        targetAgentIds,
        attachments,
      });
      const existingOperation = await awaitGuideRunDeadline(
        store.hasDailyGuideOperation({
          studentId,
          dataGeneration: body.dataGeneration,
          operationId,
        }),
        guideRunDeadline,
      );
      if (existingOperation) {
        const existingClaimPromise = reserveDailyGuideBudget(
          studentId,
          body.dataGeneration,
          store,
          operationId,
          payloadDigest,
        );
        let existingClaim: AaisGuideBudgetClaim;
        try {
          existingClaim = await awaitGuideRunDeadline(
            existingClaimPromise,
            guideRunDeadline,
          );
        } catch (error) {
          releaseLateGuideBudgetReservation({
            claimPromise: existingClaimPromise,
            store,
            studentId,
          });
          throw error;
        }
        if (existingClaim.claimStatus === "reserved") {
          throw new Error("AAIS existing guide operation was unexpectedly reserved again.");
        }
        await settleFailedGuideClaimCapacityBeforeResponse({
          claim: existingClaim,
          store,
          studentId,
          deadline: guideRunDeadline,
        });
        return await awaitGuideRunDeadline(
          createGuideOperationClaimResponse({
            claim: existingClaim,
            request,
            store,
            studentId,
            operationId,
            diagnosticId,
            requestAttemptId,
            transport,
            latencyMs: Date.now() - requestStartedAt,
          }),
          guideRunDeadline,
        );
      }
      guideRunDeadline.signal.throwIfAborted();
      const providerPreflight = await awaitGuideRunDeadline(
        Promise.resolve().then(() => preflightConfiguredAaisModelProvider()),
        guideRunDeadline,
      );
      guideRunDeadline.signal.throwIfAborted();
      const evalManifestDigests: AaisGuideEvalManifestDigests = {
        ...(providerPreflight.evaluation.primary?.manifest.manifestSha256
          ? { primary: providerPreflight.evaluation.primary.manifest.manifestSha256 }
          : {}),
        ...(providerPreflight.evaluation.fallback?.manifest.manifestSha256
          ? { secondary: providerPreflight.evaluation.fallback.manifest.manifestSha256 }
          : {}),
      };
      const rawTextWriteLeasePromise = acquireAaisResearchRawTextWriteLeaseIfRequired(actor);
      try {
        rawTextWriteLease = await awaitGuideRunDeadline(
          rawTextWriteLeasePromise,
          guideRunDeadline,
        );
      } catch (error) {
        releaseLateAcquiredGuideRawTextLease({
          leasePromise: rawTextWriteLeasePromise,
          diagnosticId,
          operationId,
          requestAttemptId,
          transport,
          latencyMs: Date.now() - requestStartedAt,
        });
        throw error;
      }
      const guideBudgetClaimPromise = reserveDailyGuideBudget(
        studentId,
        body.dataGeneration,
        store,
        operationId,
        payloadDigest,
      );
      let guideBudgetClaim: AaisGuideBudgetClaim;
      try {
        guideBudgetClaim = await awaitGuideRunDeadline(
          guideBudgetClaimPromise,
          guideRunDeadline,
        );
      } catch (error) {
        releaseLateGuideBudgetReservation({
          claimPromise: guideBudgetClaimPromise,
          store,
          studentId,
        });
        throw error;
      }
      if (guideBudgetClaim.claimStatus !== "reserved") {
        await settleFailedGuideClaimCapacityBeforeResponse({
          claim: guideBudgetClaim,
          store,
          studentId,
          deadline: guideRunDeadline,
        });
        return await awaitGuideRunDeadline(
          createGuideOperationClaimResponse({
            claim: guideBudgetClaim,
            request,
            store,
            studentId,
            operationId,
            diagnosticId,
            requestAttemptId,
            transport,
            latencyMs: Date.now() - requestStartedAt,
          }),
          guideRunDeadline,
        );
      }
      guideBudgetReservation = guideBudgetClaim;
      const budget = guideBudgetReservation.budget;
      guideRunDeadline.signal.throwIfAborted();
      const capacityReservationPromise = store.reserveGuideExchangeCapacity({
        studentId,
        reservationId: guideBudgetReservation.reservationId,
        dataGeneration: body.dataGeneration,
      });
      try {
        await awaitGuideRunDeadline(
          capacityReservationPromise,
          guideRunDeadline,
        );
      } catch (error) {
        releaseLateGuideCapacityReservation({
          reservationPromise: capacityReservationPromise,
          store,
          studentId,
          reservation: guideBudgetReservation,
        });
        throw error;
      }
      guideCapacityReserved = true;
      const input: AaisGuideInput = {
        locale: body.locale === "en-US" ? "en-US" : "zh-CN",
        studentId,
        phase: task.phase,
        taskId: task.taskId,
        learnerInput: body.learnerInput,
        providerDeadlineAt: requestStartedAt + guideProviderMaximumRetryBudgetMs,
        conversationHistory: buildBoundedGuideConversationHistory(
          session.guideMessages.filter((message) =>
            message.taskId === task.taskId
            && message.phase === task.phase
          ),
        ),
        targetAgentIds,
        workspaceState: {
          currentStep: body.workspaceState?.currentStep ?? "smart-guide",
          artifactText: body.workspaceState?.artifactText,
          helpRequestsUsed,
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
          dataGeneration: body.dataGeneration,
          operationId,
          diagnosticId,
          requestAttemptId,
          requestStartedAt,
          modelProvider: providerPreflight.provider,
          deliveryPolicy: providerPreflight.deliveryPolicy,
          evalManifestDigests,
        });
        guideRunDeadline = null;
        rawTextWriteLease = null;
        guideCapacityReserved = false;
        guideBudgetReservation = null;
        return response;
      }

      guideRunDeadline.signal.throwIfAborted();
      assertGuideProviderWindowAvailable(input.providerDeadlineAt, guideRunDeadline);
      input.providerDispatchFence = createGuideProviderDispatchFence({
          store,
          studentId,
          reservation: guideBudgetReservation,
          providerDeadlineAt: input.providerDeadlineAt ?? guideRunDeadline.deadlineAt,
          runDeadline: guideRunDeadline,
          onDispatched: () => {
            guideBudgetDispatched = true;
          },
          onReleased: () => {
            guideBudgetDispatched = false;
          },
        });
      const result = await runGuideGraphWithSignal(
        input,
        guideRunDeadline.signal,
        providerPreflight.provider,
        providerPreflight.deliveryPolicy,
      ).catch((error: unknown) => {
        annotateGuideDeliveryBudgetDisposition(error, guideBudgetDispatched);
        throw error;
      });
      guideRunDeadline.signal.throwIfAborted();
      const delivery = createGuidePublicDeliveryReceiptFromResult(
        result,
        diagnosticId,
        providerPreflight.deliveryPolicy === "require-live",
      );
      const appendGuideExchangePromise = store.appendGuideExchange({
          operationId,
          studentId,
          phase: task.phase,
          taskId: task.taskId,
          question: body.learnerInput,
          answer: result.messageText,
          ...(attachmentMetadata.length ? { attachments: attachmentMetadata } : {}),
          turns: result.visibleTurns,
          orchestration: createPersistedGuideOrchestration(result, delivery),
          budgetReservationId: guideBudgetReservation.reservationId,
          capacityReservationId: guideBudgetReservation.reservationId,
          dataGeneration: body.dataGeneration,
          deadlineAt: guideRunDeadline.deadlineAt,
        });
      try {
        await awaitGuideRunDeadline(
          appendGuideExchangePromise,
          guideRunDeadline,
        );
        guideRunDeadline.signal.throwIfAborted();
      } catch (error) {
        if (guideRunDeadline.signal.aborted) {
          transferTimedOutGuidePersistenceCleanup({
            appendPromise: appendGuideExchangePromise,
            store,
            studentId,
            reservation: guideBudgetReservation,
            lease: rawTextWriteLease,
            diagnosticId,
            operationId,
            requestAttemptId,
            transport,
            latencyMs: Date.now() - requestStartedAt,
          });
          rawTextWriteLease = null;
          guideCapacityReserved = false;
          throw error;
        }
        if (shouldPreserveGuideAppendError(error)) {
          throw error;
        }
        throw new AaisGuidePersistenceError();
      }
      guideBudgetCommitted = true;
      guideCapacityReserved = false;
      recordGuideBudgetAudit({
        event: "ai.guide.budget.used",
        outcome: "success",
        budget,
      });
      recordGuideSuccessDiagnostic({
        result,
        delivery,
        operationId,
        diagnosticId,
        requestAttemptId,
        transport,
        locale: input.locale,
        evalManifestDigest: delivery
          ? evalManifestDigests[delivery.channel]
          : undefined,
        latencyMs: Date.now() - requestStartedAt,
      });

      return NextResponse.json(
        {
          ...createGuideJsonBody(result, delivery),
          budget,
        },
        {
          headers: {
            "cache-control": "private, no-store",
          },
        },
      );
    } finally {
      if (guideRunDeadline && guideBudgetReservation && guideCapacityReserved) {
        await settleGuideCleanupBeforeResponse(
          releaseGuideCapacityReservation({
            store,
            studentId,
            reservation: guideBudgetReservation,
          }),
          guideRunDeadline,
          guideBudgetCommitted,
        );
      }
      if (
        guideRunDeadline
        && guideBudgetReservation
        && !guideBudgetCommitted
        && !guideBudgetDispatched
      ) {
        await settleGuideCleanupBeforeResponse(
          releaseGuideBudgetReservation({
            store,
            studentId,
            reservation: guideBudgetReservation,
          }),
          guideRunDeadline,
          false,
        );
      }
      if (guideRunDeadline) {
        await settleGuideCleanupBeforeResponse(
          releaseGuideRawTextLeaseSafely({
            lease: rawTextWriteLease,
            diagnosticId,
            operationId,
            requestAttemptId,
            transport,
            latencyMs: Date.now() - requestStartedAt,
            budgetDisposition: guideBudgetCommitted
              ? "charged-once"
              : guideBudgetDispatched
                ? "dispatched-uncertain"
                : guideBudgetReservation
                  ? "released"
                  : "not-reserved",
          }),
          guideRunDeadline,
          guideBudgetCommitted,
        );
      }
    }
  } catch (error) {
    return createGuideErrorResponse({
      error,
      diagnosticId,
      operationId,
      requestAttemptId,
      transport,
      latencyMs: Date.now() - requestStartedAt,
    });
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
  const operationId = requireGuideOptionalUuid(value.operationId, "operationId");
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
  const taskId = requireGuideOptionalSafeId(value.taskId, "taskId");
  const targetAgentIds = requireGuideTargetAgentIds(value.targetAgentIds);
  const workspaceState = requireGuideWorkspaceState(value.workspaceState);

  return {
    dataGeneration,
    ...(operationId ? { operationId } : {}),
    learnerInput,
    ...(locale ? { locale } : {}),
    ...(phase ? { phase } : {}),
    ...(studentId ? { studentId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(targetAgentIds ? { targetAgentIds } : {}),
    ...(workspaceState ? { workspaceState } : {}),
  };
}

function requireGuideOptionalUuid(value: unknown, field: string) {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw invalidGuideField(field);
  }
  return value.toLowerCase();
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
  if (task.status === "locked") {
    throw new AaisApiRouteError({
      code: "AAIS_TASK_LOCKED",
      message: "AAIS task is locked.",
      status: 400,
    });
  }
  return task;
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

function countPersistedLiveA1Scaffolds(
  messages: AaisGuideMessageRecord[],
  taskId: string,
) {
  return Math.min(
    maxGuideHelpRequests,
    messages.filter((message) =>
      message.kind === "assistant"
      && message.taskId === taskId
      && message.orchestration?.delivery?.responseMode === "live"
      && message.turns?.some((turn) => turn.agentId === "A1")
    ).length,
  );
}

function createGuidePayloadDigest(input: {
  body: AaisGuideRequestBody;
  targetAgentIds: string[];
  attachments: ReturnType<typeof normalizeGuideAttachments>;
}) {
  return createHash("sha256")
    .update(JSON.stringify([
      "aais-guide-operation-v1",
      input.body.dataGeneration,
      input.body.locale ?? "zh-CN",
      input.body.taskId ?? null,
      input.body.phase ?? null,
      input.body.learnerInput,
      input.targetAgentIds,
      input.body.workspaceState?.currentStep ?? "smart-guide",
      input.body.workspaceState?.artifactText ?? null,
      input.attachments,
    ]), "utf8")
    .digest("hex");
}

function createGuideDiagnosticId(operationId: string) {
  const bytes = createHash("sha256")
    .update(`aais-guide-diagnostic-v1:${operationId}`, "utf8")
    .digest()
    .subarray(0, 16);
  // Render a deterministic, opaque RFC 4122 UUID. It can be reconstructed for
  // an idempotent replay without storing the support code in learner data.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
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

function createGuideErrorResponse(input: {
  error: unknown;
  diagnosticId: string;
  operationId: string;
  requestAttemptId: string;
  transport: "json" | "sse";
  latencyMs: number;
}) {
  const publicError = resolveGuidePublicFailure(input);
  if (publicError) {
    return createGuidePublicErrorResponse(publicError);
  }
  return createAaisApiErrorResponse(getErrorResponseInput(input.error));
}

type AaisGuidePublicErrorDescriptor = {
  status: number;
  code: AaisGuidePublicErrorCode;
  message: string;
  diagnosticId: string;
  retryable: boolean;
  learnerAction: "retry" | "rephrase" | "contact-support";
};

function resolveGuidePublicFailure(input: {
  error: unknown;
  diagnosticId: string;
  operationId: string;
  requestAttemptId: string;
  transport: "json" | "sse";
  latencyMs: number;
  budgetDisposition?: "released" | "dispatched-uncertain";
}): AaisGuidePublicErrorDescriptor | null {
  if (isAaisGuideDeliveryError(input.error)) {
    const publicError = mapGuideDeliveryError(input.error);
    const providerAttempts = projectAaisGuideProviderAttemptsForDiagnostic(
      input.error.attempts,
    );
    const diagnosticAttempt = [...providerAttempts].reverse().find((attempt) =>
      attempt.attempts > 0
    ) ?? providerAttempts.at(-1);
    const lastCoreAttempt = [...input.error.attempts].reverse().find((attempt) =>
      attempt.attempts > 0
    ) ?? input.error.attempts.at(-1);
    const reason = diagnosticAttempt?.reason
      ?? mapGuideDeliveryDiagnosticReason(lastCoreAttempt?.reason, input.error.code);
    const providerWasDispatched = input.error.attempts.some((attempt) =>
      attempt.attempts > 0
    );
    const knownBudgetDisposition = guideDeliveryBudgetDispositions.get(input.error)
      ?? input.budgetDisposition;
    recordAaisAiGuideDiagnostic({
      event: "aais.ai.guide.failed",
      outcome: "failed",
      category: mapGuideDeliveryDiagnosticCategory(input.error.code, reason),
      reason,
      providerRole: diagnosticAttempt?.role ?? "none",
      retryable: publicError.retryable,
      attempts: input.error.attempts.reduce((total, attempt) => total + attempt.attempts, 0),
      providerAttempts,
      latencyMs: input.latencyMs,
      persistence: "not-started",
      budgetDisposition: knownBudgetDisposition
        ?? (providerWasDispatched ? "dispatched-uncertain" : "not-reserved"),
      transport: input.transport,
      diagnosticId: input.diagnosticId,
      operationId: input.operationId,
      requestAttemptId: input.requestAttemptId,
    });
    return {
      ...publicError,
      diagnosticId: input.diagnosticId,
    };
  }
  if (input.error instanceof AaisGuideLiveReceiptMissingError) {
    recordAaisAiGuideDiagnostic({
      event: "aais.ai.guide.failed",
      outcome: "failed",
      category: "orchestration",
      reason: "orchestration_error",
      retryable: false,
      latencyMs: input.latencyMs,
      persistence: "not-started",
      budgetDisposition: "charged-once",
      transport: input.transport,
      diagnosticId: input.diagnosticId,
      operationId: input.operationId,
      requestAttemptId: input.requestAttemptId,
    });
    return {
      status: 503,
      code: "AI_LIVE_NOT_READY",
      message: "The live AI response could not be verified.",
      diagnosticId: input.diagnosticId,
      retryable: false,
      learnerAction: "contact-support",
    };
  }
  if (input.error instanceof AaisGuidePersistenceError) {
    recordAaisAiGuideDiagnostic({
      event: "aais.ai.guide.failed",
      outcome: "failed",
      category: "persistence",
      reason: "persistence_failed",
      retryable: true,
      latencyMs: input.latencyMs,
      persistence: "failed",
      budgetDisposition: "charged-once",
      transport: input.transport,
      diagnosticId: input.diagnosticId,
      operationId: input.operationId,
      requestAttemptId: input.requestAttemptId,
    });
    return {
      status: 503,
      code: "AI_PERSISTENCE_FAILED",
      message: "The live AI response could not be saved. Your question remains on this page.",
      diagnosticId: input.diagnosticId,
      retryable: true,
      learnerAction: "retry",
    };
  }
  if (input.error instanceof AaisGuideOrchestrationError) {
    recordAaisAiGuideDiagnostic({
      event: "aais.ai.guide.failed",
      outcome: "failed",
      category: "orchestration",
      reason: "orchestration_error",
      retryable: true,
      latencyMs: input.latencyMs,
      persistence: "not-started",
      budgetDisposition: "charged-once",
      transport: input.transport,
      diagnosticId: input.diagnosticId,
      operationId: input.operationId,
      requestAttemptId: input.requestAttemptId,
    });
    return {
      status: 503,
      code: "AI_LIVE_UNAVAILABLE",
      message: "The live AI request could not be completed. Your question remains on this page.",
      diagnosticId: input.diagnosticId,
      retryable: true,
      learnerAction: "retry",
    };
  }
  if (input.error instanceof AaisGuideRouteDeadlineError) {
    const providerWindowExpired = input.error.stage === "provider-window";
    recordAaisAiGuideDiagnostic({
      event: "aais.ai.guide.failed",
      outcome: "failed",
      category: "deadline",
      reason: "route_deadline",
      retryable: true,
      ...(providerWindowExpired ? { attempts: 0 } : {}),
      latencyMs: input.latencyMs,
      persistence: providerWindowExpired ? "not-started" : "unknown",
      budgetDisposition: providerWindowExpired
        ? "released"
        : input.budgetDisposition ?? "dispatched-uncertain",
      transport: input.transport,
      diagnosticId: input.diagnosticId,
      operationId: input.operationId,
      requestAttemptId: input.requestAttemptId,
    });
    return {
      status: 504,
      code: "AI_LIVE_TIMEOUT",
      message: "The live AI request exceeded its 30-second deadline.",
      diagnosticId: input.diagnosticId,
      retryable: true,
      learnerAction: "retry",
    };
  }
  if (isGuideAbortError(input.error)) {
    recordAaisAiGuideDiagnostic({
      event: "aais.ai.guide.failed",
      outcome: "failed",
      category: "transport",
      reason: "client_disconnect",
      retryable: true,
      latencyMs: input.latencyMs,
      persistence: "unknown",
      budgetDisposition: "dispatched-uncertain",
      transport: input.transport,
      diagnosticId: input.diagnosticId,
      operationId: input.operationId,
      requestAttemptId: input.requestAttemptId,
    });
    return {
      status: 503,
      code: "AI_LIVE_UNAVAILABLE",
      message: "The live AI connection was interrupted. Your question remains on this page.",
      diagnosticId: input.diagnosticId,
      retryable: true,
      learnerAction: "retry",
    };
  }
  return null;
}

function isGuideAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function annotateGuideDeliveryBudgetDisposition(
  error: unknown,
  budgetDispatched: boolean,
) {
  if (isAaisGuideDeliveryError(error)) {
    guideDeliveryBudgetDispositions.set(
      error,
      budgetDispatched ? "dispatched-uncertain" : "released",
    );
  }
}

function recordAndCreateGuideStreamOrchestrationFailure(input: {
  diagnosticId: string;
  operationId: string;
  requestAttemptId: string;
  latencyMs: number;
  budgetDispatched: boolean;
}): AaisGuidePublicErrorDescriptor {
  recordAaisAiGuideDiagnostic({
    event: "aais.ai.guide.failed",
    outcome: "failed",
    category: "orchestration",
    reason: "orchestration_error",
    retryable: true,
    latencyMs: input.latencyMs,
    persistence: "unknown",
    budgetDisposition: input.budgetDispatched ? "dispatched-uncertain" : "released",
    transport: "sse",
    diagnosticId: input.diagnosticId,
    operationId: input.operationId,
    requestAttemptId: input.requestAttemptId,
  });
  return {
    status: 503,
    code: "AI_LIVE_UNAVAILABLE",
    message: "The live AI request could not be completed. Your question remains on this page.",
    diagnosticId: input.diagnosticId,
    retryable: true,
    learnerAction: "retry",
  };
}

async function releaseGuideRawTextLeaseSafely(input: {
  lease: AaisResearchRawTextWriteLease | null;
  diagnosticId: string;
  operationId: string;
  requestAttemptId: string;
  transport: "json" | "sse";
  latencyMs: number;
  budgetDisposition:
    | "not-reserved"
    | "released"
    | "charged-once"
    | "dispatched-uncertain";
}) {
  try {
    await input.lease?.release();
  } catch {
    recordAaisAiGuideDiagnostic({
      event: "aais.ai.guide.failed",
      outcome: "failed",
      category: "orchestration",
      reason: "orchestration_error",
      retryable: false,
      latencyMs: input.latencyMs,
      persistence: "unknown",
      budgetDisposition: input.budgetDisposition,
      transport: input.transport,
      diagnosticId: input.diagnosticId,
      operationId: input.operationId,
      requestAttemptId: input.requestAttemptId,
    });
  }
}

function releaseLateAcquiredGuideRawTextLease(input: {
  leasePromise: Promise<AaisResearchRawTextWriteLease | null>;
  diagnosticId: string;
  operationId: string;
  requestAttemptId: string;
  transport: "json" | "sse";
  latencyMs: number;
}) {
  startGuideBackgroundTask(input.leasePromise.then((lease) =>
    releaseGuideRawTextLeaseSafely({
      lease,
      diagnosticId: input.diagnosticId,
      operationId: input.operationId,
      requestAttemptId: input.requestAttemptId,
      transport: input.transport,
      latencyMs: input.latencyMs,
      budgetDisposition: "not-reserved",
    })));
}

function transferTimedOutGuidePersistenceCleanup(input: {
  appendPromise: Promise<unknown>;
  store: ReturnType<typeof getAaisLearningStore>;
  studentId: string;
  reservation: AaisGuideReservationContext;
  lease: AaisResearchRawTextWriteLease | null;
  diagnosticId: string;
  operationId: string;
  requestAttemptId: string;
  transport: "json" | "sse";
  latencyMs: number;
}) {
  startGuideBackgroundTask(input.appendPromise.then(
    () => releaseGuideRawTextLeaseSafely({
      lease: input.lease,
      diagnosticId: input.diagnosticId,
      operationId: input.operationId,
      requestAttemptId: input.requestAttemptId,
      transport: input.transport,
      latencyMs: input.latencyMs,
      budgetDisposition: "charged-once",
    }),
    () => Promise.all([
      releaseGuideCapacityReservation({
        store: input.store,
        studentId: input.studentId,
        reservation: input.reservation,
      }),
      releaseGuideRawTextLeaseSafely({
        lease: input.lease,
        diagnosticId: input.diagnosticId,
        operationId: input.operationId,
        requestAttemptId: input.requestAttemptId,
        transport: input.transport,
        latencyMs: input.latencyMs,
        budgetDisposition: "dispatched-uncertain",
      }),
    ]).then(() => undefined),
  ));
}

function mapGuideDeliveryError(error: {
  code: string;
  status: number;
  retryable: boolean;
  learnerAction: "retry" | "rephrase" | "contact-support";
}): Omit<AaisGuidePublicErrorDescriptor, "diagnosticId"> {
  if (error.code === "AAIS_AI_OUTPUT_BLOCKED") {
    return {
      status: 422,
      code: "AI_REPHRASE_REQUIRED",
      message: "The live AI could not provide a safe response. Please rephrase your question.",
      retryable: false,
      learnerAction: "rephrase" as const,
    };
  }
  if (error.code === "AAIS_AI_PROVIDER_CHAIN_EXHAUSTED") {
    return {
      status: error.status === 504 ? 504 : 503,
      code: error.status === 504 ? "AI_LIVE_TIMEOUT" : "AI_LIVE_UNAVAILABLE",
      message: error.retryable
        ? "The live AI is temporarily unavailable. Please try again shortly."
        : "The live AI provider configuration requires support attention.",
      retryable: error.retryable,
      learnerAction: error.retryable ? "retry" as const : "contact-support" as const,
    };
  }
  return {
    status: 503,
    code: "AI_LIVE_NOT_READY",
    message: "The live AI production configuration requires attention.",
    retryable: false,
    learnerAction: "contact-support" as const,
  };
}

function mapGuideDeliveryDiagnosticReason(
  reason: string | undefined,
  code: string,
): Parameters<typeof recordAaisAiGuideDiagnostic>[0]["reason"] {
  if (reason === "abort-timeout") return "response_timeout";
  if (reason === "connect-timeout") return "connect_timeout";
  if (reason === "empty-response") return "empty_response";
  if (reason === "guardrail-blocked") return "guardrail_blocked";
  if (reason === "invalid-response") return "invalid_response";
  if (reason === "observed-model-mismatch"
    || reason === "observed-model-missing"
    || reason === "observed-revision-mismatch"
    || reason === "observed-revision-missing") {
    return "observed_model_mismatch";
  }
  if (reason === "rate-limited") return "rate_limited";
  if (reason === "truncated-response") return "truncated_response";
  if (reason === "upstream-5xx") return "upstream_5xx";
  if (reason === "auth-failed") return "auth_failed";
  if (reason === "payment-required") return "payment_required";
  if (reason === "invalid-request" || reason === "upstream-4xx") return "invalid_request";
  if (reason === "route-deadline") return "route_deadline";
  if (reason === "provider-error") return "network_error";
  if (code === "AAIS_AI_LIVE_PROVIDER_REQUIRED") return "config_missing";
  if (code === "AAIS_AI_PROVIDER_CONFIGURATION_INVALID") return "config_invalid";
  if (code === "AAIS_AI_MODEL_EVALUATION_REQUIRED") return "eval_mismatch";
  if (code === "AAIS_AI_OBSERVED_MODEL_MISMATCH") return "observed_model_mismatch";
  if (code === "AAIS_AI_OUTPUT_BLOCKED") return "guardrail_blocked";
  return "chain_exhausted";
}

function mapGuideDeliveryDiagnosticCategory(
  code: string,
  reason: Parameters<typeof recordAaisAiGuideDiagnostic>[0]["reason"],
): Parameters<typeof recordAaisAiGuideDiagnostic>[0]["category"] {
  if (reason === "guardrail_blocked") return "guardrail";
  if (reason === "route_deadline") return "deadline";
  if (code === "AAIS_AI_MODEL_EVALUATION_REQUIRED"
    || code === "AAIS_AI_OBSERVED_MODEL_MISMATCH") return "evaluation";
  if (code === "AAIS_AI_LIVE_PROVIDER_REQUIRED"
    || code === "AAIS_AI_PROVIDER_CONFIGURATION_INVALID") return "configuration";
  return "provider";
}

function createGuidePublicErrorResponse(input: {
  status: number;
  code: AaisGuidePublicErrorCode;
  message: string;
  diagnosticId: string;
  retryable: boolean;
  learnerAction: "retry" | "rephrase" | "contact-support";
  headers?: HeadersInit;
}) {
  const headers = new Headers(input.headers);
  headers.set("cache-control", "private, no-store");
  const error = createGuidePublicErrorWire(input);
  return NextResponse.json(
    { error },
    { status: input.status, headers },
  );
}

function createGuidePublicErrorWire(input: {
  code: AaisGuidePublicErrorCode;
  diagnosticId: string;
  retryable: boolean;
  learnerAction: "retry" | "rephrase" | "contact-support";
}): AaisGuidePublicErrorV1 {
  return {
    schemaVersion: 1,
    code: input.code,
    diagnosticId: input.diagnosticId,
    retryable: input.retryable,
    learnerAction: input.learnerAction,
  };
}

function createGuideJsonBody(
  result: Awaited<ReturnType<typeof runAaisLearningGuideGraph>>,
  delivery: AaisGuidePublicDeliveryReceipt | null,
) {
  const visibleTimings = getVisibleGuideTimings(result);
  return {
    message: {
      text: result.messageText,
    },
    turns: result.visibleTurns,
    orchestration: {
      graph: {
        graphId: result.graph.graphId,
        topologicalOrder: createVisibleGuideTopologicalOrder(result),
      },
      runtime: {
        engine: result.runtime.engine,
        status: result.runtime.status,
        timings: {
          visibleMs: visibleTimings.length
            ? Math.max(...visibleTimings.map((timing) => timing.elapsedMs))
            : 0,
          fallback: delivery ? false : visibleTimings.some((timing) => timing.fallback),
        },
        ...(delivery ? { delivery } : {}),
      },
    },
  };
}

type AaisGuidePublicDeliveryReceipt = AaisGuideDeliveryReceiptV1;

type AaisGuideEvalManifestDigests = Partial<Record<
  AaisGuidePublicDeliveryReceipt["channel"],
  string
>>;

class AaisGuideLiveReceiptMissingError extends Error {
  constructor() {
    super("AAIS learner-visible guide response did not contain a live delivery receipt.");
    this.name = "AaisGuideLiveReceiptMissingError";
  }
}

class AaisGuidePersistenceError extends Error {
  constructor() {
    super("AAIS live guide response persistence failed.");
    this.name = "AaisGuidePersistenceError";
  }
}

class AaisGuideOrchestrationError extends Error {
  constructor() {
    super("AAIS live guide orchestration failed.");
    this.name = "AaisGuideOrchestrationError";
  }
}

function shouldPreserveGuideAppendError(error: unknown) {
  return isAaisLearnerDataGenerationConflictError(error);
}

function createGuidePublicDeliveryReceiptFromResult(
  result: Awaited<ReturnType<typeof runAaisLearningGuideGraph>>,
  diagnosticId: string,
  liveRequired: boolean,
) {
  const coreDelivery = getCoreGuideDelivery(result);
  if (
    coreDelivery?.mode === "live"
    && (coreDelivery.channel === "primary" || coreDelivery.channel === "secondary")
  ) {
    return {
      schemaVersion: 1 as const,
      responseMode: "live" as const,
      channel: coreDelivery.channel,
      degraded: coreDelivery.channel === "secondary",
      diagnosticId,
      persisted: true as const,
      budgetDisposition: "charged-once" as const,
    };
  }
  if (liveRequired) {
    throw new AaisGuideLiveReceiptMissingError();
  }
  return null;
}

function getCoreGuideDelivery(
  result: Awaited<ReturnType<typeof runAaisLearningGuideGraph>>,
) {
  return (result.runtime as typeof result.runtime & {
    delivery?: AaisGuideRuntimeDeliveryReceiptV1 | null;
  }).delivery ?? null;
}

function recordGuideSuccessDiagnostic(input: {
  result: Awaited<ReturnType<typeof runAaisLearningGuideGraph>>;
  delivery: AaisGuidePublicDeliveryReceipt | null;
  operationId: string;
  diagnosticId: string;
  requestAttemptId: string;
  transport: "json" | "sse";
  locale: "zh-CN" | "en-US";
  evalManifestDigest?: string;
  latencyMs: number;
}) {
  if (!input.delivery) {
    return;
  }
  const coreDelivery = getCoreGuideDelivery(input.result);
  const providerAttempts = projectAaisGuideProviderAttemptsForDiagnostic(
    coreDelivery?.attempts,
  );
  const failedAttempt = providerAttempts.find((attempt) =>
    attempt.outcome !== "succeeded"
  );
  const selectedRole = input.delivery.channel === "secondary" ? "fallback" : "primary";
  const selectedAttempt = [...(coreDelivery?.attempts ?? [])].reverse().find((attempt) =>
    attempt.role === selectedRole && attempt.outcome === "succeeded"
  );
  recordAaisAiGuideDiagnostic({
    event: input.delivery.channel === "secondary"
      ? "aais.ai.guide.failover"
      : "aais.ai.guide.completed",
    outcome: input.delivery.channel === "secondary" ? "live_secondary" : "live_primary",
    ...(failedAttempt
      ? {
          category: mapGuideDeliveryDiagnosticCategory(
            "AAIS_AI_PROVIDER_CHAIN_EXHAUSTED",
            failedAttempt.reason ?? "chain_exhausted",
          ),
          reason: failedAttempt.reason ?? "chain_exhausted",
        }
      : {}),
    providerRole: input.delivery.channel,
    agent: readVisibleGuideAgent(input.result.visibleTurns),
    locale: input.locale,
    modelFingerprint: selectedAttempt?.modelFingerprint,
    evalManifestDigest: input.evalManifestDigest,
    retryable: false,
    attempts: coreDelivery?.attempts.reduce((total, attempt) => total + attempt.attempts, 0) ?? 0,
    providerAttempts,
    latencyMs: input.latencyMs,
    persistence: "committed",
    budgetDisposition: "charged-once",
    transport: input.transport,
    diagnosticId: input.diagnosticId,
    operationId: input.operationId,
    requestAttemptId: input.requestAttemptId,
  });
}

async function createGuideOperationClaimResponse(input: {
  claim: Exclude<AaisGuideBudgetClaim, AaisGuideBudgetReservation>;
  request: Request;
  store: ReturnType<typeof getAaisLearningStore>;
  studentId: string;
  operationId: string;
  diagnosticId: string;
  requestAttemptId: string;
  transport: "json" | "sse";
  latencyMs: number;
}) {
  if (input.claim.claimStatus === "completed") {
    const session = await input.store.readSession(input.studentId);
    const resultMessageId = input.claim.resultMessageId
      ?? `assistant-${input.operationId}`;
    const message = session?.guideMessages.find((candidate) =>
      candidate.id === resultMessageId && candidate.kind === "assistant"
    );
    const delivery = message?.orchestration?.delivery;
    if (!message || !delivery) {
      return createGuidePublicErrorResponse({
        status: 503,
        code: "AI_PERSISTENCE_FAILED",
        message: "The completed AI guide response could not be restored.",
        diagnosticId: input.diagnosticId,
        retryable: true,
        learnerAction: "retry",
      });
    }
    const receipt = createGuidePublicDeliveryReceipt(delivery, input.diagnosticId);
    recordAaisAiGuideDiagnostic({
      event: "aais.ai.guide.idempotency_replay",
      outcome: "replayed",
      category: "idempotency",
      reason: "replay",
      providerRole: delivery.channel,
      agent: readVisibleGuideAgent(message.turns),
      retryable: false,
      attempts: 0,
      latencyMs: input.latencyMs,
      persistence: "committed",
      budgetDisposition: "charged-once",
      transport: input.transport,
      diagnosticId: input.diagnosticId,
      operationId: input.operationId,
      requestAttemptId: input.requestAttemptId,
    });
    return isGuideStreamRequest(input.request)
      ? createCompletedGuideReplayStream({
          message,
          receipt,
          operationId: input.operationId,
          requestAttemptId: input.requestAttemptId,
          budget: input.claim.budget,
        })
      : NextResponse.json(
          createCompletedGuideReplayJson(message, receipt, input.claim.budget),
          { headers: { "cache-control": "private, no-store" } },
        );
  }

  const error: Omit<AaisGuidePublicErrorDescriptor, "diagnosticId"> =
    input.claim.claimStatus === "in_progress"
    ? {
        status: 202,
        code: "AI_OPERATION_IN_PROGRESS",
        message: "This AI guide operation is still in progress.",
        retryable: true,
        learnerAction: "retry" as const,
      }
    : input.claim.claimStatus === "conflict"
      ? {
          status: 409,
          code: "AI_OPERATION_CONFLICT",
          message: "This operation identifier was already used for different input.",
          retryable: true,
          learnerAction: "retry" as const,
        }
      : {
          status: 503,
          code: "AI_LIVE_UNAVAILABLE",
          message: "The live AI operation could not be safely resumed.",
          retryable: true,
          learnerAction: "retry" as const,
        };
  const uncertain = input.claim.claimStatus === "dispatched_uncertain";
  recordAaisAiGuideDiagnostic({
    event: uncertain
      ? "aais.ai.guide.budget_uncertain"
      : "aais.ai.guide.idempotency_replay",
    outcome: uncertain ? "uncertain" : "replayed",
    category: "idempotency",
    reason: input.claim.claimStatus === "conflict"
      ? "payload_conflict"
      : uncertain
        ? "dispatched_uncertain"
        : "replay",
    retryable: error.retryable,
    attempts: 0,
    latencyMs: input.latencyMs,
    persistence: "unknown",
    budgetDisposition: uncertain
      ? "dispatched-uncertain"
      : input.claim.claimStatus === "failed"
        ? "released"
        : "charged-once",
    transport: input.transport,
    diagnosticId: input.diagnosticId,
    operationId: input.operationId,
    requestAttemptId: input.requestAttemptId,
  });
  return createGuidePublicErrorResponse({
    ...error,
    diagnosticId: input.diagnosticId,
    ...(error.status === 202 ? { headers: { "retry-after": "1" } } : {}),
  });
}

async function settleFailedGuideClaimCapacityBeforeResponse(input: {
  claim: Exclude<AaisGuideBudgetClaim, AaisGuideBudgetReservation>;
  store: ReturnType<typeof getAaisLearningStore>;
  studentId: string;
  deadline: AaisGuideRunDeadline;
}) {
  if (input.claim.claimStatus !== "failed" || !input.claim.reservationId) {
    return;
  }
  await settleGuideCleanupBeforeResponse(
    releaseGuideCapacityReservation({
      store: input.store,
      studentId: input.studentId,
      reservation: {
        reservationId: input.claim.reservationId,
        budget: input.claim.budget,
        dataGeneration: input.claim.dataGeneration,
      },
    }),
    input.deadline,
    false,
  );
}

function createGuidePublicDeliveryReceipt(
  delivery: AaisPersistedGuideDelivery,
  diagnosticId: string,
): AaisGuidePublicDeliveryReceipt {
  return {
    schemaVersion: 1,
    responseMode: "live",
    channel: delivery.channel,
    degraded: delivery.channel === "secondary",
    diagnosticId,
    persisted: true,
    budgetDisposition: "charged-once",
  };
}

function createCompletedGuideReplayJson(
  message: AaisGuideMessageRecord,
  receipt: AaisGuidePublicDeliveryReceipt,
  budget: AaisGuideDailyBudget,
) {
  return {
    message: { text: message.text },
    turns: message.turns ?? [],
    orchestration: {
      graph: {
        graphId: message.orchestration?.graphId ?? "learning-ai-guide",
        topologicalOrder: message.orchestration?.topologicalOrder ?? [],
      },
      runtime: {
        engine: "aais-langgraph-runtime",
        status: "completed",
        timings: {
          visibleMs: 0,
          fallback: false,
        },
        delivery: receipt,
      },
    },
    budget,
  };
}

function createCompletedGuideReplayStream(input: {
  message: AaisGuideMessageRecord;
  receipt: AaisGuidePublicDeliveryReceipt;
  operationId: string;
  requestAttemptId: string;
  budget: AaisGuideDailyBudget;
}) {
  const events: string[] = [];
  const send = (event: string, data: Record<string, unknown>) => {
    events.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send("ack", {
    status: "replayed",
    graphId: input.message.orchestration?.graphId ?? "learning-ai-guide",
    operationId: input.operationId,
    requestAttemptId: input.requestAttemptId,
    diagnosticId: input.receipt.diagnosticId,
    budget: input.budget,
  });
  for (const turn of input.message.turns ?? []) {
    send("agent_start", { agentId: turn.agentId });
    send("agent_delta", { agentId: turn.agentId, content: turn.content });
    send("agent_done", { agentId: turn.agentId, status: "ok" });
  }
  send("delivery", input.receipt);
  send("done", { status: "completed", delivery: input.receipt });
  return new Response(events.join(""), {
    status: 200,
    headers: {
      "content-type": "text/event-stream;charset=utf-8",
      "cache-control": "private, no-store",
      "x-accel-buffering": "no",
    },
  });
}

function readVisibleGuideAgent(
  turns: Array<{ agentId: string }> | undefined,
): "A1" | "A2" | undefined {
  return turns?.find((turn) => turn.agentId === "A1" || turn.agentId === "A2")
    ?.agentId as "A1" | "A2" | undefined;
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
  delivery: AaisGuidePublicDeliveryReceipt | null,
) {
  return {
    graphId: result.graph.graphId,
    topologicalOrder: createVisibleGuideTopologicalOrder(result),
    threadId: result.runtime.threadId,
    ...(delivery
      ? {
          delivery: {
            schemaVersion: 1 as const,
            responseMode: "live" as const,
            channel: delivery.channel,
            degraded: delivery.degraded,
          },
        }
      : {}),
  };
}

function isGuideStreamRequest(request: Request) {
  const acceptsStream = request.headers.get("accept")?.includes("text/event-stream") ?? false;
  const streamParam = new URL(request.url).searchParams.get("stream") === "1";
  return acceptsStream || streamParam;
}

type AaisGuideRunDeadline = {
  signal: AbortSignal;
  deadlineAt: number;
  abort(reason?: Error): void;
  dispose(): void;
};

class AaisGuideRouteDeadlineError extends Error {
  constructor(readonly stage: "route" | "provider-window" = "route") {
    super("AAIS guide request exceeded its bounded runtime.");
    this.name = "AaisGuideRouteDeadlineError";
  }
}

function assertGuideProviderWindowAvailable(
  providerDeadlineAt: number | undefined,
  runDeadline: AaisGuideRunDeadline,
) {
  runDeadline.signal.throwIfAborted();
  if (typeof providerDeadlineAt === "number" && Date.now() >= providerDeadlineAt) {
    throw new AaisGuideRouteDeadlineError("provider-window");
  }
}

function createGuideAbortError() {
  const error = new Error("AAIS guide request was cancelled.");
  error.name = "AbortError";
  return error;
}

function createGuideRunDeadline(
  requestSignal: AbortSignal,
  deadlineAt: number,
): AaisGuideRunDeadline {
  const controller = new AbortController();
  const abort = (reason: Error = createGuideAbortError()) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };
  const abortFromRequest = () => abort(createGuideAbortError());
  const deadlineTimer = setTimeout(() => {
    abort(new AaisGuideRouteDeadlineError());
  }, Math.max(0, deadlineAt - Date.now()));

  if (requestSignal.aborted) {
    abortFromRequest();
  } else {
    requestSignal.addEventListener("abort", abortFromRequest, { once: true });
  }

  return {
    signal: controller.signal,
    deadlineAt,
    abort,
    dispose() {
      clearTimeout(deadlineTimer);
      requestSignal.removeEventListener("abort", abortFromRequest);
    },
  };
}

async function awaitGuideRunDeadline<T>(
  pending: Promise<T>,
  deadline: AaisGuideRunDeadline,
): Promise<T> {
  deadline.signal.throwIfAborted();
  let abortListener: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(
      deadline.signal.reason instanceof Error
        ? deadline.signal.reason
        : new AaisGuideRouteDeadlineError(),
    );
    deadline.signal.addEventListener("abort", abortListener, { once: true });
    if (deadline.signal.aborted) {
      abortListener();
    }
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    if (abortListener) {
      deadline.signal.removeEventListener("abort", abortListener);
    }
  }
}

async function settleGuideCleanupBeforeResponse(
  pending: Promise<unknown>,
  deadline: AaisGuideRunDeadline,
  detachImmediately: boolean,
) {
  if (detachImmediately) {
    startGuideBackgroundTask(pending);
    return;
  }
  try {
    await awaitGuideRunDeadline(pending, deadline);
  } catch (error) {
    if (!deadline.signal.aborted) {
      throw error;
    }
    startGuideBackgroundTask(pending);
  }
}

function startGuideBackgroundTask(pending: Promise<unknown>) {
  const guarded = pending.catch(() => undefined);
  try {
    after(guarded);
  } catch (error) {
    // Direct Vitest route invocation does not install Next's request lifecycle
    // context. Production must never silently degrade to an unowned promise.
    if (process.env.VITEST) {
      void guarded;
      return;
    }
    throw error;
  }
}

async function runGuideGraphWithSignal(
  input: Parameters<typeof runAaisLearningGuideGraph>[0],
  signal: AbortSignal,
  modelProvider: AaisModelProvider,
  deliveryPolicy: "require-live" | "allow-deterministic",
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
      runAaisLearningGuideGraph(input, { signal, modelProvider, deliveryPolicy }),
      aborted,
    ]);
  } catch (error) {
    if (isAaisGuideDeliveryError(error)
      || error instanceof AaisGuideRouteDeadlineError
      || isGuideAbortError(error)) {
      throw error;
    }
    throw new AaisGuideOrchestrationError();
  } finally {
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
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
  dataGeneration: number;
  operationId: string;
  diagnosticId: string;
  requestAttemptId: string;
  requestStartedAt: number;
  modelProvider: AaisModelProvider;
  deliveryPolicy: "require-live" | "allow-deterministic";
  evalManifestDigests: AaisGuideEvalManifestDigests;
}) {
  const encoder = new TextEncoder();
  const runDeadline = input.runDeadline;
  let downstreamCancelled = false;
  let streamTerminalCompleted = false;
  let streamTransportFailureRecorded = false;
  let streamBudgetDispatched = false;

  const recordStreamTransportFailure = (
    reason: "client_disconnect" | "stream_interrupted",
  ) => {
    if (streamTransportFailureRecorded || streamTerminalCompleted) {
      return;
    }
    streamTransportFailureRecorded = true;
    recordAaisAiGuideDiagnostic({
      event: "aais.ai.guide.failed",
      outcome: "failed",
      category: "transport",
      reason,
      retryable: true,
      latencyMs: Date.now() - input.requestStartedAt,
      persistence: "unknown",
      budgetDisposition: streamBudgetDispatched
        ? "dispatched-uncertain"
        : "released",
      transport: "sse",
      diagnosticId: input.diagnosticId,
      operationId: input.operationId,
      requestAttemptId: input.requestAttemptId,
    });
  };

  const execute = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    let budgetCommitted = false;
    let budgetDispatched = false;
    let capacityConsumed = false;
    let persistenceCleanupTransferred = false;
    const enqueue = (payload: string, options: { terminal?: boolean } = {}) => {
      if (downstreamCancelled || (runDeadline.signal.aborted && !options.terminal)) {
        return false;
      }
      try {
        controller.enqueue(encoder.encode(payload));
        return true;
      } catch {
        downstreamCancelled = true;
        recordStreamTransportFailure("stream_interrupted");
        runDeadline.abort(createGuideAbortError());
        return false;
      }
    };
    const send = (
      event: string,
      data: Record<string, unknown>,
      options: { terminal?: boolean } = {},
    ) => enqueue(
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
      options,
    );
    const heartbeatTimer = setInterval(() => {
      enqueue(": aais-heartbeat\n\n");
    }, guideStreamHeartbeatIntervalMs);
    try {
        runDeadline.signal.throwIfAborted();
        const targetAgentIds = selectAaisGuideReplyAgentIds(input.input.learnerInput);
        assertGuideProviderWindowAvailable(input.input.providerDeadlineAt, runDeadline);
        const providerDispatchFence = createGuideProviderDispatchFence({
            store: input.store,
            studentId: input.input.studentId,
            reservation: {
              reservationId: input.reservationId,
              budget: input.budget,
              dataGeneration: input.dataGeneration,
            },
            providerDeadlineAt: input.input.providerDeadlineAt ?? runDeadline.deadlineAt,
            runDeadline,
            onDispatched: () => {
              budgetDispatched = true;
              streamBudgetDispatched = true;
            },
            onReleased: () => {
              budgetDispatched = false;
              streamBudgetDispatched = false;
            },
          });
        send("ack", {
          status: "accepted",
          graphId: "learning-ai-guide",
          operationId: input.operationId,
          requestAttemptId: input.requestAttemptId,
          diagnosticId: input.diagnosticId,
          budget: input.budget,
        });
        for (const agentId of targetAgentIds) {
          send("agent_start", { agentId });
        }

        const result = await runGuideGraphWithSignal(
          {
            ...input.input,
            providerDispatchFence,
          },
          runDeadline.signal,
          input.modelProvider,
          input.deliveryPolicy,
        ).catch((error: unknown) => {
          annotateGuideDeliveryBudgetDisposition(error, budgetDispatched);
          throw error;
        });
        runDeadline.signal.throwIfAborted();
        const delivery = createGuidePublicDeliveryReceiptFromResult(
          result,
          input.diagnosticId,
          input.deliveryPolicy === "require-live",
        );
        const appendGuideExchangePromise = input.store.appendGuideExchange({
            operationId: input.operationId,
            studentId: input.input.studentId,
            phase: input.input.phase,
            taskId: input.input.taskId,
            question: input.question,
            answer: result.messageText,
            ...(input.attachmentMetadata.length
              ? { attachments: input.attachmentMetadata }
              : {}),
            turns: result.visibleTurns,
            orchestration: createPersistedGuideOrchestration(result, delivery),
            budgetReservationId: input.reservationId,
            capacityReservationId: input.reservationId,
            dataGeneration: input.dataGeneration,
            deadlineAt: runDeadline.deadlineAt,
          });
        try {
          await awaitGuideRunDeadline(
            appendGuideExchangePromise,
            runDeadline,
          );
          runDeadline.signal.throwIfAborted();
        } catch (error) {
          if (runDeadline.signal.aborted) {
            transferTimedOutGuidePersistenceCleanup({
              appendPromise: appendGuideExchangePromise,
              store: input.store,
              studentId: input.input.studentId,
              reservation: {
                reservationId: input.reservationId,
                budget: input.budget,
                dataGeneration: input.dataGeneration,
              },
              lease: input.rawTextWriteLease,
              diagnosticId: input.diagnosticId,
              operationId: input.operationId,
              requestAttemptId: input.requestAttemptId,
              transport: "sse",
              latencyMs: Date.now() - input.requestStartedAt,
            });
            persistenceCleanupTransferred = true;
            throw error;
          }
          if (shouldPreserveGuideAppendError(error)) {
            throw error;
          }
          throw new AaisGuidePersistenceError();
        }
        budgetCommitted = true;
        capacityConsumed = true;
        recordGuideBudgetAudit({
          event: "ai.guide.budget.used",
          outcome: "success",
          budget: input.budget,
        });
        recordGuideSuccessDiagnostic({
          result,
          delivery,
          operationId: input.operationId,
          diagnosticId: input.diagnosticId,
          requestAttemptId: input.requestAttemptId,
          transport: "sse",
          locale: input.input.locale,
          evalManifestDigest: delivery
            ? input.evalManifestDigests[delivery.channel]
            : undefined,
          latencyMs: Date.now() - input.requestStartedAt,
        });

        for (const turn of result.visibleTurns) {
          send("agent_delta", {
            agentId: turn.agentId,
            content: turn.content,
          });
          send("agent_done", {
            agentId: turn.agentId,
            status: result.runtime.timings.agents.find((agent) => agent.agentId === turn.agentId)?.status,
          });
        }
        runDeadline.signal.throwIfAborted();
        const visibleTimings = getVisibleGuideTimings(result);
        if (delivery) {
          send("delivery", delivery);
        } else if (visibleTimings.some((timing) => timing.fallback)) {
          send("fallback", {});
        }
        streamTerminalCompleted = send("done", {
          status: "completed",
          ...(delivery ? { delivery } : {}),
        }, { terminal: true });
      } catch (error) {
        if (!downstreamCancelled) {
          if (isGuideAbortError(error)) {
            // resolveGuidePublicFailure records the client-disconnect event.
            streamTransportFailureRecorded = true;
          }
          const publicError = resolveGuidePublicFailure({
            error,
            diagnosticId: input.diagnosticId,
            operationId: input.operationId,
            requestAttemptId: input.requestAttemptId,
            transport: "sse",
            latencyMs: Date.now() - input.requestStartedAt,
            budgetDisposition: budgetDispatched
              ? "dispatched-uncertain"
              : "released",
          }) ?? recordAndCreateGuideStreamOrchestrationFailure({
            diagnosticId: input.diagnosticId,
            operationId: input.operationId,
            requestAttemptId: input.requestAttemptId,
            latencyMs: Date.now() - input.requestStartedAt,
            budgetDispatched,
          });
          streamTerminalCompleted = send(
            "error",
            { error: createGuidePublicErrorWire(publicError) },
            { terminal: true },
          );
        }
      } finally {
        clearInterval(heartbeatTimer);
        if (!capacityConsumed && !persistenceCleanupTransferred) {
          await settleGuideCleanupBeforeResponse(
            releaseGuideCapacityReservation({
              store: input.store,
              studentId: input.input.studentId,
              reservation: {
                reservationId: input.reservationId,
                budget: input.budget,
                dataGeneration: input.dataGeneration,
              },
            }),
            runDeadline,
            false,
          );
        }
        if (!budgetCommitted && !budgetDispatched) {
          await settleGuideCleanupBeforeResponse(
            releaseGuideBudgetReservation({
              store: input.store,
              studentId: input.input.studentId,
              reservation: {
                reservationId: input.reservationId,
                budget: input.budget,
                dataGeneration: input.dataGeneration,
              },
            }),
            runDeadline,
            false,
          );
        }
        if (!persistenceCleanupTransferred) {
          await settleGuideCleanupBeforeResponse(
            releaseGuideRawTextLeaseSafely({
              lease: input.rawTextWriteLease,
              diagnosticId: input.diagnosticId,
              operationId: input.operationId,
              requestAttemptId: input.requestAttemptId,
              transport: "sse",
              latencyMs: Date.now() - input.requestStartedAt,
              budgetDisposition: budgetCommitted
                ? "charged-once"
                : budgetDispatched
                  ? "dispatched-uncertain"
                  : "released",
            }),
            runDeadline,
            false,
          );
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
      recordStreamTransportFailure("client_disconnect");
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
  claimStatus: "reserved";
  reservationId: string;
  resultMessageId: null;
  budget: AaisGuideDailyBudget;
  dataGeneration: number;
};

type AaisGuideReservationContext = Pick<
  AaisGuideBudgetReservation,
  "reservationId" | "budget" | "dataGeneration"
>;

type AaisGuideBudgetClaim = AaisGuideBudgetReservation | {
  claimStatus:
    | "in_progress"
    | "completed"
    | "conflict"
    | "failed"
    | "dispatched_uncertain";
  reservationId: string | null;
  resultMessageId: string | null;
  budget: AaisGuideDailyBudget;
  dataGeneration: number;
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
  operationId: string,
  payloadDigest: string,
): Promise<AaisGuideBudgetClaim> {
  const limit = readDailyGuideLimit();
  const reservationId = operationId;
  const reservation = await store.reserveDailyGuideRequest({
    reservationId,
    operationId,
    payloadDigest,
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
      event: "ai.guide.budget.exceeded",
      outcome: "failure",
      budget,
    });
    throw new AaisGuideDailyBudgetError(budget);
  }
  if (!reservation.reservationId && reservation.status === "reserved") {
    throw new Error("AAIS guide budget reservation was not created.");
  }
  if (reservation.status !== "reserved") {
    return {
      claimStatus: reservation.status,
      reservationId: reservation.reservationId,
      resultMessageId: reservation.resultMessageId,
      budget,
      dataGeneration,
    };
  }
  return {
    claimStatus: "reserved",
    reservationId: reservation.reservationId!,
    resultMessageId: null,
    budget,
    dataGeneration,
  };
}

async function releaseGuideBudgetReservation(input: {
  store: ReturnType<typeof getAaisLearningStore>;
  studentId: string;
  reservation: AaisGuideReservationContext;
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
          event: "ai.guide.budget.released",
          outcome: "success",
          budget: input.reservation.budget,
        });
      }
      return;
    } catch {
      if (attempt === 1) {
        recordGuideBudgetAudit({
          event: "ai.guide.budget.release_failed",
          outcome: "failure",
          budget: input.reservation.budget,
        });
      }
    }
  }
}

function releaseLateGuideBudgetReservation(input: {
  claimPromise: Promise<AaisGuideBudgetClaim>;
  store: ReturnType<typeof getAaisLearningStore>;
  studentId: string;
}) {
  startGuideBackgroundTask(input.claimPromise.then((claim) =>
    claim.claimStatus === "reserved"
      ? releaseGuideBudgetReservation({
          store: input.store,
          studentId: input.studentId,
          reservation: claim,
        })
      : undefined));
}

async function releaseGuideCapacityReservation(input: {
  store: ReturnType<typeof getAaisLearningStore>;
  studentId: string;
  reservation: AaisGuideReservationContext;
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

function releaseLateGuideCapacityReservation(input: {
  reservationPromise: Promise<unknown>;
  store: ReturnType<typeof getAaisLearningStore>;
  studentId: string;
  reservation: AaisGuideReservationContext;
}) {
  startGuideBackgroundTask(input.reservationPromise.then(() =>
    releaseGuideCapacityReservation({
      store: input.store,
      studentId: input.studentId,
      reservation: input.reservation,
    })));
}

function createGuideProviderDispatchFence(input: {
  store: ReturnType<typeof getAaisLearningStore>;
  studentId: string;
  reservation: AaisGuideReservationContext;
  providerDeadlineAt: number;
  runDeadline: AaisGuideRunDeadline;
  onDispatched(): void;
  onReleased(): void;
}): AaisProviderDispatchFence {
  let state: "reserved" | "dispatching" | "dispatched" | "attempted" | "released" = "reserved";
  let acquirePromise: Promise<"ready" | "deadline"> | null = null;

  return {
    acquire() {
      if (state === "dispatched" || state === "attempted") {
        return Promise.resolve("ready");
      }
      if (state === "released") {
        return Promise.resolve("deadline");
      }
      if (acquirePromise) {
        return acquirePromise;
      }
      state = "dispatching";
      acquirePromise = (async () => {
        if (Date.now() >= input.providerDeadlineAt) {
          state = "reserved";
          return "deadline";
        }
        const dispatchPromise = dispatchGuideBudgetReservation({
          store: input.store,
          studentId: input.studentId,
          reservation: input.reservation,
          deadlineAt: input.providerDeadlineAt,
        });
        let outcome: Awaited<typeof dispatchPromise>;
        try {
          outcome = await awaitGuideRunDeadline(dispatchPromise, input.runDeadline);
        } catch (error) {
          startGuideBackgroundTask(dispatchPromise.then(async (lateOutcome) => {
            if (lateOutcome !== "dispatched" || state !== "dispatching") {
              return;
            }
            state = "dispatched";
            input.onDispatched();
            const released = await rollbackGuideBudgetDispatchBeforeProviderAttempt({
              store: input.store,
              studentId: input.studentId,
              reservation: input.reservation,
            });
            if (released) {
              state = "released";
              input.onReleased();
            }
          }));
          throw error;
        }
        if (outcome === "deadline") {
          state = "reserved";
          return "deadline";
        }
        state = "dispatched";
        input.onDispatched();
        return "ready";
      })();
      return acquirePromise;
    },
    markAttemptStarted() {
      if (state === "dispatched") {
        state = "attempted";
      }
    },
    async releaseBeforeAttempt() {
      if (state !== "dispatched") {
        return state === "released" || state === "reserved"
          ? "released"
          : "uncertain";
      }
      const released = await rollbackGuideBudgetDispatchBeforeProviderAttempt({
        store: input.store,
        studentId: input.studentId,
        reservation: input.reservation,
      });
      if (!released) {
        return "uncertain";
      }
      state = "released";
      input.onReleased();
      return "released";
    },
  };
}

async function rollbackGuideBudgetDispatchBeforeProviderAttempt(input: {
  store: ReturnType<typeof getAaisLearningStore>;
  studentId: string;
  reservation: AaisGuideReservationContext;
}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const released = await input.store.finalizeDailyGuideRequest({
        reservationId: input.reservation.reservationId,
        studentId: input.studentId,
        outcome: "released-before-provider-attempt",
        dataGeneration: input.reservation.dataGeneration,
      });
      if (released.status === "released") {
        recordGuideBudgetAudit({
          event: "ai.guide.budget.released",
          outcome: "success",
          budget: input.reservation.budget,
        });
        return true;
      }
      return false;
    } catch {
      if (attempt === 1) {
        recordGuideBudgetAudit({
          event: "ai.guide.budget.release_failed",
          outcome: "failure",
          budget: input.reservation.budget,
        });
      }
    }
  }
  return false;
}

async function dispatchGuideBudgetReservation(input: {
  store: ReturnType<typeof getAaisLearningStore>;
  studentId: string;
  reservation: AaisGuideReservationContext;
  deadlineAt: number;
}) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (Date.now() >= input.deadlineAt) {
      return "deadline" as const;
    }
    try {
      const dispatched = await input.store.finalizeDailyGuideRequest({
        reservationId: input.reservation.reservationId,
        studentId: input.studentId,
        outcome: "dispatched",
        dataGeneration: input.reservation.dataGeneration,
        operationDeadlineAt: new Date(input.deadlineAt),
      });
      if (dispatched.status !== "dispatched") {
        if (Date.now() >= input.deadlineAt) {
          return "deadline" as const;
        }
        throw new Error("AAIS guide budget reservation could not be dispatched.");
      }
      recordGuideBudgetAudit({
        event: "ai.guide.budget.dispatched",
        outcome: "success",
        budget: input.reservation.budget,
      });
      return "dispatched" as const;
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
    outcome: input.outcome,
    metadata: {
      limit: input.budget.limit,
      used: input.budget.used,
      remaining: input.budget.remaining,
      resetsAt: input.budget.resetsAt,
    },
  });
}
