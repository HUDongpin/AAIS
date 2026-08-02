import { NextResponse } from "next/server";
import {
  type AaisCohortAnalyticsFilters,
  type AaisCohortLearnerPaginationInput,
  getAaisLearningStore,
  isAaisLegacyResearchDataAccessDisabledError,
  isAaisLearningStorageConfigurationError,
  normalizeAaisCohortLearnerPagination,
  normalizeCohortAnalyticsFilters,
} from "@/lib/server/aais-learning-store";
import { isAaisAuthError, requireAaisSessionActor, resolveAaisStudentId } from "@/lib/server/aais-request-auth";
import { createAaisApiErrorResponse } from "@/lib/server/aais-api-error";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const scope = url.searchParams.get("scope");
    const analytics = scope === "cohort"
      ? await getAuthorizedCohortAnalytics(request, url.searchParams)
      : await getAaisLearningStore().getAnalytics(await resolveAaisStudentId(request));
    return NextResponse.json({
      analytics,
      secrets: "redacted",
    });
  } catch (error) {
    return createAaisApiErrorResponse(getErrorResponseInput(error));
  }
}

async function getAuthorizedCohortAnalytics(
  request: Request,
  params: URLSearchParams,
) {
  const actor = await requireAaisSessionActor(request);
  if (actor.role !== "teacher" && actor.role !== "admin") {
    throw new AaisAnalyticsAuthorizationError();
  }
  const filters = readCohortAnalyticsFilters(params);
  const pagination = readCohortLearnerPagination(params);
  return getAaisLearningStore().getCohortAnalytics(filters, pagination);
}

function readCohortAnalyticsFilters(params: URLSearchParams): AaisCohortAnalyticsFilters {
  return normalizeCohortAnalyticsFilters({
    phase: readOptionalFilter(params, "phase") as AaisCohortAnalyticsFilters["phase"],
    task: readOptionalFilter(params, "task"),
    agent: readOptionalFilter(params, "agent") as AaisCohortAnalyticsFilters["agent"],
    event: readOptionalFilter(params, "event") as AaisCohortAnalyticsFilters["event"],
    cohort: readOptionalFilter(params, "cohort"),
    role: readOptionalFilter(params, "role"),
    courseId: readOptionalFilter(params, "courseId") ?? readOptionalFilter(params, "course_id"),
  });
}

function readOptionalFilter(params: URLSearchParams, key: string) {
  const value = params.get(key)?.trim();
  return value || undefined;
}

function readCohortLearnerPagination(params: URLSearchParams): AaisCohortLearnerPaginationInput {
  const pagination = {
    limit: readOptionalInteger(params, "limit"),
    offset: readOptionalInteger(params, "offset"),
  };
  normalizeAaisCohortLearnerPagination(pagination);
  return pagination;
}

function readOptionalInteger(params: URLSearchParams, key: string) {
  const raw = params.get(key)?.trim();
  if (!raw) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid AAIS cohort analytics ${key}.`);
  }
  return Number(raw);
}

class AaisAnalyticsAuthorizationError extends Error {
  constructor() {
    super("AAIS teacher analytics requires educator authorization.");
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
  if (error instanceof AaisAnalyticsAuthorizationError) {
    return {
      code: "AAIS_COHORT_ANALYTICS_FORBIDDEN",
      message: "AAIS teacher analytics requires educator authorization.",
      status: 403,
      extra: { secrets: "redacted" },
    };
  }
  if (isAaisLegacyResearchDataAccessDisabledError(error)) {
    return {
      code: "AAIS_RESEARCH_CONTROLLED_EXPORT_REQUIRED",
      message: "Legacy product analytics are disabled on the controlled research deployment.",
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
  if (error instanceof Error && error.message.startsWith("Invalid AAIS cohort analytics ")) {
    return {
      code: "AAIS_COHORT_ANALYTICS_FILTER_INVALID",
      message: "AAIS cohort analytics filter is invalid.",
      status: 400,
      extra: { secrets: "redacted" },
    };
  }
  return {
    code: "AAIS_ANALYTICS_REQUEST_FAILED",
    message: "AAIS analytics request failed.",
    status: 400,
    extra: { secrets: "redacted" },
    cause: error,
    route: "/api/learning/analytics",
  };
}
