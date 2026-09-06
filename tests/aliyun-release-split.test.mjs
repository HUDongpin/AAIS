import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifyAaisGhcrSource } from "../scripts/verify-aais-ghcr-source.mjs";
import { assertAaisAliyunOnlyBuild } from "../scripts/guard-aais-aliyun-only.mjs";

const sha = "a".repeat(40);
const env = { GITHUB_REPOSITORY: "HUDongpin/AAIS", GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/codex/aais-aliyun-postgres-empty", GITHUB_REF_PROTECTED: "true", GITHUB_SHA: sha, AAIS_EXPECTED_SHA: sha };

describe("independent Aliyun candidate release", () => {
  it("keeps the default-branch registration package minimal and current", () => {
    const patch = readFileSync("deploy/aliyun/ghcr-registration.patch", "utf8");
    const sections = patch.split(/(?=^diff --git )/m).filter(Boolean);
    expect(sections.map((section) => section.split("\n")[0])).toEqual([
      "diff --git a/.github/workflows/ghcr-container.yml b/.github/workflows/ghcr-container.yml",
      "diff --git a/scripts/verify-aais-ghcr-source.mjs b/scripts/verify-aais-ghcr-source.mjs",
      "diff --git a/vercel.json b/vercel.json",
    ]);
    const added = (section) => section.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1)).join("\n") + "\n";
    expect(added(sections[0])).toBe(readFileSync(".github/workflows/ghcr-container.yml", "utf8"));
    expect(added(sections[1])).toBe(readFileSync("scripts/verify-aais-ghcr-source.mjs", "utf8"));
    const config = JSON.parse(added(sections[2]));
    expect(config.buildCommand).toBe("node -- scripts/guard-vercel-production-deploy.mjs && npm run build");
    expect(config.regions).toBeUndefined();
    expect(config.crons.map((cron) => cron.schedule)).toEqual(["*/5 * * * *", "*/5 * * * *"]);
    expect(config.git.deploymentEnabled).toEqual({ "codex/aais-aliyun-postgres-empty": false });
  });

  it("binds a manually approved exact SHA on one branch", () => {
    expect(verifyAaisGhcrSource(env, sha).status).toBe("pass");
    for (const overrides of [
      { GITHUB_REF: "refs/heads/main" }, { GITHUB_REF: "refs/heads/arbitrary" },
      { GITHUB_REF: "refs/tags/codex/aais-aliyun-postgres-empty" },
      { GITHUB_EVENT_NAME: "push" }, { GITHUB_EVENT_NAME: "pull_request" },
      { GITHUB_REPOSITORY: "other/AAIS" }, { AAIS_EXPECTED_SHA: "main" },
      { GITHUB_REF_PROTECTED: "false" }, { GITHUB_REF_PROTECTED: undefined },
      { AAIS_EXPECTED_SHA: "b".repeat(40) }, { GITHUB_SHA: "b".repeat(40) },
    ]) expect(() => verifyAaisGhcrSource({ ...env, ...overrides }, sha)).toThrow();
    expect(() => verifyAaisGhcrSource(env, "b".repeat(40))).toThrow();
  });
  it("does not activate the old Vercel warm-backup settings", () => {
    const config = JSON.parse(readFileSync("vercel.json", "utf8"));
    expect(config.regions).toBeUndefined();
    expect(config.crons.map((cron) => cron.schedule)).toEqual(["*/5 * * * *", "*/5 * * * *"]);
    expect(config.git.deploymentEnabled).toEqual({ "codex/aais-aliyun-postgres-empty": false });
    expect(config.buildCommand).toBe("node -- scripts/guard-aais-aliyun-only.mjs && npm run build");
    expect(() => assertAaisAliyunOnlyBuild({})).not.toThrow();
    for (const value of ["production", "preview", "development"]) {
      expect(() => assertAaisAliyunOnlyBuild({ VERCEL_ENV: value })).toThrow();
    }
    expect(() => assertAaisAliyunOnlyBuild({ VERCEL: "1" })).toThrow();
    const deferred = readFileSync("deploy/vercel/warm-backup-deferred.patch", "utf8");
    expect(deferred).toContain('+  "regions": ["sin1"]');
    expect(deferred).toContain("AAIS_PRODUCTION_DEPLOY_REQUIRES_DATABASE_POOL_MAX_2");
  });
});
