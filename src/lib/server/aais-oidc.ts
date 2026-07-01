import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWTPayload, type JWK } from "jose";
import type { AaisSessionActor } from "@/lib/server/aais-session";

export type AaisOidcConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
};

export type AaisOidcConfigurationStatus = {
  configured: boolean;
  mode: "explicit" | "discovery" | "missing";
};

const aaisOidcRoleMappingEnvNames = [
  "AAIS_OIDC_TEACHER_GROUPS",
  "AAIS_OIDC_TEACHER_EMAILS",
  "AAIS_OIDC_ADMIN_GROUPS",
  "AAIS_OIDC_ADMIN_EMAILS",
] as const;

export type AaisOidcRoleMappingEnvName = typeof aaisOidcRoleMappingEnvNames[number];

export type AaisOidcRoleMappingStatus = {
  configured: boolean;
  present: AaisOidcRoleMappingEnvName[];
  acceptedNames: AaisOidcRoleMappingEnvName[];
  redaction: "names-only";
};

export type AaisOidcState = {
  state: string;
  nonce: string;
  returnTo: string;
};

type SignedOidcStatePayload = AaisOidcState & {
  v: 1;
  iat: number;
  exp: number;
  codeVerifier: string;
};

const oidcStateCookieName = "aais_oidc_state";
const stateTtlSeconds = 10 * 60;
const devSessionSecret = "aais-dev-session-secret-do-not-use-for-production";

export function getAaisOidcStateCookieName() {
  return oidcStateCookieName;
}

export function getAaisOidcConfig(): AaisOidcConfig | null {
  const baseConfig = getAaisOidcBaseConfig();
  if (!baseConfig) {
    return null;
  }
  const endpoints = getAaisOidcExplicitEndpoints();
  if (!endpoints) {
    return null;
  }
  return {
    ...baseConfig,
    ...endpoints,
  };
}

export function getAaisOidcConfigurationStatus(): AaisOidcConfigurationStatus {
  const baseConfig = getAaisOidcBaseConfig();
  if (!baseConfig) {
    return {
      configured: false,
      mode: "missing",
    };
  }
  return {
    configured: true,
    mode: getAaisOidcExplicitEndpoints() ? "explicit" : "discovery",
  };
}

export function getAaisOidcRoleMappingStatus(): AaisOidcRoleMappingStatus {
  const present = aaisOidcRoleMappingEnvNames.filter((name) => readCsv(process.env[name]).size > 0);
  return {
    configured: present.length > 0,
    present,
    acceptedNames: [...aaisOidcRoleMappingEnvNames],
    redaction: "names-only",
  };
}

export async function resolveAaisOidcConfig(fetchImpl: typeof fetch = fetch): Promise<AaisOidcConfig | null> {
  const explicitConfig = getAaisOidcConfig();
  if (explicitConfig) {
    return explicitConfig;
  }
  const baseConfig = getAaisOidcBaseConfig();
  if (!baseConfig) {
    return null;
  }
  const discovery = await discoverAaisOidcEndpoints(baseConfig.issuer, fetchImpl);
  if (!discovery) {
    return null;
  }
  return {
    ...baseConfig,
    ...discovery,
  };
}

function getAaisOidcBaseConfig() {
  const issuer = process.env.AAIS_OIDC_ISSUER?.trim();
  const clientId = process.env.AAIS_OIDC_CLIENT_ID?.trim();
  const clientSecret = process.env.AAIS_OIDC_CLIENT_SECRET?.trim();
  const redirectUri = process.env.AAIS_OIDC_REDIRECT_URI?.trim();
  if (!issuer || !clientId || !clientSecret || !redirectUri) {
    return null;
  }
  return {
    issuer,
    clientId,
    clientSecret,
    redirectUri,
  };
}

function getAaisOidcExplicitEndpoints() {
  const authorizationEndpoint = process.env.AAIS_OIDC_AUTHORIZATION_ENDPOINT?.trim();
  const tokenEndpoint = process.env.AAIS_OIDC_TOKEN_ENDPOINT?.trim();
  const jwksUri = process.env.AAIS_OIDC_JWKS_URI?.trim();
  if (!authorizationEndpoint || !tokenEndpoint || !jwksUri) {
    return null;
  }
  return {
    authorizationEndpoint,
    tokenEndpoint,
    jwksUri,
  };
}

async function discoverAaisOidcEndpoints(issuer: string, fetchImpl: typeof fetch) {
  const discoveryUrl = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const response = await fetchImpl(discoveryUrl, {
    headers: {
      accept: "application/json",
    },
  });
  if (!response.ok) {
    return null;
  }
  const metadata = await response.json().catch(() => null) as {
    issuer?: unknown;
    authorization_endpoint?: unknown;
    token_endpoint?: unknown;
    jwks_uri?: unknown;
  } | null;
  if (
    metadata?.issuer !== issuer
    || typeof metadata.authorization_endpoint !== "string"
    || typeof metadata.token_endpoint !== "string"
    || typeof metadata.jwks_uri !== "string"
  ) {
    return null;
  }
  return {
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    jwksUri: metadata.jwks_uri,
  };
}

export function createAaisOidcState(returnTo: string, now = new Date()) {
  const safeReturnTo = normalizeReturnTarget(returnTo);
  const issuedAt = Math.floor(now.getTime() / 1000);
  const codeVerifier = randomBytes(32).toString("base64url");
  const state: AaisOidcState = {
    state: randomBytes(24).toString("base64url"),
    nonce: randomBytes(24).toString("base64url"),
    returnTo: safeReturnTo,
  };
  const payload: SignedOidcStatePayload = {
    ...state,
    v: 1,
    iat: issuedAt,
    exp: issuedAt + stateTtlSeconds,
    codeVerifier,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return {
    ...state,
    codeChallenge: createPkceCodeChallenge(codeVerifier),
    cookieValue: `${encodedPayload}.${signPayload(encodedPayload)}`,
  };
}

function normalizeReturnTarget(returnTo: string) {
  return isSafeLocalReturnTarget(returnTo) ? returnTo : "/learning";
}

function isSafeLocalReturnTarget(returnTo: string) {
  if (!isPlainLocalPath(returnTo)) {
    return false;
  }
  try {
    return isPlainLocalPath(decodeURIComponent(returnTo));
  } catch {
    return false;
  }
}

function isPlainLocalPath(value: string) {
  return value.startsWith("/")
    && !value.startsWith("//")
    && !/[\\\u0000-\u001F\u007F]/.test(value);
}

export function verifyAaisOidcState(
  cookieValue: string | null | undefined,
  expectedState: string,
  now = new Date(),
): (AaisOidcState & { codeVerifier: string }) | null {
  if (!cookieValue || !expectedState) {
    return null;
  }
  const [encodedPayload, signature, extra] = cookieValue.split(".");
  if (!encodedPayload || !signature || extra || !signatureMatches(encodedPayload, signature)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as
      Partial<SignedOidcStatePayload>;
    if (
      payload.v !== 1
      || typeof payload.state !== "string"
      || typeof payload.nonce !== "string"
      || typeof payload.returnTo !== "string"
      || typeof payload.codeVerifier !== "string"
      || typeof payload.exp !== "number"
      || payload.state !== expectedState
      || payload.exp <= Math.floor(now.getTime() / 1000)
      || !isValidPkceCodeVerifier(payload.codeVerifier)
    ) {
      return null;
    }
    return {
      state: payload.state,
      nonce: payload.nonce,
      returnTo: payload.returnTo,
      codeVerifier: payload.codeVerifier,
    };
  } catch {
    return null;
  }
}

export function getAaisOidcStateCookieOptions() {
  return {
    httpOnly: true,
    maxAge: stateTtlSeconds,
    path: "/",
    sameSite: "lax" as const,
    secure: isProductionRuntime(),
  };
}

export function getAaisOidcExpiredCookieOptions() {
  return {
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "lax" as const,
    secure: isProductionRuntime(),
  };
}

export async function exchangeAaisOidcCodeForIdToken(input: {
  config: AaisOidcConfig;
  code: string;
  codeVerifier?: string;
  fetchImpl?: typeof fetch;
}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.config.redirectUri,
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
  });
  if (input.codeVerifier) {
    body.set("code_verifier", input.codeVerifier);
  }
  const response = await (input.fetchImpl ?? fetch)(input.config.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`AAIS OIDC token exchange failed with ${response.status}`);
  }
  const payload = (await response.json()) as {
    id_token?: string;
  };
  if (!payload.id_token) {
    throw new Error("AAIS OIDC token response did not include id_token.");
  }
  return payload.id_token;
}

export async function verifyAaisOidcIdToken(input: {
  config: AaisOidcConfig;
  idToken: string;
  nonce: string;
  fetchImpl?: typeof fetch;
}): Promise<AaisSessionActor> {
  const header = decodeProtectedHeader(input.idToken);
  const jwksResponse = await (input.fetchImpl ?? fetch)(input.config.jwksUri);
  if (!jwksResponse.ok) {
    throw new Error(`AAIS OIDC JWKS lookup failed with ${jwksResponse.status}`);
  }
  const jwks = (await jwksResponse.json()) as {
    keys?: JWK[];
  };
  const key = jwks.keys?.find((candidate) => !header.kid || candidate.kid === header.kid);
  if (!key) {
    throw new Error("AAIS OIDC signing key was not found.");
  }
  const publicKey = await importJWK(key, String(header.alg ?? "RS256"));
  const verified = await jwtVerify(input.idToken, publicKey, {
    issuer: input.config.issuer,
    audience: input.config.clientId,
  });
  return createActorFromClaims(verified.payload, input.nonce);
}

function createActorFromClaims(payload: JWTPayload, expectedNonce: string): AaisSessionActor {
  if (payload.nonce !== expectedNonce) {
    throw new Error("AAIS OIDC nonce mismatch.");
  }
  if (!payload.sub) {
    throw new Error("AAIS OIDC subject is missing.");
  }
  if (payload.email && payload.email_verified !== true) {
    throw new Error("AAIS OIDC email is not verified.");
  }
  return {
    id: `oidc:${payload.sub}`,
    role: resolveAaisOidcActorRole(payload),
    displayName: String(payload.name ?? payload.email ?? payload.sub),
  };
}

function resolveAaisOidcActorRole(payload: JWTPayload): AaisSessionActor["role"] {
  const email = typeof payload.email === "string" && payload.email_verified === true
    ? payload.email.trim().toLowerCase()
    : "";
  const claimValues = getRoleClaimValues(payload);
  if (
    (email && readLowercaseCsv(process.env.AAIS_OIDC_ADMIN_EMAILS).has(email))
    || intersects(claimValues, readCsv(process.env.AAIS_OIDC_ADMIN_GROUPS))
  ) {
    return "admin";
  }
  if (
    (email && readLowercaseCsv(process.env.AAIS_OIDC_TEACHER_EMAILS).has(email))
    || intersects(claimValues, readCsv(process.env.AAIS_OIDC_TEACHER_GROUPS))
  ) {
    return "teacher";
  }
  return "student";
}

function getRoleClaimValues(payload: JWTPayload) {
  return [
    ...readClaimStrings(payload.groups),
    ...readClaimStrings(payload.roles),
    ...readClaimStrings(payload.role),
  ];
}

function readClaimStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value.trim()].filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }
  return [];
}

function readCsv(value: string | undefined) {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function readLowercaseCsv(value: string | undefined) {
  return new Set([...readCsv(value)].map((item) => item.toLowerCase()));
}

function intersects(values: string[], allowlist: Set<string>) {
  return values.some((value) => allowlist.has(value));
}

function signPayload(encodedPayload: string) {
  return createHmac("sha256", getSigningSecret())
    .update(encodedPayload)
    .digest("base64url");
}

function createPkceCodeChallenge(codeVerifier: string) {
  return createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
}

function isValidPkceCodeVerifier(value: string) {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

function signatureMatches(encodedPayload: string, signature: string) {
  const expected = signPayload(encodedPayload);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function getSigningSecret() {
  const secret = process.env.AAIS_SESSION_SECRET?.trim();
  if (secret) {
    return secret;
  }
  if (isProductionRuntime()) {
    throw new Error("AAIS session secret is not configured.");
  }
  return devSessionSecret;
}

function isProductionRuntime() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}
