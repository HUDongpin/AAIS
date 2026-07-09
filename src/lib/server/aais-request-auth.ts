import {
  getAaisSessionCookieName,
  verifyAaisSessionTokenWithMetadata,
  type AaisSessionActor,
} from "@/lib/server/aais-session";
import { isAaisSessionTokenRevoked } from "@/lib/server/aais-session-revocations";

export class AaisAuthError extends Error {
  constructor() {
    super("AAIS authentication is required.");
  }
}

export async function resolveAaisStudentId(request: Request) {
  return (await requireAaisSessionActor(request)).id;
}

export async function requireAaisSessionActor(request: Request): Promise<AaisSessionActor> {
  const token = readCookie(request.headers.get("cookie"), getAaisSessionCookieName());
  const verified = await verifyAaisRequestSessionToken(token);
  if (!verified) {
    throw new AaisAuthError();
  }
  return verified;
}

export async function verifyAaisRequestSessionToken(
  token: string | null | undefined,
): Promise<AaisSessionActor | null> {
  const verified = verifyAaisSessionTokenWithMetadata(token);
  if (!verified) {
    return null;
  }
  try {
    if (await isAaisSessionTokenRevoked({ tokenHash: verified.tokenHash })) {
      return null;
    }
  } catch {
    return null;
  }
  return verified.actor;
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
