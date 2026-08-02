import { NextResponse } from "next/server";
import {
  getAaisLearningStore,
  isAaisLearningStorageConfigurationError,
  isAaisSessionWriteConflictError,
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
  AaisResearchAuthorizationError,
  AaisResearchVisitInactiveError,
  AaisResearchVisitNotFoundError,
} from "@/lib/server/aais-research-store";

export async function GET(request: Request) {
  try {
    const actor = await requireAaisSessionActor(request);
    const session = await getAaisLearningStore().getOrCreateSession(actor.id);
    return jsonSession(session, actor.role);
  } catch (error) {
    return jsonError(error, 400);
  }
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | {
        studentId?: string;
        action?: string;
        stageId?: string;
        taskId?: string;
        messageId?: string;
        artifactText?: string;
        selfReport?: string;
        accepted?: boolean;
        reason?: string;
      }
    | null;

  try {
    const store = getAaisLearningStore();
    const actor = await requireAaisSessionActor(request);
    const studentId = actor.id;
    requireAaisCsrf(request, studentId);
    const rawTextWriteLease = await acquireAaisResearchRawTextWriteLeaseIfRequired(actor);
    try {
      if (body?.action === "select-stage") {
        const session = await store.selectStage(studentId, requireString(body.stageId, "stageId"));
        return jsonSession(session, actor.role);
      }
      if (body?.action === "select-task") {
        const session = await store.selectTask(studentId, requireString(body.taskId, "taskId"));
        return jsonSession(session, actor.role);
      }
      if (body?.action === "complete-task") {
        const session = await store.completeTask(studentId, requireString(body.taskId, "taskId"));
        return jsonSession(session, actor.role);
      }
      if (body?.action === "save-artifact") {
        const session = await store.saveArtifact(
          studentId,
          requireString(body.taskId, "taskId"),
          body.artifactText ?? "",
        );
        return jsonSession(session, actor.role);
      }
      if (body?.action === "save-self-report") {
        const session = await store.saveSelfReport(
          studentId,
          requireString(body.taskId, "taskId"),
          body.selfReport ?? "",
        );
        return jsonSession(session, actor.role);
      }
      if (body?.action === "record-ai-acceptance") {
        const session = await store.recordAiAcceptance(
          studentId,
          requireString(body.taskId, "taskId"),
          {
            accepted: body.accepted === true,
            messageId: body.messageId,
            reason: body.reason,
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
    return jsonError(error, 400);
  }
}

function jsonSession(
  session: Awaited<ReturnType<ReturnType<typeof getAaisLearningStore>["getOrCreateSession"]>>,
  role: "student" | "teacher" | "researcher" | "admin",
) {
  return NextResponse.json({
    session,
    actor: {
      role,
    },
  });
}

function requireString(value: string | undefined, label: string) {
  if (!value) {
    throw new AaisApiRouteError({
      code: "AAIS_SESSION_REQUIRED_FIELD",
      message: `${label} is required.`,
      status: 400,
    });
  }
  return value;
}

function jsonError(error: unknown, status: number) {
  const response = getErrorResponseInput(error, status);
  return createAaisApiErrorResponse(response);
}

function getErrorResponseInput(error: unknown, fallback: number) {
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
    status: fallback,
    cause: error,
    route: "/api/learning/session",
  };
}
