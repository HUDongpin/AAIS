import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateAaisEnterpriseHandoff } from "../scripts/generate-enterprise-handoff.mjs";

const execFileAsync = promisify(execFile);

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-enterprise-handoff-"));
});

afterEach(async () => {
  delete process.env.AAIS_ENTERPRISE_HANDOFF_REPORT_PATH;
  delete process.env.AAIS_ENTERPRISE_HANDOFF_MARKDOWN_PATH;
  await rm(tempDir, { force: true, recursive: true });
});

describe("AAIS enterprise handoff generator", () => {
  it("writes a redacted action handoff from the failed release gate and local credential inventory", async () => {
    const releaseCheckReportPath = await writeJson("release-check.json", {
      schemaVersion: 1,
      status: "failed",
      checkedAt: "2026-06-30T08:00:00.000Z",
      sequence: [
        { name: "vercel-env", status: "failed", outputPath: "output/vercel-env.json" },
        { name: "enterprise-smoke", status: "failed", outputPath: "output/enterprise.json" },
        { name: "release-evidence", status: "failed", outputPath: "output/evidence.json" },
      ],
      artifacts: {
        vercelEnv: {
          status: "failed",
          missingCount: 5,
          missing: [
            "AAIS_DATABASE_URL",
            "AAIS_OIDC_ISSUER",
            "AAIS_OIDC_CLIENT_ID",
            "AAIS_OIDC_CLIENT_SECRET",
            "AAIS_OIDC_REDIRECT_URI",
          ],
        },
        enterprise: {
          status: "failed",
          requiredChecks: {
            legalPages: true,
            readiness: false,
            oidcStart: false,
            oidcCallback: false,
            ssoOnlyMode: true,
          },
          evidenceOrder: {
            enterpriseAfterVercelEnv: true,
          },
        },
        aiEval: {
          status: "passed",
          compatibleWithEnterpriseReadiness: true,
          blockedCount: 0,
          modelFingerprintMatchesEnterprise: true,
        },
        postgresRestore: {
          status: "missing",
        },
      },
      leakedValue: "postgres://user:secret@host/db",
    });
    const vercelEnvReportPath = await writeJson("vercel-env.json", {
      status: "failed",
      provisioningPlan: {
        status: "required",
        actions: [
          {
            category: "storage",
            missing: ["AAIS_DATABASE_URL"],
            commands: ["vercel env add AAIS_DATABASE_URL production"],
          },
          {
            category: "oidc",
            missing: [
              "AAIS_OIDC_ISSUER",
              "AAIS_OIDC_CLIENT_ID",
              "AAIS_OIDC_CLIENT_SECRET",
              "AAIS_OIDC_REDIRECT_URI",
            ],
            commands: [
              "vercel env add AAIS_OIDC_ISSUER production",
              "vercel env add AAIS_OIDC_CLIENT_ID production",
              "vercel env add AAIS_OIDC_CLIENT_SECRET production",
              "vercel env add AAIS_OIDC_REDIRECT_URI production",
            ],
          },
        ],
      },
      storageUrl: {
        acceptedNames: [
          "AAIS_DATABASE_URL",
          "DATABASE_URL",
          "POSTGRES_URL",
          "DATABASE_URL_UNPOOLED",
          "PGHOST/PGUSER/PGDATABASE/PGPASSWORD",
        ],
      },
      redaction: {
        secrets: "omitted",
        values: "not-read",
      },
    });
    const provisionReportPath = await writeJson("provision.json", {
      status: "blocked",
      required: {
        requested: [
          "AAIS_DATABASE_URL",
          "AAIS_OIDC_ISSUER",
          "AAIS_OIDC_CLIENT_ID",
          "AAIS_OIDC_CLIENT_SECRET",
          "AAIS_OIDC_REDIRECT_URI",
        ],
        localValuesPresent: [],
        localValuesMissing: [
          "AAIS_DATABASE_URL",
          "AAIS_OIDC_ISSUER",
          "AAIS_OIDC_CLIENT_ID",
          "AAIS_OIDC_CLIENT_SECRET",
          "AAIS_OIDC_REDIRECT_URI",
        ],
      },
      rawSecret: "oidc-client-secret-value",
    });
    const envPath = path.join(tempDir, ".env.local");
    const docxPath = path.join(tempDir, "All API Keys.docx");
    await writeFile(envPath, "LRS_USERNAME=learner\nLRS_PASSWORD=do-not-emit\n", "utf8");
    await writeFile(docxPath, "AAIS_AI_API_KEY=do-not-emit-either", "utf8");
    const outputPath = path.join(tempDir, "handoff.json");
    const markdownOutputPath = path.join(tempDir, "handoff.md");
    const privateEnvTemplatePath = path.join(tempDir, "aais-private-env-template.env");
    const privateEnvTemplateReportPath = path.join(tempDir, "aais-private-env-template-report.json");
    const postgresRestoreTemplatePath = path.join(tempDir, "aais-postgres-restore-template.env");
    const postgresRestoreTemplateReportPath = path.join(tempDir, "aais-postgres-restore-template-report.json");

    const report = await generateAaisEnterpriseHandoff({
      releaseCheckReportPath,
      vercelEnvReportPath,
      provisionReportPath,
      outputPath,
      markdownOutputPath,
      privateEnvTemplatePath,
      privateEnvTemplateReportPath,
      postgresRestoreTemplatePath,
      postgresRestoreTemplateReportPath,
      localCredentialFiles: [envPath, docxPath],
      baseUrl: "https://aais-six.vercel.app",
      releaseId: "aais-2026-06-30-rc-live-ai-deepseek-v4-flash",
      aiEvalManifestPath: "output/aais-ai-eval-deepseek-v4-flash.json",
      postgresRestoreReportPath: "output/aais-postgres-restore-report-latest.json",
      now: new Date("2026-06-30T08:30:00.000Z"),
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "action-required",
      generatedAt: "2026-06-30T08:30:00.000Z",
      sourceReports: {
        releaseCheck: releaseCheckReportPath,
        vercelEnv: vercelEnvReportPath,
        provision: provisionReportPath,
      },
      currentGate: {
        status: "failed",
        checkedAt: "2026-06-30T08:00:00.000Z",
      },
      missing: {
        vercelProductionEnv: [
          "AAIS_DATABASE_URL",
          "AAIS_OIDC_ISSUER",
          "AAIS_OIDC_CLIENT_ID",
          "AAIS_OIDC_CLIENT_SECRET",
          "AAIS_OIDC_REDIRECT_URI",
        ],
        storage: ["AAIS_DATABASE_URL"],
        oidc: [
          "AAIS_OIDC_ISSUER",
          "AAIS_OIDC_CLIENT_ID",
          "AAIS_OIDC_CLIENT_SECRET",
          "AAIS_OIDC_REDIRECT_URI",
        ],
        postgresRestoreReport: true,
        teacherCohortAnalyticsSmoke: true,
      },
      localCredentialInventory: {
        values: "not-read",
        storageUsable: false,
        oidcUsable: false,
        oidcRoleMappingUsable: true,
        releaseUsable: true,
        missingNames: [
          "AAIS_DATABASE_URL",
          "AAIS_OIDC_ISSUER",
          "AAIS_OIDC_CLIENT_ID",
          "AAIS_OIDC_CLIENT_SECRET",
          "AAIS_OIDC_REDIRECT_URI",
        ],
        files: [
          {
            path: envPath,
            exists: true,
            presentNames: [],
          },
          {
            path: docxPath,
            exists: true,
            presentNames: [],
          },
        ],
      },
      provisionDryRun: {
        status: "blocked",
        localValuesPresent: [],
        localValuesMissing: [
          "AAIS_DATABASE_URL",
          "AAIS_OIDC_ISSUER",
          "AAIS_OIDC_CLIENT_ID",
          "AAIS_OIDC_CLIENT_SECRET",
          "AAIS_OIDC_REDIRECT_URI",
        ],
      },
      externalActions: [
        {
          id: "fill-private-env-template",
          status: "required",
          templatePath: privateEnvTemplatePath,
          reportPath: privateEnvTemplateReportPath,
        },
        {
          id: "verify-oidc-config-dry-run",
          status: "required-after-private-env-fill",
        },
        {
          id: "set-vercel-production-env",
          status: "required",
        },
        {
          id: "redeploy-vercel-production",
          status: "required-after-env-change",
          command: "vercel deploy --prod -y --no-wait",
        },
        {
          id: "inspect-vercel-production-deployment",
          status: "required-after-production-deploy",
        },
        {
          id: "fill-postgres-restore-template",
          status: "required",
          templatePath: postgresRestoreTemplatePath,
          reportPath: postgresRestoreTemplateReportPath,
          privateRestoreEnvFilePath: ".env.postgres-restore.local",
        },
        {
          id: "run-neon-restore-rehearsal",
          status: "required",
        },
        {
          id: "run-real-oidc-callback-smoke",
          status: "required",
        },
        {
          id: "run-teacher-cohort-analytics-smoke",
          status: "required",
        },
        {
          id: "rerun-final-gate",
          status: "required",
        },
      ],
      redaction: {
        secrets: "omitted",
        values: "not-read",
      },
    });
    expect(report.externalActions[0].commands).toEqual([
      `npm run provision:vercel-env -- --env-file .env.production.local --report ${vercelEnvReportPath} --output output/aais-vercel-env-provision-dry-run-latest.json`,
      `npm run provision:vercel-env -- --env-file .env.production.local --report ${vercelEnvReportPath} --apply --output output/aais-vercel-env-provision-apply-latest.json`,
    ]);
    const oidcConfigDryRun = report.externalActions.find((action) => action.id === "verify-oidc-config-dry-run");
    expect(oidcConfigDryRun).toMatchObject({
      status: "required-after-private-env-fill",
      command: "npm run verify:oidc-config -- --env-file .env.production.local --base-url https://aais-six.vercel.app --output output/aais-oidc-config-report-latest.json",
    });
    const setVercelEnv = report.externalActions.find((action) => action.id === "set-vercel-production-env");
    expect(setVercelEnv.commands).toEqual([
      "vercel env add AAIS_DATABASE_URL production",
      "vercel env add AAIS_OIDC_ISSUER production",
      "vercel env add AAIS_OIDC_CLIENT_ID production",
      "vercel env add AAIS_OIDC_CLIENT_SECRET production",
      "vercel env add AAIS_OIDC_REDIRECT_URI production",
    ]);
    const fillRestoreTemplate = report.externalActions.find((action) => action.id === "fill-postgres-restore-template");
    expect(fillRestoreTemplate.commands).toEqual([
      "npm run verify:postgres-restore -- --env-file .env.postgres-restore.local --database-provider neon --output output/aais-postgres-restore-report-latest.json --release-id aais-2026-06-30-rc-live-ai-deepseek-v4-flash",
    ]);
    expect(report.externalActions.find((action) => action.id === "run-neon-restore-rehearsal").command)
      .toContain("npm run verify:postgres-restore");
    const inspectProductionDeploy = report.externalActions.find(
      (action) => action.id === "inspect-vercel-production-deployment",
    );
    expect(inspectProductionDeploy).toMatchObject({
      status: "required-after-production-deploy",
      command: "npm run verify:vercel-deployment -- --deployment-url <deployment-url> --release-id aais-2026-06-30-rc-live-ai-deepseek-v4-flash --deployment-git-commit <git-sha> --output output/aais-vercel-deployment-report-latest.json",
    });
    expect(inspectProductionDeploy.note).toContain("vercel deploy --prod -y --no-wait");
    expect(inspectProductionDeploy.note).toContain("AAIS_DEPLOYMENT_GIT_COMMIT_SHA");
    expect(inspectProductionDeploy.note).toContain("READY");
    const callbackSmoke = report.externalActions.find((action) => action.id === "run-real-oidc-callback-smoke");
    expect(callbackSmoke.command).toContain(
      "AAIS_VERIFY_OIDC_CALLBACK_URL=<REQUIRED:TRANSIENT_OIDC_CALLBACK_URL>",
    );
    expect(callbackSmoke.command).toContain(
      "AAIS_VERIFY_OIDC_STATE_COOKIE=<REQUIRED:TRANSIENT_OIDC_STATE_COOKIE>",
    );
    const cohortSmoke = report.externalActions.find((action) => action.id === "run-teacher-cohort-analytics-smoke");
    expect(cohortSmoke.command).toContain(
      "AAIS_VERIFY_OIDC_CALLBACK_URL=<REQUIRED:TRANSIENT_TEACHER_OR_ADMIN_OIDC_CALLBACK_URL>",
    );
    expect(cohortSmoke.command).toContain(
      "AAIS_VERIFY_OIDC_STATE_COOKIE=<REQUIRED:TRANSIENT_TEACHER_OR_ADMIN_OIDC_STATE_COOKIE>",
    );
    expect(cohortSmoke.command).toContain("AAIS_VERIFY_REQUIRE_COHORT_ANALYTICS=true");
    expect(cohortSmoke.command).toContain("npm run verify:enterprise");
    expect(cohortSmoke.command).not.toContain("AAIS_VERIFY_EDUCATOR_CORRECT_PASSWORD");
    expect(cohortSmoke.note).toContain("cohort export JSON");
    const finalGate = report.externalActions.find((action) => action.id === "rerun-final-gate");
    expect(finalGate.command).toContain("npm run verify:enterprise-release");
    expect(finalGate.command).toContain("--deployment-git-commit <git-sha>");
    expect(finalGate.command).toContain(
      "--source-provenance-report output/aais-source-provenance-latest.json",
    );
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(report);
    const markdown = await readFile(markdownOutputPath, "utf8");
    expect(markdown).toContain("AAIS Enterprise Handoff");
    expect(markdown).toContain("cohort export JSON");
    expect(markdown).toContain(privateEnvTemplatePath);
    expect(markdown).toContain(".env.production.local");
    expect(markdown).toContain(postgresRestoreTemplatePath);
    expect(markdown).toContain(".env.postgres-restore.local");
    expect(markdown).toContain("<REQUIRED:TRANSIENT_OIDC_CALLBACK_URL>");
    expect(markdown).toContain("npm run verify:oidc-config");
    expect(markdown).toContain("AAIS_DATABASE_URL");
    expect(markdown).toContain("npm run verify:enterprise-release");
    const serialized = `${JSON.stringify(report)}\n${markdown}`;
    expect(serialized).not.toContain("postgres://user:secret@host/db");
    expect(serialized).not.toContain("oidc-client-secret-value");
    expect(serialized).not.toContain("do-not-emit");
  });

  it("uses environment output paths when explicit output paths are omitted", async () => {
    const releaseCheckReportPath = await writeJson("release-check.json", {
      status: "passed",
      checkedAt: "2026-06-30T08:00:00.000Z",
      artifacts: {
        vercelEnv: {
          missing: [],
        },
        postgresRestore: {
          status: "passed",
        },
      },
    });
    process.env.AAIS_ENTERPRISE_HANDOFF_REPORT_PATH = path.join(tempDir, "env-handoff.json");
    process.env.AAIS_ENTERPRISE_HANDOFF_MARKDOWN_PATH = path.join(tempDir, "env-handoff.md");
    const originalCwd = process.cwd();
    process.chdir(tempDir);
    try {
      await generateAaisEnterpriseHandoff({
        releaseCheckReportPath,
        vercelEnvReportPath: releaseCheckReportPath,
        provisionReportPath: releaseCheckReportPath,
        localCredentialFiles: [],
        now: new Date("2026-06-30T08:45:00.000Z"),
      });
    } finally {
      process.chdir(originalCwd);
    }

    expect(JSON.parse(await readFile(process.env.AAIS_ENTERPRISE_HANDOFF_REPORT_PATH, "utf8"))).toMatchObject({
      status: "ready",
      generatedAt: "2026-06-30T08:45:00.000Z",
    });
    const report = JSON.parse(await readFile(process.env.AAIS_ENTERPRISE_HANDOFF_REPORT_PATH, "utf8"));
    expect(report.externalActions.find((action) => action.id === "rerun-final-gate").command).toContain(
      "--base-url https://www.aais.site",
    );
    expect(await readFile(process.env.AAIS_ENTERPRISE_HANDOFF_MARKDOWN_PATH, "utf8")).toContain(
      "AAIS Enterprise Handoff",
    );
  });

  it("summarizes redacted enterprise smoke connectivity diagnostics", async () => {
    const releaseCheckReportPath = await writeJson("release-check.json", {
      status: "failed",
      checkedAt: "2026-06-30T08:00:00.000Z",
      artifacts: {
        vercelEnv: {
          missing: [],
        },
        postgresRestore: {
          status: "passed",
        },
      },
    });
    const enterpriseReportPath = await writeJson("enterprise.json", {
      status: "failed",
      checks: [
        {
          name: "readiness",
          status: "failed",
          details: {
            reason: "online check failed before redacted evidence could be collected",
            error: "omitted",
            errorCategory: "connect-timeout",
            rawMessage: "Connect Timeout Error with bearer secret",
          },
        },
        {
          name: "lrs-health",
          status: "failed",
          details: {
            errorCategory: "connect-timeout",
          },
        },
        {
          name: "oidc-callback",
          status: "skipped",
        },
      ],
      rawCookie: "aais_session=session-secret-cookie",
    });
    const outputPath = path.join(tempDir, "handoff.json");
    const markdownOutputPath = path.join(tempDir, "handoff.md");

    const report = await generateAaisEnterpriseHandoff({
      releaseCheckReportPath,
      vercelEnvReportPath: releaseCheckReportPath,
      provisionReportPath: releaseCheckReportPath,
      enterpriseReportPath,
      localCredentialFiles: [],
      outputPath,
      markdownOutputPath,
      now: new Date("2026-06-30T09:00:00.000Z"),
    });

    expect(report.enterpriseDiagnostics).toEqual({
      status: "failed",
      onlineFailureCategories: ["connect-timeout"],
      failedOnlineChecks: [
        {
          name: "readiness",
          errorCategory: "connect-timeout",
        },
        {
          name: "lrs-health",
          errorCategory: "connect-timeout",
        },
      ],
      rawErrors: "omitted",
    });
    const markdown = await readFile(markdownOutputPath, "utf8");
    expect(markdown).toContain("connect-timeout");
    const serialized = `${JSON.stringify(report)}\n${markdown}`;
    expect(serialized).not.toContain("bearer secret");
    expect(serialized).not.toContain("Connect Timeout Error");
    expect(serialized).not.toContain("session-secret-cookie");
  });

  it("adds a runtime SSO-only action when final smoke still sees trial login enabled", async () => {
    const releaseCheckReportPath = await writeJson("release-check.json", {
      status: "failed",
      checkedAt: "2026-06-30T08:00:00.000Z",
      artifacts: {
        vercelEnv: {
          missing: [],
        },
        enterprise: {
          requiredChecks: {
            legalPages: true,
            cohortAnalytics: true,
            ssoOnlyMode: false,
          },
        },
        postgresRestore: {
          status: "passed",
        },
      },
    });
    const outputPath = path.join(tempDir, "handoff.json");
    const markdownOutputPath = path.join(tempDir, "handoff.md");

    const report = await generateAaisEnterpriseHandoff({
      releaseCheckReportPath,
      vercelEnvReportPath: releaseCheckReportPath,
      provisionReportPath: releaseCheckReportPath,
      localCredentialFiles: [],
      outputPath,
      markdownOutputPath,
      now: new Date("2026-06-30T09:15:00.000Z"),
    });

    expect(report.externalActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "set-sso-only-runtime-mode",
          status: "required-after-sso-verification",
          command: "vercel env add AAIS_TRIAL_LOGIN_ENABLED production",
          requiredValue: "false",
        }),
      ]),
    );
    const markdown = await readFile(markdownOutputPath, "utf8");
    expect(markdown).toContain("set-sso-only-runtime-mode");
    expect(markdown).toContain("AAIS_TRIAL_LOGIN_ENABLED");
    expect(JSON.stringify(report)).not.toContain('"requiredValue":"true"');
  });

  it("orders SSO-only runtime changes after real OIDC callback smoke", async () => {
    const releaseCheckReportPath = await writeJson("release-check.json", {
      status: "failed",
      checkedAt: "2026-06-30T08:00:00.000Z",
      artifacts: {
        vercelEnv: {
          missing: [
            "AAIS_DATABASE_URL",
            "AAIS_OIDC_ISSUER",
            "AAIS_OIDC_CLIENT_ID",
            "AAIS_OIDC_CLIENT_SECRET",
            "AAIS_OIDC_REDIRECT_URI",
          ],
        },
        enterprise: {
          requiredChecks: {
            legalPages: true,
            cohortAnalytics: true,
            ssoOnlyMode: false,
          },
        },
        postgresRestore: {
          status: "passed",
        },
      },
    });

    const report = await generateAaisEnterpriseHandoff({
      releaseCheckReportPath,
      vercelEnvReportPath: releaseCheckReportPath,
      provisionReportPath: releaseCheckReportPath,
      localCredentialFiles: [],
      outputPath: path.join(tempDir, "handoff.json"),
      markdownOutputPath: path.join(tempDir, "handoff.md"),
      now: new Date("2026-06-30T09:18:00.000Z"),
    });

    expect(report.externalActions.map((action) => action.id)).toEqual([
      "fill-private-env-template",
      "verify-oidc-config-dry-run",
      "set-vercel-production-env",
      "redeploy-vercel-production",
      "inspect-vercel-production-deployment",
      "run-real-oidc-callback-smoke",
      "set-sso-only-runtime-mode",
      "redeploy-vercel-production-after-sso-only",
      "inspect-vercel-production-deployment-after-sso-only",
      "rerun-final-gate",
    ]);
  });

  it("orders the production redeploy after Vercel environment changes when SSO-only does not need another deploy", async () => {
    const releaseCheckReportPath = await writeJson("release-check.json", {
      status: "failed",
      checkedAt: "2026-06-30T08:00:00.000Z",
      artifacts: {
        vercelEnv: {
          missing: [
            "AAIS_DATABASE_URL",
            "AAIS_OIDC_ISSUER",
            "AAIS_OIDC_CLIENT_ID",
            "AAIS_OIDC_CLIENT_SECRET",
            "AAIS_OIDC_REDIRECT_URI",
          ],
        },
        enterprise: {
          requiredChecks: {
            legalPages: true,
            cohortAnalytics: true,
            oidcCallback: true,
            ssoOnlyMode: true,
          },
        },
        postgresRestore: {
          status: "passed",
        },
      },
    });

    const report = await generateAaisEnterpriseHandoff({
      releaseCheckReportPath,
      vercelEnvReportPath: releaseCheckReportPath,
      provisionReportPath: releaseCheckReportPath,
      localCredentialFiles: [],
      outputPath: path.join(tempDir, "handoff.json"),
      markdownOutputPath: path.join(tempDir, "handoff.md"),
      now: new Date("2026-06-30T09:18:00.000Z"),
    });

    expect(report.externalActions.map((action) => action.id)).toEqual([
      "fill-private-env-template",
      "verify-oidc-config-dry-run",
      "set-vercel-production-env",
      "redeploy-vercel-production",
      "inspect-vercel-production-deployment",
      "run-real-oidc-callback-smoke",
      "rerun-final-gate",
    ]);
  });

  it("requires real OIDC callback smoke when callback evidence is missing even if OIDC env names are present", async () => {
    const releaseCheckReportPath = await writeJson("release-check.json", {
      status: "failed",
      checkedAt: "2026-06-30T08:00:00.000Z",
      artifacts: {
        vercelEnv: {
          missing: [],
        },
        enterprise: {
          requiredChecks: {
            legalPages: true,
            oidcStart: true,
            oidcCallback: false,
            ssoOnlyMode: true,
          },
        },
        postgresRestore: {
          status: "passed",
        },
      },
    });
    const outputPath = path.join(tempDir, "handoff.json");
    const markdownOutputPath = path.join(tempDir, "handoff.md");

    const report = await generateAaisEnterpriseHandoff({
      releaseCheckReportPath,
      vercelEnvReportPath: releaseCheckReportPath,
      provisionReportPath: releaseCheckReportPath,
      localCredentialFiles: [],
      outputPath,
      markdownOutputPath,
      now: new Date("2026-06-30T09:20:00.000Z"),
    });

    expect(report.missing.realOidcCallbackSmoke).toBe(true);
    expect(report.externalActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "run-real-oidc-callback-smoke",
          status: "required",
        }),
      ]),
    );
    expect(report.externalActions.find((action) => action.id === "run-real-oidc-callback-smoke").command).toContain(
      "AAIS_VERIFY_OIDC_CALLBACK_URL=<REQUIRED:TRANSIENT_OIDC_CALLBACK_URL>",
    );
    expect(await readFile(markdownOutputPath, "utf8")).toContain("run-real-oidc-callback-smoke");
  });

  it("requires fresh transient OIDC callback evidence on the final gate rerun", async () => {
    const releaseCheckReportPath = await writeJson("release-check.json", {
      status: "failed",
      checkedAt: "2026-06-30T08:00:00.000Z",
      artifacts: {
        vercelEnv: {
          missing: [],
        },
        enterprise: {
          requiredChecks: {
            legalPages: true,
            oidcCallback: false,
            cohortAnalytics: true,
            ssoOnlyMode: true,
          },
        },
        postgresRestore: {
          status: "passed",
        },
      },
    });

    const report = await generateAaisEnterpriseHandoff({
      releaseCheckReportPath,
      vercelEnvReportPath: releaseCheckReportPath,
      provisionReportPath: releaseCheckReportPath,
      localCredentialFiles: [],
      outputPath: path.join(tempDir, "handoff.json"),
      markdownOutputPath: path.join(tempDir, "handoff.md"),
      now: new Date("2026-06-30T09:25:00.000Z"),
    });

    const finalGate = report.externalActions.find((action) => action.id === "rerun-final-gate");
    expect(finalGate.command).toContain("AAIS_VERIFY_OIDC_CALLBACK_URL=<REQUIRED:TRANSIENT_OIDC_CALLBACK_URL>");
    expect(finalGate.command).toContain("AAIS_VERIFY_OIDC_STATE_COOKIE=<REQUIRED:TRANSIENT_OIDC_STATE_COOKIE>");
    expect(finalGate.command).toContain("npm run verify:enterprise-release");
    expect(finalGate.command).toContain("--deployment-git-commit <git-sha>");
    expect(finalGate.command).toContain("--source-provenance-report output/aais-source-provenance-latest.json");
  });

  it("requires teacher/admin OIDC callback evidence when only cohort analytics smoke is missing", async () => {
    const releaseCheckReportPath = await writeJson("release-check.json", {
      status: "failed",
      checkedAt: "2026-06-30T08:00:00.000Z",
      artifacts: {
        vercelEnv: {
          missing: [],
        },
        enterprise: {
          requiredChecks: {
            legalPages: true,
            oidcCallback: true,
            cohortAnalytics: false,
            ssoOnlyMode: true,
          },
        },
        postgresRestore: {
          status: "passed",
        },
      },
    });

    const report = await generateAaisEnterpriseHandoff({
      releaseCheckReportPath,
      vercelEnvReportPath: releaseCheckReportPath,
      provisionReportPath: releaseCheckReportPath,
      localCredentialFiles: [],
      outputPath: path.join(tempDir, "handoff.json"),
      markdownOutputPath: path.join(tempDir, "handoff.md"),
      now: new Date("2026-06-30T09:25:00.000Z"),
    });

    const cohortSmoke = report.externalActions.find((action) => action.id === "run-teacher-cohort-analytics-smoke");
    const finalGate = report.externalActions.find((action) => action.id === "rerun-final-gate");
    expect(cohortSmoke.command).toContain(
      "AAIS_VERIFY_OIDC_CALLBACK_URL=<REQUIRED:TRANSIENT_TEACHER_OR_ADMIN_OIDC_CALLBACK_URL>",
    );
    expect(cohortSmoke.note).toContain("without raw learner text");
    expect(finalGate.command).toContain(
      "AAIS_VERIFY_OIDC_CALLBACK_URL=<REQUIRED:TRANSIENT_TEACHER_OR_ADMIN_OIDC_CALLBACK_URL>",
    );
    expect(finalGate.command).toContain("AAIS_VERIFY_REQUIRE_COHORT_ANALYTICS=true");
    expect(finalGate.command).not.toContain("AAIS_VERIFY_EDUCATOR_CORRECT_PASSWORD");
  });

  it("reads variable names from DOCX XML without leaking adjacent values", async () => {
    const releaseCheckReportPath = await writeJson("release-check.json", {
      status: "failed",
      checkedAt: "2026-06-30T08:00:00.000Z",
      artifacts: {
        vercelEnv: {
          missing: [
            "AAIS_DATABASE_URL",
            "AAIS_OIDC_ISSUER",
            "AAIS_OIDC_CLIENT_ID",
            "AAIS_OIDC_CLIENT_SECRET",
            "AAIS_OIDC_REDIRECT_URI",
          ],
        },
        postgresRestore: {
          status: "passed",
        },
      },
    });
    const docxPath = path.join(tempDir, "All API Keys.docx");
    await mkdir(path.join(tempDir, "word"), { recursive: true });
    await writeFile(
      path.join(tempDir, "word", "document.xml"),
      "<w:document><w:t>AAIS_DATABASE_URL=postgres-secret-placeholder AAIS_OIDC_ISSUER=https://idp.example.test</w:t></w:document>",
      "utf8",
    );
    await execFileAsync("zip", ["-qr", docxPath, "word"], { cwd: tempDir });

    const report = await generateAaisEnterpriseHandoff({
      releaseCheckReportPath,
      vercelEnvReportPath: releaseCheckReportPath,
      provisionReportPath: releaseCheckReportPath,
      localCredentialFiles: [docxPath],
      outputPath: path.join(tempDir, "handoff.json"),
      markdownOutputPath: path.join(tempDir, "handoff.md"),
      now: new Date("2026-06-30T09:00:00.000Z"),
    });

    expect(report.localCredentialInventory.files).toEqual([
      {
        path: docxPath,
        exists: true,
        presentNames: ["AAIS_DATABASE_URL", "AAIS_OIDC_ISSUER"],
      },
    ]);
    expect(report.localCredentialInventory.storageUsable).toBe(true);
    expect(report.localCredentialInventory.oidcUsable).toBe(false);
    expect(report.localCredentialInventory.oidcRoleMappingUsable).toBe(true);
    expect(report.localCredentialInventory.releaseUsable).toBe(true);
    expect(report.localCredentialInventory.missingNames).toEqual([
      "AAIS_OIDC_CLIENT_ID",
      "AAIS_OIDC_CLIENT_SECRET",
      "AAIS_OIDC_REDIRECT_URI",
    ]);
    expect(JSON.stringify(report)).not.toContain("postgres-secret-placeholder");
    expect(JSON.stringify(report)).not.toContain("https://idp.example.test");
  });

  it("does not ask for local database credentials after Vercel Neon storage is already present", async () => {
    const releaseCheckReportPath = await writeJson("release-check.json", {
      schemaVersion: 1,
      status: "failed",
      checkedAt: "2026-06-30T08:00:00.000Z",
      artifacts: {
        vercelEnv: {
          status: "failed",
          missing: [
            "AAIS_OIDC_ISSUER",
            "AAIS_OIDC_CLIENT_ID",
            "AAIS_OIDC_CLIENT_SECRET",
            "AAIS_OIDC_REDIRECT_URI",
          ],
        },
        enterprise: {
          requiredChecks: {
            legalPages: true,
            ssoOnlyMode: false,
            oidcCallback: false,
          },
        },
        postgresRestore: {
          status: "missing",
        },
      },
    });
    const vercelEnvReportPath = await writeJson("vercel-env.json", {
      status: "failed",
      required: {
        missing: [
          "AAIS_OIDC_ISSUER",
          "AAIS_OIDC_CLIENT_ID",
          "AAIS_OIDC_CLIENT_SECRET",
          "AAIS_OIDC_REDIRECT_URI",
        ],
      },
      storageUrl: {
        present: true,
        sourceEnv: "DATABASE_URL",
      },
    });

    const report = await generateAaisEnterpriseHandoff({
      releaseCheckReportPath,
      vercelEnvReportPath,
      provisionReportPath: vercelEnvReportPath,
      localCredentialFiles: [],
      outputPath: path.join(tempDir, "handoff.json"),
      markdownOutputPath: path.join(tempDir, "handoff.md"),
      now: new Date("2026-06-30T10:00:00.000Z"),
    });

    expect(report.missing.storage).toEqual([]);
    expect(report.localCredentialInventory.storageUsable).toBe(true);
    expect(report.localCredentialInventory.oidcRoleMappingUsable).toBe(true);
    expect(report.localCredentialInventory.releaseUsable).toBe(true);
    expect(report.localCredentialInventory.missingNames).toEqual([
      "AAIS_OIDC_ISSUER",
      "AAIS_OIDC_CLIENT_ID",
      "AAIS_OIDC_CLIENT_SECRET",
      "AAIS_OIDC_REDIRECT_URI",
    ]);
  });

  it("accepts alternate local OIDC role mapping names when Vercel requests the canonical teacher-group slot", async () => {
    const releaseCheckReportPath = await writeJson("release-check.json", {
      status: "failed",
      checkedAt: "2026-06-30T08:00:00.000Z",
      artifacts: {
        vercelEnv: {
          missing: ["AAIS_OIDC_TEACHER_GROUPS"],
        },
        enterprise: {
          requiredChecks: {
            legalPages: true,
            oidcCallback: true,
            cohortAnalytics: false,
            ssoOnlyMode: true,
          },
        },
        postgresRestore: {
          status: "passed",
        },
      },
    });
    const envPath = path.join(tempDir, ".env.production.local");
    await writeFile(envPath, "AAIS_OIDC_ADMIN_EMAILS=admin@example.edu\n", "utf8");

    const report = await generateAaisEnterpriseHandoff({
      releaseCheckReportPath,
      vercelEnvReportPath: releaseCheckReportPath,
      provisionReportPath: releaseCheckReportPath,
      localCredentialFiles: [envPath],
      outputPath: path.join(tempDir, "handoff.json"),
      markdownOutputPath: path.join(tempDir, "handoff.md"),
      now: new Date("2026-06-30T10:10:00.000Z"),
    });

    expect(report.missing).toMatchObject({
      oidc: [],
      oidcRoleMapping: ["AAIS_OIDC_TEACHER_GROUPS"],
    });
    expect(report.localCredentialInventory).toMatchObject({
      values: "not-read",
      oidcUsable: true,
      oidcRoleMappingUsable: true,
      missingNames: [],
      files: [
        {
          path: envPath,
          exists: true,
          presentNames: ["AAIS_OIDC_ADMIN_EMAILS"],
        },
      ],
    });
    expect(report.externalActions.map((action) => action.id)).toEqual([
      "fill-private-env-template",
      "verify-oidc-config-dry-run",
      "set-vercel-production-env",
      "redeploy-vercel-production",
      "inspect-vercel-production-deployment",
      "run-teacher-cohort-analytics-smoke",
      "rerun-final-gate",
    ]);
    expect(JSON.stringify(report)).not.toContain("admin@example.edu");
  });

  it("requires a production redeploy when live evidence lacks the current artifact coalescing policy", async () => {
    const releaseCheckReportPath = await writeJson("release-check.json", {
      schemaVersion: 1,
      status: "failed",
      checkedAt: "2026-06-30T10:30:00.000Z",
      artifacts: {
        vercelEnv: {
          status: "passed",
          missing: [],
        },
        enterprise: {
          requiredChecks: {
            legalPages: true,
            readiness: true,
            lrsHealth: false,
            oidcCallback: true,
            cohortAnalytics: true,
            ssoOnlyMode: true,
          },
          artifactCoalescing: {
            readiness: false,
            lrsHealth: false,
            complete: false,
          },
          readiness: {
            releaseIdMatchesExpected: true,
          },
        },
        postgresRestore: {
          status: "passed",
        },
        vercelDeployment: {
          status: "passed",
        },
        vercelConfig: {
          status: "passed",
        },
      },
    });

    const report = await generateAaisEnterpriseHandoff({
      releaseCheckReportPath,
      vercelEnvReportPath: releaseCheckReportPath,
      provisionReportPath: releaseCheckReportPath,
      localCredentialFiles: [],
      outputPath: path.join(tempDir, "handoff.json"),
      markdownOutputPath: path.join(tempDir, "handoff.md"),
      now: new Date("2026-06-30T10:35:00.000Z"),
    });

    expect(report.missing.currentCodeDeploy).toBe(true);
    expect(report.externalActions.map((action) => action.id)).toEqual([
      "redeploy-vercel-production",
      "inspect-vercel-production-deployment",
      "rerun-final-gate",
    ]);
    expect(report.externalActions.find((action) => action.id === "redeploy-vercel-production")).toMatchObject({
      status: "required-after-code-change",
      command: "vercel deploy --prod -y --no-wait",
      reason: "current production evidence is missing code-level release checks: artifact-coalescing",
    });
    expect(await readFile(path.join(tempDir, "handoff.md"), "utf8")).toContain("required-after-code-change");
  });

  it("requires a production redeploy when live evidence lacks legal-page checks", async () => {
    const releaseCheckReportPath = await writeJson("release-check.json", {
      schemaVersion: 1,
      status: "failed",
      checkedAt: "2026-06-30T10:45:00.000Z",
      artifacts: {
        vercelEnv: {
          status: "passed",
          missing: [],
        },
        enterprise: {
          requiredChecks: {
            legalPages: false,
            readiness: true,
            lrsHealth: true,
            oidcCallback: true,
            cohortAnalytics: true,
            ssoOnlyMode: true,
          },
          artifactCoalescing: {
            readiness: true,
            lrsHealth: true,
            complete: true,
          },
          readiness: {
            releaseIdMatchesExpected: true,
          },
        },
        postgresRestore: {
          status: "passed",
        },
        vercelDeployment: {
          status: "passed",
        },
        vercelConfig: {
          status: "passed",
        },
      },
    });

    const report = await generateAaisEnterpriseHandoff({
      releaseCheckReportPath,
      vercelEnvReportPath: releaseCheckReportPath,
      provisionReportPath: releaseCheckReportPath,
      localCredentialFiles: [],
      outputPath: path.join(tempDir, "handoff.json"),
      markdownOutputPath: path.join(tempDir, "handoff.md"),
      now: new Date("2026-06-30T10:50:00.000Z"),
    });

    expect(report.missing.currentCodeDeploy).toBe(true);
    expect(report.externalActions.map((action) => action.id)).toEqual([
      "redeploy-vercel-production",
      "inspect-vercel-production-deployment",
      "rerun-final-gate",
    ]);
    expect(report.externalActions.find((action) => action.id === "redeploy-vercel-production")).toMatchObject({
      status: "required-after-code-change",
      command: "vercel deploy --prod -y --no-wait",
      reason: "current production evidence is missing code-level release checks: legal-pages",
    });
  });

  it("requires a production redeploy when scheduled outbox drain evidence is missing", async () => {
    const releaseCheckReportPath = await writeJson("release-check.json", {
      schemaVersion: 1,
      status: "failed",
      checkedAt: "2026-06-30T10:55:00.000Z",
      artifacts: {
        vercelEnv: {
          status: "passed",
          missing: [],
        },
        enterprise: {
          requiredChecks: {
            legalPages: true,
            readiness: true,
            lrsHealth: true,
            oidcCallback: true,
            cohortAnalytics: true,
            ssoOnlyMode: true,
          },
          artifactCoalescing: {
            readiness: true,
            lrsHealth: true,
            complete: true,
          },
          readiness: {
            releaseIdMatchesExpected: true,
          },
        },
        postgresRestore: {
          status: "passed",
        },
        vercelDeployment: {
          status: "passed",
        },
        vercelConfig: {
          status: "failed",
        },
      },
    });

    const report = await generateAaisEnterpriseHandoff({
      releaseCheckReportPath,
      vercelEnvReportPath: releaseCheckReportPath,
      provisionReportPath: releaseCheckReportPath,
      localCredentialFiles: [],
      outputPath: path.join(tempDir, "handoff.json"),
      markdownOutputPath: path.join(tempDir, "handoff.md"),
      now: new Date("2026-06-30T11:00:00.000Z"),
    });

    expect(report.missing.currentCodeDeploy).toBe(true);
    expect(report.externalActions.map((action) => action.id)).toEqual([
      "redeploy-vercel-production",
      "inspect-vercel-production-deployment",
      "rerun-final-gate",
    ]);
    expect(report.externalActions.find((action) => action.id === "redeploy-vercel-production")).toMatchObject({
      status: "required-after-code-change",
      command: "vercel deploy --prod -y --no-wait",
      reason: "current production evidence is missing code-level release checks: scheduled-outbox-drain",
    });
  });

  it("requires a production redeploy when deployed release identity does not match the expected release", async () => {
    const releaseCheckReportPath = await writeJson("release-check.json", {
      schemaVersion: 1,
      status: "failed",
      checkedAt: "2026-06-30T11:05:00.000Z",
      artifacts: {
        vercelEnv: {
          status: "passed",
          missing: [],
        },
        enterprise: {
          requiredChecks: {
            legalPages: true,
            readiness: false,
            lrsHealth: true,
            oidcCallback: true,
            cohortAnalytics: true,
            ssoOnlyMode: true,
          },
          artifactCoalescing: {
            readiness: true,
            lrsHealth: true,
            complete: true,
          },
          readiness: {
            releaseIdMatchesExpected: false,
          },
        },
        postgresRestore: {
          status: "passed",
        },
        vercelDeployment: {
          status: "passed",
        },
        vercelConfig: {
          status: "passed",
        },
      },
    });

    const report = await generateAaisEnterpriseHandoff({
      releaseCheckReportPath,
      vercelEnvReportPath: releaseCheckReportPath,
      provisionReportPath: releaseCheckReportPath,
      localCredentialFiles: [],
      outputPath: path.join(tempDir, "handoff.json"),
      markdownOutputPath: path.join(tempDir, "handoff.md"),
      now: new Date("2026-06-30T11:10:00.000Z"),
    });

    expect(report.missing.currentCodeDeploy).toBe(true);
    expect(report.missing.currentCodeDeployReasons).toEqual(["release-identity"]);
    expect(report.externalActions.map((action) => action.id)).toEqual([
      "redeploy-vercel-production",
      "inspect-vercel-production-deployment",
      "rerun-final-gate",
    ]);
    expect(report.externalActions.find((action) => action.id === "redeploy-vercel-production")).toMatchObject({
      status: "required-after-code-change",
      command: "vercel deploy --prod -y --no-wait",
      reason: "current production evidence is missing code-level release checks: release-identity",
    });
  });

  it("explains when the Vercel deployment is ready but lacks git commit traceability", async () => {
    const releaseCheckReportPath = await writeJson("release-check.json", {
      schemaVersion: 1,
      status: "failed",
      checkedAt: "2026-06-30T11:15:00.000Z",
      artifacts: {
        vercelEnv: {
          status: "passed",
          missing: [],
        },
        enterprise: {
          requiredChecks: {
            legalPages: true,
            readiness: true,
            lrsHealth: true,
            oidcCallback: true,
            cohortAnalytics: true,
            ssoOnlyMode: true,
          },
          artifactCoalescing: {
            readiness: true,
            lrsHealth: true,
            complete: true,
          },
          readiness: {
            releaseIdMatchesExpected: true,
          },
        },
        postgresRestore: {
          status: "passed",
        },
        vercelDeployment: {
          status: "failed",
          readyState: "READY",
          target: "production",
          urlMatchesExpected: true,
          targetMatchesProduction: true,
          gitCommitShortSha: null,
        },
        vercelConfig: {
          status: "passed",
        },
      },
    });

    const report = await generateAaisEnterpriseHandoff({
      releaseCheckReportPath,
      vercelEnvReportPath: releaseCheckReportPath,
      provisionReportPath: releaseCheckReportPath,
      localCredentialFiles: [],
      outputPath: path.join(tempDir, "handoff.json"),
      markdownOutputPath: path.join(tempDir, "handoff.md"),
      now: new Date("2026-06-30T11:20:00.000Z"),
    });

    expect(report.missing.currentCodeDeploy).toBe(true);
    expect(report.missing.currentCodeDeployReasons).toEqual(["vercel-deployment-git-commit"]);
    expect(report.externalActions.map((action) => action.id)).toEqual([
      "redeploy-vercel-production",
      "inspect-vercel-production-deployment",
      "rerun-final-gate",
    ]);
    expect(report.externalActions.find((action) => action.id === "redeploy-vercel-production")).toMatchObject({
      status: "required-after-code-change",
      reason: "current production evidence is missing code-level release checks: vercel-deployment-git-commit",
    });
  });

  it("checks the production owner env file in the default local credential inventory", async () => {
    const releaseCheckReportPath = await writeJson("release-check.json", {
      status: "failed",
      checkedAt: "2026-06-30T08:00:00.000Z",
      artifacts: {
        vercelEnv: {
          missing: ["AAIS_DATABASE_URL", "AAIS_OIDC_ISSUER"],
        },
        postgresRestore: {
          status: "passed",
        },
      },
    });
    await writeFile(
      path.join(tempDir, ".env.production.local"),
      [
        "AAIS_DATABASE_URL=postgres://user:secret@example.neon.tech/aais",
        "AAIS_OIDC_ISSUER=https://issuer.example.test",
        "",
      ].join("\n"),
      "utf8",
    );
    const originalCwd = process.cwd();
    process.chdir(tempDir);
    try {
      const report = await generateAaisEnterpriseHandoff({
        releaseCheckReportPath,
        vercelEnvReportPath: releaseCheckReportPath,
        provisionReportPath: releaseCheckReportPath,
        outputPath: path.join(tempDir, "handoff.json"),
        markdownOutputPath: path.join(tempDir, "handoff.md"),
        now: new Date("2026-06-30T09:30:00.000Z"),
      });

      expect(report.localCredentialInventory.files[0]).toEqual({
        path: ".env.production.local",
        exists: true,
        presentNames: ["AAIS_DATABASE_URL", "AAIS_OIDC_ISSUER"],
      });
      expect(report.localCredentialInventory.storageUsable).toBe(true);
      expect(JSON.stringify(report)).not.toContain("postgres://user:secret@example.neon.tech/aais");
      expect(JSON.stringify(report)).not.toContain("https://issuer.example.test");
    } finally {
      process.chdir(originalCwd);
    }
  });
});

async function writeJson(name, value) {
  const filePath = path.join(tempDir, name);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}
