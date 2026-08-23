type AaisReadinessOutcome = {
  status: "ready" | "not_ready";
  readinessMode: "traffic" | "enterprise";
  issues: string[];
  warnings: string[];
  releaseGitCommitShortSha: string | null;
};

const repeatedDiagnosticIntervalMs = 5 * 60 * 1_000;
let lastDiagnostic: {
  signature: string;
  loggedAt: number;
} | undefined;

export function recordAaisReadinessOutcome(
  outcome: AaisReadinessOutcome,
  now = Date.now(),
) {
  if (outcome.status === "ready") {
    lastDiagnostic = undefined;
    return;
  }

  const issues = [...outcome.issues].sort();
  const signature = JSON.stringify([outcome.readinessMode, issues]);
  if (
    lastDiagnostic?.signature === signature
    && now - lastDiagnostic.loggedAt < repeatedDiagnosticIntervalMs
  ) {
    return;
  }
  lastDiagnostic = { signature, loggedAt: now };

  console.warn(JSON.stringify({
    event: "aais.readiness.not_ready",
    readinessMode: outcome.readinessMode,
    issueCount: issues.length,
    issues,
    warningCount: outcome.warnings.length,
    releaseGitCommitShortSha: outcome.releaseGitCommitShortSha,
    secrets: "redacted",
  }));
}
