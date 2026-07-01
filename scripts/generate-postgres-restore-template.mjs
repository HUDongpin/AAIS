#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const defaultOutputPath = "output/aais-postgres-restore-template-latest.env";
const defaultReportPath = "output/aais-postgres-restore-template-report-latest.json";
const defaultPostgresRestoreReportPath = "output/aais-postgres-restore-report-latest.json";
const defaultReleaseId = "aais-2026-06-30-rc-live-ai-deepseek-v4-flash";
const defaultPrivateRestoreEnvFilePath = ".env.postgres-restore.local";

export async function generateAaisPostgresRestoreTemplate(input = {}) {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const outputPath = input.outputPath ?? process.env.AAIS_POSTGRES_RESTORE_TEMPLATE_PATH ?? defaultOutputPath;
  const reportPath = input.reportPath ?? process.env.AAIS_POSTGRES_RESTORE_TEMPLATE_REPORT_PATH ?? defaultReportPath;
  const postgresRestoreReportPath = input.postgresRestoreReportPath ?? defaultPostgresRestoreReportPath;
  const privateRestoreEnvFilePath = input.privateRestoreEnvFilePath ?? defaultPrivateRestoreEnvFilePath;
  const releaseId = readSafeReleaseId(input.releaseId ?? process.env.AAIS_RELEASE_ID ?? defaultReleaseId);
  const report = {
    schemaVersion: 1,
    status: "template-created",
    generatedAt,
    release: {
      id: releaseId,
    },
    template: {
      outputPath,
      privateRestoreEnvFilePath,
      placeholderValues: "fail-closed",
      variables: [
        "AAIS_RESTORE_DATABASE_URL",
        "AAIS_RESTORE_DATABASE_PROVIDER",
        "AAIS_RESTORE_TARGET_PURPOSE",
        "AAIS_RELEASE_ID",
      ],
    },
    target: {
      databaseProvider: "neon",
      postgresRestoreReportPath,
    },
    nextCommands: [
      [
        "npm run verify:postgres-restore --",
        `--env-file ${privateRestoreEnvFilePath}`,
        "--database-provider neon",
        "--target-purpose restored-staging",
        `--output ${postgresRestoreReportPath}`,
        `--release-id ${releaseId}`,
      ].join(" "),
    ],
    redaction: {
      secrets: "omitted",
      values: "placeholders-only",
    },
  };

  await writeTextFile(outputPath, renderTemplate({ releaseId, privateRestoreEnvFilePath }));
  await writeTextFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  return report;
}

function renderTemplate({ releaseId, privateRestoreEnvFilePath }) {
  return [
    "# AAIS restored Neon rehearsal env template",
    "# Do not commit this file.",
    `# Copy this template to ${privateRestoreEnvFilePath}, then fill the copy with the restored staging Neon URL.`,
    "# Use a restored staging Neon database, never the production database.",
    "# Placeholder values intentionally fail closed in verify:postgres-restore.",
    "",
    "AAIS_RESTORE_DATABASE_URL=<REQUIRED:RESTORED_NEON_STAGING_DATABASE_URL>",
    "AAIS_RESTORE_DATABASE_PROVIDER=neon",
    "AAIS_RESTORE_TARGET_PURPOSE=restored-staging",
    `AAIS_RELEASE_ID=${releaseId}`,
    "",
  ].join("\n");
}

async function writeTextFile(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}

function readSafeReleaseId(value) {
  const trimmed = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(trimmed) ? trimmed : defaultReleaseId;
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
  const report = await generateAaisPostgresRestoreTemplate({
    outputPath: args.get("output"),
    reportPath: args.get("report"),
    postgresRestoreReportPath: args.get("postgres-restore-report"),
    releaseId: args.get("release-id"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS Postgres restore template generation failed."}\n`);
    process.exitCode = 1;
  });
}
