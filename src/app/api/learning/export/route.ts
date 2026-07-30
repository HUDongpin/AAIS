import { NextResponse } from "next/server";
import {
  type AaisCohortAnalyticsFilters,
  getAaisLearningStore,
  isAaisLegacyResearchDataAccessDisabledError,
  isAaisLearningStorageConfigurationError,
  normalizeCohortAnalyticsFilters,
} from "@/lib/server/aais-learning-store";
import { isAaisAuthError, requireAaisSessionActor, resolveAaisStudentId } from "@/lib/server/aais-request-auth";
import { createAaisApiErrorResponse } from "@/lib/server/aais-api-error";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const format = url.searchParams.get("format") === "json" ? "json" : "csv";
  const scope = url.searchParams.get("scope");

  try {
    const exported = scope === "cohort"
      ? await getAuthorizedCohortExport(request, format, url.searchParams)
      : await getAaisLearningStore().exportEvents(await resolveAaisStudentId(request), format);
    return new NextResponse(exported.body, {
      headers: {
        "content-type": exported.contentType,
        "content-disposition": `attachment; filename="${exported.fileName}"`,
      },
    });
  } catch (error) {
    return createAaisApiErrorResponse(getErrorResponseInput(error));
  }
}

async function getAuthorizedCohortExport(
  request: Request,
  format: "json" | "csv",
  params: URLSearchParams,
) {
  const actor = await requireAaisSessionActor(request);
  if (actor.role !== "teacher" && actor.role !== "admin") {
    throw new AaisExportAuthorizationError();
  }
  const filters = readCohortAnalyticsFilters(params);
  return getAaisLearningStore().exportCohortAnalytics(format, filters);
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
    status: 400,
    extra: { secrets: "redacted" },
    cause: error,
    route: "/api/learning/export",
  };
}
