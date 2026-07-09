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
  getAaisOidcStateCookieName,
  resolveAaisOidcConfig,
  verifyAaisOidcIdToken,
  verifyAaisOidcState,
} from "@/lib/server/aais-oidc";
import {
  createAaisSessionToken,
  getAaisDisplayCookieOptions,
  getAaisSessionCookieName,
  getAaisSessionCookieOptions,
} from "@/lib/server/aais-session";
import { createAaisApiErrorResponse } from "@/lib/server/aais-api-error";

export async function GET(request: Request) {
  const config = await resolveAaisOidcConfig();
  if (!config) {
    return createAaisApiErrorResponse({
      code: "AAIS_OIDC_NOT_CONFIGURED",
      message: "AAIS OIDC is not configured.",
      status: 503,
      extra: { secrets: "redacted" },
    });
  }
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const stateCookie = readCookie(request.headers.get("cookie"), getAaisOidcStateCookieName());
  const oidcState = verifyAaisOidcState(
    stateCookie,
    state ?? "",
  );
  if (!code || !oidcState) {
    recordAaisAuditEvent({
      event: "auth.oidc.failure",
      outcome: "failure",
      metadata: {
        ...getOidcAuditContext(),
        reason: "invalid_state",
        codePresent: Boolean(code),
        statePresent: Boolean(state),
        stateCookiePresent: Boolean(stateCookie),
      },
    });
    return createOidcFailureResponse("AAIS OIDC state is invalid.");
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
    recordAaisAuditEvent({
      event: "auth.oidc.success",
      actorId: actor.id,
      outcome: "success",
      metadata: {
        ...getOidcAuditContext(),
        actorRole: actor.role,
      },
    });
    const response = new NextResponse(null, {
      status: 307,
      headers: {
        location: oidcState.returnTo,
      },
    });
    response.cookies.set(getAaisSessionCookieName(), createAaisSessionToken(actor), getAaisSessionCookieOptions());
    response.cookies.set(getAaisCsrfCookieName(), createAaisCsrfToken(actor.id), getAaisCsrfCookieOptions());
    response.cookies.set("aais_student_id", actor.id, getAaisDisplayCookieOptions());
    response.cookies.set("aais_display_name", actor.displayName, getAaisDisplayCookieOptions());
    response.cookies.set(getAaisOidcStateCookieName(), "", getAaisOidcExpiredCookieOptions());
    return response;
  } catch (error) {
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
  response.cookies.set(getAaisOidcStateCookieName(), "", getAaisOidcExpiredCookieOptions());
  return response;
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
  return decodeURIComponent(cookie.slice(name.length + 1));
}
