#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const storageRequestName = "AAIS_DATABASE_URL";
const releaseIdRequestName = "AAIS_RELEASE_ID";
const deploymentGitCommitRequestName = "AAIS_DEPLOYMENT_GIT_COMMIT_SHA";
const databaseUrlEnvNames = [
  "AAIS_DATABASE_URL",
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NO_SSL",
  "DATABASE_URL_UNPOOLED",
  "POSTGRES_URL_NON_POOLING",
];
const rawPgSourceName = "PGHOST/PGUSER/PGDATABASE/PGPASSWORD";
const legacyRawPgSourceName = "POSTGRES_HOST/POSTGRES_USER/POSTGRES_DATABASE/POSTGRES_PASSWORD";
const rawPgValueNames = ["PGUSER", "PGDATABASE", "PGPASSWORD"];
const rawPgOptionalNames = ["PGPORT", "PGSSLMODE"];
const legacyRawPgValueNames = ["POSTGRES_USER", "POSTGRES_DATABASE", "POSTGRES_PASSWORD"];
const legacyRawPgOptionalNames = ["POSTGRES_PORT", "POSTGRES_SSLMODE"];
const oidcRoleMappingRequestName = "AAIS_OIDC_TEACHER_GROUPS";
const oidcRoleMappingEnvNames = [
  "AAIS_OIDC_TEACHER_GROUPS",
  "AAIS_OIDC_TEACHER_EMAILS",
  "AAIS_OIDC_ADMIN_GROUPS",
  "AAIS_OIDC_ADMIN_EMAILS",
];
const productionDeployCommand = "vercel deploy --prod -y --no-wait";
const defaultVercelDeploymentReportPath = "output/aais-vercel-deployment-report-latest.json";

export async function provisionAaisVercelEnvironment(input = {}) {
  const checkedAt = (input.now ?? new Date()).toISOString();
  const environment = normalizeEnvironment(input.environment ?? "production");
  const apply = input.apply === true;
  const envValues = await readEnvFile(input.envFilePath);
  const releaseId = readSafeReleaseId(input.releaseId ?? process.env.AAIS_RELEASE_ID);
  const deploymentGitCommit = readSafeGitCommitSha(
    input.deploymentGitCommit
      ?? process.env.AAIS_DEPLOYMENT_GIT_COMMIT_SHA
      ?? process.env.VERCEL_GIT_COMMIT_SHA,
  );
  if (releaseId && !hasLocalValue(envValues, releaseIdRequestName)) {
    envValues.set(releaseIdRequestName, releaseId);
  }
  if (deploymentGitCommit && !hasLocalValue(envValues, deploymentGitCommitRequestName)) {
    envValues.set(deploymentGitCommitRequestName, deploymentGitCommit);
  }
  const names = await readRequestedNames(input);
  const requests = names.map((name) => resolveProvisionRequest(envValues, name));
  const localValuesPresent = requests
    .filter((request) => !request.missing)
    .map((request) => request.presentName);
  const localValuesMissing = requests
    .filter((request) => request.missing)
    .map((request) => request.requestedName);
  const canApply = apply && localValuesMissing.length === 0;
  const runner = input.runner ?? runVercelEnvAdd;

  const actions = [];
  for (const request of requests) {
    if (request.missing) {
      const command = `vercel env add ${request.requestedName} ${environment}`;
      actions.push({
        name: request.requestedName,
        command,
        status: "missing_local_value",
      });
      continue;
    }
    for (const action of request.actions) {
      const command = `vercel env add ${action.name} ${environment}`;
      const common = {
        name: action.name,
        ...(action.name !== request.requestedName ? { requestedName: request.requestedName } : {}),
        command,
      };
      if (!apply) {
        actions.push({
          ...common,
          status: "dry_run",
        });
        continue;
      }
      if (!canApply) {
        actions.push({
          ...common,
          status: "blocked",
        });
        continue;
      }
      const result = await runner({
        name: action.name,
        environment,
        value: envValues.get(action.name),
      });
      actions.push({
        ...common,
        status: result?.ok === true ? "applied" : "failed",
      });
    }
  }

  const report = {
    schemaVersion: 1,
    status: getStatus({ apply, actions, localValuesMissing }),
    checkedAt,
    mode: apply ? "apply" : "dry-run",
    target: {
      environment,
      source: input.vercelEnvReportPath ? "vercel-env-report" : "explicit-names",
    },
    required: {
      requested: names,
      localValuesPresent,
      localValuesMissing,
    },
    actions,
    postApply: {
      redeployRequired: actions.length > 0,
      command: productionDeployCommand,
      inspectCommand: [
        "npm run verify:vercel-deployment --",
        "--deployment-url <deployment-url>",
        `--output ${defaultVercelDeploymentReportPath}`,
      ].join(" "),
      note: "Run a fresh production deployment after apply, inspect the returned deployment URL until it is ready, then rerun Vercel env, enterprise, and final release evidence verification.",
    },
    redaction: {
      secrets: "omitted",
      values: "read-transiently-not-output",
    },
  };

  const outputPath = input.outputPath ?? process.env.AAIS_VERCEL_ENV_PROVISION_REPORT_PATH;
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  return report;
}

async function readEnvFile(filePath) {
  const resolvedPath = String(filePath ?? "").trim();
  if (!resolvedPath) {
    throw new Error("AAIS Vercel env provisioner requires --env-file.");
  }
  let raw = "";
  try {
    raw = await readFile(resolvedPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
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
    if (!isSafeEnvName(name)) {
      continue;
    }
    const value = parseEnvValue(normalized.slice(separator + 1).trim());
    values.set(name, value);
  }
  return values;
}

function parseEnvValue(value) {
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

async function readRequestedNames(input) {
  const explicitNames = Array.isArray(input.names)
    ? input.names.map((name) => String(name ?? "").trim()).filter(Boolean)
    : [];
  const names = explicitNames.length
    ? explicitNames
    : await readMissingNamesFromReport(input.vercelEnvReportPath);
  const invalid = names.find((name) => !isSafeEnvName(name));
  if (invalid) {
    throw new Error(`Invalid AAIS Vercel env name: ${invalid}`);
  }
  return Array.from(new Set(names));
}

async function readMissingNamesFromReport(filePath) {
  const resolvedPath = String(filePath ?? "").trim();
  if (!resolvedPath) {
    throw new Error("AAIS Vercel env provisioner requires --report or --name.");
  }
  const report = JSON.parse(await readFile(resolvedPath, "utf8"));
  return Array.isArray(report?.required?.missing)
    ? report.required.missing.map((name) => String(name ?? "").trim()).filter(Boolean)
    : [];
}

function getStatus({ apply, actions, localValuesMissing }) {
  if (localValuesMissing.length > 0 || actions.some((action) => action.status === "failed")) {
    return "failed";
  }
  if (!apply) {
    return "ready";
  }
  return actions.every((action) => action.status === "applied") ? "applied" : "failed";
}

function hasLocalValue(values, name) {
  const value = values.get(name);
  return Boolean(value?.trim()) && !isPlaceholderValue(value);
}

function isPlaceholderValue(value) {
  return /^<REQUIRED:[A-Z0-9_:-]+>$/i.test(String(value ?? "").trim());
}

function resolveProvisionRequest(values, requestedName) {
  if (requestedName === oidcRoleMappingRequestName) {
    const presentName = oidcRoleMappingEnvNames.find((name) => hasLocalValue(values, name));
    return {
      requestedName,
      presentName: presentName ?? requestedName,
      missing: !presentName,
      actions: presentName ? [{ name: presentName }] : [],
    };
  }
  if (requestedName !== storageRequestName) {
    return {
      requestedName,
      presentName: requestedName,
      missing: !hasLocalValue(values, requestedName),
      actions: hasLocalValue(values, requestedName) ? [{ name: requestedName }] : [],
    };
  }
  const databaseUrlName = databaseUrlEnvNames.find((name) => hasLocalValue(values, name));
  if (databaseUrlName) {
    return {
      requestedName,
      presentName: databaseUrlName,
      missing: false,
      actions: [{ name: databaseUrlName }],
    };
  }
  const rawPgHostName = ["PGHOST", "PGHOST_UNPOOLED"].find((name) => hasLocalValue(values, name));
  const rawPgComplete = rawPgHostName && rawPgValueNames.every((name) => hasLocalValue(values, name));
  if (rawPgComplete) {
    const optionalNames = rawPgOptionalNames.filter((name) => hasLocalValue(values, name));
    return {
      requestedName,
      presentName: rawPgSourceName,
      missing: false,
      actions: [rawPgHostName, ...rawPgValueNames, ...optionalNames].map((name) => ({ name })),
    };
  }
  const legacyRawPgHostName = ["POSTGRES_HOST", "POSTGRES_HOST_NON_POOLING"].find((name) => (
    hasLocalValue(values, name)
  ));
  const legacyRawPgComplete = legacyRawPgHostName && legacyRawPgValueNames.every((name) => (
    hasLocalValue(values, name)
  ));
  if (legacyRawPgComplete) {
    const optionalNames = legacyRawPgOptionalNames.filter((name) => hasLocalValue(values, name));
    return {
      requestedName,
      presentName: legacyRawPgSourceName,
      missing: false,
      actions: [legacyRawPgHostName, ...legacyRawPgValueNames, ...optionalNames].map((name) => ({ name })),
    };
  }
  return {
    requestedName,
    presentName: requestedName,
    missing: true,
    actions: [],
  };
}

function normalizeEnvironment(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!["production", "preview", "development"].includes(normalized)) {
    throw new Error("AAIS Vercel env provisioner environment must be production, preview, or development.");
  }
  return normalized;
}

function isSafeEnvName(value) {
  return /^[A-Z][A-Z0-9_]{1,127}$/.test(value);
}

function readSafeReleaseId(value) {
  const trimmed = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(trimmed) ? trimmed : null;
}

function readSafeGitCommitSha(value) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{7,40}$/.test(trimmed) ? trimmed : null;
}

async function runVercelEnvAdd({ name, environment, value }) {
  return new Promise((resolve) => {
    const child = spawn("vercel", ["env", "add", name, environment, "--yes", "--sensitive"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", () => resolve({ ok: false }));
    child.on("close", (code) => resolve({ ok: code === 0 }));
    child.stdin.end(value);
  });
}

function parseCliArgs(argv) {
  const args = new Map();
  const names = [];
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      continue;
    }
    const [rawKey, inlineValue] = current.slice(2).split("=");
    if (rawKey === "name") {
      const value = inlineValue ?? argv[index + 1];
      if (inlineValue === undefined) {
        index += 1;
      }
      names.push(value);
      continue;
    }
    const nextValue = argv[index + 1];
    const value = inlineValue ?? (nextValue && !nextValue.startsWith("--") ? nextValue : true);
    if (inlineValue === undefined && value === nextValue) {
      index += 1;
    }
    args.set(rawKey, value);
  }
  return { args, names };
}

async function main() {
  const { args, names } = parseCliArgs(process.argv.slice(2));
  const report = await provisionAaisVercelEnvironment({
    envFilePath: args.get("env-file"),
    vercelEnvReportPath: args.get("report"),
    names,
    environment: args.get("environment") ?? "production",
    releaseId: args.get("release-id"),
    deploymentGitCommit: args.get("deployment-git-commit"),
    apply: args.has("apply"),
    outputPath: args.get("output"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status === "failed") {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS Vercel env provision failed."}\n`);
    process.exitCode = 1;
  });
}
