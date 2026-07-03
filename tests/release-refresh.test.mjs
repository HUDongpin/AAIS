import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refreshAaisReleaseEvidence } from "../scripts/refresh-release-evidence.mjs";

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-release-refresh-"));
});

afterEach(async () => {
  delete process.env.AAIS_RELEASE_REFRESH_REPORT_PATH;
  await rm(tempDir, { force: true, recursive: true });
});

describe("AAIS release evidence refresh workflow", () => {
  it("runs gate, templates, provision dry-run, handoff, audit, and bundle in order with redacted summary output", async () => {
    const calls = [];
    const paths = getPaths();

    const report = await refreshAaisReleaseEvidence({
      ...paths,
      baseUrl: "https://aais-six.vercel.app",
      releaseId: "aais-2026-06-30-rc-live-ai-deepseek-v4-pro",
      deploymentGitCommit: "ffec998b638c1234567890abcdef1234567890ab",
      envFilePath: ".env.local",
      now: new Date("2026-06-30T11:00:00.000Z"),
      enterpriseReleaseChecker: async (input) => {
        calls.push(["enterprise-release", input]);
        return {
          status: "failed",
          sequence: [
            {
              name: "source-provenance",
              status: "passed",
            },
          ],
          artifacts: {
            sourceProvenance: {
              status: "failed",
            },
          },
          leakedValue: "postgres://user:secret@host/db",
        };
      },
      envTemplateGenerator: async (input) => {
        calls.push(["env-template", input]);
        return {
          status: "template-created",
          rawSecret: "postgres://user:template-secret@host/db",
        };
      },
      restoreTemplateGenerator: async (input) => {
        calls.push(["restore-template", input]);
        return {
          status: "template-created",
          rawSecret: "postgres://user:restore-template-secret@host/db",
        };
      },
      gapTemplateGenerator: async (input) => {
        calls.push(["gap-template", input]);
        return {
          status: "template-created",
          rawSecret: "https://idp.example/callback?code=real",
        };
      },
      oidcConfigVerifier: async (input) => {
        calls.push(["oidc-config-dry-run", input]);
        return {
          status: "failed",
          rawSecret: "oidc-client-secret-value",
        };
      },
      provisioner: async (input) => {
        calls.push(["provision-dry-run", input]);
        return {
          status: "failed",
          required: {
            localValuesMissing: ["AAIS_DATABASE_URL"],
          },
          rawSecret: "oidc-client-secret-value",
        };
      },
      handoffGenerator: async (input) => {
        calls.push(["handoff", input]);
        return {
          status: "action-required",
          externalActions: [
            {
              id: "fill-private-env-template",
              status: "required",
              templatePath: paths.privateEnvTemplatePath,
              privateEnvFilePath: ".env.local",
              oidcOnboardingCommand:
                "npm run prepare:oidc-sso -- --env-file .env.local --base-url https://www.aais.site",
              neonApiPreparationCommand:
                "npm run prepare:neon-restore -- --neon-env-file .env.neon-restore.local --output-env .env.postgres-restore.local",
              commands: [
                "npm run provision:vercel-env -- --env-file .env.local --apply",
              ],
            },
            {
              id: "set-vercel-production-env",
              status: "required",
              missing: ["AAIS_OIDC_CLIENT_SECRET", "not-safe"],
              commands: [
                "vercel env add AAIS_OIDC_CLIENT_SECRET production",
                "printf '%s' 'postgres://user:secret@host/db' | vercel env add AAIS_DATABASE_URL production",
              ],
            },
            {
              id: "run-real-oidc-callback-smoke",
              status: "required",
              preflightStatus: "action-required",
              missingInputs: [
                "AAIS_VERIFY_OIDC_CALLBACK_URL",
                "AAIS_VERIFY_OIDC_STATE_COOKIE",
              ],
              command:
                "AAIS_VERIFY_OIDC_CALLBACK_URL=https://idp.example/callback?code=real npm run verify:enterprise",
              gapPreflightCommand:
                "npm run verify:enterprise-gaps -- --mode oidc-callback --preflight-only --env-file .env.enterprise-smoke.local --output output/aais-enterprise-gap-evidence-latest.json",
              gapEvidenceCommand:
                "npm run verify:enterprise-gaps -- --mode oidc-callback --env-file .env.enterprise-smoke.local --output output/aais-enterprise-gap-evidence-latest.json",
            },
            {
              id: "set-sso-only-runtime-mode",
              status: "required-after-sso-verification",
              requiredValue: "false",
              commands: [
                "vercel env rm AAIS_TRIAL_LOGIN_ENABLED production -y",
                "printf '%s' 'false' | vercel env add AAIS_TRIAL_LOGIN_ENABLED production",
              ],
            },
          ],
          businessGapActions: [
            {
              id: "production-oidc-env-config",
              status: "action-required",
              missing: ["AAIS_OIDC_CLIENT_SECRET"],
              actions: [
                "fill-private-env-template",
                "verify-oidc-config-dry-run",
                "set-vercel-production-env",
                "rerun-final-gate",
              ],
            },
            {
              id: "sso-only-cutover",
              status: "action-required",
              actions: ["set-sso-only-runtime-mode", "rerun-final-gate"],
            },
          ],
        };
      },
      readinessAuditor: async (input) => {
        calls.push(["readiness-audit", input]);
        return {
          status: "action-required",
          summary: {
            total: 11,
            passed: 5,
            actionRequired: 6,
          },
          businessGapSummary: {
            total: 7,
            passed: 2,
            actionRequired: 5,
          },
        };
      },
      bundleCreator: async (input) => {
        calls.push(["evidence-bundle", input]);
        return {
          status: "action-required",
          summary: {
            total: 8,
            present: 7,
            missing: 1,
            passed: 1,
            actionRequired: 7,
            secretScanFailed: 0,
          },
        };
      },
    });

    expect(calls.map(([name]) => name)).toEqual([
      "enterprise-release",
      "restore-template",
      "gap-template",
      "env-template",
      "provision-dry-run",
      "handoff",
      "readiness-audit",
      "evidence-bundle",
    ]);
    expect(calls[0][1]).toMatchObject({
      baseUrl: "https://aais-six.vercel.app",
      releaseId: "aais-2026-06-30-rc-live-ai-deepseek-v4-pro",
      sourceProvenanceReportPath: paths.sourceProvenanceReportPath,
      vercelEnvReportPath: paths.vercelEnvReportPath,
      vercelDeploymentReportPath: paths.vercelDeploymentReportPath,
      enterpriseReportPath: paths.enterpriseReportPath,
      releaseEvidenceReportPath: paths.releaseEvidenceReportPath,
      outputPath: paths.releaseCheckReportPath,
      aiEvalManifestPath: paths.aiEvalManifestPath,
      postgresRestoreReportPath: paths.postgresRestoreReportPath,
      deploymentGitCommit: "ffec998b638c1234567890abcdef1234567890ab",
    });
    expect(calls[1][1]).toMatchObject({
      outputPath: paths.postgresRestoreTemplatePath,
      reportPath: paths.postgresRestoreTemplateReportPath,
      postgresRestoreReportPath: paths.postgresRestoreReportPath,
      releaseId: "aais-2026-06-30-rc-live-ai-deepseek-v4-pro",
    });
    expect(calls[2][1]).toMatchObject({
      outputPath: paths.enterpriseGapTemplatePath,
      reportPath: paths.enterpriseGapTemplateReportPath,
      baseUrl: "https://aais-six.vercel.app",
      releaseId: "aais-2026-06-30-rc-live-ai-deepseek-v4-pro",
      enterpriseReportPath: paths.enterpriseReportPath,
      restoreReportPath: paths.postgresRestoreReportPath,
      gapEvidenceReportPath: paths.enterpriseGapEvidenceReportPath,
    });
    expect(calls[3][1]).toMatchObject({
      vercelEnvReportPath: paths.vercelEnvReportPath,
      enterpriseGapEvidenceReportPath: paths.enterpriseGapEvidenceReportPath,
      outputPath: paths.privateEnvTemplatePath,
      reportPath: paths.privateEnvTemplateReportPath,
      baseUrl: "https://aais-six.vercel.app",
      environment: "production",
      releaseId: "aais-2026-06-30-rc-live-ai-deepseek-v4-pro",
      deploymentGitCommit: "ffec998b638c1234567890abcdef1234567890ab",
    });
    expect(calls[4][1]).toMatchObject({
      envFilePath: ".env.local",
      vercelEnvReportPath: paths.vercelEnvReportPath,
      outputPath: paths.provisionReportPath,
      releaseId: "aais-2026-06-30-rc-live-ai-deepseek-v4-pro",
      deploymentGitCommit: "ffec998b638c1234567890abcdef1234567890ab",
      apply: false,
    });
    expect(calls[5][1]).toMatchObject({
      releaseCheckReportPath: paths.releaseCheckReportPath,
      vercelEnvReportPath: paths.vercelEnvReportPath,
      provisionReportPath: paths.provisionReportPath,
      oidcConfigReportPath: false,
      sourceProvenanceReportPath: paths.sourceProvenanceReportPath,
      deploymentGitCommit: "ffec998b638c1234567890abcdef1234567890ab",
      outputPath: paths.handoffReportPath,
      markdownOutputPath: paths.handoffMarkdownPath,
      privateEnvTemplatePath: paths.privateEnvTemplatePath,
      privateEnvTemplateReportPath: paths.privateEnvTemplateReportPath,
      postgresRestoreTemplatePath: paths.postgresRestoreTemplatePath,
      postgresRestoreTemplateReportPath: paths.postgresRestoreTemplateReportPath,
      enterpriseGapEvidenceReportPath: paths.enterpriseGapEvidenceReportPath,
    });
    expect(calls[6][1]).toMatchObject({
      releaseCheckReportPath: paths.releaseCheckReportPath,
      handoffReportPath: paths.handoffReportPath,
      gapEvidenceReportPath: paths.enterpriseGapEvidenceReportPath,
      outputPath: paths.readinessAuditReportPath,
      markdownOutputPath: paths.readinessAuditMarkdownPath,
    });
    expect(calls[7][1]).toMatchObject({
      sourceProvenanceReportPath: paths.sourceProvenanceReportPath,
      vercelEnvReportPath: paths.vercelEnvReportPath,
      vercelDeploymentReportPath: paths.vercelDeploymentReportPath,
      enterpriseReportPath: paths.enterpriseReportPath,
      releaseEvidenceReportPath: paths.releaseEvidenceReportPath,
      releaseCheckReportPath: paths.releaseCheckReportPath,
      handoffReportPath: paths.handoffReportPath,
      readinessAuditReportPath: paths.readinessAuditReportPath,
      oidcConfigReportPath: false,
      aiEvalManifestPath: paths.aiEvalManifestPath,
      postgresRestoreReportPath: paths.postgresRestoreReportPath,
      enterpriseGapTemplateReportPath: paths.enterpriseGapTemplateReportPath,
      enterpriseGapEvidenceReportPath: paths.enterpriseGapEvidenceReportPath,
      outputPath: paths.bundleReportPath,
      markdownOutputPath: paths.bundleMarkdownPath,
    });
    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "action-required",
      refreshedAt: "2026-06-30T11:00:00.000Z",
      sequence: [
        { name: "enterprise-release", status: "failed", outputPath: paths.releaseCheckReportPath },
        { name: "source-provenance", status: "passed", outputPath: paths.sourceProvenanceReportPath },
        { name: "restore-template", status: "template-created", outputPath: paths.postgresRestoreTemplateReportPath },
        { name: "gap-template", status: "template-created", outputPath: paths.enterpriseGapTemplateReportPath },
        { name: "env-template", status: "template-created", outputPath: paths.privateEnvTemplateReportPath },
        { name: "provision-dry-run", status: "failed", outputPath: paths.provisionReportPath },
        { name: "handoff", status: "action-required", outputPath: paths.handoffReportPath },
        { name: "readiness-audit", status: "action-required", outputPath: paths.readinessAuditReportPath },
        { name: "evidence-bundle", status: "action-required", outputPath: paths.bundleReportPath },
      ],
      nextActions: {
        source: "enterprise-handoff",
        total: 4,
        required: 4,
        businessGaps: [
          {
            id: "production-oidc-env-config",
            status: "action-required",
            missing: ["AAIS_OIDC_CLIENT_SECRET"],
            reasons: [],
            actions: [
              "fill-private-env-template",
              "verify-oidc-config-dry-run",
              "set-vercel-production-env",
              "rerun-final-gate",
            ],
          },
          {
            id: "sso-only-cutover",
            status: "action-required",
            missing: [],
            reasons: [],
            actions: ["set-sso-only-runtime-mode", "rerun-final-gate"],
          },
        ],
        actions: [
          {
            id: "fill-private-env-template",
            status: "required",
            templatePath: paths.privateEnvTemplatePath,
            privateEnvFilePath: ".env.local",
            oidcOnboardingCommand:
              "npm run prepare:oidc-sso -- --env-file .env.local --base-url https://www.aais.site",
            neonApiPreparationCommand:
              "npm run prepare:neon-restore -- --neon-env-file .env.neon-restore.local --output-env .env.postgres-restore.local",
            commands: [
              "npm run provision:vercel-env -- --env-file .env.local --apply",
            ],
          },
          {
            id: "set-vercel-production-env",
            status: "required",
            missing: ["AAIS_OIDC_CLIENT_SECRET"],
            commands: [
              "vercel env add AAIS_OIDC_CLIENT_SECRET production",
              "<redacted:secret-like-command>",
            ],
          },
          {
            id: "run-real-oidc-callback-smoke",
            status: "required",
            preflightStatus: "action-required",
            missingInputs: [
              "AAIS_VERIFY_OIDC_CALLBACK_URL",
              "AAIS_VERIFY_OIDC_STATE_COOKIE",
            ],
            command: "<redacted:secret-like-command>",
            gapPreflightCommand:
              "npm run verify:enterprise-gaps -- --mode oidc-callback --preflight-only --env-file .env.enterprise-smoke.local --output output/aais-enterprise-gap-evidence-latest.json",
            gapEvidenceCommand:
              "npm run verify:enterprise-gaps -- --mode oidc-callback --env-file .env.enterprise-smoke.local --output output/aais-enterprise-gap-evidence-latest.json",
          },
          {
            id: "set-sso-only-runtime-mode",
            status: "required-after-sso-verification",
            requiredValue: "false",
            commands: [
              "vercel env rm AAIS_TRIAL_LOGIN_ENABLED production -y",
              "printf '%s' 'false' | vercel env add AAIS_TRIAL_LOGIN_ENABLED production",
            ],
          },
        ],
        redaction: {
          secrets: "omitted",
          values: "not-read",
          secretLikeCommands: "redacted",
        },
      },
      summaries: {
        readinessAudit: {
          total: 11,
          passed: 5,
          actionRequired: 6,
          businessGapSummary: {
            total: 7,
            passed: 2,
            actionRequired: 5,
          },
        },
        evidenceBundle: {
          total: 8,
          present: 7,
          missing: 1,
          passed: 1,
          actionRequired: 7,
          secretScanFailed: 0,
        },
      },
      redaction: {
        secrets: "omitted",
        values: "not-read",
      },
    });
    expect(JSON.parse(await readFile(paths.outputPath, "utf8"))).toEqual(report);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("postgres://user:secret@host/db");
    expect(serialized).not.toContain("template-secret");
    expect(serialized).not.toContain("restore-template-secret");
    expect(serialized).not.toContain("oidc-client-secret-value");
    expect(serialized).not.toContain("postgres://user:secret@host/db");
    expect(serialized).not.toContain("https://idp.example/callback?code=real");
  });

  it("reports ready when every refreshed artifact is ready or passed", async () => {
    const paths = getPaths();

    const report = await refreshAaisReleaseEvidence({
      ...paths,
      now: new Date("2026-06-30T11:30:00.000Z"),
      enterpriseReleaseChecker: async () => ({
        status: "passed",
        artifacts: {
          sourceProvenance: {
            status: "passed",
          },
        },
      }),
      envTemplateGenerator: async () => ({ status: "ready" }),
      restoreTemplateGenerator: async () => ({ status: "ready" }),
      gapTemplateGenerator: async () => ({ status: "ready" }),
      oidcConfigVerifier: async () => ({ status: "ready" }),
      provisioner: async () => ({ status: "ready" }),
      handoffGenerator: async () => ({ status: "ready" }),
      readinessAuditor: async () => ({
        status: "ready",
        summary: { total: 11, passed: 11, actionRequired: 0 },
      }),
      bundleCreator: async () => ({
        status: "ready",
        summary: { total: 8, present: 8, missing: 0, passed: 8, actionRequired: 0, secretScanFailed: 0 },
      }),
    });

    expect(report.status).toBe("ready");
    expect(report.sequence.map((step) => step.status)).toEqual([
      "passed",
      "passed",
      "ready",
      "ready",
      "ready",
      "ready",
      "ready",
      "ready",
      "ready",
    ]);
  });

  it("defaults routine refreshes to the current public Vercel production alias", async () => {
    const calls = [];
    const paths = getPaths();

    await refreshAaisReleaseEvidence({
      ...paths,
      now: new Date("2026-06-30T11:45:00.000Z"),
      enterpriseReleaseChecker: async (input) => {
        calls.push(["enterprise-release", input]);
        return { status: "passed" };
      },
      envTemplateGenerator: async (input) => {
        calls.push(["env-template", input]);
        return { status: "ready" };
      },
      restoreTemplateGenerator: async () => ({ status: "ready" }),
      gapTemplateGenerator: async () => ({ status: "ready" }),
      oidcConfigVerifier: async (input) => {
        calls.push(["oidc-config-dry-run", input]);
        return { status: "ready" };
      },
      provisioner: async (input) => {
        calls.push(["provision-dry-run", input]);
        return { status: "ready" };
      },
      handoffGenerator: async (input) => {
        calls.push(["handoff", input]);
        return { status: "ready" };
      },
      readinessAuditor: async () => ({
        status: "ready",
        summary: { total: 11, passed: 11, actionRequired: 0 },
      }),
      bundleCreator: async () => ({
        status: "ready",
        summary: { total: 8, present: 8, missing: 0, passed: 8, actionRequired: 0, secretScanFailed: 0 },
      }),
    });

    expect(calls[0][1].baseUrl).toBe("https://www.aais.site");
    expect(calls[0][1].deploymentUrl).toBe("https://www.aais.site");
    expect(calls[1][1].baseUrl).toBe("https://www.aais.site");
    expect(calls[1][1].releaseId).toBe("aais-2026-06-30-rc-live-ai-deepseek-v4-pro");
    expect(calls[2][1].envFilePath).toBe(".env.production.local");
    expect(calls[2][1].releaseId).toBe("aais-2026-06-30-rc-live-ai-deepseek-v4-pro");
    expect(calls[3][1].baseUrl).toBe("https://www.aais.site");
    expect(calls[3][1].releaseId).toBe("aais-2026-06-30-rc-live-ai-deepseek-v4-pro");
  });

  it("can include a safe enterprise gap preflight without running live gap evidence", async () => {
    const calls = [];
    const paths = getPaths();

    const report = await refreshAaisReleaseEvidence({
      ...paths,
      enterpriseGapPreflightOnly: true,
      enterpriseGapEnvFilePath: ".env.enterprise-smoke.local",
      restoreEnvFilePath: ".env.postgres-restore.local",
      baseUrl: "https://aais.example.test",
      releaseId: "aais-2026-07-01-rc1",
      now: new Date("2026-07-01T12:15:00.000Z"),
      enterpriseReleaseChecker: async () => ({ status: "passed", artifacts: { sourceProvenance: { status: "passed" } } }),
      envTemplateGenerator: async (input) => {
        calls.push(["env-template", input]);
        return { status: "ready" };
      },
      restoreTemplateGenerator: async () => ({ status: "ready" }),
      gapTemplateGenerator: async () => ({ status: "ready" }),
      gapEvidenceRunner: async (input) => {
        calls.push(["gap-evidence-preflight", input]);
        return {
          status: "preflight-ready",
          preflightOnly: true,
          preflight: {
            status: "ready",
          },
        };
      },
      oidcConfigVerifier: async () => ({ status: "ready" }),
      provisioner: async () => ({ status: "ready" }),
      handoffGenerator: async () => ({ status: "ready" }),
      readinessAuditor: async () => ({
        status: "ready",
        summary: { total: 18, passed: 18, actionRequired: 0 },
      }),
      bundleCreator: async () => ({
        status: "ready",
        summary: { total: 13, present: 13, missing: 0, passed: 13, actionRequired: 0, secretScanFailed: 0 },
      }),
    });

    expect(calls).toEqual([
      [
        "gap-evidence-preflight",
        expect.objectContaining({
          mode: "all",
          envFilePath: ".env.enterprise-smoke.local",
          restoreEnvFilePath: ".env.postgres-restore.local",
          baseUrl: "https://aais.example.test",
          releaseId: "aais-2026-07-01-rc1",
          outputPath: paths.enterpriseGapEvidenceReportPath,
          enterpriseOutputPath: paths.enterpriseReportPath,
          restoreOutputPath: paths.postgresRestoreReportPath,
          preflightOnly: true,
        }),
      ],
      [
        "env-template",
        expect.objectContaining({
          vercelEnvReportPath: paths.vercelEnvReportPath,
          enterpriseGapEvidenceReportPath: paths.enterpriseGapEvidenceReportPath,
          outputPath: paths.privateEnvTemplatePath,
          reportPath: paths.privateEnvTemplateReportPath,
        }),
      ],
    ]);
    expect(report.status).toBe("action-required");
    expect(report.sequence).toContainEqual({
      name: "gap-evidence-preflight",
      status: "preflight-ready",
      outputPath: paths.enterpriseGapEvidenceReportPath,
    });
  });

  it("continues the redacted refresh chain when the online enterprise gate throws", async () => {
    const calls = [];
    const paths = getPaths();

    const report = await refreshAaisReleaseEvidence({
      ...paths,
      now: new Date("2026-06-30T12:00:00.000Z"),
      enterpriseReleaseChecker: async () => {
        calls.push("enterprise-release");
        throw new Error("fetch failed with bearer secret");
      },
      envTemplateGenerator: async () => {
        calls.push("env-template");
        return { status: "template-created" };
      },
      restoreTemplateGenerator: async () => {
        calls.push("restore-template");
        return { status: "template-created" };
      },
      gapTemplateGenerator: async () => {
        calls.push("gap-template");
        return { status: "template-created" };
      },
      oidcConfigVerifier: async () => {
        calls.push("oidc-config-dry-run");
        return { status: "failed" };
      },
      provisioner: async () => {
        calls.push("provision-dry-run");
        return { status: "failed" };
      },
      handoffGenerator: async () => {
        calls.push("handoff");
        return { status: "action-required" };
      },
      readinessAuditor: async () => {
        calls.push("readiness-audit");
        return { status: "action-required", summary: { total: 11, passed: 5, actionRequired: 6 } };
      },
      bundleCreator: async () => {
        calls.push("evidence-bundle");
        return {
          status: "action-required",
          summary: { total: 8, present: 7, missing: 1, passed: 1, actionRequired: 7, secretScanFailed: 0 },
        };
      },
    });

    expect(calls).toEqual([
      "enterprise-release",
      "restore-template",
      "gap-template",
      "env-template",
      "provision-dry-run",
      "handoff",
      "readiness-audit",
      "evidence-bundle",
    ]);
    expect(report).toMatchObject({
      status: "action-required",
      sequence: [
        { name: "enterprise-release", status: "failed", outputPath: paths.releaseCheckReportPath },
        { name: "source-provenance", status: "unknown", outputPath: paths.sourceProvenanceReportPath },
        { name: "restore-template", status: "template-created", outputPath: paths.postgresRestoreTemplateReportPath },
        { name: "gap-template", status: "template-created", outputPath: paths.enterpriseGapTemplateReportPath },
        { name: "env-template", status: "template-created", outputPath: paths.privateEnvTemplateReportPath },
        { name: "provision-dry-run", status: "failed", outputPath: paths.provisionReportPath },
        { name: "handoff", status: "action-required", outputPath: paths.handoffReportPath },
        { name: "readiness-audit", status: "action-required", outputPath: paths.readinessAuditReportPath },
        { name: "evidence-bundle", status: "action-required", outputPath: paths.bundleReportPath },
      ],
    });
    expect(JSON.stringify(report)).not.toContain("bearer secret");
  });
});

function getPaths() {
  return {
    vercelEnvReportPath: path.join(tempDir, "vercel-env.json"),
    vercelDeploymentReportPath: path.join(tempDir, "vercel-deployment.json"),
    enterpriseReportPath: path.join(tempDir, "enterprise.json"),
    releaseEvidenceReportPath: path.join(tempDir, "release-evidence.json"),
    sourceProvenanceReportPath: path.join(tempDir, "source-provenance.json"),
    releaseCheckReportPath: path.join(tempDir, "release-check.json"),
    privateEnvTemplatePath: path.join(tempDir, "private-env-template.env"),
    privateEnvTemplateReportPath: path.join(tempDir, "private-env-template-report.json"),
    postgresRestoreTemplatePath: path.join(tempDir, "restore-template.env"),
    postgresRestoreTemplateReportPath: path.join(tempDir, "restore-template-report.json"),
    enterpriseGapTemplatePath: path.join(tempDir, "gap-template.env"),
    enterpriseGapTemplateReportPath: path.join(tempDir, "gap-template-report.json"),
    enterpriseGapEvidenceReportPath: path.join(tempDir, "gap-evidence.json"),
    oidcConfigReportPath: path.join(tempDir, "oidc-config.json"),
    provisionReportPath: path.join(tempDir, "provision.json"),
    handoffReportPath: path.join(tempDir, "handoff.json"),
    handoffMarkdownPath: path.join(tempDir, "handoff.md"),
    readinessAuditReportPath: path.join(tempDir, "audit.json"),
    readinessAuditMarkdownPath: path.join(tempDir, "audit.md"),
    bundleReportPath: path.join(tempDir, "bundle.json"),
    bundleMarkdownPath: path.join(tempDir, "bundle.md"),
    aiEvalManifestPath: path.join(tempDir, "ai-eval.json"),
    postgresRestoreReportPath: path.join(tempDir, "restore.json"),
    outputPath: path.join(tempDir, "refresh.json"),
  };
}
