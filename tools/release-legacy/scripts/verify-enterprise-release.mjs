#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function runEnterpriseReleaseVerification(input) {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const fetchImpl = input.fetchImpl ?? fetch;
  const requireSsoOnly = input.requireSsoOnly === true;
  const releaseId = readReleaseId(input.releaseId ?? process.env.AAIS_RELEASE_ID);
  const expectedSessionRole = readSessionRole(input.expectedSessionRole ?? process.env.AAIS_VERIFY_EXPECTED_SESSION_ROLE);
  const readinessBearerToken = readOptionalSecret(input.readinessBearerToken ?? process.env.AAIS_READINESS_BEARER_TOKEN);
  const checks = [];
  const requireOidcEvidence = requireSsoOnly || Boolean(input.oidcCallback);

  checks.push(await runOnlineCheck("readiness", () => verifyReadiness({
    baseUrl,
    fetchImpl,
    expectedReleaseId: releaseId,
    requireOidcEvidence,
    readinessBearerToken,
  })));
  checks.push(await runOnlineCheck("security-headers", () => verifySecurityHeaders({ baseUrl, fetchImpl })));
  checks.push(await runOnlineCheck("legal-pages", () => verifyLegalPages({ baseUrl, fetchImpl })));
  checks.push(await runOnlineCheck("lrs-health", () => verifyLrsHealth({ baseUrl, fetchImpl })));
  let oidcSessionCookies = null;
  const oidcStartCheck = requireOidcEvidence
    ? await runOnlineCheck("oidc-start", () => verifyOidcStart({ baseUrl, fetchImpl }))
    : skippedCheck("oidc-start", "Trial auth current-stage gate does not require OIDC start evidence");
  const oidcCallbackCheck = requireOidcEvidence
    ? await runOnlineCheck(
      "oidc-callback",
      () => verifyOidcCallback({
        baseUrl,
        fetchImpl,
        oidcCallback: input.oidcCallback,
        expectedSessionRole,
        onSessionCookies: (cookies) => {
          oidcSessionCookies = cookies;
        },
      }),
    )
    : skippedCheck("oidc-callback", "Trial auth current-stage gate does not require OIDC callback evidence");
  checks.push(await runOnlineCheck(
    "cohort-analytics",
    () => verifyCohortAnalytics({
      baseUrl,
      fetchImpl,
      educatorLogin: input.educatorLogin,
      educatorSession: oidcSessionCookies,
      expectedSessionRole,
      requireCohortAnalytics: input.requireCohortAnalytics === true,
    }),
  ));
  checks.push(oidcStartCheck);
  checks.push(oidcCallbackCheck);
  if (requireSsoOnly) {
    checks.push(await runOnlineCheck(
      "sso-only-mode",
      () => verifySsoOnlyMode({ baseUrl, fetchImpl, readinessBearerToken }),
    ));
    checks.push(skippedCheck("trial-learning-session", "SSO-only release mode required"));
    checks.push(skippedCheck("trial-login-throttle", "SSO-only release mode required"));
  } else {
    checks.push(skippedCheck("sso-only-mode", "Trial auth current-stage gate keeps SSO-only cutover disabled"));
    checks.push(await runOnlineCheck(
      "trial-learning-session",
      () => verifyTrialLearningSession({ baseUrl, fetchImpl, trialLogin: input.trialLogin }),
    ));
    checks.push(await runOnlineCheck(
      "trial-login-throttle",
      () => verifyTrialLoginThrottle({ baseUrl, fetchImpl, trialLogin: input.trialLogin }),
    ));
  }

  const report = {
    status: checks.every((check) => check.status === "passed" || check.status === "skipped")
      ? "passed"
      : "failed",
    checkedAt: new Date().toISOString(),
    baseUrl,
    ...(releaseId ? { release: { id: releaseId } } : {}),
    checks,
    redaction: {
      secrets: "omitted",
      cookies: "attributes-only",
    },
  };

  const outputPath = input.outputPath ?? process.env.AAIS_ENTERPRISE_REPORT_PATH;
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  return report;
}

async function runOnlineCheck(name, run) {
  try {
    return await run();
  } catch (error) {
    return {
      name,
      status: "failed",
      details: {
        reason: "online check failed before redacted evidence could be collected",
        error: "omitted",
        errorCategory: classifyOnlineCheckError(error),
      },
    };
  }
}

function classifyOnlineCheckError(error) {
  const cause = error && typeof error === "object" ? error.cause : undefined;
  const code = readSafeErrorToken(cause?.code ?? error?.code);
  const name = readSafeErrorToken(cause?.name ?? error?.name);

  if (code === "und_err_connect_timeout" || code === "etimedout" || name === "connecttimeouterror") {
    return "connect-timeout";
  }
  if (code === "und_err_headers_timeout" || code === "und_err_body_timeout") {
    return "response-timeout";
  }
  if (code === "enotfound" || code === "eai_again") {
    return "dns";
  }
  if (code.startsWith("cert_") || code.startsWith("depth_") || name.includes("tls")) {
    return "tls";
  }
  if (
    code === "econnreset"
    || code === "econnrefused"
    || code === "ehostunreach"
    || code === "enetunreach"
    || code.startsWith("und_err_")
  ) {
    return "network";
  }
  return "unknown";
}

function readSafeErrorToken(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
}

function readOptionalSecret(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

function readinessFetchInit(readinessBearerToken) {
  return readinessBearerToken
    ? {
        headers: {
          authorization: `Bearer ${readinessBearerToken}`,
        },
      }
    : {};
}

async function verifySsoOnlyMode({ baseUrl, fetchImpl, readinessBearerToken }) {
  const readinessResponse = await fetchImpl(`${baseUrl}/api/system/readiness`, {
    method: "GET",
    ...readinessFetchInit(readinessBearerToken),
  });
  const readinessBody = await readJson(readinessResponse);
  const loginPageResponse = await fetchImpl(`${baseUrl}/login`, {
    method: "GET",
  });
  const loginPageHtml = await loginPageResponse.text().catch(() => "");
  const appSessionResponse = await fetchImpl(`${baseUrl}/api/auth/app-session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      account: "aais-sso-only-smoke",
      password: "redacted-smoke-password",
    }),
  });
  const appSessionSetCookie = appSessionResponse.headers.get("set-cookie") ?? "";
  const details = {
    readinessTrialAccountsDisabled: readinessBody?.checks?.trialAccounts?.status === "disabled",
    loginPageHasSsoEntry: loginPageHtml.includes("/api/auth/oidc/start")
      || loginPageHtml.includes("使用机构 SSO 登录"),
    loginPageHasTrialForm: loginPageHtml.includes("aais-login-account")
      || loginPageHtml.includes("aais-login-password")
      || loginPageHtml.includes("账号密码登录"),
    appSessionPostDisabled: appSessionResponse.status === 404,
    appSessionSetsSessionCookie: appSessionSetCookie.includes("aais_session="),
  };

  const passed = details.readinessTrialAccountsDisabled
    && loginPageResponse.status === 200
    && details.loginPageHasSsoEntry
    && !details.loginPageHasTrialForm
    && details.appSessionPostDisabled
    && !details.appSessionSetsSessionCookie;

  return {
    name: "sso-only-mode",
    status: passed ? "passed" : "failed",
    httpStatus: appSessionResponse.status,
    details,
  };
}

async function verifyLrsHealth({ baseUrl, fetchImpl }) {
  const response = await fetchImpl(`${baseUrl}/api/learning/lrs/health`, {
    method: "GET",
  });
  const body = await readJson(response);
  const configured = body?.configuration?.configured === true || body?.configured === true;
  const connected = response.status === 200 && body?.status === "connected";
  const persistentOutbox = body?.delivery?.persistentOutbox ?? {};
  const coalescing = getLrsOutboxCoalescingEvidence(persistentOutbox.coalescing);
  const recovery = getLrsOutboxRecoveryEvidence(persistentOutbox.recovery);
  const lrsOutboxOk = persistentOutbox.mode === "persistent"
    && persistentOutbox.storage === "postgres"
    && hasLrsOutboxMetrics(persistentOutbox)
    && persistentOutbox.secrets === "redacted"
    && coalescing.complete
    && recovery.complete;
  return {
    name: "lrs-health",
    status: connected && configured && lrsOutboxOk && body?.secrets === "redacted" ? "passed" : "failed",
    httpStatus: response.status,
    details: {
      lrsStatus: typeof body?.status === "string" ? body.status : "unknown",
      configured,
      lrsOutboxMode: readLrsOutboxMode(persistentOutbox.mode),
      lrsOutboxStorage: readLrsOutboxStorage(persistentOutbox.storage),
      lrsOutboxMetricsPresent: hasLrsOutboxMetrics(persistentOutbox),
      lrsOutboxRedaction: persistentOutbox.secrets === "redacted" ? "redacted" : "unknown",
      lrsOutboxCoalescingEnabled: coalescing.enabled,
      lrsOutboxCoalescingWindowSeconds: coalescing.windowSeconds,
      lrsOutboxCoalescingEvents: coalescing.events,
      lrsOutboxCoalescingStrategy: coalescing.strategy,
      lrsOutboxDeadLetterRequeue: recovery.deadLetterRequeue,
      lrsOutboxRecoveryAction: recovery.action,
      lrsOutboxRecoveryAuth: recovery.auth,
      lrsOutboxRecoveryRedaction: recovery.redaction,
      secrets: body?.secrets === "redacted" ? "redacted" : "unknown",
    },
  };
}

async function verifyCohortAnalytics({
  baseUrl,
  fetchImpl,
  educatorLogin,
  educatorSession,
  expectedSessionRole,
  requireCohortAnalytics,
}) {
  let authSource = "none";
  let loginStatus = null;
  let sessionCookie = "";
  let csrfCookie = "";
  let educatorRoleAccepted = false;
  let educatorSessionRole = "unknown";
  let educatorSessionRoleEvidence = false;

  if (requireCohortAnalytics && educatorSession?.sessionCookie && educatorSession?.csrfCookie) {
    sessionCookie = educatorSession.sessionCookie;
    csrfCookie = educatorSession.csrfCookie;
    educatorSessionRole = readSessionRole(educatorSession.sessionRole);
    educatorSessionRoleEvidence = isEducatorSessionRole(educatorSessionRole);
    authSource = "oidc-callback";
  } else if (educatorLogin?.account && educatorLogin.correctPassword) {
    authSource = "trial-login";
    const loginResponse = await postLogin({
      baseUrl,
      fetchImpl,
      account: educatorLogin.account,
      password: educatorLogin.correctPassword,
      clientIp: educatorLogin.clientIp,
    });
    const loginBody = await readJson(loginResponse);
    const setCookie = loginResponse.headers.get("set-cookie") ?? "";
    sessionCookie = extractCookiePair(setCookie, "aais_session");
    csrfCookie = extractCookiePair(setCookie, "aais_csrf");
    const educatorRole = loginBody?.appSession?.actor?.role;
    loginStatus = loginResponse.status;
    educatorRoleAccepted = educatorRole === "teacher" || educatorRole === "admin";
    educatorSessionRole = readSessionRole(educatorRole);
    educatorSessionRoleEvidence = educatorRoleAccepted;
  }

  if (!sessionCookie || !csrfCookie) {
    return {
      name: "cohort-analytics",
      status: requireCohortAnalytics ? "failed" : "skipped",
      details: {
        reason: "educator credentials not supplied",
        required: requireCohortAnalytics,
        authSource,
        secrets: "redacted",
      },
    };
  }

  let analyticsStatus = null;
  let analyticsBody = null;
  const analyticsResponse = await fetchImpl(
    `${baseUrl}/api/learning/analytics?scope=cohort&phase=practice&agent=A2&event=coaching_push`,
    {
      method: "GET",
      headers: {
        cookie: `${sessionCookie}; ${csrfCookie}`,
      },
    },
  );
  analyticsStatus = analyticsResponse.status;
  analyticsBody = await readJson(analyticsResponse);
  if (authSource === "oidc-callback") {
    educatorRoleAccepted = analyticsStatus === 200;
  }

  const analytics = analyticsBody?.analytics ?? {};
  const learners = Array.isArray(analytics.learners) ? analytics.learners : [];
  const exportResponse = await fetchImpl(
    `${baseUrl}/api/learning/export?scope=cohort&format=json&phase=practice&agent=A2&event=coaching_push`,
    {
      method: "GET",
      headers: {
        cookie: `${sessionCookie}; ${csrfCookie}`,
      },
    },
  );
  const exportBody = await readJson(exportResponse);
  const exportLearners = Array.isArray(exportBody?.learners) ? exportBody.learners : [];
  const details = {
    authSource,
    loginStatus: authSource === "trial-login" ? loginStatus : null,
    authSessionEstablished: Boolean(sessionCookie && csrfCookie),
    loginSetsSessionCookie: Boolean(sessionCookie),
    loginSetsCsrfCookie: Boolean(csrfCookie),
    educatorSessionRole,
    educatorSessionRoleEvidence,
    expectedSessionRole,
    educatorSessionRoleMatchesExpected: expectedSessionRole === "unknown" || educatorSessionRole === expectedSessionRole,
    educatorRoleAccepted,
    analyticsStatus,
    filtersApplied: cohortAnalyticsFiltersApplied(analytics.filters?.applied),
    learnerRows: learners.length,
    learnerKeysPseudonymous: learners.every((learner) =>
      typeof learner?.learnerKey === "string" && /^learner-[a-f0-9]{12}$/.test(learner.learnerKey)
    ),
    sessionKeysPseudonymous: learners.every((learner) =>
      typeof learner?.sessionKey === "string" && /^session-[a-f0-9]{12}$/.test(learner.sessionKey)
    ),
    aggregateCountsPresent: cohortAnalyticsAggregateCountsPresent(analytics.dashboard?.cohort),
    riskBreakdownPresent: cohortAnalyticsRiskBreakdownPresent(analytics.dashboard?.cohort?.riskBreakdown),
    learnerRiskLevelsPresent: cohortAnalyticsLearnerRiskLevelsPresent(learners),
    priorityReasonsStable: cohortAnalyticsPriorityReasonsStable(learners),
    aiAcceptanceDecisionsPresent: cohortAnalyticsAiAcceptanceDecisionsPresent(
      analytics.dashboard?.cohort,
      learners,
    ),
    factLayerLrs: analytics.integrations?.factLayer === "lrs",
    privacyPseudonymous: analytics.privacy?.actorMode === "pseudonymous"
      && analytics.privacy?.rawPromptStorage === "excluded_from_lrs"
      && analytics.privacy?.minimumNecessaryFields === true,
    noRawLearnerText: !containsRawLearnerText(analyticsBody),
    exportStatus: exportResponse.status,
    exportDispositionPresent: (exportResponse.headers.get("content-disposition") ?? "")
      .includes("aais-cohort-analytics.json"),
    exportScopeCohort: exportBody?.exportScope === "cohort",
    exportFiltersApplied: cohortAnalyticsFiltersApplied(exportBody?.filters?.applied),
    exportLearnerRowsMatch: exportLearners.length === learners.length,
    exportLearnerKeysPseudonymous: exportLearners.every((learner) =>
      typeof learner?.learnerKey === "string" && /^learner-[a-f0-9]{12}$/.test(learner.learnerKey)
    ),
    exportSessionKeysPseudonymous: exportLearners.every((learner) =>
      typeof learner?.sessionKey === "string" && /^session-[a-f0-9]{12}$/.test(learner.sessionKey)
    ),
    exportPrivacyPseudonymous: exportBody?.privacy?.actorMode === "pseudonymous"
      && exportBody?.privacy?.rawLearnerText === "excluded",
    exportNoRawLearnerText: !containsRawLearnerPayload(exportBody),
    exportSecrets: exportBody?.secrets === "redacted" ? "redacted" : "unknown",
    secrets: analyticsBody?.secrets === "redacted" ? "redacted" : "unknown",
  };

  const passed = details.authSessionEstablished
    && details.educatorRoleAccepted
    && details.educatorSessionRoleEvidence
    && details.educatorSessionRoleMatchesExpected
    && details.analyticsStatus === 200
    && details.filtersApplied
    && details.learnerKeysPseudonymous
    && details.sessionKeysPseudonymous
    && details.aggregateCountsPresent
    && details.riskBreakdownPresent
    && details.learnerRiskLevelsPresent
    && details.priorityReasonsStable
    && details.aiAcceptanceDecisionsPresent
    && details.factLayerLrs
    && details.privacyPseudonymous
    && details.noRawLearnerText
    && details.exportStatus === 200
    && details.exportDispositionPresent
    && details.exportScopeCohort
    && details.exportFiltersApplied
    && details.exportLearnerRowsMatch
    && details.exportLearnerKeysPseudonymous
    && details.exportSessionKeysPseudonymous
    && details.exportPrivacyPseudonymous
    && details.exportNoRawLearnerText
    && details.exportSecrets === "redacted"
    && details.secrets === "redacted";

  return {
    name: "cohort-analytics",
    status: passed ? "passed" : "failed",
    httpStatus: analyticsStatus,
    details,
  };
}

function cohortAnalyticsFiltersApplied(filters) {
  return filters?.phase === "practice"
    && filters?.agent === "A2"
    && filters?.event === "coaching_push";
}

function cohortAnalyticsAggregateCountsPresent(cohort) {
  return [
    "learnerCount",
    "trainingCompleted",
    "completedPracticeTasks",
    "scaffoldRequests",
    "coachingSignals",
    "aiInteractions",
    "aiAcceptanceDecisions",
  ].every((field) => Number.isInteger(cohort?.[field]) && cohort[field] >= 0);
}

function cohortAnalyticsRiskBreakdownPresent(riskBreakdown) {
  return ["high", "medium", "low"].every((field) =>
    Number.isInteger(riskBreakdown?.[field]) && riskBreakdown[field] >= 0
  );
}

function cohortAnalyticsLearnerRiskLevelsPresent(learners) {
  return learners.every((learner) =>
    learner?.riskLevel === "high" || learner?.riskLevel === "medium" || learner?.riskLevel === "low"
  );
}

function cohortAnalyticsPriorityReasonsStable(learners) {
  const stableReasons = new Set([
    "training_incomplete",
    "reflection_missing",
    "a2_coaching_signals",
    "high_scaffold_dependency",
    "no_ai_interaction_after_coaching",
  ]);
  return learners.every((learner) =>
    Array.isArray(learner?.priorityReasons)
    && learner.priorityReasons.every((reason) => stableReasons.has(reason))
  );
}

function cohortAnalyticsAiAcceptanceDecisionsPresent(cohort, learners) {
  return Number.isInteger(cohort?.aiAcceptanceDecisions)
    && cohort.aiAcceptanceDecisions >= 0
    && learners.every((learner) =>
      Number.isInteger(learner?.aiAcceptanceDecisions) && learner.aiAcceptanceDecisions >= 0
    );
}

function containsRawLearnerText(body) {
  const serialized = JSON.stringify(body ?? {});
  return [
    "artifactText",
    "selfReport",
    "rawLearnerText",
    "promptText",
    "cookie",
    "token",
    "password",
  ].some((marker) => serialized.includes(marker));
}

function containsRawLearnerPayload(body) {
  const serialized = JSON.stringify(body ?? {});
  return [
    "artifactText",
    "selfReport",
    "promptText",
    "cookie",
    "token",
    "password",
  ].some((marker) => serialized.includes(marker));
}

async function verifySecurityHeaders({ baseUrl, fetchImpl }) {
  const response = await fetchImpl(`${baseUrl}/api/system/readiness`, {
    method: "GET",
  });
  const required = {
    hsts: response.headers.get("strict-transport-security") === "max-age=63072000; includeSubDomains; preload",
    contentTypeOptions: response.headers.get("x-content-type-options") === "nosniff",
    frameOptions: response.headers.get("x-frame-options") === "DENY",
    referrerPolicy: response.headers.get("referrer-policy") === "strict-origin-when-cross-origin",
    permissionsPolicy: hasPermissionsPolicy(response.headers.get("permissions-policy") ?? ""),
    contentSecurityPolicy: hasContentSecurityPolicy(response.headers.get("content-security-policy") ?? ""),
    crossOriginOpenerPolicy: response.headers.get("cross-origin-opener-policy") === "same-origin",
  };
  return {
    name: "security-headers",
    status: Object.values(required).every(Boolean) ? "passed" : "failed",
    httpStatus: response.status,
    details: required,
  };
}

async function verifyLegalPages({ baseUrl, fetchImpl }) {
  const [terms, privacy] = await Promise.all([
    readLegalPage({ baseUrl, fetchImpl, path: "/terms", marker: /使用条款|Responsible use/ }),
    readLegalPage({ baseUrl, fetchImpl, path: "/privacy", marker: /隐私与学习数据说明|Privacy and data governance/ }),
  ]);
  const details = {
    termsStatus: terms.status,
    termsHtml: terms.html,
    termsContentPresent: terms.contentPresent,
    privacyStatus: privacy.status,
    privacyHtml: privacy.html,
    privacyContentPresent: privacy.contentPresent,
    secrets: "redacted",
  };
  return {
    name: "legal-pages",
    status: terms.passed && privacy.passed ? "passed" : "failed",
    details,
  };
}

async function readLegalPage({ baseUrl, fetchImpl, path: pagePath, marker }) {
  const response = await fetchImpl(`${baseUrl}${pagePath}`, {
    method: "GET",
  });
  const body = await response.text().catch(() => "");
  const contentType = response.headers.get("content-type") ?? "";
  const html = contentType.includes("text/html") || /^\s*<!doctype html/i.test(body) || body.includes("<html");
  const contentPresent = marker.test(body);
  return {
    status: response.status,
    html,
    contentPresent,
    passed: response.status === 200 && html && contentPresent,
  };
}

async function verifyReadiness({
  baseUrl,
  fetchImpl,
  expectedReleaseId = null,
  requireOidcEvidence = false,
  readinessBearerToken,
}) {
  const response = await fetchImpl(`${baseUrl}/api/system/readiness`, {
    method: "GET",
    ...readinessFetchInit(readinessBearerToken),
  });
  const jsonEvidence = await readJsonEvidence(response);
  const body = jsonEvidence.body;
  const subchecks = getReadinessSubcheckStatus(body, { requireOidcEvidence });
  const metadata = getReadinessMetadata(body, response.headers);
  const releaseIdentity = getReadinessReleaseIdentity(body?.release, expectedReleaseId);
  const { complete: releaseIdentityComplete, ...releaseIdentityDetails } = releaseIdentity;
  return {
    name: "readiness",
    status: response.status === 200
      && body?.status === "ready"
      && body?.runtime === "production"
      && Object.values(subchecks).every(Boolean)
      && releaseIdentityComplete
      ? "passed"
      : "failed",
    httpStatus: response.status,
    details: {
      responseContentType: jsonEvidence.contentType,
      responseJsonReadable: jsonEvidence.readable,
      responseBodyKind: jsonEvidence.bodyKind,
      responseErrorCategory: jsonEvidence.errorCategory,
      readinessStatus: typeof body?.status === "string" ? body.status : "unknown",
      runtime: typeof body?.runtime === "string" ? body.runtime : "unknown",
      issueCount: Array.isArray(body?.issues) ? body.issues.length : null,
      issues: getSafeReadinessIssues(body?.issues),
      secrets: body?.secrets === "redacted" ? "redacted" : "unknown",
      ...subchecks,
      ...metadata,
      ...releaseIdentityDetails,
      releaseIdentityComplete,
    },
  };
}

function getReadinessSubcheckStatus(body, input = {}) {
  const checks = body?.checks ?? {};
  const ai = checks.ai ?? {};
  const oidcRoleMapping = checks.oidc?.roleMapping ?? {};
  const lrsOutbox = checks.lrs?.outbox ?? {};
  const coalescing = getLrsOutboxCoalescingEvidence(lrsOutbox.coalescing);
  const recovery = getLrsOutboxRecoveryEvidence(lrsOutbox.recovery);
  const lrsOutboxOk = lrsOutbox.mode === "persistent"
    && lrsOutbox.storage === "postgres"
    && hasLrsOutboxMetrics(lrsOutbox.metrics)
    && coalescing.complete
    && recovery.complete;
  return {
    sessionOk: checks.session?.status === "ok",
    trialAccountsOk: checks.trialAccounts?.status === "disabled"
      || (
        checks.trialAccounts?.status === "ok"
        && checks.trialAccounts?.configured === true
        && checks.trialAccounts?.accountCount > 0
      ),
    storagePostgresConnected: checks.storage?.status === "ok"
      && checks.storage?.mode === "postgres"
      && checks.storage?.probe === "connected",
    lrsOk: checks.lrs?.status === "ok" && lrsOutboxOk,
    oidcOk: input.requireOidcEvidence === true
      ? checks.oidc?.status === "ok"
        && oidcRoleMapping.status === "ok"
        && oidcRoleMapping.configured === true
        && readOidcRoleMappingNames(oidcRoleMapping.present).length > 0
      : checks.oidc?.status === "ok",
    liveAiEvalOk: ai.status === "ok"
      && (
        ai.provider === "deterministic"
          ? ai.evalManifest === "not-required"
          : ai.provider === "openai-compatible" && Boolean(ai.evalVersion) && ai.evalManifest === "verified"
      ),
  };
}

function getReadinessMetadata(body, headers) {
  const ai = body?.checks?.ai ?? {};
  const storage = body?.checks?.storage ?? {};
  const oidc = body?.checks?.oidc ?? {};
  const roleMapping = oidc.roleMapping ?? {};
  const lrsOutbox = body?.checks?.lrs?.outbox ?? {};
  const coalescing = getLrsOutboxCoalescingEvidence(lrsOutbox.coalescing);
  const recovery = getLrsOutboxRecoveryEvidence(lrsOutbox.recovery);
  const agentEvidence = getA2MonitoringCapabilityEvidence(
    body?.checks?.agentEvidence ?? body?.checks?.a3Supervision ?? body?.checks?.a2Monitoring,
  );
  const vercelRequestIdPresent = Boolean(headers.get("x-vercel-id"));
  return {
    aiProvider: ai.provider === "deterministic" || ai.provider === "openai-compatible"
      ? ai.provider
      : "unknown",
    aiEvalVersion: typeof ai.evalVersion === "string" ? ai.evalVersion : null,
    aiEvalManifest: typeof ai.evalManifest === "string" ? ai.evalManifest : "unknown",
    aiModelFingerprint: readAiModelFingerprint(ai.modelFingerprint),
    storageProvider: normalizeDatabaseProvider(storage.provider),
    oidcMode: readOidcMode(oidc.mode),
    oidcRoleMappingStatus: readReadinessCheckStatus(roleMapping.status),
    oidcRoleMappingConfigured: roleMapping.configured === true,
    oidcRoleMappingPresent: readOidcRoleMappingNames(roleMapping.present),
    oidcRoleMappingRedaction: roleMapping.redaction === "names-only" ? "names-only" : "unknown",
    lrsOutboxMode: readLrsOutboxMode(lrsOutbox.mode),
    lrsOutboxStorage: readLrsOutboxStorage(lrsOutbox.storage),
    lrsOutboxMetricsPresent: hasLrsOutboxMetrics(lrsOutbox.metrics),
    lrsOutboxCoalescingEnabled: coalescing.enabled,
    lrsOutboxCoalescingWindowSeconds: coalescing.windowSeconds,
    lrsOutboxCoalescingEvents: coalescing.events,
    lrsOutboxCoalescingStrategy: coalescing.strategy,
    lrsOutboxDeadLetterRequeue: recovery.deadLetterRequeue,
    lrsOutboxRecoveryAction: recovery.action,
    lrsOutboxRecoveryAuth: recovery.auth,
    lrsOutboxRecoveryRedaction: recovery.redaction,
    agentEvidenceEnabled: agentEvidence.enabled,
    agentEvidenceContractVersion: agentEvidence.agentContractVersion,
    agentEvidenceContractRequiredAgents: agentEvidence.agentContractRequiredAgents,
    agentEvidenceContractRequiredAgentsComplete: agentEvidence.agentContractRequiredAgentsComplete,
    agentEvidenceContractCaModules: agentEvidence.agentContractCaModules,
    agentEvidenceContractCaModulesComplete: agentEvidence.agentContractCaModulesComplete,
    agentEvidenceContractRoles: agentEvidence.agentContractRoles,
    agentEvidenceContractRolesComplete: agentEvidence.agentContractRolesComplete,
    agentEvidenceContractXapiExtensions: agentEvidence.agentContractXapiExtensions,
    agentEvidenceContractXapiExtensionsComplete: agentEvidence.agentContractXapiExtensionsComplete,
    agentEvidenceContractPseudonymousSessionId: agentEvidence.agentContractPseudonymousSessionId,
    agentEvidenceContractComplete: agentEvidence.agentContractComplete,
    agentEvidenceResponsibilities: agentEvidence.agentResponsibilities,
    agentEvidenceResponsibilitiesComplete: agentEvidence.agentResponsibilitiesComplete,
    agentEvidenceTriggers: agentEvidence.triggers,
    agentEvidenceSignals: agentEvidence.signals,
    agentEvidenceCoachingInterruption: agentEvidence.coachingInterruption,
    agentEvidenceCoachingCooldownSeconds: agentEvidence.coachingCooldownSeconds,
    agentEvidenceArtifactRegressionMinimumPreviousCharacters:
      agentEvidence.artifactRegressionMinimumPreviousCharacters,
    agentEvidenceArtifactRegressionMinimumDropCharacters:
      agentEvidence.artifactRegressionMinimumDropCharacters,
    agentEvidenceArtifactRegressionRawTextExcluded: agentEvidence.artifactRegressionRawTextExcluded,
    agentEvidenceAiAcceptanceDecisionKeyed: agentEvidence.aiAcceptanceDecisionKeyed,
    agentEvidenceAiAcceptanceRevisions: agentEvidence.aiAcceptanceRevisions,
    agentEvidenceAiAcceptanceRawMessageIdsExcluded: agentEvidence.aiAcceptanceRawMessageIdsExcluded,
    agentEvidenceAiAcceptanceRationaleTextExcluded: agentEvidence.aiAcceptanceRationaleTextExcluded,
    agentEvidenceRedaction: agentEvidence.redaction,
    agentEvidenceComplete: agentEvidence.complete,
    a3SupervisionEnabled: agentEvidence.enabled,
    a3SupervisionTriggers: agentEvidence.triggers,
    a3SupervisionSignals: agentEvidence.signals,
    a3SupervisionRedaction: agentEvidence.redaction,
    a3SupervisionComplete: agentEvidence.complete,
    a2MonitoringEnabled: agentEvidence.enabled,
    a2MonitoringTriggers: agentEvidence.triggers,
    a2MonitoringSignals: agentEvidence.signals,
    a2CoachingInterruption: agentEvidence.coachingInterruption,
    a2CoachingCooldownSeconds: agentEvidence.coachingCooldownSeconds,
    a2ArtifactRegressionMinimumPreviousCharacters: agentEvidence.artifactRegressionMinimumPreviousCharacters,
    a2ArtifactRegressionMinimumDropCharacters: agentEvidence.artifactRegressionMinimumDropCharacters,
    a2ArtifactRegressionRawTextExcluded: agentEvidence.artifactRegressionRawTextExcluded,
    a2AiAcceptanceDecisionKeyed: agentEvidence.aiAcceptanceDecisionKeyed,
    a2AiAcceptanceRevisions: agentEvidence.aiAcceptanceRevisions,
    a2AiAcceptanceRawMessageIdsExcluded: agentEvidence.aiAcceptanceRawMessageIdsExcluded,
    a2AiAcceptanceRationaleTextExcluded: agentEvidence.aiAcceptanceRationaleTextExcluded,
    a2MonitoringRedaction: agentEvidence.redaction,
    a2MonitoringComplete: agentEvidence.complete,
    deploymentPlatform: vercelRequestIdPresent ? "vercel" : "unknown",
    vercelRequestIdPresent,
  };
}

function getReadinessReleaseIdentity(release, expectedReleaseId) {
  const expected = readReleaseId(expectedReleaseId);
  const releaseId = readReleaseId(release?.id);
  const gitCommitShortSha = readGitCommitShortSha(release?.deployment?.gitCommit?.shortSha);
  const required = Boolean(expected);
  const releaseIdMatchesExpected = required ? releaseId === expected : true;
  const deploymentGitCommitPresent = release?.deployment?.gitCommit?.present === true && Boolean(gitCommitShortSha);
  return {
    releaseId,
    expectedReleaseId: expected,
    releaseIdRequired: required,
    releaseIdMatchesExpected,
    releaseSource: release?.source === "AAIS_RELEASE_ID" ? "AAIS_RELEASE_ID" : "missing",
    deploymentProvider: release?.deployment?.provider === "vercel" ? "vercel" : "unknown",
    deploymentGitCommitPresent,
    deploymentGitCommitShortSha: gitCommitShortSha,
    deploymentGitCommitSource: readDeploymentGitCommitSource(release?.deployment?.gitCommit?.source),
    complete: required ? releaseIdMatchesExpected && deploymentGitCommitPresent : true,
  };
}

function readDeploymentGitCommitSource(value) {
  return value === "VERCEL_GIT_COMMIT_SHA" || value === "AAIS_DEPLOYMENT_GIT_COMMIT_SHA"
    ? value
    : "missing";
}

function getSafeReadinessIssues(value) {
  return Array.isArray(value)
    ? value
      .map((issue) => String(issue ?? "").trim())
      .filter((issue) => /^[A-Z][A-Z0-9_*\\/-]{1,127}$/.test(issue))
    : [];
}

function readAiModelFingerprint(value) {
  return typeof value === "string" && /^[a-f0-9]{16}$/.test(value)
    ? value
    : null;
}

function readGitCommitShortSha(value) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{7,12}$/.test(trimmed) ? trimmed : null;
}

function readOidcMode(value) {
  return value === "explicit" || value === "discovery" || value === "missing"
    ? value
    : "unknown";
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

function readLrsOutboxMode(value) {
  return value === "persistent" || value === "memory" ? value : "unknown";
}

function readLrsOutboxStorage(value) {
  return value === "postgres" || value === "process" ? value : "unknown";
}

function hasLrsOutboxMetrics(metrics) {
  return ["pending", "retry", "sent", "deadLetter", "total"]
    .every((key) => Number.isFinite(metrics?.[key]));
}

function getLrsOutboxCoalescingEvidence(policy) {
  const expectedEvents = ["artifact_saved", "artifact_edited", "planning_submitted"];
  const rawEvents = Array.isArray(policy?.events) ? policy.events : [];
  const events = expectedEvents.filter((event) => rawEvents.includes(event));
  const windowSeconds = Number.isInteger(policy?.windowSeconds) ? policy.windowSeconds : null;
  const strategy = policy?.strategy === "latest-write-wins" ? "latest-write-wins" : "unknown";
  const enabled = policy?.enabled === true;
  return {
    enabled,
    windowSeconds,
    events,
    strategy,
    complete: enabled
      && windowSeconds === 30
      && strategy === "latest-write-wins"
      && events.length === expectedEvents.length,
  };
}

function getLrsOutboxRecoveryEvidence(policy) {
  const expectedAction = "POST /api/learning/lrs/outbox/flush?action=requeue-dead-letter";
  const expectedAuth = ["admin-session-csrf", "bearer-token"];
  const rawAuth = Array.isArray(policy?.auth) ? policy.auth : [];
  const auth = expectedAuth.filter((mode) => rawAuth.includes(mode));
  const action = policy?.action === expectedAction ? expectedAction : null;
  const redaction = policy?.redaction === "payloads-excluded" ? "payloads-excluded" : "unknown";
  const deadLetterRequeue = policy?.deadLetterRequeue === true;
  return {
    deadLetterRequeue,
    action,
    auth,
    redaction,
    complete: deadLetterRequeue
      && action === expectedAction
      && auth.length === expectedAuth.length
      && redaction === "payloads-excluded",
  };
}

function getA2MonitoringCapabilityEvidence(policy) {
  const responsibilities = getAgentResponsibilitiesEvidence(policy?.agentResponsibilities);
  const agentContract = getAgentContractEvidence(policy?.agentContract);
  const expectedTriggers = [
    "monitoring_pause_detected",
    "coaching_push",
    "ai_acceptance_recorded",
  ];
  const expectedSignals = [
    "low_progress_artifact_autosave",
    "artifact_regression_autosave",
  ];
  const rawTriggers = Array.isArray(policy?.triggers) ? policy.triggers : [];
  const rawSignals = Array.isArray(policy?.signals) ? policy.signals : [];
  const triggers = expectedTriggers.filter((trigger) => rawTriggers.includes(trigger));
  const signals = expectedSignals.filter((signal) => rawSignals.includes(signal));
  const coachingInterruption = policy?.coaching?.interruption === "low" ? "low" : "unknown";
  const coachingCooldownSeconds = Number.isInteger(policy?.coaching?.cooldownSeconds)
    ? policy.coaching.cooldownSeconds
    : null;
  const artifactRegressionMinimumPreviousCharacters =
    Number.isInteger(policy?.artifactRegression?.minimumPreviousCharacters)
      ? policy.artifactRegression.minimumPreviousCharacters
      : null;
  const artifactRegressionMinimumDropCharacters =
    Number.isInteger(policy?.artifactRegression?.minimumDropCharacters)
      ? policy.artifactRegression.minimumDropCharacters
      : null;
  const artifactRegressionRawTextExcluded = policy?.artifactRegression?.rawTextExcluded === true;
  const aiAcceptanceDecisionKeyed = policy?.aiAcceptance?.decisionKeyed === true;
  const aiAcceptanceRevisions = policy?.aiAcceptance?.revisions === true;
  const aiAcceptanceRawMessageIdsExcluded = policy?.aiAcceptance?.rawMessageIdsExcluded === true;
  const aiAcceptanceRationaleTextExcluded = policy?.aiAcceptance?.rationaleTextExcluded === true;
  const redaction = policy?.redaction === "raw-learner-text-excluded"
    ? "raw-learner-text-excluded"
    : "unknown";
  const enabled = policy?.enabled === true;
  return {
    enabled,
    agentContractVersion: agentContract.version,
    agentContractRequiredAgents: agentContract.requiredAgents,
    agentContractRequiredAgentsComplete: agentContract.requiredAgentsComplete,
    agentContractCaModules: agentContract.caModules,
    agentContractCaModulesComplete: agentContract.caModulesComplete,
    agentContractRoles: agentContract.roles,
    agentContractRolesComplete: agentContract.rolesComplete,
    agentContractXapiExtensions: agentContract.xapiExtensions,
    agentContractXapiExtensionsComplete: agentContract.xapiExtensionsComplete,
    agentContractPseudonymousSessionId: agentContract.pseudonymousSessionId,
    agentContractComplete: agentContract.complete,
    agentResponsibilities: responsibilities.value,
    agentResponsibilitiesComplete: responsibilities.complete,
    triggers,
    signals,
    coachingInterruption,
    coachingCooldownSeconds,
    artifactRegressionMinimumPreviousCharacters,
    artifactRegressionMinimumDropCharacters,
    artifactRegressionRawTextExcluded,
    aiAcceptanceDecisionKeyed,
    aiAcceptanceRevisions,
    aiAcceptanceRawMessageIdsExcluded,
    aiAcceptanceRationaleTextExcluded,
    redaction,
    complete: enabled
      && agentContract.complete
      && responsibilities.complete
      && triggers.length === expectedTriggers.length
      && signals.length === expectedSignals.length
      && coachingInterruption === "low"
      && coachingCooldownSeconds === 600
      && artifactRegressionMinimumPreviousCharacters === 80
      && artifactRegressionMinimumDropCharacters === 40
      && artifactRegressionRawTextExcluded
      && aiAcceptanceDecisionKeyed
      && aiAcceptanceRevisions
      && aiAcceptanceRawMessageIdsExcluded
      && aiAcceptanceRationaleTextExcluded
      && redaction === "raw-learner-text-excluded",
  };
}

function getAgentContractEvidence(value) {
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
  const rawAgents = Array.isArray(value?.requiredAgents) ? value.requiredAgents : [];
  const requiredAgents = expectedAgents.filter((agentId) => rawAgents.includes(agentId));
  const caModules = Object.fromEntries(
    Object.entries(expectedCaModules).map(([agentId, modules]) => {
      const raw = Array.isArray(value?.caModules?.[agentId]) ? value.caModules[agentId] : [];
      return [agentId, modules.filter((module) => raw.includes(module))];
    }),
  );
  const roles = Object.fromEntries(
    Object.entries(expectedRoles).map(([agentId, role]) => [
      agentId,
      value?.roles?.[agentId] === role ? role : "unknown",
    ]),
  );
  const xapiExtensions = Object.fromEntries(
    expectedExtensions.map((name) => [name, value?.xapiExtensions?.[name] === true]),
  );
  const requiredAgentsComplete = requiredAgents.length === expectedAgents.length;
  const caModulesComplete = Object.entries(expectedCaModules)
    .every(([agentId, modules]) => arraysEqual(caModules[agentId], modules));
  const rolesComplete = Object.entries(expectedRoles)
    .every(([agentId, role]) => roles[agentId] === role);
  const xapiExtensionsComplete = expectedExtensions.every((name) => xapiExtensions[name] === true);
  const version = value?.version === "aais-a1-a4-ca-v2" ? "aais-a1-a4-ca-v2" : "invalid";
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
      && value?.complete === true,
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

function normalizeDatabaseProvider(value) {
  return value === "neon" || value === "postgres" || value === "file" ? value : "unknown";
}

async function verifyOidcStart({ baseUrl, fetchImpl }) {
  const response = await fetchImpl(`${baseUrl}/api/auth/oidc/start?from=%2Flearning`, {
    method: "GET",
    redirect: "manual",
  });
  const location = response.headers.get("location") ?? "";
  const setCookie = response.headers.get("set-cookie") ?? "";
  const details = getOidcStartDetails({ baseUrl, location, setCookie });
  return {
    name: "oidc-start",
    status: isRedirect(response.status) && Object.values(details).every(Boolean)
      ? "passed"
      : "failed",
    httpStatus: response.status,
    details,
  };
}

function getOidcStartDetails({ baseUrl, location, setCookie }) {
  const authorizationUrl = parseUrl(location);
  const redirectUri = parseUrl(authorizationUrl?.searchParams.get("redirect_uri") ?? "");
  const scope = authorizationUrl?.searchParams.get("scope") ?? "";
  return {
    redirectsToHttpsProvider: authorizationUrl?.protocol === "https:",
    responseTypeCode: authorizationUrl?.searchParams.get("response_type") === "code",
    hasClientId: Boolean(authorizationUrl?.searchParams.get("client_id")),
    hasRedirectUri: Boolean(authorizationUrl?.searchParams.get("redirect_uri")),
    redirectUriMatchesCallback: redirectUri?.toString() === getExpectedOidcCallbackUrl(baseUrl),
    hasStateParam: Boolean(authorizationUrl?.searchParams.get("state")),
    hasNonceParam: Boolean(authorizationUrl?.searchParams.get("nonce")),
    hasPkceChallenge: Boolean(authorizationUrl?.searchParams.get("code_challenge")),
    pkceMethodS256: authorizationUrl?.searchParams.get("code_challenge_method") === "S256",
    scopeIncludesOpenid: scope.split(/\s+/).includes("openid"),
    stateCookieHttpOnly: setCookie.includes("HttpOnly"),
    stateCookieSecure: setCookie.includes("Secure"),
    stateCookieSameSiteLax: /SameSite=lax/i.test(setCookie),
  };
}

function getExpectedOidcCallbackUrl(baseUrl) {
  return new URL("/api/auth/oidc/callback", `${baseUrl}/`).toString();
}

function isExpectedOidcCallbackUrl(baseUrl, callbackUrl) {
  const parsed = parseUrl(callbackUrl);
  const expected = parseUrl(getExpectedOidcCallbackUrl(baseUrl));
  return Boolean(
    parsed
      && expected
      && parsed.origin === expected.origin
      && parsed.pathname === expected.pathname,
  );
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

async function verifyOidcCallback({ baseUrl, fetchImpl, oidcCallback, expectedSessionRole, onSessionCookies }) {
  if (!oidcCallback?.callbackUrl || !oidcCallback.stateCookie) {
    return {
      name: "oidc-callback",
      status: "skipped",
      details: {
        reason: "OIDC callback URL and state cookie not supplied",
      },
    };
  }
  if (isPlaceholderValue(oidcCallback.callbackUrl) || isPlaceholderValue(oidcCallback.stateCookie)) {
    return {
      name: "oidc-callback",
      status: "failed",
      details: {
        reason: "OIDC callback placeholder values must be replaced with transient IdP evidence",
        placeholderEvidenceSupplied: true,
      },
    };
  }

  const callbackUrl = normalizeCallbackUrl(baseUrl, oidcCallback.callbackUrl);
  const callbackUrlMatchesBaseCallback = isExpectedOidcCallbackUrl(baseUrl, callbackUrl);
  if (!callbackUrlMatchesBaseCallback) {
    return {
      name: "oidc-callback",
      status: "failed",
      details: {
        callbackUrlMatchesBaseCallback,
      },
    };
  }
  const response = await fetchImpl(callbackUrl, {
    method: "GET",
    redirect: "manual",
    headers: {
      cookie: `aais_oidc_state=${oidcCallback.stateCookie}`,
    },
  });
  const location = response.headers.get("location") ?? "";
  const setCookie = response.headers.get("set-cookie") ?? "";
  const sessionCookie = extractCookiePair(setCookie, "aais_session");
  const csrfCookie = extractCookiePair(setCookie, "aais_csrf");
  const sessionCookieAttributes = getCookieAttributes(setCookie, "aais_session");
  const csrfCookieAttributes = getCookieAttributes(setCookie, "aais_csrf");
  const stateCookieAttributes = getCookieAttributes(setCookie, "aais_oidc_state");
  const learningSession = await verifyLearningSessionFromCookies({
    baseUrl,
    fetchImpl,
    sessionCookie,
    csrfCookie,
  });
  const details = {
    callbackUrlMatchesBaseCallback,
    redirectsToLocalTarget: isRedirect(response.status)
      && location.startsWith("/")
      && !location.startsWith("//"),
    setsSessionCookie: Boolean(sessionCookie),
    sessionCookieHttpOnly: sessionCookieAttributes.includes("httponly"),
    sessionCookieSecure: sessionCookieAttributes.includes("secure"),
    sessionCookieSameSiteLax: sessionCookieAttributes.includes("samesite=lax"),
    setsCsrfCookie: Boolean(csrfCookie),
    csrfCookieSecure: csrfCookieAttributes.includes("secure"),
    csrfCookieSameSiteLax: csrfCookieAttributes.includes("samesite=lax"),
    clearsStateCookie: hasCookie(setCookie, "aais_oidc_state")
      && stateCookieAttributes.includes("max-age=0"),
    setCookieLeaksCallbackUrl: setCookie.includes(oidcCallback.callbackUrl),
    learningSessionStatus: learningSession.status,
    learningSessionReadable: learningSession.readable,
    learningSessionRole: learningSession.role,
    learningSessionEducatorRole: learningSession.educatorRole,
    expectedSessionRole,
    learningSessionRoleMatchesExpected: expectedSessionRole === "unknown" || learningSession.role === expectedSessionRole,
  };

  const passed = details.redirectsToLocalTarget
    && details.callbackUrlMatchesBaseCallback
    && details.setsSessionCookie
    && details.sessionCookieHttpOnly
    && details.sessionCookieSecure
    && details.sessionCookieSameSiteLax
    && details.setsCsrfCookie
    && details.csrfCookieSecure
    && details.csrfCookieSameSiteLax
    && details.clearsStateCookie
    && !details.setCookieLeaksCallbackUrl
    && details.learningSessionReadable
    && details.learningSessionRoleMatchesExpected;

  if (passed && typeof onSessionCookies === "function") {
    onSessionCookies({
      sessionCookie,
      csrfCookie,
      sessionRole: learningSession.role,
    });
  }

  return {
    name: "oidc-callback",
    status: passed ? "passed" : "failed",
    httpStatus: response.status,
    details,
  };
}

async function verifyLearningSessionFromCookies({ baseUrl, fetchImpl, sessionCookie, csrfCookie }) {
  if (!sessionCookie || !csrfCookie) {
    return {
      status: null,
      readable: false,
      role: "unknown",
      educatorRole: false,
    };
  }
  const response = await fetchImpl(`${baseUrl}/api/learning/session`, {
    method: "GET",
    headers: {
      cookie: `${sessionCookie}; ${csrfCookie}`,
    },
  });
  const body = await readJson(response);
  return {
    status: response.status,
    readable: response.status === 200 && typeof body?.session?.studentId === "string",
    role: readSessionRole(body?.actor?.role),
    educatorRole: isEducatorSessionRole(readSessionRole(body?.actor?.role)),
  };
}

function readSessionRole(value) {
  const role = String(value ?? "").trim().toLowerCase();
  return role === "student" || role === "teacher" || role === "admin" ? role : "unknown";
}

function isEducatorSessionRole(value) {
  return value === "teacher" || value === "admin";
}

async function verifyTrialLoginThrottle({ baseUrl, fetchImpl, trialLogin }) {
  if (!trialLogin?.account || !trialLogin.correctPassword || !trialLogin.wrongPassword) {
    return {
      name: "trial-login-throttle",
      status: "skipped",
      details: {
        reason: "trial credentials not supplied",
      },
    };
  }
  const throttleAccount = trialLogin.throttleAccount ?? trialLogin.account;
  const throttleCorrectPassword = trialLogin.throttleCorrectPassword ?? trialLogin.correctPassword;
  const throttleClientIp = trialLogin.throttleClientIp ?? trialLogin.clientIp;
  const firstFiveStatuses = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await postLogin({
      baseUrl,
      fetchImpl,
      account: throttleAccount,
      password: trialLogin.wrongPassword,
      clientIp: throttleClientIp,
    });
    firstFiveStatuses.push(response.status);
  }
  const sixth = await postLogin({
    baseUrl,
    fetchImpl,
    account: throttleAccount,
    password: trialLogin.wrongPassword,
    clientIp: throttleClientIp,
  });
  const correctDuringLock = await postLogin({
    baseUrl,
    fetchImpl,
    account: throttleAccount,
    password: throttleCorrectPassword,
    clientIp: throttleClientIp,
  });
  const correctSetCookie = correctDuringLock.headers.get("set-cookie") ?? "";
  const freshLockoutProven = firstFiveStatuses.every((status) => status === 401)
    && sixth.status === 429
    && Boolean(sixth.headers.get("retry-after"))
    && correctDuringLock.status === 429
    && !correctSetCookie.includes("aais_session=");
  const alreadyLockedProven = firstFiveStatuses.every((status) => status === 429)
    && sixth.status === 429
    && Boolean(sixth.headers.get("retry-after"))
    && correctDuringLock.status === 429
    && !correctSetCookie.includes("aais_session=");

  return {
    name: "trial-login-throttle",
    status: freshLockoutProven || alreadyLockedProven ? "passed" : "failed",
    details: {
      throttleAccountIsolated: throttleAccount !== trialLogin.account,
      freshLockoutProven,
      alreadyLockedProven,
      firstFiveStatuses,
      sixthStatus: sixth.status,
      sixthHasRetryAfter: Boolean(sixth.headers.get("retry-after")),
      correctDuringLockStatus: correctDuringLock.status,
      correctDuringLockSetsSession: correctSetCookie.includes("aais_session="),
    },
  };
}

function skippedCheck(name, reason) {
  return {
    name,
    status: "skipped",
    details: {
      reason,
    },
  };
}

async function verifyTrialLearningSession({ baseUrl, fetchImpl, trialLogin }) {
  if (!trialLogin?.account || !trialLogin.correctPassword) {
    return {
      name: "trial-learning-session",
      status: "skipped",
      details: {
        reason: "trial credentials not supplied",
      },
    };
  }

  const loginResponse = await postLogin({
    baseUrl,
    fetchImpl,
    account: trialLogin.account,
    password: trialLogin.correctPassword,
    clientIp: trialLogin.clientIp,
  });
  const loginBody = await readJson(loginResponse);
  const setCookie = loginResponse.headers.get("set-cookie") ?? "";
  const sessionCookie = extractCookiePair(setCookie, "aais_session");
  const csrfCookie = extractCookiePair(setCookie, "aais_csrf");
  const loginActorMatchesAccount = loginBody?.appSession?.actor?.id === trialLogin.account;

  let sessionStatus = null;
  let sessionStudentMatchesAccount = false;
  if (loginResponse.status === 200 && sessionCookie && csrfCookie) {
    const sessionResponse = await fetchImpl(`${baseUrl}/api/learning/session`, {
      method: "GET",
      headers: {
        cookie: `${sessionCookie}; ${csrfCookie}`,
      },
    });
    sessionStatus = sessionResponse.status;
    const sessionBody = await readJson(sessionResponse);
    sessionStudentMatchesAccount = sessionBody?.session?.studentId === trialLogin.account;
  }

  const passed = loginResponse.status === 200
    && Boolean(sessionCookie)
    && Boolean(csrfCookie)
    && loginActorMatchesAccount
    && sessionStatus === 200
    && sessionStudentMatchesAccount;

  return {
    name: "trial-learning-session",
    status: passed ? "passed" : "failed",
    details: {
      loginStatus: loginResponse.status,
      loginSetsSessionCookie: Boolean(sessionCookie),
      loginSetsCsrfCookie: Boolean(csrfCookie),
      loginActorMatchesAccount,
      sessionStatus,
      sessionStudentMatchesAccount,
    },
  };
}

async function postLogin({ baseUrl, fetchImpl, account, password, clientIp }) {
  return fetchImpl(`${baseUrl}/api/auth/app-session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(clientIp ? { "x-forwarded-for": clientIp } : {}),
    },
    body: JSON.stringify({
      account,
      password,
    }),
  });
}

function extractCookiePair(setCookie, cookieName) {
  const match = setCookie.match(new RegExp(`(?:^|[,\\s])(${escapeRegExp(cookieName)}=[^;,\\s]+)`, "i"));
  return match?.[1] ?? "";
}

function hasCookie(setCookie, cookieName) {
  return new RegExp(`(?:^|[,\\s])${escapeRegExp(cookieName)}=`, "i").test(setCookie);
}

function getCookieAttributes(setCookie, cookieName) {
  const start = setCookie.search(new RegExp(`(?:^|,\\s*)${escapeRegExp(cookieName)}=`, "i"));
  if (start < 0) {
    return [];
  }
  const cookieText = setCookie.slice(start).replace(/^,\s*/, "");
  const nextCookie = cookieText.slice(1).search(/,\s*[A-Za-z0-9_%-]+=/);
  const currentCookie = nextCookie >= 0 ? cookieText.slice(0, nextCookie + 1) : cookieText;
  return currentCookie
    .split(";")
    .slice(1)
    .map((attribute) => attribute.trim().toLowerCase())
    .filter(Boolean);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeBaseUrl(value) {
  const baseUrl = String(value ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("AAIS enterprise verifier requires --base-url or AAIS_VERIFY_BASE_URL.");
  }
  return baseUrl;
}

function normalizeCallbackUrl(baseUrl, value) {
  const callbackUrl = String(value ?? "").trim();
  if (callbackUrl.startsWith("/")) {
    return `${baseUrl}${callbackUrl}`;
  }
  return callbackUrl;
}

function isPlaceholderValue(value) {
  const trimmed = String(value ?? "").trim();
  return /^<REQUIRED:[A-Z0-9_:-]+>$/i.test(trimmed)
    || /^<transient-[a-z0-9-]+>$/i.test(trimmed);
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function readJsonEvidence(response) {
  const contentType = readSafeContentType(response.headers.get("content-type"));
  try {
    const body = await response.json();
    return {
      body,
      readable: true,
      bodyKind: readJsonBodyKind(body),
      contentType,
      errorCategory: null,
    };
  } catch {
    return {
      body: null,
      readable: false,
      bodyKind: "unreadable",
      contentType,
      errorCategory: contentType.includes("text/html") ? "html-response" : "invalid-json",
    };
  }
}

function readSafeContentType(value) {
  const lower = String(value ?? "").trim().toLowerCase();
  if (!lower) {
    return "missing";
  }
  const mediaType = lower.split(";")[0].trim();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType) ? mediaType : "unknown";
}

function readJsonBodyKind(value) {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "object") {
    return "object";
  }
  return ["string", "number", "boolean"].includes(typeof value) ? typeof value : "unknown";
}

function isRedirect(status) {
  return status >= 300 && status < 400;
}

function hasPermissionsPolicy(value) {
  return value.includes("camera=()")
    && value.includes("microphone=()")
    && value.includes("geolocation=()")
    && value.includes("payment=()");
}

function hasContentSecurityPolicy(value) {
  return value.includes("default-src 'self'")
    && value.includes("frame-ancestors 'none'")
    && value.includes("base-uri 'self'");
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

function readReleaseId(value) {
  const trimmed = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(trimmed) ? trimmed : null;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const report = await runEnterpriseReleaseVerification({
    baseUrl: args.get("base-url") ?? process.env.AAIS_VERIFY_BASE_URL,
    releaseId: args.get("release-id"),
    outputPath: args.get("output"),
    readinessBearerToken: args.get("readiness-bearer-token") ?? process.env.AAIS_READINESS_BEARER_TOKEN,
    requireSsoOnly: args.has("require-sso-only") || process.env.AAIS_VERIFY_REQUIRE_SSO_ONLY === "true",
    expectedSessionRole: args.get("expected-session-role") ?? process.env.AAIS_VERIFY_EXPECTED_SESSION_ROLE,
    oidcCallback: process.env.AAIS_VERIFY_OIDC_CALLBACK_URL && process.env.AAIS_VERIFY_OIDC_STATE_COOKIE
      ? {
          callbackUrl: process.env.AAIS_VERIFY_OIDC_CALLBACK_URL,
          stateCookie: process.env.AAIS_VERIFY_OIDC_STATE_COOKIE,
        }
      : undefined,
    trialLogin: process.env.AAIS_VERIFY_TRIAL_ACCOUNT && process.env.AAIS_VERIFY_TRIAL_CORRECT_PASSWORD
      ? {
          account: process.env.AAIS_VERIFY_TRIAL_ACCOUNT,
          correctPassword: process.env.AAIS_VERIFY_TRIAL_CORRECT_PASSWORD,
          wrongPassword: process.env.AAIS_VERIFY_TRIAL_WRONG_PASSWORD ?? "aais-intentional-wrong-password",
          clientIp: process.env.AAIS_VERIFY_TRIAL_CLIENT_IP,
          throttleAccount: process.env.AAIS_VERIFY_TRIAL_THROTTLE_ACCOUNT,
          throttleCorrectPassword: process.env.AAIS_VERIFY_TRIAL_THROTTLE_CORRECT_PASSWORD,
          throttleClientIp: process.env.AAIS_VERIFY_TRIAL_THROTTLE_CLIENT_IP,
        }
      : undefined,
    requireCohortAnalytics: args.has("require-cohort-analytics")
      || process.env.AAIS_VERIFY_REQUIRE_COHORT_ANALYTICS === "true",
    educatorLogin: process.env.AAIS_VERIFY_EDUCATOR_ACCOUNT && process.env.AAIS_VERIFY_EDUCATOR_CORRECT_PASSWORD
      ? {
          account: process.env.AAIS_VERIFY_EDUCATOR_ACCOUNT,
          correctPassword: process.env.AAIS_VERIFY_EDUCATOR_CORRECT_PASSWORD,
          clientIp: process.env.AAIS_VERIFY_EDUCATOR_CLIENT_IP,
        }
      : undefined,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "passed") {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS enterprise verifier failed."}\n`);
    process.exitCode = 1;
  });
}
