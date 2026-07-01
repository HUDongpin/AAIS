import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AaisLearnerSession } from "@/lib/server/aais-learning-store";

export type AaisBackupManifest = {
  schemaVersion: 1;
  generatedAt: string;
  sessionCount: number;
  sessions: AaisBackupSession[];
  redaction: {
    secrets: "omitted";
  };
};

type AaisBackupSession = {
  studentId: string;
  sha256: string;
  payload: AaisLearnerSession;
};

export async function createAaisFileBackup(input: {
  rootDir: string;
  now?: Date;
}): Promise<AaisBackupManifest> {
  const sessionsDir = getSessionsDir(input.rootDir);
  const files = await readSessionFiles(sessionsDir);
  const sessions = await Promise.all(
    files.map(async (fileName) => {
      const raw = await readFile(path.join(sessionsDir, fileName), "utf8");
      const payload = JSON.parse(raw) as AaisLearnerSession;
      const studentId = requireBackupSafeStudentId(payload.studentId);
      return {
        studentId,
        sha256: checksumSession(payload),
        payload,
      };
    }),
  );
  const sortedSessions = sessions.sort((left, right) => left.studentId.localeCompare(right.studentId));
  return {
    schemaVersion: 1,
    generatedAt: (input.now ?? new Date()).toISOString(),
    sessionCount: sortedSessions.length,
    sessions: sortedSessions,
    redaction: {
      secrets: "omitted",
    },
  };
}

export async function restoreAaisFileBackup(input: {
  rootDir: string;
  manifest: AaisBackupManifest;
}) {
  if (input.manifest.schemaVersion !== 1) {
    throw new Error("Unsupported AAIS backup schema.");
  }
  const sessionsDir = getSessionsDir(input.rootDir);
  await mkdir(sessionsDir, { recursive: true });
  for (const entry of input.manifest.sessions) {
    const studentId = requireBackupSafeStudentId(entry.studentId);
    if (entry.payload.studentId !== studentId || checksumSession(entry.payload) !== entry.sha256) {
      throw new Error("AAIS backup checksum mismatch.");
    }
    const target = path.join(sessionsDir, `${studentId}.json`);
    const tempPath = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(entry.payload, null, 2)}\n`, "utf8");
    await rename(tempPath, target);
  }
  return {
    restoredSessions: input.manifest.sessions.length,
    redaction: {
      secrets: "omitted" as const,
    },
  };
}

async function readSessionFiles(sessionsDir: string) {
  try {
    const files = await readdir(sessionsDir);
    return files.filter((fileName) => fileName.endsWith(".json")).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function getSessionsDir(rootDir: string) {
  return path.join(rootDir, "sessions");
}

function checksumSession(session: AaisLearnerSession) {
  return createHash("sha256")
    .update(JSON.stringify(session))
    .digest("hex");
}

function requireBackupSafeStudentId(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error("Invalid AAIS backup student id.");
  }
  return value;
}
