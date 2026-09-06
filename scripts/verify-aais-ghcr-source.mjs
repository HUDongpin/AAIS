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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    console.log(JSON.stringify(verifyAaisGhcrSource(process.env, sha)));
  } catch {
    console.error("AAIS_GHCR_SOURCE_BINDING_REJECTED");
    process.exitCode = 1;
  }
}
