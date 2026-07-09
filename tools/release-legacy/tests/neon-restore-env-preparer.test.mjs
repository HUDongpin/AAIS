import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareAaisNeonRestoreEnv } from "../scripts/prepare-neon-restore-env.mjs";

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-neon-restore-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tempDir, { force: true, recursive: true });
});

describe("AAIS Neon restore env preparer", () => {
  it("is exposed through the package script without using Node's own env-file parser", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));

    expect(packageJson.scripts["prepare:neon-restore"]).toBe(
      "node -- scripts/prepare-neon-restore-env.mjs",
    );
  });

  it("creates a restored staging branch, writes the restore env, and emits a redacted report", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (init.method === "POST" && url.endsWith("/projects/neon-project-123/branches")) {
        return jsonResponse({
          branch: {
            id: "br-restore-123",
            name: "aais-restore-rc1",
          },
        });
      }
      if (init.method === "GET" && url.includes("/projects/neon-project-123/connection_uri?")) {
        return jsonResponse({
          uri: "postgresql://restore-role:restore-secret@ep-restored.us-east-1.aws.neon.tech/aais_restore?sslmode=require",
        });
      }
      throw new Error(`unexpected request ${init.method} ${url}`);
    };
    const outputEnvPath = path.join(tempDir, "restore.env");
    const reportPath = path.join(tempDir, "report.json");

    const report = await prepareAaisNeonRestoreEnv({
      apiKey: "neon-api-secret",
      projectId: "neon-project-123",
      parentBranchId: "br-prod-123",
      parentTimestamp: "2026-07-01T08:00:00.000Z",
      branchName: "aais-restore-rc1",
      databaseName: "aais_restore",
      roleName: "restore_role",
      outputEnvPath,
      reportPath,
      releaseId: "aais-2026-06-30-rc1",
      now: new Date("2026-07-01T09:00:00.000Z"),
      fetchImpl,
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "ready",
      checkedAt: "2026-07-01T09:00:00.000Z",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      source: {
        provider: "neon-api",
        projectId: "redacted",
      },
      branch: {
        mode: "created",
        id: "redacted",
        name: "aais-restore-rc1",
        parentBranchId: "redacted",
        parentTimestamp: "2026-07-01T08:00:00.000Z",
      },
      connection: {
        databaseName: "aais_restore",
        roleName: "restore_role",
        pooled: true,
        uri: "written-redacted",
      },
      envFile: {
        path: outputEnvPath,
      },
      redaction: {
        secrets: "omitted",
        values: "connection-uri-written-not-output",
      },
    });
    const postBody = JSON.parse(calls[0].init.body);
    expect(postBody).toEqual({
      branch: {
        name: "aais-restore-rc1",
        parent_id: "br-prod-123",
        parent_timestamp: "2026-07-01T08:00:00.000Z",
      },
      endpoints: [
        {
          type: "read_write",
        },
      ],
    });
    const connectionUrl = new URL(calls[1].url);
    expect(connectionUrl.searchParams.get("branch_id")).toBe("br-restore-123");
    expect(connectionUrl.searchParams.get("database_name")).toBe("aais_restore");
    expect(connectionUrl.searchParams.get("role_name")).toBe("restore_role");
    expect(connectionUrl.searchParams.get("pooled")).toBe("true");

    const envText = await readFile(outputEnvPath, "utf8");
    expect(envText).toContain("AAIS_RESTORE_DATABASE_URL=postgresql://restore-role:restore-secret@ep-restored.us-east-1.aws.neon.tech/aais_restore?sslmode=require");
    expect(envText).toContain("AAIS_RESTORE_DATABASE_PROVIDER=neon");
    expect(envText).toContain("AAIS_RESTORE_TARGET_PURPOSE=restored-staging");
    expect(envText).toContain("AAIS_RESTORE_BRANCH_ID=br-restore-123");
    const reportText = await readFile(reportPath, "utf8");
    expect(JSON.parse(reportText)).toEqual(report);
    expect(JSON.stringify(report)).not.toContain("restore-secret");
    expect(JSON.stringify(report)).not.toContain("neon-api-secret");
    expect(JSON.stringify(report)).not.toContain("ep-restored.us-east-1.aws.neon.tech");
  });

  it("can use an existing restored branch without creating another branch", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        uri: "postgres://restore-role:restore-secret@ep-existing.us-east-1.aws.neon.tech/aais_restore",
      });
    };

    const report = await prepareAaisNeonRestoreEnv({
      apiKey: "neon-api-secret",
      projectId: "neon-project-123",
      existingBranchId: "br-existing-123",
      branchName: "aais-restore-existing",
      databaseName: "aais_restore",
      roleName: "restore_role",
      outputEnvPath: path.join(tempDir, "restore.env"),
      reportPath: path.join(tempDir, "report.json"),
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe("GET");
    expect(report.branch).toMatchObject({
      mode: "existing",
      id: "redacted",
      name: "aais-restore-existing",
    });
    expect(JSON.stringify(report)).not.toContain("restore-secret");
  });

  it("reads safe inputs from a private Neon env file without leaking values", async () => {
    const neonEnvFilePath = path.join(tempDir, "neon.env");
    await writeFile(neonEnvFilePath, [
      "NEON_API_KEY=neon-api-secret",
      "NEON_PROJECT_ID=neon-project-123",
      "NEON_RESTORE_BRANCH_ID=br-existing-123",
      "NEON_RESTORE_BRANCH_NAME=aais-restore-existing",
      "NEON_DATABASE_NAME=aais_restore",
      "NEON_ROLE_NAME=restore_role",
      "",
    ].join("\n"), "utf8");
    const report = await prepareAaisNeonRestoreEnv({
      neonEnvFilePath,
      outputEnvPath: path.join(tempDir, "restore.env"),
      reportPath: path.join(tempDir, "report.json"),
      fetchImpl: async () => jsonResponse({
        uri: "postgres://restore-role:restore-secret@ep-existing.us-east-1.aws.neon.tech/aais_restore",
      }),
    });

    expect(report.status).toBe("ready");
    expect(JSON.stringify(report)).not.toContain("neon-api-secret");
    expect(JSON.stringify(report)).not.toContain("restore-secret");
  });

  it("fails closed when the Neon API key is missing before writing the restore env", async () => {
    const outputEnvPath = path.join(tempDir, "restore.env");

    await expect(prepareAaisNeonRestoreEnv({
      projectId: "neon-project-123",
      databaseName: "aais_restore",
      roleName: "restore_role",
      outputEnvPath,
      fetchImpl: async () => {
        throw new Error("should not call Neon");
      },
    })).rejects.toThrow("NEON_API_KEY is required for AAIS Neon restore preparation");
    await expect(readFile(outputEnvPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not include secret-like Neon API error bodies in thrown errors", async () => {
    await expect(prepareAaisNeonRestoreEnv({
      apiKey: "neon-api-secret",
      projectId: "neon-project-123",
      branchName: "aais-restore-rc1",
      databaseName: "aais_restore",
      roleName: "restore_role",
      outputEnvPath: path.join(tempDir, "restore.env"),
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        async json() {
          return { message: "forbidden neon-api-secret restore-secret" };
        },
      }),
    })).rejects.toThrow("Neon API POST /projects/neon-project-123/branches failed with 403.");
  });
});

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    },
  };
}
