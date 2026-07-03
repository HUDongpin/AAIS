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
        aiEval: passingAiEvalSummary(),
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
          "POSTGRES_PRISMA_URL",
          "POSTGRES_URL_NO_SSL",
          "DATABASE_URL_UNPOOLED",
          "POSTGRES_URL_NON_POOLING",
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
      releaseId: "aais-2026-06-30-rc-live-ai-deepseek-v4-pro",
      aiEvalManifestPath: "output/aais-ai-eval-deepseek-v4-pro.json",
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
      storage: {
        status: "action-required",
        sourceEnv: null,
        action: "set-vercel-production-env",
        redaction: {
          values: "not-read",
        },
      },
      oidc: {
        status: "action-required",
        callbackUrl: "https://aais-six.vercel.app/api/auth/oidc/callback",
        requiredNames: [
          "AAIS_OIDC_ISSUER",
          "AAIS_OIDC_CLIENT_ID",
          "AAIS_OIDC_CLIENT_SECRET",
          "AAIS_OIDC_REDIRECT_URI",
        ],
        missingRequiredNames: [
          "AAIS_OIDC_ISSUER",
          "AAIS_OIDC_CLIENT_ID",
          "AAIS_OIDC_CLIENT_SECRET",
          "AAIS_OIDC_REDIRECT_URI",
        ],
        acceptedRoleMappingNames: [
          "AAIS_OIDC_TEACHER_GROUPS",
          "AAIS_OIDC_TEACHER_EMAILS",
          "AAIS_OIDC_ADMIN_GROUPS",
          "AAIS_OIDC_ADMIN_EMAILS",
        ],
        missingRoleMappingNames: [],
        optionalExplicitEndpointNames: [
          "AAIS_OIDC_AUTHORIZATION_ENDPOINT",
          "AAIS_OIDC_TOKEN_ENDPOINT",
          "AAIS_OIDC_JWKS_URI",
        ],
        explicitEndpointsRule: "all-or-none",
        transientEvidence: [
          "AAIS_VERIFY_OIDC_CALLBACK_URL",
          "AAIS_VERIFY_OIDC_STATE_COOKIE",
          "AAIS_VERIFY_EXPECTED_SESSION_ROLE",
        ],
        redaction: {
          values: "not-read",
          transientEvidence: "not-stored",
        },
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
    expect(report.businessGapSummary).toEqual({
      total: 7,
      passed: 2,
      actionRequired: 5,
    });
    expect(report.businessGapActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "production-oidc-env-config",
          status: "action-required",
          missing: [
            "AAIS_OIDC_ISSUER",
            "AAIS_OIDC_CLIENT_ID",
            "AAIS_OIDC_CLIENT_SECRET",
            "AAIS_OIDC_REDIRECT_URI",
          ],
          actions: [
            "fill-private-env-template",
            "verify-oidc-config-dry-run",
            "set-vercel-production-env",
            "redeploy-vercel-production",
            "inspect-vercel-production-deployment",
            "rerun-final-gate",
          ],
        }),
        expect.objectContaining({
          id: "neon-restore-rehearsal",
          status: "action-required",
          actions: ["fill-postgres-restore-template", "run-neon-restore-rehearsal", "rerun-final-gate"],
        }),
        expect.objectContaining({
          id: "sso-only-cutover",
          status: "passed",
        }),
        expect.objectContaining({
          id: "current-release-consistency",
          status: "action-required",
          reasons: [
            "release-identity",
            "vercel-deployment-git-commit",
            "scheduled-outbox-drain",
          ],
        }),
      ]),
    );
    expect(report.externalActions[0].oidcOnboardingCommand).toBe(
      "npm run prepare:oidc-sso -- --env-file .env.production.local --base-url https://aais-six.vercel.app --output output/aais-oidc-onboarding-report-latest.json --markdown-output output/aais-oidc-onboarding-report-latest.md --release-id aais-2026-06-30-rc-live-ai-deepseek-v4-pro",
    );
    expect(report.externalActions[0].note).toContain("IdP registration contract");
    expect(report.externalActions[0].commands).toEqual([
      `npm run provision:vercel-env -- --env-file .env.production.local --report ${vercelEnvReportPath} --release-id aais-2026-06-30-rc-live-ai-deepseek-v4-pro --deployment-git-commit <git-sha> --output output/aais-vercel-env-provision-dry-run-latest.json`,
      `npm run provision:vercel-env -- --env-file .env.production.local --report ${vercelEnvReportPath} --release-id aais-2026-06-30-rc-live-ai-deepseek-v4-pro --deployment-git-commit <git-sha> --apply --output output/aais-vercel-env-provision-apply-latest.json`,
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
    expect(fillRestoreTemplate.neonApiPreparationCommand).toBe(
      "npm run prepare:neon-restore -- --neon-env-file .env.neon-restore.local --output-env .env.postgres-restore.local --report output/aais-neon-restore-env-report-latest.json --release-id aais-2026-06-30-rc-live-ai-deepseek-v4-pro",
    );
    expect(fillRestoreTemplate.note).toContain("without printing the connection URI");
    expect(fillRestoreTemplate.commands).toEqual([
      "npm run verify:postgres-restore -- --env-file .env.postgres-restore.local --source-env-file .env.production.local --database-provider neon --target-purpose restored-staging --output output/aais-postgres-restore-report-latest.json --release-id aais-2026-06-30-rc-live-ai-deepseek-v4-pro",
    ]);
    expect(report.externalActions.find((action) => action.id === "run-neon-restore-rehearsal").command)
      .toContain("npm run verify:postgres-restore");
    expect(report.externalActions.find((action) => action.id === "run-neon-restore-rehearsal").command)
      .toContain("--env-file .env.postgres-restore.local");
    expect(report.externalActions.find((action) => action.id === "run-neon-restore-rehearsal").command)
      .toContain("--source-env-file .env.production.local");
    expect(report.externalActions.find((action) => action.id === "run-neon-restore-rehearsal").command)
      .toContain("--target-purpose restored-staging");
    expect(report.externalActions.find((action) => action.id === "run-neon-restore-rehearsal").command)
      .not.toContain("--database-url");
    expect(report.externalActions.find((action) => action.id === "run-neon-restore-rehearsal").note)
      .toContain("Do not pass database URLs on the command line");
    expect(report.externalActions.find((action) => action.id === "run-neon-restore-rehearsal").note)
      .toContain("differs from production sources");
    expect(report.externalActions.find((action) => action.id === "run-neon-restore-rehearsal").gapEvidenceCommand)
      .toBe(
        "npm run verify:enterprise-gaps -- --mode restore --restore-env-file .env.postgres-restore.local --source-env-file .env.production.local --restore-output output/aais-postgres-restore-report-latest.json --output output/aais-enterprise-gap-evidence-latest.json --release-id aais-2026-06-30-rc-live-ai-deepseek-v4-pro",
      );
    expect(report.externalActions.find((action) => action.id === "run-neon-restore-rehearsal").gapPreflightCommand)
      .toBe(
        "npm run verify:enterprise-gaps -- --mode restore --preflight-only --restore-env-file .env.postgres-restore.local --source-env-file .env.production.local --restore-output output/aais-postgres-restore-report-latest.json --output output/aais-enterprise-gap-evidence-latest.json --release-id aais-2026-06-30-rc-live-ai-deepseek-v4-pro",
      );
    const inspectProductionDeploy = report.externalActions.find(
      (action) => action.id === "inspect-vercel-production-deployment",
    );
    expect(inspectProductionDeploy).toMatchObject({
      status: "required-after-production-deploy",
      command: "npm run verify:vercel-deployment -- --deployment-url <deployment-url> --release-id aais-2026-06-30-rc-live-ai-deepseek-v4-pro --deployment-git-commit <git-sha> --output output/aais-vercel-deployment-report-latest.json",
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
    expect(callbackSmoke.command).not.toContain("--require-sso-only");
    expect(callbackSmoke.note).toContain("before disabling trial login");
    expect(callbackSmoke.gapEvidenceCommand).toBe(
      "npm run verify:enterprise-gaps -- --mode oidc-callback --env-file .env.enterprise-smoke.local --base-url https://aais-six.vercel.app --enterprise-output output/aais-enterprise-report-latest.json --output output/aais-enterprise-gap-evidence-latest.json --release-id aais-2026-06-30-rc-live-ai-deepseek-v4-pro",
    );
    expect(callbackSmoke.gapPreflightCommand).toBe(
      "npm run verify:enterprise-gaps -- --mode oidc-callback --preflight-only --env-file .env.enterprise-smoke.local --base-url https://aais-six.vercel.app --enterprise-output output/aais-enterprise-report-latest.json --output output/aais-enterprise-gap-evidence-latest.json --release-id aais-2026-06-30-rc-live-ai-deepseek-v4-pro",
    );
    const cohortSmoke = report.externalActions.find((action) => action.id === "run-teacher-cohort-analytics-smoke");
    expect(cohortSmoke.command).toContain(
      "AAIS_VERIFY_OIDC_CALLBACK_URL=<REQUIRED:TRANSIENT_TEACHER_OR_ADMIN_OIDC_CALLBACK_URL>",
    );
    expect(cohortSmoke.gapEvidenceCommand).toBe(
      "npm run verify:enterprise-gaps -- --mode cohort-sso --env-file .env.enterprise-smoke.local --base-url https://aais-six.vercel.app --enterprise-output output/aais-enterprise-report-latest.json --output output/aais-enterprise-gap-evidence-latest.json --release-id aais-2026-06-30-rc-live-ai-deepseek-v4-pro",
    );
    expect(cohortSmoke.gapPreflightCommand).toBe(
      "npm run verify:enterprise-gaps -- --mode cohort-sso --preflight-only --env-file .env.enterprise-smoke.local --base-url https://aais-six.vercel.app --enterprise-output output/aais-enterprise-report-latest.json --output output/aais-enterprise-gap-evidence-latest.json --release-id aais-2026-06-30-rc-live-ai-deepseek-v4-pro",
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
    expect(markdown).toContain("Business Gap Action Plan");
    expect(markdown).toContain("production-oidc-env-config");
    expect(markdown).toContain("current-release-consistency");
    expect(markdown).toContain("Storage / Neon");
    expect(markdown).toContain("OIDC / SSO");
    expect(markdown).toContain("callback URL to register: https://aais-six.vercel.app/api/auth/oidc/callback");
    expect(markdown).toContain("accepted role mapping names: AAIS_OIDC_TEACHER_GROUPS, AAIS_OIDC_TEACHER_EMAILS, AAIS_OIDC_ADMIN_GROUPS, AAIS_OIDC_ADMIN_EMAILS");
    expect(markdown).toContain("cohort export JSON");
    expect(markdown).toContain("--preflight-only");
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
          target: {
            authMode: "sso-only",
          },
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
          target: {
            authMode: "sso-only",
          },
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
          target: {
            authMode: "sso-only",
          },
          missing: [],
        },
        enterprise: {
          requiredChecks: {
            legalPages: true,
            cohortAnalytics: true,
            ssoOnlyMode: false,
          },
        },
        aiEval: passingAiEvalSummary(),
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
          commands: [
            "vercel env rm AAIS_TRIAL_LOGIN_ENABLED production -y",
            "printf '%s' 'false' | vercel env add AAIS_TRIAL_LOGIN_ENABLED production",
          ],
          requiredValue: "false",
        }),
      ]),
    );
    const markdown = await readFile(markdownOutputPath, "utf8");
    expect(markdown).toContain("set-sso-only-runtime-mode");
    expect(markdown).toContain("AAIS_TRIAL_LOGIN_ENABLED");
    expect(markdown).toContain("required value: false");
    expect(markdown).toContain("vercel env rm AAIS_TRIAL_LOGIN_ENABLED production -y");
    expect(markdown).toContain("printf '%s' 'false' | vercel env add AAIS_TRIAL_LOGIN_ENABLED production");
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
        aiEval: passingAiEvalSummary(),
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
        aiEval: passingAiEvalSummary(),
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
          target: {
            authMode: "sso-only",
          },
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
    expect(report.externalActions.find((action) => action.id === "run-real-oidc-callback-smoke").command)
      .not.toContain("--require-sso-only");
    expect(report.externalActions.find((action) => action.id === "run-real-oidc-callback-smoke").note)
      .toContain("before disabling trial login");
    expect(await readFile(markdownOutputPath, "utf8")).toContain("run-real-oidc-callback-smoke");
  });

  it("requires fresh transient OIDC callback evidence on the final gate rerun", async () => {
    const releaseCheckReportPath = await writeJson("release-check.json", {
      status: "failed",
      checkedAt: "2026-06-30T08:00:00.000Z",
      artifacts: {
        vercelEnv: {
          target: {
            authMode: "sso-only",
          },
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
          target: {
            authMode: "sso-only",
          },
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
        aiEval: passingAiEvalSummary(),
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
    expect(report.storage).toMatchObject({
      status: "satisfied",
      sourceEnv: "DATABASE_URL",
      action: "none",
      note: expect.stringContaining("Vercel-connected Neon storage is already accepted"),
      redaction: {
        values: "not-read",
      },
    });
    expect(report.localCredentialInventory.storageUsable).toBe(true);
    expect(report.localCredentialInventory.oidcRoleMappingUsable).toBe(true);
    expect(report.localCredentialInventory.releaseUsable).toBe(true);
    expect(report.localCredentialInventory.missingNames).toEqual([
      "AAIS_OIDC_ISSUER",
      "AAIS_OIDC_CLIENT_ID",
      "AAIS_OIDC_CLIENT_SECRET",
      "AAIS_OIDC_REDIRECT_URI",
    ]);
    const markdown = await readFile(path.join(tempDir, "handoff.md"), "utf8");
    expect(markdown).toContain("Storage / Neon");
    expect(markdown).toContain("source env: DATABASE_URL");
    expect(markdown).toContain("action: none");
    expect(markdown).toContain("OIDC / SSO");
    expect(markdown).toContain("missing Vercel OIDC names: AAIS_OIDC_ISSUER, AAIS_OIDC_CLIENT_ID, AAIS_OIDC_CLIENT_SECRET, AAIS_OIDC_REDIRECT_URI");
    expect(markdown).toContain("local verify:oidc-config required names: AAIS_OIDC_ISSUER, AAIS_OIDC_CLIENT_ID, AAIS_OIDC_CLIENT_SECRET, AAIS_OIDC_REDIRECT_URI");
    expect(markdown).toContain("local validation-only names: none");
  });

  it("calls out OIDC redirect URI as local validation-only when Vercel already has it", async () => {
    const releaseCheckReportPath = await writeJson("release-check.json", {
      schemaVersion: 1,
      status: "failed",
      checkedAt: "2026-07-01T08:00:00.000Z",
      artifacts: {
        vercelEnv: {
          status: "failed",
          missing: [
            "AAIS_OIDC_ISSUER",
            "AAIS_OIDC_CLIENT_ID",
            "AAIS_OIDC_CLIENT_SECRET",
            "AAIS_OIDC_TEACHER_GROUPS",
          ],
        },
        enterprise: {
          requiredChecks: {
            legalPages: true,
            ssoOnlyMode: false,
            oidcCallback: false,
            cohortAnalytics: false,
          },
        },
        postgresRestore: {
          status: "missing",
        },
      },
    });

    const report = await generateAaisEnterpriseHandoff({
      releaseCheckReportPath,
      vercelEnvReportPath: releaseCheckReportPath,
      provisionReportPath: releaseCheckReportPath,
      localCredentialFiles: [],
      baseUrl: "https://www.aais.site",
      outputPath: path.join(tempDir, "handoff.json"),
      markdownOutputPath: path.join(tempDir, "handoff.md"),
      now: new Date("2026-07-01T08:30:00.000Z"),
    });

    expect(report.oidc).toMatchObject({
      missingRequiredNames: [
        "AAIS_OIDC_ISSUER",
        "AAIS_OIDC_CLIENT_ID",
        "AAIS_OIDC_CLIENT_SECRET",
      ],
      localValidationOnlyNames: ["AAIS_OIDC_REDIRECT_URI"],
      localValidationRequiredNames: [
        "AAIS_OIDC_ISSUER",
        "AAIS_OIDC_CLIENT_ID",
        "AAIS_OIDC_CLIENT_SECRET",
        "AAIS_OIDC_REDIRECT_URI",
      ],
    });
    const markdown = await readFile(path.join(tempDir, "handoff.md"), "utf8");
    expect(markdown).toContain("missing Vercel OIDC names: AAIS_OIDC_ISSUER, AAIS_OIDC_CLIENT_ID, AAIS_OIDC_CLIENT_SECRET");
    expect(markdown).toContain("local validation-only names: AAIS_OIDC_REDIRECT_URI");
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
        aiEval: passingAiEvalSummary(),
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
        aiEval: passingAiEvalSummary(),
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
        aiEval: passingAiEvalSummary(),
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
        aiEval: passingAiEvalSummary(),
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
        aiEval: passingAiEvalSummary(),
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
        aiEval: passingAiEvalSummary(),
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

  it("adds enterprise gap evidence commands when live A1-A4 AI eval is incomplete", async () => {
    const releaseCheckReportPath = await writeJson("release-check.json", {
      status: "failed",
      checkedAt: "2026-07-01T09:00:00.000Z",
      artifacts: {
        vercelEnv: {
          status: "passed",
          missing: [],
        },
        enterprise: {
          status: "passed",
          readiness: {
            releaseIdMatchesExpected: true,
          },
          requiredChecks: {
            legalPages: true,
            agentEvidence: true,
            oidcCallback: true,
            cohortAnalytics: true,
            ssoOnlyMode: true,
          },
          artifactCoalescing: {
            complete: true,
          },
        },
        aiEval: {
          status: "missing",
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
    const enterpriseGapEvidenceReportPath = await writeJson("gap-evidence.json", {
      status: "action-required",
      mode: "all",
      preflight: {
        status: "action-required",
        required: {
          missing: [
            "AAIS_VERIFY_OIDC_CALLBACK_URL",
            "AAIS_VERIFY_OIDC_STATE_COOKIE",
            "AAIS_AI_ENDPOINT",
            "AAIS_AI_API_KEY",
            "AAIS_AI_MODEL",
            "AAIS_AI_EVAL_VERSION",
          ],
          placeholders: ["AAIS_RESTORE_DATABASE_URL"],
          invalid: [],
        },
        liveAiEvalEvidence: {
          endpointPresent: false,
          endpointHttps: false,
          apiKeyPresent: false,
          modelPresent: false,
          evalVersionPresent: false,
        },
      },
    });

    const report = await generateAaisEnterpriseHandoff({
      releaseCheckReportPath,
      vercelEnvReportPath: releaseCheckReportPath,
      provisionReportPath: releaseCheckReportPath,
      enterpriseGapEvidenceReportPath,
      outputPath: path.join(tempDir, "handoff.json"),
      markdownOutputPath: path.join(tempDir, "handoff.md"),
      baseUrl: "https://aais-six.vercel.app",
      releaseId: "aais-2026-06-30-rc-live-ai-deepseek-v4-pro",
      aiEvalManifestPath: "output/aais-ai-eval-deepseek-v4-pro.json",
      now: new Date("2026-07-01T09:05:00.000Z"),
    });

    expect(report.missing.liveAiEval).toBe(true);
    expect(report.sourceReports.enterpriseGapEvidence).toBe(enterpriseGapEvidenceReportPath);
    expect(report.gapEvidencePreflight).toMatchObject({
      status: "action-required",
      missing: [
        "AAIS_VERIFY_OIDC_CALLBACK_URL",
        "AAIS_VERIFY_OIDC_STATE_COOKIE",
        "AAIS_AI_ENDPOINT",
        "AAIS_AI_API_KEY",
        "AAIS_AI_MODEL",
        "AAIS_AI_EVAL_VERSION",
      ],
      placeholders: ["AAIS_RESTORE_DATABASE_URL"],
    });
    expect(report.externalActions.map((action) => action.id)).toEqual([
      "run-live-ai-eval",
      "rerun-final-gate",
    ]);
    const liveAiEval = report.externalActions.find((action) => action.id === "run-live-ai-eval");
    expect(liveAiEval.preflightStatus).toBe("action-required");
    expect(liveAiEval.missingInputs).toEqual([
      "AAIS_AI_ENDPOINT",
      "AAIS_AI_API_KEY",
      "AAIS_AI_MODEL",
      "AAIS_AI_EVAL_VERSION",
    ]);
    expect(liveAiEval.command).toBe(
      "npm run ai:evaluate -- --env-file .env.production.local --output output/aais-ai-eval-deepseek-v4-pro.json --env-json-output output/aais-ai-eval-inline-latest.json --eval-version <AAIS_AI_EVAL_VERSION> --release-id aais-2026-06-30-rc-live-ai-deepseek-v4-pro",
    );
    expect(liveAiEval.gapEvidenceCommand).toBe(
      "npm run verify:enterprise-gaps -- --mode live-ai-eval --ai-eval-env-file .env.production.local --ai-eval-output output/aais-ai-eval-deepseek-v4-pro.json --ai-eval-inline-output output/aais-ai-eval-inline-latest.json --output output/aais-enterprise-gap-evidence-latest.json --release-id aais-2026-06-30-rc-live-ai-deepseek-v4-pro",
    );
    expect(liveAiEval.gapPreflightCommand).toBe(
      "npm run verify:enterprise-gaps -- --mode live-ai-eval --preflight-only --ai-eval-env-file .env.production.local --ai-eval-output output/aais-ai-eval-deepseek-v4-pro.json --ai-eval-inline-output output/aais-ai-eval-inline-latest.json --output output/aais-enterprise-gap-evidence-latest.json --release-id aais-2026-06-30-rc-live-ai-deepseek-v4-pro",
    );
    expect(liveAiEval.note).toContain("aais-a1-a4-ca-eval-v2");
  });
});

function passingAiEvalSummary() {
  return {
    status: "passed",
    compatibleWithEnterpriseReadiness: true,
    blockedCount: 0,
    agentEvidenceComplete: true,
    agentEvidenceContractVersion: "aais-a1-a4-ca-eval-v2",
    modelFingerprintMatchesEnterprise: true,
  };
}

async function writeJson(name, value) {
  const filePath = path.join(tempDir, name);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}
