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
  it("runs gate, env-template, provision dry-run, handoff, audit, and bundle in order with redacted summary output", async () => {
    const calls = [];
    const paths = getPaths();

    const report = await refreshAaisReleaseEvidence({
      ...paths,
      baseUrl: "https://aais-six.vercel.app",
      releaseId: "aais-2026-06-30-rc-live-ai-deepseek-v4-flash",
      envFilePath: ".env.local",
      now: new Date("2026-06-30T11:00:00.000Z"),
      enterpriseReleaseChecker: async (input) => {
        calls.push(["enterprise-release", input]);
        return {
          status: "failed",
          artifacts: {
            sourceProvenance: {
              status: "passed",
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
      "env-template",
      "restore-template",
      "oidc-config-dry-run",
      "provision-dry-run",
      "handoff",
      "readiness-audit",
      "evidence-bundle",
    ]);
    expect(calls[0][1]).toMatchObject({
      baseUrl: "https://aais-six.vercel.app",
      releaseId: "aais-2026-06-30-rc-live-ai-deepseek-v4-flash",
      sourceProvenanceReportPath: paths.sourceProvenanceReportPath,
      vercelEnvReportPath: paths.vercelEnvReportPath,
      vercelDeploymentReportPath: paths.vercelDeploymentReportPath,
      enterpriseReportPath: paths.enterpriseReportPath,
      releaseEvidenceReportPath: paths.releaseEvidenceReportPath,
      outputPath: paths.releaseCheckReportPath,
      aiEvalManifestPath: paths.aiEvalManifestPath,
      postgresRestoreReportPath: paths.postgresRestoreReportPath,
    });
    expect(calls[1][1]).toMatchObject({
      vercelEnvReportPath: paths.vercelEnvReportPath,
      outputPath: paths.privateEnvTemplatePath,
      reportPath: paths.privateEnvTemplateReportPath,
      baseUrl: "https://aais-six.vercel.app",
      environment: "production",
      releaseId: "aais-2026-06-30-rc-live-ai-deepseek-v4-flash",
    });
    expect(calls[2][1]).toMatchObject({
      outputPath: paths.postgresRestoreTemplatePath,
      reportPath: paths.postgresRestoreTemplateReportPath,
      postgresRestoreReportPath: paths.postgresRestoreReportPath,
      releaseId: "aais-2026-06-30-rc-live-ai-deepseek-v4-flash",
    });
    expect(calls[3][1]).toMatchObject({
      envFilePath: ".env.local",
      baseUrl: "https://aais-six.vercel.app",
      outputPath: paths.oidcConfigReportPath,
    });
    expect(calls[4][1]).toMatchObject({
      envFilePath: ".env.local",
      vercelEnvReportPath: paths.vercelEnvReportPath,
      outputPath: paths.provisionReportPath,
      releaseId: "aais-2026-06-30-rc-live-ai-deepseek-v4-flash",
      apply: false,
    });
    expect(calls[5][1]).toMatchObject({
      releaseCheckReportPath: paths.releaseCheckReportPath,
      vercelEnvReportPath: paths.vercelEnvReportPath,
      provisionReportPath: paths.provisionReportPath,
      oidcConfigReportPath: paths.oidcConfigReportPath,
      outputPath: paths.handoffReportPath,
      markdownOutputPath: paths.handoffMarkdownPath,
      privateEnvTemplatePath: paths.privateEnvTemplatePath,
      privateEnvTemplateReportPath: paths.privateEnvTemplateReportPath,
      postgresRestoreTemplatePath: paths.postgresRestoreTemplatePath,
      postgresRestoreTemplateReportPath: paths.postgresRestoreTemplateReportPath,
    });
    expect(calls[6][1]).toMatchObject({
      releaseCheckReportPath: paths.releaseCheckReportPath,
      handoffReportPath: paths.handoffReportPath,
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
      oidcConfigReportPath: paths.oidcConfigReportPath,
      aiEvalManifestPath: paths.aiEvalManifestPath,
      postgresRestoreReportPath: paths.postgresRestoreReportPath,
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
        { name: "env-template", status: "template-created", outputPath: paths.privateEnvTemplateReportPath },
        { name: "restore-template", status: "template-created", outputPath: paths.postgresRestoreTemplateReportPath },
        { name: "oidc-config-dry-run", status: "failed", outputPath: paths.oidcConfigReportPath },
        { name: "provision-dry-run", status: "failed", outputPath: paths.provisionReportPath },
        { name: "handoff", status: "action-required", outputPath: paths.handoffReportPath },
        { name: "readiness-audit", status: "action-required", outputPath: paths.readinessAuditReportPath },
        { name: "evidence-bundle", status: "action-required", outputPath: paths.bundleReportPath },
      ],
      summaries: {
        readinessAudit: {
          total: 11,
          passed: 5,
          actionRequired: 6,
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
    expect(calls[1][1].releaseId).toBe("aais-2026-06-30-rc-live-ai-deepseek-v4-flash");
    expect(calls[2][1].envFilePath).toBe(".env.production.local");
    expect(calls[2][1].baseUrl).toBe("https://www.aais.site");
    expect(calls[3][1].envFilePath).toBe(".env.production.local");
    expect(calls[3][1].releaseId).toBe("aais-2026-06-30-rc-live-ai-deepseek-v4-flash");
    expect(calls[4][1].baseUrl).toBe("https://www.aais.site");
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
      "env-template",
      "restore-template",
      "oidc-config-dry-run",
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
        { name: "env-template", status: "template-created", outputPath: paths.privateEnvTemplateReportPath },
        { name: "restore-template", status: "template-created", outputPath: paths.postgresRestoreTemplateReportPath },
        { name: "oidc-config-dry-run", status: "failed", outputPath: paths.oidcConfigReportPath },
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
