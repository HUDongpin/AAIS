import { createHmac, timingSafeEqual } from "node:crypto";
import { getAaisDisplayCookieOptions } from "@/lib/server/aais-session";

const csrfCookieName = "aais_csrf";
const csrfTtlSeconds = 60 * 60 * 8;
const devSessionSecret = "aais-dev-session-secret-do-not-use-for-production";

type CsrfPayload = {
  v: 1;
  sub: string;
  iat: number;
  exp: number;
};

export class AaisCsrfError extends Error {
  constructor() {
    super("AAIS CSRF token is required.");
  }
}

export function getAaisCsrfCookieName() {
  return csrfCookieName;
}

export function createAaisCsrfToken(studentId: string, now = new Date()) {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload: CsrfPayload = {
    v: 1,
    sub: requireSafeStudentId(studentId),
    iat: issuedAt,
    exp: issuedAt + csrfTtlSeconds,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${signPayload(encodedPayload)}`;
}

export function verifyAaisCsrfToken(
  token: string | null | undefined,
  studentId: string,
  now = new Date(),
) {
  if (!token) {
    return false;
  }
  const [encodedPayload, signature, extra] = token.split(".");
  if (!encodedPayload || !signature || extra) {
    return false;
  }
  if (!signatureMatches(encodedPayload, signature)) {
    return false;
  }
  const payload = parsePayload(encodedPayload);
  if (!payload || payload.sub !== studentId) {
    return false;
  }
  return payload.exp > Math.floor(now.getTime() / 1000);
}

export function requireAaisCsrf(request: Request, studentId: string) {
  const headerToken = request.headers.get("x-aais-csrf");
  const cookieToken = readCookie(request.headers.get("cookie"), csrfCookieName);
  if (!headerToken || headerToken !== cookieToken || !verifyAaisCsrfToken(headerToken, studentId)) {
    throw new AaisCsrfError();
  }
}

export function isAaisCsrfError(error: unknown) {
  return error instanceof AaisCsrfError;
}

export function getAaisCsrfCookieOptions() {
  return getAaisDisplayCookieOptions();
}

function parsePayload(encodedPayload: string): CsrfPayload | null {
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as
      Partial<CsrfPayload>;
    if (
      payload.v !== 1
      || typeof payload.sub !== "string"
      || typeof payload.iat !== "number"
      || typeof payload.exp !== "number"
    ) {
      return null;
    }
    return {
      v: 1,
      sub: requireSafeStudentId(payload.sub),
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

function signPayload(encodedPayload: string) {
  return createHmac("sha256", getSigningSecret())
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

function getSigningSecret() {
  const secret = process.env.AAIS_SESSION_SECRET?.trim();
  if (secret) {
    return secret;
  }
  if (process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production") {
    throw new Error("AAIS session secret is not configured.");
  }
  return devSessionSecret;
}

function requireSafeStudentId(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error("Invalid AAIS student id.");
  }
  return value;
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
