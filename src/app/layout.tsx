import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AAIS",
  description: "Apprenticeship AI system for Cognitive Apprenticeship learning.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        <a className="aais-skip-link" href="#aais-main-content">
          跳到主要内容
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
