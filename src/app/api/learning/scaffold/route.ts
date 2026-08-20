import { NextResponse } from "next/server";
import {
  AaisLearnerSessionNotFoundError,
  createAaisLearnerSessionApiDto,
  getAaisLearningStore,
  isAaisLearnerMutationError,
  isAaisLearnerDataGenerationConflictError,
  isAaisLearnerSessionNotFoundError,
  isAaisLearnerSessionLimitError,
  isAaisLearningStorageConfigurationError,
  isAaisSessionWriteConflictError,
} from "@/lib/server/aais-learning-store";
import { isAaisCsrfError, requireAaisCsrf } from "@/lib/server/aais-csrf";
import { isAaisAuthError, requireAaisSessionActor } from "@/lib/server/aais-request-auth";
import {
  AaisApiRouteError,
  createAaisApiErrorResponse,
  isAaisApiRouteError,
} from "@/lib/server/aais-api-error";
import {
  AaisRequestBodyError,
  readAaisBoundedJson,
} from "@/lib/server/aais-request-json";
import { acquireAaisResearchRawTextWriteLeaseIfRequired } from "@/lib/server/aais-research-raw-text";
import { scaffoldTools } from "@/data/aais";
import {
  readOptionalAaisLearningRequestId,
  requireAaisLearningRequestId,
} from "../aais-learning-request-id";

const maxScaffoldRequestBodyBytes = 16 * 1024;

export async function POST(request: Request) {
  try {
    const actor = await requireAaisSessionActor(request);
    const studentId = actor.id;
    requireAaisCsrf(request, studentId);
    const body = await readAaisBoundedJson(request, {
      maxBytes: maxScaffoldRequestBodyBytes,
    }) as
      | {
          studentId?: string;
          taskId?: string;
          toolId?: string;
          dataGeneration?: number;
        }
      | null;
    const taskId = requireScaffoldTaskId(body?.taskId);
    const toolId = readOptionalScaffoldId(body?.toolId, "toolId");
    if (toolId && !scaffoldTools.some((tool) => tool.id === toolId)) {
      throw new AaisApiRouteError({
        code: "AAIS_SCAFFOLD_TOOL_INVALID",
        message: "AAIS scaffold tool is invalid.",
        status: 400,
      });
    }
    const dataGeneration = requireDataGeneration(body?.dataGeneration);
    const store = getAaisLearningStore();
    if (!await store.readSession(studentId)) {
      throw new AaisLearnerSessionNotFoundError();
    }
    const rawTextWriteLease = await acquireAaisResearchRawTextWriteLeaseIfRequired(actor);
    try {
      const result = await store.requestScaffold(
        studentId,
        taskId,
        toolId,
        dataGeneration,
      );
      return NextResponse.json({
        ...result,
        session: createAaisLearnerSessionApiDto(result.session),
      }, {
        headers: {
          "cache-control": "private, no-store",
        },
      });
    } finally {
      await rawTextWriteLease?.release();
    }
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

function requireScaffoldTaskId(value: unknown) {
  return requireAaisLearningRequestId(value, {
    required: {
      code: "AAIS_SCAFFOLD_REQUIRED_FIELD",
      message: "taskId is required.",
    },
    invalid: {
      code: "AAIS_SCAFFOLD_FIELD_INVALID",
      message: "taskId is invalid.",
    },
  });
}

function readOptionalScaffoldId(value: unknown, label: string) {
  return readOptionalAaisLearningRequestId(value, {
    code: "AAIS_SCAFFOLD_FIELD_INVALID",
    message: `${label} is invalid.`,
  });
}

function getErrorResponseInput(error: unknown) {
  if (error instanceof AaisRequestBodyError) {
    return {
      code: error.reason === "too_large"
        ? "AAIS_SCAFFOLD_BODY_TOO_LARGE"
        : "AAIS_SCAFFOLD_BODY_INVALID",
      message: error.reason === "too_large"
        ? "AAIS scaffold request body is too large."
        : "AAIS scaffold request body is invalid.",
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
  if (isAaisLearningStorageConfigurationError(error)) {
    return {
      code: "AAIS_STORAGE_NOT_CONFIGURED",
      message: "AAIS production learner storage requires Postgres configuration.",
      status: 503,
    };
  }
  if (isAaisLearnerSessionNotFoundError(error)) {
    return {
      code: "AAIS_LEARNER_SESSION_NOT_FOUND",
      message: "AAIS learner session was not found.",
      status: 404,
    };
  }
  if (isAaisLearnerMutationError(error)) {
    const code = error.reason === "scaffold_practice_only"
      ? "AAIS_SCAFFOLD_PRACTICE_ONLY"
      : error.reason === "scaffold_tool_invalid"
        ? "AAIS_SCAFFOLD_TOOL_INVALID"
        : error.reason === "task_locked"
          ? "AAIS_TASK_LOCKED"
          : error.reason === "task_unknown"
            ? "AAIS_TASK_UNKNOWN"
            : null;
    if (code) {
      const message = error.reason === "task_unknown"
        ? "AAIS task was not found."
        : error.reason === "task_locked"
          ? "AAIS task is locked."
          : error.reason === "scaffold_tool_invalid"
            ? "AAIS scaffold tool is invalid."
            : "AAIS scaffolding is available only for practice tasks.";
      return {
        code,
        message,
        status: 400,
      };
    }
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
      code: error.reason === "scaffold_history_limit_reached"
        ? "AAIS_SESSION_SCAFFOLD_HISTORY_LIMIT_REACHED"
        : "AAIS_SESSION_PERSISTENCE_LIMIT_REACHED",
      message: error.reason === "scaffold_history_limit_reached"
        ? "AAIS learner session scaffold history has reached its persistence limit."
        : "AAIS learner session has reached its persistence limit.",
      status: 413,
    };
  }
  return {
    code: "AAIS_SCAFFOLD_REQUEST_FAILED",
    message: "AAIS scaffold request failed.",
    status: 500,
    cause: error,
    route: "/api/learning/scaffold",
  };
}
