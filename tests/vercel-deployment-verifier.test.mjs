import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyAaisVercelDeployment } from "../scripts/verify-vercel-deployment.mjs";

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-vercel-deployment-"));
});

afterEach(async () => {
  await rm(tempDir, { force: true, recursive: true });
});

describe("AAIS Vercel deployment verifier", () => {
  it("writes a redacted READY production deployment report from Vercel inspect JSON", async () => {
    const outputPath = path.join(tempDir, "vercel-deployment.json");

    const report = await verifyAaisVercelDeployment({
      deploymentUrl: "https://www.aais.site",
      releaseId: "aais-2026-06-30-rc1",
      inspectJson: JSON.stringify({
        url: "aais-live.vercel.app",
        aliases: ["www.aais.site"],
        readyState: "READY",
        target: "production",
        meta: {
          githubCommitSha: "0123456789abcdef0123456789abcdef01234567",
        },
      }),
      outputPath,
      now: new Date("2026-07-01T01:00:00.000Z"),
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "passed",
      checkedAt: "2026-07-01T01:00:00.000Z",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      deployment: {
        url: "https://aais-live.vercel.app",
        expectedUrl: "https://www.aais.site",
        urlMatchesExpected: true,
        aliases: ["https://www.aais.site"],
        readyState: "READY",
        target: "production",
        targetMatchesProduction: true,
        gitCommitShortSha: "0123456789ab",
        gitCommitSource: "vercel-inspect",
      },
      inspect: {
        source: "inline-json",
        parsed: true,
        errorCategory: null,
        secretScan: {
          status: "passed",
        },
      },
      redaction: {
        secrets: "omitted",
        rawInspectOutput: "not-stored",
        values: "summarized",
      },
    });
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(report);
  });

  it("fails while the inspected deployment is not READY", async () => {
    const report = await verifyAaisVercelDeployment({
      deploymentUrl: "https://www.aais.site",
      inspectJson: JSON.stringify({
        url: "www.aais.site",
        readyState: "BUILDING",
        target: "production",
      }),
      outputPath: path.join(tempDir, "building.json"),
    });

    expect(report.status).toBe("failed");
    expect(report.deployment).toMatchObject({
      readyState: "BUILDING",
      urlMatchesExpected: true,
      targetMatchesProduction: true,
    });
  });

  it("fails when the inspected deployment is not tied to a git commit", async () => {
    const report = await verifyAaisVercelDeployment({
      deploymentUrl: "https://www.aais.site",
      inspectJson: JSON.stringify({
        url: "www.aais.site",
        readyState: "READY",
        target: "production",
      }),
      outputPath: path.join(tempDir, "missing-commit.json"),
    });

    expect(report.status).toBe("failed");
    expect(report.deployment).toMatchObject({
      readyState: "READY",
      urlMatchesExpected: true,
      targetMatchesProduction: true,
      gitCommitShortSha: null,
    });
  });

  it("uses an explicit deployment git commit for CLI deployments without Vercel git metadata", async () => {
    const report = await verifyAaisVercelDeployment({
      deploymentUrl: "https://www.aais.site",
      deploymentGitCommit: "fedcba9876543210fedcba9876543210fedcba98",
      inspectJson: JSON.stringify({
        url: "www.aais.site",
        readyState: "READY",
        target: "production",
      }),
      outputPath: path.join(tempDir, "explicit-commit.json"),
    });

    expect(report).toMatchObject({
      status: "passed",
      deployment: {
        readyState: "READY",
        urlMatchesExpected: true,
        targetMatchesProduction: true,
        gitCommitShortSha: "fedcba987654",
        gitCommitSource: "AAIS_DEPLOYMENT_GIT_COMMIT_SHA",
      },
    });
  });

  it("does not write raw inspect output or secret-like values to the report", async () => {
    const report = await verifyAaisVercelDeployment({
      deploymentUrl: "https://www.aais.site",
      inspectJson: JSON.stringify({
        url: "www.aais.site",
        readyState: "READY",
        target: "production",
        env: {
          DATABASE_URL: "postgres://user:database-secret@example.neon.tech/aais",
        },
      }),
      outputPath: path.join(tempDir, "secret-scan.json"),
    });

    const serialized = JSON.stringify(report);
    expect(report.status).toBe("failed");
    expect(report.inspect.secretScan).toMatchObject({
      status: "failed",
      issue: "postgres-url-with-password",
    });
    expect(serialized).not.toContain("database-secret");
    expect(serialized).not.toContain("DATABASE_URL");
  });
});
