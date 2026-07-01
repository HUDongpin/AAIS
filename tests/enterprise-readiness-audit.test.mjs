import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditAaisEnterpriseReadiness } from "../scripts/audit-enterprise-readiness.mjs";

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-enterprise-audit-"));
});

afterEach(async () => {
  delete process.env.AAIS_ENTERPRISE_AUDIT_REPORT_PATH;
  delete process.env.AAIS_ENTERPRISE_AUDIT_MARKDOWN_PATH;
  await rm(tempDir, { force: true, recursive: true });
});

describe("AAIS enterprise readiness audit", () => {
  it("summarizes final gate requirements into a redacted action-required matrix", async () => {
    const releaseCheckReportPath = await writeJson("release-check.json", {
      status: "failed",
      checkedAt: "2026-06-30T09:00:00.000Z",
      release: {
        id: "aais-2026-06-30-rc-live-ai-deepseek-v4-flash",
        consistent: false,
      },
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
            readiness: false,
            securityHeaders: true,
            legalPages: false,
            lrsHealth: true,
            cohortAnalytics: false,
            oidcStart: false,
            oidcCallback: false,
            ssoOnlyMode: true,
          },
          evidenceOrder: {
            enterpriseAfterVercelEnv: true,
            enterpriseAfterVercelDeployment: true,
          },
          artifactCoalescing: {
            readiness: false,
            lrsHealth: false,
            complete: false,
          },
          readiness: {
            releaseIdMatchesExpected: false,
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
        vercelConfig: {
          status: "failed",
          path: "/api/learning/lrs/outbox/flush",
          cronCount: 0,
          outboxCronPresent: false,
          outboxCronDaily: false,
          secretScanStatus: "passed",
        },
      },
      leakedSecret: "postgres://user:secret@host/db",
    });
    const handoffReportPath = await writeJson("handoff.json", {
      status: "action-required",
      externalActions: [
        { id: "fill-private-env-template", status: "required" },
        { id: "set-vercel-production-env", status: "required" },
        { id: "redeploy-vercel-production", status: "required-after-env-change" },
        { id: "inspect-vercel-production-deployment", status: "required-after-production-deploy" },
        { id: "fill-postgres-restore-template", status: "required" },
        { id: "run-neon-restore-rehearsal", status: "required" },
        { id: "run-teacher-cohort-analytics-smoke", status: "required" },
        { id: "run-real-oidc-callback-smoke", status: "required" },
        { id: "rerun-final-gate", status: "required" },
      ],
      sensitiveValue: "oidc-client-secret-value",
    });
    const outputPath = path.join(tempDir, "audit.json");
    const markdownOutputPath = path.join(tempDir, "audit.md");

    const report = await auditAaisEnterpriseReadiness({
      releaseCheckReportPath,
      handoffReportPath,
      outputPath,
      markdownOutputPath,
      now: new Date("2026-06-30T09:30:00.000Z"),
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "action-required",
      generatedAt: "2026-06-30T09:30:00.000Z",
      sourceReports: {
        releaseCheck: releaseCheckReportPath,
        handoff: handoffReportPath,
      },
      summary: {
        total: 17,
        passed: 5,
        actionRequired: 12,
      },
      requiredControls: [
        {
          id: "vercel-production-env",
          status: "action-required",
          missing: [
            "AAIS_DATABASE_URL",
            "AAIS_OIDC_ISSUER",
            "AAIS_OIDC_CLIENT_ID",
            "AAIS_OIDC_CLIENT_SECRET",
            "AAIS_OIDC_REDIRECT_URI",
          ],
          actions: [
            "fill-private-env-template",
            "set-vercel-production-env",
            "redeploy-vercel-production",
            "inspect-vercel-production-deployment",
            "rerun-final-gate",
          ],
        },
        {
          id: "neon-storage-readiness",
          status: "action-required",
          actions: [
            "fill-private-env-template",
            "set-vercel-production-env",
            "redeploy-vercel-production",
            "inspect-vercel-production-deployment",
            "rerun-final-gate",
          ],
        },
        {
          id: "deployment-release-identity",
          status: "action-required",
          actions: [
            "fill-private-env-template",
            "set-vercel-production-env",
            "redeploy-vercel-production",
            "inspect-vercel-production-deployment",
            "rerun-final-gate",
          ],
          note: "Requires deployed /api/system/readiness to report the expected AAIS_RELEASE_ID; Vercel git short SHA is recorded when available.",
        },
        {
          id: "vercel-deployment-ready",
          status: "action-required",
          actions: ["redeploy-vercel-production", "inspect-vercel-production-deployment", "rerun-final-gate"],
          note: "Requires redacted Vercel inspect evidence from the deployment URL returned by vercel deploy --prod -y --no-wait.",
        },
        {
          id: "security-headers",
          status: "passed",
        },
        {
          id: "legal-pages",
          status: "action-required",
          actions: ["redeploy-vercel-production", "inspect-vercel-production-deployment", "rerun-final-gate"],
          note: "Requires deployed /terms and /privacy to return redacted 200/HTML/content-presence evidence.",
        },
        {
          id: "lrs-health",
          status: "passed",
        },
        {
          id: "scheduled-outbox-drain",
          status: "action-required",
          actions: ["redeploy-vercel-production", "inspect-vercel-production-deployment", "rerun-final-gate"],
          note: "Requires final release evidence to prove the daily Vercel Cron drain for /api/learning/lrs/outbox/flush.",
        },
        {
          id: "artifact-event-coalescing",
          status: "action-required",
          actions: ["redeploy-vercel-production", "inspect-vercel-production-deployment", "rerun-final-gate"],
        },
        {
          id: "cohort-analytics",
          status: "action-required",
          actions: ["run-teacher-cohort-analytics-smoke", "rerun-final-gate"],
          note: "Requires teacher/admin cohort analytics and cohort export proof from the same OIDC callback session.",
        },
        {
          id: "oidc-start",
          status: "action-required",
          actions: [
            "fill-private-env-template",
            "set-vercel-production-env",
            "redeploy-vercel-production",
            "inspect-vercel-production-deployment",
            "rerun-final-gate",
          ],
        },
        {
          id: "oidc-callback-handoff",
          status: "action-required",
          actions: ["run-real-oidc-callback-smoke", "rerun-final-gate"],
        },
        {
          id: "sso-only-mode",
          status: "passed",
        },
        {
          id: "live-ai-eval",
          status: "passed",
        },
        {
          id: "neon-restore-rehearsal",
          status: "action-required",
          actions: ["fill-postgres-restore-template", "run-neon-restore-rehearsal", "rerun-final-gate"],
        },
        {
          id: "evidence-order",
          status: "passed",
        },
        {
          id: "release-consistency",
          status: "action-required",
          actions: [
            "fill-postgres-restore-template",
            "run-neon-restore-rehearsal",
            "run-real-oidc-callback-smoke",
            "rerun-final-gate",
          ],
        },
      ],
      redaction: {
        secrets: "omitted",
        values: "not-read",
      },
    });
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(report);
    const markdown = await readFile(markdownOutputPath, "utf8");
    expect(markdown).toContain("AAIS Enterprise Readiness Audit");
    expect(markdown).toContain("vercel-production-env");
    expect(markdown).toContain("deployment-release-identity");
    expect(markdown).toContain("run-neon-restore-rehearsal");
    expect(markdown).toContain("cohort export proof");
    const serialized = `${JSON.stringify(report)}\n${markdown}`;
    expect(serialized).not.toContain("postgres://user:secret@host/db");
    expect(serialized).not.toContain("oidc-client-secret-value");
  });

  it("uses environment output paths when explicit output paths are omitted", async () => {
    const releaseCheckReportPath = await writeJson("release-check.json", {
      status: "passed",
      checkedAt: "2026-06-30T09:00:00.000Z",
      release: {
        consistent: true,
      },
      artifacts: {
        vercelEnv: {
          status: "passed",
          missingCount: 0,
          missing: [],
        },
        vercelDeployment: {
          status: "passed",
          readyState: "READY",
          urlMatchesExpected: true,
          targetMatchesProduction: true,
        },
        enterprise: {
          status: "passed",
          requiredChecks: {
            readiness: true,
            securityHeaders: true,
            legalPages: true,
            lrsHealth: true,
            cohortAnalytics: true,
            oidcStart: true,
            oidcCallback: true,
            ssoOnlyMode: true,
          },
          evidenceOrder: {
            enterpriseAfterVercelEnv: true,
            enterpriseAfterVercelDeployment: true,
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
        aiEval: {
          status: "passed",
          compatibleWithEnterpriseReadiness: true,
          blockedCount: 0,
          modelFingerprintMatchesEnterprise: true,
        },
        postgresRestore: {
          status: "passed",
          targetPurpose: "restored-staging",
          sameAsSource: false,
          tablePresent: true,
          lrsOutboxTablePresent: true,
          smokeInserted: true,
          smokeReadBack: true,
          smokeDeleted: true,
        },
        vercelConfig: {
          status: "passed",
          path: "/api/learning/lrs/outbox/flush",
          cronCount: 1,
          outboxCronPresent: true,
          outboxCronDaily: true,
          secretScanStatus: "passed",
        },
      },
    });
    process.env.AAIS_ENTERPRISE_AUDIT_REPORT_PATH = path.join(tempDir, "env-audit.json");
    process.env.AAIS_ENTERPRISE_AUDIT_MARKDOWN_PATH = path.join(tempDir, "env-audit.md");

    await auditAaisEnterpriseReadiness({
      releaseCheckReportPath,
      handoffReportPath: releaseCheckReportPath,
      now: new Date("2026-06-30T09:45:00.000Z"),
    });

    expect(JSON.parse(await readFile(process.env.AAIS_ENTERPRISE_AUDIT_REPORT_PATH, "utf8"))).toMatchObject({
      status: "ready",
      summary: {
        total: 17,
        passed: 17,
        actionRequired: 0,
      },
    });
    expect(await readFile(process.env.AAIS_ENTERPRISE_AUDIT_MARKDOWN_PATH, "utf8")).toContain(
      "AAIS Enterprise Readiness Audit",
    );
  });

  it("points SSO-only runtime failures to the SSO-only owner action", async () => {
    const releaseCheckReportPath = await writeJson("release-check.json", {
      status: "failed",
      checkedAt: "2026-06-30T09:00:00.000Z",
      release: {
        consistent: true,
      },
      artifacts: {
        vercelEnv: {
          status: "passed",
          missingCount: 0,
          missing: [],
        },
        enterprise: {
          status: "failed",
          requiredChecks: {
            readiness: true,
            securityHeaders: true,
            legalPages: true,
            lrsHealth: true,
            cohortAnalytics: true,
            oidcStart: true,
            oidcCallback: true,
            ssoOnlyMode: false,
          },
          evidenceOrder: {
            enterpriseAfterVercelEnv: true,
            enterpriseAfterVercelDeployment: true,
          },
          readiness: {
            releaseIdMatchesExpected: true,
          },
        },
        aiEval: {
          status: "passed",
          compatibleWithEnterpriseReadiness: true,
          blockedCount: 0,
          modelFingerprintMatchesEnterprise: true,
        },
        postgresRestore: {
          status: "passed",
          targetPurpose: "restored-staging",
          sameAsSource: false,
          tablePresent: true,
          lrsOutboxTablePresent: true,
          smokeInserted: true,
          smokeReadBack: true,
          smokeDeleted: true,
        },
      },
    });
    const handoffReportPath = await writeJson("handoff.json", {
      status: "action-required",
      externalActions: [
        { id: "run-real-oidc-callback-smoke", status: "required" },
        { id: "set-sso-only-runtime-mode", status: "required-after-sso-verification" },
        { id: "redeploy-vercel-production-after-sso-only", status: "required-after-sso-only-change" },
        { id: "inspect-vercel-production-deployment-after-sso-only", status: "required-after-production-deploy" },
        { id: "rerun-final-gate", status: "required" },
      ],
    });

    const report = await auditAaisEnterpriseReadiness({
      releaseCheckReportPath,
      handoffReportPath,
      outputPath: path.join(tempDir, "audit.json"),
      markdownOutputPath: path.join(tempDir, "audit.md"),
      now: new Date("2026-06-30T10:00:00.000Z"),
    });

    expect(report.requiredControls.find((control) => control.id === "sso-only-mode")).toEqual({
      id: "sso-only-mode",
      status: "action-required",
      actions: [
        "run-real-oidc-callback-smoke",
        "set-sso-only-runtime-mode",
        "redeploy-vercel-production-after-sso-only",
        "inspect-vercel-production-deployment-after-sso-only",
        "rerun-final-gate",
      ],
    });
  });

  it("does not mark Neon storage as action-required when only OIDC is blocking readiness", async () => {
    const releaseCheckReportPath = await writeJson("release-check.json", {
      status: "failed",
      checkedAt: "2026-06-30T09:00:00.000Z",
      release: {
        consistent: false,
      },
      artifacts: {
        vercelEnv: {
          status: "failed",
          missingCount: 4,
          missing: [
            "AAIS_OIDC_ISSUER",
            "AAIS_OIDC_CLIENT_ID",
            "AAIS_OIDC_CLIENT_SECRET",
            "AAIS_OIDC_REDIRECT_URI",
          ],
        },
        enterprise: {
          status: "failed",
          readiness: {
            storagePostgresConnected: true,
            storageProvider: "neon",
            issueCount: 1,
            releaseIdMatchesExpected: false,
          },
          requiredChecks: {
            readiness: false,
            securityHeaders: true,
            legalPages: true,
            lrsHealth: true,
            cohortAnalytics: true,
            oidcStart: false,
            oidcCallback: false,
            ssoOnlyMode: false,
          },
          evidenceOrder: {
            enterpriseAfterVercelEnv: true,
            enterpriseAfterVercelDeployment: true,
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
    });
    const handoffReportPath = await writeJson("handoff.json", {
      status: "action-required",
      externalActions: [
        { id: "fill-private-env-template", status: "required" },
        { id: "set-vercel-production-env", status: "required" },
        { id: "redeploy-vercel-production", status: "required-after-env-change" },
        { id: "inspect-vercel-production-deployment", status: "required-after-production-deploy" },
        { id: "fill-postgres-restore-template", status: "required" },
        { id: "run-neon-restore-rehearsal", status: "required" },
        { id: "run-real-oidc-callback-smoke", status: "required" },
        { id: "set-sso-only-runtime-mode", status: "required-after-sso-verification" },
        { id: "redeploy-vercel-production-after-sso-only", status: "required-after-sso-only-change" },
        { id: "inspect-vercel-production-deployment-after-sso-only", status: "required-after-production-deploy" },
        { id: "rerun-final-gate", status: "required" },
      ],
    });

    const report = await auditAaisEnterpriseReadiness({
      releaseCheckReportPath,
      handoffReportPath,
      outputPath: path.join(tempDir, "audit.json"),
      markdownOutputPath: path.join(tempDir, "audit.md"),
      now: new Date("2026-06-30T10:15:00.000Z"),
    });

    expect(report.requiredControls.find((control) => control.id === "neon-storage-readiness")).toEqual({
      id: "neon-storage-readiness",
      status: "passed",
    });
  });
});

async function writeJson(name, value) {
  const filePath = path.join(tempDir, name);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}
