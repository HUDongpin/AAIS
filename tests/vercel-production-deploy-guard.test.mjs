import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluateAaisVercelProductionDeploy,
  getAaisProductCronScheduleState,
  hasAllAaisProductCronSchedules,
} from "../scripts/guard-vercel-production-deploy.mjs";

describe("AAIS Vercel production deploy guard", () => {
  it("does not block local builds", () => {
    const report = evaluateAaisVercelProductionDeploy({ env: {} });

    expect(report.status).toBe("skipped");
    expect(report.reason).toBe("AAIS_NOT_RUNNING_ON_VERCEL");
  });

  it("allows non-production Vercel builds", () => {
    const report = evaluateAaisVercelProductionDeploy({
      env: {
        VERCEL: "1",
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_REF: "codex/advisory-fixes",
      },
    });

    expect(report.status).toBe("passed");
    expect(report.reason).toBe("AAIS_NON_PRODUCTION_VERCEL_BUILD");
  });

  it("allows production Vercel builds from Git-connected main", () => {
    const report = evaluateAaisVercelProductionDeploy({
      env: {
        VERCEL: "1",
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_REF: "main",
        VERCEL_GIT_COMMIT_SHA: "0123456789abcdef",
        VERCEL_GIT_PROVIDER: "github",
        AAIS_RUNTIME_LEASE_SCHEMA_CONFIRMED: "true",
      },
    });

    expect(report.status).toBe("passed");
    expect(report.reason).toBe("AAIS_PRODUCTION_DEPLOY_GIT_MAIN_CONFIRMED");
    expect(report.issues).toEqual([]);
  });

  it("blocks the first cron-free production build until Aliyun owns both product schedules", () => {
    const report = evaluateAaisVercelProductionDeploy({
      productCronScheduleState: "removed",
      env: {
        VERCEL: "1",
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_REF: "main",
        VERCEL_GIT_COMMIT_SHA: "0123456789abcdef",
        VERCEL_GIT_PROVIDER: "github",
        AAIS_RUNTIME_LEASE_SCHEMA_CONFIRMED: "true",
      },
    });

    expect(report.status).toBe("failed");
    expect(report.reason).toBe("AAIS_PRODUCTION_DEPLOY_SCHEDULER_STATE_INVALID");
    expect(report.issues).toEqual([
      "AAIS_PRODUCTION_DEPLOY_REQUIRES_CURRENT_VERCEL_CRONS_BEFORE_HANDOFF",
    ]);
  });

  it("allows the cron-removal transition after the Aliyun handoff is evidenced", () => {
    const report = evaluateAaisVercelProductionDeploy({
      productCronScheduleState: "removed",
      env: {
        VERCEL: "1",
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_REF: "main",
        VERCEL_GIT_COMMIT_SHA: "0123456789abcdef",
        VERCEL_GIT_PROVIDER: "github",
        AAIS_ALIYUN_PRIMARY_SCHEDULERS_CONFIRMED: "true",
        AAIS_RUNTIME_LEASE_SCHEMA_CONFIRMED: "true",
      },
    });

    expect(report.status).toBe("passed");
    expect(report.checks.productCronScheduleState).toBe("removed");
  });

  it("blocks the lease-aware production build until migrations and target identity are evidenced", () => {
    const report = evaluateAaisVercelProductionDeploy({
      env: {
        VERCEL: "1",
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_REF: "main",
        VERCEL_GIT_COMMIT_SHA: "0123456789abcdef",
        VERCEL_GIT_PROVIDER: "github",
      },
    });

    expect(report.status).toBe("failed");
    expect(report.reason).toBe(
      "AAIS_PRODUCTION_DEPLOY_RUNTIME_LEASE_SCHEMA_NOT_CONFIRMED",
    );
    expect(report.issues).toEqual([
      "AAIS_PRODUCTION_DEPLOY_REQUIRES_RUNTIME_LEASE_SCHEMA",
    ]);
  });

  it("blocks production Vercel builds without Git main metadata", () => {
    const report = evaluateAaisVercelProductionDeploy({
      env: {
        VERCEL: "1",
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_REF: "codex/manual-upload",
        AAIS_RUNTIME_LEASE_SCHEMA_CONFIRMED: "true",
      },
    });

    expect(report.status).toBe("failed");
    expect(report.reason).toBe("AAIS_PRODUCTION_DEPLOY_NOT_GIT_MAIN");
    expect(report.issues).toEqual([
      "AAIS_PRODUCTION_DEPLOY_REQUIRES_MAIN_GIT_REF",
      "AAIS_PRODUCTION_DEPLOY_REQUIRES_GIT_COMMIT_SHA",
      "AAIS_PRODUCTION_DEPLOY_REQUIRES_GIT_PROVIDER",
    ]);
  });

  it("treats a partial product-cron configuration as a guarded removal", () => {
    const partialConfig = {
      crons: [
        {
          path: "/api/learning/lrs/outbox/flush",
          schedule: "*/5 * * * *",
        },
      ],
    };
    expect(hasAllAaisProductCronSchedules(partialConfig)).toBe(false);
    expect(getAaisProductCronScheduleState(partialConfig)).toBe("partial");
  });

  it("blocks Vercel product crons from being restored after the Aliyun handoff", () => {
    const report = evaluateAaisVercelProductionDeploy({
      env: {
        VERCEL: "1",
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_REF: "main",
        VERCEL_GIT_COMMIT_SHA: "0123456789abcdef",
        VERCEL_GIT_PROVIDER: "github",
        AAIS_RUNTIME_LEASE_SCHEMA_CONFIRMED: "true",
        AAIS_ALIYUN_PRIMARY_SCHEDULERS_CONFIRMED: "true",
      },
    });

    expect(report.status).toBe("failed");
    expect(report.reason).toBe("AAIS_PRODUCTION_DEPLOY_SCHEDULER_STATE_INVALID");
    expect(report.issues).toEqual([
      "AAIS_PRODUCTION_DEPLOY_REQUIRES_CRON_FREE_VERCEL_AFTER_HANDOFF",
    ]);
  });

  it("treats a query-string worker schedule as a product Cron reintroduction", () => {
    expect(getAaisProductCronScheduleState({
      crons: [
        {
          path: "/api/auth/email-outbox/flush?source=vercel-cron",
          schedule: "*/5 * * * *",
        },
      ],
    })).toBe("partial");
  });

  it("wires the guard into the Vercel build command", () => {
    const vercelConfig = JSON.parse(readFileSync("vercel.json", "utf8"));
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const vercelIgnore = readFileSync(".vercelignore", "utf8");
    const packageScripts = Object.values(packageJson.scripts ?? {}).join("\n");

    expect(vercelConfig.buildCommand).toBe(
      "node -- scripts/guard-vercel-production-deploy.mjs && npm run build",
    );
    expect(hasAllAaisProductCronSchedules(vercelConfig)).toBe(true);
    expect(vercelConfig.crons).toHaveLength(2);
    expect(vercelIgnore).toMatch(/^\/\*\.docx$/m);
    expect(vercelIgnore).toMatch(/^docs\/figures\/$/m);
    expect(packageScripts).not.toContain("vercel deploy --prod");
  });

  it("keeps dynamic file-store paths out of Next server trace expansion", () => {
    const learningStoreSource = readFileSync(
      "src/lib/server/aais-learning-store.ts",
      "utf8",
    );

    expect(learningStoreSource).not.toContain(
      'path.join(process.cwd(), ".aais-data")',
    );
    expect(learningStoreSource.match(/\/\*turbopackIgnore: true\*\//g)?.length ?? 0)
      .toBeGreaterThanOrEqual(7);
  });
});
