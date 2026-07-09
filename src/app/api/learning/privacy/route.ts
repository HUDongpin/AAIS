import { NextResponse } from "next/server";
import {
  getAaisLearningStore,
  isAaisLearningStorageConfigurationError,
} from "@/lib/server/aais-learning-store";
import { isAaisCsrfError, requireAaisCsrf } from "@/lib/server/aais-csrf";
import { isAaisAuthError, resolveAaisStudentId } from "@/lib/server/aais-request-auth";
import { createAaisApiErrorResponse } from "@/lib/server/aais-api-error";

export async function GET(request: Request) {
  try {
    const studentId = await resolveAaisStudentId(request);
    const exported = await getAaisLearningStore().exportLearnerData(studentId);
    return NextResponse.json(exported, {
      headers: {
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return createAaisApiErrorResponse(getErrorResponseInput(error));
  }
}

export async function DELETE(request: Request) {
  try {
    const studentId = await resolveAaisStudentId(request);
    requireAaisCsrf(request, studentId);
    const deletion = await getAaisLearningStore().deleteLearnerData(studentId);
    return NextResponse.json(
      {
        deletion,
      },
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    return createAaisApiErrorResponse(getErrorResponseInput(error));
  }
}

function getErrorResponseInput(error: unknown) {
  if (isAaisAuthError(error)) {
    return {
      code: "AAIS_AUTH_REQUIRED",
      message: "AAIS authentication is required.",
      status: 401,
      extra: { secrets: "redacted" },
    };
  }
  if (isAaisCsrfError(error)) {
    return {
      code: "AAIS_CSRF_REQUIRED",
      message: "AAIS CSRF token is required.",
      status: 403,
      extra: { secrets: "redacted" },
    };
  }
  if (isAaisLearningStorageConfigurationError(error)) {
    return {
      code: "AAIS_STORAGE_NOT_CONFIGURED",
      message: "AAIS production learner storage requires Postgres configuration.",
      status: 503,
      extra: { secrets: "redacted" },
    };
  }
  return {
    code: "AAIS_PRIVACY_REQUEST_FAILED",
    message: "AAIS privacy request failed.",
    status: 400,
    extra: { secrets: "redacted" },
    cause: error,
    route: "/api/learning/privacy",
  };
}
