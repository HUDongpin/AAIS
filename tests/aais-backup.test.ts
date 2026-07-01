import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAaisFileBackup,
  restoreAaisFileBackup,
} from "@/lib/server/aais-backup";
import { createAaisLearningStore } from "@/lib/server/aais-learning-store";

let sourceDir: string;
let restoreDir: string;

beforeEach(async () => {
  sourceDir = await mkdtemp(path.join(tmpdir(), "aais-backup-source-"));
  restoreDir = await mkdtemp(path.join(tmpdir(), "aais-backup-restore-"));
});

afterEach(async () => {
  await rm(sourceDir, { force: true, recursive: true });
  await rm(restoreDir, { force: true, recursive: true });
});

describe("AAIS file backup operations", () => {
  it("creates a verifiable backup manifest and restores learner sessions", async () => {
    const sourceStore = createAaisLearningStore({ rootDir: sourceDir });
    await sourceStore.getOrCreateSession("S001");
    await sourceStore.saveArtifact("S001", "training_task_1", "企业备份演练记录");

    const manifest = await createAaisFileBackup({
      rootDir: sourceDir,
      now: new Date("2026-06-30T01:00:00.000Z"),
    });

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      generatedAt: "2026-06-30T01:00:00.000Z",
      sessionCount: 1,
      redaction: {
        secrets: "omitted",
      },
    });
    expect(manifest.sessions[0]).toMatchObject({
      studentId: "S001",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const restored = await restoreAaisFileBackup({
      rootDir: restoreDir,
      manifest,
    });
    const restoredStore = createAaisLearningStore({ rootDir: restoreDir });
    const session = await restoredStore.getOrCreateSession("S001");

    expect(restored).toEqual({
      restoredSessions: 1,
      redaction: {
        secrets: "omitted",
      },
    });
    expect(session.tasks[0].artifactText).toBe("企业备份演练记录");
  });

  it("rejects backup manifests whose session checksum has been tampered with", async () => {
    const sourceStore = createAaisLearningStore({ rootDir: sourceDir });
    await sourceStore.getOrCreateSession("S001");
    const manifest = await createAaisFileBackup({ rootDir: sourceDir });
    manifest.sessions[0].payload.activeStage = "tampered";

    await expect(restoreAaisFileBackup({
      rootDir: restoreDir,
      manifest,
    })).rejects.toThrow("AAIS backup checksum mismatch");
  });
});
