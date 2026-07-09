// @vitest-environment node

import { CompactSign, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const oidcEnv = {
  AAIS_SESSION_SECRET: "test-session-secret-with-at-least-32-characters",
  AAIS_OIDC_ISSUER: "https://idp.example.test",
  AAIS_OIDC_CLIENT_ID: "aais-client",
  AAIS_OIDC_CLIENT_SECRET: "aais-client-secret",
  AAIS_OIDC_REDIRECT_URI: "http://localhost/api/auth/oidc/callback",
  AAIS_OIDC_AUTHORIZATION_ENDPOINT: "https://idp.example.test/oauth2/authorize",
  AAIS_OIDC_TOKEN_ENDPOINT: "https://idp.example.test/oauth2/token",
  AAIS_OIDC_JWKS_URI: "https://idp.example.test/.well-known/jwks.json",
};

beforeEach(() => {
  for (const [key, value] of Object.entries(oidcEnv)) {
    process.env[key] = value;
  }
});

afterEach(() => {
  for (const key of Object.keys(oidcEnv)) {
    delete process.env[key];
  }
  delete process.env.AAIS_OIDC_TEACHER_GROUPS;
  delete process.env.AAIS_OIDC_ADMIN_EMAILS;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("AAIS OIDC auth routes", () => {
  it("falls back to the learning page when the return target contains backslashes", async () => {
    const { createAaisOidcState, verifyAaisOidcState } = await import("@/lib/server/aais-oidc");

    const state = createAaisOidcState("/%5C%5Cevil.example/path");
    const verified = verifyAaisOidcState(state.cookieValue, state.state);

    expect(verified?.returnTo).toBe("/learning");
  });

  it("starts an OIDC authorization flow with signed state and nonce", async () => {
    const { GET } = await import("@/app/api/auth/oidc/start/route");

    const response = await GET(new Request("http://localhost/api/auth/oidc/start?from=/learning"));
    const location = new URL(response.headers.get("location") ?? "");
    const setCookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(307);
    expect(location.origin + location.pathname).toBe(oidcEnv.AAIS_OIDC_AUTHORIZATION_ENDPOINT);
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("client_id")).toBe(oidcEnv.AAIS_OIDC_CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(oidcEnv.AAIS_OIDC_REDIRECT_URI);
    expect(location.searchParams.get("scope")).toBe("openid email profile");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("nonce")).toBeTruthy();
    expect(location.searchParams.get("code_challenge")).toBeTruthy();
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.has("code_verifier")).toBe(false);
    expect(setCookie).toContain("aais_oidc_state=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=lax");
  });

  it("fails closed in production when an explicit OIDC endpoint is not HTTPS", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AAIS_OIDC_REDIRECT_URI", "https://www.aais.site/api/auth/oidc/callback");
    vi.stubEnv("AAIS_OIDC_AUTHORIZATION_ENDPOINT", "http://idp.example.test/oauth2/authorize");
    const { GET } = await import("@/app/api/auth/oidc/start/route");

    const response = await GET(new Request("https://www.aais.site/api/auth/oidc/start?from=/learning"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: {
        code: "AAIS_OIDC_NOT_CONFIGURED",
        message: "AAIS OIDC is not configured.",
      },
      secrets: "redacted",
    });
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie") ?? "").not.toContain("aais_oidc_state=");
    expect(JSON.stringify(body)).not.toContain("aais-client-secret");
  });

  it("does not fall back to discovery when explicit OIDC endpoints are only partially configured", async () => {
    delete process.env.AAIS_OIDC_TOKEN_ENDPOINT;
    delete process.env.AAIS_OIDC_JWKS_URI;
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        issuer: oidcEnv.AAIS_OIDC_ISSUER,
        authorization_endpoint: "https://idp.example.test/discovered/authorize",
        token_endpoint: "https://idp.example.test/discovered/token",
        jwks_uri: "https://idp.example.test/discovered/jwks.json",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("@/app/api/auth/oidc/start/route");

    const response = await GET(new Request("http://localhost/api/auth/oidc/start?from=/learning"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: {
        code: "AAIS_OIDC_NOT_CONFIGURED",
        message: "AAIS OIDC is not configured.",
      },
      secrets: "redacted",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBeNull();
  });

  it("starts an OIDC flow from issuer discovery when provider endpoints are not configured explicitly", async () => {
    delete process.env.AAIS_OIDC_AUTHORIZATION_ENDPOINT;
    delete process.env.AAIS_OIDC_TOKEN_ENDPOINT;
    delete process.env.AAIS_OIDC_JWKS_URI;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe("https://idp.example.test/.well-known/openid-configuration");
      return Response.json({
        issuer: oidcEnv.AAIS_OIDC_ISSUER,
        authorization_endpoint: "https://idp.example.test/discovered/authorize",
        token_endpoint: "https://idp.example.test/discovered/token",
        jwks_uri: "https://idp.example.test/discovered/jwks.json",
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("@/app/api/auth/oidc/start/route");

    const response = await GET(new Request("http://localhost/api/auth/oidc/start?from=/learning"));
    const location = new URL(response.headers.get("location") ?? "");

    expect(response.status).toBe(307);
    expect(location.origin + location.pathname).toBe("https://idp.example.test/discovered/authorize");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("client_id")).toBe(oidcEnv.AAIS_OIDC_CLIENT_ID);
    expect(location.searchParams.get("nonce")).toBeTruthy();
    expect(location.searchParams.get("code_challenge")).toBeTruthy();
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("keeps issuer path segments when building the OIDC discovery URL", async () => {
    process.env.AAIS_OIDC_ISSUER = "https://idp.example.test/tenant/v2.0";
    delete process.env.AAIS_OIDC_AUTHORIZATION_ENDPOINT;
    delete process.env.AAIS_OIDC_TOKEN_ENDPOINT;
    delete process.env.AAIS_OIDC_JWKS_URI;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe("https://idp.example.test/tenant/v2.0/.well-known/openid-configuration");
      return Response.json({
        issuer: process.env.AAIS_OIDC_ISSUER,
        authorization_endpoint: "https://idp.example.test/tenant/v2.0/authorize",
        token_endpoint: "https://idp.example.test/tenant/v2.0/token",
        jwks_uri: "https://idp.example.test/tenant/v2.0/jwks.json",
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("@/app/api/auth/oidc/start/route");

    const response = await GET(new Request("http://localhost/api/auth/oidc/start?from=/learning"));
    const location = new URL(response.headers.get("location") ?? "");

    expect(response.status).toBe(307);
    expect(location.origin + location.pathname).toBe("https://idp.example.test/tenant/v2.0/authorize");
  });

  it("exchanges a valid callback for AAIS session and CSRF cookies", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { GET: start } = await import("@/app/api/auth/oidc/start/route");
    const { GET: callback } = await import("@/app/api/auth/oidc/callback/route");
    const startResponse = await start(new Request("http://localhost/api/auth/oidc/start?from=/learning"));
    const authorizationUrl = new URL(startResponse.headers.get("location") ?? "");
    const state = authorizationUrl.searchParams.get("state") ?? "";
    const nonce = authorizationUrl.searchParams.get("nonce") ?? "";
    const stateCookie = extractCookie(startResponse.headers.get("set-cookie") ?? "", "aais_oidc_state");
    const idToken = await createIdToken({ nonce });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === oidcEnv.AAIS_OIDC_TOKEN_ENDPOINT) {
        expect(init?.method).toBe("POST");
        expect(String(init?.body)).toContain("grant_type=authorization_code");
        expect(String(init?.body)).toContain("code=valid-code");
        expect(String(init?.body)).toContain("code_verifier=");
        expect(String(init?.body)).not.toContain("code_challenge");
        return Response.json({
          token_type: "Bearer",
          id_token: idToken,
        });
      }
      if (url === oidcEnv.AAIS_OIDC_JWKS_URI) {
        return Response.json({
          keys: [await publicJwk],
        });
      }
      return new Response("unexpected request", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await callback(
      new Request(`http://localhost/api/auth/oidc/callback?code=valid-code&state=${encodeURIComponent(state)}`, {
        headers: {
          cookie: `aais_oidc_state=${stateCookie}`,
        },
      }),
    );
    const setCookie = response.headers.get("set-cookie") ?? "";
    const auditEvents = info.mock.calls.map((call) => JSON.parse(String(call[0])));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/learning");
    expect(setCookie).toContain("aais_session=");
    expect(setCookie).toContain("aais_csrf=");
    expect(setCookie).toContain("aais_oidc_state=");
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).not.toContain("valid-code");
    expect(setCookie).not.toContain(idToken);
    expect(auditEvents).toEqual([
      expect.objectContaining({
        type: "aais.audit",
        event: "auth.oidc.success",
        actorId: expect.stringMatching(/^actor:[a-f0-9]{16}$/),
        actorIdRedaction: "sha256-16",
        outcome: "success",
        metadata: expect.objectContaining({
          authSource: "oidc-callback",
          actorRole: "student",
        }),
      }),
    ]);
    expect(JSON.stringify(auditEvents)).not.toContain("enterprise-user-1");
    expect(JSON.stringify(auditEvents)).not.toContain("learner@example.test");
    info.mockRestore();
  });

  it("maps configured OIDC educator claims into teacher and admin AAIS sessions", async () => {
    process.env.AAIS_OIDC_TEACHER_GROUPS = "aais-teachers";
    process.env.AAIS_OIDC_ADMIN_EMAILS = "admin@example.test";
    const { GET: start } = await import("@/app/api/auth/oidc/start/route");
    const { GET: callback } = await import("@/app/api/auth/oidc/callback/route");
    const { verifyAaisSessionToken } = await import("@/lib/server/aais-session");

    const teacherStart = await start(new Request("http://localhost/api/auth/oidc/start?from=/dashboard"));
    const teacherAuthorizationUrl = new URL(teacherStart.headers.get("location") ?? "");
    const teacherState = teacherAuthorizationUrl.searchParams.get("state") ?? "";
    const teacherNonce = teacherAuthorizationUrl.searchParams.get("nonce") ?? "";
    const teacherStateCookie = extractCookie(teacherStart.headers.get("set-cookie") ?? "", "aais_oidc_state");
    const teacherToken = await createIdToken({
      nonce: teacherNonce,
      extraClaims: {
        groups: ["aais-teachers"],
        email: "teacher@example.test",
        name: "Enterprise Teacher",
      },
    });

    const adminStart = await start(new Request("http://localhost/api/auth/oidc/start?from=/dashboard"));
    const adminAuthorizationUrl = new URL(adminStart.headers.get("location") ?? "");
    const adminState = adminAuthorizationUrl.searchParams.get("state") ?? "";
    const adminNonce = adminAuthorizationUrl.searchParams.get("nonce") ?? "";
    const adminStateCookie = extractCookie(adminStart.headers.get("set-cookie") ?? "", "aais_oidc_state");
    const adminToken = await createIdToken({
      nonce: adminNonce,
      extraClaims: {
        groups: ["aais-teachers"],
        email: "admin@example.test",
        name: "Enterprise Admin",
      },
    });

    const tokenQueue = [teacherToken, adminToken];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === oidcEnv.AAIS_OIDC_TOKEN_ENDPOINT) {
        expect(init?.method).toBe("POST");
        return Response.json({
          token_type: "Bearer",
          id_token: tokenQueue.shift(),
        });
      }
      if (url === oidcEnv.AAIS_OIDC_JWKS_URI) {
        return Response.json({
          keys: [await publicJwk],
        });
      }
      return new Response("unexpected request", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const teacherResponse = await callback(
      new Request(`http://localhost/api/auth/oidc/callback?code=teacher-code&state=${encodeURIComponent(teacherState)}`, {
        headers: {
          cookie: `aais_oidc_state=${teacherStateCookie}`,
        },
      }),
    );
    const adminResponse = await callback(
      new Request(`http://localhost/api/auth/oidc/callback?code=admin-code&state=${encodeURIComponent(adminState)}`, {
        headers: {
          cookie: `aais_oidc_state=${adminStateCookie}`,
        },
      }),
    );

    expect(verifyAaisSessionToken(extractCookie(teacherResponse.headers.get("set-cookie") ?? "", "aais_session")))
      .toMatchObject({
        role: "teacher",
        displayName: "Enterprise Teacher",
      });
    expect(verifyAaisSessionToken(extractCookie(adminResponse.headers.get("set-cookie") ?? "", "aais_session")))
      .toMatchObject({
        role: "admin",
        displayName: "Enterprise Admin",
      });
  });

  it("rejects callbacks with missing or mismatched state", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { GET } = await import("@/app/api/auth/oidc/callback/route");

    const response = await GET(
      new Request("http://localhost/api/auth/oidc/callback?code=valid-code&state=tampered", {
        headers: {
          cookie: "aais_oidc_state=also-tampered",
        },
      }),
    );
    const setCookie = response.headers.get("set-cookie") ?? "";
    const auditEvents = info.mock.calls.map((call) => JSON.parse(String(call[0])));

    expect(response.status).toBe(401);
    expect(setCookie).toContain("aais_oidc_state=");
    expect(setCookie).toContain("Max-Age=0");
    expect(auditEvents).toEqual([
      expect.objectContaining({
        type: "aais.audit",
        event: "auth.oidc.failure",
        outcome: "failure",
        metadata: expect.objectContaining({
          authSource: "oidc-callback",
          providerMode: "explicit",
          reason: "invalid_state",
          codePresent: true,
          statePresent: true,
          stateCookiePresent: true,
          roleMappingRedaction: "names-only",
        }),
      }),
    ]);
    expect(JSON.stringify(auditEvents)).not.toContain("tampered");
    expect(JSON.stringify(auditEvents)).not.toContain("also-tampered");
    info.mockRestore();
  });

  it("records redacted fixed-category audit events and clears OIDC state on provider failure", async () => {
    process.env.AAIS_OIDC_TEACHER_GROUPS = "aais-teachers";
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { GET: start } = await import("@/app/api/auth/oidc/start/route");
    const { GET: callback } = await import("@/app/api/auth/oidc/callback/route");
    const startResponse = await start(new Request("http://localhost/api/auth/oidc/start?from=/learning"));
    const authorizationUrl = new URL(startResponse.headers.get("location") ?? "");
    const state = authorizationUrl.searchParams.get("state") ?? "";
    const stateCookie = extractCookie(startResponse.headers.get("set-cookie") ?? "", "aais_oidc_state");
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === oidcEnv.AAIS_OIDC_TOKEN_ENDPOINT) {
        return Response.json(
          {
            error: "invalid_grant",
            error_description: "provider detail must not appear in AAIS audit output",
          },
          { status: 502 },
        );
      }
      return new Response("unexpected request", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await callback(
      new Request(
        `http://localhost/api/auth/oidc/callback?code=provider-code-that-must-not-leak&state=${encodeURIComponent(state)}`,
        {
          headers: {
            cookie: `aais_oidc_state=${stateCookie}`,
          },
        },
      ),
    );
    const setCookie = response.headers.get("set-cookie") ?? "";
    const auditEvents = info.mock.calls.map((call) => JSON.parse(String(call[0])));

    expect(response.status).toBe(401);
    expect(setCookie).toContain("aais_oidc_state=");
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).not.toContain("aais_session=");
    expect(auditEvents).toEqual([
      expect.objectContaining({
        type: "aais.audit",
        event: "auth.oidc.failure",
        outcome: "failure",
        metadata: expect.objectContaining({
          authSource: "oidc-callback",
          providerMode: "explicit",
          reason: "token_exchange_failed",
          roleMappingConfigured: true,
          roleMappingPresent: ["AAIS_OIDC_TEACHER_GROUPS"],
          roleMappingRedaction: "names-only",
        }),
      }),
    ]);
    const serializedAudit = JSON.stringify(auditEvents);
    expect(serializedAudit).not.toContain("provider-code-that-must-not-leak");
    expect(serializedAudit).not.toContain("aais-client-secret");
    expect(serializedAudit).not.toContain("provider detail must not appear");
    expect(serializedAudit).not.toContain(state);
    expect(serializedAudit).not.toContain(stateCookie);
    info.mockRestore();
  });

  it("rejects OIDC callbacks when the ID token does not include a verified email claim", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { GET: start } = await import("@/app/api/auth/oidc/start/route");
    const { GET: callback } = await import("@/app/api/auth/oidc/callback/route");
    const startResponse = await start(new Request("http://localhost/api/auth/oidc/start?from=/learning"));
    const authorizationUrl = new URL(startResponse.headers.get("location") ?? "");
    const state = authorizationUrl.searchParams.get("state") ?? "";
    const nonce = authorizationUrl.searchParams.get("nonce") ?? "";
    const stateCookie = extractCookie(startResponse.headers.get("set-cookie") ?? "", "aais_oidc_state");
    const idToken = await createIdToken({
      nonce,
      extraClaims: {
        email: undefined,
        email_verified: undefined,
      },
    });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === oidcEnv.AAIS_OIDC_TOKEN_ENDPOINT) {
        return Response.json({
          token_type: "Bearer",
          id_token: idToken,
        });
      }
      if (String(input) === oidcEnv.AAIS_OIDC_JWKS_URI) {
        return Response.json({
          keys: [await publicJwk],
        });
      }
      return new Response("unexpected request", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await callback(
      new Request(
        `http://localhost/api/auth/oidc/callback?code=code-for-token-without-email&state=${encodeURIComponent(state)}`,
        {
          headers: {
            cookie: `aais_oidc_state=${stateCookie}`,
          },
        },
      ),
    );
    const setCookie = response.headers.get("set-cookie") ?? "";
    const auditEvents = info.mock.calls.map((call) => JSON.parse(String(call[0])));

    expect(response.status).toBe(401);
    expect(setCookie).toContain("aais_oidc_state=");
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).not.toContain("aais_session=");
    expect(auditEvents).toEqual([
      expect.objectContaining({
        type: "aais.audit",
        event: "auth.oidc.failure",
        outcome: "failure",
        metadata: expect.objectContaining({
          authSource: "oidc-callback",
          providerMode: "explicit",
          reason: "missing_email",
          roleMappingRedaction: "names-only",
        }),
      }),
    ]);
    const serialized = JSON.stringify(auditEvents);
    expect(serialized).not.toContain("code-for-token-without-email");
    expect(serialized).not.toContain(idToken);
    expect(serialized).not.toContain(state);
    expect(serialized).not.toContain(stateCookie);
    info.mockRestore();
  });
});

const keyPairPromise = generateKeyPair("RS256");
const publicJwk = keyPairPromise.then(async ({ publicKey }) => ({
  ...(await exportJWK(publicKey)),
  kid: "test-key",
  alg: "RS256",
  use: "sig",
}));

async function createIdToken(input: {
  nonce: string;
  extraClaims?: Record<string, unknown>;
}) {
  const { privateKey } = await keyPairPromise;
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: oidcEnv.AAIS_OIDC_ISSUER,
    aud: oidcEnv.AAIS_OIDC_CLIENT_ID,
    sub: "enterprise-user-1",
    email: "learner@example.test",
    email_verified: true,
    name: "Enterprise Learner",
    nonce: input.nonce,
    iat: now,
    exp: now + 300,
    ...input.extraClaims,
  };
  return new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .sign(privateKey);
}

function extractCookie(setCookie: string, name: string) {
  const match = setCookie.match(new RegExp(`${name}=([^;,]+)`));
  return match?.[1] ?? "";
}
