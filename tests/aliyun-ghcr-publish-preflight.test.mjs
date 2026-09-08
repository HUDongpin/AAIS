import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { verifyAaisGhcrResumeProof } from "../scripts/verify-aais-ghcr-source.mjs";

const sha = "a".repeat(40);
const packageInfo = { visibility: "private", repository: { full_name: "HUDongpin/AAIS" } };
const digest = `sha256:${"b".repeat(64)}`;
const version = (tags = [], name = digest) => ({ name, metadata: { container: { tags } } });
const workflow = readFileSync(".github/workflows/ghcr-container.yml", "utf8");
const step = workflow.split("      - name: Verify private package and refuse an existing SHA tag\n")[1]
  .split("\n      - name:")[0];
const script = step.split("        run: |\n")[1].split("\n")
  .map((line) => line.replace(/^ {10}/, "")).join("\n");

function runPreflight(responses, overrides = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "aais-ghcr-preflight-"));
  try {
    const bin = path.join(directory, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(directory, "responses.json"), JSON.stringify(responses));
    writeFileSync(path.join(directory, "calls.json"), "[]");
    writeFileSync(path.join(bin, "curl"), `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.AAIS_TEST_RESPONSES;
const callsFile = path.join(root, "calls.json");
const calls = fs.existsSync(callsFile) ? JSON.parse(fs.readFileSync(callsFile)) : [];
const responses = JSON.parse(fs.readFileSync(path.join(root, "responses.json")));
const response = responses[calls.length] ?? { status: 500, body: {} };
calls.push(process.argv.at(-1));
fs.writeFileSync(callsFile, JSON.stringify(calls));
fs.writeFileSync(process.argv[process.argv.indexOf("--output") + 1], JSON.stringify(response.body));
process.stdout.write(String(response.status));
`, { mode: 0o700 });
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        AAIS_TEST_RESPONSES: directory,
        RUNNER_TEMP: directory,
        GITHUB_REPOSITORY: "HUDongpin/AAIS",
        GITHUB_SHA: sha,
        GH_TOKEN: "synthetic-test-token",
        GHCR_PACKAGE_API: "https://api.github.com/users/HUDongpin/packages/container/aais",
        AAIS_RESUME_DIGEST: "",
        AAIS_RESUME_RUN_ID: "",
        AAIS_RESUME_RUN_ATTEMPT: "",
        ...overrides,
      },
      timeout: 10_000,
    });
    const calls = JSON.parse(readFileSync(path.join(directory, "calls.json"), "utf8"));
    return { ...result, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("actual GHCR publication preflight shell", () => {
  it("permits the first package and rejects ambiguous package access failures", () => {
    expect(runPreflight([{ status: 404, body: {} }]).status).toBe(0);
    expect(runPreflight([{ status: 403, body: {} }]).status).not.toBe(0);
  });

  it("requires the existing package to be private and bound to AAIS", () => {
    for (const body of [
      { ...packageInfo, visibility: "public" },
      { ...packageInfo, repository: { full_name: "HUDongpin/another-repo" } },
    ]) expect(runPreflight([{ status: 200, body }]).status).not.toBe(0);
  });

  it("allows a new SHA only after complete version inspection", () => {
    const result = runPreflight([
      { status: 200, body: packageInfo },
      { status: 200, body: [version(["b".repeat(40)])] },
    ]);
    expect(result.status).toBe(0);
    expect(result.calls.at(-1)).toContain("/versions?per_page=100&page=1");
  });

  it("rejects an existing SHA tag, including one beyond the first page", () => {
    for (const pages of [[version([sha])], Array.from({ length: 100 }, () => version())]) {
      const result = runPreflight([
        { status: 200, body: packageInfo },
        { status: 200, body: pages },
        { status: 200, body: [version([sha])] },
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("AAIS_GHCR_SHA_TAG_ALREADY_EXISTS");
      expect(result.stdout + result.stderr).not.toContain("synthetic-test-token");
    }
  });

  it("fails closed on unreadable or malformed version pages", () => {
    for (const response of [
      { status: 403, body: {} },
      { status: 404, body: {} },
      { status: 200, body: { error: "not an array" } },
      { status: 200, body: [{ metadata: { container: { tags: null } } }] },
    ]) {
      expect(runPreflight([{ status: 200, body: packageInfo }, response]).status).not.toBe(0);
    }
  });

  it("requires an exact existing digest and complete recovery inputs before resuming", () => {
    const recovery = { AAIS_RESUME_DIGEST: digest, AAIS_RESUME_RUN_ID: "1001", AAIS_RESUME_RUN_ATTEMPT: "1" };
    const responses = [{ status: 200, body: packageInfo }, { status: 200, body: [version([sha])] }];
    expect(runPreflight(responses, recovery).status).toBe(0);
    expect(runPreflight(responses, { ...recovery, AAIS_RESUME_DIGEST: `sha256:${"c".repeat(64)}` }).status).not.toBe(0);
    const incomplete = runPreflight(responses, { ...recovery, AAIS_RESUME_RUN_ID: "" });
    expect(incomplete.status).not.toBe(0);
    expect(incomplete.calls).toEqual([]);
    expect(runPreflight([{ status: 404, body: {} }], recovery).status).not.toBe(0);
  });
});

function buildProof() {
  const runId = "1001";
  const runAttempt = "1";
  const record = { schemaVersion: 1, gitSha: sha, imageDigest: digest,
    imageRepository: "ghcr.io/hudongpin/aais", runId, runAttempt };
  return {
    expectedSha: sha, digest, runId, runAttempt,
    run: { id: 1001, run_attempt: 1, repository: { full_name: "HUDongpin/AAIS" },
      head_sha: sha, head_branch: "codex/aais-aliyun-postgres-empty",
      path: ".github/workflows/ghcr-container.yml", event: "workflow_dispatch", status: "completed" },
    jobs: { total_count: 1, jobs: [{ name: "Publish immutable private GHCR image", run_id: 1001,
      run_attempt: 1, head_sha: sha, status: "completed", conclusion: "failure",
      steps: ["Record immutable source metadata", "Build and push the exact-SHA image with OCI attestations",
        "Record immutable build output"].map((name) => ({ name, conclusion: "success" })) }] },
    log: `2026-09-08T06:00:00.0000000Z AAIS_GHCR_BUILD_OUTPUT=${JSON.stringify(record)}\n`,
  };
}

describe("recovery from provider-recorded build output", () => {
  it("accepts a proved build even when a later publication step failed", () => {
    expect(verifyAaisGhcrResumeProof(buildProof())).toEqual({ status: "verified", digest,
      buildRunId: "1001", buildRunAttempt: "1" });
  });

  it("rejects a different source, digest, run, repository, workflow, or attempt", () => {
    for (const change of [
      (p) => { p.run.head_sha = "c".repeat(40); },
      (p) => { p.digest = `sha256:${"c".repeat(64)}`; },
      (p) => { p.run.id = 1002; },
      (p) => { p.run.repository.full_name = "HUDongpin/other"; },
      (p) => { p.run.head_branch = "main"; },
      (p) => { p.run.path = ".github/workflows/other.yml"; },
      (p) => { p.run.event = "pull_request"; },
      (p) => { p.run.run_attempt = 2; },
      (p) => { p.run.status = "in_progress"; },
      (p) => { p.jobs.jobs[0].head_sha = "c".repeat(40); },
      (p) => { p.jobs.jobs[0].run_id = 1002; },
      (p) => { p.jobs.jobs[0].run_attempt = 2; },
    ]) {
      const proof = buildProof(); change(proof);
      expect(() => verifyAaisGhcrResumeProof(proof)).toThrow("AAIS_GHCR_RESUME_PROOF_REJECTED");
    }
  });

  it("rejects an incomplete job list, failed build, or untrusted log marker", () => {
    for (const change of [
      (p) => { p.jobs.total_count = 2; },
      (p) => { p.jobs.jobs.push(structuredClone(p.jobs.jobs[0])); p.jobs.total_count = 2; },
      (p) => { p.jobs.jobs[0].steps[1].conclusion = "failure"; },
      (p) => { p.jobs.jobs[0].steps.pop(); },
      (p) => { p.log += p.log; },
      (p) => { p.log = p.log.replace("AAIS_GHCR_BUILD_OUTPUT=", "echo AAIS_GHCR_BUILD_OUTPUT="); },
      (p) => { p.log = p.log.replace(sha, "c".repeat(40)); },
      (p) => { p.log = ""; },
    ]) {
      const proof = buildProof(); change(proof);
      expect(() => verifyAaisGhcrResumeProof(proof)).toThrow("AAIS_GHCR_RESUME_PROOF_REJECTED");
    }
  });
});
