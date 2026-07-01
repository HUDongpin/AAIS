import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateAaisPrivateEnvTemplate } from "../scripts/generate-private-env-template.mjs";

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-private-env-template-"));
});

afterEach(async () => {
  delete process.env.AAIS_PRIVATE_ENV_TEMPLATE_PATH;
  delete process.env.AAIS_PRIVATE_ENV_TEMPLATE_REPORT_PATH;
  await rm(tempDir, { force: true, recursive: true });
});

describe("AAIS private env template generator", () => {
  it("writes a fail-closed owner-fillable template and redacted report for missing Vercel values", async () => {
    const vercelEnvReportPath = await writeJson("vercel-env.json", {
      schemaVersion: 1,
      status: "failed",
      checkedAt: "2026-06-30T07:00:00.000Z",
      required: {
        missing: [
          "AAIS_RELEASE_ID",
          "AAIS_DEPLOYMENT_GIT_COMMIT_SHA",
          "AAIS_DATABASE_URL",
          "AAIS_OIDC_ISSUER",
          "AAIS_OIDC_CLIENT_ID",
          "AAIS_OIDC_CLIENT_SECRET",
          "AAIS_OIDC_REDIRECT_URI",
          "AAIS_OIDC_TEACHER_GROUPS",
        ],
      },
      rawSecret: "postgres://aais:secret@example.neon.tech/aais",
    });
    const outputPath = path.join(tempDir, "aais-private-production.env");
    const reportPath = path.join(tempDir, "template-report.json");

    const report = await generateAaisPrivateEnvTemplate({
      vercelEnvReportPath,
      outputPath,
      reportPath,
      baseUrl: "https://aais-six.vercel.app",
      environment: "production",
      releaseId: "aais-2026-06-30-rc-live-ai-deepseek-v4-flash",
      deploymentGitCommit: "0123456789abcdef0123456789abcdef01234567",
      now: new Date("2026-06-30T07:30:00.000Z"),
    });

    expect(report).toEqual({
      schemaVersion: 1,
      status: "template-created",
      generatedAt: "2026-06-30T07:30:00.000Z",
      sourceReports: {
        vercelEnv: vercelEnvReportPath,
      },
      target: {
        environment: "production",
        baseUrl: "https://aais-six.vercel.app",
      },
      missing: [
        "AAIS_RELEASE_ID",
        "AAIS_DEPLOYMENT_GIT_COMMIT_SHA",
        "AAIS_DATABASE_URL",
        "AAIS_OIDC_ISSUER",
        "AAIS_OIDC_CLIENT_ID",
        "AAIS_OIDC_CLIENT_SECRET",
        "AAIS_OIDC_REDIRECT_URI",
        "AAIS_OIDC_TEACHER_GROUPS",
      ],
      template: {
        outputPath,
        privateEnvFilePath: ".env.production.local",
        placeholderValues: "fail-closed",
        variables: [
          "AAIS_RELEASE_ID",
          "AAIS_DEPLOYMENT_GIT_COMMIT_SHA",
          "AAIS_DATABASE_URL",
          "AAIS_OIDC_ISSUER",
          "AAIS_OIDC_CLIENT_ID",
          "AAIS_OIDC_CLIENT_SECRET",
          "AAIS_OIDC_REDIRECT_URI",
          "AAIS_OIDC_TEACHER_GROUPS",
        ],
      },
      suggestions: {
        storageProvider: "neon",
        canonicalStorageEnv: "AAIS_DATABASE_URL",
        releaseId: "aais-2026-06-30-rc-live-ai-deepseek-v4-flash",
        deploymentGitCommit: "0123456789abcdef0123456789abcdef01234567",
        oidcRedirectUri: "https://aais-six.vercel.app/api/auth/oidc/callback",
      },
      nextCommands: [
        `npm run provision:vercel-env -- --env-file .env.production.local --report ${vercelEnvReportPath} --release-id aais-2026-06-30-rc-live-ai-deepseek-v4-flash --deployment-git-commit 0123456789abcdef0123456789abcdef01234567 --output output/aais-vercel-env-provision-dry-run-latest.json`,
        `npm run provision:vercel-env -- --env-file .env.production.local --report ${vercelEnvReportPath} --release-id aais-2026-06-30-rc-live-ai-deepseek-v4-flash --deployment-git-commit 0123456789abcdef0123456789abcdef01234567 --apply --output output/aais-vercel-env-provision-apply-latest.json`,
      ],
      redaction: {
        secrets: "omitted",
        values: "placeholders-only",
      },
    });

    const template = await readFile(outputPath, "utf8");
    expect(template).toContain("# AAIS private production env template");
    expect(template).toContain("# Do not commit this file.");
    expect(template).toContain("# Copy this template to .env.production.local, then fill the copy with real values.");
    expect(template).toContain("# Placeholder values intentionally fail closed in provision:vercel-env.");
    expect(template).toContain("# Suggested AAIS_OIDC_REDIRECT_URI: https://aais-six.vercel.app/api/auth/oidc/callback");
    expect(template).toContain("AAIS_RELEASE_ID=aais-2026-06-30-rc-live-ai-deepseek-v4-flash");
    expect(template).toContain("AAIS_DEPLOYMENT_GIT_COMMIT_SHA=0123456789abcdef0123456789abcdef01234567");
    expect(template).toContain("AAIS_DATABASE_URL=<REQUIRED:NEON_POSTGRES_URL>");
    expect(template).toContain("AAIS_OIDC_ISSUER=<REQUIRED:OIDC_ISSUER>");
    expect(template).toContain("AAIS_OIDC_CLIENT_ID=<REQUIRED:OIDC_CLIENT_ID>");
    expect(template).toContain("AAIS_OIDC_CLIENT_SECRET=<REQUIRED:OIDC_CLIENT_SECRET>");
    expect(template).toContain("AAIS_OIDC_REDIRECT_URI=<REQUIRED:OIDC_REDIRECT_URI>");
    expect(template).toContain("AAIS_OIDC_TEACHER_GROUPS=<REQUIRED:OIDC_TEACHER_GROUPS>");
    expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual(report);

    const serialized = `${JSON.stringify(report)}\n${template}`;
    expect(serialized).not.toContain("postgres://aais:secret@example.neon.tech/aais");
    expect(serialized).not.toContain("secret@example");
  });

  it("uses environment output paths when explicit output paths are omitted", async () => {
    const vercelEnvReportPath = await writeJson("vercel-env.json", {
      required: {
        missing: ["AAIS_DATABASE_URL"],
      },
    });
    process.env.AAIS_PRIVATE_ENV_TEMPLATE_PATH = path.join(tempDir, "env-template.env");
    process.env.AAIS_PRIVATE_ENV_TEMPLATE_REPORT_PATH = path.join(tempDir, "env-report.json");

    const report = await generateAaisPrivateEnvTemplate({
      vercelEnvReportPath,
      baseUrl: "https://aais-six.vercel.app",
      now: new Date("2026-06-30T07:30:00.000Z"),
    });

    expect(report.template.outputPath).toBe(process.env.AAIS_PRIVATE_ENV_TEMPLATE_PATH);
    expect(report.template.privateEnvFilePath).toBe(".env.production.local");
    expect(JSON.parse(await readFile(process.env.AAIS_PRIVATE_ENV_TEMPLATE_REPORT_PATH, "utf8"))).toEqual(report);
  });

  it("falls back to the Vercel report when explicit names are an empty CLI list", async () => {
    const vercelEnvReportPath = await writeJson("vercel-env.json", {
      required: {
        missing: ["AAIS_DATABASE_URL"],
      },
    });
    const outputPath = path.join(tempDir, "template.env");
    const reportPath = path.join(tempDir, "report.json");

    const report = await generateAaisPrivateEnvTemplate({
      vercelEnvReportPath,
      outputPath,
      reportPath,
      names: [],
      now: new Date("2026-06-30T07:30:00.000Z"),
    });

    expect(report.status).toBe("template-created");
    expect(report.target.baseUrl).toBe("https://www.aais.site");
    expect(report.suggestions.oidcRedirectUri).toBe("https://www.aais.site/api/auth/oidc/callback");
    expect(report.missing).toEqual(["AAIS_DATABASE_URL"]);
    const template = await readFile(outputPath, "utf8");
    expect(template).toContain("# Suggested AAIS_OIDC_REDIRECT_URI: https://www.aais.site/api/auth/oidc/callback");
    expect(template).toContain("AAIS_DATABASE_URL=<REQUIRED:NEON_POSTGRES_URL>");
  });
});

async function writeJson(fileName, value) {
  const filePath = path.join(tempDir, fileName);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}
