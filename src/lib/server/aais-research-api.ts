import {
  AaisResearchConfigurationError,
  AaisResearchDisabledError,
  AaisResearchValidationError,
} from "@/lib/server/aais-research-contract";
import {
  AaisResearchAuthorizationError,
  AaisResearchCapacityError,
  AaisResearchEventConflictError,
  AaisResearchExportDisabledError,
  AaisResearchVisitInactiveError,
  AaisResearchVisitMismatchError,
  AaisResearchVisitNotFoundError,
  AaisResearchWithdrawalPendingError,
} from "@/lib/server/aais-research-store";
import { isAaisAuthError } from "@/lib/server/aais-request-auth";
import { isAaisCsrfError } from "@/lib/server/aais-csrf";

export function getAaisResearchErrorResponseInput(error: unknown, route: string) {
  const common = { extra: { secrets: "redacted" as const } };
  if (error instanceof AaisResearchDisabledError) {
    return {
      code: "AAIS_RESEARCH_DISABLED",
      message: "AAIS research data collection is disabled.",
      status: 503,
      ...common,
    };
  }
  if (isAaisAuthError(error)) {
    return {
      code: "AAIS_AUTH_REQUIRED",
      message: "AAIS authentication is required.",
      status: 401,
      ...common,
    };
  }
  if (isAaisCsrfError(error)) {
    return {
      code: "AAIS_CSRF_REQUIRED",
      message: "AAIS CSRF token is required.",
      status: 403,
      ...common,
    };
  }
  if (error instanceof AaisResearchAuthorizationError) {
    return {
      code: "AAIS_RESEARCH_FORBIDDEN",
      message: "AAIS research operation is not authorized.",
      status: 403,
      ...common,
    };
  }
  if (error instanceof AaisResearchExportDisabledError) {
    return {
      code: "AAIS_RESEARCH_EXPORT_DISABLED",
      message: "AAIS research event export is disabled.",
      status: 403,
      ...common,
    };
  }
  if (error instanceof AaisResearchCapacityError) {
    return {
      code: "AAIS_RESEARCH_CAPACITY_REACHED",
      message: "AAIS research participant capacity has been reached.",
      status: 409,
      ...common,
    };
  }
  if (error instanceof AaisResearchEventConflictError) {
    return {
      code: "AAIS_RESEARCH_EVENT_CONFLICT",
      message: "AAIS research client event id is already bound to a different payload.",
      status: 409,
      ...common,
    };
  }
  if (error instanceof AaisResearchVisitNotFoundError) {
    return {
      code: "AAIS_RESEARCH_VISIT_NOT_FOUND",
      message: "AAIS research visit was not found.",
      status: 404,
      ...common,
    };
  }
  if (error instanceof AaisResearchVisitMismatchError) {
    return {
      code: "AAIS_RESEARCH_VISIT_MISMATCH",
      message: "AAIS research event does not match the authenticated actor visit.",
      status: 409,
      ...common,
    };
  }
  if (error instanceof AaisResearchVisitInactiveError) {
    return {
      code: "AAIS_RESEARCH_VISIT_INACTIVE",
      message: "AAIS research visit is no longer active.",
      status: 409,
      ...common,
    };
  }
  if (error instanceof AaisResearchWithdrawalPendingError) {
    return {
      code: "AAIS_RESEARCH_WITHDRAWAL_PENDING",
      message: "AAIS research withdrawal is waiting for an in-flight write; retry after it finishes.",
      status: 409,
      ...common,
    };
  }
  if (error instanceof AaisResearchValidationError) {
    return {
      code: "AAIS_RESEARCH_REQUEST_INVALID",
      message: error.message,
      status: 400,
      ...common,
    };
  }
  if (error instanceof AaisResearchConfigurationError) {
    return {
      code: "AAIS_RESEARCH_NOT_CONFIGURED",
      message: "AAIS research infrastructure is not configured.",
      status: 503,
      ...common,
      cause: error,
      route,
    };
  }
  return {
    code: "AAIS_RESEARCH_OPERATION_FAILED",
    message: "AAIS research operation failed.",
    status: 500,
    ...common,
    cause: error,
    route,
  };
}
