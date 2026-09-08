import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const sha = "a".repeat(40);
const packageInfo = { visibility: "private", repository: { full_name: "HUDongpin/AAIS" } };
const version = (tags = []) => ({ metadata: { container: { tags } } });
const workflow = readFileSync(".github/workflows/ghcr-container.yml", "utf8");
const step = workflow.split("      - name: Verify private package and refuse an existing SHA tag\n")[1]
  .split("\n      - name:")[0];
const script = step.split("        run: |\n")[1].split("\n")
  .map((line) => line.replace(/^ {10}/, "")).join("\n");

function runPreflight(responses) {
  const directory = mkdtempSync(path.join(tmpdir(), "aais-ghcr-preflight-"));
  try {
    const bin = path.join(directory, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(directory, "responses.json"), JSON.stringify(responses));
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
});
