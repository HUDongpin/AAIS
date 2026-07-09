import { NextResponse } from "next/server";
import {
  getAaisLearningStore,
  isAaisLearningStorageConfigurationError,
  isAaisSessionWriteConflictError,
} from "@/lib/server/aais-learning-store";
import { isAaisCsrfError, requireAaisCsrf } from "@/lib/server/aais-csrf";
import { isAaisAuthError, resolveAaisStudentId } from "@/lib/server/aais-request-auth";
import {
  AaisApiRouteError,
  createAaisApiErrorResponse,
  isAaisApiRouteError,
} from "@/lib/server/aais-api-error";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | {
        studentId?: string;
        taskId?: string;
        toolId?: string;
      }
    | null;

  try {
    const studentId = await resolveAaisStudentId(request);
    requireAaisCsrf(request, studentId);
    const result = await getAaisLearningStore().requestScaffold(
      studentId,
      requireString(body?.taskId, "taskId"),
      body?.toolId ?? "stage-checklist",
    );
    return NextResponse.json(result);
  } catch (error) {
    return createAaisApiErrorResponse(getErrorResponseInput(error));
  }
}

function requireString(value: string | undefined, label: string) {
  if (!value) {
    throw new AaisApiRouteError({
      code: "AAIS_SCAFFOLD_REQUIRED_FIELD",
      message: `${label} is required.`,
      status: 400,
    });
  }
  return value;
}

function getErrorResponseInput(error: unknown) {
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
  if (error instanceof Error && error.message === "A1 scaffolding is only available in practice tasks") {
    return {
      code: "AAIS_SCAFFOLD_PRACTICE_ONLY",
      message: "AAIS scaffolding is only available in practice tasks.",
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
    code: "AAIS_SCAFFOLD_REQUEST_FAILED",
    message: "AAIS scaffold request failed.",
    status: 400,
    cause: error,
    route: "/api/learning/scaffold",
  };
}
