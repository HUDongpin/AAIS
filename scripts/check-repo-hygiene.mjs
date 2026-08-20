#!/usr/bin/env node

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

const localPrivateArtifacts = [
  ".env",
  ".env.local",
  ".env.production.local",
  ".env.postgres-restore.local",
  ".env.enterprise-smoke.local",
  "All API Keys.docx",
  "output/",
  "output/aais-private-env-template-latest.env",
  "output/aais-postgres-restore-template-latest.env",
  "output/aais-enterprise-gap-template-latest.env",
];

export async function runAaisRepoHygieneCheck(input = {}) {
  const cwd = input.cwd ?? process.cwd();
  const checkedAt = new Date().toISOString();
  const issues = [];
  const git = input.git ?? ((args) => runGit(args, cwd));
  const fileExists = input.fileExists ?? ((relativePath) => pathExists(path.join(cwd, relativePath)));

  const gitRoot = await git(["rev-parse", "--show-toplevel"]).catch(() => "");
  if (!String(gitRoot).trim()) {
    return {
      schemaVersion: 1,
      status: "failed",
      checkedAt,
      checks: {
        git: {
          repository: "missing",
        },
      },
      issues: ["AAIS_GIT_REPOSITORY_MISSING"],
      redaction: redactionSummary(),
    };
  }

  const remoteOutput = await git(["remote", "-v"]);
  const remotes = parseRemoteOutput(remoteOutput);
  if (remotes.length === 0) {
    issues.push("AAIS_GIT_REMOTE_MISSING");
  }

  const branch = normalizeOptionalText(await git(["branch", "--show-current"]).catch(() => ""));
  const statusOutput = await git(["status", "--short"]);
  const dirtySummary = summarizeGitStatus(statusOutput);
  if (dirtySummary.total > 0 && !input.allowDirty) {
    issues.push("AAIS_WORKTREE_DIRTY");
  }

  const stagedFiles = splitLines(await git(["diff", "--cached", "--name-only"]).catch(() => ""));
  const stagedForbidden = stagedFiles.filter(isForbiddenSourcePath);
  if (stagedForbidden.length > 0) {
    issues.push("AAIS_FORBIDDEN_FILES_STAGED");
  }

  const presentArtifacts = [];
  for (const artifact of localPrivateArtifacts) {
    if (await fileExists(artifact)) {
      presentArtifacts.push(artifact);
    }
  }
  if (presentArtifacts.length > 0 && !input.allowLocalPrivateArtifacts) {
    issues.push("AAIS_LOCAL_PRIVATE_ARTIFACTS_PRESENT");
  }

  return {
    schemaVersion: 1,
    status: issues.length ? "failed" : "passed",
    checkedAt,
    checks: {
      git: {
        repository: "present",
        branch,
        remotes,
        remoteConfigured: remotes.length > 0,
        dirty: dirtySummary,
        stagedForbidden,
      },
      localPrivateArtifacts: {
        presentCount: presentArtifacts.length,
        present: presentArtifacts,
      },
    },
    issues,
    redaction: redactionSummary(),
  };
}

export function parseRemoteOutput(output) {
  const names = new Set();
  for (const line of splitLines(output)) {
    const match = /^([^\s]+)\s+/.exec(line);
    if (match?.[1]) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
}

export function summarizeGitStatus(output) {
  const lines = splitLines(output);
  return {
    total: lines.length,
    staged: lines.filter((line) => line[0] && line[0] !== " " && line[0] !== "?").length,
    unstaged: lines.filter((line) => line[1] && line[1] !== " ").length,
    untracked: lines.filter((line) => line.startsWith("??")).length,
    deleted: lines.filter((line) => line.includes("D")).length,
  };
}

export function isForbiddenSourcePath(filePath) {
  const normalized = String(filePath ?? "").replace(/\\/g, "/").replace(/^\.?\//, "");
  if (!normalized || normalized === ".env.example") {
    return false;
  }
  if (
    normalized === "All API Keys.docx"
    || (!normalized.includes("/") && /\.docx$/i.test(normalized))
  ) {
    return true;
  }
  if (normalized === ".env" || normalized.startsWith(".env.")) {
    return true;
  }
  if (normalized.startsWith("output/")) {
    return true;
  }
  return false;
}

async function runGit(args, cwd) {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return result.stdout;
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function splitLines(output) {
  return String(output ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function normalizeOptionalText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function redactionSummary() {
  return {
    secrets: "omitted",
    credentialValues: "not-read",
    envValues: "not-read",
    databaseUrls: "not-read",
  };
}

function parseArgs(argv) {
  const input = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-dirty") {
      input.allowDirty = true;
    } else if (arg === "--allow-local-private-artifacts") {
      input.allowLocalPrivateArtifacts = true;
    } else if (arg === "--output") {
      input.outputPath = argv[index + 1];
      index += 1;
    } else if (arg === "--help") {
      input.help = true;
    } else {
      throw new Error(`Unknown AAIS repo hygiene argument: ${arg}`);
    }
  }
  return input;
}

function printHelp() {
  console.log([
    "Usage: npm run hygiene:check -- [--allow-dirty] [--allow-local-private-artifacts] [--output <report.json>]",
    "",
    "Checks AAIS source hygiene without reading secret values:",
    "  - Git repository and remote presence",
    "  - dirty worktree counts",
    "  - forbidden staged files such as .env*, output/, and root-level owner DOCX files",
    "  - local private artifact presence by path only",
  ].join("\n"));
}

async function writeReportIfRequested(report, outputPath) {
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const report = await writeReportIfRequested(
    await runAaisRepoHygieneCheck(args),
    args.outputPath,
  );
  console.log(JSON.stringify({
    status: report.status,
    issues: report.issues,
    remoteConfigured: report.checks.git?.remoteConfigured ?? false,
    dirtyCount: report.checks.git?.dirty?.total ?? null,
    localPrivateArtifactCount: report.checks.localPrivateArtifacts?.presentCount ?? null,
    secrets: "redacted",
  }));
  if (report.status !== "passed") {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`AAIS repo hygiene check failed: ${error.message}`);
    process.exitCode = 1;
  });
}
