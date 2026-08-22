import { NextResponse } from "next/server";
import {
  createAaisLearnerSessionApiDto,
  getAaisLearningStore,
  isAaisAiAcceptanceTargetError,
  isAaisLearnerMutationError,
  isAaisLearnerDataGenerationConflictError,
  isAaisLearnerSessionLimitError,
  isAaisLearnerTextRevisionConflictError,
  isAaisLearningStorageConfigurationError,
  isAaisSessionWriteConflictError,
  type AaisHistoryDocumentRecord,
} from "@/lib/server/aais-learning-store";
import { isAaisCsrfError, requireAaisCsrf } from "@/lib/server/aais-csrf";
import {
  isAaisAuthError,
  requireAaisSessionActor,
} from "@/lib/server/aais-request-auth";
import {
  AaisApiRouteError,
  createAaisApiErrorResponse,
  isAaisApiRouteError,
} from "@/lib/server/aais-api-error";
import {
  AaisResearchConfigurationError,
  AaisResearchDisabledError,
} from "@/lib/server/aais-research-contract";
import { getAaisResearchErrorResponseInput } from "@/lib/server/aais-research-api";
import { acquireAaisResearchRawTextWriteLeaseIfRequired } from "@/lib/server/aais-research-raw-text";
import {
  AaisRequestBodyError,
  readAaisBoundedJson,
} from "@/lib/server/aais-request-json";
import {
  AaisResearchAuthorizationError,
  AaisResearchVisitInactiveError,
  AaisResearchVisitNotFoundError,
} from "@/lib/server/aais-research-store";
import { requireAaisLearningRequestId } from "../aais-learning-request-id";

type AaisSessionRequestBody = {
  studentId?: string;
  action?: string;
  stageId?: string;
  taskId?: string;
  messageId?: string;
  mutationId?: string;
  artifactText?: string;
  selfReport?: string;
  accepted?: boolean;
  reason?: string;
  activeDocumentId?: string | null;
  documentTitle?: string;
  document?: AaisHistoryDocumentRecord | null;
  dataGeneration?: number;
  expectedArtifactRevision?: number;
  expectedSelfReportRevision?: number;
};

const maxSessionRequestBodyBytes = 16 * 1024 * 1024;
const maxArtifactCharacters = 2 * 1024 * 1024;
const maxTextCharacters = 20_000;
const maxDocumentTitleCharacters = 200;
const selectableStageIds = new Set(["assessment", "comparison", "guide", "reflection"]);
const sessionActions = new Set([
  "archive-artifact",
  "complete-task",
  "record-ai-acceptance",
  "save-artifact",
  "save-self-report",
  "select-stage",
  "select-task",
]);

export async function GET(request: Request) {
  try {
    const actor = await requireAaisSessionActor(request);
    const session = await getAaisLearningStore().readSession(actor.id);
    if (!session) {
      throw new AaisApiRouteError({
        code: "AAIS_LEARNER_SESSION_NOT_FOUND",
        message: "AAIS learner session was not found.",
        status: 404,
      });
    }
    return jsonSession(session, actor.role);
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireAaisSessionActor(request);
    requireAaisCsrf(request, actor.id);
    const rawTextWriteLease = await acquireAaisResearchRawTextWriteLeaseIfRequired(actor);
    try {
      const session = await getAaisLearningStore().getOrCreateSession(actor.id);
      return jsonSession(session, actor.role);
    } finally {
      await rawTextWriteLease?.release();
    }
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await requireAaisSessionActor(request);
    const studentId = actor.id;
    requireAaisCsrf(request, studentId);
    const body = requireSessionBody(await readAaisBoundedJson(request, {
      maxBytes: maxSessionRequestBodyBytes,
    }));
    const action = requireSessionAction(body.action);
    const store = getAaisLearningStore();
    const dataGeneration = requireDataGeneration(body.dataGeneration);
    validateSessionActionInput(action, body);
    if (!await store.readSession(studentId)) {
      throw new AaisApiRouteError({
        code: "AAIS_LEARNER_SESSION_NOT_FOUND",
        message: "AAIS learner session was not found.",
        status: 404,
      });
    }
    const rawTextWriteLease = await acquireAaisResearchRawTextWriteLeaseIfRequired(actor);
    try {
      if (action === "select-stage") {
        const session = await store.selectStage(
          studentId,
          requireStageId(body.stageId),
          dataGeneration,
        );
        return jsonSession(session, actor.role);
      }
      if (action === "select-task") {
        const session = await store.selectTask(
          studentId,
          requireSessionTaskId(body.taskId),
          dataGeneration,
        );
        return jsonSession(session, actor.role);
      }
      if (action === "complete-task") {
        const session = await store.completeTask(
          studentId,
          requireSessionTaskId(body.taskId),
          dataGeneration,
        );
        return jsonSession(session, actor.role);
      }
      if (action === "save-artifact") {
        const session = await store.saveArtifact(
          studentId,
          requireSessionTaskId(body.taskId),
          readOptionalText(body.artifactText, "artifactText", maxArtifactCharacters) ?? "",
          {
            activeDocumentId: readOptionalNullableId(body.activeDocumentId, "activeDocumentId"),
            documentTitle: readOptionalText(
              body.documentTitle,
              "documentTitle",
              maxDocumentTitleCharacters,
            ),
            mutationId: readRequiredId(body.mutationId, "mutationId"),
            expectedArtifactRevision: requireExpectedTextRevision(
              body.expectedArtifactRevision,
              "expectedArtifactRevision",
            ),
            dataGeneration,
          },
        );
        return jsonSession(session, actor.role);
      }
      if (action === "archive-artifact") {
        if (body.document === undefined) {
          throw new AaisApiRouteError({
            code: "AAIS_SESSION_REQUIRED_FIELD",
            message: "document is required.",
            status: 400,
          });
        }
        const session = await store.archiveArtifact(
          studentId,
          requireSessionTaskId(body.taskId),
          {
            activeDocumentId: readOptionalNullableId(body.activeDocumentId, "activeDocumentId"),
            document: readHistoryDocument(body.document),
            mutationId: readRequiredId(body.mutationId, "mutationId"),
            expectedArtifactRevision: requireExpectedTextRevision(
              body.expectedArtifactRevision,
              "expectedArtifactRevision",
            ),
            dataGeneration,
          },
        );
        return jsonSession(session, actor.role);
      }
      if (action === "save-self-report") {
        const session = await store.saveSelfReport(
          studentId,
          requireSessionTaskId(body.taskId),
          readOptionalText(body.selfReport, "selfReport", maxTextCharacters) ?? "",
          {
            dataGeneration,
            expectedSelfReportRevision: requireExpectedTextRevision(
              body.expectedSelfReportRevision,
              "expectedSelfReportRevision",
            ),
            mutationId: readRequiredId(body.mutationId, "mutationId"),
          },
        );
        return jsonSession(session, actor.role);
      }
      if (action === "record-ai-acceptance") {
        if (typeof body.accepted !== "boolean") {
          throwInvalidSessionField("accepted");
        }
        const session = await store.recordAiAcceptance(
          studentId,
          requireSessionTaskId(body.taskId),
          {
            accepted: body.accepted === true,
            messageId: readOptionalId(body.messageId, "messageId"),
            reason: readOptionalText(body.reason, "reason", maxTextCharacters),
            dataGeneration,
          },
        );
        return jsonSession(session, actor.role);
      }

      return createAaisApiErrorResponse({
        code: "AAIS_SESSION_UNSUPPORTED_ACTION",
        message: "Unsupported AAIS session action.",
        status: 400,
      });
    } finally {
      await rawTextWriteLease?.release();
    }
  } catch (error) {
    return jsonError(error);
  }
}

function jsonSession(
  session: Awaited<ReturnType<ReturnType<typeof getAaisLearningStore>["getOrCreateSession"]>>,
  role: "student" | "teacher" | "researcher" | "admin",
) {
  return NextResponse.json(
    {
      session: createAaisLearnerSessionApiDto(session),
      actor: {
        role,
      },
    },
    {
      headers: {
        "cache-control": "private, no-store",
      },
    },
  );
}

function requireSessionBody(value: unknown): AaisSessionRequestBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AaisApiRouteError({
      code: "AAIS_SESSION_BODY_INVALID",
      message: "AAIS session request body is invalid.",
      status: 400,
    });
  }
  return value as AaisSessionRequestBody;
}

function requireSessionAction(value: unknown) {
  if (typeof value !== "string" || !sessionActions.has(value)) {
    throw new AaisApiRouteError({
      code: "AAIS_SESSION_UNSUPPORTED_ACTION",
      message: "Unsupported AAIS session action.",
      status: 400,
    });
  }
  return value;
}

function validateSessionActionInput(action: string, body: AaisSessionRequestBody) {
  if (action === "select-stage") {
    requireStageId(body.stageId);
    return;
  }
  if (action === "select-task" || action === "complete-task") {
    requireSessionTaskId(body.taskId);
    return;
  }
  if (action === "save-artifact") {
    requireSessionTaskId(body.taskId);
    readOptionalText(body.artifactText, "artifactText", maxArtifactCharacters);
    readOptionalNullableId(body.activeDocumentId, "activeDocumentId");
    readRequiredId(body.mutationId, "mutationId");
    readOptionalText(body.documentTitle, "documentTitle", maxDocumentTitleCharacters);
    requireExpectedTextRevision(body.expectedArtifactRevision, "expectedArtifactRevision");
    return;
  }
  if (action === "archive-artifact") {
    requireSessionTaskId(body.taskId);
    readOptionalNullableId(body.activeDocumentId, "activeDocumentId");
    if (body.document === undefined) {
      throw new AaisApiRouteError({
        code: "AAIS_SESSION_REQUIRED_FIELD",
        message: "document is required.",
        status: 400,
      });
    }
    readHistoryDocument(body.document);
    readRequiredId(body.mutationId, "mutationId");
    requireExpectedTextRevision(body.expectedArtifactRevision, "expectedArtifactRevision");
    return;
  }
  if (action === "save-self-report") {
    requireSessionTaskId(body.taskId);
    readOptionalText(body.selfReport, "selfReport", maxTextCharacters);
    readRequiredId(body.mutationId, "mutationId");
    requireExpectedTextRevision(body.expectedSelfReportRevision, "expectedSelfReportRevision");
    return;
  }
  if (action === "record-ai-acceptance") {
    requireSessionTaskId(body.taskId);
    if (typeof body.accepted !== "boolean") {
      throwInvalidSessionField("accepted");
    }
    readOptionalId(body.messageId, "messageId");
    readOptionalText(body.reason, "reason", maxTextCharacters);
  }
}

function requireStageId(value: unknown) {
  const stageId = requireString(value, "stageId");
  if (!selectableStageIds.has(stageId)) {
    throw new AaisApiRouteError({
      code: "AAIS_STAGE_INVALID",
      message: "AAIS stage is invalid.",
      status: 400,
    });
  }
  return stageId;
}

function requireString(value: unknown, label: string) {
  if (typeof value !== "string" || !value) {
    throw new AaisApiRouteError({
      code: "AAIS_SESSION_REQUIRED_FIELD",
      message: `${label} is required.`,
      status: 400,
    });
  }
  return value;
}

function requireSessionTaskId(value: unknown) {
  return requireAaisLearningRequestId(value, {
    required: {
      code: "AAIS_SESSION_REQUIRED_FIELD",
      message: "taskId is required.",
    },
    invalid: {
      code: "AAIS_SESSION_FIELD_INVALID",
      message: "AAIS session field taskId is invalid.",
    },
  });
}

function readOptionalText(value: unknown, label: string, maxCharacters: number) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throwInvalidSessionField(label);
  }
  if (value.length > maxCharacters) {
    throw new AaisApiRouteError({
      code: "AAIS_SESSION_FIELD_TOO_LARGE",
      message: `AAIS session field ${label} is too large.`,
      status: 413,
    });
  }
  return value;
}

function readOptionalId(value: unknown, label: string) {
  const text = readOptionalText(value, label, 128);
  if (text !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text)) {
    throwInvalidSessionField(label);
  }
  return text;
}

function readOptionalNullableId(value: unknown, label: string) {
  return value === null ? null : readOptionalId(value, label);
}

function readHistoryDocument(value: unknown): AaisHistoryDocumentRecord | null {
  if (value === null) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throwInvalidSessionField("document");
  }
  const document = value as Record<string, unknown>;
  const savedAt = readOptionalText(document.savedAt, "document.savedAt", 64);
  if (!savedAt || Number.isNaN(Date.parse(savedAt))) {
    throwInvalidSessionField("document.savedAt");
  }
  return {
    id: readRequiredId(document.id, "document.id"),
    taskId: readRequiredId(document.taskId, "document.taskId"),
    title: readOptionalText(document.title, "document.title", maxDocumentTitleCharacters) ?? "",
    html: readOptionalText(document.html, "document.html", maxArtifactCharacters) ?? "",
    savedAt,
  };
}

function readRequiredId(value: unknown, label: string) {
  const result = readOptionalId(value, label);
  if (!result) {
    throwInvalidSessionField(label);
  }
  return result;
}

function throwInvalidSessionField(label: string): never {
  throw new AaisApiRouteError({
    code: "AAIS_SESSION_FIELD_INVALID",
    message: `AAIS session field ${label} is invalid.`,
    status: 400,
  });
}

function requireDataGeneration(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new AaisApiRouteError({
      code: "AAIS_LEARNER_DATA_GENERATION_REQUIRED",
      message: "A current learner data generation is required.",
      status: 409,
    });
  }
  return Number(value);
}

function requireExpectedTextRevision(value: unknown, label: string) {
  if (value === undefined) {
    throw new AaisApiRouteError({
      code: "AAIS_SESSION_TEXT_REVISION_REQUIRED",
      message: `A current ${label} is required.`,
      status: 409,
    });
  }
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throwInvalidSessionField(label);
  }
  return Number(value);
}

function jsonError(error: unknown) {
  const response = getErrorResponseInput(error);
  return createAaisApiErrorResponse(response);
}

function getErrorResponseInput(error: unknown) {
  if (error instanceof AaisRequestBodyError) {
    return {
      code: error.reason === "too_large"
        ? "AAIS_SESSION_BODY_TOO_LARGE"
        : "AAIS_SESSION_BODY_INVALID",
      message: error.reason === "too_large"
        ? "AAIS session request body is too large."
        : "AAIS session request body is invalid.",
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
    return getAaisResearchErrorResponseInput(error, "/api/learning/session");
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
  if (isAaisLearnerTextRevisionConflictError(error)) {
    return error.field === "artifact"
      ? {
          code: "AAIS_ARTIFACT_REVISION_CONFLICT",
          message: "AAIS artifact changed after this edit started. Reload before saving again.",
          status: 409,
        }
      : {
          code: "AAIS_SELF_REPORT_REVISION_CONFLICT",
          message: "AAIS self-report changed after this edit started. Reload before saving again.",
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
    const responses = {
      events_limit_reached: [
        "AAIS_SESSION_EVENTS_LIMIT_REACHED",
        "AAIS learner session event history has reached its persistence limit.",
      ],
      guide_messages_limit_reached: [
        "AAIS_SESSION_GUIDE_MESSAGES_LIMIT_REACHED",
        "AAIS learner session guide history has reached its persistence limit.",
      ],
      payload_too_large: [
        "AAIS_SESSION_PAYLOAD_TOO_LARGE",
        "AAIS learner session payload is too large to persist safely.",
      ],
      scaffold_history_limit_reached: [
        "AAIS_SESSION_SCAFFOLD_HISTORY_LIMIT_REACHED",
        "AAIS learner session scaffold history has reached its persistence limit.",
      ],
    } satisfies Record<typeof error.reason, readonly [string, string]>;
    const [code, message] = responses[error.reason];
    return {
      code,
      message,
      status: 413,
    };
  }
  if (isAaisAiAcceptanceTargetError(error)) {
    return {
      code: "AAIS_AI_ACCEPTANCE_TARGET_INVALID",
      message: "AAIS AI acceptance requires an assistant message from the same task.",
      status: 400,
    };
  }
  if (isAaisLearnerMutationError(error)) {
    return getLearnerMutationErrorInput(error.reason);
  }
  if (error instanceof Error && error.message.startsWith("Task ") && error.message.endsWith(" is locked")) {
    return {
      code: "AAIS_TASK_LOCKED",
      message: "AAIS task is locked.",
      status: 400,
    };
  }
  if (error instanceof Error && error.message.startsWith("Unknown task ")) {
    return {
      code: "AAIS_TASK_UNKNOWN",
      message: "AAIS task was not found.",
      status: 400,
    };
  }
  return {
    code: "AAIS_SESSION_REQUEST_FAILED",
    message: "AAIS session request failed.",
    status: 500,
    cause: error,
    route: "/api/learning/session",
  };
}

function getLearnerMutationErrorInput(
  reason: import("@/lib/server/aais-learning-store").AaisLearnerMutationErrorReason,
) {
  const responses = {
    history_document_required: ["AAIS_HISTORY_DOCUMENT_REQUIRED", "AAIS history document is required.", 400],
    history_limit_reached: ["AAIS_HISTORY_LIMIT_REACHED", "AAIS document history has reached its limit.", 409],
    history_not_found: ["AAIS_HISTORY_DOCUMENT_NOT_FOUND", "AAIS history document was not found.", 404],
    history_too_large: ["AAIS_HISTORY_TOO_LARGE", "AAIS document history is too large.", 413],
    history_task_mismatch: ["AAIS_HISTORY_TASK_MISMATCH", "AAIS history document does not belong to this task.", 409],
    mutation_replay_conflict: ["AAIS_MUTATION_ID_CONFLICT", "AAIS mutation id is already bound to different content.", 409],
    scaffold_practice_only: ["AAIS_SCAFFOLD_PRACTICE_ONLY", "AAIS scaffolding is available only for practice tasks.", 400],
    scaffold_tool_invalid: ["AAIS_SCAFFOLD_TOOL_INVALID", "AAIS scaffold tool is invalid.", 400],
    stage_invalid: ["AAIS_STAGE_INVALID", "AAIS stage is invalid.", 400],
    task_locked: ["AAIS_TASK_LOCKED", "AAIS task is locked.", 400],
    task_not_active: ["AAIS_TASK_NOT_ACTIVE", "AAIS task is not active.", 409],
    task_unknown: ["AAIS_TASK_UNKNOWN", "AAIS task was not found.", 400],
  } satisfies Record<typeof reason, readonly [string, string, number]>;
  const [code, message, status] = responses[reason];
  return {
    code,
    message,
    status,
  };
}
