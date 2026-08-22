import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Analytics } from "@vercel/analytics/next";
import {
  aaisLocaleCookieName,
  aaisSkipLinkId,
  defaultAaisLocale,
  parseAaisLocale,
} from "@/lib/aais-locale";
import "./globals.css";

export const metadata: Metadata = {
  title: "CAAIS",
  description: "Apprenticeship AI system for Cognitive Apprenticeship learning.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const locale = parseAaisLocale(cookieStore.get(aaisLocaleCookieName)?.value) ?? defaultAaisLocale;
  return (
    <html lang={locale}>
      <body>
        <a id={aaisSkipLinkId} className="aais-skip-link" href="#aais-main-content">
          {locale === "en-US" ? "Skip to main content" : "跳到主要内容"}
        </a>
        <div id="aais-main-content" tabIndex={-1}>
          {children}
        </div>
        {shouldEnableAaisVercelAnalytics() ? <Analytics /> : null}
      </body>
    </html>
  );
}

export function shouldEnableAaisVercelAnalytics(
  env: Record<string, string | undefined> = process.env,
) {
  return env.AAIS_RESEARCH_MODE?.trim().toLowerCase() !== "true"
    && env.AAIS_RESEARCH_REQUIRED?.trim().toLowerCase() !== "true"
    && env.AAIS_RESEARCH_ENVIRONMENT?.trim().toLowerCase() !== "research";
}
