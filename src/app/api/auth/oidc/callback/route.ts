import { NextResponse } from "next/server";
import {
  createAaisCsrfToken,
  getAaisCsrfCookieName,
  getAaisCsrfCookieOptions,
} from "@/lib/server/aais-csrf";
import { recordAaisAuditEvent } from "@/lib/server/aais-audit-log";
import {
  exchangeAaisOidcCodeForIdToken,
  getAaisOidcConfigurationStatus,
  getAaisOidcExpiredCookieOptions,
  getAaisOidcRoleMappingStatus,
  getAaisOidcSessionPolicyFingerprint,
  getAaisOidcStateCookieName,
  isAaisOidcProviderUnavailableError,
  resolveAaisOidcConfig,
  verifyAaisOidcIdToken,
  verifyAaisOidcState,
} from "@/lib/server/aais-oidc";
import {
  createAaisSessionToken,
  getAaisOidcSessionTtlSeconds,
  getAaisSessionCookieName,
  getAaisSessionCookieOptions,
  type AaisSessionActor,
} from "@/lib/server/aais-session";
import { createAaisApiErrorResponse } from "@/lib/server/aais-api-error";
import { AaisSessionConfigurationError } from "@/lib/server/aais-session-secret";

export async function GET(request: Request) {
  let completedCallback: {
    actor: AaisSessionActor;
    response: NextResponse;
  };
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const stateCookie = readCookie(request.headers.get("cookie"), getAaisOidcStateCookieName());
  if (!code || !state || !stateCookie) {
    return createInvalidStateResponse({ code, state, stateCookie });
  }
  let oidcState;
  try {
    oidcState = verifyAaisOidcState(
      stateCookie,
      state ?? "",
    );
  } catch (error) {
    if (error instanceof AaisSessionConfigurationError) {
      recordOidcFailure("session_configuration");
      return createOidcUnavailableResponse(
        "AAIS_SESSION_SECRET_NOT_CONFIGURED",
        "AAIS session secret is not configured securely.",
        error,
      );
    }
    throw error;
  }
  if (!oidcState) {
    return createInvalidStateResponse({ code, state, stateCookie });
  }
  let config;
  try {
    config = await resolveAaisOidcConfig();
  } catch (error) {
    recordOidcFailure("provider_configuration_unavailable");
    return createOidcUnavailableResponse(
      "AAIS_OIDC_PROVIDER_UNAVAILABLE",
      "AAIS OIDC provider configuration is temporarily unavailable.",
      error,
    );
  }
  if (!config) {
    recordOidcFailure("provider_configuration_unavailable");
    return createOidcUnavailableResponse(
      "AAIS_OIDC_NOT_CONFIGURED",
      "AAIS OIDC is not configured.",
    );
  }

  try {
    const idToken = await exchangeAaisOidcCodeForIdToken({
      config,
      code,
      codeVerifier: oidcState.codeVerifier,
    });
    const actor = await verifyAaisOidcIdToken({
      config,
      idToken,
      nonce: oidcState.nonce,
    });
    const sessionPolicyFingerprint = getAaisOidcSessionPolicyFingerprint(config);
    if (!sessionPolicyFingerprint) {
      throw new Error("AAIS OIDC session policy is unavailable.");
    }
    const oidcSessionTtlSeconds = getAaisOidcSessionTtlSeconds();
    const sessionToken = createAaisSessionToken(actor, new Date(), {
      authSource: "oidc",
      oidcPolicyFingerprint: sessionPolicyFingerprint,
      ttlSeconds: oidcSessionTtlSeconds,
    });
    const csrfToken = createAaisCsrfToken(actor.id);
    const response = new NextResponse(null, {
      status: 307,
      headers: {
        location: oidcState.returnTo,
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
      },
    });
    response.cookies.set(
      getAaisSessionCookieName(),
      sessionToken,
      getAaisSessionCookieOptions(oidcSessionTtlSeconds),
    );
    response.cookies.set(getAaisCsrfCookieName(), csrfToken, getAaisCsrfCookieOptions());
    expireOidcCallbackCookies(response);
    completedCallback = { actor, response };
  } catch (error) {
    if (isAaisOidcProviderUnavailableError(error)) {
      recordOidcFailure(`${error.operation}_provider_unavailable`);
      return createOidcUnavailableResponse(
        "AAIS_OIDC_PROVIDER_UNAVAILABLE",
        "AAIS OIDC provider is temporarily unavailable.",
        error,
        502,
      );
    }
    recordAaisAuditEvent({
      event: "auth.oidc.failure",
      outcome: "failure",
      metadata: {
        ...getOidcAuditContext(),
        reason: classifyOidcCallbackFailure(error),
      },
    });
    return createOidcFailureResponse("AAIS OIDC callback failed.");
  }
  recordAaisAuditEvent({
    event: "auth.oidc.success",
    actorId: completedCallback.actor.id,
    outcome: "success",
    metadata: {
      ...getOidcAuditContext(),
      actorRole: completedCallback.actor.role,
    },
  });
  return completedCallback.response;
}

function createOidcFailureResponse(message: string) {
  const response = createAaisApiErrorResponse({
    code: message === "AAIS OIDC state is invalid."
      ? "AAIS_OIDC_STATE_INVALID"
      : "AAIS_OIDC_CALLBACK_FAILED",
    message,
    status: 401,
    extra: { secrets: "redacted" },
  });
  expireOidcCallbackCookies(response);
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}

function createOidcUnavailableResponse(
  code:
    | "AAIS_OIDC_NOT_CONFIGURED"
    | "AAIS_OIDC_PROVIDER_UNAVAILABLE"
    | "AAIS_SESSION_SECRET_NOT_CONFIGURED",
  message: string,
  cause?: unknown,
  status: 502 | 503 = 503,
) {
  const response = createAaisApiErrorResponse({
    code,
    message,
    status,
    extra: { secrets: "redacted" },
    cause,
    route: "/api/auth/oidc/callback",
  });
  expireOidcCallbackCookies(response);
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}

function createInvalidStateResponse(input: {
  code: string | null;
  state: string | null;
  stateCookie: string | null;
}) {
  recordAaisAuditEvent({
    event: "auth.oidc.failure",
    outcome: "failure",
    metadata: {
      ...getOidcAuditContext(),
      reason: "invalid_state",
      codePresent: Boolean(input.code),
      statePresent: Boolean(input.state),
      stateCookiePresent: Boolean(input.stateCookie),
    },
  });
  return createOidcFailureResponse("AAIS OIDC state is invalid.");
}

function recordOidcFailure(reason: string) {
  recordAaisAuditEvent({
    event: "auth.oidc.failure",
    outcome: "failure",
    metadata: {
      ...getOidcAuditContext(),
      reason,
    },
  });
}

function expireOidcCallbackCookies(response: NextResponse) {
  const options = getAaisOidcExpiredCookieOptions();
  response.cookies.set(getAaisOidcStateCookieName(), "", options);
  response.cookies.set("aais_student_id", "", options);
  response.cookies.set("aais_display_name", "", options);
}

function getOidcAuditContext() {
  const configuration = getAaisOidcConfigurationStatus();
  const roleMapping = getAaisOidcRoleMappingStatus();
  return {
    authSource: "oidc-callback",
    providerMode: configuration.mode,
    roleMappingConfigured: roleMapping.configured,
    roleMappingPresent: roleMapping.present,
    roleMappingRedaction: roleMapping.redaction,
  };
}

function classifyOidcCallbackFailure(error: unknown) {
  if (!(error instanceof Error)) {
    return "unknown";
  }
  if (error.message.startsWith("AAIS OIDC token exchange failed")) {
    return "token_exchange_failed";
  }
  if (error.message === "AAIS OIDC token response did not include id_token.") {
    return "missing_id_token";
  }
  if (error.message.startsWith("AAIS OIDC JWKS lookup failed")) {
    return "jwks_lookup_failed";
  }
  if (error.message === "AAIS OIDC signing key was not found.") {
    return "signing_key_not_found";
  }
  if (error.message === "AAIS OIDC nonce mismatch.") {
    return "nonce_mismatch";
  }
  if (error.message === "AAIS OIDC subject is missing.") {
    return "missing_subject";
  }
  if (error.message === "AAIS OIDC email is missing.") {
    return "missing_email";
  }
  if (error.message === "AAIS OIDC email is not verified.") {
    return "unverified_email";
  }
  return "token_verification_failed";
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
