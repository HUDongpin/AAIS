import { describe, expect, it } from "vitest";
import {
  isForbiddenSourcePath,
  parseRemoteOutput,
  runAaisRepoHygieneCheck,
  summarizeGitStatus,
} from "../scripts/check-repo-hygiene.mjs";

describe("AAIS repo hygiene check", () => {
  it("passes for a clean source checkout with a configured remote", async () => {
    const report = await runAaisRepoHygieneCheck({
      git: createFakeGit({
        remotes: "origin\tgit@github.com:owner/aais.git (fetch)\norigin\tgit@github.com:owner/aais.git (push)\n",
        status: "",
        staged: "",
      }),
      fileExists: async () => false,
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "passed",
      checks: {
        git: {
          repository: "present",
          branch: "main",
          remotes: ["origin"],
          remoteConfigured: true,
          dirty: {
            total: 0,
          },
          stagedForbidden: [],
        },
        localPrivateArtifacts: {
          presentCount: 0,
          present: [],
        },
      },
      issues: [],
      redaction: {
        secrets: "omitted",
        credentialValues: "not-read",
        envValues: "not-read",
        databaseUrls: "not-read",
      },
    });
  });

  it("fails closed for missing remote, dirty worktree, forbidden staged files, and local private artifacts", async () => {
    const report = await runAaisRepoHygieneCheck({
      git: createFakeGit({
        remotes: "",
        status: [
          " M src/app/page.tsx",
          "A  .env.production.local",
          "?? output/private-report.json",
          " D scripts/legacy.mjs",
        ].join("\n"),
        staged: [
          ".env.production.local",
          ".env.example",
          "output/private-report.json",
          "All API Keys.docx",
        ].join("\n"),
      }),
      fileExists: async (relativePath) =>
        relativePath === "All API Keys.docx" || relativePath === ".env.production.local",
    });

    expect(report.status).toBe("failed");
    expect(report.issues).toEqual([
      "AAIS_GIT_REMOTE_MISSING",
      "AAIS_WORKTREE_DIRTY",
      "AAIS_FORBIDDEN_FILES_STAGED",
      "AAIS_LOCAL_PRIVATE_ARTIFACTS_PRESENT",
    ]);
    expect(report.checks.git.dirty).toMatchObject({
      total: 4,
      staged: 1,
      unstaged: 3,
      untracked: 1,
      deleted: 1,
    });
    expect(report.checks.git.stagedForbidden).toEqual([
      ".env.production.local",
      "output/private-report.json",
      "All API Keys.docx",
    ]);
    expect(report.checks.localPrivateArtifacts.present).toEqual([
      ".env.production.local",
      "All API Keys.docx",
    ]);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("postgres://");
  });

  it("allows explicit dirty and local private artifact exceptions for local inventory runs", async () => {
    const report = await runAaisRepoHygieneCheck({
      allowDirty: true,
      allowLocalPrivateArtifacts: true,
      git: createFakeGit({
        remotes: "origin\thttps://github.com/owner/aais.git (fetch)\n",
        status: " M README.md",
        staged: "",
      }),
      fileExists: async (relativePath) => relativePath === ".env.local",
    });

    expect(report.status).toBe("passed");
    expect(report.issues).toEqual([]);
    expect(report.checks.git.dirty.total).toBe(1);
    expect(report.checks.localPrivateArtifacts.present).toEqual([".env.local"]);
  });

  it("parses remote names, status counts, and forbidden source paths", () => {
    expect(parseRemoteOutput([
      "origin\tgit@github.com:owner/aais.git (fetch)",
      "origin\tgit@github.com:owner/aais.git (push)",
      "backup\tssh://example/aais.git (fetch)",
    ].join("\n"))).toEqual(["backup", "origin"]);
    expect(summarizeGitStatus([
      " M file-a.ts",
      "A  file-b.ts",
      "?? file-c.ts",
      " D file-d.ts",
    ].join("\n"))).toEqual({
      total: 4,
      staged: 1,
      unstaged: 3,
      untracked: 1,
      deleted: 1,
    });
    expect(isForbiddenSourcePath(".env.example")).toBe(false);
    expect(isForbiddenSourcePath(".env.local")).toBe(true);
    expect(isForbiddenSourcePath("output/report.json")).toBe(true);
    expect(isForbiddenSourcePath("All API Keys.docx")).toBe(true);
  });
});

function createFakeGit(input) {
  return async (args) => {
    const command = args.join(" ");
    if (command === "rev-parse --show-toplevel") {
      return "/repo\n";
    }
    if (command === "remote -v") {
      return input.remotes;
    }
    if (command === "branch --show-current") {
      return "main\n";
    }
    if (command === "status --short") {
      return input.status;
    }
    if (command === "diff --cached --name-only") {
      return input.staged;
    }
    throw new Error(`Unexpected git command ${command}`);
  };
}
