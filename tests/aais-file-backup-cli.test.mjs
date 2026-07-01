import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAaisFileBackupCommand } from "../scripts/manage-file-backup.mjs";

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-file-backup-cli-"));
});

afterEach(async () => {
  await rm(tempDir, { force: true, recursive: true });
});

describe("AAIS file backup CLI", () => {
  it("writes a private manifest and a redacted report, then restores verified sessions", async () => {
    const sourceRoot = path.join(tempDir, "source");
    const restoreRoot = path.join(tempDir, "restore");
    const manifestOutputPath = path.join(tempDir, "private-backup.json");
    const backupReportPath = path.join(tempDir, "backup-report.json");
    const restoreReportPath = path.join(tempDir, "restore-report.json");
    await writeSession(sourceRoot, {
      schemaVersion: 1,
      studentId: "S001",
      sessionId: "session-S001",
      createdAt: "2026-07-01T01:00:00.000Z",
      updatedAt: "2026-07-01T01:05:00.000Z",
      activeTaskId: "training_task_1",
      activeStage: "training",
      tasks: [
        {
          taskId: "training_task_1",
          phase: "training",
          status: "active",
          artifactText: "learner private artifact must stay out of report",
          selfReport: "",
          scaffoldRequests: 0,
          scaffoldHistory: [],
        },
      ],
      guideMessages: [],
      events: [],
    });

    const backupReport = await runAaisFileBackupCommand({
      action: "backup",
      rootDir: sourceRoot,
      manifestOutputPath,
      reportPath: backupReportPath,
      now: new Date("2026-07-01T02:00:00.000Z"),
    });

    expect(backupReport).toMatchObject({
      schemaVersion: 1,
      status: "passed",
      action: "backup",
      generatedAt: "2026-07-01T02:00:00.000Z",
      backup: {
        manifestPath: manifestOutputPath,
        sessionCount: 1,
        sessions: [
          {
            studentId: "S001",
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        ],
      },
      redaction: {
        secrets: "omitted",
        learnerPayloads: "manifest-private-not-in-report",
      },
    });
    const manifest = JSON.parse(await readFile(manifestOutputPath, "utf8"));
    expect(manifest.sessions[0].payload.tasks[0].artifactText).toBe("learner private artifact must stay out of report");
    expect(await readFile(backupReportPath, "utf8")).not.toContain("learner private artifact must stay out of report");

    const restoreReport = await runAaisFileBackupCommand({
      action: "restore",
      rootDir: restoreRoot,
      manifestPath: manifestOutputPath,
      reportPath: restoreReportPath,
    });

    expect(restoreReport).toMatchObject({
      status: "passed",
      action: "restore",
      backup: {
        manifestPath: manifestOutputPath,
        sessionCount: 1,
      },
      restore: {
        restoredSessions: 1,
      },
      redaction: {
        secrets: "omitted",
        learnerPayloads: "manifest-private-not-in-report",
      },
    });
    const restoredSession = JSON.parse(await readFile(path.join(restoreRoot, "sessions", "S001.json"), "utf8"));
    expect(restoredSession.tasks[0].artifactText).toBe("learner private artifact must stay out of report");
    expect(await readFile(restoreReportPath, "utf8")).not.toContain("learner private artifact must stay out of report");
  });

  it("fails closed when a backup manifest payload no longer matches its checksum", async () => {
    const sourceRoot = path.join(tempDir, "source");
    const restoreRoot = path.join(tempDir, "restore");
    const manifestOutputPath = path.join(tempDir, "private-backup.json");
    await writeSession(sourceRoot, {
      schemaVersion: 1,
      studentId: "S001",
      sessionId: "session-S001",
      createdAt: "2026-07-01T01:00:00.000Z",
      updatedAt: "2026-07-01T01:05:00.000Z",
      activeTaskId: "training_task_1",
      activeStage: "training",
      tasks: [],
      guideMessages: [],
      events: [],
    });
    await runAaisFileBackupCommand({
      action: "backup",
      rootDir: sourceRoot,
      manifestOutputPath,
      reportPath: path.join(tempDir, "backup-report.json"),
    });
    const manifest = JSON.parse(await readFile(manifestOutputPath, "utf8"));
    manifest.sessions[0].payload.activeStage = "tampered";
    await writeFile(manifestOutputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await expect(runAaisFileBackupCommand({
      action: "restore",
      rootDir: restoreRoot,
      manifestPath: manifestOutputPath,
      reportPath: path.join(tempDir, "restore-report.json"),
    })).rejects.toThrow("AAIS backup checksum mismatch");
  });

  it("exposes package scripts for controlled file backup operations", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));

    expect(packageJson.scripts["backup:file"]).toBe("node -- scripts/manage-file-backup.mjs backup");
    expect(packageJson.scripts["restore:file"]).toBe("node -- scripts/manage-file-backup.mjs restore");
  });
});

async function writeSession(rootDir, session) {
  const sessionsDir = path.join(rootDir, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(path.join(sessionsDir, `${session.studentId}.json`), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}
