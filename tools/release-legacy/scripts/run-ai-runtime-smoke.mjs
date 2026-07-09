#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const defaultBaseUrl = "http://127.0.0.1:3000";
const defaultTimeoutMs = 35000;
const defaultLearnerInput = "Please answer in one sentence how to study university calculus.";
const redaction = {
  secrets: "omitted",
  cookies: "omitted",
  csrf: "omitted",
  rawPrompt: "omitted",
  rawModelReply: "omitted",
};

export async function runAaisAiRuntimeSmoke(input = {}) {
  const envValues = await readEnvFile(input.envFilePath);
  const checkedAt = (input.now ?? new Date()).toISOString();
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = normalizeBaseUrl(
    input.baseUrl
      ?? envValues.get("AAIS_RUNTIME_SMOKE_BASE_URL")
      ?? process.env.AAIS_RUNTIME_SMOKE_BASE_URL
      ?? defaultBaseUrl,
  );
  const timeoutMs = readPositiveInteger(
    input.timeoutMs
      ?? envValues.get("AAIS_RUNTIME_SMOKE_TIMEOUT_MS")
      ?? process.env.AAIS_RUNTIME_SMOKE_TIMEOUT_MS,
    defaultTimeoutMs,
  );
  const outputPath = input.outputPath
    ?? envValues.get("AAIS_RUNTIME_SMOKE_OUTPUT_PATH")
    ?? process.env.AAIS_RUNTIME_SMOKE_OUTPUT_PATH;

  let auth;
  try {
    auth = await resolveSmokeAuth({
      input,
      envValues,
      baseUrl,
      fetchImpl,
      timeoutMs,
    });
  } catch (error) {
    const report = createBaseReport({
      checkedAt,
      status: "failed",
      failureReason: classifySmokeError(error, "auth-unavailable"),
      httpStatus: 0,
      elapsedMs: 0,
      auth: {
        mode: "unavailable",
        values: "omitted",
      },
    });
    await writeReport(outputPath, report);
    return report;
  }

  const startedAt = nowMs();
  let httpStatus = 0;
  let body = null;
  let failureReason = null;

  try {
    const response = await fetchWithTimeout(fetchImpl, `${baseUrl}/api/learning/ai-guide`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: auth.cookieHeader,
        "x-aais-csrf": auth.csrfToken,
      },
      body: JSON.stringify({
        locale: "zh-CN",
        phase: "training",
        taskId: "training_task_1",
        learnerInput: input.learnerInput
          ?? envValues.get("AAIS_RUNTIME_SMOKE_PROMPT")
          ?? process.env.AAIS_RUNTIME_SMOKE_PROMPT
          ?? defaultLearnerInput,
        targetAgentIds: ["A2"],
        workspaceState: {
          currentStep: "runtime-ai-smoke",
          helpRequestsUsed: 0,
        },
      }),
    }, timeoutMs);
    httpStatus = response.status;
    body = await response.json().catch(() => null);
    if (!response.ok) {
      failureReason = "http-status";
    }
  } catch (error) {
    failureReason = classifySmokeError(error, "request-failed");
  }

  const elapsedMs = Math.round(nowMs() - startedAt);
  const visibleAgents = readVisibleAgents(body);
  const runtimeTimings = readRuntimeTimings(body);
  const runtimeAi = sanitizeRuntimeProfile(body?.orchestration?.runtime?.ai);
  if (!failureReason && !visibleAgents.includes("A2")) {
    failureReason = "missing-a2-turn";
  }
  if (!failureReason && !runtimeAi) {
    failureReason = "missing-runtime-ai";
  }

  const report = createBaseReport({
    checkedAt,
    status: failureReason ? "failed" : "passed",
    failureReason,
    httpStatus,
    elapsedMs,
    auth: auth.report,
    visibleAgents,
    runtimeTimings,
    runtimeAi,
  });
  await writeReport(outputPath, report);
  return report;
}

function createBaseReport({
  checkedAt,
  status,
  failureReason = null,
  httpStatus,
  elapsedMs,
  auth,
  visibleAgents = [],
  runtimeTimings = null,
  runtimeAi = null,
}) {
  return {
    schemaVersion: 1,
    status,
    checkedAt,
    target: {
      path: "/api/learning/ai-guide",
      targetAgentIds: ["A2"],
    },
    http: {
      status: httpStatus,
      ok: httpStatus >= 200 && httpStatus < 300,
      elapsedMs,
    },
    auth,
    response: {
      visibleAgents,
      visibleTurnCount: visibleAgents.length,
      rawMessage: "omitted",
      rawTurns: "omitted",
    },
    runtime: {
      fallback: runtimeTimings?.fallback ?? null,
      timeoutReason: runtimeTimings?.timeoutReason ?? null,
      ai: runtimeAi,
    },
    ...(failureReason ? { failureReason } : {}),
    redaction,
  };
}

async function resolveSmokeAuth({ input, envValues, baseUrl, fetchImpl, timeoutMs }) {
  const providedCookie = input.cookie
    ?? envValues.get("AAIS_RUNTIME_SMOKE_COOKIE")
    ?? process.env.AAIS_RUNTIME_SMOKE_COOKIE;
  const providedCsrf = input.csrfToken
    ?? input.csrf
    ?? envValues.get("AAIS_RUNTIME_SMOKE_CSRF")
    ?? process.env.AAIS_RUNTIME_SMOKE_CSRF
    ?? readCookieValue(providedCookie, "aais_csrf");

  if (providedCookie && providedCsrf) {
    return {
      cookieHeader: providedCookie,
      csrfToken: providedCsrf,
      report: {
        mode: "provided-cookie",
        sessionCookie: providedCookie.includes("aais_session=") ? "present" : "unknown",
        csrfCookie: providedCookie.includes("aais_csrf=") ? "present" : "unknown",
        values: "omitted",
      },
    };
  }

  const trialAccount = input.trialAccount
    ?? envValues.get("AAIS_RUNTIME_SMOKE_TRIAL_ACCOUNT")
    ?? process.env.AAIS_RUNTIME_SMOKE_TRIAL_ACCOUNT;
  const trialPassword = input.trialPassword
    ?? envValues.get("AAIS_RUNTIME_SMOKE_TRIAL_PASSWORD")
    ?? process.env.AAIS_RUNTIME_SMOKE_TRIAL_PASSWORD;

  if (!trialAccount || !trialPassword) {
    throw createSmokeError("auth-input-missing");
  }

  const response = await fetchWithTimeout(fetchImpl, `${baseUrl}/api/auth/app-session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      account: trialAccount,
      password: trialPassword,
      from: "/learning",
    }),
  }, timeoutMs);
  const setCookies = readSetCookieHeaders(response.headers);
  const sessionCookie = extractCookiePair(setCookies, "aais_session");
  const csrfCookie = extractCookiePair(setCookies, "aais_csrf");
  const csrfToken = readCookieValue(csrfCookie, "aais_csrf");

  if (!response.ok || !sessionCookie || !csrfCookie || !csrfToken) {
    throw createSmokeError("trial-login-failed");
  }

  return {
    cookieHeader: `${sessionCookie}; ${csrfCookie}`,
    csrfToken,
    report: {
      mode: "trial-login",
      loginStatus: response.status,
      sessionCookie: "present",
      csrfCookie: "present",
      values: "omitted",
    },
  };
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function readVisibleAgents(body) {
  const turns = Array.isArray(body?.turns) ? body.turns : [];
  return turns
    .map((turn) => String(turn?.agentId ?? ""))
    .filter((agentId) => /^A[1-4]$/.test(agentId));
}

function readRuntimeTimings(body) {
  const timings = body?.orchestration?.runtime?.timings;
  if (!timings || typeof timings !== "object") {
    return null;
  }
  return {
    fallback: typeof timings.fallback === "boolean" ? timings.fallback : null,
    timeoutReason: typeof timings.timeoutReason === "string" ? timings.timeoutReason : null,
  };
}

function sanitizeRuntimeProfile(profile) {
  if (!profile || typeof profile !== "object") {
    return null;
  }
  return {
    mode: profile.mode === "live" ? "live" : "deterministic",
    primary: sanitizeProviderProfile(profile.primary),
    fallback: sanitizeProviderProfile(profile.fallback),
    redaction: {
      secrets: "omitted",
      endpoints: "omitted",
      modelIds: "fingerprint-only",
    },
  };
}

function sanitizeProviderProfile(profile) {
  if (!profile || typeof profile !== "object") {
    return null;
  }
  return {
    providerRole: profile.providerRole === "fallback" ? "fallback" : "primary",
    provider: sanitizeProvider(profile.provider),
    modelFingerprint: sanitizeFingerprint(profile.modelFingerprint),
    thinkingMode: profile.thinkingMode === "disabled" ? "disabled" : "provider-default",
    thinkingModeSource: sanitizeSource(profile.thinkingModeSource),
    timeoutMs: sanitizeTimeout(profile.timeoutMs),
    maxRetries: readNonNegativeNumber(profile.maxRetries),
    maxTokens: readNonNegativeNumber(profile.maxTokens),
  };
}

function sanitizeProvider(value) {
  return ["openai-compatible", "qwen", "dashscope"].includes(String(value))
    ? String(value)
    : "openai-compatible";
}

function sanitizeFingerprint(value) {
  const fingerprint = String(value ?? "");
  return /^[a-f0-9]{8,64}$/i.test(fingerprint) ? fingerprint : "invalid";
}

function sanitizeSource(value) {
  const source = String(value ?? "default");
  return /^[A-Z0-9_:-]{1,80}$/i.test(source) ? source : "default";
}

function sanitizeTimeout(value) {
  const timeout = value && typeof value === "object" ? value : {};
  return {
    configured: readNullableNumber(timeout.configured),
    effective: readNonNegativeNumber(timeout.effective),
    default: readNonNegativeNumber(timeout.default),
    min: readNonNegativeNumber(timeout.min),
    max: readNonNegativeNumber(timeout.max),
    clamped: timeout.clamped === true,
    source: typeof timeout.source === "string" ? sanitizeSource(timeout.source) : null,
  };
}

function readNullableNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function readNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function readSetCookieHeaders(headers) {
  if (typeof headers?.getSetCookie === "function") {
    const values = headers.getSetCookie();
    if (values.length) {
      return values.flatMap(splitSetCookieHeader);
    }
  }
  const raw = headers?.get?.("set-cookie");
  return raw ? splitSetCookieHeader(raw) : [];
}

function splitSetCookieHeader(value) {
  return String(value)
    .split(/,\s*(?=[^;,]+=)/)
    .map((cookie) => cookie.trim())
    .filter(Boolean);
}

function extractCookiePair(setCookies, name) {
  for (const cookie of setCookies) {
    const pair = String(cookie).split(";")[0]?.trim();
    if (pair?.startsWith(`${name}=`)) {
      return pair;
    }
  }
  return "";
}

function readCookieValue(cookieHeader, name) {
  const parts = String(cookieHeader ?? "").split(";").map((part) => part.trim());
  const prefix = `${name}=`;
  const match = parts.find((part) => part.startsWith(prefix));
  return match ? match.slice(prefix.length) : "";
}

function createSmokeError(reason) {
  return Object.assign(new Error(reason), {
    reason,
  });
}

function classifySmokeError(error, fallback) {
  if (typeof error?.reason === "string") {
    return error.reason;
  }
  if (error?.name === "AbortError") {
    return "abort-timeout";
  }
  const causeCode = String(error?.cause?.code ?? "");
  const causeName = String(error?.cause?.name ?? "");
  const causeMessage = String(error?.cause?.message ?? "");
  const message = String(error?.message ?? "");
  if (
    causeCode === "UND_ERR_CONNECT_TIMEOUT"
    || causeName === "ConnectTimeoutError"
    || /connect timeout/i.test(causeMessage)
    || /connect timeout/i.test(message)
  ) {
    return "connect-timeout";
  }
  return fallback;
}

function normalizeBaseUrl(value) {
  const trimmed = String(value ?? "").trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? trimmed : defaultBaseUrl;
  } catch {
    return defaultBaseUrl;
  }
}

function readPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function readEnvFile(filePath) {
  const resolvedPath = String(filePath ?? "").trim();
  if (!resolvedPath) {
    return new Map();
  }
  let raw = "";
  try {
    raw = await readFile(resolvedPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`AAIS runtime smoke env file is missing: ${resolvedPath}`);
    }
    throw error;
  }
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
    if (/^[A-Z][A-Z0-9_]{1,127}$/.test(name)) {
      values.set(name, parseEnvValue(normalized.slice(separator + 1).trim()));
    }
  }
  return values;
}

function parseEnvValue(value) {
  const trimmed = String(value ?? "").trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
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

async function writeReport(outputPath, report) {
  if (!outputPath) {
    return;
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const report = await runAaisAiRuntimeSmoke({
    envFilePath: args.get("env-file"),
    baseUrl: args.get("base-url"),
    cookie: args.get("cookie"),
    csrfToken: args.get("csrf") ?? args.get("csrf-token"),
    trialAccount: args.get("trial-account"),
    trialPassword: args.get("trial-password"),
    learnerInput: args.get("prompt"),
    timeoutMs: args.get("timeout-ms"),
    outputPath: args.get("output"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "passed") {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS runtime smoke failed."}\n`);
    process.exitCode = 1;
  });
}
