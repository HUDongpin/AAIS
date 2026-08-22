import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateAaisVercelProductionDeploy } from "../scripts/guard-vercel-production-deploy.mjs";

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
      },
    });

    expect(report.status).toBe("passed");
    expect(report.reason).toBe("AAIS_PRODUCTION_DEPLOY_GIT_MAIN_CONFIRMED");
    expect(report.issues).toEqual([]);
  });

  it("blocks production Vercel builds without Git main metadata", () => {
    const report = evaluateAaisVercelProductionDeploy({
      env: {
        VERCEL: "1",
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_REF: "codex/manual-upload",
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

  it("wires the guard into the Vercel build command", () => {
    const vercelConfig = JSON.parse(readFileSync("vercel.json", "utf8"));
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const vercelIgnore = readFileSync(".vercelignore", "utf8");
    const packageScripts = Object.values(packageJson.scripts ?? {}).join("\n");

    expect(vercelConfig.buildCommand).toBe(
      "node -- scripts/guard-vercel-production-deploy.mjs && npm run build",
    );
    expect(vercelConfig.crons).toContainEqual({
      path: "/api/learning/lrs/outbox/flush",
      schedule: "*/5 * * * *",
    });
    expect(vercelConfig.crons).toContainEqual({
      path: "/api/auth/email-outbox/flush",
      schedule: "*/5 * * * *",
    });
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
