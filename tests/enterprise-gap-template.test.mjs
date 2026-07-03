import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateAaisEnterpriseGapTemplate } from "../scripts/generate-enterprise-gap-template.mjs";

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-gap-template-"));
});

afterEach(async () => {
  delete process.env.AAIS_ENTERPRISE_GAP_TEMPLATE_PATH;
  delete process.env.AAIS_ENTERPRISE_GAP_TEMPLATE_REPORT_PATH;
  await rm(tempDir, { force: true, recursive: true });
});

describe("AAIS enterprise gap evidence template", () => {
  it("is exposed through a package release script", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));

    expect(packageJson.scripts["release:gap-template"]).toBe(
      "node -- scripts/generate-enterprise-gap-template.mjs",
    );
  });

  it("writes a fail-closed current-stage trial auth evidence template and redacted report", async () => {
    const outputPath = path.join(tempDir, "gap-template.env");
    const reportPath = path.join(tempDir, "gap-template-report.json");
    const report = await generateAaisEnterpriseGapTemplate({
      outputPath,
      reportPath,
      baseUrl: "https://aais.example.test/path?ignored=1#hash",
      releaseId: "aais-2026-07-01-rc1",
      enterpriseReportPath: "output/enterprise.json",
      restoreEnvFilePath: ".env.postgres-restore.local",
      restoreReportPath: "output/restore.json",
      gapEvidenceReportPath: "output/gaps.json",
      now: new Date("2026-07-01T11:00:00.000Z"),
    });

    expect(report).toEqual({
      schemaVersion: 1,
      status: "template-created",
      generatedAt: "2026-07-01T11:00:00.000Z",
      release: {
        id: "aais-2026-07-01-rc1",
      },
      template: {
        outputPath,
        privateSmokeEnvFilePath: ".env.enterprise-smoke.local",
        placeholderValues: "fail-closed",
        variables: [
          "AAIS_VERIFY_BASE_URL",
          "AAIS_VERIFY_TRIAL_ACCOUNT",
          "AAIS_VERIFY_TRIAL_CORRECT_PASSWORD",
          "AAIS_VERIFY_TRIAL_WRONG_PASSWORD",
          "AAIS_VERIFY_TRIAL_THROTTLE_ACCOUNT",
          "AAIS_VERIFY_TRIAL_THROTTLE_CORRECT_PASSWORD",
          "AAIS_VERIFY_TRIAL_CLIENT_IP",
          "AAIS_VERIFY_TRIAL_THROTTLE_CLIENT_IP",
          "AAIS_VERIFY_EDUCATOR_ACCOUNT",
          "AAIS_VERIFY_EDUCATOR_CORRECT_PASSWORD",
          "AAIS_RELEASE_ID",
        ],
      },
      target: {
        baseUrl: "https://aais.example.test/path",
        enterpriseReportPath: "output/enterprise.json",
        restoreEnvFilePath: ".env.postgres-restore.local",
        restoreReportPath: "output/restore.json",
        aiEvalEnvFilePath: ".env.production.local",
        aiEvalManifestPath: "output/aais-ai-eval-deepseek-v4-pro.json",
        aiEvalInlineManifestPath: "output/aais-ai-eval-inline-latest.json",
        gapEvidenceReportPath: "output/gaps.json",
      },
      nextCommands: {
        trialAuth: "npm run verify:enterprise-gaps -- --mode trial-auth --env-file .env.enterprise-smoke.local --base-url https://aais.example.test/path --enterprise-output output/enterprise.json --output output/gaps.json --release-id aais-2026-07-01-rc1",
        restore: "npm run verify:enterprise-gaps -- --mode restore --restore-env-file .env.postgres-restore.local --restore-output output/restore.json --output output/gaps.json --release-id aais-2026-07-01-rc1",
        liveAiEval: "npm run verify:enterprise-gaps -- --mode live-ai-eval --ai-eval-env-file .env.production.local --ai-eval-output output/aais-ai-eval-deepseek-v4-pro.json --ai-eval-inline-output output/aais-ai-eval-inline-latest.json --output output/gaps.json --release-id aais-2026-07-01-rc1",
        all: "npm run verify:enterprise-gaps -- --mode all --env-file .env.enterprise-smoke.local --restore-env-file .env.postgres-restore.local --ai-eval-env-file .env.production.local --base-url https://aais.example.test/path --enterprise-output output/enterprise.json --restore-output output/restore.json --ai-eval-output output/aais-ai-eval-deepseek-v4-pro.json --ai-eval-inline-output output/aais-ai-eval-inline-latest.json --output output/gaps.json --release-id aais-2026-07-01-rc1",
      },
      redaction: {
        secrets: "omitted",
        values: "placeholders-only",
        trialAuthEvidence: "not-stored",
      },
    });

    const template = await readFile(outputPath, "utf8");
    expect(template).toContain("# AAIS enterprise gap evidence env template");
    expect(template).toContain("# Do not commit this file.");
    expect(template).toContain("AAIS_VERIFY_BASE_URL=https://aais.example.test/path");
    expect(template).toContain("AAIS_VERIFY_TRIAL_ACCOUNT=<REQUIRED:TRIAL_LEARNER_ACCOUNT>");
    expect(template).toContain("AAIS_VERIFY_TRIAL_CORRECT_PASSWORD=<REQUIRED:TRIAL_LEARNER_PASSWORD>");
    expect(template).toContain("AAIS_VERIFY_TRIAL_WRONG_PASSWORD=<OPTIONAL:INTENTIONAL_WRONG_PASSWORD>");
    expect(template).toContain("AAIS_VERIFY_TRIAL_THROTTLE_ACCOUNT=<OPTIONAL:SEPARATE_THROTTLE_ACCOUNT>");
    expect(template).toContain("AAIS_VERIFY_TRIAL_THROTTLE_CORRECT_PASSWORD=<OPTIONAL:SEPARATE_THROTTLE_PASSWORD>");
    expect(template).toContain("AAIS_VERIFY_TRIAL_CLIENT_IP=<OPTIONAL:TRIAL_LEARNING_CLIENT_IP>");
    expect(template).toContain("AAIS_VERIFY_TRIAL_THROTTLE_CLIENT_IP=<OPTIONAL:TRIAL_THROTTLE_CLIENT_IP>");
    expect(template).toContain("AAIS_VERIFY_EDUCATOR_ACCOUNT=<REQUIRED:TRIAL_EDUCATOR_ACCOUNT>");
    expect(template).toContain("AAIS_VERIFY_EDUCATOR_CORRECT_PASSWORD=<REQUIRED:TRIAL_EDUCATOR_PASSWORD>");
    expect(template).not.toContain("AAIS_VERIFY_OIDC_CALLBACK_URL");
    expect(template).not.toContain("AAIS_VERIFY_OIDC_STATE_COOKIE");
    expect(template).toContain("AAIS_RELEASE_ID=aais-2026-07-01-rc1");
    expect(`${JSON.stringify(report)}\n${template}`).not.toContain("secret-code");
    expect(`${JSON.stringify(report)}\n${template}`).not.toContain("secret-state-cookie");
    expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual(report);
  });

  it("uses environment output paths when explicit output paths are omitted", async () => {
    process.env.AAIS_ENTERPRISE_GAP_TEMPLATE_PATH = path.join(tempDir, "env-gap-template.env");
    process.env.AAIS_ENTERPRISE_GAP_TEMPLATE_REPORT_PATH = path.join(tempDir, "env-gap-report.json");

    const report = await generateAaisEnterpriseGapTemplate({
      baseUrl: "https://aais.example.test",
      releaseId: "aais-2026-07-01-rc1",
      now: new Date("2026-07-01T11:00:00.000Z"),
    });

    expect(report.template.outputPath).toBe(process.env.AAIS_ENTERPRISE_GAP_TEMPLATE_PATH);
    expect(JSON.parse(await readFile(process.env.AAIS_ENTERPRISE_GAP_TEMPLATE_REPORT_PATH, "utf8"))).toEqual(report);
  });
});
