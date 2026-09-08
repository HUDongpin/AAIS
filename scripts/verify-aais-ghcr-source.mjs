import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function verifyAaisGhcrSource(env, actualSha) {
  if (env.GITHUB_REPOSITORY !== "HUDongpin/AAIS"
    || env.GITHUB_EVENT_NAME !== "workflow_dispatch"
    || env.GITHUB_REF !== "refs/heads/codex/aais-aliyun-postgres-empty"
    || env.GITHUB_REF_PROTECTED !== "true"
    || !/^[a-f0-9]{40}$/.test(env.AAIS_EXPECTED_SHA ?? "")
    || env.GITHUB_SHA !== env.AAIS_EXPECTED_SHA
    || actualSha !== env.AAIS_EXPECTED_SHA) {
    throw new Error("AAIS_GHCR_SOURCE_BINDING_REJECTED");
  }
  return { status: "pass", repository: "HUDongpin/AAIS", ref: env.GITHUB_REF, sha: actualSha };
}

export function verifyAaisGhcrResumeProof({ run, jobs, log, expectedSha, digest, runId, runAttempt }) {
  const reject = () => { throw new Error("AAIS_GHCR_RESUME_PROOF_REJECTED"); };
  if (!/^[a-f0-9]{40}$/.test(expectedSha ?? "")
    || !/^sha256:[a-f0-9]{64}$/.test(digest ?? "")
    || !/^[1-9][0-9]*$/.test(runId ?? "") || !/^[1-9][0-9]*$/.test(runAttempt ?? "")
    || String(run?.id) !== runId || String(run?.run_attempt) !== runAttempt
    || run?.repository?.full_name !== "HUDongpin/AAIS"
    || run?.head_sha !== expectedSha || run?.head_branch !== "codex/aais-aliyun-postgres-empty"
    || run?.path !== ".github/workflows/ghcr-container.yml"
    || run?.event !== "workflow_dispatch" || run?.status !== "completed"
    || !Array.isArray(jobs?.jobs) || jobs.jobs.length !== jobs.total_count
    || typeof log !== "string" || log.length > 8 * 1024 * 1024) reject();
  const matches = jobs.jobs.filter((job) => job.name === "Publish immutable private GHCR image");
  if (matches.length !== 1) reject();
  const job = matches[0];
  if (String(job.run_id) !== runId || String(job.run_attempt) !== runAttempt
    || job.head_sha !== expectedSha || job.status !== "completed" || !Array.isArray(job.steps)) reject();
  for (const name of ["Record immutable source metadata",
    "Build and push the exact-SHA image with OCI attestations", "Record immutable build output"]) {
    const steps = job.steps.filter((step) => step.name === name);
    if (steps.length !== 1 || steps[0].conclusion !== "success") reject();
  }
  const records = [...log.matchAll(/^\d{4}-\S+Z AAIS_GHCR_BUILD_OUTPUT=(\{[^\r\n]*\})\r?$/gm)];
  if (records.length !== 1) reject();
  let record;
  try { record = JSON.parse(records[0][1]); } catch { reject(); }
  if (record?.schemaVersion !== 1 || record.gitSha !== expectedSha || record.imageDigest !== digest
    || record.imageRepository !== "ghcr.io/hudongpin/aais"
    || record.runId !== runId || record.runAttempt !== runAttempt) reject();
  return { status: "verified", digest, buildRunId: runId, buildRunAttempt: runAttempt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    console.log(JSON.stringify(verifyAaisGhcrSource(process.env, sha)));
  } catch {
    console.error("AAIS_GHCR_SOURCE_BINDING_REJECTED");
    process.exitCode = 1;
  }
}
