import { LearningPage } from "@/components/pages/learning-page";
import { requireAaisPageSession } from "@/lib/server/aais-page-auth";

export default async function Page() {
  await requireAaisPageSession("/learning");
  return <LearningPage />;
}
