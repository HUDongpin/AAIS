import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  getAaisSessionCookieName,
  verifyAaisSessionToken,
} from "@/lib/server/aais-session";

export async function requireAaisPageSession(returnTo: string) {
  const cookieStore = await cookies();
  const token = cookieStore.get(getAaisSessionCookieName())?.value;
  const actor = verifyAaisSessionToken(token);
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
