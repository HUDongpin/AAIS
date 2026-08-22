// @vitest-environment node

import { createHmac } from "node:crypto";
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

afterEach(async () => {
  const { resetAaisOidcDiscoveryCacheForTests } = await import("@/lib/server/aais-oidc");
  resetAaisOidcDiscoveryCacheForTests();
  for (const key of Object.keys(oidcEnv)) {
    delete process.env[key];
  }
  delete process.env.AAIS_OIDC_TEACHER_GROUPS;
  delete process.env.AAIS_OIDC_RESEARCHER_GROUPS;
  delete process.env.AAIS_OIDC_RESEARCHER_EMAILS;
  delete process.env.AAIS_OIDC_ADMIN_EMAILS;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("AAIS OIDC auth routes", () => {
  it("invalidates the signed OIDC session policy fingerprint when issuer, client, or role mappings change", async () => {
    const { getAaisOidcSessionPolicyFingerprint } = await import("@/lib/server/aais-oidc");
    process.env.AAIS_OIDC_TEACHER_GROUPS = "group-b,group-a";
    const original = getAaisOidcSessionPolicyFingerprint();

    process.env.AAIS_OIDC_TEACHER_GROUPS = "group-a,group-b";
    expect(getAaisOidcSessionPolicyFingerprint()).toBe(original);
    process.env.AAIS_OIDC_TEACHER_GROUPS = "group-a";
    expect(getAaisOidcSessionPolicyFingerprint()).not.toBe(original);
    process.env.AAIS_OIDC_TEACHER_GROUPS = "group-b,group-a";
    process.env.AAIS_OIDC_CLIENT_ID = "replacement-client";
    expect(getAaisOidcSessionPolicyFingerprint()).not.toBe(original);
  });

  it("falls back to the learning page when the return target contains backslashes", async () => {
    const { createAaisOidcState, verifyAaisOidcState } = await import("@/lib/server/aais-oidc");

    const state = createAaisOidcState("/%5C%5Cevil.example/path");
    const verified = verifyAaisOidcState(state.cookieValue, state.state);

    expect(verified?.returnTo).toBe("/learning");
  });

  it("bounds return targets and re-normalizes the signed target when state is consumed", async () => {
    const { createAaisOidcState, verifyAaisOidcState } = await import("@/lib/server/aais-oidc");

    const oversized = createAaisOidcState(`/${"a".repeat(2048)}`);
    expect(verifyAaisOidcState(oversized.cookieValue, oversized.state)?.returnTo).toBe("/learning");

    const original = createAaisOidcState("/learning");
    const [encodedPayload] = original.cookieValue.split(".");
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    payload.returnTo = "/%252F%252Fevil.example.test/path";
    const replacedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const replacementSignature = createHmac("sha256", oidcEnv.AAIS_SESSION_SECRET)
      .update(replacedPayload)
      .digest("base64url");

    expect(
      verifyAaisOidcState(`${replacedPayload}.${replacementSignature}`, original.state)?.returnTo,
    ).toBe("/learning");
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
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("fails OIDC start and callback closed with a structured response when the shared secret is weak", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { createAaisOidcState } = await import("@/lib/server/aais-oidc");
    const validState = createAaisOidcState("/learning");
    process.env.AAIS_SESSION_SECRET = "x";
    const { GET: start } = await import("@/app/api/auth/oidc/start/route");
    const { GET: callback } = await import("@/app/api/auth/oidc/callback/route");

    const startResponse = await start(new Request("http://localhost/api/auth/oidc/start"));
    const callbackResponse = await callback(new Request(
      `http://localhost/api/auth/oidc/callback?code=unused&state=${encodeURIComponent(validState.state)}`,
      { headers: { cookie: `aais_oidc_state=${validState.cookieValue}` } },
    ));

    expect(startResponse.status).toBe(503);
    await expect(startResponse.json()).resolves.toMatchObject({
      error: { code: "AAIS_SESSION_SECRET_NOT_CONFIGURED" },
      secrets: "redacted",
    });
    expect(callbackResponse.status).toBe(503);
    await expect(callbackResponse.json()).resolves.toMatchObject({
      error: { code: "AAIS_SESSION_SECRET_NOT_CONFIGURED" },
      secrets: "redacted",
    });
    expect(callbackResponse.headers.get("set-cookie") ?? "").toContain("aais_oidc_state=;");
    expect(info.mock.calls.map((call) => JSON.parse(String(call[0])))).toEqual([
      expect.objectContaining({
        event: "auth.oidc.failure",
        metadata: expect.objectContaining({ reason: "session_configuration" }),
      }),
    ]);
    error.mockRestore();
    info.mockRestore();
  });

  it("returns a redacted structured 503 when issuer discovery throws", async () => {
    delete process.env.AAIS_OIDC_AUTHORIZATION_ENDPOINT;
    delete process.env.AAIS_OIDC_TOKEN_ENDPOINT;
    delete process.env.AAIS_OIDC_JWKS_URI;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new Error("provider hostname and secret-shaped diagnostics must not leak");
    }));
    const { GET } = await import("@/app/api/auth/oidc/start/route");

    const response = await GET(new Request("http://localhost/api/auth/oidc/start?from=/learning"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: {
        code: "AAIS_OIDC_PROVIDER_UNAVAILABLE",
        message: "AAIS OIDC provider configuration is temporarily unavailable.",
      },
      secrets: "redacted",
    });
    expect(JSON.stringify(body)).not.toContain("hostname");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    error.mockRestore();
  });

  it("classifies malformed, oversized, and failed token/JWKS 2xx bodies as provider unavailable", async () => {
    const {
      exchangeAaisOidcCodeForIdToken,
      resolveAaisOidcConfig,
      verifyAaisOidcIdToken,
    } = await import("@/lib/server/aais-oidc");
    delete process.env.AAIS_OIDC_AUTHORIZATION_ENDPOINT;
    delete process.env.AAIS_OIDC_TOKEN_ENDPOINT;
    delete process.env.AAIS_OIDC_JWKS_URI;

    await expect(resolveAaisOidcConfig(async () => new Response("{}", {
      headers: { "content-length": String((64 * 1024) + 1) },
    }))).resolves.toBeNull();

    const config = createTestOidcConfig();
    const tokenResponses = [
      () => new Response("{", { status: 200 }),
      () => new Response("{}", {
        status: 200,
        headers: { "content-length": String((256 * 1024) + 1) },
      }),
      () => createFailedOidcBodyResponse(),
    ];
    for (const createResponse of tokenResponses) {
      await expect(exchangeAaisOidcCodeForIdToken({
        config,
        code: "bounded-response-code",
        fetchImpl: async () => createResponse(),
      })).rejects.toMatchObject({
        name: "AaisOidcProviderUnavailableError",
        operation: "token",
      });
    }

    const idToken = await createIdToken({ nonce: "bounded-jwks-nonce" });
    const jwksResponses = [
      () => new Response("{", { status: 200 }),
      () => new Response("{}", {
        status: 200,
        headers: { "content-length": String((1024 * 1024) + 1) },
      }),
      () => createFailedOidcBodyResponse(),
    ];
    for (const createResponse of jwksResponses) {
      await expect(verifyAaisOidcIdToken({
        config,
        idToken,
        nonce: "bounded-jwks-nonce",
        fetchImpl: async () => createResponse(),
      })).rejects.toMatchObject({
        name: "AaisOidcProviderUnavailableError",
        operation: "jwks",
      });
    }
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

  it("single-flights concurrent discovery requests and honors positive-cache TTL per issuer", async () => {
    delete process.env.AAIS_OIDC_AUTHORIZATION_ENDPOINT;
    delete process.env.AAIS_OIDC_TOKEN_ENDPOINT;
    delete process.env.AAIS_OIDC_JWKS_URI;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const issuer = String(input).replace(/\/\.well-known\/openid-configuration$/, "");
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks.json`,
      });
    });
    const { resolveAaisOidcConfig } = await import("@/lib/server/aais-oidc");

    const concurrent = await Promise.all(Array.from({ length: 20 }, () =>
      resolveAaisOidcConfig(fetchMock, 1_000)
    ));
    expect(concurrent.every((config) => config?.issuer === oidcEnv.AAIS_OIDC_ISSUER)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await resolveAaisOidcConfig(fetchMock, 300_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await resolveAaisOidcConfig(fetchMock, 301_001);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    process.env.AAIS_OIDC_CLIENT_ID = "replacement-client";
    await resolveAaisOidcConfig(fetchMock, 301_002);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    process.env.AAIS_OIDC_ISSUER = "https://other-idp.example.test";
    await resolveAaisOidcConfig(fetchMock, 301_003);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("short-caches failed discovery without crossing issuer configuration", async () => {
    delete process.env.AAIS_OIDC_AUTHORIZATION_ENDPOINT;
    delete process.env.AAIS_OIDC_TOKEN_ENDPOINT;
    delete process.env.AAIS_OIDC_JWKS_URI;
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
    const { resolveAaisOidcConfig } = await import("@/lib/server/aais-oidc");

    await expect(resolveAaisOidcConfig(fetchMock, 1_000)).resolves.toBeNull();
    await expect(resolveAaisOidcConfig(fetchMock, 15_999)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(resolveAaisOidcConfig(fetchMock, 16_001)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
        expect(init?.signal).toBeInstanceOf(AbortSignal);
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
        expect(init?.signal).toBeInstanceOf(AbortSignal);
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
    const { verifyAaisSessionTokenWithMetadata } = await import("@/lib/server/aais-session");
    const { getAaisOidcSessionPolicyFingerprint } = await import("@/lib/server/aais-oidc");
    const verifiedSession = verifyAaisSessionTokenWithMetadata(
      extractCookie(setCookie, "aais_session"),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/learning");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(setCookie).toContain("aais_session=");
    expect(setCookie).toContain("Max-Age=900");
    expect(setCookie).toContain("aais_csrf=");
    expect(setCookie).toContain("aais_oidc_state=");
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("aais_student_id=;");
    expect(setCookie).toContain("aais_display_name=;");
    expect(setCookie).not.toContain("aais_student_id=oidc");
    expect(setCookie).not.toContain("aais_display_name=Enterprise");
    expect(setCookie).not.toContain("valid-code");
    expect(setCookie).not.toContain(idToken);
    expect(verifiedSession).toMatchObject({
      authSource: "oidc",
      authVersion: null,
      oidcPolicyFingerprint: getAaisOidcSessionPolicyFingerprint(),
    });
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

  it("derives a stable issuer-scoped safe actor id for StringOrURI subjects and isolates legacy ids", async () => {
    const { createAaisOidcActorId, verifyAaisOidcIdToken } = await import("@/lib/server/aais-oidc");
    const subject = "acct:教授@example.test/tenant/resource?mode=学习#身份";
    const idToken = await createIdToken({
      nonce: "actor-id-nonce",
      extraClaims: { sub: subject },
    });
    const config = createTestOidcConfig();
    const fetchMock = createJwksFetchMock();

    const first = await verifyAaisOidcIdToken({
      config,
      idToken,
      nonce: "actor-id-nonce",
      fetchImpl: fetchMock,
    });
    const second = await verifyAaisOidcIdToken({
      config,
      idToken,
      nonce: "actor-id-nonce",
      fetchImpl: createJwksFetchMock(),
    });
    const otherIssuer = "https://other-idp.example.test";
    const otherIssuerToken = await createIdToken({
      nonce: "other-issuer-nonce",
      extraClaims: { iss: otherIssuer, sub: subject },
    });
    const otherIssuerActor = await verifyAaisOidcIdToken({
      config: createTestOidcConfig({ AAIS_OIDC_ISSUER: otherIssuer }),
      idToken: otherIssuerToken,
      nonce: "other-issuer-nonce",
      fetchImpl: createJwksFetchMock(),
    });

    expect(first.id).toBe(second.id);
    expect(first.id).toBe(createAaisOidcActorId(oidcEnv.AAIS_OIDC_ISSUER, subject));
    expect(first.id).toMatch(/^oidc:v2:[a-f0-9]{64}$/);
    expect(first.id).not.toBe(`oidc:${subject}`);
    expect(createAaisOidcActorId(`${oidcEnv.AAIS_OIDC_ISSUER}/`, subject)).toBe(first.id);
    expect(otherIssuerActor.id).not.toBe(first.id);
    expect(createAaisOidcActorId(otherIssuer, subject)).toBe(otherIssuerActor.id);
  });

  it("requires exp, iat, and sub and rejects stale ID tokens", async () => {
    const { verifyAaisOidcIdToken } = await import("@/lib/server/aais-oidc");
    const now = Math.floor(Date.now() / 1000);
    for (const missingClaim of ["exp", "iat", "sub"] as const) {
      const idToken = await createIdToken({
        nonce: "required-claims-nonce",
        extraClaims: { [missingClaim]: undefined },
      });
      await expect(verifyAaisOidcIdToken({
        config: createTestOidcConfig(),
        idToken,
        nonce: "required-claims-nonce",
        fetchImpl: createJwksFetchMock(),
      })).rejects.toThrow();
    }

    const staleToken = await createIdToken({
      nonce: "stale-token-nonce",
      extraClaims: {
        iat: now - (20 * 60),
        exp: now + 5 * 60,
      },
    });
    await expect(verifyAaisOidcIdToken({
      config: createTestOidcConfig(),
      idToken: staleToken,
      nonce: "stale-token-nonce",
      fetchImpl: createJwksFetchMock(),
    })).rejects.toThrow();
  });

  it("enforces an asymmetric signing algorithm allowlist before JWKS lookup", async () => {
    const { verifyAaisOidcIdToken } = await import("@/lib/server/aais-oidc");
    const secret = new TextEncoder().encode("test-only-hmac-key-with-more-than-32-bytes");
    const now = Math.floor(Date.now() / 1000);
    const idToken = await new CompactSign(new TextEncoder().encode(JSON.stringify({
      iss: oidcEnv.AAIS_OIDC_ISSUER,
      aud: oidcEnv.AAIS_OIDC_CLIENT_ID,
      sub: "hmac-subject",
      nonce: "hmac-nonce",
      email: "learner@example.test",
      email_verified: true,
      iat: now,
      exp: now + 300,
    })))
      .setProtectedHeader({ alg: "HS256", kid: "hmac-test-key" })
      .sign(secret);
    const fetchMock = vi.fn<typeof fetch>();

    await expect(verifyAaisOidcIdToken({
      config: createTestOidcConfig(),
      idToken,
      nonce: "hmac-nonce",
      fetchImpl: fetchMock,
    })).rejects.toThrow("AAIS OIDC signing algorithm is not allowed.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires matching azp for multiple audiences and rejects every mismatched azp", async () => {
    const { verifyAaisOidcIdToken } = await import("@/lib/server/aais-oidc");
    const verifyClaims = async (extraClaims: Record<string, unknown>) => {
      const idToken = await createIdToken({ nonce: "azp-nonce", extraClaims });
      return verifyAaisOidcIdToken({
        config: createTestOidcConfig(),
        idToken,
        nonce: "azp-nonce",
        fetchImpl: createJwksFetchMock(),
      });
    };

    await expect(verifyClaims({
      aud: [oidcEnv.AAIS_OIDC_CLIENT_ID, "another-client"],
    })).rejects.toThrow("AAIS OIDC authorized party mismatch.");
    await expect(verifyClaims({
      aud: [oidcEnv.AAIS_OIDC_CLIENT_ID, "another-client"],
      azp: "wrong-client",
    })).rejects.toThrow("AAIS OIDC authorized party mismatch.");
    await expect(verifyClaims({
      aud: oidcEnv.AAIS_OIDC_CLIENT_ID,
      azp: "wrong-client",
    })).rejects.toThrow("AAIS OIDC authorized party mismatch.");
    await expect(verifyClaims({
      aud: [oidcEnv.AAIS_OIDC_CLIENT_ID, "another-client"],
      azp: oidcEnv.AAIS_OIDC_CLIENT_ID,
    })).resolves.toMatchObject({ role: "student" });
  });

  it("maps configured OIDC claims into teacher, researcher, and admin AAIS sessions", async () => {
    process.env.AAIS_OIDC_TEACHER_GROUPS = "aais-teachers";
    process.env.AAIS_OIDC_RESEARCHER_GROUPS = "aais-researchers";
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

    const researcherStart = await start(new Request("http://localhost/api/auth/oidc/start?from=/dashboard"));
    const researcherAuthorizationUrl = new URL(researcherStart.headers.get("location") ?? "");
    const researcherState = researcherAuthorizationUrl.searchParams.get("state") ?? "";
    const researcherNonce = researcherAuthorizationUrl.searchParams.get("nonce") ?? "";
    const researcherStateCookie = extractCookie(researcherStart.headers.get("set-cookie") ?? "", "aais_oidc_state");
    const researcherToken = await createIdToken({
      nonce: researcherNonce,
      extraClaims: {
        groups: ["aais-researchers"],
        email: "researcher@example.test",
        name: "Study Researcher",
      },
    });

    const tokenQueue = [teacherToken, adminToken, researcherToken];
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
    const researcherResponse = await callback(
      new Request(`http://localhost/api/auth/oidc/callback?code=researcher-code&state=${encodeURIComponent(researcherState)}`, {
        headers: {
          cookie: `aais_oidc_state=${researcherStateCookie}`,
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
    expect(verifyAaisSessionToken(extractCookie(researcherResponse.headers.get("set-cookie") ?? "", "aais_session")))
      .toMatchObject({
        role: "researcher",
        displayName: "Study Researcher",
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

  it("rejects locally incomplete callbacks before discovery or any provider fetch", async () => {
    delete process.env.AAIS_OIDC_AUTHORIZATION_ENDPOINT;
    delete process.env.AAIS_OIDC_TOKEN_ENDPOINT;
    delete process.env.AAIS_OIDC_JWKS_URI;
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const { createAaisOidcState } = await import("@/lib/server/aais-oidc");
    const signed = createAaisOidcState("/learning");
    const { GET } = await import("@/app/api/auth/oidc/callback/route");

    const responses = await Promise.all([
      GET(new Request(`http://localhost/api/auth/oidc/callback?state=${signed.state}`, {
        headers: { cookie: `aais_oidc_state=${signed.cookieValue}` },
      })),
      GET(new Request("http://localhost/api/auth/oidc/callback?code=unused&state=unused")),
      GET(new Request("http://localhost/api/auth/oidc/callback?code=unused")),
    ]);

    expect(responses.map((response) => response.status)).toEqual([401, 401, 401]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a provider invalid_grant response on the redacted 401 callback path", async () => {
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
          { status: 400 },
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
    await expect(response.clone().json()).resolves.toEqual({
      error: {
        code: "AAIS_OIDC_CALLBACK_FAILED",
        message: "AAIS OIDC callback failed.",
      },
      secrets: "redacted",
    });
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

  it("maps a token-provider fetch rejection after valid local state to a redacted gateway error", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { GET: start } = await import("@/app/api/auth/oidc/start/route");
    const { GET: callback } = await import("@/app/api/auth/oidc/callback/route");
    const started = await start(new Request("http://localhost/api/auth/oidc/start"));
    const authorizationUrl = new URL(started.headers.get("location") ?? "");
    const state = authorizationUrl.searchParams.get("state") ?? "";
    const stateCookie = extractCookie(started.headers.get("set-cookie") ?? "", "aais_oidc_state");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => {
      throw new Error("private network detail");
    }));

    const response = await callback(new Request(
      `http://localhost/api/auth/oidc/callback?code=valid-local-state&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `aais_oidc_state=${stateCookie}` } },
    ));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: {
        code: "AAIS_OIDC_PROVIDER_UNAVAILABLE",
        message: "AAIS OIDC provider is temporarily unavailable.",
      },
      secrets: "redacted",
    });
    expect(JSON.stringify(body)).not.toContain("private network detail");
  });

  it.each(["token", "jwks"] as const)(
    "maps a malformed 2xx %s response to a monitored redacted gateway error",
    async (operation) => {
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { GET: start } = await import("@/app/api/auth/oidc/start/route");
      const { GET: callback } = await import("@/app/api/auth/oidc/callback/route");
      const started = await start(new Request("http://localhost/api/auth/oidc/start"));
      const authorizationUrl = new URL(started.headers.get("location") ?? "");
      const state = authorizationUrl.searchParams.get("state") ?? "";
      const nonce = authorizationUrl.searchParams.get("nonce") ?? "";
      const stateCookie = extractCookie(started.headers.get("set-cookie") ?? "", "aais_oidc_state");
      const idToken = await createIdToken({ nonce });
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
        if (String(input) === oidcEnv.AAIS_OIDC_TOKEN_ENDPOINT) {
          return operation === "token"
            ? new Response("{", { status: 200 })
            : Response.json({ id_token: idToken });
        }
        if (String(input) === oidcEnv.AAIS_OIDC_JWKS_URI) {
          return new Response("{", { status: 200 });
        }
        return new Response("unexpected request", { status: 500 });
      }));

      const response = await callback(new Request(
        `http://localhost/api/auth/oidc/callback?code=malformed-provider-body&state=${encodeURIComponent(state)}`,
        { headers: { cookie: `aais_oidc_state=${stateCookie}` } },
      ));
      const body = await response.json();
      const auditEvents = info.mock.calls.map((call) => JSON.parse(String(call[0])));
      const apiErrors = error.mock.calls
        .map((call) => String(call[0]))
        .filter((entry) => entry.startsWith("{"))
        .map((entry) => JSON.parse(entry));

      expect(response.status).toBe(502);
      expect(body).toEqual({
        error: {
          code: "AAIS_OIDC_PROVIDER_UNAVAILABLE",
          message: "AAIS OIDC provider is temporarily unavailable.",
        },
        secrets: "redacted",
      });
      expect(auditEvents).toEqual([
        expect.objectContaining({
          event: "auth.oidc.failure",
          metadata: expect.objectContaining({
            reason: `${operation}_provider_unavailable`,
          }),
        }),
      ]);
      expect(apiErrors).toContainEqual(expect.objectContaining({
        event: "aais.api.error",
        code: "AAIS_OIDC_PROVIDER_UNAVAILABLE",
        status: 502,
        causeName: "AaisOidcProviderUnavailableError",
      }));
      expect(JSON.stringify({ body, auditEvents, apiErrors })).not.toContain("malformed-provider-body");
      info.mockRestore();
      error.mockRestore();
    },
  );

  it("returns a redacted 503 and clears state and legacy display cookies when callback discovery throws", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { GET: start } = await import("@/app/api/auth/oidc/start/route");
    const { GET: callback } = await import("@/app/api/auth/oidc/callback/route");
    const startResponse = await start(new Request("http://localhost/api/auth/oidc/start?from=/learning"));
    const authorizationUrl = new URL(startResponse.headers.get("location") ?? "");
    const state = authorizationUrl.searchParams.get("state") ?? "";
    const stateCookie = extractCookie(startResponse.headers.get("set-cookie") ?? "", "aais_oidc_state");
    delete process.env.AAIS_OIDC_AUTHORIZATION_ENDPOINT;
    delete process.env.AAIS_OIDC_TOKEN_ENDPOINT;
    delete process.env.AAIS_OIDC_JWKS_URI;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => {
      throw new Error("private provider discovery detail");
    }));

    const response = await callback(new Request(
      `http://localhost/api/auth/oidc/callback?code=unused&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `aais_oidc_state=${stateCookie}` } },
    ));
    const body = await response.json();
    const setCookie = response.headers.get("set-cookie") ?? "";
    const auditEvents = info.mock.calls.map((call) => JSON.parse(String(call[0])));

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: {
        code: "AAIS_OIDC_PROVIDER_UNAVAILABLE",
        message: "AAIS OIDC provider configuration is temporarily unavailable.",
      },
      secrets: "redacted",
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(setCookie).toContain("aais_oidc_state=;");
    expect(setCookie).toContain("aais_student_id=;");
    expect(setCookie).toContain("aais_display_name=;");
    expect(auditEvents).toEqual([
      expect.objectContaining({
        event: "auth.oidc.failure",
        outcome: "failure",
        metadata: expect.objectContaining({ reason: "provider_configuration_unavailable" }),
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain("private provider");
    info.mockRestore();
    error.mockRestore();
  });

  it("does not record success when session construction fails after token verification", async () => {
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
      extraClaims: { name: "x".repeat(121) },
    });
    vi.stubGlobal("fetch", createCallbackFetchMock(idToken));

    const response = await callback(new Request(
      `http://localhost/api/auth/oidc/callback?code=valid-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `aais_oidc_state=${stateCookie}` } },
    ));
    const auditEvents = info.mock.calls.map((call) => JSON.parse(String(call[0])));

    expect(response.status).toBe(401);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      event: "auth.oidc.failure",
      outcome: "failure",
    });
    expect(auditEvents.some((event) => event.event === "auth.oidc.success")).toBe(false);
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

function createTestOidcConfig(overrides: Partial<typeof oidcEnv> = {}) {
  const values = { ...oidcEnv, ...overrides };
  return {
    issuer: values.AAIS_OIDC_ISSUER,
    clientId: values.AAIS_OIDC_CLIENT_ID,
    clientSecret: values.AAIS_OIDC_CLIENT_SECRET,
    redirectUri: values.AAIS_OIDC_REDIRECT_URI,
    authorizationEndpoint: values.AAIS_OIDC_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: values.AAIS_OIDC_TOKEN_ENDPOINT,
    jwksUri: values.AAIS_OIDC_JWKS_URI,
  };
}

function createJwksFetchMock() {
  return vi.fn<typeof fetch>(async (_input, init) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json({ keys: [await publicJwk] });
  });
}

function createCallbackFetchMock(idToken: string) {
  return vi.fn<typeof fetch>(async (input) => {
    if (String(input) === oidcEnv.AAIS_OIDC_TOKEN_ENDPOINT) {
      return Response.json({ id_token: idToken });
    }
    if (String(input) === oidcEnv.AAIS_OIDC_JWKS_URI) {
      return Response.json({ keys: [await publicJwk] });
    }
    return new Response("unexpected request", { status: 500 });
  });
}

function createFailedOidcBodyResponse() {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("private OIDC response stream failure"));
    },
  }), { status: 200 });
}
