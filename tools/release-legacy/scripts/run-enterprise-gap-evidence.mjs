#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runAaisAiEvaluation } from "./run-ai-eval.mjs";
import { runEnterpriseReleaseVerification } from "./verify-enterprise-release.mjs";
import { runAaisPostgresRestoreRehearsal } from "./verify-postgres-restore.mjs";

const enterpriseModes = new Set(["all", "trial-auth", "cohort-sso", "oidc-callback"]);
const trialEnterpriseModes = new Set(["all", "trial-auth"]);
const oidcEnterpriseModes = new Set(["cohort-sso", "oidc-callback"]);
const restoreModes = new Set(["all", "restore"]);
const aiEvalModes = new Set(["all", "live-ai-eval"]);
const defaultOutputPath = "output/aais-enterprise-gap-evidence-latest.json";
const defaultEnterpriseOutputPath = "output/aais-enterprise-report-latest.json";
const defaultRestoreOutputPath = "output/aais-postgres-restore-report-latest.json";
const defaultAiEvalOutputPath = "output/aais-ai-eval-deepseek-v4-pro.json";
const defaultAiEvalInlineOutputPath = "output/aais-ai-eval-inline-latest.json";
const defaultRestoreEnvFilePath = ".env.postgres-restore.local";
const defaultSourceEnvFilePath = ".env.production.local";

export async function runAaisEnterpriseGapEvidence(input = {}) {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const mode = readMode(input.mode ?? process.env.AAIS_ENTERPRISE_GAP_MODE ?? "all");
  const preflightOnly = input.preflightOnly === true || process.env.AAIS_ENTERPRISE_GAP_PREFLIGHT_ONLY === "true";
  const envValues = await readEnvFile(input.envFilePath);
  const restoreEnvFilePath = input.restoreEnvFilePath
    ?? envValues.get("AAIS_RESTORE_ENV_FILE")
    ?? process.env.AAIS_RESTORE_ENV_FILE
    ?? defaultRestoreEnvFilePath;
  const sourceEnvFilePath = input.sourceEnvFilePath
    ?? envValues.get("AAIS_SOURCE_DATABASE_ENV_FILE")
    ?? process.env.AAIS_SOURCE_DATABASE_ENV_FILE
    ?? defaultSourceEnvFilePath;
  const aiEvalEnvFilePath = input.aiEvalEnvFilePath
    ?? envValues.get("AAIS_AI_EVAL_ENV_FILE")
    ?? process.env.AAIS_AI_EVAL_ENV_FILE
    ?? sourceEnvFilePath;
  const restoreEnvValues = restoreModes.has(mode)
    ? await readEnvFile(restoreEnvFilePath)
    : new Map();
  const aiEvalEnvValues = aiEvalModes.has(mode)
    ? await readEnvFile(aiEvalEnvFilePath)
    : new Map();
  const outputPath = input.outputPath ?? process.env.AAIS_ENTERPRISE_GAP_REPORT_PATH ?? defaultOutputPath;
  const enterpriseOutputPath = input.enterpriseOutputPath
    ?? envValues.get("AAIS_ENTERPRISE_REPORT_PATH")
    ?? process.env.AAIS_ENTERPRISE_REPORT_PATH
    ?? defaultEnterpriseOutputPath;
  const restoreOutputPath = input.restoreOutputPath
    ?? envValues.get("AAIS_RESTORE_REHEARSAL_REPORT_PATH")
    ?? process.env.AAIS_RESTORE_REHEARSAL_REPORT_PATH
    ?? defaultRestoreOutputPath;
  const aiEvalOutputPath = input.aiEvalOutputPath
    ?? envValues.get("AAIS_AI_EVAL_MANIFEST_PATH")
    ?? process.env.AAIS_AI_EVAL_MANIFEST_PATH
    ?? defaultAiEvalOutputPath;
  const aiEvalInlineOutputPath = input.aiEvalInlineOutputPath
    ?? envValues.get("AAIS_AI_EVAL_INLINE_OUTPUT_PATH")
    ?? process.env.AAIS_AI_EVAL_INLINE_OUTPUT_PATH
    ?? defaultAiEvalInlineOutputPath;
  const baseUrl = readText(
    input.baseUrl ?? envValues.get("AAIS_VERIFY_BASE_URL") ?? process.env.AAIS_VERIFY_BASE_URL,
  );
  const releaseId = readReleaseId(
    input.releaseId ?? envValues.get("AAIS_RELEASE_ID") ?? process.env.AAIS_RELEASE_ID,
  );
  const transientEvidence = getTransientOidcEvidence({ input, envValues });
  const trialAuthEvidence = getTrialAuthEvidence({ input, envValues });
  const trialSmokeClientIps = getTrialSmokeClientIps({ generatedAt, trialAuthEvidence });
  const restoreEvidence = getRestoreEvidence(restoreEnvValues);
  const aiEvalEvidence = getAiEvalEvidence(aiEvalEnvValues);
  const preflight = getPreflight({
    mode,
    baseUrl,
    transientEvidence,
    trialAuthEvidence,
    restoreEvidence,
    aiEvalEvidence,
  });

  if (preflight.status !== "ready") {
    const report = createReport({
      generatedAt,
      mode,
      releaseId,
      outputPath,
      enterpriseOutputPath,
      restoreOutputPath,
      aiEvalOutputPath,
      aiEvalInlineOutputPath,
      restoreEnvFilePath,
      sourceEnvFilePath,
      aiEvalEnvFilePath,
      preflight,
      results: {},
      preflightOnly,
    });
    await writeJson(outputPath, report);
    return report;
  }

  if (preflightOnly) {
    const report = createReport({
      generatedAt,
      mode,
      releaseId,
      outputPath,
      enterpriseOutputPath,
      restoreOutputPath,
      aiEvalOutputPath,
      aiEvalInlineOutputPath,
      restoreEnvFilePath,
      sourceEnvFilePath,
      aiEvalEnvFilePath,
      preflight,
      results: {},
      preflightOnly,
    });
    await writeJson(outputPath, report);
    return report;
  }

  const results = {};
  if (enterpriseModes.has(mode)) {
    const enterpriseVerifier = input.enterpriseVerifier ?? runEnterpriseReleaseVerification;
    const trialMode = trialEnterpriseModes.has(mode);
    const oidcMode = oidcEnterpriseModes.has(mode);
    results.enterprise = summarizeEnterpriseReport(await enterpriseVerifier({
      baseUrl,
      releaseId,
      outputPath: enterpriseOutputPath,
      requireSsoOnly: mode === "cohort-sso",
      requireCohortAnalytics: mode === "all" || mode === "trial-auth" || mode === "cohort-sso",
      ...(oidcMode
        ? {
            oidcCallback: {
              callbackUrl: transientEvidence.callbackUrl,
              stateCookie: transientEvidence.stateCookie,
            },
            expectedSessionRole: readSessionRole(transientEvidence.expectedSessionRole),
          }
        : {}),
      ...(trialMode
        ? {
            trialLogin: {
              account: trialAuthEvidence.trialAccount,
              correctPassword: trialAuthEvidence.trialPassword,
              wrongPassword: trialAuthEvidence.trialWrongPassword || "aais-intentional-wrong-password",
              clientIp: trialSmokeClientIps.learningClientIp,
              throttleAccount: trialAuthEvidence.trialThrottleAccount,
              throttleCorrectPassword: trialAuthEvidence.trialThrottlePassword,
              throttleClientIp: trialSmokeClientIps.throttleClientIp,
            },
            educatorLogin: {
              account: trialAuthEvidence.educatorAccount,
              correctPassword: trialAuthEvidence.educatorPassword,
              clientIp: trialAuthEvidence.educatorClientIp,
            },
          }
        : {}),
    }));
  }
  if (restoreModes.has(mode)) {
    const restoreVerifier = input.restoreVerifier ?? runAaisPostgresRestoreRehearsal;
    results.postgresRestore = summarizeRestoreReport(await restoreVerifier({
      envFilePath: restoreEnvFilePath,
      sourceEnvFilePath,
      outputPath: restoreOutputPath,
      releaseId,
      databaseProvider: input.databaseProvider ?? "neon",
      targetPurpose: "restored-staging",
    }));
  }
  if (aiEvalModes.has(mode)) {
    const aiEvalRunner = input.aiEvalRunner ?? runAaisAiEvaluation;
    results.liveAiEval = summarizeAiEvalReport(await aiEvalRunner({
      envFilePath: aiEvalEnvFilePath,
      outputPath: aiEvalOutputPath,
      envJsonOutputPath: aiEvalInlineOutputPath,
      releaseId,
      now: input.now,
    }));
  }

  const report = createReport({
    generatedAt,
    mode,
    releaseId,
    outputPath,
    enterpriseOutputPath,
    restoreOutputPath,
    aiEvalOutputPath,
    aiEvalInlineOutputPath,
    restoreEnvFilePath,
    sourceEnvFilePath,
    aiEvalEnvFilePath,
    preflight,
    results,
    preflightOnly,
  });
  await writeJson(outputPath, report);
  return report;
}

function createReport({
  generatedAt,
  mode,
  releaseId,
  enterpriseOutputPath,
  restoreOutputPath,
  aiEvalOutputPath,
  aiEvalInlineOutputPath,
  restoreEnvFilePath,
  sourceEnvFilePath,
  aiEvalEnvFilePath,
  preflight,
  results,
  preflightOnly,
}) {
  const resultStatuses = Object.values(results).map((result) => result.status);
  const status = preflight.status !== "ready"
    ? "action-required"
    : preflightOnly
      ? "preflight-ready"
    : resultStatuses.every((resultStatus) => resultStatus === "passed")
      ? "passed"
      : "failed";
  return {
    schemaVersion: 1,
    status,
    generatedAt,
    mode,
    ...(preflightOnly ? { preflightOnly: true } : {}),
    ...(releaseId ? { release: { id: releaseId } } : {}),
    outputs: {
      enterpriseReportPath: enterpriseModes.has(mode) ? enterpriseOutputPath : null,
      postgresRestoreReportPath: restoreModes.has(mode) ? restoreOutputPath : null,
      aiEvalManifestPath: aiEvalModes.has(mode) ? aiEvalOutputPath : null,
      aiEvalInlineManifestPath: aiEvalModes.has(mode) ? aiEvalInlineOutputPath : null,
      restoreEnvFilePath: restoreModes.has(mode) ? restoreEnvFilePath : null,
      sourceEnvFilePath: restoreModes.has(mode) ? sourceEnvFilePath : null,
      aiEvalEnvFilePath: aiEvalModes.has(mode) ? aiEvalEnvFilePath : null,
    },
    preflight,
    results,
    redaction: {
      secrets: "omitted",
      cookies: "attributes-only",
      transientEvidence: "presence-only",
      trialAuthEvidence: "presence-only",
      databaseUrls: "redacted",
      aiProviderEnv: "presence-only",
      modelOutputs: "summarized-status-only",
    },
  };
}

function getPreflight({ mode, baseUrl, transientEvidence, trialAuthEvidence, restoreEvidence, aiEvalEvidence }) {
  const missing = [];
  const placeholders = [];
  const invalid = [];

  if (enterpriseModes.has(mode)) {
    if (!baseUrl) {
      missing.push("AAIS_VERIFY_BASE_URL");
    } else if (!isHttpsUrl(baseUrl)) {
      invalid.push("AAIS_VERIFY_BASE_URL");
    }
  }

  if (oidcEnterpriseModes.has(mode)) {
    for (const name of ["AAIS_VERIFY_OIDC_CALLBACK_URL", "AAIS_VERIFY_OIDC_STATE_COOKIE"]) {
      const value = transientEvidence[name === "AAIS_VERIFY_OIDC_CALLBACK_URL" ? "callbackUrl" : "stateCookie"];
      if (!value) {
        missing.push(name);
      } else if (isPlaceholderValue(value)) {
        placeholders.push(name);
      }
    }
    const expectedSessionRoleRequired = mode === "cohort-sso";
    const expectedSessionRole = readText(transientEvidence.expectedSessionRole);
    const normalizedExpectedSessionRole = readSessionRole(expectedSessionRole);
    if (expectedSessionRoleRequired && !expectedSessionRole) {
      missing.push("AAIS_VERIFY_EXPECTED_SESSION_ROLE");
    } else if (expectedSessionRoleRequired && expectedSessionRole && isPlaceholderValue(expectedSessionRole)) {
      placeholders.push("AAIS_VERIFY_EXPECTED_SESSION_ROLE");
    } else if (expectedSessionRoleRequired && !isEducatorSessionRole(normalizedExpectedSessionRole)) {
      invalid.push("AAIS_VERIFY_EXPECTED_SESSION_ROLE");
    } else if (!expectedSessionRoleRequired && expectedSessionRole && !isPlaceholderValue(expectedSessionRole) && normalizedExpectedSessionRole === "unknown") {
      invalid.push("AAIS_VERIFY_EXPECTED_SESSION_ROLE");
    }
  }

  if (trialEnterpriseModes.has(mode)) {
    for (const [name, value] of [
      ["AAIS_VERIFY_TRIAL_ACCOUNT", trialAuthEvidence.trialAccount],
      ["AAIS_VERIFY_TRIAL_CORRECT_PASSWORD", trialAuthEvidence.trialPassword],
      ["AAIS_VERIFY_EDUCATOR_ACCOUNT", trialAuthEvidence.educatorAccount],
      ["AAIS_VERIFY_EDUCATOR_CORRECT_PASSWORD", trialAuthEvidence.educatorPassword],
    ]) {
      if (!value) {
        missing.push(name);
      } else if (isPlaceholderValue(value)) {
        placeholders.push(name);
      }
    }
    if (trialAuthEvidence.trialWrongPassword && isPlaceholderValue(trialAuthEvidence.trialWrongPassword)) {
      placeholders.push("AAIS_VERIFY_TRIAL_WRONG_PASSWORD");
    }
    if (trialAuthEvidence.trialThrottleAccount && !trialAuthEvidence.trialThrottlePassword) {
      missing.push("AAIS_VERIFY_TRIAL_THROTTLE_CORRECT_PASSWORD");
    }
    if (!trialAuthEvidence.trialThrottleAccount && trialAuthEvidence.trialThrottlePassword) {
      missing.push("AAIS_VERIFY_TRIAL_THROTTLE_ACCOUNT");
    }
    for (const [name, value] of [
      ["AAIS_VERIFY_TRIAL_THROTTLE_ACCOUNT", trialAuthEvidence.trialThrottleAccount],
      ["AAIS_VERIFY_TRIAL_THROTTLE_CORRECT_PASSWORD", trialAuthEvidence.trialThrottlePassword],
      ["AAIS_VERIFY_TRIAL_CLIENT_IP", trialAuthEvidence.trialClientIp],
      ["AAIS_VERIFY_TRIAL_THROTTLE_CLIENT_IP", trialAuthEvidence.trialThrottleClientIp],
    ]) {
      if (value && isPlaceholderValue(value)) {
        placeholders.push(name);
      }
    }
  }

  if (restoreModes.has(mode)) {
    if (!restoreEvidence.databaseUrlPresent) {
      missing.push("AAIS_RESTORE_DATABASE_URL");
    }
    if (restoreEvidence.databaseUrlPlaceholder) {
      placeholders.push("AAIS_RESTORE_DATABASE_URL");
    }
    if (restoreEvidence.targetPurpose !== "restored-staging") {
      invalid.push("AAIS_RESTORE_TARGET_PURPOSE");
    }
  }

  if (aiEvalModes.has(mode)) {
    for (const item of [
      ["AAIS_AI_ENDPOINT", "endpointPresent", "endpointPlaceholder"],
      ["AAIS_AI_API_KEY", "apiKeyPresent", "apiKeyPlaceholder"],
      ["AAIS_AI_MODEL", "modelPresent", "modelPlaceholder"],
      ["AAIS_AI_EVAL_VERSION", "evalVersionPresent", "evalVersionPlaceholder"],
    ]) {
      const [name, presenceKey, placeholderKey] = item;
      if (!aiEvalEvidence[presenceKey]) {
        missing.push(name);
      } else if (aiEvalEvidence[placeholderKey]) {
        placeholders.push(name);
      }
    }
    if (aiEvalEvidence.endpointPresent && !aiEvalEvidence.endpointPlaceholder && !aiEvalEvidence.endpointHttps) {
      invalid.push("AAIS_AI_ENDPOINT");
    }
  }

  return {
    status: missing.length || placeholders.length || invalid.length ? "action-required" : "ready",
    required: {
      missing,
      placeholders,
      invalid,
    },
    oidcTransientEvidence: oidcEnterpriseModes.has(mode)
      ? {
          callbackUrlPresent: Boolean(transientEvidence.callbackUrl),
          stateCookiePresent: Boolean(transientEvidence.stateCookie),
          expectedSessionRole: readSessionRole(transientEvidence.expectedSessionRole),
          expectedEducatorRole: isEducatorSessionRole(readSessionRole(transientEvidence.expectedSessionRole)),
        }
      : null,
    trialAuthEvidence: trialEnterpriseModes.has(mode)
      ? {
          trialAccountPresent: Boolean(trialAuthEvidence.trialAccount),
          trialPasswordPresent: Boolean(trialAuthEvidence.trialPassword),
          educatorAccountPresent: Boolean(trialAuthEvidence.educatorAccount),
          educatorPasswordPresent: Boolean(trialAuthEvidence.educatorPassword),
        }
      : null,
    restoreEvidence: restoreModes.has(mode)
      ? {
          databaseUrlPresent: restoreEvidence.databaseUrlPresent,
          databaseUrlPlaceholder: restoreEvidence.databaseUrlPlaceholder,
          targetPurpose: restoreEvidence.targetPurpose,
          provider: restoreEvidence.provider,
        }
      : null,
    liveAiEvalEvidence: aiEvalModes.has(mode)
      ? {
          endpointPresent: aiEvalEvidence.endpointPresent,
          endpointHttps: aiEvalEvidence.endpointHttps,
          apiKeyPresent: aiEvalEvidence.apiKeyPresent,
          modelPresent: aiEvalEvidence.modelPresent,
          evalVersionPresent: aiEvalEvidence.evalVersionPresent,
        }
      : null,
  };
}

function getTransientOidcEvidence({ input, envValues }) {
  return {
    callbackUrl: readText(
      input.oidcCallbackUrl
        ?? envValues.get("AAIS_VERIFY_OIDC_CALLBACK_URL")
        ?? process.env.AAIS_VERIFY_OIDC_CALLBACK_URL,
    ),
    stateCookie: readText(
      input.oidcStateCookie
        ?? envValues.get("AAIS_VERIFY_OIDC_STATE_COOKIE")
        ?? process.env.AAIS_VERIFY_OIDC_STATE_COOKIE,
    ),
    expectedSessionRole: readText(
      input.expectedSessionRole
        ?? envValues.get("AAIS_VERIFY_EXPECTED_SESSION_ROLE")
        ?? process.env.AAIS_VERIFY_EXPECTED_SESSION_ROLE,
    ),
  };
}

function getTrialAuthEvidence({ input, envValues }) {
  return {
    trialAccount: readText(
      input.trialAccount
        ?? envValues.get("AAIS_VERIFY_TRIAL_ACCOUNT")
        ?? process.env.AAIS_VERIFY_TRIAL_ACCOUNT,
    ),
    trialPassword: readText(
      input.trialPassword
        ?? envValues.get("AAIS_VERIFY_TRIAL_CORRECT_PASSWORD")
        ?? process.env.AAIS_VERIFY_TRIAL_CORRECT_PASSWORD,
    ),
    trialWrongPassword: readText(
      input.trialWrongPassword
        ?? envValues.get("AAIS_VERIFY_TRIAL_WRONG_PASSWORD")
        ?? process.env.AAIS_VERIFY_TRIAL_WRONG_PASSWORD,
    ),
    trialThrottleAccount: readText(
      input.trialThrottleAccount
        ?? envValues.get("AAIS_VERIFY_TRIAL_THROTTLE_ACCOUNT")
        ?? process.env.AAIS_VERIFY_TRIAL_THROTTLE_ACCOUNT,
    ) || undefined,
    trialThrottlePassword: readText(
      input.trialThrottlePassword
        ?? envValues.get("AAIS_VERIFY_TRIAL_THROTTLE_CORRECT_PASSWORD")
        ?? process.env.AAIS_VERIFY_TRIAL_THROTTLE_CORRECT_PASSWORD,
    ) || undefined,
    trialClientIp: readText(
      input.trialClientIp
        ?? envValues.get("AAIS_VERIFY_TRIAL_CLIENT_IP")
        ?? process.env.AAIS_VERIFY_TRIAL_CLIENT_IP,
    ) || undefined,
    trialThrottleClientIp: readText(
      input.trialThrottleClientIp
        ?? envValues.get("AAIS_VERIFY_TRIAL_THROTTLE_CLIENT_IP")
        ?? process.env.AAIS_VERIFY_TRIAL_THROTTLE_CLIENT_IP,
    ) || undefined,
    educatorAccount: readText(
      input.educatorAccount
        ?? envValues.get("AAIS_VERIFY_EDUCATOR_ACCOUNT")
        ?? process.env.AAIS_VERIFY_EDUCATOR_ACCOUNT,
    ),
    educatorPassword: readText(
      input.educatorPassword
        ?? envValues.get("AAIS_VERIFY_EDUCATOR_CORRECT_PASSWORD")
        ?? process.env.AAIS_VERIFY_EDUCATOR_CORRECT_PASSWORD,
    ),
    educatorClientIp: readText(
      input.educatorClientIp
        ?? envValues.get("AAIS_VERIFY_EDUCATOR_CLIENT_IP")
        ?? process.env.AAIS_VERIFY_EDUCATOR_CLIENT_IP,
    ) || undefined,
  };
}

function getTrialSmokeClientIps({ generatedAt, trialAuthEvidence }) {
  return {
    learningClientIp: trialAuthEvidence.trialClientIp
      ?? createSmokeClientIp({ generatedAt, purpose: "trial-learning", prefix: "203.0.113" }),
    throttleClientIp: trialAuthEvidence.trialThrottleClientIp
      ?? createSmokeClientIp({ generatedAt, purpose: "trial-throttle", prefix: "198.51.100" }),
  };
}

function createSmokeClientIp({ generatedAt, purpose, prefix }) {
  const hash = createHash("sha256")
    .update(`${generatedAt}:${purpose}`)
    .digest();
  const octet = (hash[0] % 254) + 1;
  return `${prefix}.${octet}`;
}

function getRestoreEvidence(values) {
  const databaseUrl = readText(values.get("AAIS_RESTORE_DATABASE_URL"));
  return {
    databaseUrlPresent: Boolean(databaseUrl),
    databaseUrlPlaceholder: Boolean(databaseUrl && isPlaceholderValue(databaseUrl)),
    targetPurpose: readText(values.get("AAIS_RESTORE_TARGET_PURPOSE")).toLowerCase() || "invalid",
    provider: readText(values.get("AAIS_RESTORE_DATABASE_PROVIDER")).toLowerCase() || "unknown",
  };
}

function getAiEvalEvidence(values) {
  const endpoint = readText(values.get("AAIS_AI_ENDPOINT"));
  const apiKey = readText(values.get("AAIS_AI_API_KEY"));
  const model = readText(values.get("AAIS_AI_MODEL"));
  const evalVersion = readText(values.get("AAIS_AI_EVAL_VERSION"));
  return {
    endpointPresent: Boolean(endpoint),
    endpointPlaceholder: Boolean(endpoint && isPlaceholderValue(endpoint)),
    endpointHttps: Boolean(endpoint && isHttpsUrl(endpoint)),
    apiKeyPresent: Boolean(apiKey),
    apiKeyPlaceholder: Boolean(apiKey && isPlaceholderValue(apiKey)),
    modelPresent: Boolean(model),
    modelPlaceholder: Boolean(model && isPlaceholderValue(model)),
    evalVersionPresent: Boolean(evalVersion),
    evalVersionPlaceholder: Boolean(evalVersion && isPlaceholderValue(evalVersion)),
  };
}

function summarizeEnterpriseReport(report) {
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  return {
    status: readStatus(report?.status),
    checkedAt: typeof report?.checkedAt === "string" ? report.checkedAt : null,
    checks: checks.map((check) => ({
      name: readSafeToken(check?.name),
      status: readStatus(check?.status),
    })),
    requiredEvidence: {
      oidcCallback: getCheckPassed(checks, "oidc-callback"),
      cohortAnalytics: getCheckPassed(checks, "cohort-analytics"),
      ssoOnlyMode: getCheckPassed(checks, "sso-only-mode"),
      trialLearningSession: getCheckPassed(checks, "trial-learning-session"),
      trialLoginThrottle: getCheckPassed(checks, "trial-login-throttle"),
    },
    redaction: {
      secrets: report?.redaction?.secrets === "omitted" ? "omitted" : "unknown",
      cookies: report?.redaction?.cookies === "attributes-only" ? "attributes-only" : "unknown",
    },
  };
}

function summarizeRestoreReport(report) {
  return {
    status: readStatus(report?.status),
    checkedAt: typeof report?.checkedAt === "string" ? report.checkedAt : null,
    target: {
      provider: readSafeToken(report?.target?.provider),
      purpose: readSafeToken(report?.target?.purpose),
      sameAsSource: report?.target?.sameAsSource === true,
      databaseUrl: report?.target?.databaseUrl === "redacted" ? "redacted" : "unknown",
    },
    checks: {
      tablePresent: report?.checks?.tablePresent === true,
      lrsOutboxTablePresent: report?.checks?.lrsOutboxTablePresent === true,
      smokeInsertOnly: report?.checks?.smokeInsertOnly === true,
      smokeInserted: report?.checks?.smokeInserted === true,
      smokeReadBack: report?.checks?.smokeReadBack === true,
      smokeDeleted: report?.checks?.smokeDeleted === true,
    },
    redaction: {
      secrets: report?.redaction?.secrets === "omitted" ? "omitted" : "unknown",
    },
  };
}

function summarizeAiEvalReport(report) {
  const results = Array.isArray(report?.results) ? report.results : [];
  return {
    status: readStatus(report?.status),
    passedAt: typeof report?.passedAt === "string" ? report.passedAt : null,
    sampleCount: Number.isFinite(report?.sampleCount) ? report.sampleCount : 0,
    blockedCount: Number.isFinite(report?.blockedCount) ? report.blockedCount : 0,
    guardrailPolicy: readSafeToken(report?.guardrailPolicy),
    sampleResults: results.map((result) => ({
      id: readSafeToken(result?.id),
      agentId: readSafeAgentId(result?.agentId),
      status: readStatus(result?.status),
    })),
    agentEvidence: {
      contractVersion: readText(report?.agentEvidence?.contractVersion) || "unknown",
      complete: report?.agentEvidence?.complete === true,
      requiredAgents: readSafeAgentList(report?.agentEvidence?.requiredAgents),
      coveredAgents: readSafeAgentList(report?.agentEvidence?.coveredAgents),
      requiredCaModules: readSafeCaModuleList(report?.agentEvidence?.requiredCaModules),
      coveredCaModules: readSafeCaModuleList(report?.agentEvidence?.coveredCaModules),
      caBackgroundIncluded: report?.agentEvidence?.caBackgroundIncluded === true,
      rawPromptsStored: report?.agentEvidence?.rawPromptsStored === true,
      rawOutputsStored: report?.agentEvidence?.rawOutputsStored === true,
    },
    redaction: {
      prompts: report?.redaction?.prompts === "summarized" ? "summarized" : "unknown",
      secrets: report?.redaction?.secrets === "omitted" ? "omitted" : "unknown",
    },
  };
}

function getCheckPassed(checks, name) {
  return checks.find((check) => check?.name === name)?.status === "passed";
}

async function readEnvFile(filePath) {
  const resolved = readText(filePath);
  if (!resolved) {
    return new Map();
  }
  try {
    const raw = await readFile(resolved, "utf8");
    return parseEnv(raw);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return new Map();
    }
    throw error;
  }
}

function parseEnv(raw) {
  const values = new Map();
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = normalized.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(name)) {
      continue;
    }
    values.set(name, parseEnvValue(normalized.slice(separator + 1).trim()));
  }
  return values;
}

function parseEnvValue(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\");
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function writeJson(outputPath, report) {
  if (!outputPath) {
    return;
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function readMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  if (
    mode === "all"
    || mode === "trial-auth"
    || mode === "oidc-callback"
    || mode === "cohort-sso"
    || mode === "restore"
    || mode === "live-ai-eval"
  ) {
    return mode;
  }
  throw new Error("AAIS enterprise gap mode must be one of: all, trial-auth, oidc-callback, cohort-sso, restore, live-ai-eval.");
}

function readText(value) {
  return String(value ?? "").trim();
}

function readReleaseId(value) {
  const trimmed = readText(value);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(trimmed) ? trimmed : null;
}

function readStatus(value) {
  return ["passed", "failed", "skipped", "action-required", "preflight-ready"].includes(value)
    ? value
    : "unknown";
}

function readSessionRole(value) {
  const role = readText(value).toLowerCase();
  return role === "student" || role === "teacher" || role === "admin" ? role : "unknown";
}

function isEducatorSessionRole(value) {
  return value === "teacher" || value === "admin";
}

function readSafeToken(value) {
  const token = readText(value).toLowerCase().replace(/[^a-z0-9._:-]/g, "");
  return token || "unknown";
}

function readSafeAgentId(value) {
  return ["A1", "A2", "A3", "A4"].includes(value) ? value : "unknown";
}

function readSafeAgentList(value) {
  return Array.isArray(value)
    ? [...new Set(value.map(readSafeAgentId).filter((agentId) => agentId !== "unknown"))]
    : [];
}

function readSafeCaModuleList(value) {
  const allowed = new Set(["Modelling", "Coaching", "Scaffolding", "Fading", "Articulation", "Reflection"]);
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => allowed.has(item)))]
    : [];
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isPlaceholderValue(value) {
  return /<[^>]+>|required|placeholder|todo/i.test(String(value ?? ""));
}

function parseCliArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      continue;
    }
    const [rawKey, inlineValue] = current.slice(2).split("=");
    const nextValue = argv[index + 1];
    const value = inlineValue ?? (nextValue && !nextValue.startsWith("--") ? nextValue : true);
    if (inlineValue === undefined && value === nextValue) {
      index += 1;
    }
    args.set(rawKey, value);
  }
  return args;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const report = await runAaisEnterpriseGapEvidence({
    mode: args.get("mode"),
    envFilePath: args.get("env-file"),
    restoreEnvFilePath: args.get("restore-env-file"),
    sourceEnvFilePath: args.get("source-env-file"),
    aiEvalEnvFilePath: args.get("ai-eval-env-file"),
    baseUrl: args.get("base-url"),
    releaseId: args.get("release-id"),
    outputPath: args.get("output"),
    enterpriseOutputPath: args.get("enterprise-output"),
    restoreOutputPath: args.get("restore-output"),
    aiEvalOutputPath: args.get("ai-eval-output"),
    aiEvalInlineOutputPath: args.get("ai-eval-inline-output"),
    expectedSessionRole: args.get("expected-session-role"),
    preflightOnly: args.has("preflight-only"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "passed" && report.status !== "preflight-ready") {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS enterprise gap evidence failed."}\n`);
    process.exitCode = 1;
  });
}
