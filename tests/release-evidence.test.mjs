import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyAaisReleaseEvidence } from "../scripts/verify-release-evidence.mjs";

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-release-evidence-"));
  vi.stubEnv("AAIS_RELEASE_SOURCE_PROVENANCE_REPORT_PATH", path.join(tempDir, "missing-source-provenance.json"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tempDir, { force: true, recursive: true });
});

describe("AAIS release evidence verifier", () => {
  it("writes a passing redacted release evidence report from all required artifacts", async () => {
    const sourceProvenanceReportPath = await writeJson("source-provenance.json", {
      schemaVersion: 1,
      status: "passed",
      checkedAt: "2026-06-30T00:30:00.000Z",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      source: {
        gitHeadPresent: true,
        gitCommitShortSha: "0123456789ab",
        branch: "main",
        clean: true,
        workingTree: {
          total: 0,
          staged: 0,
          unstaged: 0,
          untracked: 0,
        },
        errorCategory: null,
      },
      redaction: {
        secrets: "omitted",
        fileNames: "not-included",
        gitStatus: "counts-only",
      },
    });
    const enterpriseReportPath = await writeJson("enterprise-report.json", {
      status: "passed",
      checkedAt: "2026-06-30T03:00:00.000Z",
      baseUrl: "https://aais-six.vercel.app",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      checks: [
        {
          name: "readiness",
          status: "passed",
          details: passingReadinessDetails(),
        },
        { name: "security-headers", status: "passed" },
        passingLegalPagesCheck(),
        passingLrsHealthCheck(),
        passingOidcCohortAnalyticsCheck(),
        { name: "oidc-start", status: "passed", details: passingOidcStartDetails() },
        passingOidcCallbackCheck(),
        passingSsoOnlyModeCheck(),
        { name: "trial-learning-session", status: "skipped" },
        { name: "trial-login-throttle", status: "skipped" },
      ],
      redaction: {
        secrets: "omitted",
        cookies: "attributes-only",
      },
    });
    const aiEvalManifestPath = await writeJson("ai-eval-manifest.json", passingAiEvalManifest());
    const postgresRestoreReportPath = await writeJson("restore-report.json", {
      schemaVersion: 1,
      status: "passed",
      checkedAt: "2026-06-30T04:00:00.000Z",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      target: {
        databaseUrl: "redacted",
        provider: "neon",
        purpose: "restored-staging",
        sameAsSource: false,
      },
      checks: {
        tablePresent: true,
        lrsOutboxTablePresent: true,
        smokeInsertOnly: true,
        smokeInserted: true,
        smokeReadBack: true,
        smokeDeleted: true,
      },
      redaction: {
        secrets: "omitted",
      },
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport();
    const vercelDeploymentReportPath = await writePassingVercelDeploymentReport();
    const outputPath = path.join(tempDir, "release-evidence.json");

    const report = await verifyAaisReleaseEvidence({
      sourceProvenanceReportPath,
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      vercelDeploymentReportPath,
      authMode: "sso-only",
      outputPath,
      deploymentUrl: "https://aais-six.vercel.app/",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      releaseId: "aais-2026-06-30-rc1",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "passed",
      checkedAt: "2026-06-30T05:00:00.000Z",
      release: {
        id: "aais-2026-06-30-rc1",
        consistent: true,
      },
      artifacts: {
        sourceProvenance: {
          status: "passed",
          reportedStatus: "passed",
          release: {
            id: "aais-2026-06-30-rc1",
            matchesExpected: true,
          },
          source: {
            gitHeadPresent: true,
            gitCommitShortSha: "0123456789ab",
            clean: true,
            gitCommitMatchesDeployment: true,
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
        },
        vercelEnv: {
          status: "passed",
          reportedStatus: "passed",
          target: {
            environment: "Production",
            expectedEnvironment: "Production",
            environmentMatchesExpected: true,
            authMode: "sso-only",
            expectedAuthMode: "sso-only",
            authModeMatchesExpected: true,
            aiMode: "live",
            expectedAiMode: "live",
            aiModeMatchesExpected: true,
          },
          missingCount: 0,
          freshness: {
            timestamp: "2026-06-30T02:30:00.000Z",
            withinMaxAge: true,
          },
          secretScan: {
            status: "passed",
          },
          redaction: {
            secrets: "omitted",
            values: "not-read",
          },
        },
        vercelDeployment: {
          status: "passed",
          reportedStatus: "passed",
          release: {
            id: "aais-2026-06-30-rc1",
            matchesExpected: true,
          },
          deployment: {
            url: "https://aais-six.vercel.app",
            expectedUrl: "https://aais-six.vercel.app",
            expectedDeploymentUrl: "https://aais-six.vercel.app",
            urlMatchesExpected: true,
            readyState: "READY",
            target: "production",
            targetMatchesProduction: true,
            gitCommitShortSha: "0123456789ab",
          },
          inspectSecretScan: "passed",
          redaction: {
            secrets: "omitted",
            rawInspectOutput: "not-stored",
            values: "summarized",
          },
        },
        enterprise: {
          status: "passed",
          deployment: {
            baseUrl: "https://aais-six.vercel.app",
            expectedBaseUrl: "https://aais-six.vercel.app",
            matchesExpected: true,
          },
          storageProvider: {
            value: "neon",
            expected: "neon",
            matchesExpected: true,
          },
          deploymentPlatform: {
            value: "vercel",
            expected: "vercel",
            matchesExpected: true,
            vercelRequestIdPresent: true,
          },
          release: {
            id: "aais-2026-06-30-rc1",
            matchesExpected: true,
          },
          requiredChecks: {
            readiness: true,
            securityHeaders: true,
            legalPages: true,
            lrsHealth: true,
            agentEvidence: true,
            a2Monitoring: true,
            cohortAnalytics: true,
            oidcStart: true,
            oidcCallback: true,
            ssoOnlyMode: true,
          },
          optionalChecks: {
            trialLearningSession: "skipped",
            trialLoginThrottle: "skipped",
          },
          ssoOnlyEvidence: {
            trialLearningSessionSkipped: true,
            trialLoginThrottleSkipped: true,
            trialChecksSkipped: true,
          },
          lrsOutboxEvidence: {
            mode: "persistent",
            storage: "postgres",
            metricsPresent: true,
            artifactCoalescing: {
              enabled: true,
              windowSeconds: 30,
              events: ["artifact_saved", "artifact_edited", "planning_submitted"],
            },
            artifactCoalescingComplete: true,
            complete: true,
          },
          lrsHealthEvidence: {
            outboxMode: "persistent",
            outboxStorage: "postgres",
            outboxMetricsPresent: true,
            outboxRedaction: "redacted",
            artifactCoalescing: {
              enabled: true,
              windowSeconds: 30,
              events: ["artifact_saved", "artifact_edited", "planning_submitted"],
            },
            artifactCoalescingComplete: true,
            complete: true,
          },
          legalPagesEvidence: {
            termsStatus: 200,
            termsHtml: true,
            termsContentPresent: true,
            privacyStatus: 200,
            privacyHtml: true,
            privacyContentPresent: true,
            redaction: "redacted",
            complete: true,
          },
          freshness: {
            timestamp: "2026-06-30T03:00:00.000Z",
            withinMaxAge: true,
          },
          evidenceOrder: {
            enterpriseCheckedAt: "2026-06-30T03:00:00.000Z",
            vercelEnvCheckedAt: "2026-06-30T02:30:00.000Z",
            vercelDeploymentCheckedAt: "2026-06-30T02:45:00.000Z",
            enterpriseAfterVercelEnv: true,
            enterpriseAfterVercelDeployment: true,
          },
        },
        aiEval: {
          status: "passed",
          provider: "openai-compatible",
          release: {
            id: "aais-2026-06-30-rc1",
            matchesExpected: true,
          },
          sampleCount: 4,
          blockedCount: 0,
          compatibleWithEnterpriseReadiness: true,
          modelFingerprint: {
            value: modelFingerprint("enterprise-model"),
            enterpriseValue: modelFingerprint("enterprise-model"),
            matchesEnterprise: true,
          },
          freshness: {
            timestamp: "2026-06-30T01:00:00.000Z",
            withinMaxAge: true,
          },
        },
        postgresRestore: {
          status: "passed",
          provider: {
            value: "neon",
            expected: "neon",
            matchesExpected: true,
          },
          release: {
            id: "aais-2026-06-30-rc1",
            matchesExpected: true,
          },
          sameAsSource: false,
          targetPurpose: "restored-staging",
          tablePresent: true,
          lrsOutboxTablePresent: true,
          smokeInsertOnly: true,
          smokeInserted: true,
          smokeReadBack: true,
          smokeDeleted: true,
          freshness: {
            timestamp: "2026-06-30T04:00:00.000Z",
            withinMaxAge: true,
          },
        },
        vercelConfig: {
          status: "passed",
          path: "/api/learning/lrs/outbox/flush",
          outboxCronPresent: true,
          outboxCronSchedule: "7 3 * * *",
          outboxCronDaily: true,
          secretScan: {
            status: "passed",
          },
          redaction: {
            secrets: "omitted",
            values: "not-read",
          },
        },
      },
      redaction: {
        secrets: "omitted",
        cookies: "attributes-only",
        prompts: "summarized",
      },
    });
    const written = JSON.parse(await readFile(outputPath, "utf8"));
    expect(written).toEqual(report);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("real-auth-code");
    expect(serialized).not.toContain("real-state-cookie");
    expect(serialized).not.toContain("restore-secret");
    expect(serialized).not.toContain("provider reply");
    expect(serialized).not.toContain("enterprise-model");
  });

  it("fails restore evidence without restored-staging purpose and LRS outbox schema proof", async () => {
    const {
      sourceProvenanceReportPath,
      enterpriseReportPath,
      vercelDeploymentReportPath,
      aiEvalManifestPath,
    } = await writePassingReleaseArtifacts();
    const postgresRestoreReportPath = await writeJson("restore-report.json", {
      schemaVersion: 1,
      status: "passed",
      checkedAt: "2026-06-30T04:00:00.000Z",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      target: {
        databaseUrl: "redacted",
        provider: "neon",
        sameAsSource: false,
      },
      checks: {
        tablePresent: true,
        smokeInsertOnly: true,
        smokeInserted: true,
        smokeReadBack: true,
        smokeDeleted: true,
      },
      redaction: {
        secrets: "omitted",
      },
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport();

    const report = await verifyAaisReleaseEvidence({
      sourceProvenanceReportPath,
      enterpriseReportPath,
      vercelDeploymentReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      releaseId: "aais-2026-06-30-rc1",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.postgresRestore).toMatchObject({
      status: "failed",
      targetPurpose: "invalid",
      tablePresent: true,
      lrsOutboxTablePresent: false,
      smokeInsertOnly: true,
      smokeInserted: true,
      smokeReadBack: true,
      smokeDeleted: true,
    });
  });

  it("fails restore evidence when the smoke write does not prove insert-only behavior", async () => {
    const {
      sourceProvenanceReportPath,
      enterpriseReportPath,
      vercelDeploymentReportPath,
      aiEvalManifestPath,
    } = await writePassingReleaseArtifacts();
    const postgresRestoreReportPath = await writeJson("restore-report.json", {
      schemaVersion: 1,
      status: "passed",
      checkedAt: "2026-06-30T04:00:00.000Z",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      target: {
        databaseUrl: "redacted",
        provider: "neon",
        purpose: "restored-staging",
        sameAsSource: false,
      },
      checks: {
        tablePresent: true,
        lrsOutboxTablePresent: true,
        smokeInserted: true,
        smokeReadBack: true,
        smokeDeleted: true,
      },
      redaction: {
        secrets: "omitted",
      },
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport();

    const report = await verifyAaisReleaseEvidence({
      sourceProvenanceReportPath,
      enterpriseReportPath,
      vercelDeploymentReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      releaseId: "aais-2026-06-30-rc1",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.postgresRestore).toMatchObject({
      status: "failed",
      targetPurpose: "restored-staging",
      tablePresent: true,
      lrsOutboxTablePresent: true,
      smokeInsertOnly: false,
      smokeInserted: true,
      smokeReadBack: true,
      smokeDeleted: true,
    });
  });

  it("fails final release evidence when the Vercel Cron outbox drain is missing", async () => {
    const {
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts();
    const vercelEnvReportPath = await writePassingVercelEnvReport();
    const vercelConfigPath = await writeJson("vercel-without-outbox-cron.json", {
      crons: [
        {
          path: "/api/other",
          schedule: "7 3 * * *",
        },
      ],
    });

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      vercelConfigPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.vercelConfig).toMatchObject({
      status: "failed",
      path: "/api/learning/lrs/outbox/flush",
      cronCount: 1,
      outboxCronPresent: false,
      outboxCronSchedule: null,
      outboxCronDaily: false,
      secretScan: {
        status: "passed",
      },
    });
  });

  it("fails final release evidence when the Vercel Cron outbox drain is not daily", async () => {
    const {
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts();
    const vercelEnvReportPath = await writePassingVercelEnvReport();
    const vercelConfigPath = await writeJson("vercel-hourly-outbox-cron.json", {
      crons: [
        {
          path: "/api/learning/lrs/outbox/flush",
          schedule: "0 * * * *",
        },
      ],
    });

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      vercelConfigPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.vercelConfig).toMatchObject({
      status: "failed",
      path: "/api/learning/lrs/outbox/flush",
      cronCount: 1,
      outboxCronPresent: true,
      outboxCronSchedule: "0 * * * *",
      outboxCronDaily: false,
      secretScan: {
        status: "passed",
      },
    });
  });

  it("fails when cohort analytics evidence lacks filtered pseudonymous aggregate proof", async () => {
    const {
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts();
    const enterpriseReportPath = await writeJson("enterprise-report-with-weak-cohort-analytics.json", {
      status: "passed",
      checkedAt: "2026-06-30T03:00:00.000Z",
      baseUrl: "https://aais-six.vercel.app",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      checks: [
        {
          name: "readiness",
          status: "passed",
          details: {
            aiProvider: "openai-compatible",
            aiEvalVersion: "eval-2026-06-30",
            aiEvalManifest: "verified",
            aiModelFingerprint: modelFingerprint("enterprise-model"),
            storageProvider: "neon",
            deploymentPlatform: "vercel",
            vercelRequestIdPresent: true,
          },
        },
        { name: "security-headers", status: "passed" },
        passingLegalPagesCheck(),
        passingLrsHealthCheck(),
        {
          name: "cohort-analytics",
          status: "passed",
          details: {
            loginStatus: 200,
            educatorRoleAccepted: true,
            analyticsStatus: 200,
            filtersApplied: false,
            learnerRows: 1,
            learnerKeysPseudonymous: false,
            sessionKeysPseudonymous: false,
            aggregateCountsPresent: true,
            riskBreakdownPresent: false,
            learnerRiskLevelsPresent: false,
            priorityReasonsStable: false,
            factLayerLrs: true,
            privacyPseudonymous: true,
            noRawLearnerText: false,
            secrets: "redacted",
          },
        },
        { name: "oidc-start", status: "passed", details: passingOidcStartDetails() },
        passingOidcCallbackCheck(),
        { name: "sso-only-mode", status: "passed" },
        { name: "trial-learning-session", status: "skipped" },
        { name: "trial-login-throttle", status: "skipped" },
      ],
      redaction: {
        secrets: "omitted",
        cookies: "attributes-only",
      },
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport();

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      authMode: "sso-only",
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.enterprise).toMatchObject({
      status: "failed",
      requiredChecks: {
        cohortAnalytics: false,
      },
      cohortAnalyticsEvidence: {
        filtersApplied: false,
        learnerKeysPseudonymous: false,
        sessionKeysPseudonymous: false,
        noRawLearnerText: false,
        aggregateProofComplete: false,
        riskBreakdownPresent: false,
        learnerRiskLevelsPresent: false,
        priorityReasonsStable: false,
      },
    });
  });

  it("fails when legal page evidence is incomplete", async () => {
    const {
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts({
      legalPagesCheck: passingLegalPagesCheck({
        privacyContentPresent: false,
      }),
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport();

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.enterprise).toMatchObject({
      status: "failed",
      requiredChecks: {
        legalPages: false,
      },
      legalPagesEvidence: {
        termsStatus: 200,
        termsContentPresent: true,
        privacyStatus: 200,
        privacyContentPresent: false,
        redaction: "redacted",
        complete: false,
      },
    });
  });

  it("accepts SSO-only cohort analytics proven by an OIDC callback educator session", async () => {
    const {
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts({
      cohortCheck: passingOidcCohortAnalyticsCheck(),
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport();

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("passed");
    expect(report.artifacts.enterprise).toMatchObject({
      requiredChecks: {
        cohortAnalytics: true,
      },
      cohortAnalyticsEvidence: {
        authSource: "oidc-callback",
        authSessionEstablished: true,
        aggregateProofComplete: true,
        exportProofComplete: true,
        riskBreakdownPresent: true,
        learnerRiskLevelsPresent: true,
        priorityReasonsStable: true,
      },
      releaseIdentityEvidence: {
        releaseId: "aais-2026-06-30-rc1",
        expectedReleaseId: "aais-2026-06-30-rc1",
        releaseIdMatchesExpected: true,
        releaseIdentityComplete: true,
        complete: true,
      },
    });
  });

  it("fails final evidence when the OIDC callback session role does not match the expected educator role", async () => {
    const oidcCallbackCheck = passingOidcCallbackCheck();
    oidcCallbackCheck.details.learningSessionRole = "student";
    oidcCallbackCheck.details.learningSessionEducatorRole = false;
    oidcCallbackCheck.details.learningSessionRoleMatchesExpected = false;
    const {
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts({
      oidcCallbackCheck,
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport();

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.enterprise).toMatchObject({
      status: "failed",
      requiredChecks: {
        oidcCallback: false,
      },
      oidcCallbackEvidence: {
        learningSessionRole: "student",
        learningSessionEducatorRole: false,
        expectedSessionRole: "teacher",
        learningSessionRoleMatchesExpected: false,
        learningSessionHandoffComplete: false,
      },
    });
  });

  it("fails final evidence when cohort analytics lacks teacher/admin OIDC role-match proof", async () => {
    const cohortCheck = passingOidcCohortAnalyticsCheck();
    cohortCheck.details.educatorSessionRole = "student";
    cohortCheck.details.educatorSessionRoleEvidence = false;
    cohortCheck.details.educatorSessionRoleMatchesExpected = false;
    const {
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts({
      cohortCheck,
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport();

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.enterprise).toMatchObject({
      status: "failed",
      requiredChecks: {
        cohortAnalytics: false,
      },
      cohortAnalyticsEvidence: {
        authSource: "oidc-callback",
        educatorSessionRole: "student",
        educatorSessionRoleEvidence: false,
        expectedSessionRole: "teacher",
        educatorSessionRoleMatchesExpected: false,
        ssoOnlyEducatorProofComplete: false,
      },
    });
  });

  it("fails final sso-only release evidence when cohort analytics is proven by trial login", async () => {
    const {
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts({
      cohortCheck: passingCohortAnalyticsCheck(),
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport();

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.enterprise).toMatchObject({
      status: "failed",
      requiredChecks: {
        cohortAnalytics: false,
      },
      cohortAnalyticsEvidence: {
        authSource: "trial-login",
        aggregateProofComplete: true,
        ssoOnlyEducatorProofComplete: false,
      },
    });
  });

  it("fails final release evidence when deployed readiness release id does not match the release", async () => {
    const {
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts({
      readinessDetails: passingReadinessDetails({
        releaseId: "aais-2026-06-29-old",
        expectedReleaseId: "aais-2026-06-30-rc1",
        releaseIdMatchesExpected: false,
        releaseIdentityComplete: false,
      }),
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport();

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.enterprise).toMatchObject({
      requiredChecks: {
        readiness: false,
      },
      releaseIdentityEvidence: {
        releaseId: "aais-2026-06-29-old",
        expectedReleaseId: "aais-2026-06-30-rc1",
        releaseIdMatchesExpected: false,
        releaseIdentityComplete: false,
        complete: false,
      },
    });
  });

  it("fails final release evidence when cohort analytics lacks AI acceptance decision proof", async () => {
    const {
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts({
      cohortCheck: {
        name: "cohort-analytics",
        status: "passed",
        details: {
          authSource: "oidc-callback",
          authSessionEstablished: true,
          educatorRoleAccepted: true,
          analyticsStatus: 200,
          filtersApplied: true,
          learnerRows: 1,
          learnerKeysPseudonymous: true,
          sessionKeysPseudonymous: true,
          aggregateCountsPresent: true,
          riskBreakdownPresent: true,
          learnerRiskLevelsPresent: true,
          priorityReasonsStable: true,
          factLayerLrs: true,
          privacyPseudonymous: true,
          noRawLearnerText: true,
          secrets: "redacted",
        },
      },
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport();

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.enterprise).toMatchObject({
      status: "failed",
      requiredChecks: {
        cohortAnalytics: false,
      },
      cohortAnalyticsEvidence: {
        aiAcceptanceDecisionsPresent: false,
        aggregateProofComplete: false,
      },
    });
  });

  it("fails final release evidence when sso-only mode lacks trial-login retirement proof", async () => {
    const {
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts({
      ssoOnlyModeCheck: { name: "sso-only-mode", status: "passed" },
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport();

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.enterprise).toMatchObject({
      status: "failed",
      requiredChecks: {
        ssoOnlyMode: false,
      },
      ssoOnlyRuntimeEvidence: {
        readinessTrialAccountsDisabled: false,
        loginPageHasSsoEntry: false,
        loginPageHasTrialForm: false,
        appSessionPostDisabled: false,
        appSessionSetsSessionCookie: false,
        complete: false,
      },
    });
  });

  it("fails final release evidence when readiness lacks OIDC role-mapping proof", async () => {
    const {
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts({
      readinessDetails: {
        aiProvider: "openai-compatible",
        aiEvalVersion: "eval-2026-06-30",
        aiEvalManifest: "verified",
        aiModelFingerprint: modelFingerprint("enterprise-model"),
        storageProvider: "neon",
        deploymentPlatform: "vercel",
        vercelRequestIdPresent: true,
      },
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport();

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.enterprise).toMatchObject({
      status: "failed",
      requiredChecks: {
        readiness: false,
      },
      oidcRoleMappingEvidence: {
        status: "unknown",
        configured: false,
        present: [],
        redaction: "unknown",
        complete: false,
      },
    });
  });

  it("fails final release evidence when readiness lacks persistent Postgres LRS outbox proof", async () => {
    const {
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts({
      readinessDetails: passingReadinessDetails({
        lrsOutboxMode: "memory",
        lrsOutboxStorage: "process",
        lrsOutboxMetricsPresent: true,
      }),
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport();

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.enterprise).toMatchObject({
      status: "failed",
      requiredChecks: {
        lrsHealth: false,
      },
      lrsOutboxEvidence: {
        mode: "memory",
        storage: "process",
        metricsPresent: true,
        complete: false,
      },
    });
  });

  it("fails final release evidence when LRS health lacks persistent Postgres outbox proof", async () => {
    const {
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts({
      lrsHealthCheck: {
        name: "lrs-health",
        status: "passed",
        details: {
          lrsStatus: "connected",
          configured: true,
          lrsOutboxMode: "memory",
          lrsOutboxStorage: "process",
          lrsOutboxMetricsPresent: true,
          secrets: "redacted",
        },
      },
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport();

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.enterprise).toMatchObject({
      status: "failed",
      requiredChecks: {
        lrsHealth: false,
      },
      lrsHealthEvidence: {
        status: "connected",
        configured: true,
        outboxMode: "memory",
        outboxStorage: "process",
        outboxMetricsPresent: true,
        complete: false,
      },
    });
  });

  it("fails final release evidence when LRS health lacks artifact coalescing proof", async () => {
    const {
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts({
      lrsHealthCheck: {
        name: "lrs-health",
        status: "passed",
        details: {
          lrsStatus: "connected",
          configured: true,
          lrsOutboxMode: "persistent",
          lrsOutboxStorage: "postgres",
          lrsOutboxMetricsPresent: true,
          lrsOutboxRedaction: "redacted",
          secrets: "redacted",
        },
      },
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport();

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.enterprise).toMatchObject({
      status: "failed",
      requiredChecks: {
        lrsHealth: false,
      },
      lrsHealthEvidence: {
        outboxMode: "persistent",
        outboxStorage: "postgres",
        outboxMetricsPresent: true,
        artifactCoalescingComplete: false,
        complete: false,
      },
    });
  });

  it("fails final release evidence when artifact coalescing omits planning submissions", async () => {
    const legacyCoalescingEvents = ["artifact_saved", "artifact_edited"];
    const {
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts({
      readinessDetails: passingReadinessDetails({
        lrsOutboxCoalescingEvents: legacyCoalescingEvents,
      }),
      lrsHealthCheck: {
        ...passingLrsHealthCheck(),
        details: {
          ...passingLrsHealthCheck().details,
          lrsOutboxCoalescingEvents: legacyCoalescingEvents,
        },
      },
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport();

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.enterprise).toMatchObject({
      status: "failed",
      lrsOutboxEvidence: {
        artifactCoalescing: {
          events: legacyCoalescingEvents,
        },
        artifactCoalescingComplete: false,
        complete: false,
      },
      lrsHealthEvidence: {
        artifactCoalescing: {
          events: legacyCoalescingEvents,
        },
        artifactCoalescingComplete: false,
        complete: false,
      },
    });
  });

  it("fails when OIDC start evidence lacks the complete authorization-code request details", async () => {
    const enterpriseReportPath = await writeJson("enterprise-report.json", {
      status: "passed",
      checkedAt: "2026-06-30T03:00:00.000Z",
      baseUrl: "https://aais-six.vercel.app",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      checks: [
        {
          name: "readiness",
          status: "passed",
          details: {
            aiProvider: "openai-compatible",
            aiEvalVersion: "eval-2026-06-30",
            aiEvalManifest: "verified",
            aiModelFingerprint: modelFingerprint("enterprise-model"),
            storageProvider: "neon",
            deploymentPlatform: "vercel",
            vercelRequestIdPresent: true,
          },
        },
        { name: "security-headers", status: "passed" },
        passingLegalPagesCheck(),
        passingLrsHealthCheck(),
        {
          name: "oidc-start",
          status: "passed",
          details: {
            redirectsToHttpsProvider: true,
            responseTypeCode: true,
            hasClientId: true,
            hasRedirectUri: true,
            hasStateParam: true,
            hasNonceParam: false,
            hasPkceChallenge: true,
            pkceMethodS256: true,
            scopeIncludesOpenid: true,
            stateCookieHttpOnly: true,
            stateCookieSecure: true,
            stateCookieSameSiteLax: true,
          },
        },
        passingOidcCallbackCheck(),
        { name: "sso-only-mode", status: "passed" },
      ],
      redaction: {
        secrets: "omitted",
        cookies: "attributes-only",
      },
    });
    const aiEvalManifestPath = await writeJson("ai-eval-manifest.json", passingAiEvalManifest());
    const postgresRestoreReportPath = await writeJson("restore-report.json", {
      schemaVersion: 1,
      status: "passed",
      checkedAt: "2026-06-30T04:00:00.000Z",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      target: {
        databaseUrl: "redacted",
        provider: "neon",
        purpose: "restored-staging",
        sameAsSource: false,
      },
      checks: {
        tablePresent: true,
        lrsOutboxTablePresent: true,
        smokeInsertOnly: true,
        smokeInserted: true,
        smokeReadBack: true,
        smokeDeleted: true,
      },
      redaction: {
        secrets: "omitted",
      },
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport();

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.enterprise).toMatchObject({
      status: "failed",
      requiredChecks: {
        oidcStart: false,
      },
      oidcStartEvidence: {
        completeAuthorizationCodeRequest: false,
        hasNonceParam: false,
      },
    });
  });

  it("fails when OIDC callback evidence lacks learner-session handoff proof", async () => {
    const {
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts();
    const enterpriseReportPath = await writeJson("enterprise-report-with-weak-callback.json", {
      status: "passed",
      checkedAt: "2026-06-30T03:00:00.000Z",
      baseUrl: "https://aais-six.vercel.app",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      checks: [
        {
          name: "readiness",
          status: "passed",
          details: {
            aiProvider: "openai-compatible",
            aiEvalVersion: "eval-2026-06-30",
            aiEvalManifest: "verified",
            aiModelFingerprint: modelFingerprint("enterprise-model"),
            storageProvider: "neon",
            deploymentPlatform: "vercel",
            vercelRequestIdPresent: true,
          },
        },
        { name: "security-headers", status: "passed" },
        passingLegalPagesCheck(),
        passingLrsHealthCheck(),
        { name: "oidc-start", status: "passed", details: passingOidcStartDetails() },
        {
          name: "oidc-callback",
          status: "passed",
          details: {
            redirectsToLocalTarget: true,
            setsSessionCookie: true,
            setsCsrfCookie: true,
            clearsStateCookie: true,
            setCookieLeaksCallbackUrl: false,
          },
        },
        { name: "sso-only-mode", status: "passed" },
        { name: "trial-learning-session", status: "skipped" },
        { name: "trial-login-throttle", status: "skipped" },
      ],
      redaction: {
        secrets: "omitted",
        cookies: "attributes-only",
      },
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport();

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.enterprise).toMatchObject({
      status: "failed",
      requiredChecks: {
        oidcCallback: false,
      },
      oidcCallbackEvidence: {
        learningSessionStatus: null,
        learningSessionReadable: false,
        learningSessionHandoffComplete: false,
      },
    });
  });

  it("fails when enterprise smoke evidence is older than the Vercel env preflight", async () => {
    const {
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts();
    const vercelEnvReportPath = await writePassingVercelEnvReport({
      checkedAt: "2026-06-30T03:30:00.000Z",
    });

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.enterprise).toMatchObject({
      status: "failed",
      evidenceOrder: {
        enterpriseAfterVercelEnv: false,
        enterpriseAfterVercelDeployment: true,
        enterpriseCheckedAt: "2026-06-30T03:00:00.000Z",
        vercelEnvCheckedAt: "2026-06-30T03:30:00.000Z",
        vercelDeploymentCheckedAt: "2026-06-30T02:45:00.000Z",
      },
    });
  });

  it("fails when enterprise smoke evidence is older than the Vercel deployment inspect report", async () => {
    const {
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts({
      vercelDeployment: {
        checkedAt: "2026-06-30T03:30:00.000Z",
      },
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport({
      checkedAt: "2026-06-30T02:30:00.000Z",
    });

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.enterprise).toMatchObject({
      status: "failed",
      evidenceOrder: {
        enterpriseAfterVercelEnv: true,
        enterpriseAfterVercelDeployment: false,
        enterpriseCheckedAt: "2026-06-30T03:00:00.000Z",
        vercelEnvCheckedAt: "2026-06-30T02:30:00.000Z",
        vercelDeploymentCheckedAt: "2026-06-30T03:30:00.000Z",
      },
    });
  });

  it("fails when the Vercel deployment report lacks a traceable git commit", async () => {
    const {
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts({
      vercelDeployment: {
        gitCommitShortSha: "not-a-git-sha",
      },
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport();

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.vercelDeployment).toMatchObject({
      status: "failed",
      reportedStatus: "passed",
      deployment: {
        gitCommitShortSha: null,
      },
    });
  });

  it("fails when Vercel deployment git evidence does not match deployed readiness", async () => {
    const {
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts({
      vercelDeployment: {
        gitCommitShortSha: "fedcba987654",
      },
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport();

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.vercelDeployment).toMatchObject({
      status: "failed",
      deployment: {
        gitCommitShortSha: "fedcba987654",
        gitCommitMatchesEnterprise: false,
      },
    });
  });

  it("passes the current-stage trial auth release evidence without OIDC provider artifacts", async () => {
    const {
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts({
      authMode: "trial",
      readinessDetails: passingReadinessDetails({
        oidcMode: "missing",
        oidcRoleMappingStatus: "missing",
        oidcRoleMappingConfigured: false,
        oidcRoleMappingPresent: [],
      }),
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport({ authMode: "trial" });

    const report = await verifyAaisReleaseEvidence({
      authMode: "trial",
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("passed");
    expect(report.artifacts.vercelEnv.target).toMatchObject({
      authMode: "trial",
      expectedAuthMode: "trial",
      authModeMatchesExpected: true,
    });
    expect(report.artifacts.enterprise.requiredChecks).toMatchObject({
      readiness: true,
      cohortAnalytics: true,
      oidcStart: true,
      oidcCallback: true,
      ssoOnlyMode: true,
      trialLearningSession: true,
      trialLoginThrottle: true,
    });
    expect(report.artifacts.enterprise.optionalChecks).toEqual({
      trialLearningSession: "passed",
      trialLoginThrottle: "passed",
    });
    expect(report.artifacts.enterprise.trialAuthEvidence).toEqual({
      trialLearningSessionPassed: true,
      trialLoginThrottlePassed: true,
      trialChecksPassed: true,
    });
    expect(report.artifacts.enterprise.oidcRoleMappingEvidence.complete).toBe(false);
  });

  it("fails when final sso-only release evidence includes passed trial smoke checks", async () => {
    const enterpriseReportPath = await writeJson("enterprise-report.json", {
      status: "passed",
      checkedAt: "2026-06-30T03:00:00.000Z",
      baseUrl: "https://aais-six.vercel.app",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      checks: [
        {
          name: "readiness",
          status: "passed",
          details: {
            aiProvider: "openai-compatible",
            aiEvalVersion: "eval-2026-06-30",
            aiEvalManifest: "verified",
            aiModelFingerprint: modelFingerprint("enterprise-model"),
            storageProvider: "neon",
            deploymentPlatform: "vercel",
            vercelRequestIdPresent: true,
          },
        },
        { name: "security-headers", status: "passed" },
        passingLegalPagesCheck(),
        passingLrsHealthCheck(),
        { name: "oidc-start", status: "passed", details: passingOidcStartDetails() },
        passingOidcCallbackCheck(),
        { name: "sso-only-mode", status: "passed" },
        { name: "trial-learning-session", status: "passed" },
        { name: "trial-login-throttle", status: "passed" },
      ],
      redaction: {
        secrets: "omitted",
        cookies: "attributes-only",
      },
    });
    const aiEvalManifestPath = await writeJson("ai-eval-manifest.json", passingAiEvalManifest());
    const postgresRestoreReportPath = await writeJson("restore-report.json", {
      schemaVersion: 1,
      status: "passed",
      checkedAt: "2026-06-30T04:00:00.000Z",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      target: {
        databaseUrl: "redacted",
        provider: "neon",
        purpose: "restored-staging",
        sameAsSource: false,
      },
      checks: {
        tablePresent: true,
        lrsOutboxTablePresent: true,
        smokeInsertOnly: true,
        smokeInserted: true,
        smokeReadBack: true,
        smokeDeleted: true,
      },
      redaction: {
        secrets: "omitted",
      },
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport();

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.enterprise).toMatchObject({
      status: "failed",
      optionalChecks: {
        trialLearningSession: "passed",
        trialLoginThrottle: "passed",
      },
      ssoOnlyEvidence: {
        trialLearningSessionSkipped: false,
        trialLoginThrottleSkipped: false,
        trialChecksSkipped: false,
      },
    });
  });

  it("fails when the live AI evaluation manifest model does not match deployed readiness", async () => {
    const enterpriseReportPath = await writeJson("enterprise-report.json", {
      status: "passed",
      checkedAt: "2026-06-30T03:00:00.000Z",
      baseUrl: "https://aais-six.vercel.app",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      checks: [
        {
          name: "readiness",
          status: "passed",
          details: {
            aiProvider: "openai-compatible",
            aiEvalVersion: "eval-2026-06-30",
            aiEvalManifest: "verified",
            aiModelFingerprint: modelFingerprint("deployed-model"),
            storageProvider: "neon",
            deploymentPlatform: "vercel",
            vercelRequestIdPresent: true,
          },
        },
        { name: "security-headers", status: "passed" },
        passingLegalPagesCheck(),
        passingLrsHealthCheck(),
        { name: "oidc-start", status: "passed" },
        passingOidcCallbackCheck(),
        { name: "sso-only-mode", status: "passed" },
      ],
      redaction: {
        secrets: "omitted",
        cookies: "attributes-only",
      },
    });
    const aiEvalManifestPath = await writeJson(
      "ai-eval-manifest.json",
      passingAiEvalManifest({ model: "evaluated-model" }),
    );
    const postgresRestoreReportPath = await writeJson("restore-report.json", {
      schemaVersion: 1,
      status: "passed",
      checkedAt: "2026-06-30T04:00:00.000Z",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      target: {
        databaseUrl: "redacted",
        provider: "neon",
        purpose: "restored-staging",
        sameAsSource: false,
      },
      checks: {
        tablePresent: true,
        lrsOutboxTablePresent: true,
        smokeInsertOnly: true,
        smokeInserted: true,
        smokeReadBack: true,
        smokeDeleted: true,
      },
      redaction: {
        secrets: "omitted",
      },
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport();

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.aiEval).toMatchObject({
      status: "failed",
      compatibleWithEnterpriseReadiness: true,
      modelFingerprint: {
        value: modelFingerprint("evaluated-model"),
        enterpriseValue: modelFingerprint("deployed-model"),
        matchesEnterprise: false,
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("deployed-model");
    expect(serialized).not.toContain("evaluated-model");
  });

  it("fails when A1-A4 live AI coverage has a role contract mismatch", async () => {
    const agentEvidence = passingAiEvalManifest().agentEvidence;
    const {
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts({
      aiEvalManifest: {
        agentEvidence: {
          ...agentEvidence,
          coverage: expectedAiEvalAgentCoverage({
            A3: {
              label: "监督智能体",
              responsibility: "frontend-expert-modelling-coaching",
              sampleIds: ["a3-supervision-a1-signal"],
              caModules: ["Scaffolding"],
              complete: true,
            },
          }),
        },
      },
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport();

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.aiEval).toMatchObject({
      status: "failed",
      agentEvidence: {
        complete: false,
        coverageComplete: false,
        coverage: {
          A3: {
            responsibility: "invalid",
            caModules: ["Scaffolding"],
            complete: false,
          },
        },
      },
    });
  });

  it("fails final release evidence when readiness lacks A1-A4 xAPI agent-contract proof", async () => {
    const {
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts({
      readinessDetails: passingReadinessDetails({
        agentEvidenceContractXapiExtensions: {
          ...expectedAgentContractXapiExtensions(),
          pseudonymousSessionId: false,
        },
        agentEvidenceContractXapiExtensionsComplete: false,
        agentEvidenceContractPseudonymousSessionId: false,
        agentEvidenceContractComplete: false,
      }),
    });
    const vercelEnvReportPath = await writePassingVercelEnvReport();

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.enterprise).toMatchObject({
      status: "failed",
      requiredChecks: {
        agentEvidence: false,
        a3Supervision: false,
        a2Monitoring: false,
      },
      agentEvidence: {
        agentContract: {
          xapiExtensions: {
            pseudonymousSessionId: false,
          },
          xapiExtensionsComplete: false,
          complete: false,
        },
        complete: false,
      },
    });
  });

  it("fails when the Vercel env report is not passing Production sso-only live evidence", async () => {
    const {
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts();
    const vercelEnvReportPath = await writeJson("vercel-env-report.json", {
      schemaVersion: 1,
      status: "failed",
      checkedAt: "2026-06-30T02:30:00.000Z",
      target: {
        environment: "Preview",
        authMode: "trial",
        aiMode: "deterministic",
      },
      required: {
        present: ["AAIS_SESSION_SECRET"],
        missing: ["AAIS_DATABASE_URL"],
      },
      categories: {
        core: [],
        storage: ["AAIS_DATABASE_URL"],
        releaseMode: [],
        oidc: [],
        ai: [],
        lrs: [],
      },
      redaction: {
        secrets: "omitted",
        values: "not-read",
      },
    });

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.vercelEnv).toMatchObject({
      status: "failed",
      reportedStatus: "failed",
      target: {
        environment: "Preview",
        expectedEnvironment: "Production",
        environmentMatchesExpected: false,
        authMode: "trial",
        expectedAuthMode: "sso-only",
        authModeMatchesExpected: false,
        aiMode: "deterministic",
        expectedAiMode: "live",
        aiModeMatchesExpected: false,
      },
      missingCount: 1,
      missing: ["AAIS_DATABASE_URL"],
      redaction: {
        secrets: "omitted",
        values: "not-read",
      },
    });
  });

  it("fails when critical evidence is skipped, blocked, or pointed at the source database", async () => {
    const enterpriseReportPath = await writeJson("enterprise-report.json", {
      status: "passed",
      checkedAt: "2026-06-20T03:00:00.000Z",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      checks: [
        {
          name: "readiness",
          status: "passed",
          details: {
            aiProvider: "openai-compatible",
            aiEvalVersion: "eval-2026-06-30",
            aiEvalManifest: "verified",
            storageProvider: "postgres",
            deploymentPlatform: "unknown",
            vercelRequestIdPresent: false,
          },
        },
        { name: "security-headers", status: "passed" },
        passingLegalPagesCheck(),
        passingLrsHealthCheck(),
        { name: "oidc-start", status: "passed" },
        { name: "oidc-callback", status: "skipped" },
        { name: "sso-only-mode", status: "skipped" },
      ],
      redaction: {
        secrets: "omitted",
        cookies: "attributes-only",
      },
    });
    const aiEvalManifestPath = await writeJson(
      "ai-eval-manifest.json",
      passingAiEvalManifest({
        evalVersion: "eval-2026-06-29",
        status: "failed",
        passedAt: "2026-06-20T01:00:00.000Z",
        blockedCount: 1,
      }),
    );
    const postgresRestoreReportPath = await writeJson("restore-report.json", {
      schemaVersion: 1,
      status: "passed",
      checkedAt: "2026-06-20T04:00:00.000Z",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      target: {
        databaseUrl: "redacted",
        purpose: "restored-staging",
        sameAsSource: true,
      },
      checks: {
        tablePresent: true,
        lrsOutboxTablePresent: true,
        smokeInserted: false,
        smokeReadBack: true,
        smokeDeleted: true,
      },
      redaction: {
        secrets: "omitted",
      },
    });

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      authMode: "sso-only",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.enterprise).toMatchObject({
      status: "failed",
      requiredChecks: {
        oidcCallback: false,
        ssoOnlyMode: false,
      },
      freshness: {
        withinMaxAge: false,
      },
    });
    expect(report.artifacts.aiEval).toMatchObject({
      status: "failed",
      blockedCount: 1,
      compatibleWithEnterpriseReadiness: false,
      freshness: {
        withinMaxAge: false,
      },
    });
    expect(report.artifacts.postgresRestore).toMatchObject({
      status: "failed",
      sameAsSource: true,
      smokeInserted: false,
      freshness: {
        withinMaxAge: false,
      },
    });
  });

  it("fails when an artifact timestamp is in the future", async () => {
    const enterpriseReportPath = await writeJson("enterprise-report.json", {
      status: "passed",
      checkedAt: "2026-07-01T03:00:00.000Z",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      checks: [
        {
          name: "readiness",
          status: "passed",
          details: {
            aiProvider: "openai-compatible",
            aiEvalVersion: "eval-2026-06-30",
            aiEvalManifest: "verified",
            storageProvider: "postgres",
          },
        },
        { name: "security-headers", status: "passed" },
        passingLegalPagesCheck(),
        passingLrsHealthCheck(),
        { name: "oidc-start", status: "passed" },
        passingOidcCallbackCheck(),
        { name: "sso-only-mode", status: "passed" },
      ],
      redaction: {
        secrets: "omitted",
        cookies: "attributes-only",
      },
    });
    const aiEvalManifestPath = await writeJson("ai-eval-manifest.json", passingAiEvalManifest());
    const postgresRestoreReportPath = await writeJson("restore-report.json", {
      schemaVersion: 1,
      status: "passed",
      checkedAt: "2026-06-30T04:00:00.000Z",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      target: {
        databaseUrl: "redacted",
        purpose: "restored-staging",
        sameAsSource: false,
      },
      checks: {
        tablePresent: true,
        lrsOutboxTablePresent: true,
        smokeInsertOnly: true,
        smokeInserted: true,
        smokeReadBack: true,
        smokeDeleted: true,
      },
      redaction: {
        secrets: "omitted",
      },
    });

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.enterprise).toMatchObject({
      status: "failed",
      freshness: {
        isFuture: true,
        withinMaxAge: false,
      },
    });
  });

  it("fails without leaking when an artifact contains secret-like raw content", async () => {
    const enterpriseReportPath = await writeJson("enterprise-report.json", {
      status: "passed",
      checkedAt: "2026-06-30T03:00:00.000Z",
      debugAuthorization: "Bearer live-secret-token",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      checks: [
        {
          name: "readiness",
          status: "passed",
          details: {
            aiProvider: "openai-compatible",
            aiEvalVersion: "eval-2026-06-30",
            aiEvalManifest: "verified",
          },
        },
        { name: "security-headers", status: "passed" },
        passingLegalPagesCheck(),
        passingLrsHealthCheck(),
        { name: "oidc-start", status: "passed" },
        passingOidcCallbackCheck(),
        { name: "sso-only-mode", status: "passed" },
      ],
      redaction: {
        secrets: "omitted",
        cookies: "attributes-only",
      },
    });
    const aiEvalManifestPath = await writeJson("ai-eval-manifest.json", passingAiEvalManifest());
    const postgresRestoreReportPath = await writeJson("restore-report.json", {
      schemaVersion: 1,
      status: "passed",
      checkedAt: "2026-06-30T04:00:00.000Z",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      target: {
        databaseUrl: "redacted",
        purpose: "restored-staging",
        sameAsSource: false,
      },
      checks: {
        tablePresent: true,
        lrsOutboxTablePresent: true,
        smokeInsertOnly: true,
        smokeInserted: true,
        smokeReadBack: true,
        smokeDeleted: true,
      },
      redaction: {
        secrets: "omitted",
      },
    });

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.enterprise).toMatchObject({
      status: "failed",
      secretScan: {
        status: "failed",
        issue: "bearer-token",
      },
    });
    expect(JSON.stringify(report)).not.toContain("live-secret-token");
  });

  it("fails without leaking when an artifact contains a transient OIDC callback URL", async () => {
    const {
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
    } = await writePassingReleaseArtifacts();
    const vercelEnvReportPath = await writePassingVercelEnvReport();
    const enterpriseReport = JSON.parse(await readFile(enterpriseReportPath, "utf8"));
    enterpriseReport.debugCallbackUrl = "https://www.aais.site/api/auth/oidc/callback?code=provider-code-that-must-not-leak&state=provider-state-that-must-not-leak";
    await writeFile(enterpriseReportPath, `${JSON.stringify(enterpriseReport, null, 2)}\n`, "utf8");

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      vercelEnvReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.enterprise).toMatchObject({
      status: "failed",
      secretScan: {
        status: "failed",
        issue: "authorization-code-url",
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("provider-code-that-must-not-leak");
    expect(serialized).not.toContain("provider-state-that-must-not-leak");
  });

  it("fails when artifacts belong to different release candidates", async () => {
    const enterpriseReportPath = await writeJson("enterprise-report.json", {
      status: "passed",
      checkedAt: "2026-06-30T03:00:00.000Z",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      checks: [
        {
          name: "readiness",
          status: "passed",
          details: {
            aiProvider: "openai-compatible",
            aiEvalVersion: "eval-2026-06-30",
            aiEvalManifest: "verified",
          },
        },
        { name: "security-headers", status: "passed" },
        passingLegalPagesCheck(),
        passingLrsHealthCheck(),
        { name: "oidc-start", status: "passed" },
        passingOidcCallbackCheck(),
        { name: "sso-only-mode", status: "passed" },
      ],
      redaction: {
        secrets: "omitted",
        cookies: "attributes-only",
      },
    });
    const aiEvalManifestPath = await writeJson("ai-eval-manifest.json", passingAiEvalManifest());
    const postgresRestoreReportPath = await writeJson("restore-report.json", {
      schemaVersion: 1,
      status: "passed",
      checkedAt: "2026-06-30T04:00:00.000Z",
      release: {
        id: "aais-2026-06-29-rc9",
      },
      target: {
        databaseUrl: "redacted",
        purpose: "restored-staging",
        sameAsSource: false,
      },
      checks: {
        tablePresent: true,
        lrsOutboxTablePresent: true,
        smokeInsertOnly: true,
        smokeInserted: true,
        smokeReadBack: true,
        smokeDeleted: true,
      },
      redaction: {
        secrets: "omitted",
      },
    });

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.release).toMatchObject({
      id: "aais-2026-06-30-rc1",
      consistent: false,
    });
    expect(report.artifacts.postgresRestore).toMatchObject({
      status: "failed",
      release: {
        id: "aais-2026-06-29-rc9",
        matchesExpected: false,
      },
    });
  });

  it("fails when the enterprise report or restore report comes from the wrong Vercel and Neon target", async () => {
    const enterpriseReportPath = await writeJson("enterprise-report.json", {
      status: "passed",
      checkedAt: "2026-06-30T03:00:00.000Z",
      baseUrl: "https://aais-preview.vercel.app",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      checks: [
        {
          name: "readiness",
          status: "passed",
          details: {
            aiProvider: "openai-compatible",
            aiEvalVersion: "eval-2026-06-30",
            aiEvalManifest: "verified",
            storageProvider: "postgres",
          },
        },
        { name: "security-headers", status: "passed" },
        passingLegalPagesCheck(),
        passingLrsHealthCheck(),
        { name: "oidc-start", status: "passed" },
        passingOidcCallbackCheck(),
        { name: "sso-only-mode", status: "passed" },
      ],
      redaction: {
        secrets: "omitted",
        cookies: "attributes-only",
      },
    });
    const aiEvalManifestPath = await writeJson("ai-eval-manifest.json", passingAiEvalManifest());
    const postgresRestoreReportPath = await writeJson("restore-report.json", {
      schemaVersion: 1,
      status: "passed",
      checkedAt: "2026-06-30T04:00:00.000Z",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      target: {
        databaseUrl: "redacted",
        provider: "postgres",
        purpose: "restored-staging",
        sameAsSource: false,
      },
      checks: {
        tablePresent: true,
        lrsOutboxTablePresent: true,
        smokeInsertOnly: true,
        smokeInserted: true,
        smokeReadBack: true,
        smokeDeleted: true,
      },
      redaction: {
        secrets: "omitted",
      },
    });

    const report = await verifyAaisReleaseEvidence({
      enterpriseReportPath,
      aiEvalManifestPath,
      postgresRestoreReportPath,
      deploymentUrl: "https://aais-six.vercel.app",
      deploymentPlatform: "vercel",
      databaseProvider: "neon",
      now: new Date("2026-06-30T05:00:00.000Z"),
      maxAgeHours: 24,
    });

    expect(report.status).toBe("failed");
    expect(report.artifacts.enterprise).toMatchObject({
      status: "failed",
      deployment: {
        baseUrl: "https://aais-preview.vercel.app",
        expectedBaseUrl: "https://aais-six.vercel.app",
        matchesExpected: false,
      },
      storageProvider: {
        value: "postgres",
        expected: "neon",
        matchesExpected: false,
      },
      deploymentPlatform: {
        value: "unknown",
        expected: "vercel",
        matchesExpected: false,
        vercelRequestIdPresent: false,
      },
    });
    expect(report.artifacts.postgresRestore).toMatchObject({
      status: "failed",
      provider: {
        value: "postgres",
        expected: "neon",
        matchesExpected: false,
      },
    });
  });
});

async function writeJson(fileName, value) {
  const filePath = path.join(tempDir, fileName);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

function passingAiEvalManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    evalVersion: "eval-2026-06-30",
    provider: "openai-compatible",
    model: "enterprise-model",
    status: "passed",
    passedAt: "2026-06-30T01:00:00.000Z",
    release: {
      id: "aais-2026-06-30-rc1",
    },
    sampleCount: 4,
    blockedCount: 0,
    agentEvidence: {
      contractVersion: "aais-a1-a4-ca-eval-v2",
      requiredAgents: ["A1", "A2", "A3", "A4"],
      coveredAgents: ["A1", "A2", "A3", "A4"],
      requiredCaModules: ["Modelling", "Coaching", "Scaffolding", "Fading", "Articulation", "Reflection"],
      coveredCaModules: ["Modelling", "Coaching", "Scaffolding", "Fading", "Articulation", "Reflection"],
      coverage: expectedAiEvalAgentCoverage(),
      caBackgroundIncluded: true,
      rawPromptsStored: false,
      rawOutputsStored: false,
      complete: true,
    },
    redaction: {
      prompts: "summarized",
      secrets: "omitted",
    },
    ...overrides,
  };
}

function expectedAiEvalAgentCoverage(overrides = {}) {
  return {
    A1: {
      label: "导学智能体",
      responsibility: "frontend-guide-scaffolding",
      sampleIds: ["a1-guide-training"],
      caModules: ["Scaffolding", "Fading"],
      complete: true,
    },
    A2: {
      label: "专家智能体",
      responsibility: "frontend-expert-modelling-coaching",
      sampleIds: ["a2-expert-modelling-coaching"],
      caModules: ["Modelling", "Coaching"],
      complete: true,
    },
    A3: {
      label: "监督智能体",
      responsibility: "backend-supervision-a1-signal",
      sampleIds: ["a3-supervision-a1-signal"],
      caModules: ["Scaffolding"],
      complete: true,
    },
    A4: {
      label: "反思智能体",
      responsibility: "backend-reflection-articulation",
      sampleIds: ["a4-articulation-reflection"],
      caModules: ["Articulation", "Reflection"],
      complete: true,
    },
    ...overrides,
  };
}

async function writePassingReleaseArtifacts(input = {}) {
  const sourceProvenanceReportPath = await writeJson("source-provenance.json", {
    schemaVersion: 1,
    status: "passed",
    checkedAt: "2026-06-30T00:30:00.000Z",
    release: {
      id: "aais-2026-06-30-rc1",
    },
    source: {
      gitHeadPresent: true,
      gitCommitShortSha: input.sourceGitCommitShortSha ?? "0123456789ab",
      branch: "main",
      clean: true,
      workingTree: {
        total: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
      },
      errorCategory: null,
    },
    redaction: {
      secrets: "omitted",
      fileNames: "not-included",
      gitStatus: "counts-only",
    },
  });
  const authMode = input.authMode ?? "sso-only";
  vi.stubEnv("AAIS_RELEASE_AUTH_MODE", authMode);
  const trialAuthMode = authMode === "trial";
  const enterpriseReportPath = await writeJson("enterprise-report.json", {
    status: "passed",
    checkedAt: "2026-06-30T03:00:00.000Z",
    baseUrl: "https://aais-six.vercel.app",
    release: {
      id: "aais-2026-06-30-rc1",
    },
    checks: [
      {
        name: "readiness",
        status: "passed",
        details: {
          ...(input.readinessDetails ?? passingReadinessDetails()),
        },
      },
      { name: "security-headers", status: "passed" },
      input.legalPagesCheck ?? passingLegalPagesCheck(),
      input.lrsHealthCheck ?? passingLrsHealthCheck(),
      input.cohortCheck ?? (trialAuthMode ? passingCohortAnalyticsCheck() : passingOidcCohortAnalyticsCheck()),
      trialAuthMode
        ? { name: "oidc-start", status: "skipped" }
        : { name: "oidc-start", status: "passed", details: passingOidcStartDetails() },
      trialAuthMode ? { name: "oidc-callback", status: "skipped" } : input.oidcCallbackCheck ?? passingOidcCallbackCheck(),
      trialAuthMode ? { name: "sso-only-mode", status: "skipped" } : input.ssoOnlyModeCheck ?? passingSsoOnlyModeCheck(),
      { name: "trial-learning-session", status: trialAuthMode ? "passed" : "skipped" },
      { name: "trial-login-throttle", status: trialAuthMode ? "passed" : "skipped" },
    ],
    redaction: {
      secrets: "omitted",
      cookies: "attributes-only",
    },
  });
  const aiEvalManifestPath = await writeJson(
    "ai-eval-manifest.json",
    passingAiEvalManifest(input.aiEvalManifest ?? {}),
  );
  const postgresRestoreReportPath = await writeJson("restore-report.json", {
    schemaVersion: 1,
    status: "passed",
    checkedAt: "2026-06-30T04:00:00.000Z",
    release: {
      id: "aais-2026-06-30-rc1",
    },
    target: {
      databaseUrl: "redacted",
      provider: "neon",
      purpose: "restored-staging",
      sameAsSource: false,
    },
    checks: {
      tablePresent: true,
      lrsOutboxTablePresent: true,
      smokeInsertOnly: true,
      smokeInserted: true,
      smokeReadBack: true,
      smokeDeleted: true,
    },
    redaction: {
      secrets: "omitted",
    },
  });
  const vercelDeploymentReportPath = await writePassingVercelDeploymentReport(input.vercelDeployment);
  vi.stubEnv("AAIS_RELEASE_SOURCE_PROVENANCE_REPORT_PATH", sourceProvenanceReportPath);
  vi.stubEnv("AAIS_RELEASE_VERCEL_DEPLOYMENT_REPORT_PATH", vercelDeploymentReportPath);
  return {
    sourceProvenanceReportPath,
    enterpriseReportPath,
    vercelDeploymentReportPath,
    aiEvalManifestPath,
    postgresRestoreReportPath,
  };
}

function modelFingerprint(model) {
  return createHash("sha256")
    .update(`aais-ai-model:${model}`)
    .digest("hex")
    .slice(0, 16);
}

function passingReadinessDetails(input = {}) {
  return {
    aiProvider: "openai-compatible",
    aiEvalVersion: "eval-2026-06-30",
    aiEvalManifest: "verified",
    aiModelFingerprint: modelFingerprint("enterprise-model"),
    storageProvider: "neon",
    oidcMode: "explicit",
    oidcRoleMappingStatus: "ok",
    oidcRoleMappingConfigured: true,
    oidcRoleMappingPresent: ["AAIS_OIDC_TEACHER_GROUPS"],
    oidcRoleMappingRedaction: "names-only",
    lrsOutboxMode: "persistent",
    lrsOutboxStorage: "postgres",
    lrsOutboxMetricsPresent: true,
    lrsOutboxCoalescingEnabled: true,
    lrsOutboxCoalescingWindowSeconds: 30,
    lrsOutboxCoalescingEvents: ["artifact_saved", "artifact_edited", "planning_submitted"],
    lrsOutboxDeadLetterRequeue: true,
    lrsOutboxRecoveryAction: "POST /api/learning/lrs/outbox/flush?action=requeue-dead-letter",
    lrsOutboxRecoveryAuth: ["admin-session-csrf", "bearer-token"],
    lrsOutboxRecoveryRedaction: "payloads-excluded",
    agentEvidenceEnabled: true,
    agentEvidenceContractVersion: "aais-a1-a4-ca-v2",
    agentEvidenceContractRequiredAgents: ["A1", "A2", "A3", "A4"],
    agentEvidenceContractRequiredAgentsComplete: true,
    agentEvidenceContractCaModules: expectedAgentContractCaModules(),
    agentEvidenceContractCaModulesComplete: true,
    agentEvidenceContractRoles: expectedAgentContractRoles(),
    agentEvidenceContractRolesComplete: true,
    agentEvidenceContractXapiExtensions: expectedAgentContractXapiExtensions(),
    agentEvidenceContractXapiExtensionsComplete: true,
    agentEvidenceContractPseudonymousSessionId: true,
    agentEvidenceContractComplete: true,
    agentEvidenceResponsibilities: expectedAgentResponsibilities(),
    agentEvidenceResponsibilitiesComplete: true,
    agentEvidenceTriggers: [
      "monitoring_pause_detected",
      "coaching_push",
      "ai_acceptance_recorded",
    ],
    agentEvidenceSignals: [
      "low_progress_artifact_autosave",
      "artifact_regression_autosave",
    ],
    agentEvidenceCoachingInterruption: "low",
    agentEvidenceCoachingCooldownSeconds: 600,
    agentEvidenceArtifactRegressionMinimumPreviousCharacters: 80,
    agentEvidenceArtifactRegressionMinimumDropCharacters: 40,
    agentEvidenceArtifactRegressionRawTextExcluded: true,
    agentEvidenceAiAcceptanceDecisionKeyed: true,
    agentEvidenceAiAcceptanceRevisions: true,
    agentEvidenceAiAcceptanceRawMessageIdsExcluded: true,
    agentEvidenceAiAcceptanceRationaleTextExcluded: true,
    agentEvidenceRedaction: "raw-learner-text-excluded",
    agentEvidenceComplete: true,
    a3SupervisionEnabled: true,
    a3SupervisionTriggers: [
      "monitoring_pause_detected",
      "coaching_push",
      "ai_acceptance_recorded",
    ],
    a3SupervisionSignals: [
      "low_progress_artifact_autosave",
      "artifact_regression_autosave",
    ],
    a3SupervisionRedaction: "raw-learner-text-excluded",
    a3SupervisionComplete: true,
    a2MonitoringEnabled: true,
    a2MonitoringTriggers: [
      "monitoring_pause_detected",
      "coaching_push",
      "ai_acceptance_recorded",
    ],
    a2MonitoringSignals: [
      "low_progress_artifact_autosave",
      "artifact_regression_autosave",
    ],
    a2CoachingInterruption: "low",
    a2CoachingCooldownSeconds: 600,
    a2ArtifactRegressionMinimumPreviousCharacters: 80,
    a2ArtifactRegressionMinimumDropCharacters: 40,
    a2ArtifactRegressionRawTextExcluded: true,
    a2AiAcceptanceDecisionKeyed: true,
    a2AiAcceptanceRevisions: true,
    a2AiAcceptanceRawMessageIdsExcluded: true,
    a2AiAcceptanceRationaleTextExcluded: true,
    a2MonitoringRedaction: "raw-learner-text-excluded",
    a2MonitoringComplete: true,
    deploymentPlatform: "vercel",
    vercelRequestIdPresent: true,
    releaseId: "aais-2026-06-30-rc1",
    expectedReleaseId: "aais-2026-06-30-rc1",
    releaseIdRequired: true,
    releaseIdMatchesExpected: true,
    releaseSource: "AAIS_RELEASE_ID",
    deploymentProvider: "vercel",
    deploymentGitCommitPresent: true,
    deploymentGitCommitShortSha: "0123456789ab",
    releaseIdentityComplete: true,
    ...input,
  };
}

function expectedAgentResponsibilities() {
  return {
    A1: ["scaffold_request", "scaffold_self_check_started"],
    A2: ["expert_model_viewed", "coaching_push", "ai_acceptance_recorded"],
    A3: [
      "artifact_edited",
      "artifact_saved",
      "planning_submitted",
      "monitoring_pause_detected",
    ],
    A4: ["articulation_submitted", "expert_trace_compared", "self_report_saved"],
  };
}

function expectedAgentContractCaModules() {
  return {
    A1: ["Scaffolding", "Fading"],
    A2: ["Modelling", "Coaching"],
    A3: ["Scaffolding"],
    A4: ["Articulation", "Reflection"],
  };
}

function expectedAgentContractRoles() {
  return {
    A1: "frontend-direct-dialogue",
    A2: "frontend-direct-dialogue",
    A3: "backend-a1-signal",
    A4: "backend-a1-reflection",
  };
}

function expectedAgentContractXapiExtensions() {
  return {
    agentRole: true,
    agentCaModules: true,
    agentFamily: true,
    agentPhaseScope: true,
    pseudonymousSessionId: true,
  };
}

function passingOidcStartDetails() {
  return {
    redirectsToHttpsProvider: true,
    responseTypeCode: true,
    hasClientId: true,
    hasRedirectUri: true,
    redirectUriMatchesCallback: true,
    hasStateParam: true,
    hasNonceParam: true,
    hasPkceChallenge: true,
    pkceMethodS256: true,
    scopeIncludesOpenid: true,
    stateCookieHttpOnly: true,
    stateCookieSecure: true,
    stateCookieSameSiteLax: true,
  };
}

function passingLegalPagesCheck(input = {}) {
  return {
    name: "legal-pages",
    status: "passed",
    details: {
      termsStatus: 200,
      termsHtml: true,
      termsContentPresent: true,
      privacyStatus: 200,
      privacyHtml: true,
      privacyContentPresent: true,
      secrets: "redacted",
      ...input,
    },
  };
}

function passingCohortAnalyticsCheck() {
  return {
    name: "cohort-analytics",
    status: "passed",
    details: {
      loginStatus: 200,
      educatorRoleAccepted: true,
      analyticsStatus: 200,
      filtersApplied: true,
      learnerRows: 1,
      learnerKeysPseudonymous: true,
      sessionKeysPseudonymous: true,
      aggregateCountsPresent: true,
      riskBreakdownPresent: true,
      learnerRiskLevelsPresent: true,
      priorityReasonsStable: true,
      aiAcceptanceDecisionsPresent: true,
      factLayerLrs: true,
      privacyPseudonymous: true,
      noRawLearnerText: true,
      exportStatus: 200,
      exportDispositionPresent: true,
      exportScopeCohort: true,
      exportFiltersApplied: true,
      exportLearnerRowsMatch: true,
      exportLearnerKeysPseudonymous: true,
      exportSessionKeysPseudonymous: true,
      exportPrivacyPseudonymous: true,
      exportNoRawLearnerText: true,
      exportSecrets: "redacted",
      secrets: "redacted",
    },
  };
}

function passingOidcCohortAnalyticsCheck() {
  return {
    name: "cohort-analytics",
    status: "passed",
    details: {
      authSource: "oidc-callback",
      authSessionEstablished: true,
      educatorSessionRole: "teacher",
      educatorSessionRoleEvidence: true,
      expectedSessionRole: "teacher",
      educatorSessionRoleMatchesExpected: true,
      educatorRoleAccepted: true,
      analyticsStatus: 200,
      filtersApplied: true,
      learnerRows: 1,
      learnerKeysPseudonymous: true,
      sessionKeysPseudonymous: true,
      aggregateCountsPresent: true,
      riskBreakdownPresent: true,
      learnerRiskLevelsPresent: true,
      priorityReasonsStable: true,
      aiAcceptanceDecisionsPresent: true,
      factLayerLrs: true,
      privacyPseudonymous: true,
      noRawLearnerText: true,
      exportStatus: 200,
      exportDispositionPresent: true,
      exportScopeCohort: true,
      exportFiltersApplied: true,
      exportLearnerRowsMatch: true,
      exportLearnerKeysPseudonymous: true,
      exportSessionKeysPseudonymous: true,
      exportPrivacyPseudonymous: true,
      exportNoRawLearnerText: true,
      exportSecrets: "redacted",
      secrets: "redacted",
    },
  };
}

function passingLrsHealthCheck() {
  return {
    name: "lrs-health",
    status: "passed",
    details: {
      lrsStatus: "connected",
      configured: true,
      lrsOutboxMode: "persistent",
      lrsOutboxStorage: "postgres",
      lrsOutboxMetricsPresent: true,
      lrsOutboxRedaction: "redacted",
      lrsOutboxCoalescingEnabled: true,
      lrsOutboxCoalescingWindowSeconds: 30,
      lrsOutboxCoalescingEvents: ["artifact_saved", "artifact_edited", "planning_submitted"],
      lrsOutboxDeadLetterRequeue: true,
      lrsOutboxRecoveryAction: "POST /api/learning/lrs/outbox/flush?action=requeue-dead-letter",
      lrsOutboxRecoveryAuth: ["admin-session-csrf", "bearer-token"],
      lrsOutboxRecoveryRedaction: "payloads-excluded",
      secrets: "redacted",
    },
  };
}

function passingOidcCallbackCheck() {
  return {
    name: "oidc-callback",
    status: "passed",
    details: {
      callbackUrlMatchesBaseCallback: true,
      redirectsToLocalTarget: true,
      setsSessionCookie: true,
      sessionCookieHttpOnly: true,
      sessionCookieSecure: true,
      sessionCookieSameSiteLax: true,
      setsCsrfCookie: true,
      csrfCookieSecure: true,
      csrfCookieSameSiteLax: true,
      clearsStateCookie: true,
      setCookieLeaksCallbackUrl: false,
      learningSessionStatus: 200,
      learningSessionReadable: true,
      learningSessionRole: "teacher",
      learningSessionEducatorRole: true,
      expectedSessionRole: "teacher",
      learningSessionRoleMatchesExpected: true,
    },
  };
}

function passingSsoOnlyModeCheck() {
  return {
    name: "sso-only-mode",
    status: "passed",
    httpStatus: 404,
    details: {
      readinessTrialAccountsDisabled: true,
      loginPageHasSsoEntry: true,
      loginPageHasTrialForm: false,
      appSessionPostDisabled: true,
      appSessionSetsSessionCookie: false,
    },
  };
}

async function writePassingVercelEnvReport(input = {}) {
  const authMode = input.authMode ?? "sso-only";
  vi.stubEnv("AAIS_RELEASE_AUTH_MODE", authMode);
  const present = authMode === "trial"
    ? [
        "AAIS_SESSION_SECRET",
        "AAIS_DATABASE_URL",
        "AAIS_DATABASE_PROVIDER",
        "AAIS_TRIAL_ACCOUNTS_JSON",
        "AAIS_AI_PROVIDER",
        "AAIS_AI_ENDPOINT",
        "AAIS_AI_API_KEY",
        "AAIS_AI_MODEL",
        "AAIS_AI_EVAL_APPROVED",
        "AAIS_AI_EVAL_VERSION",
        "AAIS_AI_EVAL_MANIFEST_PATH",
        "LRS_ENDPOINT",
        "LRS_USERNAME",
        "LRS_PASSWORD",
      ]
    : [
        "AAIS_SESSION_SECRET",
        "AAIS_DATABASE_URL",
        "AAIS_DATABASE_PROVIDER",
        "AAIS_TRIAL_LOGIN_ENABLED",
        "AAIS_OIDC_ISSUER",
        "AAIS_OIDC_CLIENT_ID",
        "AAIS_OIDC_CLIENT_SECRET",
        "AAIS_OIDC_REDIRECT_URI",
        "AAIS_OIDC_TEACHER_GROUPS",
        "AAIS_OIDC_AUTHORIZATION_ENDPOINT",
        "AAIS_OIDC_TOKEN_ENDPOINT",
        "AAIS_OIDC_JWKS_URI",
        "AAIS_AI_PROVIDER",
        "AAIS_AI_ENDPOINT",
        "AAIS_AI_API_KEY",
        "AAIS_AI_MODEL",
        "AAIS_AI_EVAL_APPROVED",
        "AAIS_AI_EVAL_VERSION",
        "AAIS_AI_EVAL_MANIFEST_PATH",
        "LRS_ENDPOINT",
        "LRS_USERNAME",
        "LRS_PASSWORD",
      ];
  return writeJson("vercel-env-report.json", {
    schemaVersion: 1,
    status: "passed",
    checkedAt: input.checkedAt ?? "2026-06-30T02:30:00.000Z",
    target: {
      environment: "Production",
      authMode,
      aiMode: "live",
    },
    required: {
      present,
      missing: [],
    },
    categories: {
      core: [],
      storage: [],
      releaseMode: [],
      oidc: [],
      oidcRoleMapping: [],
      ai: [],
      lrs: [],
    },
    redaction: {
      secrets: "omitted",
      values: "not-read",
    },
  });
}

async function writePassingVercelDeploymentReport(input = {}) {
  return writeJson(input.fileName ?? "vercel-deployment-report.json", {
    schemaVersion: 1,
    status: input.status ?? "passed",
    checkedAt: input.checkedAt ?? "2026-06-30T02:45:00.000Z",
    command: "vercel inspect <deployment-url> --json",
    release: {
      id: input.releaseId ?? "aais-2026-06-30-rc1",
    },
    deployment: {
      url: input.url ?? "https://aais-six.vercel.app",
      expectedUrl: input.expectedUrl ?? "https://aais-six.vercel.app",
      urlMatchesExpected: input.urlMatchesExpected ?? true,
      aliases: input.aliases ?? [],
      readyState: input.readyState ?? "READY",
      target: input.target ?? "production",
      targetMatchesProduction: input.targetMatchesProduction ?? true,
      gitCommitShortSha: input.gitCommitShortSha ?? "0123456789ab",
    },
    inspect: {
      source: "vercel-cli",
      parsed: true,
      errorCategory: null,
      secretScan: {
        status: input.inspectSecretScanStatus ?? "passed",
      },
    },
    redaction: {
      secrets: "omitted",
      rawInspectOutput: "not-stored",
      values: "summarized",
    },
  });
}
