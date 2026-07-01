import { NextResponse } from "next/server";
import {
  type AaisCohortAnalyticsFilters,
  getAaisLearningStore,
  isAaisLearningStorageConfigurationError,
} from "@/lib/server/aais-learning-store";
import { isAaisAuthError, requireAaisSessionActor, resolveAaisStudentId } from "@/lib/server/aais-request-auth";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const scope = url.searchParams.get("scope");
    const store = getAaisLearningStore();
    const analytics = scope === "cohort"
      ? await getAuthorizedCohortAnalytics(request, store, readCohortAnalyticsFilters(url.searchParams))
      : await store.getAnalytics(resolveAaisStudentId(request));
    return NextResponse.json({
      analytics,
      secrets: "redacted",
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "AAIS analytics request failed.",
        secrets: "redacted",
      },
      { status: getErrorStatus(error) },
    );
  }
}

async function getAuthorizedCohortAnalytics(
  request: Request,
  store: ReturnType<typeof getAaisLearningStore>,
  filters: AaisCohortAnalyticsFilters,
) {
  const actor = requireAaisSessionActor(request);
  if (actor.role !== "teacher" && actor.role !== "admin") {
    throw new AaisAnalyticsAuthorizationError();
  }
  return store.getCohortAnalytics(filters);
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

class AaisAnalyticsAuthorizationError extends Error {
  constructor() {
    super("AAIS teacher analytics requires educator authorization.");
  }
}

function getErrorStatus(error: unknown) {
  if (isAaisAuthError(error)) {
    return 401;
  }
  if (error instanceof AaisAnalyticsAuthorizationError) {
    return 403;
  }
  if (isAaisLearningStorageConfigurationError(error)) {
    return 503;
  }
  return 400;
}
