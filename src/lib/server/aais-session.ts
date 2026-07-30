import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type AaisSessionActor = {
  id: string;
  role: "student" | "teacher" | "researcher" | "admin";
  displayName: string;
};

type AaisSessionPayload = {
  v: 1;
  actor: AaisSessionActor;
  iat: number;
  exp: number;
};

export type AaisVerifiedSessionToken = {
  actor: AaisSessionActor;
  expiresAt: Date;
  tokenHash: string;
};

const sessionCookieName = "aais_session";
const sessionTtlSeconds = 60 * 60 * 8;
const devSessionSecret = "aais-dev-session-secret-do-not-use-for-production";

export class AaisSessionConfigurationError extends Error {
  constructor() {
    super("AAIS session secret is not configured.");
  }
}

export function getAaisSessionCookieName() {
  return sessionCookieName;
}

export function createAaisSessionToken(
  actor: AaisSessionActor,
  now = new Date(),
) {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload: AaisSessionPayload = {
    v: 1,
    actor: requireSafeActor(actor),
    iat: issuedAt,
    exp: issuedAt + sessionTtlSeconds,
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
  };
}

export function createAaisSessionTokenHash(token: string) {
  return createHash("sha256")
    .update(`aais-session-token:${token}`)
    .digest("hex");
}

export function getAaisSessionCookieOptions() {
  return {
    httpOnly: true,
    maxAge: sessionTtlSeconds,
    path: "/",
    sameSite: "lax" as const,
    secure: isProductionRuntime(),
  };
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
    if (payload.v !== 1 || !payload.actor || typeof payload.iat !== "number" || typeof payload.exp !== "number") {
      return null;
    }
    return {
      v: 1,
      actor: requireSafeActor(payload.actor),
      iat: payload.iat,
      exp: payload.exp,
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

function isAaisSessionRole(value: unknown): value is AaisSessionActor["role"] {
  return value === "student"
    || value === "teacher"
    || value === "researcher"
    || value === "admin";
}

function getSessionSecret() {
  const secret = process.env.AAIS_SESSION_SECRET?.trim();
  if (secret) {
    return secret;
  }
  if (isProductionRuntime()) {
    throw new AaisSessionConfigurationError();
  }
  return devSessionSecret;
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function isProductionRuntime() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}
