#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const defaultBaseUrl = "https://www.aais.site";
const sessionCookieName = "aais_session";
const csrfCookieName = "aais_csrf";

export async function runAaisProductionSmoke(input = {}) {
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? process.env.AAIS_SMOKE_BASE_URL ?? defaultBaseUrl);
  const account = readRequiredValue(
    input.account ?? process.env.AAIS_SMOKE_TRIAL_ACCOUNT,
    "AAIS_SMOKE_TRIAL_ACCOUNT",
  );
  const password = readRequiredValue(
    input.password ?? process.env.AAIS_SMOKE_TRIAL_PASSWORD,
    "AAIS_SMOKE_TRIAL_PASSWORD",
  );
  const fetchImpl = input.fetchImpl ?? fetch;
  const checkedAt = new Date().toISOString();
  const checks = [];

  checks.push(await checkLoginPage({ baseUrl, fetchImpl }));
  checks.push(await checkReadiness({ baseUrl, fetchImpl }));
  const blockedCredentialCheck = await maybeCheckBlockedTrialLogin({
    baseUrl,
    blockedAccount: input.blockedAccount ?? process.env.AAIS_SMOKE_BLOCKED_TRIAL_ACCOUNT,
    blockedPassword: input.blockedPassword ?? process.env.AAIS_SMOKE_BLOCKED_TRIAL_PASSWORD,
    fetchImpl,
  });
  if (blockedCredentialCheck) {
    checks.push(blockedCredentialCheck);
  }

  const loginCheck = await checkTrialLogin({ baseUrl, account, password, fetchImpl });
  checks.push(loginCheck.safeCheck);
  if (!loginCheck.cookieHeader || !loginCheck.csrfToken) {
    return writeReportIfRequested({
      status: "failed",
      checkedAt,
      baseUrl,
      checks,
      redaction: redactionSummary(),
    }, input.outputPath ?? process.env.AAIS_SMOKE_OUTPUT);
  }

  checks.push(await checkLearningWrite({
    baseUrl,
    cookieHeader: loginCheck.cookieHeader,
    csrfToken: loginCheck.csrfToken,
    fetchImpl,
    now: checkedAt,
  }));

  return writeReportIfRequested({
    status: checks.every((check) => check.status === "passed") ? "passed" : "failed",
    checkedAt,
    baseUrl,
    checks,
    redaction: redactionSummary(),
  }, input.outputPath ?? process.env.AAIS_SMOKE_OUTPUT);
}

async function maybeCheckBlockedTrialLogin({
  baseUrl,
  blockedAccount,
  blockedPassword,
  fetchImpl,
}) {
  const account = String(blockedAccount ?? "").trim();
  const password = String(blockedPassword ?? "");
  if (!account && !password) {
    return null;
  }
  if (!account || !password) {
    return {
      name: "blocked-trial-login",
      status: "failed",
      details: {
        configured: "incomplete",
        loginRejected: false,
        sessionCookie: "not_checked",
      },
    };
  }
  try {
    const response = await fetchImpl(`${baseUrl}/api/auth/app-session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        account,
        password,
        consentAccepted: true,
        from: "/learning",
      }),
    });
    const body = await readJson(response);
    const cookieJar = extractCookieJar(response.headers);
    const loginRejected = response.status === 401
      || response.status === 403
      || response.status === 404
      || body?.error?.code === "AAIS_INVALID_CREDENTIALS"
      || body?.error?.code === "AAIS_TRIAL_LOGIN_DISABLED";
    const passed = loginRejected && !cookieJar.hasSessionCookie;
    return {
      name: "blocked-trial-login",
      status: passed ? "passed" : "failed",
      httpStatus: response.status,
      details: {
        configured: "present",
        loginRejected,
        sessionCookie: cookieJar.hasSessionCookie ? "present" : "absent",
        errorCode: typeof body?.error?.code === "string" ? body.error.code : "unknown",
      },
    };
  } catch (error) {
    return failedOnlineCheck("blocked-trial-login", error);
  }
}

async function checkLoginPage({ baseUrl, fetchImpl }) {
  try {
    const response = await fetchImpl(`${baseUrl}/login`, {
      method: "GET",
    });
    const body = await readText(response);
    const hasLoginMarkup = typeof body === "string"
      && /<html|<form|account|password|登录|login/i.test(body);
    return {
      name: "login-page",
      status: response.status === 200 && hasLoginMarkup ? "passed" : "failed",
      httpStatus: response.status,
      details: {
        pageReachable: response.status === 200,
        loginMarkup: hasLoginMarkup ? "present" : "missing",
      },
    };
  } catch (error) {
    return failedOnlineCheck("login-page", error);
  }
}

async function checkReadiness({ baseUrl, fetchImpl }) {
  try {
    const response = await fetchImpl(`${baseUrl}/api/system/readiness`, {
      method: "GET",
    });
    const body = await readJson(response);
    const status = body?.status === "ready" ? "passed" : "failed";
    return {
      name: "public-readiness",
      status,
      httpStatus: response.status,
      details: {
        publicStatus: typeof body?.status === "string" ? body.status : "unknown",
      },
    };
  } catch (error) {
    return failedOnlineCheck("public-readiness", error);
  }
}

async function checkTrialLogin({ baseUrl, account, password, fetchImpl }) {
  try {
    const response = await fetchImpl(`${baseUrl}/api/auth/app-session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        account,
        password,
        consentAccepted: true,
        from: "/learning",
      }),
    });
    const body = await readJson(response);
    const cookieJar = extractCookieJar(response.headers);
    const passed = response.status === 200
      && body?.redirectTarget === "/learning"
      && cookieJar.hasSessionCookie
      && Boolean(cookieJar.csrfToken);
    return {
      safeCheck: {
        name: "trial-login",
        status: passed ? "passed" : "failed",
        httpStatus: response.status,
        details: {
          redirectTarget: typeof body?.redirectTarget === "string" ? body.redirectTarget : "unknown",
          sessionCookie: cookieJar.hasSessionCookie ? "present" : "missing",
          csrfCookie: cookieJar.csrfToken ? "present" : "missing",
        },
      },
      cookieHeader: passed ? cookieJar.cookieHeader : null,
      csrfToken: passed ? cookieJar.csrfToken : null,
    };
  } catch (error) {
    return {
      safeCheck: failedOnlineCheck("trial-login", error),
      cookieHeader: null,
      csrfToken: null,
    };
  }
}

async function checkLearningWrite({ baseUrl, cookieHeader, csrfToken, fetchImpl, now }) {
  try {
    const sessionResponse = await fetchImpl(`${baseUrl}/api/learning/session`, {
      method: "GET",
      headers: {
        cookie: cookieHeader,
      },
    });
    const sessionBody = await readJson(sessionResponse);
    const taskId = readActiveTaskId(sessionBody);
    if (sessionResponse.status !== 200 || !taskId) {
      return {
        name: "learning-write",
        status: "failed",
        httpStatus: sessionResponse.status,
        details: {
          sessionReadable: sessionResponse.status === 200,
          activeTask: taskId ? "present" : "missing",
          writeAttempted: false,
        },
      };
    }

    const writeResponse = await fetchImpl(`${baseUrl}/api/learning/session`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: cookieHeader,
        "x-aais-csrf": csrfToken,
      },
      body: JSON.stringify({
        action: "save-artifact",
        taskId,
        artifactText: `AAIS smoke verification ${now}`,
      }),
    });
    const writeBody = await readJson(writeResponse);
    return {
      name: "learning-write",
      status: writeResponse.status === 200 && readActiveTaskId(writeBody) ? "passed" : "failed",
      httpStatus: writeResponse.status,
      details: {
        sessionReadable: true,
        activeTask: "present",
        writeAttempted: true,
        writeAccepted: writeResponse.status === 200,
      },
    };
  } catch (error) {
    return failedOnlineCheck("learning-write", error);
  }
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

async function readText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function failedOnlineCheck(name, error) {
  return {
    name,
    status: "failed",
    details: {
      reason: "online check failed before redacted evidence could be collected",
      errorCategory: classifyOnlineError(error),
    },
  };
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

async function writeReportIfRequested(report, outputPath) {
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}

function redactionSummary() {
  return {
    credentials: "omitted",
    cookies: "omitted",
    learnerText: "synthetic-smoke-only",
  };
}

function normalizeBaseUrl(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    throw new Error("AAIS smoke base URL is required.");
  }
  const url = new URL(trimmed);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("AAIS smoke base URL must use http or https.");
  }
  return url.toString().replace(/\/$/, "");
}

function readRequiredValue(value, envName) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    throw new Error(`${envName} is required for AAIS smoke verification.`);
  }
  return trimmed;
}

function parseArgs(argv) {
  const input = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base-url") {
      input.baseUrl = argv[index + 1];
      index += 1;
    } else if (arg === "--account") {
      input.account = argv[index + 1];
      index += 1;
    } else if (arg === "--password") {
      input.password = argv[index + 1];
      index += 1;
    } else if (arg === "--blocked-account") {
      input.blockedAccount = argv[index + 1];
      index += 1;
    } else if (arg === "--blocked-password") {
      input.blockedPassword = argv[index + 1];
      index += 1;
    } else if (arg === "--output") {
      input.outputPath = argv[index + 1];
      index += 1;
    } else if (arg === "--help") {
      input.help = true;
    } else {
      throw new Error(`Unknown AAIS smoke argument: ${arg}`);
    }
  }
  return input;
}

function printHelp() {
  console.log([
    "Usage: npm run smoke:prod -- --base-url https://www.aais.site --account <trial-account> --password <trial-password>",
    "",
    "Environment alternatives:",
    "  AAIS_SMOKE_BASE_URL",
    "  AAIS_SMOKE_TRIAL_ACCOUNT",
    "  AAIS_SMOKE_TRIAL_PASSWORD",
    "  AAIS_SMOKE_BLOCKED_TRIAL_ACCOUNT",
    "  AAIS_SMOKE_BLOCKED_TRIAL_PASSWORD",
    "  AAIS_SMOKE_OUTPUT",
  ].join("\n"));
}

async function main() {
  const input = parseArgs(process.argv.slice(2));
  if (input.help) {
    printHelp();
    return;
  }
  const report = await runAaisProductionSmoke(input);
  const summary = report.checks
    .map((check) => `${check.name}:${check.status}`)
    .join(" ");
  console.log(`AAIS smoke ${report.status}: ${summary}`);
  if (report.status !== "passed") {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`AAIS smoke failed: ${error.message}`);
    process.exitCode = 1;
  });
}
