import { NextResponse } from "next/server";
import {
  type AaisCohortAnalyticsFilters,
  getAaisLearningStore,
  isAaisEducatorScopeAuthorizationError,
  isAaisLearnerSessionNotFoundError,
  isAaisLegacyResearchDataAccessDisabledError,
  isAaisLearningStorageConfigurationError,
  normalizeCohortAnalyticsFilters,
} from "@/lib/server/aais-learning-store";
import { isAaisAuthError, requireAaisSessionActor } from "@/lib/server/aais-request-auth";
import { createAaisApiErrorResponse } from "@/lib/server/aais-api-error";

export async function GET(request: Request) {
  try {
    const actor = await requireAaisSessionActor(request);
    const url = new URL(request.url);
    const format = readExportFormat(url.searchParams);
    const scope = readExportScope(url.searchParams);
    const exported = scope === "cohort"
      ? await getAuthorizedCohortExport(actor, format, url.searchParams)
      : await getAaisLearningStore().exportEvents(actor.id, format);
    return new NextResponse(exported.body, {
      headers: {
        "cache-control": "private, no-store",
        "content-type": exported.contentType,
        "content-disposition": `attachment; filename="${exported.fileName}"`,
      },
    });
  } catch (error) {
    return createAaisApiErrorResponse(getErrorResponseInput(error));
  }
}

async function getAuthorizedCohortExport(
  actor: Awaited<ReturnType<typeof requireAaisSessionActor>>,
  format: "json" | "csv",
  params: URLSearchParams,
) {
  if (actor.role !== "teacher" && actor.role !== "admin") {
    throw new AaisExportAuthorizationError();
  }
  const filters = readCohortAnalyticsFilters(params);
  return getAaisLearningStore().exportEducatorCohortAnalytics(format, {
    actorId: actor.id,
    actorRole: actor.role,
  }, filters);
}

function readExportFormat(params: URLSearchParams): "json" | "csv" {
  const value = params.get("format")?.trim();
  if (!value) {
    return "csv";
  }
  if (value === "json" || value === "csv") {
    return value;
  }
  throw new AaisExportQueryError();
}

function readExportScope(params: URLSearchParams): "owner" | "cohort" {
  const value = params.get("scope")?.trim();
  if (!value || value === "owner") {
    return "owner";
  }
  if (value === "cohort") {
    return value;
  }
  throw new AaisExportQueryError();
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

class AaisExportAuthorizationError extends Error {
  constructor() {
    super("AAIS cohort export requires educator authorization.");
  }
}

class AaisExportQueryError extends Error {
  constructor() {
    super("AAIS export query is invalid.");
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
  if (error instanceof AaisExportAuthorizationError) {
    return {
      code: "AAIS_COHORT_EXPORT_FORBIDDEN",
      message: "AAIS cohort export requires educator authorization.",
      status: 403,
      extra: { secrets: "redacted" },
    };
  }
  if (error instanceof AaisExportQueryError) {
    return {
      code: "AAIS_EXPORT_QUERY_INVALID",
      message: "AAIS export query is invalid.",
      status: 400,
      extra: { secrets: "redacted" },
    };
  }
  if (isAaisEducatorScopeAuthorizationError(error)) {
    return {
      code: "AAIS_COHORT_EXPORT_FORBIDDEN",
      message: "AAIS cohort export requires an active educator enrollment.",
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
      message: "Research event exports are available only through the controlled research export.",
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
    code: "AAIS_EXPORT_REQUEST_FAILED",
    message: "AAIS export request failed.",
    status: 500,
    extra: { secrets: "redacted" },
    cause: error,
    route: "/api/learning/export",
  };
}
