import { NextResponse } from "next/server";
import {
  createAaisCsrfToken,
  getAaisCsrfCookieName,
  getAaisCsrfCookieOptions,
} from "@/lib/server/aais-csrf";
import { recordAaisAuditEvent } from "@/lib/server/aais-audit-log";
import {
  AaisSessionConfigurationError,
  createAaisSessionToken,
  getAaisDisplayCookieOptions,
  getAaisExpiredCookieOptions,
  getAaisSessionCookieName,
  getAaisSessionCookieOptions,
  verifyAaisSessionTokenWithMetadata,
} from "@/lib/server/aais-session";
import { revokeAaisSessionToken } from "@/lib/server/aais-session-revocations";
import {
  checkAaisLoginRateLimit,
  clearAaisLoginFailures,
  recordAaisLoginFailure,
  type AaisLoginRateLimitResult,
} from "@/lib/server/aais-auth-rate-limit";
import { authenticateAaisTrialAccount, isAaisTrialLoginEnabled } from "@/lib/server/aais-trial-accounts";
import { authenticateAaisUserAccount } from "@/lib/server/aais-users";
import { createAaisApiErrorResponse } from "@/lib/server/aais-api-error";

const aaisLoginConsentVersion = "terms-privacy-guardian-v1";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    account?: string;
    password?: string;
    consentAccepted?: boolean;
    from?: string | null;
  } | null;

  if (!body?.account?.trim() || !body.password) {
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
    rateLimit = await checkAaisLoginRateLimit({ accountId: account, request });
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
    let failureLimit: AaisLoginRateLimitResult;
    try {
      failureLimit = await recordAaisLoginFailure({ accountId: account, request });
    } catch (error) {
      return createRateLimitUnavailableResponse(account, error);
    }
    recordAaisAuditEvent({
      event: "auth.login.failure",
      actorId: account,
      outcome: "failure",
      metadata: {
        reason: failureLimit.status === "blocked" ? "rate_limited" : "invalid_credentials",
        ...(failureLimit.status === "blocked"
          ? { retryAfterSeconds: failureLimit.retryAfterSeconds }
          : {}),
      },
    });
    if (failureLimit.status === "blocked") {
      return createRateLimitResponse(failureLimit.retryAfterSeconds);
    }
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
  recordAaisAuditEvent({
    event: "auth.login.success",
    actorId: authResult.actor.id,
    outcome: "success",
    metadata: {
      consentAcknowledged: true,
      consentVersion: aaisLoginConsentVersion,
    },
  });

  const redirectTarget = body.from?.startsWith("/") && !body.from.startsWith("//")
    ? body.from
    : "/learning";

  const response = NextResponse.json({
    redirectTarget,
    appSession: {
      actor: {
        id: authResult.actor.id,
        role: authResult.actor.role,
        displayName: authResult.actor.displayName,
      },
    },
  });
  const sessionToken = createSessionTokenOrResponse(authResult.actor);
  if (sessionToken instanceof NextResponse) {
    return sessionToken;
  }
  response.cookies.set(getAaisSessionCookieName(), sessionToken, getAaisSessionCookieOptions());
  response.cookies.set(
    getAaisCsrfCookieName(),
    createAaisCsrfToken(authResult.actor.id),
    getAaisCsrfCookieOptions(),
  );
  response.cookies.set("aais_student_id", authResult.actor.id, getAaisDisplayCookieOptions());
  response.cookies.set("aais_display_name", authResult.actor.displayName, getAaisDisplayCookieOptions());
  return response;
}

async function authenticateAaisAccount(account: string, password: string) {
  const userResult = await authenticateAaisUserAccount(account, password);
  if (userResult.status === "ok") {
    return userResult;
  }
  if (!isAaisTrialLoginEnabled()) {
    return userResult.status === "not_configured"
      ? { status: "not_configured" as const }
      : { status: "invalid" as const };
  }
  const trialResult = authenticateAaisTrialAccount(account, password);
  if (trialResult.status === "ok") {
    return trialResult;
  }
  if (userResult.status === "not_configured" && trialResult.status === "not_configured") {
    return { status: "not_configured" as const };
  }
  return { status: "invalid" as const };
}

export async function DELETE(request?: Request) {
  const token = request ? readCookie(request.headers.get("cookie"), getAaisSessionCookieName()) : null;
  const verified = verifyAaisSessionTokenWithMetadata(token);
  const revocation = verified
    ? await revokeAaisSessionToken({
        tokenHash: verified.tokenHash,
        actorId: verified.actor.id,
        expiresAt: verified.expiresAt,
      })
    : null;
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
  const response = NextResponse.json({
    ok: true,
    sessionRevoked: Boolean(revocation),
    secrets: "redacted",
  });
  response.cookies.set(getAaisSessionCookieName(), "", {
    ...getAaisExpiredCookieOptions(),
    httpOnly: true,
  });
  response.cookies.set(getAaisCsrfCookieName(), "", getAaisExpiredCookieOptions());
  response.cookies.set("aais_student_id", "", getAaisExpiredCookieOptions());
  response.cookies.set("aais_display_name", "", getAaisExpiredCookieOptions());
  return response;
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
  return decodeURIComponent(cookie.slice(name.length + 1));
}

function createSessionTokenOrResponse(actor: Parameters<typeof createAaisSessionToken>[0]) {
  try {
    return createAaisSessionToken(actor);
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
