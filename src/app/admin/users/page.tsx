import type { Metadata } from "next";
import { AdminUsersPage } from "@/components/pages/admin-users-page";
import { requireAaisAdminPageSession } from "@/lib/server/aais-page-auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "AAIS Admin Users",
  description: "AAIS user account administration",
};

export default async function Page() {
  await requireAaisAdminPageSession("/admin/users");
  return <AdminUsersPage />;
}
