import {
  getAaisSessionCookieName,
  verifyAaisSessionToken,
  type AaisSessionActor,
} from "@/lib/server/aais-session";

export class AaisAuthError extends Error {
  constructor() {
    super("AAIS authentication is required.");
  }
}

export function resolveAaisStudentId(request: Request) {
  return requireAaisSessionActor(request).id;
}

export function requireAaisSessionActor(request: Request): AaisSessionActor {
  const token = readCookie(request.headers.get("cookie"), getAaisSessionCookieName());
  const actor = verifyAaisSessionToken(token);
  if (!actor) {
    throw new AaisAuthError();
  }
  return actor;
}

export function isAaisAuthError(error: unknown) {
  return error instanceof AaisAuthError;
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
