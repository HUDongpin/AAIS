import { NextResponse } from "next/server";
import {
  type AaisCohortAnalyticsFilters,
  type AaisCohortLearnerPaginationInput,
  getAaisLearningStore,
  isAaisEducatorScopeAuthorizationError,
  isAaisLearnerSessionNotFoundError,
  isAaisLegacyResearchDataAccessDisabledError,
  isAaisLearningStorageConfigurationError,
  normalizeAaisCohortLearnerPagination,
  normalizeCohortAnalyticsFilters,
} from "@/lib/server/aais-learning-store";
import { isAaisAuthError, requireAaisSessionActor } from "@/lib/server/aais-request-auth";
import { createAaisApiErrorResponse } from "@/lib/server/aais-api-error";

export async function GET(request: Request) {
  try {
    const actor = await requireAaisSessionActor(request);
    const url = new URL(request.url);
    const scope = readAnalyticsScope(url.searchParams);
    const analytics = scope === "cohort"
      ? await getAuthorizedCohortAnalytics(actor, url.searchParams)
      : await getAaisLearningStore().getAnalytics(actor.id);
    return NextResponse.json({
      analytics,
      secrets: "redacted",
    }, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return createAaisApiErrorResponse(getErrorResponseInput(error));
  }
}

async function getAuthorizedCohortAnalytics(
  actor: Awaited<ReturnType<typeof requireAaisSessionActor>>,
  params: URLSearchParams,
) {
  if (actor.role !== "teacher" && actor.role !== "admin") {
    throw new AaisAnalyticsAuthorizationError();
  }
  const filters = readCohortAnalyticsFilters(params);
  const pagination = readCohortLearnerPagination(params);
  return getAaisLearningStore().getEducatorCohortAnalytics({
    actorId: actor.id,
    actorRole: actor.role,
  }, filters, pagination);
}

function readAnalyticsScope(params: URLSearchParams): "owner" | "cohort" {
  const value = params.get("scope")?.trim();
  if (!value || value === "owner") {
    return "owner";
  }
  if (value === "cohort") {
    return value;
  }
  throw new AaisAnalyticsQueryError();
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

class AaisAnalyticsQueryError extends Error {
  constructor() {
    super("AAIS analytics query is invalid.");
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
  if (error instanceof AaisAnalyticsQueryError) {
    return {
      code: "AAIS_ANALYTICS_QUERY_INVALID",
      message: "AAIS analytics query is invalid.",
      status: 400,
      extra: { secrets: "redacted" },
    };
  }
  if (isAaisEducatorScopeAuthorizationError(error)) {
    return {
      code: "AAIS_COHORT_ANALYTICS_FORBIDDEN",
      message: "AAIS teacher analytics requires an active educator enrollment.",
      status: 403,
      extra: { secrets: "redacted" },
    };
  }
  if (isAaisLearnerSessionNotFoundError(error)) {
    return {
      code: "AAIS_LEARNER_SESSION_NOT_FOUND",
      message: "AAIS learner session was not found.",
      status: 404,
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
    status: 500,
    extra: { secrets: "redacted" },
    cause: error,
    route: "/api/learning/analytics",
  };
}
