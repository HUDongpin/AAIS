import { TeacherDashboardPage } from "@/components/pages/teacher-dashboard-page";
import { requireAaisEducatorPageSession } from "@/lib/server/aais-page-auth";

export default async function Page() {
  await requireAaisEducatorPageSession("/dashboard");
  return <TeacherDashboardPage />;
}
