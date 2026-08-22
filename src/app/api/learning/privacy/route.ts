import { NextResponse } from "next/server";
import {
  getAaisLearningStore,
  isAaisLearnerDataDeliveryFenceError,
  isAaisLearnerDataGenerationConflictError,
  isAaisLearningStorageConfigurationError,
} from "@/lib/server/aais-learning-store";
import { isAaisCsrfError, requireAaisCsrf } from "@/lib/server/aais-csrf";
import { isAaisAuthError, resolveAaisStudentId } from "@/lib/server/aais-request-auth";
import {
  AaisApiRouteError,
  createAaisApiErrorResponse,
  isAaisApiRouteError,
} from "@/lib/server/aais-api-error";
import {
  AaisRequestBodyError,
  readAaisBoundedJson,
} from "@/lib/server/aais-request-json";

const maxPrivacyRequestBodyBytes = 16 * 1024;

export async function GET(request: Request) {
  try {
    const studentId = await resolveAaisStudentId(request);
    const exported = await getAaisLearningStore().exportLearnerData(studentId);
    return NextResponse.json(exported, {
      headers: {
        "cache-control": "private, no-store",
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
    const body = await readAaisBoundedJson(request, {
      maxBytes: maxPrivacyRequestBodyBytes,
    }) as {
      dataGeneration?: unknown;
    } | null;
    const deletion = await getAaisLearningStore().deleteLearnerData(
      studentId,
      requireDataGeneration(body?.dataGeneration),
    );
    return NextResponse.json(
      {
        deletion,
      },
      {
        headers: {
          "cache-control": "private, no-store",
        },
      },
    );
  } catch (error) {
    return createAaisApiErrorResponse(getErrorResponseInput(error));
  }
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

function getErrorResponseInput(error: unknown) {
  if (error instanceof AaisRequestBodyError) {
    return {
      code: error.reason === "too_large"
        ? "AAIS_PRIVACY_BODY_TOO_LARGE"
        : "AAIS_PRIVACY_BODY_INVALID",
      message: error.reason === "too_large"
        ? "AAIS privacy request body is too large."
        : "AAIS privacy request body is invalid.",
      status: error.status,
      extra: { secrets: "redacted" },
    };
  }
  if (isAaisApiRouteError(error)) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      extra: { secrets: "redacted" },
    };
  }
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
  if (isAaisLearnerDataGenerationConflictError(error)) {
    return {
      code: "AAIS_LEARNER_DATA_GENERATION_STALE",
      message: "AAIS learner data changed after this request started. Reload the session.",
      status: 409,
      extra: { secrets: "redacted" },
    };
  }
  if (isAaisLearnerDataDeliveryFenceError(error)) {
    return {
      code: error.reason === "in_flight"
        ? "AAIS_LRS_DELIVERY_IN_FLIGHT"
        : "AAIS_LRS_DELIVERY_RECONCILIATION_REQUIRED",
      message: error.reason === "in_flight"
        ? "AAIS is finishing an in-flight learning-record delivery. Retry deletion later."
        : "AAIS cannot confirm the final LRS acknowledgement. Reconciliation is required before deletion can complete.",
      status: 409,
      extra: {
        deletionCompleted: false,
        externalDeliveryState: error.reason,
        secrets: "redacted",
      },
    };
  }
  return {
    code: "AAIS_PRIVACY_REQUEST_FAILED",
    message: "AAIS privacy request failed.",
    status: 500,
    extra: { secrets: "redacted" },
    cause: error,
    route: "/api/learning/privacy",
  };
}
