import { LoginPage } from "@/components/pages/login-page";
import { isAaisTrialLoginEnabled } from "@/lib/server/aais-trial-accounts";

export const dynamic = "force-dynamic";

export default function Page() {
  return <LoginPage trialLoginEnabled={isAaisTrialLoginEnabled()} />;
}
