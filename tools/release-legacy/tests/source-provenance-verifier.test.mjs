import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyAaisSourceProvenance } from "../scripts/verify-source-provenance.mjs";

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-source-provenance-"));
});

afterEach(async () => {
  await rm(tempDir, { force: true, recursive: true });
});

describe("AAIS source provenance verifier", () => {
  it("passes for a clean git HEAD without recording file names", async () => {
    const outputPath = path.join(tempDir, "source.json");
    const report = await verifyAaisSourceProvenance({
      releaseId: "aais-2026-06-30-rc1",
      outputPath,
      now: new Date("2026-07-01T02:00:00.000Z"),
      runner: async (args) => {
        const command = args.join(" ");
        if (command === "rev-parse HEAD") {
          return "0123456789abcdef0123456789abcdef01234567\n";
        }
        if (command === "rev-parse --abbrev-ref HEAD") {
          return "main\n";
        }
        if (command === "status --porcelain=v1") {
          return "";
        }
        throw new Error("unexpected git command");
      },
    });

    expect(report).toEqual({
      schemaVersion: 1,
      status: "passed",
      checkedAt: "2026-07-01T02:00:00.000Z",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      source: {
        gitHeadPresent: true,
        gitCommitShortSha: "0123456789ab",
        branch: "main",
        clean: true,
        workingTree: {
          total: 0,
          staged: 0,
          unstaged: 0,
          untracked: 0,
        },
        errorCategory: null,
      },
      redaction: {
        secrets: "omitted",
        fileNames: "not-included",
        gitStatus: "counts-only",
      },
    });
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(report);
  });

  it("fails with counts only when the worktree is dirty", async () => {
    const report = await verifyAaisSourceProvenance({
      releaseId: "aais-2026-06-30-rc1",
      outputPath: path.join(tempDir, "dirty.json"),
      runner: async (args) => {
        const command = args.join(" ");
        if (command === "rev-parse HEAD") {
          return "abcdef1234567890abcdef1234567890abcdef12\n";
        }
        if (command === "rev-parse --abbrev-ref HEAD") {
          return "release/aais\n";
        }
        if (command === "status --porcelain=v1") {
          return [
            " M src/app.ts",
            "A  scripts/new.mjs",
            "?? .env.production.local",
            "",
          ].join("\n");
        }
        throw new Error("unexpected git command");
      },
    });

    expect(report).toMatchObject({
      status: "failed",
      source: {
        gitHeadPresent: true,
        gitCommitShortSha: "abcdef123456",
        clean: false,
        workingTree: {
          total: 3,
          staged: 1,
          unstaged: 1,
          untracked: 1,
        },
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("src/app.ts");
    expect(serialized).not.toContain(".env.production.local");
  });

  it("fails safely when the repository has no HEAD commit", async () => {
    const report = await verifyAaisSourceProvenance({
      outputPath: path.join(tempDir, "no-head.json"),
      runner: async (args) => {
        const command = args.join(" ");
        if (command === "status --porcelain=v1") {
          return "?? package.json\n";
        }
        throw new Error("no git head");
      },
    });

    expect(report).toMatchObject({
      status: "failed",
      source: {
        gitHeadPresent: false,
        gitCommitShortSha: null,
        branch: null,
        clean: false,
        workingTree: {
          total: 1,
          staged: 0,
          unstaged: 0,
          untracked: 1,
        },
        errorCategory: "no-git-head",
      },
    });
    expect(JSON.stringify(report)).not.toContain("package.json");
  });
});
