import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAaisSessionCookieName } from "@/lib/server/aais-session";
import { verifyAaisRequestSessionToken } from "@/lib/server/aais-request-auth";

export async function requireAaisPageSession(returnTo: string) {
  const cookieStore = await cookies();
  const token = cookieStore.get(getAaisSessionCookieName())?.value;
  const actor = await verifyAaisRequestSessionToken(token);
  if (!actor) {
    redirect(`/login?from=${encodeURIComponent(returnTo)}`);
  }
  return actor;
}

export async function requireAaisEducatorPageSession(returnTo: string) {
  const actor = await requireAaisPageSession(returnTo);
  if (actor.role !== "teacher" && actor.role !== "admin") {
    redirect("/learning");
  }
  return actor;
}

export async function requireAaisAdminPageSession(returnTo: string) {
  const actor = await requireAaisPageSession(returnTo);
  if (actor.role !== "admin") {
    redirect("/learning");
  }
  return actor;
}
