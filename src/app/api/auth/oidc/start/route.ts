import { NextResponse } from "next/server";
import {
  createAaisOidcState,
  getAaisOidcStateCookieName,
  getAaisOidcStateCookieOptions,
  resolveAaisOidcConfig,
} from "@/lib/server/aais-oidc";
import { createAaisApiErrorResponse } from "@/lib/server/aais-api-error";
import { AaisSessionConfigurationError } from "@/lib/server/aais-session-secret";

export async function GET(request: Request) {
  let config;
  try {
    config = await resolveAaisOidcConfig();
  } catch (error) {
    return createAaisApiErrorResponse({
      code: "AAIS_OIDC_PROVIDER_UNAVAILABLE",
      message: "AAIS OIDC provider configuration is temporarily unavailable.",
      status: 503,
      extra: { secrets: "redacted" },
      cause: error,
      route: "/api/auth/oidc/start",
    });
  }
  if (!config) {
    return createAaisApiErrorResponse({
      code: "AAIS_OIDC_NOT_CONFIGURED",
      message: "AAIS OIDC is not configured.",
      status: 503,
      extra: { secrets: "redacted" },
    });
  }
  const url = new URL(request.url);
  let state;
  try {
    state = createAaisOidcState(url.searchParams.get("from") ?? "/learning");
  } catch (error) {
    if (error instanceof AaisSessionConfigurationError) {
      return createAaisApiErrorResponse({
        code: "AAIS_SESSION_SECRET_NOT_CONFIGURED",
        message: "AAIS session secret is not configured securely.",
        status: 503,
        extra: { secrets: "redacted" },
      });
    }
    throw error;
  }
  const authorizationUrl = new URL(config.authorizationEndpoint);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", config.clientId);
  authorizationUrl.searchParams.set("redirect_uri", config.redirectUri);
  authorizationUrl.searchParams.set("scope", "openid email profile");
  authorizationUrl.searchParams.set("state", state.state);
  authorizationUrl.searchParams.set("nonce", state.nonce);
  authorizationUrl.searchParams.set("code_challenge", state.codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");

  const response = NextResponse.redirect(authorizationUrl);
  response.cookies.set(
    getAaisOidcStateCookieName(),
    state.cookieValue,
    getAaisOidcStateCookieOptions(),
  );
  response.headers.set("cache-control", "private, no-store");
  return response;
}
