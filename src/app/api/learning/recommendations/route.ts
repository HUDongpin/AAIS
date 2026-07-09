import { NextResponse } from "next/server";
import {
  type AaisCohortAnalyticsFilters,
  getAaisLearningStore,
  isAaisLearningStorageConfigurationError,
  isAaisRecommendationOverrideTargetError,
  isAaisSessionWriteConflictError,
  normalizeCohortAnalyticsFilters,
} from "@/lib/server/aais-learning-store";
import {
  buildDisabledAaisRecommendations,
  buildAaisLearnerRecommendations,
  isAaisRecommendationsEnabled,
  type AaisRecommendationOverrideDecision,
} from "@/lib/server/aais-recommendations";
import { isAaisAuthError, requireAaisSessionActor } from "@/lib/server/aais-request-auth";
import { isAaisCsrfError, requireAaisCsrf } from "@/lib/server/aais-csrf";
import {
  AaisApiRouteError,
  createAaisApiErrorResponse,
  isAaisApiRouteError,
} from "@/lib/server/aais-api-error";

type RecommendationOverrideBody = {
  recommendationId?: string;
  learnerKey?: string;
  sessionKey?: string;
  ruleId?: string;
  targetTaskId?: string | null;
  decision?: string;
  note?: string;
} | null;

export async function GET(request: Request) {
  try {
    const actor = await requireEducatorActor(request);
    if (!isAaisRecommendationsEnabled()) {
      return NextResponse.json({
        ...buildDisabledAaisRecommendations(),
        actor: {
          role: actor.role,
        },
        secrets: "redacted",
      });
    }
    const url = new URL(request.url);
    const filters = readCohortAnalyticsFilters(url.searchParams);
    const analytics = await getAaisLearningStore().getCohortAnalytics(filters);
    return NextResponse.json({
      ...buildAaisLearnerRecommendations(analytics),
      actor: {
        role: actor.role,
      },
      secrets: "redacted",
    });
  } catch (error) {
    return createAaisApiErrorResponse(getErrorResponseInput(error));
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as RecommendationOverrideBody;
  try {
    const actor = await requireEducatorActor(request);
    requireAaisCsrf(request, actor.id);
    if (!isAaisRecommendationsEnabled()) {
      throw new AaisRecommendationsDisabledError();
    }
    const override = await getAaisLearningStore().recordRecommendationOverride({
      actorId: actor.id,
      actorRole: actor.role,
      learnerKey: requirePattern(body?.learnerKey, /^learner-[a-f0-9]{12}$/, "learnerKey"),
      sessionKey: requirePattern(body?.sessionKey, /^session-[a-f0-9]{12}$/, "sessionKey"),
      recommendationId: requirePattern(
        body?.recommendationId,
        /^recommendation-[a-f0-9]{12}$/,
        "recommendationId",
      ),
      ruleId: requirePattern(body?.ruleId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "ruleId"),
      targetTaskId: body?.targetTaskId
        ? requirePattern(body.targetTaskId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "targetTaskId")
        : null,
      decision: requireRecommendationDecision(body?.decision),
      note: typeof body?.note === "string" ? body.note : "",
    });
    return NextResponse.json({
      override: {
        recommendationId: override.event.detail.recommendation_id,
        learnerKey: override.event.detail.learner_key,
        sessionKey: override.event.detail.session_key,
        decision: override.event.detail.decision,
        event: override.event.event,
      },
      secrets: "redacted",
    });
  } catch (error) {
    return createAaisApiErrorResponse(getErrorResponseInput(error));
  }
}

async function requireEducatorActor(request: Request) {
  const actor = await requireAaisSessionActor(request);
  if (actor.role === "teacher" || actor.role === "admin") {
    return actor as typeof actor & { role: "teacher" | "admin" };
  }
  throw new AaisRecommendationAuthorizationError();
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

function requirePattern(value: string | undefined | null, pattern: RegExp, label: string) {
  if (!value || !pattern.test(value)) {
    throw new AaisApiRouteError({
      code: "AAIS_RECOMMENDATION_REQUIRED_FIELD",
      message: `${label} is required.`,
      status: 400,
    });
  }
  return value;
}

function requireRecommendationDecision(value: string | undefined): AaisRecommendationOverrideDecision {
  if (value === "accepted" || value === "dismissed" || value === "deferred") {
    return value;
  }
  throw new AaisApiRouteError({
    code: "AAIS_RECOMMENDATION_DECISION_INVALID",
    message: "Recommendation override decision is invalid.",
    status: 400,
  });
}

class AaisRecommendationAuthorizationError extends Error {
  constructor() {
    super("AAIS recommendations require educator authorization.");
  }
}

class AaisRecommendationsDisabledError extends Error {
  constructor() {
    super("AAIS recommendations are disabled for this environment.");
  }
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
  if (error instanceof AaisRecommendationAuthorizationError) {
    return {
      code: "AAIS_RECOMMENDATIONS_FORBIDDEN",
      message: "AAIS recommendations require educator authorization.",
      status: 403,
    };
  }
  if (error instanceof AaisRecommendationsDisabledError) {
    return {
      code: "AAIS_RECOMMENDATIONS_DISABLED",
      message: "AAIS recommendations are disabled for this environment.",
      status: 503,
    };
  }
  if (isAaisCsrfError(error)) {
    return {
      code: "AAIS_CSRF_REQUIRED",
      message: "AAIS CSRF token is required.",
      status: 403,
    };
  }
  if (isAaisRecommendationOverrideTargetError(error)) {
    return {
      code: "AAIS_RECOMMENDATION_TARGET_NOT_FOUND",
      message: "AAIS recommendation target was not found.",
      status: 404,
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
  if (error instanceof Error && error.message.startsWith("Invalid AAIS cohort analytics ")) {
    return {
      code: "AAIS_COHORT_ANALYTICS_FILTER_INVALID",
      message: "AAIS cohort analytics filter is invalid.",
      status: 400,
      extra: { secrets: "redacted" },
    };
  }
  return {
    code: "AAIS_RECOMMENDATIONS_REQUEST_FAILED",
    message: "AAIS recommendations request failed.",
    status: 400,
    cause: error,
    route: "/api/learning/recommendations",
  };
}
