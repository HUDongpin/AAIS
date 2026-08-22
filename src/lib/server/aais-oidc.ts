import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWTPayload, type JWK } from "jose";
import { normalizeAaisLocalRedirectTarget } from "@/lib/aais-local-redirect";
import type { AaisSessionActor } from "@/lib/server/aais-session";
import { requireAaisSessionSecret } from "@/lib/server/aais-session-secret";

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
  "AAIS_OIDC_RESEARCHER_GROUPS",
  "AAIS_OIDC_RESEARCHER_EMAILS",
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
const oidcClockToleranceSeconds = 60;
const oidcIdTokenMaxAgeSeconds = 15 * 60;
const oidcProviderTimeoutMs = 10_000;
const oidcDiscoveryMaxBytes = 64 * 1024;
const oidcTokenResponseMaxBytes = 256 * 1024;
const oidcJwksMaxBytes = 1024 * 1024;
const oidcReturnTargetMaxLength = 2048;
const oidcDiscoveryCacheTtlMs = 5 * 60 * 1000;
const oidcDiscoveryNegativeCacheTtlMs = 15 * 1000;
const oidcDiscoveryCacheMaxEntries = 32;
const allowedOidcSigningAlgorithms = new Set([
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
]);
const invalidOidcEndpointConfig = Symbol("invalid-oidc-endpoints");

type AaisOidcEndpoints = Pick<
  AaisOidcConfig,
  "authorizationEndpoint" | "tokenEndpoint" | "jwksUri"
>;

type AaisOidcDiscoveryOutcome =
  | { status: "configured"; endpoints: AaisOidcEndpoints }
  | { status: "missing" }
  | { status: "unavailable" };

const oidcDiscoveryCache = new Map<string, {
  expiresAt: number;
  outcome: AaisOidcDiscoveryOutcome;
}>();
const oidcDiscoveryInflight = new Map<string, Promise<AaisOidcDiscoveryOutcome>>();

export class AaisOidcProviderUnavailableError extends Error {
  constructor(readonly operation: "discovery" | "token" | "jwks", options?: { cause?: unknown }) {
    super(`AAIS OIDC ${operation} provider is temporarily unavailable.`, options);
    this.name = "AaisOidcProviderUnavailableError";
  }
}

export function isAaisOidcProviderUnavailableError(
  error: unknown,
): error is AaisOidcProviderUnavailableError {
  return error instanceof AaisOidcProviderUnavailableError;
}

export function resetAaisOidcDiscoveryCacheForTests() {
  oidcDiscoveryCache.clear();
  oidcDiscoveryInflight.clear();
}

export function getAaisOidcStateCookieName() {
  return oidcStateCookieName;
}

export function getAaisOidcConfig(): AaisOidcConfig | null {
  const baseConfig = getAaisOidcBaseConfig();
  if (!baseConfig) {
    return null;
  }
  const endpoints = getAaisOidcExplicitEndpoints();
  if (!endpoints || endpoints === invalidOidcEndpointConfig) {
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
  const endpoints = getAaisOidcExplicitEndpoints();
  if (endpoints === invalidOidcEndpointConfig) {
    return {
      configured: false,
      mode: "missing",
    };
  }
  return {
    configured: true,
    mode: endpoints ? "explicit" : "discovery",
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

export function getAaisOidcSessionPolicyFingerprint(
  resolvedConfig?: Pick<AaisOidcConfig, "issuer" | "clientId">,
) {
  const baseConfig = resolvedConfig ?? getAaisOidcBaseConfig();
  if (!baseConfig) {
    return null;
  }
  const endpoints = getAaisOidcExplicitEndpoints();
  if (endpoints === invalidOidcEndpointConfig) {
    return null;
  }
  const roleMapping = Object.fromEntries(
    aaisOidcRoleMappingEnvNames.map((name) => {
      const values = name.endsWith("_EMAILS")
        ? [...readLowercaseCsv(process.env[name])]
        : [...readCsv(process.env[name])];
      return [name, values.sort()];
    }),
  );
  return createHash("sha256")
    .update("aais.oidc.session-policy:v1\0", "utf8")
    .update(JSON.stringify({
      issuer: canonicalizeOidcIssuer(baseConfig.issuer),
      clientId: baseConfig.clientId,
      endpointMode: endpoints ? "explicit" : "discovery",
      endpoints: endpoints ?? null,
      roleMapping,
    }), "utf8")
    .digest("hex");
}

export async function resolveAaisOidcConfig(
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<AaisOidcConfig | null> {
  const baseConfig = getAaisOidcBaseConfig();
  if (!baseConfig) {
    return null;
  }
  const endpoints = getAaisOidcExplicitEndpoints();
  if (endpoints === invalidOidcEndpointConfig) {
    return null;
  }
  if (endpoints) {
    return {
      ...baseConfig,
      ...endpoints,
    };
  }
  const cacheKey = JSON.stringify({
    issuer: canonicalizeOidcIssuer(baseConfig.issuer),
    endpointMode: "discovery",
    clientId: baseConfig.clientId,
    redirectUri: baseConfig.redirectUri,
  });
  const discovery = await resolveAaisOidcDiscovery(cacheKey, baseConfig.issuer, fetchImpl, now);
  if (discovery.status === "unavailable") {
    throw new AaisOidcProviderUnavailableError("discovery");
  }
  if (discovery.status === "missing") {
    return null;
  }
  return {
    ...baseConfig,
    ...discovery.endpoints,
  };
}

async function resolveAaisOidcDiscovery(
  cacheKey: string,
  issuer: string,
  fetchImpl: typeof fetch,
  now: number,
): Promise<AaisOidcDiscoveryOutcome> {
  const cached = oidcDiscoveryCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.outcome;
  }
  if (cached) {
    oidcDiscoveryCache.delete(cacheKey);
  }
  const current = oidcDiscoveryInflight.get(cacheKey);
  if (current) {
    return current;
  }
  const loading = loadAaisOidcDiscovery(issuer, fetchImpl)
    .then((outcome) => {
      pruneAaisOidcDiscoveryCache(now);
      oidcDiscoveryCache.set(cacheKey, {
        outcome,
        expiresAt: now + (outcome.status === "configured"
          ? oidcDiscoveryCacheTtlMs
          : oidcDiscoveryNegativeCacheTtlMs),
      });
      return outcome;
    })
    .finally(() => {
      oidcDiscoveryInflight.delete(cacheKey);
    });
  oidcDiscoveryInflight.set(cacheKey, loading);
  return loading;
}

async function loadAaisOidcDiscovery(
  issuer: string,
  fetchImpl: typeof fetch,
): Promise<AaisOidcDiscoveryOutcome> {
  try {
    const endpoints = await discoverAaisOidcEndpoints(issuer, fetchImpl);
    return endpoints
      ? { status: "configured", endpoints }
      : { status: "missing" };
  } catch {
    return { status: "unavailable" };
  }
}

function pruneAaisOidcDiscoveryCache(now: number) {
  for (const [key, entry] of oidcDiscoveryCache) {
    if (entry.expiresAt <= now) {
      oidcDiscoveryCache.delete(key);
    }
  }
  while (oidcDiscoveryCache.size >= oidcDiscoveryCacheMaxEntries) {
    const oldestKey = oidcDiscoveryCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    oidcDiscoveryCache.delete(oldestKey);
  }
}

function getAaisOidcBaseConfig() {
  const issuer = readOidcUrlEnv("AAIS_OIDC_ISSUER");
  const clientId = readOidcTextEnv("AAIS_OIDC_CLIENT_ID");
  const clientSecret = readOidcTextEnv("AAIS_OIDC_CLIENT_SECRET");
  const redirectUri = readOidcUrlEnv("AAIS_OIDC_REDIRECT_URI", {
    allowLocalHttpInDevelopment: true,
  });
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
  const rawAuthorizationEndpoint = process.env.AAIS_OIDC_AUTHORIZATION_ENDPOINT?.trim();
  const rawTokenEndpoint = process.env.AAIS_OIDC_TOKEN_ENDPOINT?.trim();
  const rawJwksUri = process.env.AAIS_OIDC_JWKS_URI?.trim();
  const presentCount = [rawAuthorizationEndpoint, rawTokenEndpoint, rawJwksUri]
    .filter((value) => Boolean(value)).length;
  if (presentCount === 0) {
    return null;
  }
  if (presentCount !== 3) {
    return invalidOidcEndpointConfig;
  }
  const authorizationEndpoint = readOidcUrlValue(rawAuthorizationEndpoint);
  const tokenEndpoint = readOidcUrlValue(rawTokenEndpoint);
  const jwksUri = readOidcUrlValue(rawJwksUri);
  if (!authorizationEndpoint || !tokenEndpoint || !jwksUri) {
    return invalidOidcEndpointConfig;
  }
  return {
    authorizationEndpoint,
    tokenEndpoint,
    jwksUri,
  };
}

async function discoverAaisOidcEndpoints(issuer: string, fetchImpl: typeof fetch) {
  const discoveryUrl = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  let response: Response;
  try {
    response = await fetchImpl(discoveryUrl, {
      headers: {
        accept: "application/json",
      },
      signal: AbortSignal.timeout(oidcProviderTimeoutMs),
    });
  } catch (cause) {
    throw new AaisOidcProviderUnavailableError("discovery", { cause });
  }
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel().catch(() => undefined);
    throw new AaisOidcProviderUnavailableError("discovery");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const metadata = await readBoundedOidcJson(response, oidcDiscoveryMaxBytes).catch(() => null) as {
    issuer?: unknown;
    authorization_endpoint?: unknown;
    token_endpoint?: unknown;
    jwks_uri?: unknown;
  } | null;
  if (
    metadata?.issuer !== issuer
  ) {
    return null;
  }
  const authorizationEndpoint = readOidcUrlValue(metadata.authorization_endpoint);
  const tokenEndpoint = readOidcUrlValue(metadata.token_endpoint);
  const jwksUri = readOidcUrlValue(metadata.jwks_uri);
  if (!authorizationEndpoint || !tokenEndpoint || !jwksUri) {
    return null;
  }
  return {
    authorizationEndpoint,
    tokenEndpoint,
    jwksUri,
  };
}

function readOidcTextEnv(name: string) {
  const value = process.env[name]?.trim();
  return value && !isPlaceholderValue(value) ? value : "";
}

function readOidcUrlEnv(
  name: string,
  options: {
    allowLocalHttpInDevelopment?: boolean;
  } = {},
) {
  return readOidcUrlValue(process.env[name], options);
}

function readOidcUrlValue(
  value: unknown,
  options: {
    allowLocalHttpInDevelopment?: boolean;
  } = {},
) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || isPlaceholderValue(trimmed)) {
    return "";
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol === "https:") {
      return trimmed;
    }
    if (
      !isProductionRuntime()
      && options.allowLocalHttpInDevelopment
      && url.protocol === "http:"
      && isLocalhost(url.hostname)
    ) {
      return trimmed;
    }
  } catch {
    return "";
  }
  return "";
}

function isPlaceholderValue(value: string) {
  return /^<REQUIRED:/i.test(value)
    || value === "<REQUIRED>"
    || /^(CHANGE_ME|TODO|TBD)$/i.test(value);
}

function isLocalhost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
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
  return returnTo.length <= oidcReturnTargetMaxLength
    ? normalizeAaisLocalRedirectTarget(returnTo)
    : "/learning";
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
      || typeof payload.iat !== "number"
      || typeof payload.exp !== "number"
      || payload.state !== expectedState
      || payload.iat > Math.floor(now.getTime() / 1000) + oidcClockToleranceSeconds
      || payload.exp > payload.iat + stateTtlSeconds
      || payload.exp <= Math.floor(now.getTime() / 1000)
      || !isValidPkceCodeVerifier(payload.codeVerifier)
    ) {
      return null;
    }
    return {
      state: payload.state,
      nonce: payload.nonce,
      returnTo: normalizeReturnTarget(payload.returnTo),
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
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(input.config.tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(oidcProviderTimeoutMs),
    });
  } catch (cause) {
    throw new AaisOidcProviderUnavailableError("token", { cause });
  }
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel().catch(() => undefined);
    throw new AaisOidcProviderUnavailableError("token");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`AAIS OIDC token exchange failed with ${response.status}`);
  }
  let payload: unknown;
  try {
    payload = await readBoundedOidcJson(response, oidcTokenResponseMaxBytes);
  } catch (cause) {
    throw new AaisOidcProviderUnavailableError("token", { cause });
  }
  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || typeof (payload as { id_token?: unknown }).id_token !== "string"
    || !(payload as { id_token: string }).id_token
  ) {
    throw new AaisOidcProviderUnavailableError("token");
  }
  return (payload as { id_token: string }).id_token;
}

export async function verifyAaisOidcIdToken(input: {
  config: AaisOidcConfig;
  idToken: string;
  nonce: string;
  fetchImpl?: typeof fetch;
}): Promise<AaisSessionActor> {
  const header = decodeProtectedHeader(input.idToken);
  const algorithm = typeof header.alg === "string" ? header.alg : "";
  if (!allowedOidcSigningAlgorithms.has(algorithm)) {
    throw new Error("AAIS OIDC signing algorithm is not allowed.");
  }
  let jwksResponse: Response;
  try {
    jwksResponse = await (input.fetchImpl ?? fetch)(input.config.jwksUri, {
      headers: {
        accept: "application/json",
      },
      signal: AbortSignal.timeout(oidcProviderTimeoutMs),
    });
  } catch (cause) {
    throw new AaisOidcProviderUnavailableError("jwks", { cause });
  }
  if (jwksResponse.status === 429 || jwksResponse.status >= 500) {
    await jwksResponse.body?.cancel().catch(() => undefined);
    throw new AaisOidcProviderUnavailableError("jwks");
  }
  if (!jwksResponse.ok) {
    await jwksResponse.body?.cancel().catch(() => undefined);
    throw new Error(`AAIS OIDC JWKS lookup failed with ${jwksResponse.status}`);
  }
  let jwksPayload: unknown;
  try {
    jwksPayload = await readBoundedOidcJson(jwksResponse, oidcJwksMaxBytes);
  } catch (cause) {
    throw new AaisOidcProviderUnavailableError("jwks", { cause });
  }
  if (
    !jwksPayload
    || typeof jwksPayload !== "object"
    || Array.isArray(jwksPayload)
    || !Array.isArray((jwksPayload as { keys?: unknown }).keys)
    || !(jwksPayload as { keys: unknown[] }).keys.every((candidate) => (
      Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate)
    ))
  ) {
    throw new AaisOidcProviderUnavailableError("jwks");
  }
  const jwks = jwksPayload as { keys: JWK[] };
  const key = Array.isArray(jwks?.keys)
    ? jwks.keys.find((candidate) => (
        (!header.kid || candidate.kid === header.kid)
        && (!candidate.alg || candidate.alg === algorithm)
        && (!candidate.use || candidate.use === "sig")
        && (!candidate.key_ops || candidate.key_ops.includes("verify"))
      ))
    : undefined;
  if (!key) {
    throw new Error("AAIS OIDC signing key was not found.");
  }
  const publicKey = await importJWK(key, algorithm);
  const verified = await jwtVerify(input.idToken, publicKey, {
    issuer: input.config.issuer,
    audience: input.config.clientId,
    algorithms: [...allowedOidcSigningAlgorithms],
    requiredClaims: ["exp", "iat", "sub"],
    maxTokenAge: oidcIdTokenMaxAgeSeconds,
    clockTolerance: oidcClockToleranceSeconds,
  });
  validateAuthorizedParty(verified.payload, input.config.clientId);
  return createActorFromClaims(verified.payload, input.nonce, input.config.issuer);
}

function createActorFromClaims(
  payload: JWTPayload,
  expectedNonce: string,
  verifiedIssuer: string,
): AaisSessionActor {
  if (payload.nonce !== expectedNonce) {
    throw new Error("AAIS OIDC nonce mismatch.");
  }
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new Error("AAIS OIDC subject is missing.");
  }
  if (typeof payload.email !== "string" || !payload.email.trim()) {
    throw new Error("AAIS OIDC email is missing.");
  }
  if (payload.email_verified !== true) {
    throw new Error("AAIS OIDC email is not verified.");
  }
  return {
    id: createAaisOidcActorId(verifiedIssuer, payload.sub),
    role: resolveAaisOidcActorRole(payload),
    displayName: String(payload.name ?? payload.email ?? payload.sub),
  };
}

export function createAaisOidcActorId(issuer: string, subject: string) {
  const canonicalIssuer = canonicalizeOidcIssuer(issuer);
  const digest = createHash("sha256")
    .update("aais.oidc.actor-id:v2\0", "utf8")
    .update(canonicalIssuer, "utf8")
    .update("\0", "utf8")
    .update(subject, "utf8")
    .digest("hex");
  return `oidc:v2:${digest}`;
}

function canonicalizeOidcIssuer(issuer: string) {
  try {
    return new URL(issuer).href;
  } catch {
    return issuer;
  }
}

function validateAuthorizedParty(payload: JWTPayload, clientId: string) {
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const authorizedParty = payload.azp;
  if (
    (authorizedParty !== undefined && authorizedParty !== clientId)
    || (audience.length > 1 && authorizedParty !== clientId)
  ) {
    throw new Error("AAIS OIDC authorized party mismatch.");
  }
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
    (email && readLowercaseCsv(process.env.AAIS_OIDC_RESEARCHER_EMAILS).has(email))
    || intersects(claimValues, readCsv(process.env.AAIS_OIDC_RESEARCHER_GROUPS))
  ) {
    return "researcher";
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

async function readBoundedOidcJson(response: Response, maxBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("AAIS OIDC provider response is too large.");
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("AAIS OIDC provider response body is missing.");
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("AAIS OIDC provider response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let jsonText: string;
  try {
    jsonText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("AAIS OIDC provider response is not valid UTF-8.");
  }
  try {
    return JSON.parse(jsonText) as unknown;
  } catch {
    throw new Error("AAIS OIDC provider response is not valid JSON.");
  }
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
  return requireAaisSessionSecret();
}

function isProductionRuntime() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}
