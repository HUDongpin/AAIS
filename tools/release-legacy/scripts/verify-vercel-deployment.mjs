#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaultOutputPath = "output/aais-vercel-deployment-report-latest.json";

export async function verifyAaisVercelDeployment(input = {}) {
  const checkedAt = (input.now ?? new Date()).toISOString();
  const deploymentUrl = normalizeUrl(input.deploymentUrl ?? process.env.AAIS_RELEASE_DEPLOYMENT_URL);
  const releaseId = readSafeReleaseId(input.releaseId ?? process.env.AAIS_RELEASE_ID);
  const explicitGitCommit = readExplicitGitCommit(
    input.deploymentGitCommit
      ?? process.env.AAIS_DEPLOYMENT_GIT_COMMIT_SHA
      ?? process.env.VERCEL_GIT_COMMIT_SHA,
    input.deploymentGitCommit || process.env.AAIS_DEPLOYMENT_GIT_COMMIT_SHA
      ? "AAIS_DEPLOYMENT_GIT_COMMIT_SHA"
      : "VERCEL_GIT_COMMIT_SHA",
  );
  const inspectResult = await readInspectJson(input, deploymentUrl);
  const parsed = inspectResult.ok ? parseInspectPayload(inspectResult.raw) : null;
  const deployment = summarizeDeployment(parsed, deploymentUrl, explicitGitCommit);
  const redactionOk = inspectResult.secretScan.status === "passed";
  const commitTraceable = Boolean(deployment.gitCommitShortSha);
  const status = deploymentUrl
    && inspectResult.ok
    && deployment.readyState === "READY"
    && deployment.urlMatchesExpected
    && deployment.target === "production"
    && commitTraceable
    && redactionOk
    ? "passed"
    : "failed";

  const report = {
    schemaVersion: 1,
    status,
    checkedAt,
    command: "vercel inspect <deployment-url> --json",
    release: {
      id: releaseId,
    },
    deployment,
    inspect: {
      source: inspectResult.source,
      parsed: inspectResult.ok,
      errorCategory: inspectResult.errorCategory,
      secretScan: inspectResult.secretScan,
    },
    redaction: {
      secrets: "omitted",
      rawInspectOutput: "not-stored",
      values: "summarized",
    },
  };

  const outputPath = input.outputPath ?? process.env.AAIS_VERCEL_DEPLOYMENT_REPORT_PATH ?? defaultOutputPath;
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  return report;
}

async function readInspectJson(input, deploymentUrl) {
  if (input.inspectJson !== undefined) {
    return parseRawInspect(String(input.inspectJson), "inline-json");
  }
  if (input.inspectJsonPath) {
    try {
      return parseRawInspect(await readFile(input.inspectJsonPath, "utf8"), "file");
    } catch {
      return failedInspect("file", "unreadable");
    }
  }
  if (!deploymentUrl) {
    return failedInspect("vercel-cli", "missing-deployment-url");
  }
  const runner = input.runner ?? runVercelInspect;
  try {
    const result = await runner(deploymentUrl);
    if (result?.ok === false) {
      return failedInspect("vercel-cli", readErrorCategory(result.errorCategory));
    }
    return parseRawInspect(String(result?.stdout ?? ""), "vercel-cli");
  } catch {
    return failedInspect("vercel-cli", "inspect-failed");
  }
}

function parseRawInspect(raw, source) {
  const secretScan = scanSecretLikeContent(raw);
  try {
    JSON.parse(raw);
    return {
      ok: true,
      raw,
      source,
      errorCategory: null,
      secretScan,
    };
  } catch {
    return {
      ok: false,
      raw: "",
      source,
      errorCategory: "invalid-json",
      secretScan,
    };
  }
}

function failedInspect(source, errorCategory) {
  return {
    ok: false,
    raw: "",
    source,
    errorCategory,
    secretScan: {
      status: "not-run",
    },
  };
}

async function runVercelInspect(deploymentUrl) {
  try {
    const { stdout } = await execFileAsync("vercel", ["inspect", deploymentUrl, "--json"], {
      maxBuffer: 2 * 1024 * 1024,
    });
    return {
      ok: true,
      stdout,
    };
  } catch {
    return {
      ok: false,
      errorCategory: "inspect-failed",
    };
  }
}

function parseInspectPayload(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    return null;
  }
}

function summarizeDeployment(inspect, expectedUrl, explicitGitCommit = null) {
  const candidates = [
    inspect?.url,
    inspect?.deployment?.url,
    inspect?.deploymentUrl,
  ].map(normalizeUrl).filter(Boolean);
  const aliases = getAliases(inspect).map(normalizeUrl).filter(Boolean);
  const expected = normalizeUrl(expectedUrl);
  const primaryUrl = candidates[0] ?? null;
  const allUrls = [...new Set([...candidates, ...aliases])];
  const readyState = readReadyState(
    inspect?.readyState
      ?? inspect?.state
      ?? inspect?.deployment?.readyState
      ?? inspect?.deployment?.state,
  );
  const target = readDeploymentTarget(inspect?.target ?? inspect?.deployment?.target);
  const inspectGitCommitShortSha = readGitCommitShortSha(
    inspect?.meta?.githubCommitSha
      ?? inspect?.meta?.gitCommitSha
      ?? inspect?.deployment?.meta?.githubCommitSha
      ?? inspect?.deployment?.meta?.gitCommitSha,
  );
  const gitCommitShortSha = inspectGitCommitShortSha ?? explicitGitCommit?.shortSha ?? null;
  return {
    url: primaryUrl,
    expectedUrl: expected,
    urlMatchesExpected: Boolean(expected && allUrls.includes(expected)),
    aliases,
    readyState,
    target,
    targetMatchesProduction: target === "production",
    gitCommitShortSha,
    gitCommitSource: inspectGitCommitShortSha
      ? "vercel-inspect"
      : explicitGitCommit?.shortSha
        ? explicitGitCommit.source
        : "missing",
  };
}

function getAliases(inspect) {
  const raw = [
    ...(Array.isArray(inspect?.aliases) ? inspect.aliases : []),
    ...(Array.isArray(inspect?.alias) ? inspect.alias : []),
    ...(Array.isArray(inspect?.deployment?.aliases) ? inspect.deployment.aliases : []),
  ];
  return raw.map((item) => typeof item === "string" ? item : item?.url).filter(Boolean);
}

function normalizeUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function readReadyState(value) {
  const trimmed = String(value ?? "").trim().toUpperCase();
  return ["READY", "BUILDING", "ERROR", "QUEUED", "CANCELED"].includes(trimmed) ? trimmed : "unknown";
}

function readDeploymentTarget(value) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  return trimmed === "production" || trimmed === "preview" ? trimmed : "unknown";
}

function readSafeReleaseId(value) {
  const trimmed = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(trimmed) ? trimmed : null;
}

function readGitCommitShortSha(value) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{7,40}$/.test(trimmed) ? trimmed.slice(0, 12) : null;
}

function readExplicitGitCommit(value, source) {
  const shortSha = readGitCommitShortSha(value);
  if (!shortSha) {
    return null;
  }
  return {
    shortSha,
    source: source === "VERCEL_GIT_COMMIT_SHA" ? "VERCEL_GIT_COMMIT_SHA" : "AAIS_DEPLOYMENT_GIT_COMMIT_SHA",
  };
}

function readErrorCategory(value) {
  const trimmed = String(value ?? "").trim();
  return /^[a-z][a-z0-9_-]{1,63}$/.test(trimmed) ? trimmed : "inspect-failed";
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
  const report = await verifyAaisVercelDeployment({
    deploymentUrl: args.get("deployment-url"),
    releaseId: args.get("release-id"),
    deploymentGitCommit: args.get("deployment-git-commit"),
    inspectJsonPath: args.get("inspect-json"),
    outputPath: args.get("output"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "passed") {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => {
    process.stderr.write("AAIS Vercel deployment verification failed.\n");
    process.exitCode = 1;
  });
}
