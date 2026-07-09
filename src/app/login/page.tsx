import type { Metadata } from "next";
import { LoginPage } from "@/components/pages/login-page";
import { isAaisTrialLoginEnabled } from "@/lib/server/aais-trial-accounts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "CAAIS",
  description: "Cognitive Apprenticeship AI System",
};

export default function Page() {
  return <LoginPage trialLoginEnabled={isAaisTrialLoginEnabled()} />;
}
