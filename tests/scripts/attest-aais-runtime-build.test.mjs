import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  createAaisRuntimeBuildAttestation,
} from "../../scripts/attest-aais-runtime-build.mjs";
import {
  readRuntimeBuildAttestation,
} from "../../scripts/reconcile-aais-browser-rehearsal.mjs";

const execFileAsync = promisify(execFile);
const scope = {
  projectId: "aais",
  studyId: "runtime-attestation-test",
  environment: "research",
  lrsNamespace:
    "https://www.aais.site/xapi/studies/runtime-attestation-test/research/v1",
};

describe("AAIS production runtime attestation", () => {
  it("binds a fresh production bundle to a clean full Git HEAD and study scope", async () => {
    const repository = await createRepository();
    const first = await createAaisRuntimeBuildAttestation({
      cwd: repository.root,
      output: "evidence/runtime-first.json",
      expectedCommit: repository.head,
      ...scope,
      build: createFakeProductionBuild("bundle-content-v1"),
      now: () => new Date("2026-07-30T10:00:00.000Z"),
    });
    const second = await createAaisRuntimeBuildAttestation({
      cwd: repository.root,
      output: "evidence/runtime-second.json",
      expectedCommit: repository.head,
      ...scope,
      build: createFakeProductionBuild("bundle-content-v1"),
      now: () => new Date("2026-07-30T10:01:00.000Z"),
    });

    expect(first).toMatchObject({
      evidence_schema_version: 2,
      attestation_type: "aais-runtime-build",
      application_mode: "production-build",
      commit_sha: repository.head,
      runtime_build_id: "test-build-id",
      runtime_bundle_scope: "next-production-runtime-v1",
      runtime_bundle_algorithm: "sha256-canonical-file-manifest-v1",
    });
    expect(first.runtime_bundle_entry_count).toBeGreaterThan(2);
    expect(first.runtime_bundle_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(second.runtime_bundle_sha256).toBe(first.runtime_bundle_sha256);
    expect((await stat(path.join(
      repository.root,
      "evidence/runtime-first.json",
    ))).mode & 0o777).toBe(0o600);

    const manifest = {
      project_id: scope.projectId,
      study_id: scope.studyId,
      environment: scope.environment,
      lrs_namespace: scope.lrsNamespace,
    };
    const read = await readRuntimeBuildAttestation(
      path.join(repository.root, "evidence/runtime-first.json"),
      manifest,
    );
    expect(read).toMatchObject({
      commit_sha: repository.head,
      runtime_bundle_sha256: first.runtime_bundle_sha256,
    });
    expect(read.attestationSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes the runtime digest when bundle content or declared scope changes", async () => {
    const repository = await createRepository();
    const first = await createAaisRuntimeBuildAttestation({
      cwd: repository.root,
      output: "evidence/content-one.json",
      expectedCommit: repository.head,
      ...scope,
      build: createFakeProductionBuild("bundle-one"),
    });
    const contentChanged = await createAaisRuntimeBuildAttestation({
      cwd: repository.root,
      output: "evidence/content-two.json",
      expectedCommit: repository.head,
      ...scope,
      build: createFakeProductionBuild("bundle-two"),
    });
    const scopeChanged = await createAaisRuntimeBuildAttestation({
      cwd: repository.root,
      output: "evidence/scope-two.json",
      expectedCommit: repository.head,
      ...scope,
      studyId: "runtime-attestation-other-study",
      lrsNamespace:
        "https://www.aais.site/xapi/studies/runtime-attestation-other-study/research/v1",
      build: createFakeProductionBuild("bundle-two"),
    });

    expect(contentChanged.runtime_bundle_sha256)
      .not.toBe(first.runtime_bundle_sha256);
    expect(scopeChanged.runtime_bundle_sha256)
      .not.toBe(contentChanged.runtime_bundle_sha256);
  });

  it("rejects a dirty tree, a mismatched commit, and a build that dirties tracked source", async () => {
    const dirty = await createRepository();
    await writeFile(path.join(dirty.root, "tracked.txt"), "changed\n");
    await expect(createAaisRuntimeBuildAttestation({
      cwd: dirty.root,
      output: "evidence/dirty.json",
      expectedCommit: dirty.head,
      ...scope,
      build: createFakeProductionBuild("never-built"),
    })).rejects.toThrow("rejected a dirty worktree");

    const mismatch = await createRepository();
    await expect(createAaisRuntimeBuildAttestation({
      cwd: mismatch.root,
      output: "evidence/mismatch.json",
      expectedCommit: "0".repeat(40),
      ...scope,
      build: createFakeProductionBuild("never-built"),
    })).rejects.toThrow("does not match Git HEAD");

    const buildDirty = await createRepository();
    await expect(createAaisRuntimeBuildAttestation({
      cwd: buildDirty.root,
      output: "evidence/build-dirty.json",
      expectedCommit: buildDirty.head,
      ...scope,
      build: async ({ cwd }) => {
        await createFakeProductionBuild("bundle")({ cwd });
        await writeFile(path.join(cwd, "tracked.txt"), "changed by build\n");
      },
    })).rejects.toThrow("after the production build and bundle hash");
  });

  it("rejects legacy or structurally weakened runtime attestations", async () => {
    const repository = await createRepository();
    const file = path.join(repository.root, "evidence/legacy.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({
      evidence_schema_version: 1,
      attestation_type: "aais-runtime-build",
      captured_at: "2026-07-30T10:00:00.000Z",
      application_mode: "production-build",
      project_id: scope.projectId,
      study_id: scope.studyId,
      environment: scope.environment,
      lrs_namespace: scope.lrsNamespace,
      commit_sha: repository.head.slice(0, 7),
      runtime_build_id: "unbound-build",
      runtime_bundle_sha256: "0".repeat(64),
    })}\n`);

    await expect(readRuntimeBuildAttestation(file, {
      project_id: scope.projectId,
      study_id: scope.studyId,
      environment: scope.environment,
      lrs_namespace: scope.lrsNamespace,
    })).rejects.toThrow("runtime build attestation is invalid");
  });
});

async function createRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aais-runtime-attestation-"));
  await writeFile(path.join(root, ".gitignore"), ".next/\nevidence/\n");
  await writeFile(path.join(root, "tracked.txt"), "committed\n");
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
  });
  await execFileAsync("git", ["config", "user.name", "AAIS Test"], { cwd: root });
  await execFileAsync("git", ["add", ".gitignore", "tracked.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root });
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  })).stdout.trim();
  return { root, head };
}

function createFakeProductionBuild(content) {
  return async ({ cwd }) => {
    await mkdir(path.join(cwd, ".next/server"), { recursive: true });
    await mkdir(path.join(cwd, ".next/static/chunks"), { recursive: true });
    await mkdir(path.join(cwd, ".next/cache"), { recursive: true });
    await writeFile(path.join(cwd, ".next/BUILD_ID"), "test-build-id");
    await writeFile(path.join(cwd, ".next/server/app.js"), content);
    await writeFile(path.join(cwd, ".next/static/chunks/app.js"), "static");
    await writeFile(path.join(cwd, ".next/build-manifest.json"), "{}");
    await writeFile(path.join(cwd, ".next/cache/ignored-cache"), `${Date.now()}`);
  };
}
