import { NextResponse } from "next/server";
import {
  createAaisOidcState,
  getAaisOidcStateCookieName,
  getAaisOidcStateCookieOptions,
  resolveAaisOidcConfig,
} from "@/lib/server/aais-oidc";

export async function GET(request: Request) {
  const config = await resolveAaisOidcConfig();
  if (!config) {
    return NextResponse.json(
      {
        error: "AAIS OIDC is not configured.",
        secrets: "redacted",
      },
      { status: 503 },
    );
  }
  const url = new URL(request.url);
  const state = createAaisOidcState(url.searchParams.get("from") ?? "/learning");
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
  return response;
}
