export function shouldEnableAaisVercelAnalytics(
  env: Record<string, string | undefined> = process.env,
) {
  const provider = env.AAIS_DEPLOYMENT_PROVIDER?.trim().toLowerCase();
  const vercelRuntime = provider === "vercel" || Boolean(env.VERCEL);
  return vercelRuntime
    && env.AAIS_RESEARCH_MODE?.trim().toLowerCase() !== "true"
    && env.AAIS_RESEARCH_REQUIRED?.trim().toLowerCase() !== "true"
    && env.AAIS_RESEARCH_ENVIRONMENT?.trim().toLowerCase() !== "research";
}
