import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAaisReleaseEvidenceBundle } from "../scripts/create-release-evidence-bundle.mjs";

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-release-bundle-"));
});

afterEach(async () => {
  delete process.env.AAIS_RELEASE_BUNDLE_REPORT_PATH;
  delete process.env.AAIS_RELEASE_BUNDLE_MARKDOWN_PATH;
  await rm(tempDir, { force: true, recursive: true });
});

describe("AAIS release evidence bundle manifest", () => {
  it("writes a redacted manifest with artifact hashes, statuses, and secret-scan results", async () => {
    const sourceProvenancePath = await writeJson("source-provenance.json", {
      status: "passed",
      checkedAt: "2026-06-30T09:59:30.000Z",
      release: {
        id: "aais-2026-06-30-rc-live-ai-deepseek-v4-flash",
      },
      source: {
        gitHeadPresent: true,
        gitCommitShortSha: "0123456789ab",
        clean: true,
        workingTree: {
          total: 0,
          staged: 0,
          unstaged: 0,
          untracked: 0,
        },
      },
      redaction: {
        secrets: "omitted",
        fileNames: "not-included",
        gitStatus: "counts-only",
      },
    });
    const vercelEnvPath = await writeJson("vercel-env.json", {
      status: "failed",
      checkedAt: "2026-06-30T10:00:00.000Z",
      required: {
        missing: ["AAIS_DATABASE_URL"],
      },
    });
    const vercelDeploymentPath = await writeJson("vercel-deployment.json", {
      status: "passed",
      checkedAt: "2026-06-30T10:00:30.000Z",
    });
    const enterprisePath = await writeJson("enterprise.json", {
      status: "failed",
      checkedAt: "2026-06-30T10:01:00.000Z",
      checks: [{ name: "readiness", status: "failed" }],
      rawSecret: "postgres://user:secret@host/db",
    });
    const releaseEvidencePath = await writeJson("release-evidence.json", {
      status: "failed",
      checkedAt: "2026-06-30T10:02:00.000Z",
      artifacts: {
        vercelEnv: { status: "failed" },
        aiEval: { status: "passed" },
      },
    });
    const releaseCheckPath = await writeJson("release-check.json", {
      status: "failed",
      checkedAt: "2026-06-30T10:03:00.000Z",
    });
    const handoffPath = await writeJson("handoff.json", {
      status: "action-required",
      generatedAt: "2026-06-30T10:04:00.000Z",
    });
    const auditPath = await writeJson("audit.json", {
      status: "action-required",
      generatedAt: "2026-06-30T10:05:00.000Z",
      summary: {
        total: 11,
        passed: 5,
        actionRequired: 6,
      },
    });
    const oidcConfigPath = await writeJson("oidc-config.json", {
      status: "failed",
      checkedAt: "2026-06-30T10:05:30.000Z",
      required: {
        missing: [
          "AAIS_OIDC_ISSUER",
          "AAIS_OIDC_CLIENT_ID",
          "AAIS_OIDC_CLIENT_SECRET",
          "AAIS_OIDC_REDIRECT_URI",
        ],
      },
      redirectUri: {
        status: "failed",
        expectedCallback: "https://www.aais.site/api/auth/oidc/callback",
      },
      discovery: {
        status: "skipped",
        reason: "base-config-invalid",
      },
      redaction: {
        secrets: "omitted",
        values: "not-output",
      },
    });
    const aiEvalPath = await writeJson("ai-eval.json", {
      status: "passed",
      passedAt: "2026-06-30T10:06:00.000Z",
      evalVersion: "deepseek-v4-flash-2026-06-30",
    });
    const postgresRestorePath = path.join(tempDir, "missing-restore.json");
    const outputPath = path.join(tempDir, "bundle.json");
    const markdownOutputPath = path.join(tempDir, "bundle.md");

    const report = await createAaisReleaseEvidenceBundle({
      sourceProvenanceReportPath: sourceProvenancePath,
      vercelEnvReportPath: vercelEnvPath,
      vercelDeploymentReportPath: vercelDeploymentPath,
      enterpriseReportPath: enterprisePath,
      releaseEvidenceReportPath: releaseEvidencePath,
      releaseCheckReportPath: releaseCheckPath,
      handoffReportPath: handoffPath,
      readinessAuditReportPath: auditPath,
      oidcConfigReportPath: oidcConfigPath,
      aiEvalManifestPath: aiEvalPath,
      postgresRestoreReportPath: postgresRestorePath,
      outputPath,
      markdownOutputPath,
      releaseId: "aais-2026-06-30-rc-live-ai-deepseek-v4-flash",
      now: new Date("2026-06-30T10:30:00.000Z"),
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "action-required",
      generatedAt: "2026-06-30T10:30:00.000Z",
      release: {
        id: "aais-2026-06-30-rc-live-ai-deepseek-v4-flash",
      },
      summary: {
        total: 11,
        present: 10,
        missing: 1,
        passed: 3,
        actionRequired: 8,
        secretScanFailed: 1,
      },
      artifacts: [
        {
          id: "source-provenance",
          path: sourceProvenancePath,
          required: true,
          present: true,
          reportedStatus: "passed",
          effectiveStatus: "passed",
          sha256: sha256(await readFile(sourceProvenancePath, "utf8")),
          secretScan: {
            status: "passed",
          },
          metadata: {
            checkedAt: "2026-06-30T09:59:30.000Z",
          },
        },
        {
          id: "vercel-env",
          path: vercelEnvPath,
          required: true,
          present: true,
          reportedStatus: "failed",
          effectiveStatus: "action-required",
          sha256: sha256(await readFile(vercelEnvPath, "utf8")),
          secretScan: {
            status: "passed",
          },
          metadata: {
            checkedAt: "2026-06-30T10:00:00.000Z",
            missing: ["AAIS_DATABASE_URL"],
          },
        },
        {
          id: "vercel-deployment",
          path: vercelDeploymentPath,
          required: true,
          present: true,
          reportedStatus: "passed",
          effectiveStatus: "passed",
          sha256: sha256(await readFile(vercelDeploymentPath, "utf8")),
          secretScan: {
            status: "passed",
          },
          metadata: {
            checkedAt: "2026-06-30T10:00:30.000Z",
          },
        },
        {
          id: "enterprise-smoke",
          path: enterprisePath,
          required: true,
          present: true,
          reportedStatus: "failed",
          effectiveStatus: "action-required",
          secretScan: {
            status: "failed",
            issue: "postgres-url-with-password",
          },
        },
        {
          id: "release-evidence",
          path: releaseEvidencePath,
          required: true,
          present: true,
          reportedStatus: "failed",
          effectiveStatus: "action-required",
        },
        {
          id: "enterprise-release-check",
          path: releaseCheckPath,
          required: true,
          present: true,
          reportedStatus: "failed",
          effectiveStatus: "action-required",
        },
        {
          id: "enterprise-handoff",
          path: handoffPath,
          required: true,
          present: true,
          reportedStatus: "action-required",
          effectiveStatus: "action-required",
        },
        {
          id: "enterprise-readiness-audit",
          path: auditPath,
          required: true,
          present: true,
          reportedStatus: "action-required",
          effectiveStatus: "action-required",
          metadata: {
            summary: {
              total: 11,
              passed: 5,
              actionRequired: 6,
            },
          },
        },
        {
          id: "oidc-config",
          path: oidcConfigPath,
          required: true,
          present: true,
          reportedStatus: "failed",
          effectiveStatus: "action-required",
          secretScan: {
            status: "passed",
          },
          metadata: {
            checkedAt: "2026-06-30T10:05:30.000Z",
            missing: [
              "AAIS_OIDC_ISSUER",
              "AAIS_OIDC_CLIENT_ID",
              "AAIS_OIDC_CLIENT_SECRET",
              "AAIS_OIDC_REDIRECT_URI",
            ],
          },
        },
        {
          id: "ai-eval",
          path: aiEvalPath,
          required: true,
          present: true,
          reportedStatus: "passed",
          effectiveStatus: "passed",
          metadata: {
            checkedAt: "2026-06-30T10:06:00.000Z",
            evalVersion: "deepseek-v4-flash-2026-06-30",
          },
        },
        {
          id: "postgres-restore",
          path: postgresRestorePath,
          required: true,
          present: false,
          reportedStatus: "missing",
          effectiveStatus: "action-required",
          secretScan: {
            status: "not-run",
          },
        },
      ],
      redaction: {
        secrets: "omitted",
        values: "not-read",
      },
    });
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(report);
    const markdown = await readFile(markdownOutputPath, "utf8");
    expect(markdown).toContain("AAIS Release Evidence Bundle");
    expect(markdown).toContain("oidc-config");
    expect(markdown).toContain("postgres-restore");
    const serialized = `${JSON.stringify(report)}\n${markdown}`;
    expect(serialized).not.toContain("postgres://user:secret@host/db");
    expect(serialized).not.toContain("secret@host");
  });

  it("fails without leaking when an artifact contains legal page body text", async () => {
    const leakedBody = "AAIS 只收集运行 Cognitive Apprenticeship 学习流程所需的数据，并以教师可行动、学习者可追踪、机构可审计为边界。";
    const artifactPath = await writeJson("artifact-with-legal-body.json", {
      status: "passed",
      checkedAt: "2026-06-30T10:00:00.000Z",
      rawPageBody: leakedBody,
    });
    const outputPath = path.join(tempDir, "bundle.json");
    const markdownOutputPath = path.join(tempDir, "bundle.md");

    const report = await createAaisReleaseEvidenceBundle({
      vercelEnvReportPath: artifactPath,
      enterpriseReportPath: artifactPath,
      releaseEvidenceReportPath: artifactPath,
      releaseCheckReportPath: artifactPath,
      handoffReportPath: artifactPath,
      readinessAuditReportPath: artifactPath,
      oidcConfigReportPath: artifactPath,
      aiEvalManifestPath: artifactPath,
      postgresRestoreReportPath: artifactPath,
      outputPath,
      markdownOutputPath,
      releaseId: "aais-2026-06-30-rc-live-ai-deepseek-v4-flash",
      now: new Date("2026-06-30T10:30:00.000Z"),
    });

    expect(report).toMatchObject({
      status: "action-required",
      summary: {
        secretScanFailed: 9,
      },
    });
    expect(report.artifacts.find((artifact) => artifact.id === "vercel-env")).toMatchObject({
      secretScan: {
        status: "failed",
        issue: "legal-page-body",
      },
    });
    const serialized = `${JSON.stringify(report)}\n${await readFile(outputPath, "utf8")}\n${await readFile(markdownOutputPath, "utf8")}`;
    expect(serialized).not.toContain(leakedBody);
  });

  it("does not flag required owner placeholders as password secrets", async () => {
    const passedPath = await writeJson("passed.json", {
      status: "passed",
      checkedAt: "2026-06-30T10:00:00.000Z",
    });
    const handoffPath = await writeJson("handoff.json", {
      status: "action-required",
      generatedAt: "2026-06-30T10:04:00.000Z",
      ownerActions: [
        {
          id: "run-teacher-cohort-analytics-smoke",
          command:
            "AAIS_VERIFY_EDUCATOR_ACCOUNT=<REQUIRED:TEACHER_OR_ADMIN_ACCOUNT> AAIS_VERIFY_EDUCATOR_CORRECT_PASSWORD=<REQUIRED:TEACHER_OR_ADMIN_PASSWORD> AAIS_VERIFY_REQUIRE_COHORT_ANALYTICS=true npm run verify:enterprise",
        },
      ],
    });

    const report = await createAaisReleaseEvidenceBundle({
      vercelEnvReportPath: passedPath,
      vercelDeploymentReportPath: passedPath,
      enterpriseReportPath: passedPath,
      releaseEvidenceReportPath: passedPath,
      releaseCheckReportPath: passedPath,
      handoffReportPath: handoffPath,
      readinessAuditReportPath: passedPath,
      oidcConfigReportPath: passedPath,
      aiEvalManifestPath: passedPath,
      postgresRestoreReportPath: passedPath,
      outputPath: path.join(tempDir, "placeholder-bundle.json"),
      markdownOutputPath: path.join(tempDir, "placeholder-bundle.md"),
      releaseId: "aais-2026-06-30-rc-live-ai-deepseek-v4-flash",
      now: new Date("2026-06-30T10:30:00.000Z"),
    });

    expect(report.summary.secretScanFailed).toBe(0);
    expect(report.artifacts.find((artifact) => artifact.id === "enterprise-handoff")).toMatchObject({
      secretScan: {
        status: "passed",
      },
    });
  });

  it("uses environment output paths when explicit output paths are omitted", async () => {
    const reportPath = await writeJson("report.json", {
      status: "passed",
      checkedAt: "2026-06-30T10:00:00.000Z",
    });
    process.env.AAIS_RELEASE_BUNDLE_REPORT_PATH = path.join(tempDir, "env-bundle.json");
    process.env.AAIS_RELEASE_BUNDLE_MARKDOWN_PATH = path.join(tempDir, "env-bundle.md");

    await createAaisReleaseEvidenceBundle({
      sourceProvenanceReportPath: reportPath,
      vercelEnvReportPath: reportPath,
      vercelDeploymentReportPath: reportPath,
      enterpriseReportPath: reportPath,
      releaseEvidenceReportPath: reportPath,
      releaseCheckReportPath: reportPath,
      handoffReportPath: reportPath,
      readinessAuditReportPath: reportPath,
      oidcConfigReportPath: reportPath,
      aiEvalManifestPath: reportPath,
      postgresRestoreReportPath: reportPath,
      now: new Date("2026-06-30T10:45:00.000Z"),
    });

    expect(JSON.parse(await readFile(process.env.AAIS_RELEASE_BUNDLE_REPORT_PATH, "utf8"))).toMatchObject({
      status: "ready",
      summary: {
        total: 11,
        present: 11,
        missing: 0,
        passed: 11,
        actionRequired: 0,
      },
    });
    expect(await readFile(process.env.AAIS_RELEASE_BUNDLE_MARKDOWN_PATH, "utf8")).toContain(
      "AAIS Release Evidence Bundle",
    );
  });
});

async function writeJson(name, value) {
  const filePath = path.join(tempDir, name);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
