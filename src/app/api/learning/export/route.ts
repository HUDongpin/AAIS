import { NextResponse } from "next/server";
import {
  type AaisCohortAnalyticsFilters,
  getAaisLearningStore,
  isAaisLearningStorageConfigurationError,
} from "@/lib/server/aais-learning-store";
import { isAaisAuthError, requireAaisSessionActor, resolveAaisStudentId } from "@/lib/server/aais-request-auth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const format = url.searchParams.get("format") === "json" ? "json" : "csv";
  const scope = url.searchParams.get("scope");

  try {
    const store = getAaisLearningStore();
    const exported = scope === "cohort"
      ? await getAuthorizedCohortExport(request, store, format, readCohortAnalyticsFilters(url.searchParams))
      : await store.exportEvents(resolveAaisStudentId(request), format);
    return new NextResponse(exported.body, {
      headers: {
        "content-type": exported.contentType,
        "content-disposition": `attachment; filename="${exported.fileName}"`,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "AAIS export request failed.",
      },
      { status: getErrorStatus(error) },
    );
  }
}

async function getAuthorizedCohortExport(
  request: Request,
  store: ReturnType<typeof getAaisLearningStore>,
  format: "json" | "csv",
  filters: AaisCohortAnalyticsFilters,
) {
  const actor = requireAaisSessionActor(request);
  if (actor.role !== "teacher" && actor.role !== "admin") {
    throw new AaisExportAuthorizationError();
  }
  return store.exportCohortAnalytics(format, filters);
}

function readCohortAnalyticsFilters(params: URLSearchParams): AaisCohortAnalyticsFilters {
  return {
    phase: readOptionalFilter(params, "phase") as AaisCohortAnalyticsFilters["phase"],
    task: readOptionalFilter(params, "task"),
    agent: readOptionalFilter(params, "agent") as AaisCohortAnalyticsFilters["agent"],
    event: readOptionalFilter(params, "event") as AaisCohortAnalyticsFilters["event"],
    cohort: readOptionalFilter(params, "cohort"),
    role: readOptionalFilter(params, "role"),
    courseId: readOptionalFilter(params, "courseId") ?? readOptionalFilter(params, "course_id"),
  };
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

function getErrorStatus(error: unknown) {
  if (isAaisAuthError(error)) {
    return 401;
  }
  if (error instanceof AaisExportAuthorizationError) {
    return 403;
  }
  if (isAaisLearningStorageConfigurationError(error)) {
    return 503;
  }
  return 400;
}
