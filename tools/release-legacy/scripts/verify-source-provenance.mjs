#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaultOutputPath = "output/aais-source-provenance-latest.json";

export async function verifyAaisSourceProvenance(input = {}) {
  const checkedAt = (input.now ?? new Date()).toISOString();
  const cwd = input.cwd ?? process.cwd();
  const releaseId = readSafeReleaseId(input.releaseId ?? process.env.AAIS_RELEASE_ID);
  const runner = input.runner ?? runGit;
  const head = await readGitValue(runner, cwd, ["rev-parse", "HEAD"], "no-git-head");
  const branch = await readGitValue(runner, cwd, ["rev-parse", "--abbrev-ref", "HEAD"], "unknown-branch");
  const status = await readGitValue(
    runner,
    cwd,
    ["status", "--porcelain=v1"],
    "status-unavailable",
    { preserveWhitespace: true },
  );
  const gitCommitShortSha = readGitCommitShortSha(head.value);
  const workingTree = summarizePorcelainStatus(status.ok ? status.value : "");
  const headPresent = Boolean(gitCommitShortSha);
  const clean = headPresent && status.ok && workingTree.total === 0;
  const report = {
    schemaVersion: 1,
    status: clean ? "passed" : "failed",
    checkedAt,
    release: {
      id: releaseId,
    },
    source: {
      gitHeadPresent: headPresent,
      gitCommitShortSha,
      branch: readSafeBranch(branch.value),
      clean,
      workingTree,
      errorCategory: head.ok ? null : head.errorCategory,
    },
    redaction: {
      secrets: "omitted",
      fileNames: "not-included",
      gitStatus: "counts-only",
    },
  };

  const outputPath = input.outputPath ?? process.env.AAIS_SOURCE_PROVENANCE_REPORT_PATH ?? defaultOutputPath;
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  return report;
}

async function readGitValue(runner, cwd, args, errorCategory, options = {}) {
  try {
    const value = await runner(args, cwd);
    return {
      ok: true,
      value: options.preserveWhitespace ? String(value ?? "") : String(value ?? "").trim(),
      errorCategory: null,
    };
  } catch {
    return {
      ok: false,
      value: null,
      errorCategory,
    };
  }
}

async function runGit(args, cwd) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

function summarizePorcelainStatus(raw) {
  const lines = String(raw ?? "")
    .split(/\r?\n/)
    .filter(Boolean);
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of lines) {
    if (line.startsWith("??")) {
      untracked += 1;
      continue;
    }
    if (line[0] && line[0] !== " ") {
      staged += 1;
    }
    if (line[1] && line[1] !== " ") {
      unstaged += 1;
    }
  }
  return {
    total: lines.length,
    staged,
    unstaged,
    untracked,
  };
}

function readSafeReleaseId(value) {
  const trimmed = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(trimmed) ? trimmed : null;
}

function readGitCommitShortSha(value) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{7,40}$/.test(trimmed) ? trimmed.slice(0, 12) : null;
}

function readSafeBranch(value) {
  const trimmed = String(value ?? "").trim();
  return /^[A-Za-z0-9._/-]{1,127}$/.test(trimmed) ? trimmed : null;
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
  const report = await verifyAaisSourceProvenance({
    cwd: args.get("cwd"),
    releaseId: args.get("release-id"),
    outputPath: args.get("output"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "passed") {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS source provenance verification failed."}\n`);
    process.exitCode = 1;
  });
}
