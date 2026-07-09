#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const sessionCookieName = "aais_session";
const csrfCookieName = "aais_csrf";
const knownProductionHosts = new Set(["www.aais.site", "aais.site", "aais-six.vercel.app"]);

export async function runAaisStagingLoadSanity(input = {}) {
  if (input.approved !== true) {
    throw new Error("AAIS staging load sanity requires explicit --approved.");
  }
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? process.env.AAIS_LOAD_BASE_URL);
  assertStagingTarget(baseUrl);
  const suppliedCredentials = input.credentials
    ?? (input.credentialsPath ? await readCredentialsFromFile(input.credentialsPath) : readCredentialsFromEnv());
  const credentials = normalizeCredentials(
    suppliedCredentials,
  );
  const targetUsers = normalizeInteger(
    input.targetUsers ?? process.env.AAIS_LOAD_TARGET_USERS,
    Math.min(200, credentials.length),
    1,
    500,
  );
  if (credentials.length < targetUsers) {
    throw new Error(`AAIS staging load sanity requires at least ${targetUsers} student credentials.`);
  }
  const concurrency = normalizeInteger(
    input.concurrency ?? process.env.AAIS_LOAD_CONCURRENCY,
    Math.min(200, targetUsers),
    1,
    targetUsers,
  );
  const maxP95Ms = normalizeInteger(
    input.maxP95Ms ?? process.env.AAIS_LOAD_MAX_P95_MS,
    2500,
    100,
    60000,
  );
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? new Date();
  const nowMs = input.nowMs ?? (() => performance.now());
  const checkedAt = now.toISOString();
  const selectedCredentials = credentials.slice(0, targetUsers);
  const results = await runWithConcurrency(selectedCredentials, concurrency, (credential, index) =>
    runStudentFlow({
      baseUrl,
      credential,
      fetchImpl,
      nowMs,
      checkedAt,
      index,
    }),
  );
  const successful = results.filter((result) => result.status === "passed");
  const failed = results.filter((result) => result.status !== "passed");
  const durations = successful.map((result) => result.durationMs);
  const timing = buildTimingSummary(durations);
  const failureSummary = summarizeFailures(failed);
  const passed = failed.length === 0 && timing.p95Ms !== null && timing.p95Ms <= maxP95Ms;
  const report = {
    schemaVersion: 1,
    status: passed ? "passed" : "failed",
    checkedAt,
    baseUrl,
    target: {
      purpose: "staging-or-preview-only",
      targetUsers,
      concurrency,
      credentialCount: credentials.length,
    },
    thresholds: {
      maxP95Ms,
    },
    results: {
      attempted: results.length,
      passed: successful.length,
      failed: failed.length,
      timing,
      failureSummary,
    },
    redaction: {
      accounts: "omitted",
      passwords: "omitted",
      cookies: "omitted",
      csrfTokens: "omitted",
      learnerText: "synthetic-load-sanity-only",
      responseBodies: "omitted",
    },
    secrets: "redacted",
  };
  return writeReportIfRequested(report, input.outputPath ?? process.env.AAIS_LOAD_OUTPUT);
}

async function runStudentFlow({
  baseUrl,
  credential,
  fetchImpl,
  nowMs,
  checkedAt,
  index,
}) {
  const startedAt = nowMs();
  const label = `student-${index + 1}`;
  try {
    const loginResponse = await fetchImpl(`${baseUrl}/api/auth/app-session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        account: credential.account,
        password: credential.password,
        consentAccepted: true,
        from: "/learning",
      }),
    });
    const loginBody = await readJson(loginResponse);
    const cookieJar = extractCookieJar(loginResponse.headers);
    if (
      loginResponse.status !== 200
      || loginBody?.redirectTarget !== "/learning"
      || !cookieJar.hasSessionCookie
      || !cookieJar.csrfToken
    ) {
      return failedResult("login", loginResponse.status, startedAt, nowMs);
    }

    const sessionResponse = await fetchImpl(`${baseUrl}/api/learning/session`, {
      method: "GET",
      headers: {
        cookie: cookieJar.cookieHeader,
      },
    });
    const sessionBody = await readJson(sessionResponse);
    const taskId = readActiveTaskId(sessionBody);
    if (sessionResponse.status !== 200 || !taskId) {
      return failedResult("session-read", sessionResponse.status, startedAt, nowMs);
    }

    const writeResponse = await fetchImpl(`${baseUrl}/api/learning/session`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: cookieJar.cookieHeader,
        "x-aais-csrf": cookieJar.csrfToken,
      },
      body: JSON.stringify({
        action: "save-artifact",
        taskId,
        artifactText: `AAIS staging load sanity synthetic note ${label} ${checkedAt}`,
      }),
    });
    const writeBody = await readJson(writeResponse);
    if (writeResponse.status !== 200 || !readActiveTaskId(writeBody)) {
      return failedResult("session-write", writeResponse.status, startedAt, nowMs);
    }

    return {
      status: "passed",
      durationMs: Math.max(0, Math.round(nowMs() - startedAt)),
    };
  } catch (error) {
    return {
      status: "failed",
      phase: "network",
      errorCategory: classifyOnlineError(error),
      durationMs: Math.max(0, Math.round(nowMs() - startedAt)),
    };
  }
}

function failedResult(phase, httpStatus, startedAt, nowMs) {
  return {
    status: "failed",
    phase,
    httpStatus,
    durationMs: Math.max(0, Math.round(nowMs() - startedAt)),
  };
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function summarizeFailures(failedResults) {
  const summary = {};
  for (const result of failedResults) {
    const key = [
      result.phase ?? "unknown",
      typeof result.httpStatus === "number" ? result.httpStatus : result.errorCategory ?? "unknown",
    ].join(":");
    summary[key] = (summary[key] ?? 0) + 1;
  }
  return summary;
}

function buildTimingSummary(durations) {
  if (!durations.length) {
    return {
      minMs: null,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
    };
  }
  const sorted = [...durations].sort((left, right) => left - right);
  return {
    minMs: sorted[0],
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1],
  };
}

function percentile(sortedDurations, ratio) {
  const index = Math.max(0, Math.ceil(sortedDurations.length * ratio) - 1);
  return sortedDurations[index] ?? 0;
}

function readActiveTaskId(body) {
  const value = body?.session?.activeTaskId;
  return typeof value === "string" && value.trim() ? value : null;
}

function extractCookieJar(headers) {
  const cookies = new Map();
  for (const header of readSetCookieHeaders(headers)) {
    const pair = header.split(";")[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return {
    hasSessionCookie: cookies.has(sessionCookieName),
    csrfToken: cookies.get(csrfCookieName) ?? null,
    cookieHeader: [...cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; "),
  };
}

function readSetCookieHeaders(headers) {
  if (typeof headers?.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const value = typeof headers?.get === "function" ? headers.get("set-cookie") : null;
  if (!value) {
    return [];
  }
  return value.split(/,(?=\s*[^;,]+=)/).map((header) => header.trim()).filter(Boolean);
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function writeReportIfRequested(report, outputPath) {
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}

function readCredentialsFromEnv() {
  const value = process.env.AAIS_LOAD_STUDENT_CREDENTIALS_JSON;
  if (!value) {
    throw new Error("AAIS_LOAD_STUDENT_CREDENTIALS_JSON or --credentials is required.");
  }
  return parseCredentialsJson(value);
}

async function readCredentialsFromFile(filePath) {
  const content = await readFile(filePath, "utf8");
  return parseCredentialsJson(content);
}

function parseCredentialsJson(value) {
  const parsed = JSON.parse(value);
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (Array.isArray(parsed?.students)) {
    return parsed.students;
  }
  throw new Error("AAIS load credentials JSON must be an array or { students: [...] }.");
}

function normalizeCredentials(value) {
  const credentials = parseMaybeJsonCredentials(value)
    .map((entry) => ({
      account: String(entry?.account ?? "").trim(),
      password: String(entry?.password ?? ""),
    }))
    .filter((entry) => entry.account && entry.password);
  if (!credentials.length) {
    throw new Error("AAIS staging load sanity requires at least one student credential.");
  }
  return credentials;
}

function parseMaybeJsonCredentials(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    return parseCredentialsJson(value);
  }
  return [];
}

function normalizeBaseUrl(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    throw new Error("AAIS_LOAD_BASE_URL or --base-url is required.");
  }
  const url = new URL(trimmed);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function assertStagingTarget(baseUrl) {
  const host = new URL(baseUrl).hostname.toLowerCase();
  if (knownProductionHosts.has(host)) {
    throw new Error("AAIS load sanity must target staging or preview, not the known production host.");
  }
}

function normalizeInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= min && parsed <= max) {
    return parsed;
  }
  return fallback;
}

function classifyOnlineError(error) {
  const code = String(error?.cause?.code ?? error?.code ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
  if (code === "enotfound" || code === "eai_again") {
    return "dns";
  }
  if (code === "econnrefused" || code === "econnreset" || code.startsWith("und_err_")) {
    return "network";
  }
  return "unknown";
}

async function parseCliArgs(argv) {
  const options = {
    approved: false,
    baseUrl: process.env.AAIS_LOAD_BASE_URL,
    credentials: null,
    credentialsPath: "",
    targetUsers: process.env.AAIS_LOAD_TARGET_USERS,
    concurrency: process.env.AAIS_LOAD_CONCURRENCY,
    maxP95Ms: process.env.AAIS_LOAD_MAX_P95_MS,
    outputPath: process.env.AAIS_LOAD_OUTPUT,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--approved") {
      options.approved = true;
      continue;
    }
    if (arg === "--base-url") {
      options.baseUrl = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--credentials") {
      options.credentialsPath = path.resolve(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg === "--target-users") {
      options.targetUsers = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--concurrency") {
      options.concurrency = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--max-p95-ms") {
      options.maxP95Ms = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--output") {
      options.outputPath = path.resolve(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    throw new Error(`Unknown AAIS load sanity argument: ${arg}`);
  }
  if (!options.credentials && !options.credentialsPath && process.env.AAIS_LOAD_STUDENT_CREDENTIALS_JSON) {
    options.credentials = parseCredentialsJson(process.env.AAIS_LOAD_STUDENT_CREDENTIALS_JSON);
  }
  return options;
}

function printHelp() {
  process.stdout.write([
    "Usage: npm run load:staging -- --approved --base-url https://preview.example --credentials ./ignored-load-users.json --target-users 200 --concurrency 200 --output ./aais-load-sanity.json",
    "",
    "Runs a staging/preview-only AAIS learner load sanity check:",
    "  - logs in each supplied student account",
    "  - reads /api/learning/session",
    "  - writes one synthetic artifact update",
    "  - reports aggregate timing and failure counts only",
    "",
    "Credentials may also be supplied through AAIS_LOAD_STUDENT_CREDENTIALS_JSON.",
    "Known production hosts are refused.",
    "",
  ].join("\n"));
}

async function main() {
  const options = await parseCliArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const report = await runAaisStagingLoadSanity(options);
  process.stdout.write(JSON.stringify({
    status: report.status,
    baseUrl: report.baseUrl,
    target: report.target,
    results: report.results,
    secrets: "redacted",
  }) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS staging load sanity failed."}\n`);
    process.exitCode = 1;
  });
}
