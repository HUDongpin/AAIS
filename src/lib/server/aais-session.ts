import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { requireAaisSessionSecret } from "@/lib/server/aais-session-secret";

export { AaisSessionConfigurationError } from "@/lib/server/aais-session-secret";

export type AaisSessionActor = {
  id: string;
  role: "student" | "teacher" | "researcher" | "admin";
  displayName: string;
};

export type AaisSessionAuthSource = "database" | "trial" | "oidc" | "development";

type AaisSessionPayload = {
  v: 1 | 2 | 3;
  actor: AaisSessionActor;
  iat: number;
  exp: number;
  authVersion?: number;
  authSource?: AaisSessionAuthSource;
  oidcPolicyFingerprint?: string;
  trialPolicyFingerprint?: string;
};

export type AaisVerifiedSessionToken = {
  actor: AaisSessionActor;
  expiresAt: Date;
  tokenHash: string;
  authVersion: number | null;
  authSource: AaisSessionAuthSource | null;
  oidcPolicyFingerprint: string | null;
  trialPolicyFingerprint: string | null;
};

const sessionCookieName = "aais_session";
const sessionTtlSeconds = 60 * 60 * 8;
const oidcSessionTtlSeconds = 15 * 60;
export function getAaisSessionCookieName() {
  return sessionCookieName;
}

export function createAaisSessionToken(
  actor: AaisSessionActor,
  now = new Date(),
  options: {
    authVersion?: number;
    authSource?: AaisSessionAuthSource;
    oidcPolicyFingerprint?: string;
    trialPolicyFingerprint?: string;
    ttlSeconds?: number;
  } = {},
) {
  const issuedAt = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
    throw new Error("Invalid AAIS session issuance time.");
  }
  const authVersion = options.authVersion === undefined
    ? undefined
    : requireSafeAuthVersion(options.authVersion);
  const authSource = options.authSource;
  const oidcPolicyFingerprint = options.oidcPolicyFingerprint;
  const trialPolicyFingerprint = options.trialPolicyFingerprint;
  const ttlSeconds = options.ttlSeconds === undefined
    ? sessionTtlSeconds
    : requireSafeSessionTtl(options.ttlSeconds);
  requireValidSourceOptions({
    authSource,
    authVersion,
    oidcPolicyFingerprint,
    trialPolicyFingerprint,
  });
  const payload: AaisSessionPayload = {
    v: authSource === undefined ? (authVersion === undefined ? 1 : 2) : 3,
    actor: requireSafeActor(actor),
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    ...(authVersion === undefined ? {} : { authVersion }),
    ...(authSource === undefined ? {} : { authSource }),
    ...(oidcPolicyFingerprint === undefined ? {} : { oidcPolicyFingerprint }),
    ...(trialPolicyFingerprint === undefined ? {} : { trialPolicyFingerprint }),
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  return `${encodedPayload}.${signPayload(encodedPayload)}`;
}

export function verifyAaisSessionToken(token: string | null | undefined, now = new Date()) {
  return verifyAaisSessionTokenWithMetadata(token, now)?.actor ?? null;
}

export function verifyAaisSessionTokenWithMetadata(
  token: string | null | undefined,
  now = new Date(),
): AaisVerifiedSessionToken | null {
  if (!token) {
    return null;
  }
  const [encodedPayload, signature, extra] = token.split(".");
  if (!encodedPayload || !signature || extra) {
    return null;
  }
  if (!signatureMatches(encodedPayload, signature)) {
    return null;
  }
  const payload = parsePayload(encodedPayload);
  if (!payload) {
    return null;
  }
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (payload.exp <= nowSeconds) {
    return null;
  }
  return {
    actor: payload.actor,
    expiresAt: new Date(payload.exp * 1000),
    tokenHash: createAaisSessionTokenHash(token),
    authVersion: payload.v === 2 || payload.v === 3 ? payload.authVersion ?? null : null,
    authSource: payload.v === 3 ? payload.authSource ?? null : null,
    oidcPolicyFingerprint: payload.v === 3 ? payload.oidcPolicyFingerprint ?? null : null,
    trialPolicyFingerprint: payload.v === 3 ? payload.trialPolicyFingerprint ?? null : null,
  };
}

export function createAaisSessionTokenHash(token: string) {
  return createHash("sha256")
    .update(`aais-session-token:${token}`)
    .digest("hex");
}

export function getAaisSessionCookieOptions(maxAgeSeconds = sessionTtlSeconds) {
  return {
    httpOnly: true,
    maxAge: requireSafeSessionTtl(maxAgeSeconds),
    path: "/",
    sameSite: "lax" as const,
    secure: isProductionRuntime(),
  };
}

export function getAaisOidcSessionTtlSeconds() {
  return oidcSessionTtlSeconds;
}

export function getAaisDisplayCookieOptions() {
  return {
    maxAge: sessionTtlSeconds,
    path: "/",
    sameSite: "lax" as const,
    secure: isProductionRuntime(),
  };
}

export function getAaisExpiredCookieOptions() {
  return {
    maxAge: 0,
    path: "/",
    sameSite: "lax" as const,
    secure: isProductionRuntime(),
  };
}

function signPayload(encodedPayload: string) {
  return createHmac("sha256", getSessionSecret())
    .update(encodedPayload)
    .digest("base64url");
}

function signatureMatches(encodedPayload: string, signature: string) {
  const expected = signPayload(encodedPayload);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function parsePayload(encodedPayload: string): AaisSessionPayload | null {
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as
      Partial<AaisSessionPayload>;
    if (
      (payload.v !== 1 && payload.v !== 2 && payload.v !== 3)
      || !payload.actor
      || typeof payload.iat !== "number"
      || typeof payload.exp !== "number"
      || !Number.isSafeInteger(payload.iat)
      || !Number.isSafeInteger(payload.exp)
      || Number(payload.iat) < 0
      || Number(payload.exp) <= Number(payload.iat)
      || Number(payload.exp) - Number(payload.iat) > sessionTtlSeconds
      || (payload.v === 1 && (
        payload.authVersion !== undefined
        || payload.authSource !== undefined
        || payload.oidcPolicyFingerprint !== undefined
        || payload.trialPolicyFingerprint !== undefined
      ))
      || (payload.v === 2 && (
        !isSafeAuthVersion(payload.authVersion)
        || payload.authSource !== undefined
        || payload.oidcPolicyFingerprint !== undefined
        || payload.trialPolicyFingerprint !== undefined
      ))
      || (payload.v === 3 && !hasValidSourcePayload(payload))
    ) {
      return null;
    }
    return {
      v: payload.v,
      actor: requireSafeActor(payload.actor),
      iat: payload.iat,
      exp: payload.exp,
      ...(payload.v === 2 || payload.v === 3
        ? (payload.authVersion === undefined ? {} : { authVersion: payload.authVersion })
        : {}),
      ...(payload.v === 3 ? { authSource: payload.authSource } : {}),
      ...(payload.v === 3 && payload.oidcPolicyFingerprint !== undefined
        ? { oidcPolicyFingerprint: payload.oidcPolicyFingerprint }
        : {}),
      ...(payload.v === 3 && payload.trialPolicyFingerprint !== undefined
        ? { trialPolicyFingerprint: payload.trialPolicyFingerprint }
        : {}),
    };
  } catch {
    return null;
  }
}

function requireSafeActor(actor: Partial<AaisSessionActor>): AaisSessionActor {
  const role = actor.role;
  if (
    typeof actor.id !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(actor.id)
    || !isAaisSessionRole(role)
    || typeof actor.displayName !== "string"
    || actor.displayName.trim().length === 0
    || actor.displayName.length > 120
  ) {
    throw new Error("Invalid AAIS session actor.");
  }
  return {
    id: actor.id,
    role,
    displayName: actor.displayName.trim(),
  };
}

function requireSafeAuthVersion(value: number) {
  if (!isSafeAuthVersion(value)) {
    throw new Error("Invalid AAIS session actor auth version.");
  }
  return value;
}

function isSafeAuthVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function requireSafeSessionTtl(value: number) {
  if (!Number.isSafeInteger(value) || value < 60 || value > sessionTtlSeconds) {
    throw new Error("Invalid AAIS session TTL.");
  }
  return value;
}

function requireValidSourceOptions(input: {
  authSource?: AaisSessionAuthSource;
  authVersion?: number;
  oidcPolicyFingerprint?: string;
  trialPolicyFingerprint?: string;
}) {
  if (input.authSource === undefined) {
    if (
      input.oidcPolicyFingerprint !== undefined
      || input.trialPolicyFingerprint !== undefined
    ) {
      throw new Error("AAIS session policy requires an authentication source.");
    }
    return;
  }
  if (!isAaisSessionAuthSource(input.authSource)) {
    throw new Error("Invalid AAIS session authentication source.");
  }
  if (input.authSource === "database") {
    if (
      !isSafeAuthVersion(input.authVersion)
      || input.oidcPolicyFingerprint !== undefined
      || input.trialPolicyFingerprint !== undefined
    ) {
      throw new Error("Invalid AAIS database session source metadata.");
    }
    return;
  }
  if (input.authVersion !== undefined) {
    throw new Error("Only AAIS database sessions may include an auth version.");
  }
  if (input.authSource === "oidc") {
    if (
      !isPolicyFingerprint(input.oidcPolicyFingerprint)
      || input.trialPolicyFingerprint !== undefined
    ) {
      throw new Error("Invalid AAIS OIDC session policy fingerprint.");
    }
    return;
  }
  if (input.authSource === "trial") {
    if (
      !isPolicyFingerprint(input.trialPolicyFingerprint)
      || input.oidcPolicyFingerprint !== undefined
    ) {
      throw new Error("Invalid AAIS trial session policy fingerprint.");
    }
    return;
  }
  if (
    input.oidcPolicyFingerprint !== undefined
    || input.trialPolicyFingerprint !== undefined
  ) {
    throw new Error("Only AAIS OIDC or trial sessions may include a policy fingerprint.");
  }
}

function hasValidSourcePayload(payload: Partial<AaisSessionPayload>) {
  try {
    requireValidSourceOptions({
      authSource: payload.authSource,
      authVersion: payload.authVersion,
      oidcPolicyFingerprint: payload.oidcPolicyFingerprint,
      trialPolicyFingerprint: payload.trialPolicyFingerprint,
    });
    return payload.authSource !== undefined;
  } catch {
    return false;
  }
}

function isAaisSessionAuthSource(value: unknown): value is AaisSessionAuthSource {
  return value === "database"
    || value === "trial"
    || value === "oidc"
    || value === "development";
}

function isPolicyFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isAaisSessionRole(value: unknown): value is AaisSessionActor["role"] {
  return value === "student"
    || value === "teacher"
    || value === "researcher"
    || value === "admin";
}

function getSessionSecret() {
  return requireAaisSessionSecret();
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function isProductionRuntime() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}
