#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const modulePath = import.meta.url.startsWith("file:")
  ? fileURLToPath(import.meta.url)
  : null;
const excludedRuntimeRoots = new Set(["cache", "dev", "diagnostics", "types"]);
const excludedRuntimeFiles = new Set(["trace", "trace-build"]);
const runtimeBundleScope = "next-production-runtime-v1";
const runtimeBundleAlgorithm = "sha256-canonical-file-manifest-v1";

if (isDirectInvocation()) {
  const options = readOptions(process.argv.slice(2));
  const result = await createAaisRuntimeBuildAttestation(options);
  process.stdout.write(`${JSON.stringify({
    status: "verified",
    commit_sha: result.commit_sha,
    runtime_build_id: result.runtime_build_id,
    runtime_bundle_sha256: result.runtime_bundle_sha256,
    output: options.output,
    secrets: "not-read",
  })}\n`);
}

export async function createAaisRuntimeBuildAttestation(input) {
  const cwd = await realpath(path.resolve(input.cwd ?? process.cwd()));
  const output = path.resolve(cwd, requireText(input.output, "output"));
  const scope = validateScope(input);
  const expectedCommit = requireCommitSha(input.expectedCommit);
  const git = input.git ?? ((args) => runGit(args, cwd));
  const build = input.build ?? (() => runProductionBuild(cwd));
  const now = input.now ?? (() => new Date());

  const gitRoot = await realpath(path.resolve(
    String(await git(["rev-parse", "--show-toplevel"])).trim(),
  ));
  if (gitRoot !== cwd) {
    throw new Error("AAIS runtime attestation must run from the Git repository root.");
  }
  await assertArtifactOutputIsIgnoredOrExternal(output, gitRoot, git);

  const headBefore = String(await git(["rev-parse", "HEAD"])).trim();
  if (headBefore !== expectedCommit) {
    throw new Error("AAIS runtime attestation expected commit does not match Git HEAD.");
  }
  await assertCleanWorktree(git, "before the production build");

  const buildStartedAt = Date.now();
  await build({ cwd });

  const buildIdPath = path.join(cwd, ".next", "BUILD_ID");
  const buildIdStat = await stat(buildIdPath).catch(() => null);
  if (!buildIdStat?.isFile() || buildIdStat.mtimeMs < buildStartedAt - 2_000) {
    throw new Error("AAIS runtime attestation requires a fresh production BUILD_ID.");
  }
  const runtimeBuildIdRaw = await readFile(buildIdPath, "utf8");
  const runtimeBuildId = runtimeBuildIdRaw.trim();
  if (runtimeBuildId !== runtimeBuildIdRaw
    || !/^[A-Za-z0-9._-]{1,128}$/.test(runtimeBuildId)) {
    throw new Error("AAIS production BUILD_ID is invalid.");
  }

  const runtime = await hashRuntimeBundle({
    cwd,
    scope,
    commitSha: expectedCommit,
    runtimeBuildId,
  });

  const headAfter = String(await git(["rev-parse", "HEAD"])).trim();
  if (headAfter !== expectedCommit) {
    throw new Error("AAIS Git HEAD changed while producing the runtime attestation.");
  }
  await assertCleanWorktree(git, "after the production build and bundle hash");

  const capturedAt = now().toISOString();
  if (Number.isNaN(new Date(capturedAt).getTime())) {
    throw new Error("AAIS runtime attestation capture time is invalid.");
  }
  const attestation = {
    evidence_schema_version: 2,
    attestation_type: "aais-runtime-build",
    captured_at: capturedAt,
    application_mode: "production-build",
    project_id: scope.projectId,
    study_id: scope.studyId,
    environment: scope.environment,
    lrs_namespace: scope.lrsNamespace,
    commit_sha: expectedCommit,
    runtime_build_id: runtimeBuildId,
    runtime_bundle_scope: runtimeBundleScope,
    runtime_bundle_algorithm: runtimeBundleAlgorithm,
    runtime_bundle_entry_count: runtime.entryCount,
    runtime_bundle_sha256: runtime.sha256,
  };
  await writeRestrictedJson(output, attestation);
  return attestation;
}

export async function hashRuntimeBundle(input) {
  const runtimeRoot = path.join(input.cwd, ".next");
  const entries = await collectRuntimeEntries(runtimeRoot);
  if (entries.length < 1 || !entries.some((entry) => entry.path === "BUILD_ID")) {
    throw new Error("AAIS production runtime bundle is empty or missing BUILD_ID.");
  }

  const digest = createHash("sha256");
  digest.update(`${JSON.stringify({
    algorithm: runtimeBundleAlgorithm,
    scope: runtimeBundleScope,
    project_id: input.scope.projectId,
    study_id: input.scope.studyId,
    environment: input.scope.environment,
    lrs_namespace: input.scope.lrsNamespace,
    commit_sha: input.commitSha,
    runtime_build_id: input.runtimeBuildId,
    entry_count: entries.length,
  })}\n`);
  for (const entry of entries) {
    digest.update(`${JSON.stringify(entry)}\n`);
  }
  return {
    entryCount: entries.length,
    sha256: digest.digest("hex"),
  };
}

async function collectRuntimeEntries(runtimeRoot) {
  const result = [];
  await walk("");
  return result.sort((left, right) => compareText(left.path, right.path));

  async function walk(relativeDirectory) {
    const absoluteDirectory = path.join(runtimeRoot, relativeDirectory);
    const children = await readdir(absoluteDirectory, { withFileTypes: true });
    children.sort((left, right) => compareText(left.name, right.name));
    for (const child of children) {
      const relativePath = path.posix.join(
        relativeDirectory.split(path.sep).join(path.posix.sep),
        child.name,
      );
      const rootName = relativePath.split("/")[0];
      if (excludedRuntimeRoots.has(rootName)
        || excludedRuntimeFiles.has(relativePath)) {
        continue;
      }
      const absolutePath = path.join(runtimeRoot, ...relativePath.split("/"));
      const metadata = await lstat(absolutePath);
      if (metadata.isDirectory()) {
        await walk(path.join(relativeDirectory, child.name));
      } else if (metadata.isFile()) {
        const bytes = await readFile(absolutePath);
        result.push({
          path: relativePath,
          type: "file",
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } else if (metadata.isSymbolicLink()) {
        const target = await readlink(absolutePath);
        result.push({
          path: relativePath,
          type: "symlink",
          target,
        });
      } else {
        throw new Error("AAIS production runtime contains an unsupported entry type.");
      }
    }
  }
}

function validateScope(input) {
  const projectId = requireText(input.projectId, "project-id");
  const studyId = requireText(input.studyId, "study-id");
  const environment = requireText(input.environment, "environment");
  const lrsNamespace = requireText(input.lrsNamespace, "lrs-namespace");
  if (projectId !== "aais"
    || !/^[A-Za-z0-9._-]{1,128}$/.test(studyId)
    || !["production", "staging", "research"].includes(environment)) {
    throw new Error("AAIS runtime attestation scope is invalid.");
  }
  const expectedNamespace = `https://www.aais.site/xapi/studies/${encodeURIComponent(
    studyId,
  )}/${environment}/v1`;
  if (lrsNamespace !== expectedNamespace) {
    throw new Error("AAIS runtime attestation namespace is not canonical.");
  }
  return { projectId, studyId, environment, lrsNamespace };
}

function requireCommitSha(value) {
  const commit = requireText(value, "expected-commit");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    throw new Error("AAIS runtime attestation requires a full Git commit SHA.");
  }
  return commit;
}

async function assertCleanWorktree(git, phase) {
  const status = String(await git([
    "status",
    "--porcelain",
    "--untracked-files=all",
  ])).trim();
  if (status) {
    const digest = createHash("sha256").update(status).digest("hex");
    const count = status.split(/\r?\n/).filter(Boolean).length;
    throw new Error(
      `AAIS runtime attestation rejected a dirty worktree ${phase} `
      + `(entries=${count}, status_sha256=${digest}).`,
    );
  }
}

async function assertArtifactOutputIsIgnoredOrExternal(output, gitRoot, git) {
  const relative = path.relative(gitRoot, output);
  if (!relative || relative === "."
    || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return;
  }
  try {
    await git(["check-ignore", "-q", "--", relative]);
  } catch {
    throw new Error(
      "AAIS runtime attestation output must be outside the repository or ignored by Git.",
    );
  }
}

async function writeRestrictedJson(filePath, value) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await chmod(filePath, 0o600);
}

async function runGit(args, cwd) {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout;
}

function runProductionBuild(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "build"], {
      cwd,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", () => {
      reject(new Error("AAIS production build could not be started."));
    });
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) {
        resolve();
      } else {
        reject(new Error("AAIS production build did not complete successfully."));
      }
    });
  });
}

function readOptions(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new Error("AAIS runtime attestation options are invalid.");
    }
    values.set(name, value);
  }
  const allowed = new Set([
    "--output",
    "--project-id",
    "--study-id",
    "--environment",
    "--lrs-namespace",
    "--expected-commit",
  ]);
  if ([...values.keys()].some((name) => !allowed.has(name))) {
    throw new Error("AAIS runtime attestation received an unknown option.");
  }
  return {
    output: requireText(values.get("--output"), "output"),
    projectId: requireText(values.get("--project-id"), "project-id"),
    studyId: requireText(values.get("--study-id"), "study-id"),
    environment: requireText(values.get("--environment"), "environment"),
    lrsNamespace: requireText(values.get("--lrs-namespace"), "lrs-namespace"),
    expectedCommit: requireText(values.get("--expected-commit"), "expected-commit"),
  };
}

function requireText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`AAIS runtime attestation requires ${name}.`);
  }
  return text;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isDirectInvocation() {
  return Boolean(modulePath && process.argv[1])
    && path.resolve(process.argv[1]) === modulePath;
}
