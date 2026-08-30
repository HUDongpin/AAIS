export type AaisDeploymentProvider = "aliyun" | "vercel" | "unknown";

export type AaisReleaseMetadata = {
  id: string | null;
  source: "AAIS_RELEASE_ID" | "missing";
  deployment: {
    provider: AaisDeploymentProvider;
    gitCommit: {
      present: boolean;
      shortSha: string | null;
      source: "VERCEL_GIT_COMMIT_SHA" | "AAIS_DEPLOYMENT_GIT_COMMIT_SHA" | "missing";
    };
  };
};

export function getAaisReleaseMetadata(
  env: Record<string, string | undefined> = process.env,
): AaisReleaseMetadata {
  const releaseId = readSafeReleaseId(env.AAIS_RELEASE_ID);
  const vercelGitCommitShortSha = readSafeGitCommitShortSha(env.VERCEL_GIT_COMMIT_SHA);
  const explicitGitCommitShortSha = readSafeGitCommitShortSha(env.AAIS_DEPLOYMENT_GIT_COMMIT_SHA);
  const gitCommitShortSha = vercelGitCommitShortSha ?? explicitGitCommitShortSha;
  return {
    id: releaseId,
    source: releaseId ? "AAIS_RELEASE_ID" : "missing",
    deployment: {
      provider: readAaisDeploymentProvider(env),
      gitCommit: {
        present: Boolean(gitCommitShortSha),
        shortSha: gitCommitShortSha,
        source: vercelGitCommitShortSha
          ? "VERCEL_GIT_COMMIT_SHA"
          : explicitGitCommitShortSha
            ? "AAIS_DEPLOYMENT_GIT_COMMIT_SHA"
            : "missing",
      },
    },
  };
}

export function readAaisDeploymentProvider(
  env: Record<string, string | undefined> = process.env,
): AaisDeploymentProvider {
  const configured = env.AAIS_DEPLOYMENT_PROVIDER?.trim().toLowerCase();
  if (configured === "aliyun" || configured === "vercel") {
    return configured;
  }
  return env.VERCEL ? "vercel" : "unknown";
}

function readSafeReleaseId(value: string | undefined) {
  const trimmed = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(trimmed) ? trimmed : null;
}

function readSafeGitCommitShortSha(value: string | undefined) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{7,40}$/.test(trimmed) ? trimmed.slice(0, 12) : null;
}
