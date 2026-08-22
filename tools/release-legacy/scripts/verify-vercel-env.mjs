#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const rawPgSourceEnv = "PGHOST/PGUSER/PGDATABASE/PGPASSWORD";
const legacyRawPgSourceEnv = "POSTGRES_HOST/POSTGRES_USER/POSTGRES_DATABASE/POSTGRES_PASSWORD";
const databaseUrlEnvNames = [
  "AAIS_DATABASE_URL",
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NO_SSL",
  "DATABASE_URL_UNPOOLED",
  "POSTGRES_URL_NON_POOLING",
];
const databaseAcceptedEnvNames = [...databaseUrlEnvNames, rawPgSourceEnv, legacyRawPgSourceEnv];
const rawPgEnvNames = ["PGUSER", "PGDATABASE", "PGPASSWORD"];
const legacyRawPgEnvNames = ["POSTGRES_USER", "POSTGRES_DATABASE", "POSTGRES_PASSWORD"];
const aiEvalManifestEnvNames = ["AAIS_AI_EVAL_MANIFEST_PATH", "AAIS_AI_EVAL_MANIFEST_JSON"];
const oidcRoleMappingEnvNames = [
  "AAIS_OIDC_TEACHER_GROUPS",
  "AAIS_OIDC_TEACHER_EMAILS",
  "AAIS_OIDC_ADMIN_GROUPS",
  "AAIS_OIDC_ADMIN_EMAILS",
];

const requiredByCategory = {
  core: [
    "AAIS_SESSION_SECRET",
    "AAIS_PRODUCT_PSEUDONYM_SECRET",
    "AAIS_RELEASE_ID",
    "AAIS_DEPLOYMENT_GIT_COMMIT_SHA",
  ],
  storage: ["AAIS_DATABASE_URL", "AAIS_DATABASE_PROVIDER"],
  releaseMode: ["AAIS_TRIAL_LOGIN_ENABLED"],
  oidc: [
    "AAIS_OIDC_ISSUER",
    "AAIS_OIDC_CLIENT_ID",
    "AAIS_OIDC_CLIENT_SECRET",
    "AAIS_OIDC_REDIRECT_URI",
  ],
  oidcRoleMapping: ["AAIS_OIDC_TEACHER_GROUPS"],
  ai: [
    "AAIS_AI_PROVIDER",
    "AAIS_AI_ENDPOINT",
    "AAIS_AI_API_KEY",
    "AAIS_AI_MODEL",
    "AAIS_AI_EVAL_APPROVED",
    "AAIS_AI_EVAL_VERSION",
    "AAIS_AI_EVAL_MANIFEST_PATH",
  ],
  lrs: ["LRS_ENDPOINT", "LRS_USERNAME", "LRS_PASSWORD", "CRON_SECRET"],
};

export async function verifyAaisVercelEnvironment(input = {}) {
  const checkedAt = (input.now ?? new Date()).toISOString();
  const targetEnvironment = normalizeEnvironment(input.environment ?? "Production");
  const authMode = normalizeAuthMode(input.authMode ?? process.env.AAIS_VERCEL_ENV_AUTH_MODE);
  const aiMode = normalizeAiMode(input.aiMode ?? process.env.AAIS_VERCEL_ENV_AI_MODE);
  const required = getRequiredByCategory({ authMode, aiMode });
  const requiredNames = Object.values(required).flat();
  const rows = input.rows ?? parseVercelEnvList(input.envListText ?? await readVercelEnvList());
  const storageUrl = getStorageUrlStatus(rows, targetEnvironment);
  const aiEvalManifest = getAiEvalManifestStatus(rows, targetEnvironment);
  const oidcRoleMapping = getOidcRoleMappingStatus(rows, targetEnvironment);
  const present = requiredNames
    .flatMap((name) => {
      if (name === "AAIS_DATABASE_URL") {
        return storageUrl.present ? [storageUrl.sourceEnv] : [];
      }
      if (name === "AAIS_AI_EVAL_MANIFEST_PATH") {
        return aiEvalManifest.present ? [aiEvalManifest.sourceEnv] : [];
      }
      if (name === "AAIS_OIDC_TEACHER_GROUPS") {
        return oidcRoleMapping.present ? [oidcRoleMapping.sourceEnv] : [];
      }
      return rows.some((row) => row.name === name && row.environments.includes(targetEnvironment))
        ? [name]
        : [];
    });
  const missing = requiredNames.filter((name) => {
    if (name === "AAIS_DATABASE_URL") {
      return !storageUrl.present;
    }
    if (name === "AAIS_AI_EVAL_MANIFEST_PATH") {
      return !aiEvalManifest.present;
    }
    if (name === "AAIS_OIDC_TEACHER_GROUPS") {
      return !oidcRoleMapping.present;
    }
    return !present.includes(name);
  });
  const categories = Object.fromEntries(
    Object.entries(required).map(([category, names]) => [
      category,
      names.filter((name) => missing.includes(name)),
    ]),
  );

  const report = {
    schemaVersion: 1,
    status: missing.length === 0 ? "passed" : "failed",
    checkedAt,
    target: {
      environment: targetEnvironment,
      authMode,
      aiMode,
    },
    required: {
      present,
      missing,
    },
    categories,
    storageUrl,
    aiEvalManifest,
    oidcRoleMapping,
    provisioningPlan: getProvisioningPlan(categories, targetEnvironment),
    redaction: {
      secrets: "omitted",
      values: "not-read",
    },
  };

  const outputPath = input.outputPath ?? process.env.AAIS_VERCEL_ENV_REPORT_PATH;
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  return report;
}

function getRequiredByCategory({ authMode, aiMode }) {
  return {
    ...requiredByCategory,
    oidc: authMode === "sso-only" ? requiredByCategory.oidc : [],
    oidcRoleMapping: authMode === "sso-only" ? requiredByCategory.oidcRoleMapping : [],
    releaseMode: authMode === "sso-only"
      ? ["AAIS_TRIAL_LOGIN_ENABLED"]
      : ["AAIS_TRIAL_ACCOUNTS_JSON"],
    ai: aiMode === "live" ? requiredByCategory.ai : [],
  };
}

function getOidcRoleMappingStatus(rows, targetEnvironment) {
  const sourceEnv = oidcRoleMappingEnvNames.find((name) => rows.some(
    (row) => row.name === name && row.environments.includes(targetEnvironment),
  )) ?? null;
  return {
    present: Boolean(sourceEnv),
    sourceEnv,
    acceptedNames: oidcRoleMappingEnvNames,
  };
}

function getAiEvalManifestStatus(rows, targetEnvironment) {
  const sourceEnv = aiEvalManifestEnvNames.find((name) => rows.some(
    (row) => row.name === name && row.environments.includes(targetEnvironment),
  )) ?? null;
  return {
    present: Boolean(sourceEnv),
    sourceEnv,
    acceptedNames: aiEvalManifestEnvNames,
  };
}

function getStorageUrlStatus(rows, targetEnvironment) {
  const sourceEnv = databaseUrlEnvNames.find((name) => rows.some(
    (row) => row.name === name && row.environments.includes(targetEnvironment),
  )) ?? getRawPgSourceEnv(rows, targetEnvironment);
  return {
    present: Boolean(sourceEnv),
    sourceEnv,
    acceptedNames: databaseAcceptedEnvNames,
  };
}

function getRawPgSourceEnv(rows, targetEnvironment) {
  const hasHost = ["PGHOST", "PGHOST_UNPOOLED"].some((name) => hasEnvRow(rows, targetEnvironment, name));
  const hasPieces = rawPgEnvNames.every((name) => hasEnvRow(rows, targetEnvironment, name));
  if (hasHost && hasPieces) {
    return rawPgSourceEnv;
  }
  const hasLegacyHost = ["POSTGRES_HOST", "POSTGRES_HOST_NON_POOLING"].some((name) => (
    hasEnvRow(rows, targetEnvironment, name)
  ));
  const hasLegacyPieces = legacyRawPgEnvNames.every((name) => hasEnvRow(rows, targetEnvironment, name));
  return hasLegacyHost && hasLegacyPieces ? legacyRawPgSourceEnv : null;
}

function hasEnvRow(rows, targetEnvironment, name) {
  return rows.some((row) => row.name === name && row.environments.includes(targetEnvironment));
}

function getProvisioningPlan(categories, environment) {
  const actions = Object.entries(categories)
    .filter(([, missing]) => missing.length > 0)
    .map(([category, missing]) => ({
      category,
      missing,
      commands: getProvisioningCommands({ category, missing, environment }),
      note: getProvisioningNote(category),
    }));

  return {
    status: actions.length > 0 ? "required" : "not-needed",
    environment,
    actions,
    redaction: {
      values: "not-included",
    },
  };
}

function getProvisioningCommands({ category, missing, environment }) {
  const target = environment.toLowerCase();
  const commands = missing.map((name) => `vercel env add ${name} ${target}`);
  if (category === "ai" && missing.includes("AAIS_AI_EVAL_MANIFEST_PATH")) {
    commands.push(`vercel env add AAIS_AI_EVAL_MANIFEST_JSON ${target}`);
  }
  return commands;
}

function getProvisioningNote(category) {
  if (category === "storage") {
    return "Use the Neon production Postgres connection string. AAIS prefers AAIS_DATABASE_URL but also accepts Vercel/Neon DATABASE_URL, POSTGRES_URL, POSTGRES_PRISMA_URL, POSTGRES_URL_NO_SSL, DATABASE_URL_UNPOOLED, POSTGRES_URL_NON_POOLING, raw PGHOST/PGUSER/PGDATABASE/PGPASSWORD pieces, or legacy POSTGRES_HOST/POSTGRES_USER/POSTGRES_DATABASE/POSTGRES_PASSWORD pieces; set AAIS_DATABASE_PROVIDER to neon when the host cannot be inspected here.";
  }
  if (category === "releaseMode") {
    return "Current-stage AAIS uses trial auth in production; set AAIS_TRIAL_ACCOUNTS_JSON for the trial gate, and only set AAIS_TRIAL_LOGIN_ENABLED to false after enterprise SSO access is verified.";
  }
  if (category === "oidc") {
    return "Use the enterprise IdP issuer, client, secret, and production callback URL. AAIS discovers provider endpoints from the issuer unless explicit endpoint variables are supplied.";
  }
  if (category === "oidcRoleMapping") {
    return "Configure at least one verified teacher/admin OIDC role mapping so SSO-only cohort analytics can authorize educator sessions. AAIS accepts AAIS_OIDC_TEACHER_GROUPS, AAIS_OIDC_TEACHER_EMAILS, AAIS_OIDC_ADMIN_GROUPS, or AAIS_OIDC_ADMIN_EMAILS.";
  }
  if (category === "ai") {
    return "Use the reviewed live-AI provider, model, approval flag, eval version, and either a server-readable eval manifest path or a redacted inline eval manifest JSON.";
  }
  if (category === "lrs") {
    return "Use a long random value so Vercel Cron can call the persistent LRS outbox drain with Authorization: Bearer <CRON_SECRET> without exposing the token in reports.";
  }
  return "Set these Vercel Production variables from the owner-approved secret source, then rerun the verifier.";
}

function parseVercelEnvList(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Z][A-Z0-9_]+\s+/.test(line))
    .map((line) => {
      const tokens = line.split(/\s+/);
      return {
        name: tokens[0],
        environments: tokens
          .slice(2)
          .map((token) => normalizeEnvironment(token.replace(/,$/, "")))
          .filter((token) => ["Production", "Preview", "Development"].includes(token)),
      };
    });
}

async function readVercelEnvList() {
  const { stdout } = await execFileAsync("vercel", ["env", "ls"], {
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

function normalizeEnvironment(value) {
  const lower = String(value ?? "").trim().toLowerCase();
  if (lower === "production") {
    return "Production";
  }
  if (lower === "preview") {
    return "Preview";
  }
  if (lower === "development") {
    return "Development";
  }
  return "Production";
}

function normalizeAuthMode(value) {
  return String(value ?? "").trim().toLowerCase() === "sso-only" ? "sso-only" : "trial";
}

function normalizeAiMode(value) {
  return String(value ?? "").trim().toLowerCase() === "deterministic" ? "deterministic" : "live";
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
  const report = await verifyAaisVercelEnvironment({
    environment: args.get("environment"),
    authMode: args.get("auth-mode"),
    aiMode: args.get("ai-mode"),
    outputPath: args.get("output"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "passed") {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS Vercel env verification failed."}\n`);
    process.exitCode = 1;
  });
}
