import {
  getAaisSessionCookieName,
  verifyAaisSessionTokenWithMetadata,
  type AaisSessionActor,
} from "@/lib/server/aais-session";
import { isAaisSessionTokenRevoked } from "@/lib/server/aais-session-revocations";
import { resolveAaisDatabaseSessionActor } from "@/lib/server/aais-users";
import { verifyAaisTrialSessionActor } from "@/lib/server/aais-trial-accounts";
import { getAaisOidcSessionPolicyFingerprint } from "@/lib/server/aais-oidc";

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
    if (verified.authSource === "oidc") {
      const currentPolicyFingerprint = getAaisOidcSessionPolicyFingerprint();
      return verified.actor.id.startsWith("oidc:v2:")
        && currentPolicyFingerprint !== null
        && verified.oidcPolicyFingerprint === currentPolicyFingerprint
        ? verified.actor
        : null;
    }
    if (verified.authSource === "trial") {
      return verified.trialPolicyFingerprint === null
        ? null
        : verifyAaisTrialSessionActor({
            actorId: verified.actor.id,
            role: verified.actor.role,
            policyFingerprint: verified.trialPolicyFingerprint,
          });
    }
    if (verified.authSource === "development") {
      return isProductionRuntime() ? null : verified.actor;
    }
    // V1 cookies do not carry an authentication source. Guessing that source
    // from an actor-id prefix (or from whichever backing store happens to be
    // configured) can turn a database outage or configuration change into an
    // authorization fail-open outside NODE_ENV=production. Current login
    // routes mint source-bound v3 cookies; legacy v2 database cookies remain
    // verifiable through their auth version below.
    if (verified.authSource === null && verified.authVersion === null) {
      return null;
    }
    const currentActor = await resolveAaisDatabaseSessionActor(verified.actor.id);
    if (currentActor.status === "active") {
      return currentActor.actor.id === verified.actor.id
        && currentActor.actor.role === verified.actor.role
        && verified.authVersion !== null
        && currentActor.authVersion === verified.authVersion
        ? currentActor.actor
        : null;
    }
    return null;
  } catch {
    return null;
  }
}

function isProductionRuntime() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
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
  try {
    return decodeURIComponent(cookie.slice(name.length + 1));
  } catch {
    return null;
  }
}
