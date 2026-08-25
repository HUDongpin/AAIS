import { cookies } from "next/headers";
import { TeacherDashboardPage } from "@/components/pages/teacher-dashboard-page";
import {
  aaisLocaleCookieName,
  defaultAaisLocale,
  parseAaisLocale,
} from "@/lib/aais-locale";
import { requireAaisEducatorPageSession } from "@/lib/server/aais-page-auth";

export const dynamic = "force-dynamic";

export default async function Page() {
  const cookieStore = await cookies();
  const locale = parseAaisLocale(cookieStore.get(aaisLocaleCookieName)?.value) ?? defaultAaisLocale;
  await requireAaisEducatorPageSession("/dashboard");
  return <TeacherDashboardPage locale={locale} />;
}
