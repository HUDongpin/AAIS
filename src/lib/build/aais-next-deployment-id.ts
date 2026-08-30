type BuildEnvironment = Record<string, string | undefined>;

export function readAaisBuildDeploymentId(
  env: BuildEnvironment = process.env,
): string | undefined {
  const providerDeploymentId = env.NEXT_DEPLOYMENT_ID?.trim();
  if (providerDeploymentId) {
    return providerDeploymentId;
  }

  const gitSha = [
    env.AAIS_DEPLOYMENT_GIT_COMMIT_SHA,
    env.VERCEL_GIT_COMMIT_SHA,
  ]
    .map((value) => value?.trim().toLowerCase() ?? "")
    .find((value) => /^[a-f0-9]{40}$/.test(value));
  return gitSha || undefined;
}
