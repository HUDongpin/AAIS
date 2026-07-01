#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const defaultRootDir = ".aais-data";
const defaultManifestOutputPath = "output/aais-file-backup-private-latest.json";
const defaultReportPath = "output/aais-file-backup-report-latest.json";

export async function runAaisFileBackupCommand(input = {}) {
  const action = normalizeAction(input.action);
  const rootDir = readSafePath(input.rootDir ?? process.env.AAIS_DATA_DIR ?? defaultRootDir, defaultRootDir);
  const reportPath = readSafePath(
    input.reportPath ?? process.env.AAIS_FILE_BACKUP_REPORT_PATH ?? defaultReportPath,
    defaultReportPath,
  );

  if (action === "backup") {
    return writeBackup({
      rootDir,
      manifestOutputPath: readSafePath(
        input.manifestOutputPath
          ?? process.env.AAIS_FILE_BACKUP_MANIFEST_PATH
          ?? defaultManifestOutputPath,
        defaultManifestOutputPath,
      ),
      reportPath,
      now: input.now,
    });
  }

  return restoreBackup({
    rootDir,
    manifestPath: readSafePath(
      input.manifestPath
        ?? process.env.AAIS_FILE_BACKUP_MANIFEST_PATH
        ?? defaultManifestOutputPath,
      defaultManifestOutputPath,
    ),
    reportPath,
  });
}

async function writeBackup({
  rootDir,
  manifestOutputPath,
  reportPath,
  now,
}) {
  const generatedAt = (now ?? new Date()).toISOString();
  const manifest = await createBackupManifest({ rootDir, generatedAt });
  const report = {
    schemaVersion: 1,
    status: "passed",
    action: "backup",
    generatedAt,
    source: {
      mode: "file",
      rootDir,
      sessionsDir: getSessionsDir(rootDir),
    },
    backup: {
      manifestPath: manifestOutputPath,
      sessionCount: manifest.sessionCount,
      sessions: summarizeBackupSessions(manifest.sessions),
    },
    redaction: {
      secrets: "omitted",
      learnerPayloads: "manifest-private-not-in-report",
    },
  };

  await writeJsonFile(manifestOutputPath, manifest);
  await writeJsonFile(reportPath, report);
  return report;
}

async function restoreBackup({
  rootDir,
  manifestPath,
  reportPath,
}) {
  const restoredAt = new Date().toISOString();
  const manifest = validateBackupManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const sessionsDir = getSessionsDir(rootDir);
  await mkdir(sessionsDir, { recursive: true });
  for (const entry of manifest.sessions) {
    const target = path.join(sessionsDir, `${entry.studentId}.json`);
    const tempPath = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(entry.payload, null, 2)}\n`, "utf8");
    await rename(tempPath, target);
  }

  const report = {
    schemaVersion: 1,
    status: "passed",
    action: "restore",
    restoredAt,
    target: {
      mode: "file",
      rootDir,
      sessionsDir,
    },
    backup: {
      manifestPath,
      generatedAt: manifest.generatedAt,
      sessionCount: manifest.sessionCount,
      sessions: summarizeBackupSessions(manifest.sessions),
    },
    restore: {
      restoredSessions: manifest.sessions.length,
    },
    redaction: {
      secrets: "omitted",
      learnerPayloads: "manifest-private-not-in-report",
    },
  };
  await writeJsonFile(reportPath, report);
  return report;
}

async function createBackupManifest({ rootDir, generatedAt }) {
  const files = await readSessionFiles(getSessionsDir(rootDir));
  const sessions = await Promise.all(files.map(async (fileName) => {
    const raw = await readFile(path.join(getSessionsDir(rootDir), fileName), "utf8");
    const payload = JSON.parse(raw);
    const studentId = requireSafeStudentId(payload?.studentId);
    return {
      studentId,
      sha256: checksumSession(payload),
      payload,
    };
  }));
  const sortedSessions = sessions.sort((left, right) => left.studentId.localeCompare(right.studentId));
  return {
    schemaVersion: 1,
    generatedAt,
    sessionCount: sortedSessions.length,
    sessions: sortedSessions,
    redaction: {
      secrets: "omitted",
    },
  };
}

function validateBackupManifest(value) {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) {
    throw new Error("Unsupported AAIS backup schema.");
  }
  const sessions = Array.isArray(value.sessions) ? value.sessions : null;
  if (!sessions || value.sessionCount !== sessions.length) {
    throw new Error("Invalid AAIS backup session count.");
  }
  for (const entry of sessions) {
    const studentId = requireSafeStudentId(entry?.studentId);
    if (!entry?.payload || entry.payload.studentId !== studentId) {
      throw new Error("AAIS backup student id mismatch.");
    }
    if (!/^[a-f0-9]{64}$/.test(String(entry.sha256 ?? "")) || checksumSession(entry.payload) !== entry.sha256) {
      throw new Error("AAIS backup checksum mismatch.");
    }
  }
  return value;
}

function summarizeBackupSessions(sessions) {
  return sessions.map((entry) => ({
    studentId: entry.studentId,
    sha256: entry.sha256,
  }));
}

async function readSessionFiles(sessionsDir) {
  try {
    const files = await readdir(sessionsDir);
    return files.filter((fileName) => fileName.endsWith(".json")).sort();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function checksumSession(session) {
  return createHash("sha256")
    .update(JSON.stringify(session))
    .digest("hex");
}

function getSessionsDir(rootDir) {
  return path.join(rootDir, "sessions");
}

function requireSafeStudentId(value) {
  const trimmed = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(trimmed)) {
    throw new Error("Invalid AAIS backup student id.");
  }
  return trimmed;
}

function normalizeAction(value) {
  const action = String(value ?? "").trim().toLowerCase();
  if (action === "backup" || action === "restore") {
    return action;
  }
  throw new Error("AAIS file backup command requires action backup or restore.");
}

function readSafePath(value, fallback) {
  const trimmed = String(value ?? "").trim();
  return trimmed || fallback;
}

async function writeJsonFile(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseCliArgs(argv) {
  const args = new Map();
  let action = null;
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      action ??= current;
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
  return { action, args };
}

async function main() {
  const { action, args } = parseCliArgs(process.argv.slice(2));
  const report = await runAaisFileBackupCommand({
    action,
    rootDir: args.get("root-dir"),
    manifestOutputPath: args.get("manifest-output"),
    manifestPath: args.get("manifest"),
    reportPath: args.get("report"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS file backup command failed."}\n`);
    process.exitCode = 1;
  });
}
