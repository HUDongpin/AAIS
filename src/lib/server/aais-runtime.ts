export function requiresAaisDurableStorage(
  env: NodeJS.ProcessEnv = process.env,
) {
  if (env.VERCEL_ENV?.trim() === "preview") {
    return false;
  }
  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
}
