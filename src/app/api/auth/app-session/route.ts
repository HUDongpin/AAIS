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
} from "@/lib/server/aais-session";
import {
  checkAaisLoginRateLimit,
  clearAaisLoginFailures,
  recordAaisLoginFailure,
} from "@/lib/server/aais-auth-rate-limit";
import { authenticateAaisTrialAccount, isAaisTrialLoginEnabled } from "@/lib/server/aais-trial-accounts";

export async function POST(request: Request) {
  if (!isAaisTrialLoginEnabled()) {
    return NextResponse.json({ error: "AAIS trial login is disabled." }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as {
    account?: string;
    password?: string;
    from?: string | null;
  } | null;

  if (!body?.account?.trim() || !body.password) {
    return NextResponse.json({ error: "Account and password are required." }, { status: 401 });
  }
  const account = body.account.trim();
  const rateLimit = checkAaisLoginRateLimit({ accountId: account, request });
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
  const authResult = authenticateAaisTrialAccount(account, body.password);
  if (authResult.status === "not_configured") {
    recordAaisAuditEvent({
      event: "auth.login.failure",
      actorId: account,
      outcome: "failure",
      metadata: {
        reason: "not_configured",
      },
    });
    return NextResponse.json({ error: "AAIS auth is not configured." }, { status: 503 });
  }
  if (authResult.status !== "ok") {
    const failureLimit = recordAaisLoginFailure({ accountId: account, request });
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
    return NextResponse.json({ error: "Invalid AAIS trial account or password." }, { status: 401 });
  }
  clearAaisLoginFailures({ accountId: account, request });
  recordAaisAuditEvent({
    event: "auth.login.success",
    actorId: authResult.actor.id,
    outcome: "success",
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

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(getAaisSessionCookieName(), "", {
    ...getAaisExpiredCookieOptions(),
    httpOnly: true,
  });
  response.cookies.set(getAaisCsrfCookieName(), "", getAaisExpiredCookieOptions());
  response.cookies.set("aais_student_id", "", getAaisExpiredCookieOptions());
  response.cookies.set("aais_display_name", "", getAaisExpiredCookieOptions());
  return response;
}

function createSessionTokenOrResponse(actor: Parameters<typeof createAaisSessionToken>[0]) {
  try {
    return createAaisSessionToken(actor);
  } catch (error) {
    if (error instanceof AaisSessionConfigurationError) {
      return NextResponse.json({ error: "AAIS session secret is not configured." }, { status: 503 });
    }
    throw error;
  }
}

function createRateLimitResponse(retryAfterSeconds: number) {
  return NextResponse.json(
    {
      error: "Too many login attempts. Please retry later.",
      retryAfterSeconds,
    },
    {
      status: 429,
      headers: {
        "retry-after": String(retryAfterSeconds),
      },
    },
  );
}
