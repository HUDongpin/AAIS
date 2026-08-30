import { NextResponse } from "next/server";
import {
  createAaisCsrfToken,
  getAaisCsrfCookieName,
  getAaisCsrfCookieOptions,
  requireAaisCsrf,
} from "@/lib/server/aais-csrf";
import { recordAaisAuditEvent } from "@/lib/server/aais-audit-log";
import {
  AaisSessionConfigurationError,
  createAaisSessionToken,
  getAaisExpiredCookieOptions,
  getAaisSessionCookieName,
  getAaisSessionCookieOptions,
  verifyAaisSessionTokenWithMetadata,
} from "@/lib/server/aais-session";
import { revokeAaisSessionToken } from "@/lib/server/aais-session-revocations";
import {
  admitAaisLoginAttempt,
  clearAaisLoginFailures,
  type AaisLoginRateLimitResult,
} from "@/lib/server/aais-auth-rate-limit";
import {
  authenticateAaisTrialAccount,
  getAaisTrialSessionPolicyFingerprint,
  isAaisTrialLoginEnabled,
} from "@/lib/server/aais-trial-accounts";
import { authenticateAaisUserAccount } from "@/lib/server/aais-users";
import { createAaisApiErrorResponse } from "@/lib/server/aais-api-error";
import {
  AaisResearchValidationError,
  assertAaisResearchModeEnabled,
  parseAaisResearchEventInput,
} from "@/lib/server/aais-research-contract";
import { getAaisResearchErrorResponseInput } from "@/lib/server/aais-research-api";
import { getAaisResearchStore } from "@/lib/server/aais-research-store";
import { normalizeAaisLocalRedirectTarget } from "@/lib/aais-local-redirect";
import { AaisRequestBodyError, readAaisBoundedJson } from "@/lib/server/aais-request-json";
import { AaisPasswordKdfCapacityError } from "@/lib/server/aais-password-kdf";
import { verifyAaisRequestSessionToken } from "@/lib/server/aais-request-auth";

const aaisLoginConsentVersion = "terms-privacy-guardian-v1";
const aaisLoginBodyMaxBytes = 16 * 1024;
const aaisLogoutBodyMaxBytes = 16 * 1024;
const aaisLoginAccountMaxCharacters = 320;
const aaisLoginPasswordMaxCharacters = 1_024;
const aaisLoginRedirectMaxCharacters = 2_048;

export async function POST(request: Request) {
  try {
    return await handleLoginRequest(request);
  } catch (error) {
    if (error instanceof AaisLoginRequestValidationError) {
      return createAaisApiErrorResponse({
        code: error.code,
        message: error.message,
        status: error.status,
      });
    }
    if (error instanceof AaisPasswordKdfCapacityError) {
      return createAaisApiErrorResponse({
        code: "AAIS_AUTH_CAPACITY_UNAVAILABLE",
        message: "AAIS login is temporarily busy. Please retry shortly.",
        status: 503,
      });
    }
    return createAaisApiErrorResponse({
      code: "AAIS_AUTH_REQUEST_FAILED",
      message: "AAIS login could not be completed.",
      status: 500,
      cause: error,
      route: "/api/auth/app-session",
    });
  }
}

async function handleLoginRequest(request: Request) {
  const body = await readLoginRequestBody(request);

  if (!body.account.trim() || !body.password) {
    return createAaisApiErrorResponse({
      code: "AAIS_AUTH_REQUIRED_FIELDS",
      message: "Account and password are required.",
      status: 401,
    });
  }
  if (body.consentAccepted !== true) {
    return createAaisApiErrorResponse({
      code: "AAIS_LOGIN_CONSENT_REQUIRED",
      message: "AAIS terms, privacy, and guardian consent acknowledgement is required before login.",
      status: 428,
    });
  }
  const account = body.account.trim();
  let rateLimit: AaisLoginRateLimitResult;
  try {
    rateLimit = await admitAaisLoginAttempt({ accountId: account, request });
  } catch (error) {
    return createRateLimitUnavailableResponse(account, error);
  }
  if (rateLimit.status === "blocked") {
    recordAaisAuditEvent({
      event: "auth.login.failure",
      actorId: account,
      outcome: "failure",
      metadata: {
        reason: "rate_limited",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      },
    });
    return createRateLimitResponse(rateLimit.retryAfterSeconds);
  }
  const authResult = await authenticateAaisAccount(account, body.password);
  if (authResult.status === "schema_unavailable") {
    recordAaisAuditEvent({
      event: "auth.login.failure",
      actorId: account,
      outcome: "failure",
      metadata: {
        reason: "schema_unavailable",
      },
    });
    return createAaisApiErrorResponse({
      code: "AAIS_AUTH_STORE_NOT_CONFIGURED",
      message: "AAIS database authentication is temporarily unavailable.",
      status: 503,
    });
  }
  if (authResult.status === "not_configured") {
    if (!isAaisTrialLoginEnabled()) {
      return createAaisApiErrorResponse({
        code: "AAIS_TRIAL_LOGIN_DISABLED",
        message: "AAIS trial login is disabled.",
        status: 404,
      });
    }
    recordAaisAuditEvent({
      event: "auth.login.failure",
      actorId: account,
      outcome: "failure",
      metadata: {
        reason: "not_configured",
      },
    });
    return createAaisApiErrorResponse({
      code: "AAIS_AUTH_NOT_CONFIGURED",
      message: "AAIS auth is not configured.",
      status: 503,
    });
  }
  if (authResult.status !== "ok") {
    recordAaisAuditEvent({
      event: "auth.login.failure",
      actorId: account,
      outcome: "failure",
      metadata: {
        reason: "invalid_credentials",
      },
    });
    return createAaisApiErrorResponse({
      code: "AAIS_INVALID_CREDENTIALS",
      message: "Invalid AAIS trial account or password.",
      status: 401,
    });
  }
  try {
    await clearAaisLoginFailures({ accountId: account, request });
  } catch (error) {
    return createRateLimitUnavailableResponse(account, error);
  }
  const redirectTarget = normalizeAaisLocalRedirectTarget(body.from);

  const response = NextResponse.json(
    {
      redirectTarget,
      appSession: {
        actor: {
          id: authResult.actor.id,
          role: authResult.actor.role,
          displayName: authResult.actor.displayName,
        },
      },
    },
    { headers: { "cache-control": "private, no-store" } },
  );
  const authVersion = "authVersion" in authResult && typeof authResult.authVersion === "number"
    ? authResult.authVersion
    : undefined;
  const sessionCredentials = createSessionCredentialsOrResponse(
    authResult.actor,
    authVersion === undefined
      ? { authSource: "trial" }
      : { authSource: "database", authVersion },
  );
  if (sessionCredentials instanceof NextResponse) {
    recordAaisAuditEvent({
      event: "auth.login.failure",
      actorId: authResult.actor.id,
      outcome: "failure",
      metadata: { reason: "session_configuration" },
    });
    return sessionCredentials;
  }
  response.cookies.set(
    getAaisSessionCookieName(),
    sessionCredentials.sessionToken,
    getAaisSessionCookieOptions(),
  );
  response.cookies.set(
    getAaisCsrfCookieName(),
    sessionCredentials.csrfToken,
    getAaisCsrfCookieOptions(),
  );
  response.cookies.set("aais_student_id", "", getAaisExpiredCookieOptions());
  response.cookies.set("aais_display_name", "", getAaisExpiredCookieOptions());
  recordAaisAuditEvent({
    event: "auth.login.success",
    actorId: account,
    outcome: "success",
    metadata: {
      consentAcknowledged: true,
      consentVersion: aaisLoginConsentVersion,
    },
  });
  return response;
}

type AaisLoginRequestBody = {
  account: string;
  password: string;
  consentAccepted?: boolean;
  from?: string | null;
};

class AaisLoginRequestValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AaisLoginRequestValidationError";
  }
}

async function readLoginRequestBody(request: Request): Promise<AaisLoginRequestBody> {
  let value: unknown;
  try {
    value = await readAaisBoundedJson(request, { maxBytes: aaisLoginBodyMaxBytes });
  } catch (error) {
    if (error instanceof AaisRequestBodyError && error.reason === "too_large") {
      throw new AaisLoginRequestValidationError(
        "AAIS_AUTH_REQUEST_TOO_LARGE",
        "AAIS login request is too large.",
        413,
      );
    }
    throw new AaisLoginRequestValidationError(
      "AAIS_AUTH_REQUEST_INVALID",
      "AAIS login request is invalid.",
      400,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AaisLoginRequestValidationError(
      "AAIS_AUTH_REQUEST_INVALID",
      "AAIS login request is invalid.",
      400,
    );
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set(["account", "password", "consentAccepted", "from"]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new AaisLoginRequestValidationError(
      "AAIS_AUTH_REQUEST_INVALID",
      "AAIS login request is invalid.",
      400,
    );
  }
  if (
    typeof record.account !== "string"
    || typeof record.password !== "string"
    || (record.consentAccepted !== undefined && typeof record.consentAccepted !== "boolean")
    || (record.from !== undefined && record.from !== null && typeof record.from !== "string")
  ) {
    throw new AaisLoginRequestValidationError(
      "AAIS_AUTH_REQUEST_INVALID",
      "AAIS login request is invalid.",
      400,
    );
  }
  if (
    record.account.length > aaisLoginAccountMaxCharacters
    || record.password.length > aaisLoginPasswordMaxCharacters
    || (typeof record.from === "string" && record.from.length > aaisLoginRedirectMaxCharacters)
  ) {
    throw new AaisLoginRequestValidationError(
      "AAIS_AUTH_REQUEST_TOO_LARGE",
      "AAIS login request is too large.",
      413,
    );
  }
  return {
    account: record.account,
    password: record.password,
    ...(record.consentAccepted === undefined
      ? {}
      : { consentAccepted: record.consentAccepted }),
    ...(record.from === undefined ? {} : { from: record.from }),
  };
}

async function authenticateAaisAccount(account: string, password: string) {
  const trialLoginEnabled = isAaisTrialLoginEnabled();
  const [userAttempt, trialAttempt] = await Promise.allSettled([
    authenticateAaisUserAccount(account, password),
    trialLoginEnabled
      ? authenticateAaisTrialAccount(account, password)
      : Promise.resolve({ status: "not_configured" as const }),
  ]);
  if (userAttempt.status === "rejected") {
    throw userAttempt.reason;
  }
  const userResult = userAttempt.value;
  if (userResult.status === "ok") {
    return userResult;
  }
  if (userResult.status === "schema_unavailable") {
    return userResult;
  }
  if (trialAttempt.status === "rejected") {
    throw trialAttempt.reason;
  }
  const trialResult = trialAttempt.value;
  if (userResult.status === "invalid") {
    return userResult;
  }
  if (!trialLoginEnabled) {
    return userResult.status === "not_configured"
      ? { status: "not_configured" as const }
      : { status: "invalid" as const };
  }
  if (trialResult.status === "ok") {
    return trialResult;
  }
  if (userResult.status === "not_configured" && trialResult.status === "not_configured") {
    return { status: "not_configured" as const };
  }
  return { status: "invalid" as const };
}

export async function DELETE(request: Request) {
  try {
    const token = readCookie(request.headers.get("cookie"), getAaisSessionCookieName());
    const verified = verifyAaisSessionTokenWithMetadata(token);
    const authorizedActor = verified
      ? await verifyAaisRequestSessionToken(token)
      : null;
    if (verified) {
      requireAaisCsrf(request, verified.actor.id);
    }
    const researchLogout = authorizedActor
      ? await readResearchLogoutContext(request)
      : null;
    const researchStore = researchLogout ? getAaisResearchStore() : null;
    if (researchLogout) {
      assertAaisResearchModeEnabled();
    }

    let revocation: Awaited<ReturnType<typeof revokeAaisSessionToken>> | null = null;
    try {
      revocation = verified
        ? await revokeAaisSessionToken({
            tokenHash: verified.tokenHash,
            actorId: verified.actor.id,
            expiresAt: verified.expiresAt,
          })
        : null;
    } catch (error) {
      if (authorizedActor && researchLogout && researchStore) {
        try {
          await researchStore.recordEvent(authorizedActor, {
            clientEventId: researchLogout.failureClientEventId,
            clientTime: researchLogout.finalClientTime,
            expectedVisitId: researchLogout.expectedVisitId,
            eventName: "account_logout",
            outcome: "failure",
            detail: {
              operation_id: researchLogout.operationId,
              error_kind: "session_revoke_failed",
            },
          });
        } catch {
          // The authenticated client retries this exact idempotent failure event.
        }
      }
      throw new AaisLogoutRevocationError(error);
    }
    let researchLogoutEvent: Awaited<ReturnType<NonNullable<typeof researchStore>["recordEvent"]>>
      | null = null;
    if (authorizedActor && researchLogout && researchStore) {
      try {
        researchLogoutEvent = await researchStore.recordEvent(authorizedActor, {
          clientEventId: researchLogout.successClientEventId,
          clientTime: researchLogout.finalClientTime,
          expectedVisitId: researchLogout.expectedVisitId,
          eventName: "account_logout",
          outcome: "success",
          detail: {
            operation_id: researchLogout.operationId,
            trigger: "server_session_revoke",
          },
        });
      } catch (error) {
        recordAaisAuditEvent({
          event: "auth.logout",
          actorId: authorizedActor.id,
          outcome: "success",
          metadata: {
            researchEventRecorded: false,
            revocationStorage: revocation?.storageMode ?? "none",
          },
        });
        const response = createAaisApiErrorResponse({
          code: "AAIS_RESEARCH_LOGOUT_ACK_FAILED",
          message: "AAIS server session was revoked, but the final research acknowledgement failed.",
          status: 503,
          extra: {
            sessionRevoked: true,
            researchLogoutAcknowledged: false,
            secrets: "redacted",
          },
          cause: error,
          route: "/api/auth/app-session",
        });
        expireAaisSessionCookies(response);
        return response;
      }
    }
    if (verified) {
      recordAaisAuditEvent({
        event: "auth.logout",
        actorId: verified.actor.id,
        outcome: "success",
        metadata: {
          revocationStorage: revocation?.storageMode ?? "none",
        },
      });
    }
    const response = NextResponse.json(
      {
        ok: true,
        sessionRevoked: Boolean(revocation),
        sessionAbsent: !verified,
        ...(researchLogoutEvent
          ? {
              researchLogout: {
                clientEventId: researchLogoutEvent.clientEventId,
                visitId: researchLogoutEvent.visitId,
              },
            }
          : {}),
        secrets: "redacted",
      },
      { headers: { "cache-control": "private, no-store" } },
    );
    expireAaisSessionCookies(response);
    return response;
  } catch (error) {
    if (error instanceof AaisRequestBodyError) {
      return createAaisApiErrorResponse({
        code: error.reason === "too_large"
          ? "AAIS_LOGOUT_REQUEST_TOO_LARGE"
          : "AAIS_LOGOUT_REQUEST_INVALID",
        message: error.reason === "too_large"
          ? "AAIS logout request is too large."
          : "AAIS logout request is invalid.",
        status: error.status,
      });
    }
    if (error instanceof AaisLogoutRevocationError) {
      return createAaisApiErrorResponse({
        code: "AAIS_LOGOUT_FAILED",
        message: "AAIS server session revocation failed; the session remains active.",
        status: 503,
        cause: error.cause,
        route: "/api/auth/app-session",
      });
    }
    return createAaisApiErrorResponse(
      getAaisResearchErrorResponseInput(error, "/api/auth/app-session"),
    );
  }
}

type AaisResearchLogoutContext = {
  expectedVisitId: string;
  failureClientEventId: string;
  finalClientTime: string;
  operationId: string;
  successClientEventId: string;
};

class AaisLogoutRevocationError extends Error {
  constructor(readonly cause: unknown) {
    super("AAIS logout revocation failed.");
    this.name = "AaisLogoutRevocationError";
  }
}

async function readResearchLogoutContext(
  request: Request,
): Promise<AaisResearchLogoutContext | null> {
  if (!request.body) {
    return null;
  }
  const body = await readAaisBoundedJson(request, {
    maxBytes: aaisLogoutBodyMaxBytes,
    allowEmpty: true,
  });
  if (body === undefined) {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AaisResearchValidationError("AAIS logout request is invalid.");
  }
  const bodyRecord = body as Record<string, unknown>;
  if (Object.keys(bodyRecord).length !== 1 || !("researchLogout" in bodyRecord)) {
    throw new AaisResearchValidationError("AAIS logout request is invalid.");
  }
  const value = bodyRecord.researchLogout;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AaisResearchValidationError("AAIS research logout request is invalid.");
  }
  const record = value as Record<string, unknown>;
  const keys = [
    "expectedVisitId",
    "failureClientEventId",
    "finalClientTime",
    "operationId",
    "successClientEventId",
  ];
  if (
    Object.keys(record).length !== keys.length
    || !keys.every((key) => typeof record[key] === "string")
  ) {
    throw new AaisResearchValidationError("AAIS research logout request is invalid.");
  }
  const context = record as AaisResearchLogoutContext;
  parseAaisResearchEventInput({
    clientEventId: context.successClientEventId,
    clientTime: context.finalClientTime,
    expectedVisitId: context.expectedVisitId,
    eventName: "account_logout",
    outcome: "success",
    detail: {
      operation_id: context.operationId,
      trigger: "server_session_revoke",
    },
  });
  parseAaisResearchEventInput({
    clientEventId: context.failureClientEventId,
    clientTime: context.finalClientTime,
    expectedVisitId: context.expectedVisitId,
    eventName: "account_logout",
    outcome: "failure",
    detail: {
      operation_id: context.operationId,
      error_kind: "session_revoke_failed",
    },
  });
  return context;
}

function readCookie(cookieHeader: string | null, name: string) {
  if (!cookieHeader) {
    return null;
  }
  const cookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!cookie) {
    return null;
  }
  try {
    return decodeURIComponent(cookie.slice(name.length + 1));
  } catch {
    return null;
  }
}

function expireAaisSessionCookies(response: NextResponse) {
  response.cookies.set(getAaisSessionCookieName(), "", {
    ...getAaisExpiredCookieOptions(),
    httpOnly: true,
  });
  response.cookies.set(getAaisCsrfCookieName(), "", getAaisExpiredCookieOptions());
  response.cookies.set("aais_student_id", "", getAaisExpiredCookieOptions());
  response.cookies.set("aais_display_name", "", getAaisExpiredCookieOptions());
}

function createSessionCredentialsOrResponse(
  actor: Parameters<typeof createAaisSessionToken>[0],
  options: NonNullable<Parameters<typeof createAaisSessionToken>[2]>,
) {
  try {
    let sessionOptions = options;
    if (options.authSource === "trial") {
      const trialPolicyFingerprint = getAaisTrialSessionPolicyFingerprint(actor.id);
      if (!trialPolicyFingerprint) {
        return createAaisApiErrorResponse({
          code: "AAIS_AUTH_NOT_CONFIGURED",
          message: "AAIS auth is not configured.",
          status: 503,
        });
      }
      sessionOptions = { ...options, trialPolicyFingerprint };
    }
    return {
      sessionToken: createAaisSessionToken(actor, new Date(), sessionOptions),
      csrfToken: createAaisCsrfToken(actor.id),
    };
  } catch (error) {
    if (error instanceof AaisSessionConfigurationError) {
      return createAaisApiErrorResponse({
        code: "AAIS_SESSION_SECRET_NOT_CONFIGURED",
        message: "AAIS session secret is not configured.",
        status: 503,
      });
    }
    throw error;
  }
}

function createRateLimitResponse(retryAfterSeconds: number) {
  return createAaisApiErrorResponse({
    code: "AAIS_LOGIN_RATE_LIMITED",
    message: "Too many login attempts. Please retry later.",
    status: 429,
    extra: {
      retryAfterSeconds,
    },
    headers: {
      "retry-after": String(retryAfterSeconds),
    },
  });
}

function createRateLimitUnavailableResponse(account: string, cause: unknown) {
  recordAaisAuditEvent({
    event: "auth.login.failure",
    actorId: account,
    outcome: "failure",
    metadata: {
      reason: "rate_limit_unavailable",
    },
  });
  return createAaisApiErrorResponse({
    code: "AAIS_LOGIN_RATE_LIMIT_UNAVAILABLE",
    message: "AAIS login protection is temporarily unavailable.",
    status: 503,
    route: "/api/auth/app-session",
    cause,
  });
}
