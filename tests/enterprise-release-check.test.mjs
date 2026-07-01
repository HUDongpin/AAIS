import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAaisEnterpriseReleaseCheck } from "../scripts/run-enterprise-release-check.mjs";

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-enterprise-release-check-"));
});

afterEach(async () => {
  await rm(tempDir, { force: true, recursive: true });
});

describe("AAIS enterprise release check runner", () => {
  it("runs Vercel env, enterprise smoke, and final evidence in order with redacted summary output", async () => {
    const calls = [];
    const sourceProvenanceReportPath = path.join(tempDir, "source-provenance.json");
    const vercelEnvReportPath = path.join(tempDir, "vercel-env.json");
    const vercelDeploymentReportPath = path.join(tempDir, "vercel-deployment.json");
    const enterpriseReportPath = path.join(tempDir, "enterprise.json");
    const releaseEvidenceReportPath = path.join(tempDir, "release-evidence.json");
    const vercelConfigPath = path.join(tempDir, "vercel.json");
    const outputPath = path.join(tempDir, "release-check.json");

    const report = await runAaisEnterpriseReleaseCheck({
      baseUrl: "https://aais-six.vercel.app",
      releaseId: "aais-2026-06-30-rc1",
      deploymentGitCommit: "0123456789abcdef0123456789abcdef01234567",
      aiEvalManifestPath: path.join(tempDir, "ai-eval.json"),
      postgresRestoreReportPath: path.join(tempDir, "restore.json"),
      vercelConfigPath,
      sourceProvenanceReportPath,
      vercelEnvReportPath,
      vercelDeploymentReportPath,
      enterpriseReportPath,
      releaseEvidenceReportPath,
      outputPath,
      educatorLogin: {
        account: "teacher-a",
        correctPassword: "teacher-password-that-must-not-leak",
      },
      now: new Date("2026-06-30T08:00:00.000Z"),
      sourceProvenanceVerifier: async (input) => {
        calls.push(["source-provenance", input]);
        return {
          status: "passed",
          source: {
            gitHeadPresent: true,
            gitCommitShortSha: "0123456789ab",
            clean: true,
          },
        };
      },
      vercelEnvVerifier: async (input) => {
        calls.push(["vercel-env", input]);
        return {
          status: "passed",
          required: {
            missing: [],
          },
          rawSecret: "AAIS_OIDC_CLIENT_SECRET_VALUE_SHOULD_NOT_APPEAR",
        };
      },
      vercelDeploymentVerifier: async (input) => {
        calls.push(["vercel-deployment", input]);
        return {
          status: "passed",
          deployment: {
            readyState: "READY",
            target: "production",
            urlMatchesExpected: true,
            targetMatchesProduction: true,
            gitCommitShortSha: "0123456789ab",
          },
        };
      },
      enterpriseVerifier: async (input) => {
        calls.push(["enterprise", input]);
        return {
          status: "passed",
          checks: [
            {
              name: "readiness",
              status: "passed",
              details: {
                storagePostgresConnected: true,
                storageProvider: "neon",
                issueCount: 0,
              },
            },
            { name: "oidc-start", status: "passed" },
            { name: "sso-only-mode", status: "passed" },
          ],
          rawCookie: "aais_session=session-secret-cookie",
        };
      },
      releaseEvidenceVerifier: async (input) => {
        calls.push(["release-evidence", input]);
        return {
          status: "passed",
          release: {
            id: "aais-2026-06-30-rc1",
            consistent: true,
          },
          artifacts: {
            sourceProvenance: {
              status: "passed",
              source: {
                gitHeadPresent: true,
                gitCommitShortSha: "0123456789ab",
                clean: true,
                gitCommitMatchesDeployment: true,
              },
            },
            vercelEnv: {
              status: "passed",
              missingCount: 0,
              missing: [],
            },
            vercelDeployment: {
              status: "passed",
              deployment: {
                readyState: "READY",
                target: "production",
                urlMatchesExpected: true,
                targetMatchesProduction: true,
                gitCommitShortSha: "0123456789ab",
              },
            },
            enterprise: {
              status: "passed",
              evidenceOrder: {
                enterpriseAfterVercelEnv: true,
                enterpriseAfterVercelDeployment: true,
              },
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
              lrsOutboxEvidence: {
                artifactCoalescingComplete: true,
              },
              lrsHealthEvidence: {
                artifactCoalescingComplete: true,
              },
            },
            aiEval: {
              status: "passed",
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
              outboxCronSchedule: "7 3 * * *",
              outboxCronDaily: true,
              secretScan: {
                status: "passed",
              },
            },
          },
          providerSecret: "sk-live-secret-like-value",
        };
      },
    });

    expect(calls.map(([name]) => name)).toEqual([
      "source-provenance",
      "vercel-env",
      "vercel-deployment",
      "enterprise",
      "release-evidence",
    ]);
    expect(calls[0][1]).toMatchObject({
      releaseId: "aais-2026-06-30-rc1",
      outputPath: sourceProvenanceReportPath,
    });
    expect(calls[1][1]).toMatchObject({
      environment: "production",
      authMode: "sso-only",
      aiMode: "live",
      outputPath: vercelEnvReportPath,
    });
    expect(calls[2][1]).toMatchObject({
      deploymentUrl: "https://aais-six.vercel.app",
      releaseId: "aais-2026-06-30-rc1",
      deploymentGitCommit: "0123456789abcdef0123456789abcdef01234567",
      outputPath: vercelDeploymentReportPath,
    });
    expect(calls[3][1]).toMatchObject({
      baseUrl: "https://aais-six.vercel.app",
      releaseId: "aais-2026-06-30-rc1",
      requireSsoOnly: true,
      requireCohortAnalytics: true,
      educatorLogin: {
        account: "teacher-a",
        correctPassword: "teacher-password-that-must-not-leak",
      },
      outputPath: enterpriseReportPath,
    });
    expect(calls[4][1]).toMatchObject({
      releaseId: "aais-2026-06-30-rc1",
      sourceProvenanceReportPath,
      vercelEnvReportPath,
      vercelDeploymentReportPath,
      enterpriseReportPath,
      aiEvalManifestPath: path.join(tempDir, "ai-eval.json"),
      postgresRestoreReportPath: path.join(tempDir, "restore.json"),
      vercelConfigPath,
      outputPath: releaseEvidenceReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
    });
    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "passed",
      checkedAt: "2026-06-30T08:00:00.000Z",
      sequence: [
        { name: "source-provenance", status: "passed", outputPath: sourceProvenanceReportPath },
        { name: "vercel-env", status: "passed", outputPath: vercelEnvReportPath },
        { name: "vercel-deployment", status: "passed", outputPath: vercelDeploymentReportPath },
        { name: "enterprise-smoke", status: "passed", outputPath: enterpriseReportPath },
        { name: "release-evidence", status: "passed", outputPath: releaseEvidenceReportPath },
      ],
      gate: {
        source: "release-evidence",
        passed: true,
      },
      artifacts: {
        sourceProvenance: {
          status: "passed",
          gitHeadPresent: true,
          gitCommitShortSha: "0123456789ab",
          clean: true,
          gitCommitMatchesDeployment: true,
        },
        vercelEnv: {
          status: "passed",
          missingCount: 0,
          missing: [],
        },
        vercelDeployment: {
          status: "passed",
          readyState: "READY",
          target: "production",
          urlMatchesExpected: true,
          targetMatchesProduction: true,
          gitCommitShortSha: "0123456789ab",
        },
        enterprise: {
          status: "passed",
          readiness: {
            storagePostgresConnected: true,
            storageProvider: "neon",
            issueCount: 0,
          },
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
          artifactCoalescing: {
            readiness: true,
            lrsHealth: true,
            complete: true,
          },
          evidenceOrder: {
            enterpriseAfterVercelEnv: true,
            enterpriseAfterVercelDeployment: true,
          },
        },
        aiEval: {
          status: "passed",
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
          outboxCronSchedule: "7 3 * * *",
          outboxCronDaily: true,
          secretScanStatus: "passed",
        },
      },
      redaction: {
        secrets: "omitted",
        cookies: "attributes-only",
        values: "not-read",
      },
    });
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(report);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("AAIS_OIDC_CLIENT_SECRET_VALUE_SHOULD_NOT_APPEAR");
    expect(serialized).not.toContain("session-secret-cookie");
    expect(serialized).not.toContain("sk-live-secret-like-value");
  });

  it("fails the gate when final release evidence fails after earlier checks ran", async () => {
    const sourceProvenanceReportPath = path.join(tempDir, "source-provenance.json");
    const report = await runAaisEnterpriseReleaseCheck({
      baseUrl: "https://aais-six.vercel.app",
      releaseId: "aais-2026-06-30-rc1",
      deploymentGitCommit: "0123456789abcdef0123456789abcdef01234567",
      sourceProvenanceReportPath,
      vercelEnvReportPath: path.join(tempDir, "vercel-env.json"),
      enterpriseReportPath: path.join(tempDir, "enterprise.json"),
      releaseEvidenceReportPath: path.join(tempDir, "release-evidence.json"),
      outputPath: path.join(tempDir, "release-check.json"),
      now: new Date("2026-06-30T08:30:00.000Z"),
      sourceProvenanceVerifier: async () => ({
        status: "passed",
        source: {
          gitHeadPresent: true,
          gitCommitShortSha: "0123456789ab",
          clean: true,
        },
      }),
      vercelEnvVerifier: async () => ({
        status: "passed",
        required: {
          missing: [],
        },
      }),
      vercelDeploymentVerifier: async () => ({
        status: "passed",
      }),
      enterpriseVerifier: async () => ({
        status: "passed",
      }),
      releaseEvidenceVerifier: async () => ({
        status: "failed",
        artifacts: {
          sourceProvenance: {
            status: "passed",
            source: {
              gitHeadPresent: true,
              gitCommitShortSha: "0123456789ab",
              clean: true,
              gitCommitMatchesDeployment: true,
            },
          },
          vercelEnv: {
            status: "failed",
            missingCount: 1,
            missing: ["AAIS_DATABASE_URL"],
          },
          enterprise: {
            status: "failed",
            evidenceOrder: {
              enterpriseAfterVercelEnv: true,
              enterpriseAfterVercelDeployment: true,
            },
            requiredChecks: {
              readiness: false,
              securityHeaders: true,
              legalPages: false,
              lrsHealth: false,
              oidcStart: false,
              oidcCallback: false,
              ssoOnlyMode: true,
            },
            lrsOutboxEvidence: {
              artifactCoalescingComplete: false,
            },
            lrsHealthEvidence: {
              artifactCoalescingComplete: false,
            },
          },
          aiEval: {
            status: "passed",
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
            secretScan: {
              status: "passed",
            },
          },
        },
      }),
    });

    expect(report.status).toBe("failed");
    expect(report.gate).toEqual({
      source: "release-evidence",
      passed: false,
      finalStatus: "failed",
    });
    expect(report.artifacts.vercelEnv).toEqual({
      status: "failed",
      missingCount: 1,
      missing: ["AAIS_DATABASE_URL"],
    });
    expect(report.artifacts.enterprise.requiredChecks.readiness).toBe(false);
    expect(report.artifacts.enterprise.artifactCoalescing).toEqual({
      readiness: false,
      lrsHealth: false,
      complete: false,
    });
    expect(report.artifacts.postgresRestore.status).toBe("missing");
    expect(report.artifacts.vercelConfig).toMatchObject({
      status: "failed",
      path: "/api/learning/lrs/outbox/flush",
      cronCount: 0,
      outboxCronPresent: false,
      outboxCronDaily: false,
      secretScanStatus: "passed",
    });
  });
});
