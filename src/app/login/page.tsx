import type { Metadata } from "next";
import { cookies } from "next/headers";
import { LoginPage } from "@/components/pages/login-page";
import {
  aaisLocaleCookieName,
  parseAaisLocale,
} from "@/lib/aais-locale";
import { isAaisTrialLoginEnabled } from "@/lib/server/aais-trial-accounts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "CAAIS",
  description: "Cognitive Apprenticeship AI System",
  referrer: "no-referrer",
};

export default async function Page() {
  const cookieStore = await cookies();
  const initialLocale = parseAaisLocale(
    cookieStore.get(aaisLocaleCookieName)?.value,
  ) ?? undefined;
  return (
    <LoginPage
      initialLocale={initialLocale}
      trialLoginEnabled={isAaisTrialLoginEnabled()}
    />
  );
}
