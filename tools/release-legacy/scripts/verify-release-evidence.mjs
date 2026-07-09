#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const requiredEnterpriseChecks = [
  ["readiness", "readiness"],
  ["security-headers", "securityHeaders"],
  ["legal-pages", "legalPages"],
  ["lrs-health", "lrsHealth"],
  ["cohort-analytics", "cohortAnalytics"],
  ["oidc-start", "oidcStart"],
  ["oidc-callback", "oidcCallback"],
  ["sso-only-mode", "ssoOnlyMode"],
  ["trial-learning-session", "trialLearningSession"],
  ["trial-login-throttle", "trialLoginThrottle"],
];
const defaultVercelConfigPath = "vercel.json";
const defaultSourceProvenanceReportPath = "output/aais-source-provenance-latest.json";
const defaultVercelDeploymentReportPath = "output/aais-vercel-deployment-report-latest.json";
const lrsOutboxCronPath = "/api/learning/lrs/outbox/flush";
const aiEvalAgentEvidenceContractVersion = "aais-a1-a4-ca-eval-v2";
const requiredAiEvalAgentIds = ["A1", "A2", "A3", "A4"];
const requiredAiEvalCaModules = ["Modelling", "Coaching", "Scaffolding", "Fading", "Articulation", "Reflection"];
const requiredAiEvalAgentContracts = {
  A1: {
    label: "导学智能体",
    caModules: ["Scaffolding", "Fading"],
    responsibility: "frontend-guide-scaffolding",
  },
  A2: {
    label: "专家智能体",
    caModules: ["Modelling", "Coaching"],
    responsibility: "frontend-expert-modelling-coaching",
  },
  A3: {
    label: "监督智能体",
    caModules: ["Scaffolding"],
    responsibility: "backend-supervision-a1-signal",
  },
  A4: {
    label: "反思智能体",
    caModules: ["Articulation", "Reflection"],
    responsibility: "backend-reflection-articulation",
  },
};

export async function verifyAaisReleaseEvidence(input = {}) {
  const checkedAt = (input.now ?? new Date()).toISOString();
  const now = new Date(checkedAt);
  const maxAgeHours = readPositiveNumber(
    input.maxAgeHours ?? process.env.AAIS_RELEASE_EVIDENCE_MAX_AGE_HOURS,
    168,
  );
  const expectedDeploymentUrl = normalizeBaseUrl(
    input.deploymentUrl ?? process.env.AAIS_RELEASE_DEPLOYMENT_URL,
  );
  const expectedDeploymentPlatform = readDeploymentPlatform(
    input.deploymentPlatform ?? process.env.AAIS_RELEASE_DEPLOYMENT_PLATFORM,
  );
  const expectedDatabaseProvider = readDatabaseProvider(
    input.databaseProvider ?? process.env.AAIS_RELEASE_DATABASE_PROVIDER,
  );
  const expectedAuthMode = readAuthMode(
    input.authMode ?? process.env.AAIS_RELEASE_AUTH_MODE ?? process.env.AAIS_VERCEL_ENV_AUTH_MODE,
  );
  const sourceProvenance = await verifySourceProvenanceReport(
    input.sourceProvenanceReportPath
      ?? process.env.AAIS_RELEASE_SOURCE_PROVENANCE_REPORT_PATH
      ?? defaultSourceProvenanceReportPath,
    readReleaseId(input.releaseId ?? process.env.AAIS_RELEASE_ID) ?? null,
    { now, maxAgeHours },
  );
  const vercelEnv = await verifyVercelEnvReport(
    input.vercelEnvReportPath ?? process.env.AAIS_RELEASE_VERCEL_ENV_REPORT_PATH,
    { now, maxAgeHours, expectedAuthMode },
  );
  const enterprise = await verifyEnterpriseReport(
    input.enterpriseReportPath ?? process.env.AAIS_RELEASE_ENTERPRISE_REPORT_PATH,
    {
      now,
      maxAgeHours,
      expectedDeploymentUrl,
      expectedDeploymentPlatform,
      expectedDatabaseProvider,
      expectedAuthMode,
      vercelEnvCheckedAt: vercelEnv.checkedAt,
    },
  );
  const expectedReleaseId = enterprise.release?.id ?? null;
  const vercelDeployment = await verifyVercelDeploymentReport(
    input.vercelDeploymentReportPath
      ?? process.env.AAIS_RELEASE_VERCEL_DEPLOYMENT_REPORT_PATH
      ?? defaultVercelDeploymentReportPath,
    expectedReleaseId,
    expectedDeploymentUrl,
    { now, maxAgeHours },
  );
  if (vercelDeployment.deployment) {
    vercelDeployment.deployment.gitCommitMatchesEnterprise = getDeploymentGitCommitMatchesEnterprise(
      vercelDeployment,
      enterprise,
    );
  }
  if (sourceProvenance.source) {
    sourceProvenance.source.gitCommitMatchesDeployment = getSourceGitCommitMatchesDeployment(
      sourceProvenance,
      vercelDeployment,
    );
  }
  if (vercelDeployment.status === "passed"
    && vercelDeployment.deployment?.gitCommitMatchesEnterprise !== true) {
    vercelDeployment.status = "failed";
  }
  if (sourceProvenance.status === "passed"
    && sourceProvenance.source?.gitCommitMatchesDeployment !== true) {
    sourceProvenance.status = "failed";
  }
  enterprise.evidenceOrder = getEnterpriseEvidenceOrder(
    enterprise.checkedAt,
    vercelEnv.checkedAt,
    vercelDeployment.checkedAt,
  );
  if (enterprise.status === "passed"
    && (!enterprise.evidenceOrder.enterpriseAfterVercelEnv
      || !enterprise.evidenceOrder.enterpriseAfterVercelDeployment)) {
    enterprise.status = "failed";
  }
  const aiEval = await verifyAiEvalManifest(
    input.aiEvalManifestPath ?? process.env.AAIS_RELEASE_AI_EVAL_MANIFEST_PATH,
    enterprise.aiReadiness,
    expectedReleaseId,
    { now, maxAgeHours },
  );
  const postgresRestore = await verifyPostgresRestoreReport(
    input.postgresRestoreReportPath ?? process.env.AAIS_RELEASE_POSTGRES_RESTORE_REPORT_PATH,
    expectedReleaseId,
    expectedDatabaseProvider,
    { now, maxAgeHours },
  );
  const vercelConfig = await verifyVercelConfig(
    input.vercelConfigPath ?? process.env.AAIS_RELEASE_VERCEL_CONFIG_PATH ?? defaultVercelConfigPath,
  );
  const releaseConsistent = [sourceProvenance, enterprise, vercelDeployment, aiEval, postgresRestore]
    .every((artifact) => artifact.release?.matchesExpected === true);

  const report = {
    schemaVersion: 1,
    status: [sourceProvenance, vercelEnv, enterprise, vercelDeployment, aiEval, postgresRestore, vercelConfig]
      .every((artifact) => artifact.status === "passed")
      ? "passed"
      : "failed",
    checkedAt,
    artifacts: {
      vercelEnv,
      sourceProvenance,
      enterprise,
      vercelDeployment,
      aiEval,
      postgresRestore,
      vercelConfig,
    },
    release: {
      id: expectedReleaseId,
      consistent: releaseConsistent,
    },
    freshnessPolicy: {
      maxAgeHours,
    },
    redaction: {
      secrets: "omitted",
      cookies: "attributes-only",
      prompts: "summarized",
    },
  };

  const outputPath = input.outputPath ?? process.env.AAIS_RELEASE_EVIDENCE_REPORT_PATH;
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  return report;
}

async function verifySourceProvenanceReport(filePath, expectedReleaseId, freshnessInput) {
  const artifact = await readJsonArtifact(filePath);
  if (!artifact.ok) {
    return missingArtifact(artifact.reason);
  }

  const report = artifact.value;
  const source = report?.source ?? {};
  const gitCommitShortSha = readGitCommitShortSha(source.gitCommitShortSha);
  const freshness = getFreshness(report?.checkedAt, freshnessInput);
  const secretScan = artifact.secretScan;
  const release = getReleaseStatus(report?.release, expectedReleaseId);
  const redactionOk = report?.redaction?.secrets === "omitted"
    && report?.redaction?.fileNames === "not-included"
    && report?.redaction?.gitStatus === "counts-only";
  const clean = source.clean === true
    && source.gitHeadPresent === true
    && Boolean(gitCommitShortSha)
    && source.workingTree?.total === 0;
  const status = report?.schemaVersion === 1
    && report?.status === "passed"
    && clean
    && freshness.withinMaxAge
    && secretScan.status === "passed"
    && release.matchesExpected
    && redactionOk
    ? "passed"
    : "failed";

  return {
    status,
    reportedStatus: normalizeStatus(report?.status),
    checkedAt: typeof report?.checkedAt === "string" ? report.checkedAt : null,
    freshness,
    secretScan,
    release,
    source: {
      gitHeadPresent: source.gitHeadPresent === true,
      gitCommitShortSha,
      clean,
      workingTree: {
        total: readNonNegativeInteger(source.workingTree?.total),
        staged: readNonNegativeInteger(source.workingTree?.staged),
        unstaged: readNonNegativeInteger(source.workingTree?.unstaged),
        untracked: readNonNegativeInteger(source.workingTree?.untracked),
      },
      errorCategory: readSafeErrorCategory(source.errorCategory),
    },
    redaction: {
      secrets: report?.redaction?.secrets === "omitted" ? "omitted" : "invalid",
      fileNames: report?.redaction?.fileNames === "not-included" ? "not-included" : "invalid",
      gitStatus: report?.redaction?.gitStatus === "counts-only" ? "counts-only" : "invalid",
    },
  };
}

async function verifyVercelDeploymentReport(filePath, expectedReleaseId, expectedDeploymentUrl, freshnessInput) {
  const artifact = await readJsonArtifact(filePath);
  if (!artifact.ok) {
    return missingArtifact(artifact.reason);
  }

  const report = artifact.value;
  const deployment = report?.deployment ?? {};
  const inspectedUrl = normalizeBaseUrl(deployment.url);
  const expectedUrl = normalizeBaseUrl(deployment.expectedUrl);
  const aliases = Array.isArray(deployment.aliases)
    ? deployment.aliases.map(normalizeBaseUrl).filter(Boolean)
    : [];
  const readyState = deployment.readyState === "READY" ? "READY" : normalizeReportString(deployment.readyState);
  const target = deployment.target === "production" ? "production" : normalizeReportString(deployment.target);
  const urlMatchesExpected = deployment.urlMatchesExpected === true
    && expectedUrl === expectedDeploymentUrl;
  const targetMatchesProduction = deployment.targetMatchesProduction === true
    && target === "production";
  const freshness = getFreshness(report?.checkedAt, freshnessInput);
  const secretScan = artifact.secretScan;
  const inspectSecretScan = normalizeStatus(report?.inspect?.secretScan?.status);
  const release = getReleaseStatus(report?.release, expectedReleaseId);
  const gitCommitShortSha = readGitCommitShortSha(deployment.gitCommitShortSha);
  const gitCommitSource = readGitCommitSource(deployment.gitCommitSource);
  const redactionOk = report?.redaction?.secrets === "omitted"
    && report?.redaction?.rawInspectOutput === "not-stored"
    && report?.redaction?.values === "summarized";
  const status = report?.schemaVersion === 1
    && report?.status === "passed"
    && readyState === "READY"
    && urlMatchesExpected
    && targetMatchesProduction
    && freshness.withinMaxAge
    && secretScan.status === "passed"
    && inspectSecretScan === "passed"
    && release.matchesExpected
    && Boolean(gitCommitShortSha)
    && redactionOk
    ? "passed"
    : "failed";

  return {
    status,
    reportedStatus: normalizeStatus(report?.status),
    checkedAt: typeof report?.checkedAt === "string" ? report.checkedAt : null,
    freshness,
    secretScan,
    inspectSecretScan,
    release,
    deployment: {
      url: inspectedUrl,
      expectedUrl,
      expectedDeploymentUrl,
      urlMatchesExpected,
      aliases,
      readyState,
      target,
      targetMatchesProduction,
      gitCommitShortSha,
      gitCommitSource,
    },
    redaction: {
      secrets: report?.redaction?.secrets === "omitted" ? "omitted" : "invalid",
      rawInspectOutput: report?.redaction?.rawInspectOutput === "not-stored" ? "not-stored" : "invalid",
      values: report?.redaction?.values === "summarized" ? "summarized" : "invalid",
    },
  };
}

function getDeploymentGitCommitMatchesEnterprise(vercelDeployment, enterprise) {
  const deploymentGitCommit = vercelDeployment?.deployment?.gitCommitShortSha;
  const enterpriseGitCommit = enterprise?.releaseIdentityEvidence?.deploymentGitCommitShortSha;
  return Boolean(deploymentGitCommit && enterpriseGitCommit && deploymentGitCommit === enterpriseGitCommit);
}

function getSourceGitCommitMatchesDeployment(sourceProvenance, vercelDeployment) {
  const sourceGitCommit = sourceProvenance?.source?.gitCommitShortSha;
  const deploymentGitCommit = vercelDeployment?.deployment?.gitCommitShortSha;
  return Boolean(sourceGitCommit && deploymentGitCommit && sourceGitCommit === deploymentGitCommit);
}

async function verifyVercelEnvReport(filePath, freshnessInput) {
  const artifact = await readJsonArtifact(filePath);
  if (!artifact.ok) {
    return missingArtifact(artifact.reason);
  }

  const report = artifact.value;
  const target = getVercelEnvTargetStatus(report?.target, freshnessInput.expectedAuthMode);
  const missing = getSafeEnvNames(report?.required?.missing);
  const categories = getSafeEnvCategories(report?.categories);
  const categoriesEmpty = Object.values(categories).every((items) => items.length === 0);
  const redactionOk = report?.redaction?.secrets === "omitted"
    && report?.redaction?.values === "not-read";
  const freshness = getFreshness(report?.checkedAt, freshnessInput);
  const secretScan = artifact.secretScan;
  const status = report?.schemaVersion === 1
    && report?.status === "passed"
    && target.environmentMatchesExpected
    && target.authModeMatchesExpected
    && target.aiModeMatchesExpected
    && missing.length === 0
    && categoriesEmpty
    && redactionOk
    && freshness.withinMaxAge
    && secretScan.status === "passed"
    ? "passed"
    : "failed";

  return {
    status,
    reportedStatus: normalizeStatus(report?.status),
    checkedAt: typeof report?.checkedAt === "string" ? report.checkedAt : null,
    target,
    missingCount: missing.length,
    missing,
    categories,
    freshness,
    secretScan,
    redaction: {
      secrets: report?.redaction?.secrets === "omitted" ? "omitted" : "invalid",
      values: report?.redaction?.values === "not-read" ? "not-read" : "invalid",
    },
  };
}

async function verifyEnterpriseReport(filePath, freshnessInput) {
  const artifact = await readJsonArtifact(filePath);
  if (!artifact.ok) {
    return missingArtifact(artifact.reason);
  }

  const report = artifact.value;
  const readinessCheck = Array.isArray(report?.checks)
    ? report.checks.find((check) => check?.name === "readiness")
    : null;
  const checks = new Map(
    Array.isArray(report?.checks)
      ? report.checks.map((check) => [check?.name, check?.status])
      : [],
  );
  const checkDetails = new Map(
    Array.isArray(report?.checks)
      ? report.checks.map((check) => [check?.name, check?.details])
      : [],
  );
  const oidcStartEvidence = getOidcStartEvidence(checkDetails.get("oidc-start"));
  const oidcCallbackEvidence = getOidcCallbackEvidence(checkDetails.get("oidc-callback"));
  const cohortAnalyticsEvidence = getCohortAnalyticsEvidence(checkDetails.get("cohort-analytics"));
  const oidcRoleMappingEvidence = getOidcRoleMappingEvidence(readinessCheck?.details);
  const releaseIdentityEvidence = getReadinessReleaseIdentityEvidence(readinessCheck?.details);
  const lrsOutboxEvidence = getLrsOutboxEvidence(readinessCheck?.details);
  const lrsHealthEvidence = getLrsHealthEvidence(checkDetails.get("lrs-health"));
  const agentEvidence = getAgentEvidence(readinessCheck?.details);
  const legalPagesEvidence = getLegalPagesEvidence(checkDetails.get("legal-pages"));
  const ssoOnlyRuntimeEvidence = getSsoOnlyRuntimeEvidence(checkDetails.get("sso-only-mode"));
  const expectedAuthMode = freshnessInput.expectedAuthMode === "sso-only" ? "sso-only" : "trial";
  const ssoOnlyRequired = expectedAuthMode === "sso-only";
  const requiredChecks = Object.fromEntries(
    requiredEnterpriseChecks.map(([name, field]) => [field, checks.get(name) === "passed"]),
  );
  requiredChecks.readiness = requiredChecks.readiness
    && (!ssoOnlyRequired || oidcRoleMappingEvidence.complete)
    && releaseIdentityEvidence.complete;
  requiredChecks.lrsHealth = requiredChecks.lrsHealth
    && lrsOutboxEvidence.complete
    && lrsHealthEvidence.complete;
  requiredChecks.agentEvidence = agentEvidence.complete;
  requiredChecks.a3Supervision = agentEvidence.complete;
  requiredChecks.a2Monitoring = agentEvidence.complete;
  requiredChecks.legalPages = requiredChecks.legalPages
    && legalPagesEvidence.complete;
  requiredChecks.cohortAnalytics = requiredChecks.cohortAnalytics
    && cohortAnalyticsEvidence.aggregateProofComplete
    && cohortAnalyticsEvidence.exportProofComplete
    && (!ssoOnlyRequired || cohortAnalyticsEvidence.ssoOnlyEducatorProofComplete);
  requiredChecks.oidcStart = ssoOnlyRequired
    ? requiredChecks.oidcStart && oidcStartEvidence.completeAuthorizationCodeRequest
    : checks.get("oidc-start") === "skipped" || requiredChecks.oidcStart;
  requiredChecks.oidcCallback = ssoOnlyRequired
    ? requiredChecks.oidcCallback && oidcCallbackEvidence.learningSessionHandoffComplete
    : checks.get("oidc-callback") === "skipped" || requiredChecks.oidcCallback;
  requiredChecks.ssoOnlyMode = ssoOnlyRequired
    ? requiredChecks.ssoOnlyMode && ssoOnlyRuntimeEvidence.complete
    : checks.get("sso-only-mode") === "skipped" || requiredChecks.ssoOnlyMode;
  const redactionOk = report?.redaction?.secrets === "omitted"
    && report?.redaction?.cookies === "attributes-only";
  const freshness = getFreshness(report?.checkedAt, freshnessInput);
  const secretScan = artifact.secretScan;
  const release = getReleaseStatus(report?.release);
  const deployment = getDeploymentStatus(report?.baseUrl, freshnessInput.expectedDeploymentUrl);
  const deploymentPlatform = getDeploymentPlatformStatus(
    readinessCheck?.details,
    freshnessInput.expectedDeploymentPlatform,
  );
  const storageProvider = getDatabaseProviderStatus(
    readinessCheck?.details?.storageProvider,
    freshnessInput.expectedDatabaseProvider,
  );
  const evidenceOrder = getEnterpriseEvidenceOrder(report?.checkedAt, freshnessInput.vercelEnvCheckedAt);
  const optionalChecks = {
    trialLearningSession: normalizeStatus(checks.get("trial-learning-session")),
    trialLoginThrottle: normalizeStatus(checks.get("trial-login-throttle")),
  };
  const ssoOnlyEvidence = {
    trialLearningSessionSkipped: optionalChecks.trialLearningSession === "skipped",
    trialLoginThrottleSkipped: optionalChecks.trialLoginThrottle === "skipped",
  };
  ssoOnlyEvidence.trialChecksSkipped = ssoOnlyEvidence.trialLearningSessionSkipped
    && ssoOnlyEvidence.trialLoginThrottleSkipped;
  const trialAuthEvidence = {
    trialLearningSessionPassed: optionalChecks.trialLearningSession === "passed",
    trialLoginThrottlePassed: optionalChecks.trialLoginThrottle === "passed",
  };
  trialAuthEvidence.trialChecksPassed = trialAuthEvidence.trialLearningSessionPassed
    && trialAuthEvidence.trialLoginThrottlePassed;
  requiredChecks.trialLearningSession = ssoOnlyRequired
    ? ssoOnlyEvidence.trialLearningSessionSkipped
    : trialAuthEvidence.trialLearningSessionPassed;
  requiredChecks.trialLoginThrottle = ssoOnlyRequired
    ? ssoOnlyEvidence.trialLoginThrottleSkipped
    : trialAuthEvidence.trialLoginThrottlePassed;
  const status = report?.status === "passed"
    && redactionOk
    && freshness.withinMaxAge
    && secretScan.status === "passed"
    && release.matchesExpected
    && deployment.matchesExpected
    && deploymentPlatform.matchesExpected
    && storageProvider.matchesExpected
    && evidenceOrder.enterpriseAfterVercelEnv
    && Object.values(requiredChecks).every(Boolean)
    && (ssoOnlyRequired ? ssoOnlyEvidence.trialChecksSkipped : trialAuthEvidence.trialChecksPassed)
    ? "passed"
    : "failed";

  return {
    status,
    reportedStatus: normalizeStatus(report?.status),
    checkedAt: typeof report?.checkedAt === "string" ? report.checkedAt : null,
    freshness,
    secretScan,
    release,
    deployment,
    deploymentPlatform,
    storageProvider,
    evidenceOrder,
    requiredChecks,
    cohortAnalyticsEvidence,
    oidcRoleMappingEvidence,
    releaseIdentityEvidence,
    lrsOutboxEvidence,
    lrsHealthEvidence,
    agentEvidence,
    a3SupervisionEvidence: agentEvidence,
    a2MonitoringEvidence: agentEvidence,
    legalPagesEvidence,
    oidcStartEvidence,
    oidcCallbackEvidence,
    ssoOnlyRuntimeEvidence,
    optionalChecks,
    ssoOnlyEvidence,
    trialAuthEvidence,
    aiReadiness: normalizeAiReadiness(readinessCheck?.details),
    redaction: {
      secrets: redactionOk ? "omitted" : "invalid",
      cookies: report?.redaction?.cookies === "attributes-only" ? "attributes-only" : "invalid",
    },
  };
}

async function verifyAiEvalManifest(filePath, aiReadiness, expectedReleaseId, freshnessInput) {
  const artifact = await readJsonArtifact(filePath);
  if (!artifact.ok) {
    return missingArtifact(artifact.reason);
  }

  const manifest = artifact.value;
  const sampleCount = Number(manifest?.sampleCount ?? 0);
  const blockedCount = Number(manifest?.blockedCount ?? 0);
  const compatibleWithEnterpriseReadiness = aiReadiness?.provider === "openai-compatible"
    && aiReadiness?.evalManifest === "verified"
    && typeof aiReadiness?.evalVersion === "string"
    && aiReadiness.evalVersion === manifest?.evalVersion
    && manifest?.provider === aiReadiness.provider;
  const redactionOk = manifest?.redaction?.prompts === "summarized"
    && manifest?.redaction?.secrets === "omitted";
  const freshness = getFreshness(manifest?.passedAt, freshnessInput);
  const secretScan = artifact.secretScan;
  const release = getReleaseStatus(manifest?.release, expectedReleaseId);
  const modelFingerprint = getAiModelFingerprint(manifest?.model);
  const agentEvidence = getAiEvalAgentEvidence(manifest?.agentEvidence);
  const enterpriseModelFingerprint = aiReadiness?.modelFingerprint ?? null;
  const modelFingerprintStatus = {
    value: modelFingerprint,
    enterpriseValue: enterpriseModelFingerprint,
    matchesEnterprise: Boolean(
      modelFingerprint
        && enterpriseModelFingerprint
        && modelFingerprint === enterpriseModelFingerprint,
    ),
  };
  const status = manifest?.schemaVersion === 1
    && manifest?.provider === "openai-compatible"
    && manifest?.status === "passed"
    && sampleCount > 0
    && blockedCount === 0
    && compatibleWithEnterpriseReadiness
    && agentEvidence.complete
    && modelFingerprintStatus.matchesEnterprise
    && freshness.withinMaxAge
    && secretScan.status === "passed"
    && release.matchesExpected
    && redactionOk
    ? "passed"
    : "failed";

  return {
    status,
    reportedStatus: normalizeStatus(manifest?.status),
    provider: manifest?.provider === "openai-compatible" ? "openai-compatible" : "invalid",
    evalVersion: typeof manifest?.evalVersion === "string" ? manifest.evalVersion : null,
    sampleCount: Number.isFinite(sampleCount) ? sampleCount : 0,
    blockedCount: Number.isFinite(blockedCount) ? blockedCount : 0,
    compatibleWithEnterpriseReadiness,
    agentEvidence,
    modelFingerprint: modelFingerprintStatus,
    freshness,
    secretScan,
    release,
    redaction: {
      prompts: manifest?.redaction?.prompts === "summarized" ? "summarized" : "invalid",
      secrets: manifest?.redaction?.secrets === "omitted" ? "omitted" : "invalid",
    },
  };
}

function getAiEvalAgentEvidence(value) {
  const requiredAgents = Array.isArray(value?.requiredAgents)
    ? requiredAiEvalAgentIds.filter((agentId) => value.requiredAgents.includes(agentId))
    : [];
  const coveredAgents = Array.isArray(value?.coveredAgents)
    ? requiredAiEvalAgentIds.filter((agentId) => value.coveredAgents.includes(agentId))
    : [];
  const requiredCaModules = Array.isArray(value?.requiredCaModules)
    ? requiredAiEvalCaModules.filter((module) => value.requiredCaModules.includes(module))
    : [];
  const coveredCaModules = Array.isArray(value?.coveredCaModules)
    ? requiredAiEvalCaModules.filter((module) => value.coveredCaModules.includes(module))
    : [];
  const coverage = getAiEvalAgentCoverage(value?.coverage);
  const complete = value?.contractVersion === aiEvalAgentEvidenceContractVersion
    && value?.complete === true
    && value?.caBackgroundIncluded === true
    && value?.rawPromptsStored === false
    && value?.rawOutputsStored === false
    && requiredAgents.length === requiredAiEvalAgentIds.length
    && coveredAgents.length === requiredAiEvalAgentIds.length
    && requiredCaModules.length === requiredAiEvalCaModules.length
    && coveredCaModules.length === requiredAiEvalCaModules.length
    && coverage.complete;

  return {
    contractVersion: value?.contractVersion === aiEvalAgentEvidenceContractVersion
      ? aiEvalAgentEvidenceContractVersion
      : "invalid",
    requiredAgents,
    coveredAgents,
    requiredCaModules,
    coveredCaModules,
    coverage: coverage.value,
    coverageComplete: coverage.complete,
    caBackgroundIncluded: value?.caBackgroundIncluded === true,
    rawPromptsStored: value?.rawPromptsStored === false ? false : null,
    rawOutputsStored: value?.rawOutputsStored === false ? false : null,
    complete,
  };
}

function getAiEvalAgentCoverage(value) {
  const sanitized = Object.fromEntries(
    Object.entries(requiredAiEvalAgentContracts).map(([agentId, contract]) => {
      const raw = value?.[agentId] ?? {};
      const sampleIds = getSafeAiEvalSampleIds(raw.sampleIds);
      const caModules = Array.isArray(raw.caModules)
        ? contract.caModules.filter((module) => raw.caModules.includes(module))
        : [];
      const label = raw.label === contract.label ? contract.label : "invalid";
      const responsibility = raw.responsibility === contract.responsibility
        ? contract.responsibility
        : "invalid";
      return [
        agentId,
        {
          label,
          responsibility,
          sampleIds,
          caModules,
          complete: raw.complete === true
            && label === contract.label
            && responsibility === contract.responsibility
            && sampleIds.length > 0
            && arraysEqual(caModules, contract.caModules),
        },
      ];
    }),
  );
  return {
    value: sanitized,
    complete: Object.values(sanitized).every((agent) => agent.complete),
  };
}

function getSafeAiEvalSampleIds(value) {
  return Array.isArray(value)
    ? value
      .map((sampleId) => String(sampleId ?? "").trim())
      .filter((sampleId) => /^[A-Za-z0-9][A-Za-z0-9._:-]{1,80}$/.test(sampleId))
    : [];
}

async function verifyPostgresRestoreReport(filePath, expectedReleaseId, expectedDatabaseProvider, freshnessInput) {
  const artifact = await readJsonArtifact(filePath);
  if (!artifact.ok) {
    return missingArtifact(artifact.reason);
  }

  const restore = artifact.value;
  const checks = restore?.checks ?? {};
  const sameAsSource = restore?.target?.sameAsSource === true;
  const targetPurpose = restore?.target?.purpose === "restored-staging" ? "restored-staging" : "invalid";
  const tablePresent = checks.tablePresent === true;
  const lrsOutboxTablePresent = checks.lrsOutboxTablePresent === true;
  const smokeInsertOnly = checks.smokeInsertOnly === true;
  const smokeInserted = checks.smokeInserted === true;
  const smokeReadBack = checks.smokeReadBack === true;
  const smokeDeleted = checks.smokeDeleted === true;
  const redactionOk = restore?.target?.databaseUrl === "redacted"
    && restore?.redaction?.secrets === "omitted";
  const freshness = getFreshness(restore?.checkedAt, freshnessInput);
  const secretScan = artifact.secretScan;
  const release = getReleaseStatus(restore?.release, expectedReleaseId);
  const provider = getDatabaseProviderStatus(restore?.target?.provider, expectedDatabaseProvider);
  const status = restore?.schemaVersion === 1
    && restore?.status === "passed"
    && targetPurpose === "restored-staging"
    && !sameAsSource
    && tablePresent
    && lrsOutboxTablePresent
    && smokeInsertOnly
    && smokeInserted
    && smokeReadBack
    && smokeDeleted
    && freshness.withinMaxAge
    && secretScan.status === "passed"
    && release.matchesExpected
    && provider.matchesExpected
    && redactionOk
    ? "passed"
    : "failed";

  return {
    status,
    reportedStatus: normalizeStatus(restore?.status),
    checkedAt: typeof restore?.checkedAt === "string" ? restore.checkedAt : null,
    freshness,
    secretScan,
    release,
    provider,
    targetPurpose,
    sameAsSource,
    tablePresent,
    lrsOutboxTablePresent,
    smokeInsertOnly,
    smokeInserted,
    smokeReadBack,
    smokeDeleted,
    redaction: {
      databaseUrl: restore?.target?.databaseUrl === "redacted" ? "redacted" : "invalid",
      secrets: restore?.redaction?.secrets === "omitted" ? "omitted" : "invalid",
    },
  };
}

async function verifyVercelConfig(filePath) {
  const artifact = await readJsonArtifact(filePath);
  if (!artifact.ok) {
    return missingArtifact(artifact.reason);
  }

  const config = artifact.value;
  const crons = Array.isArray(config?.crons) ? config.crons : [];
  const outboxCron = crons.find((cron) => cron?.path === lrsOutboxCronPath);
  const schedule = readSafeCronSchedule(outboxCron?.schedule);
  const dailyCadence = isDailyCronSchedule(schedule);
  const secretScan = artifact.secretScan;
  const status = secretScan.status === "passed"
    && Boolean(outboxCron)
    && dailyCadence
    ? "passed"
    : "failed";

  return {
    status,
    path: lrsOutboxCronPath,
    cronCount: crons.length,
    outboxCronPresent: Boolean(outboxCron),
    outboxCronSchedule: schedule,
    outboxCronDaily: dailyCadence,
    secretScan,
    redaction: {
      secrets: "omitted",
      values: "not-read",
    },
  };
}

async function readJsonArtifact(filePath) {
  const resolvedPath = String(filePath ?? "").trim();
  if (!resolvedPath) {
    return { ok: false, reason: "not-supplied" };
  }
  try {
    const raw = await readFile(resolvedPath, "utf8");
    return {
      ok: true,
      value: JSON.parse(raw),
      secretScan: scanSecretLikeContent(raw),
    };
  } catch {
    return { ok: false, reason: "unreadable-or-invalid-json" };
  }
}

function missingArtifact(reason) {
  return {
    status: "missing",
    reason,
  };
}

function normalizeAiReadiness(details) {
  if (!details || typeof details !== "object") {
    return {
      provider: "missing",
      evalVersion: null,
      evalManifest: "missing",
    };
  }
  return {
    provider: details.aiProvider === "openai-compatible" || details.aiProvider === "deterministic"
      ? details.aiProvider
      : "missing",
    evalVersion: typeof details.aiEvalVersion === "string" ? details.aiEvalVersion : null,
    evalManifest: typeof details.aiEvalManifest === "string" ? details.aiEvalManifest : "missing",
    modelFingerprint: readAiModelFingerprint(details.aiModelFingerprint),
  };
}

function normalizeStatus(value) {
  return typeof value === "string" ? value : "missing";
}

function getCohortAnalyticsEvidence(details = {}) {
  const authSource = typeof details?.authSource === "string" ? details.authSource : "trial-login";
  const loginStatus = Number.isInteger(details?.loginStatus) ? details.loginStatus : null;
  const analyticsStatus = Number.isInteger(details?.analyticsStatus) ? details.analyticsStatus : null;
  const learnerRows = Number.isInteger(details?.learnerRows) ? details.learnerRows : null;
  const evidence = {
    authSource,
    loginStatus,
    authSessionEstablished: details?.authSessionEstablished === true,
    educatorSessionRole: readSessionRole(details?.educatorSessionRole),
    educatorSessionRoleEvidence: details?.educatorSessionRoleEvidence === true,
    expectedSessionRole: readSessionRole(details?.expectedSessionRole),
    educatorSessionRoleMatchesExpected: details?.educatorSessionRoleMatchesExpected === true,
    educatorRoleAccepted: details?.educatorRoleAccepted === true,
    analyticsStatus,
    filtersApplied: details?.filtersApplied === true,
    learnerRows,
    learnerKeysPseudonymous: details?.learnerKeysPseudonymous === true,
    sessionKeysPseudonymous: details?.sessionKeysPseudonymous === true,
    aggregateCountsPresent: details?.aggregateCountsPresent === true,
    riskBreakdownPresent: details?.riskBreakdownPresent === true,
    learnerRiskLevelsPresent: details?.learnerRiskLevelsPresent === true,
    priorityReasonsStable: details?.priorityReasonsStable === true,
    aiAcceptanceDecisionsPresent: details?.aiAcceptanceDecisionsPresent === true,
    factLayerLrs: details?.factLayerLrs === true,
    privacyPseudonymous: details?.privacyPseudonymous === true,
    noRawLearnerText: details?.noRawLearnerText === true,
    exportStatus: Number.isInteger(details?.exportStatus) ? details.exportStatus : null,
    exportDispositionPresent: details?.exportDispositionPresent === true,
    exportScopeCohort: details?.exportScopeCohort === true,
    exportFiltersApplied: details?.exportFiltersApplied === true,
    exportLearnerRowsMatch: details?.exportLearnerRowsMatch === true,
    exportLearnerKeysPseudonymous: details?.exportLearnerKeysPseudonymous === true,
    exportSessionKeysPseudonymous: details?.exportSessionKeysPseudonymous === true,
    exportPrivacyPseudonymous: details?.exportPrivacyPseudonymous === true,
    exportNoRawLearnerText: details?.exportNoRawLearnerText === true,
    exportSecrets: details?.exportSecrets === "redacted" ? "redacted" : "unknown",
    secrets: details?.secrets === "redacted" ? "redacted" : "unknown",
  };
  const authProofComplete = evidence.loginStatus === 200
    || (evidence.authSource === "oidc-callback" && evidence.authSessionEstablished);
  const exportProofComplete = evidence.exportStatus === 200
    && evidence.exportDispositionPresent
    && evidence.exportScopeCohort
    && evidence.exportFiltersApplied
    && evidence.exportLearnerRowsMatch
    && evidence.exportLearnerKeysPseudonymous
    && evidence.exportSessionKeysPseudonymous
    && evidence.exportPrivacyPseudonymous
    && evidence.exportNoRawLearnerText
    && evidence.exportSecrets === "redacted";
  return {
    ...evidence,
    ssoOnlyEducatorProofComplete: evidence.authSource === "oidc-callback"
      && evidence.authSessionEstablished
      && evidence.educatorSessionRoleEvidence
      && evidence.educatorSessionRoleMatchesExpected,
    exportProofComplete,
    aggregateProofComplete: authProofComplete
      && evidence.educatorRoleAccepted
      && evidence.analyticsStatus === 200
      && evidence.filtersApplied
      && Number.isInteger(evidence.learnerRows)
      && evidence.learnerRows >= 0
      && evidence.learnerKeysPseudonymous
      && evidence.sessionKeysPseudonymous
      && evidence.aggregateCountsPresent
      && evidence.riskBreakdownPresent
      && evidence.learnerRiskLevelsPresent
      && evidence.priorityReasonsStable
      && evidence.aiAcceptanceDecisionsPresent
      && evidence.factLayerLrs
      && evidence.privacyPseudonymous
      && evidence.noRawLearnerText
      && evidence.secrets === "redacted",
  };
}

function getOidcStartEvidence(details) {
  const evidence = {
    redirectsToHttpsProvider: details?.redirectsToHttpsProvider === true,
    responseTypeCode: details?.responseTypeCode === true,
    hasClientId: details?.hasClientId === true,
    hasRedirectUri: details?.hasRedirectUri === true,
    redirectUriMatchesCallback: details?.redirectUriMatchesCallback === true,
    hasStateParam: details?.hasStateParam === true,
    hasNonceParam: details?.hasNonceParam === true,
    hasPkceChallenge: details?.hasPkceChallenge === true,
    pkceMethodS256: details?.pkceMethodS256 === true,
    scopeIncludesOpenid: details?.scopeIncludesOpenid === true,
    stateCookieHttpOnly: details?.stateCookieHttpOnly === true,
    stateCookieSecure: details?.stateCookieSecure === true,
    stateCookieSameSiteLax: details?.stateCookieSameSiteLax === true,
  };
  return {
    ...evidence,
    completeAuthorizationCodeRequest: Object.values(evidence).every(Boolean),
  };
}

function getOidcRoleMappingEvidence(details) {
  const present = readOidcRoleMappingNames(details?.oidcRoleMappingPresent);
  const evidence = {
    mode: readOidcMode(details?.oidcMode),
    status: readReadinessCheckStatus(details?.oidcRoleMappingStatus),
    configured: details?.oidcRoleMappingConfigured === true,
    present,
    redaction: details?.oidcRoleMappingRedaction === "names-only" ? "names-only" : "unknown",
  };
  return {
    ...evidence,
    complete: (
      (evidence.mode === "explicit" || evidence.mode === "discovery")
      && evidence.status === "ok"
      && evidence.configured
      && evidence.present.length > 0
      && evidence.redaction === "names-only"
    ),
  };
}

function getReadinessReleaseIdentityEvidence(details) {
  const releaseId = readReleaseId(details?.releaseId);
  const expectedReleaseId = readReleaseId(details?.expectedReleaseId);
  const gitCommitShortSha = readGitCommitShortSha(details?.deploymentGitCommitShortSha);
  const evidence = {
    releaseId,
    expectedReleaseId,
    releaseIdRequired: details?.releaseIdRequired === true,
    releaseIdMatchesExpected: details?.releaseIdMatchesExpected === true,
    releaseSource: details?.releaseSource === "AAIS_RELEASE_ID" ? "AAIS_RELEASE_ID" : "missing",
    deploymentProvider: details?.deploymentProvider === "vercel" ? "vercel" : "unknown",
    deploymentGitCommitPresent: details?.deploymentGitCommitPresent === true && Boolean(gitCommitShortSha),
    deploymentGitCommitShortSha: gitCommitShortSha,
    deploymentGitCommitSource: readDeploymentGitCommitSource(details?.deploymentGitCommitSource),
    releaseIdentityComplete: details?.releaseIdentityComplete === true,
  };
  return {
    ...evidence,
    complete: evidence.releaseIdRequired
      && Boolean(evidence.releaseId)
      && Boolean(evidence.expectedReleaseId)
      && evidence.releaseIdMatchesExpected
      && evidence.releaseSource === "AAIS_RELEASE_ID"
      && evidence.deploymentGitCommitPresent
      && evidence.releaseIdentityComplete,
  };
}

function getOidcCallbackEvidence(details) {
  const evidence = {
    callbackUrlMatchesBaseCallback: details?.callbackUrlMatchesBaseCallback === true,
    redirectsToLocalTarget: details?.redirectsToLocalTarget === true,
    setsSessionCookie: details?.setsSessionCookie === true,
    sessionCookieHttpOnly: details?.sessionCookieHttpOnly === true,
    sessionCookieSecure: details?.sessionCookieSecure === true,
    sessionCookieSameSiteLax: details?.sessionCookieSameSiteLax === true,
    setsCsrfCookie: details?.setsCsrfCookie === true,
    csrfCookieSecure: details?.csrfCookieSecure === true,
    csrfCookieSameSiteLax: details?.csrfCookieSameSiteLax === true,
    clearsStateCookie: details?.clearsStateCookie === true,
    setCookieDoesNotLeakCallbackUrl: details?.setCookieLeaksCallbackUrl === false,
    learningSessionStatus: details?.learningSessionStatus === 200 ? 200 : null,
    learningSessionReadable: details?.learningSessionReadable === true,
    learningSessionRole: readSessionRole(details?.learningSessionRole),
    learningSessionEducatorRole: details?.learningSessionEducatorRole === true,
    expectedSessionRole: readSessionRole(details?.expectedSessionRole),
    learningSessionRoleMatchesExpected: details?.learningSessionRoleMatchesExpected === true,
  };
  return {
    ...evidence,
    learningSessionHandoffComplete: evidence.callbackUrlMatchesBaseCallback
      && evidence.redirectsToLocalTarget
      && evidence.setsSessionCookie
      && evidence.sessionCookieHttpOnly
      && evidence.sessionCookieSecure
      && evidence.sessionCookieSameSiteLax
      && evidence.setsCsrfCookie
      && evidence.csrfCookieSecure
      && evidence.csrfCookieSameSiteLax
      && evidence.clearsStateCookie
      && evidence.setCookieDoesNotLeakCallbackUrl
      && evidence.learningSessionStatus === 200
      && evidence.learningSessionReadable
      && evidence.learningSessionEducatorRole
      && evidence.learningSessionRoleMatchesExpected,
  };
}

function readSessionRole(value) {
  const role = String(value ?? "").trim().toLowerCase();
  return role === "student" || role === "teacher" || role === "admin" ? role : "unknown";
}

function getSsoOnlyRuntimeEvidence(details = {}) {
  const evidence = {
    readinessTrialAccountsDisabled: details?.readinessTrialAccountsDisabled === true,
    loginPageHasSsoEntry: details?.loginPageHasSsoEntry === true,
    loginPageHasTrialForm: details?.loginPageHasTrialForm === true,
    appSessionPostDisabled: details?.appSessionPostDisabled === true,
    appSessionSetsSessionCookie: details?.appSessionSetsSessionCookie === true,
  };
  return {
    ...evidence,
    complete: evidence.readinessTrialAccountsDisabled
      && evidence.loginPageHasSsoEntry
      && !evidence.loginPageHasTrialForm
      && evidence.appSessionPostDisabled
      && !evidence.appSessionSetsSessionCookie,
  };
}

function getLrsOutboxEvidence(details = {}) {
  const mode = readLrsOutboxMode(details?.lrsOutboxMode);
  const storage = readLrsOutboxStorage(details?.lrsOutboxStorage);
  const metricsPresent = details?.lrsOutboxMetricsPresent === true;
  const artifactCoalescing = getArtifactCoalescingEvidence(details);
  const deadLetterRecovery = getLrsOutboxRecoveryEvidence(details);
  return {
    mode,
    storage,
    metricsPresent,
    artifactCoalescing: artifactCoalescing.policy,
    artifactCoalescingComplete: artifactCoalescing.complete,
    deadLetterRecovery: deadLetterRecovery.policy,
    deadLetterRecoveryComplete: deadLetterRecovery.complete,
    complete: mode === "persistent"
      && storage === "postgres"
      && metricsPresent
      && artifactCoalescing.complete
      && deadLetterRecovery.complete,
  };
}

function getLrsHealthEvidence(details = {}) {
  const status = details?.lrsStatus === "connected" ? "connected" : normalizeReportString(details?.lrsStatus);
  const outboxMode = readLrsOutboxMode(details?.lrsOutboxMode);
  const outboxStorage = readLrsOutboxStorage(details?.lrsOutboxStorage);
  const outboxMetricsPresent = details?.lrsOutboxMetricsPresent === true;
  const outboxRedaction = details?.lrsOutboxRedaction === "redacted" ? "redacted" : "unknown";
  const configured = details?.configured === true;
  const artifactCoalescing = getArtifactCoalescingEvidence(details);
  const deadLetterRecovery = getLrsOutboxRecoveryEvidence(details);
  return {
    status,
    configured,
    outboxMode,
    outboxStorage,
    outboxMetricsPresent,
    outboxRedaction,
    artifactCoalescing: artifactCoalescing.policy,
    artifactCoalescingComplete: artifactCoalescing.complete,
    deadLetterRecovery: deadLetterRecovery.policy,
    deadLetterRecoveryComplete: deadLetterRecovery.complete,
    complete: status === "connected"
      && configured
      && outboxMode === "persistent"
      && outboxStorage === "postgres"
      && outboxMetricsPresent
      && outboxRedaction === "redacted"
      && artifactCoalescing.complete
      && deadLetterRecovery.complete,
  };
}

function getAgentEvidence(details = {}) {
  const responsibilities = getAgentResponsibilitiesEvidence(details?.agentEvidenceResponsibilities);
  const agentContract = getAgentContractEvidence({
    version: details?.agentEvidenceContractVersion,
    requiredAgents: details?.agentEvidenceContractRequiredAgents,
    caModules: details?.agentEvidenceContractCaModules,
    roles: details?.agentEvidenceContractRoles,
    xapiExtensions: details?.agentEvidenceContractXapiExtensions,
    complete: details?.agentEvidenceContractComplete,
  });
  const expectedTriggers = [
    "monitoring_pause_detected",
    "coaching_push",
    "ai_acceptance_recorded",
  ];
  const expectedSignals = [
    "low_progress_artifact_autosave",
    "artifact_regression_autosave",
  ];
  const rawTriggers = Array.isArray(details?.agentEvidenceTriggers)
    ? details.agentEvidenceTriggers
    : Array.isArray(details?.a3SupervisionTriggers)
      ? details.a3SupervisionTriggers
    : Array.isArray(details?.a2MonitoringTriggers)
      ? details.a2MonitoringTriggers
      : [];
  const rawSignals = Array.isArray(details?.agentEvidenceSignals)
    ? details.agentEvidenceSignals
    : Array.isArray(details?.a3SupervisionSignals)
      ? details.a3SupervisionSignals
    : Array.isArray(details?.a2MonitoringSignals)
      ? details.a2MonitoringSignals
      : [];
  const triggers = expectedTriggers.filter((trigger) => rawTriggers.includes(trigger));
  const signals = expectedSignals.filter((signal) => rawSignals.includes(signal));
  const evidence = {
    enabled: details?.agentEvidenceEnabled === true
      || details?.a3SupervisionEnabled === true
      || details?.a2MonitoringEnabled === true,
    agentContract,
    agentResponsibilities: responsibilities.value,
    agentResponsibilitiesComplete: responsibilities.complete,
    triggers,
    signals,
    coachingInterruption: readAgentEvidenceValue(
      details?.agentEvidenceCoachingInterruption,
      details?.a2CoachingInterruption,
    ) === "low" ? "low" : "unknown",
    coachingCooldownSeconds: readIntegerValue(
      details?.agentEvidenceCoachingCooldownSeconds,
      details?.a2CoachingCooldownSeconds,
    ),
    artifactRegression: {
      minimumPreviousCharacters: readIntegerValue(
        details?.agentEvidenceArtifactRegressionMinimumPreviousCharacters,
        details?.a2ArtifactRegressionMinimumPreviousCharacters,
      ),
      minimumDropCharacters: readIntegerValue(
        details?.agentEvidenceArtifactRegressionMinimumDropCharacters,
        details?.a2ArtifactRegressionMinimumDropCharacters,
      ),
      rawTextExcluded: details?.agentEvidenceArtifactRegressionRawTextExcluded === true
        || details?.a2ArtifactRegressionRawTextExcluded === true,
    },
    aiAcceptance: {
      decisionKeyed: details?.agentEvidenceAiAcceptanceDecisionKeyed === true
        || details?.a2AiAcceptanceDecisionKeyed === true,
      revisions: details?.agentEvidenceAiAcceptanceRevisions === true
        || details?.a2AiAcceptanceRevisions === true,
      rawMessageIdsExcluded: details?.agentEvidenceAiAcceptanceRawMessageIdsExcluded === true
        || details?.a2AiAcceptanceRawMessageIdsExcluded === true,
      rationaleTextExcluded: details?.agentEvidenceAiAcceptanceRationaleTextExcluded === true
        || details?.a2AiAcceptanceRationaleTextExcluded === true,
    },
    redaction: readAgentEvidenceValue(
      details?.agentEvidenceRedaction,
      details?.a3SupervisionRedaction,
      details?.a2MonitoringRedaction,
    ) === "raw-learner-text-excluded"
      ? "raw-learner-text-excluded"
      : "unknown",
  };
  return {
    ...evidence,
    complete: evidence.enabled
      && agentContract.complete
      && responsibilities.complete
      && triggers.length === expectedTriggers.length
      && signals.length === expectedSignals.length
      && evidence.coachingInterruption === "low"
      && evidence.coachingCooldownSeconds === 600
      && evidence.artifactRegression.minimumPreviousCharacters === 80
      && evidence.artifactRegression.minimumDropCharacters === 40
      && evidence.artifactRegression.rawTextExcluded
      && evidence.aiAcceptance.decisionKeyed
      && evidence.aiAcceptance.revisions
      && evidence.aiAcceptance.rawMessageIdsExcluded
      && evidence.aiAcceptance.rationaleTextExcluded
      && evidence.redaction === "raw-learner-text-excluded",
  };
}

function getAgentContractEvidence(value = {}) {
  const expectedAgents = ["A1", "A2", "A3", "A4"];
  const expectedCaModules = {
    A1: ["Scaffolding", "Fading"],
    A2: ["Modelling", "Coaching"],
    A3: ["Scaffolding"],
    A4: ["Articulation", "Reflection"],
  };
  const expectedRoles = {
    A1: "frontend-direct-dialogue",
    A2: "frontend-direct-dialogue",
    A3: "backend-a1-signal",
    A4: "backend-a1-reflection",
  };
  const expectedExtensions = [
    "agentRole",
    "agentCaModules",
    "agentFamily",
    "agentPhaseScope",
    "pseudonymousSessionId",
  ];
  const rawAgents = Array.isArray(value.requiredAgents) ? value.requiredAgents : [];
  const requiredAgents = expectedAgents.filter((agentId) => rawAgents.includes(agentId));
  const caModules = Object.fromEntries(
    Object.entries(expectedCaModules).map(([agentId, modules]) => {
      const raw = Array.isArray(value.caModules?.[agentId]) ? value.caModules[agentId] : [];
      return [agentId, modules.filter((module) => raw.includes(module))];
    }),
  );
  const roles = Object.fromEntries(
    Object.entries(expectedRoles).map(([agentId, role]) => [
      agentId,
      value.roles?.[agentId] === role ? role : "unknown",
    ]),
  );
  const xapiExtensions = Object.fromEntries(
    expectedExtensions.map((name) => [name, value.xapiExtensions?.[name] === true]),
  );
  const requiredAgentsComplete = requiredAgents.length === expectedAgents.length;
  const caModulesComplete = Object.entries(expectedCaModules)
    .every(([agentId, modules]) => arraysEqual(caModules[agentId], modules));
  const rolesComplete = Object.entries(expectedRoles)
    .every(([agentId, role]) => roles[agentId] === role);
  const xapiExtensionsComplete = expectedExtensions.every((name) => xapiExtensions[name] === true);
  const version = value.version === "aais-a1-a4-ca-v2" ? "aais-a1-a4-ca-v2" : "invalid";
  return {
    version,
    requiredAgents,
    requiredAgentsComplete,
    caModules,
    caModulesComplete,
    roles,
    rolesComplete,
    xapiExtensions,
    xapiExtensionsComplete,
    pseudonymousSessionId: xapiExtensions.pseudonymousSessionId === true,
    complete: version === "aais-a1-a4-ca-v2"
      && requiredAgentsComplete
      && caModulesComplete
      && rolesComplete
      && xapiExtensionsComplete
      && value.complete === true,
  };
}

function getAgentResponsibilitiesEvidence(value) {
  const expected = {
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
  const sanitized = Object.fromEntries(
    Object.entries(expected).map(([agentId, expectedEvents]) => {
      const rawEvents = Array.isArray(value?.[agentId]) ? value[agentId] : [];
      return [
        agentId,
        expectedEvents.filter((eventName) => rawEvents.includes(eventName)),
      ];
    }),
  );
  return {
    value: sanitized,
    complete: Object.entries(expected).every(([agentId, expectedEvents]) =>
      arraysEqual(sanitized[agentId], expectedEvents)
    ),
  };
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function readAgentEvidenceValue(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function readIntegerValue(...values) {
  const value = readAgentEvidenceValue(...values);
  return Number.isInteger(value) ? value : null;
}

function getLegalPagesEvidence(details = {}) {
  const termsStatus = Number.isInteger(details?.termsStatus) ? details.termsStatus : null;
  const privacyStatus = Number.isInteger(details?.privacyStatus) ? details.privacyStatus : null;
  const termsHtml = details?.termsHtml === true;
  const privacyHtml = details?.privacyHtml === true;
  const termsContentPresent = details?.termsContentPresent === true;
  const privacyContentPresent = details?.privacyContentPresent === true;
  const redaction = details?.secrets === "redacted" ? "redacted" : "unknown";
  return {
    termsStatus,
    termsHtml,
    termsContentPresent,
    privacyStatus,
    privacyHtml,
    privacyContentPresent,
    redaction,
    complete: termsStatus === 200
      && privacyStatus === 200
      && termsHtml
      && privacyHtml
      && termsContentPresent
      && privacyContentPresent
      && redaction === "redacted",
  };
}

function getArtifactCoalescingEvidence(details = {}) {
  const expectedEvents = ["artifact_saved", "artifact_edited", "planning_submitted"];
  const rawEvents = Array.isArray(details?.lrsOutboxCoalescingEvents)
    ? details.lrsOutboxCoalescingEvents
    : [];
  const events = expectedEvents.filter((event) => rawEvents.includes(event));
  const windowSeconds = Number.isInteger(details?.lrsOutboxCoalescingWindowSeconds)
    ? details.lrsOutboxCoalescingWindowSeconds
    : null;
  const enabled = details?.lrsOutboxCoalescingEnabled === true;
  return {
    policy: {
      enabled,
      windowSeconds,
      events,
    },
    complete: enabled
      && windowSeconds === 30
      && events.length === expectedEvents.length,
  };
}

function getLrsOutboxRecoveryEvidence(details = {}) {
  const expectedAction = "POST /api/learning/lrs/outbox/flush?action=requeue-dead-letter";
  const expectedAuth = ["admin-session-csrf", "bearer-token"];
  const rawAuth = Array.isArray(details?.lrsOutboxRecoveryAuth)
    ? details.lrsOutboxRecoveryAuth
    : [];
  const auth = expectedAuth.filter((mode) => rawAuth.includes(mode));
  const deadLetterRequeue = details?.lrsOutboxDeadLetterRequeue === true;
  const action = details?.lrsOutboxRecoveryAction === expectedAction ? expectedAction : null;
  const redaction = details?.lrsOutboxRecoveryRedaction === "payloads-excluded"
    ? "payloads-excluded"
    : "unknown";
  return {
    policy: {
      deadLetterRequeue,
      action,
      auth,
      redaction,
    },
    complete: deadLetterRequeue
      && action === expectedAction
      && auth.length === expectedAuth.length
      && redaction === "payloads-excluded",
  };
}

function getAiModelFingerprint(model) {
  const trimmed = String(model ?? "").trim();
  if (!trimmed) {
    return null;
  }
  return createHash("sha256")
    .update(`aais-ai-model:${trimmed}`)
    .digest("hex")
    .slice(0, 16);
}

function readAiModelFingerprint(value) {
  return typeof value === "string" && /^[a-f0-9]{16}$/.test(value)
    ? value
    : null;
}

function readReleaseId(value) {
  const trimmed = String(value ?? "").trim();
  return isSafeReleaseId(trimmed) ? trimmed : null;
}

function readGitCommitShortSha(value) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{7,12}$/.test(trimmed) ? trimmed : null;
}

function readGitCommitSource(value) {
  const trimmed = String(value ?? "").trim();
  return ["vercel-inspect", "AAIS_DEPLOYMENT_GIT_COMMIT_SHA", "VERCEL_GIT_COMMIT_SHA"].includes(trimmed)
    ? trimmed
    : "missing";
}

function readNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function readSafeErrorCategory(value) {
  const trimmed = String(value ?? "").trim();
  return /^[a-z][a-z0-9_-]{1,63}$/.test(trimmed) ? trimmed : null;
}

function readDeploymentGitCommitSource(value) {
  return value === "VERCEL_GIT_COMMIT_SHA" || value === "AAIS_DEPLOYMENT_GIT_COMMIT_SHA"
    ? value
    : "missing";
}

function readOidcMode(value) {
  return value === "explicit" || value === "discovery" || value === "missing"
    ? value
    : "unknown";
}

function readLrsOutboxMode(value) {
  return value === "persistent" || value === "memory" ? value : "unknown";
}

function readLrsOutboxStorage(value) {
  return value === "postgres" || value === "process" ? value : "unknown";
}

function readReadinessCheckStatus(value) {
  return ["ok", "missing", "blocked", "invalid", "disabled"].includes(value)
    ? value
    : "unknown";
}

function readOidcRoleMappingNames(value) {
  const accepted = new Set([
    "AAIS_OIDC_TEACHER_GROUPS",
    "AAIS_OIDC_TEACHER_EMAILS",
    "AAIS_OIDC_ADMIN_GROUPS",
    "AAIS_OIDC_ADMIN_EMAILS",
  ]);
  return Array.isArray(value)
    ? value.filter((name) => accepted.has(name))
    : [];
}

function getVercelEnvTargetStatus(target, expectedAuthMode = "trial") {
  const environment = target?.environment === "Production" ? "Production" : normalizeReportString(target?.environment);
  const authMode = target?.authMode === "sso-only" || target?.authMode === "trial"
    ? target.authMode
    : normalizeReportString(target?.authMode);
  const aiMode = target?.aiMode === "live" || target?.aiMode === "deterministic"
    ? target.aiMode
    : normalizeReportString(target?.aiMode);
  const normalizedExpectedAuthMode = expectedAuthMode === "sso-only" ? "sso-only" : "trial";
  return {
    environment,
    expectedEnvironment: "Production",
    environmentMatchesExpected: environment === "Production",
    authMode,
    expectedAuthMode: normalizedExpectedAuthMode,
    authModeMatchesExpected: authMode === normalizedExpectedAuthMode,
    aiMode,
    expectedAiMode: "live",
    aiModeMatchesExpected: aiMode === "live",
  };
}

function normalizeReportString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "missing";
}

function getSafeEnvNames(value) {
  return Array.isArray(value)
    ? value.map((name) => String(name ?? "").trim()).filter(isSafeEnvName)
    : [];
}

function getSafeEnvCategories(value) {
  const categories = ["core", "storage", "releaseMode", "oidc", "oidcRoleMapping", "ai", "lrs"];
  return Object.fromEntries(
    categories.map((category) => [category, getSafeEnvNames(value?.[category])]),
  );
}

function isSafeEnvName(value) {
  return /^[A-Z][A-Z0-9_]{1,127}$/.test(value);
}

function getReleaseStatus(release, expectedId = null) {
  const id = typeof release?.id === "string" && isSafeReleaseId(release.id)
    ? release.id
    : null;
  const matchesExpected = expectedId
    ? id === expectedId
    : Boolean(id);
  return {
    id,
    present: Boolean(id),
    matchesExpected,
  };
}

function isSafeReleaseId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value.trim());
}

function getDeploymentStatus(baseUrl, expectedBaseUrl = null) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const matchesExpected = expectedBaseUrl
    ? normalizedBaseUrl === expectedBaseUrl
    : Boolean(normalizedBaseUrl);
  return {
    baseUrl: normalizedBaseUrl,
    expectedBaseUrl,
    matchesExpected,
  };
}

function getDeploymentPlatformStatus(details, expected = null) {
  const value = readDeploymentPlatform(details?.deploymentPlatform);
  const vercelRequestIdPresent = details?.vercelRequestIdPresent === true;
  const matchesExpected = expected === "vercel"
    ? value === "vercel" && vercelRequestIdPresent
    : true;
  return {
    value,
    expected,
    matchesExpected,
    vercelRequestIdPresent,
  };
}

function readDeploymentPlatform(value) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  return trimmed === "vercel" ? "vercel" : "unknown";
}

function readAuthMode(value) {
  return String(value ?? "").trim().toLowerCase() === "sso-only" ? "sso-only" : "trial";
}

function normalizeBaseUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }
  try {
    const url = new URL(raw);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function getDatabaseProviderStatus(value, expected = null) {
  const provider = readDatabaseProvider(value);
  const matchesExpected = expected ? provider === expected : true;
  return {
    value: provider,
    expected,
    matchesExpected,
  };
}

function readDatabaseProvider(value) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  return trimmed === "neon" || trimmed === "postgres" ? trimmed : null;
}

function readSafeCronSchedule(value) {
  const trimmed = String(value ?? "").trim();
  return /^[0-9*,/\-\s]+$/.test(trimmed) && trimmed.split(/\s+/).length === 5
    ? trimmed
    : null;
}

function isDailyCronSchedule(schedule) {
  if (!schedule) {
    return false;
  }
  const parts = schedule.split(/\s+/);
  return parts.length === 5
    && isCronFixedNumberField(parts[0], 0, 59)
    && isCronFixedNumberField(parts[1], 0, 23)
    && parts[2] === "*"
    && parts[3] === "*"
    && parts[4] === "*";
}

function isCronFixedNumberField(value, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max;
}

function scanSecretLikeContent(raw) {
  const issue = [
    ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ["bearer-token", /bearer\s+[A-Za-z0-9._-]{8,}/i],
    ["postgres-url-with-password", /postgres(?:ql)?:\/\/[^:\s/]+:[^@\s/]+@/i],
    ["oidc-id-token", /\bid_token\s*[:=]/i],
    ["authorization-code-url", /[?&]code=[^\s"'<>]+/i],
    ["oidc-state-cookie", /aais_oidc_state=[A-Za-z0-9._~%+-]{24,}/i],
    ["pkce-verifier", /code_verifier=[A-Za-z0-9._~-]{20,}/i],
    ["api-key-assignment", /api[_-]?key\s*[:=]\s*["']?[A-Za-z0-9._-]{8,}/i],
    ["password-assignment", /password\s*[:=]\s*["']?[^"'\s,}]{8,}/i],
    ["raw-learner-text", /不能出现在教师看板的原始学习文本|第一位学习者的|第二位学习者的/i],
    ["legal-page-body", /AAIS 只收集运行 Cognitive Apprenticeship|学习使用边界|数据范围|运维与证据/i],
  ].find(([, pattern]) => pattern.test(raw));
  if (!issue) {
    return {
      status: "passed",
    };
  }
  return {
    status: "failed",
    issue: issue[0],
  };
}

function getFreshness(timestamp, { now, maxAgeHours }) {
  if (typeof timestamp !== "string") {
    return {
      timestamp: null,
      ageHours: null,
      isFuture: false,
      withinMaxAge: false,
    };
  }
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return {
      timestamp,
      ageHours: null,
      isFuture: false,
      withinMaxAge: false,
    };
  }
  const rawAgeHours = (now.getTime() - parsed.getTime()) / (1000 * 60 * 60);
  const isFuture = rawAgeHours < 0;
  const ageHours = Math.max(0, rawAgeHours);
  return {
    timestamp: parsed.toISOString(),
    ageHours: Number(ageHours.toFixed(3)),
    isFuture,
    withinMaxAge: !isFuture && ageHours <= maxAgeHours,
  };
}

function getEnterpriseEvidenceOrder(enterpriseCheckedAt, vercelEnvCheckedAt, vercelDeploymentCheckedAt = null) {
  const enterpriseTimestamp = readIsoTimestamp(enterpriseCheckedAt);
  const vercelEnvTimestamp = readIsoTimestamp(vercelEnvCheckedAt);
  const vercelDeploymentTimestamp = readIsoTimestamp(vercelDeploymentCheckedAt);
  return {
    enterpriseCheckedAt: enterpriseTimestamp,
    vercelEnvCheckedAt: vercelEnvTimestamp,
    vercelDeploymentCheckedAt: vercelDeploymentTimestamp,
    enterpriseAfterVercelEnv: Boolean(
      enterpriseTimestamp
        && vercelEnvTimestamp
        && new Date(enterpriseTimestamp).getTime() >= new Date(vercelEnvTimestamp).getTime(),
    ),
    enterpriseAfterVercelDeployment: Boolean(
      enterpriseTimestamp
        && vercelDeploymentTimestamp
        && new Date(enterpriseTimestamp).getTime() >= new Date(vercelDeploymentTimestamp).getTime(),
    ),
  };
}

function readIsoTimestamp(value) {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function readPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCliArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      continue;
    }
    const [rawKey, inlineValue] = current.slice(2).split("=");
    const value = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined) {
      index += 1;
    }
    args.set(rawKey, value);
  }
  return args;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const report = await verifyAaisReleaseEvidence({
    sourceProvenanceReportPath: args.get("source-provenance-report"),
    vercelEnvReportPath: args.get("vercel-env-report"),
    vercelDeploymentReportPath: args.get("vercel-deployment-report"),
    enterpriseReportPath: args.get("enterprise-report"),
    aiEvalManifestPath: args.get("ai-eval-manifest"),
    postgresRestoreReportPath: args.get("postgres-restore-report"),
    vercelConfigPath: args.get("vercel-config"),
    outputPath: args.get("output"),
    maxAgeHours: args.get("max-age-hours"),
    deploymentUrl: args.get("deployment-url"),
    deploymentPlatform: args.get("deployment-platform"),
    databaseProvider: args.get("database-provider"),
    authMode: args.get("auth-mode"),
    releaseId: args.get("release-id"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "passed") {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS release evidence verification failed."}\n`);
    process.exitCode = 1;
  });
}
