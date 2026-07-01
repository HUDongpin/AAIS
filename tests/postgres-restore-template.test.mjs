import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateAaisPostgresRestoreTemplate } from "../scripts/generate-postgres-restore-template.mjs";

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-restore-template-"));
});

afterEach(async () => {
  delete process.env.AAIS_POSTGRES_RESTORE_TEMPLATE_PATH;
  delete process.env.AAIS_POSTGRES_RESTORE_TEMPLATE_REPORT_PATH;
  await rm(tempDir, { force: true, recursive: true });
});

describe("AAIS Postgres restore rehearsal template", () => {
  it("writes a fail-closed restored Neon env template and redacted report", async () => {
    const outputPath = path.join(tempDir, "restore-template.env");
    const reportPath = path.join(tempDir, "restore-template-report.json");
    const postgresRestoreReportPath = path.join(tempDir, "restore-report.json");

    const report = await generateAaisPostgresRestoreTemplate({
      outputPath,
      reportPath,
      postgresRestoreReportPath,
      releaseId: "aais-2026-06-30-rc-live-ai-deepseek-v4-flash",
      now: new Date("2026-06-30T12:00:00.000Z"),
    });

    expect(report).toEqual({
      schemaVersion: 1,
      status: "template-created",
      generatedAt: "2026-06-30T12:00:00.000Z",
      release: {
        id: "aais-2026-06-30-rc-live-ai-deepseek-v4-flash",
      },
      template: {
        outputPath,
        privateRestoreEnvFilePath: ".env.postgres-restore.local",
        placeholderValues: "fail-closed",
        variables: [
          "AAIS_RESTORE_DATABASE_URL",
          "AAIS_RESTORE_DATABASE_PROVIDER",
          "AAIS_RESTORE_TARGET_PURPOSE",
          "AAIS_RELEASE_ID",
        ],
      },
      target: {
        databaseProvider: "neon",
        postgresRestoreReportPath,
      },
      nextCommands: [
        `npm run verify:postgres-restore -- --env-file .env.postgres-restore.local --database-provider neon --target-purpose restored-staging --output ${postgresRestoreReportPath} --release-id aais-2026-06-30-rc-live-ai-deepseek-v4-flash`,
      ],
      redaction: {
        secrets: "omitted",
        values: "placeholders-only",
      },
    });

    const template = await readFile(outputPath, "utf8");
    expect(template).toContain("# AAIS restored Neon rehearsal env template");
    expect(template).toContain("# Do not commit this file.");
    expect(template).toContain("# Copy this template to .env.postgres-restore.local, then fill the copy with the restored staging Neon URL.");
    expect(template).toContain("# Use a restored staging Neon database, never the production database.");
    expect(template).toContain("AAIS_RESTORE_DATABASE_URL=<REQUIRED:RESTORED_NEON_STAGING_DATABASE_URL>");
    expect(template).toContain("AAIS_RESTORE_DATABASE_PROVIDER=neon");
    expect(template).toContain("AAIS_RESTORE_TARGET_PURPOSE=restored-staging");
    expect(template).toContain("AAIS_RELEASE_ID=aais-2026-06-30-rc-live-ai-deepseek-v4-flash");
    expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual(report);
    expect(`${JSON.stringify(report)}\n${template}`).not.toContain("postgres://");
  });

  it("uses environment output paths when explicit output paths are omitted", async () => {
    process.env.AAIS_POSTGRES_RESTORE_TEMPLATE_PATH = path.join(tempDir, "env-template.env");
    process.env.AAIS_POSTGRES_RESTORE_TEMPLATE_REPORT_PATH = path.join(tempDir, "env-report.json");

    const report = await generateAaisPostgresRestoreTemplate({
      postgresRestoreReportPath: path.join(tempDir, "restore-report.json"),
      releaseId: "aais-2026-06-30-rc-live-ai-deepseek-v4-flash",
      now: new Date("2026-06-30T12:00:00.000Z"),
    });

    expect(report.template.outputPath).toBe(process.env.AAIS_POSTGRES_RESTORE_TEMPLATE_PATH);
    expect(report.template.privateRestoreEnvFilePath).toBe(".env.postgres-restore.local");
    expect(JSON.parse(await readFile(process.env.AAIS_POSTGRES_RESTORE_TEMPLATE_REPORT_PATH, "utf8"))).toEqual(report);
  });
});
