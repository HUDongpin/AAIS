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
      releaseId: "aais-2026-06-30-rc-live-ai-deepseek-v4-pro",
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
        provisionVariables: [
          "AAIS_RELEASE_ID",
          "AAIS_DEPLOYMENT_GIT_COMMIT_SHA",
          "AAIS_DATABASE_URL",
          "AAIS_OIDC_ISSUER",
          "AAIS_OIDC_CLIENT_ID",
          "AAIS_OIDC_CLIENT_SECRET",
          "AAIS_OIDC_REDIRECT_URI",
          "AAIS_OIDC_TEACHER_GROUPS",
        ],
        localEvidenceOnlyVariables: [],
        validationOnlyVariables: [],
      },
      suggestions: {
        storageProvider: "neon",
        canonicalStorageEnv: "AAIS_DATABASE_URL",
        releaseId: "aais-2026-06-30-rc-live-ai-deepseek-v4-pro",
        deploymentGitCommit: "0123456789abcdef0123456789abcdef01234567",
        oidcRedirectUri: "https://aais-six.vercel.app/api/auth/oidc/callback",
        oidc: {
          idpRedirectUri: "https://aais-six.vercel.app/api/auth/oidc/callback",
          requiredNames: [
            "AAIS_OIDC_ISSUER",
            "AAIS_OIDC_CLIENT_ID",
            "AAIS_OIDC_CLIENT_SECRET",
            "AAIS_OIDC_REDIRECT_URI",
          ],
          acceptedRoleMappingNames: [
            "AAIS_OIDC_TEACHER_GROUPS",
            "AAIS_OIDC_TEACHER_EMAILS",
            "AAIS_OIDC_ADMIN_GROUPS",
            "AAIS_OIDC_ADMIN_EMAILS",
          ],
          optionalExplicitEndpointNames: [
            "AAIS_OIDC_AUTHORIZATION_ENDPOINT",
            "AAIS_OIDC_TOKEN_ENDPOINT",
            "AAIS_OIDC_JWKS_URI",
          ],
          explicitEndpointsRule: "all-or-none",
          validationCommand: "npm run verify:oidc-config -- --env-file .env.production.local --base-url https://aais-six.vercel.app --output output/aais-oidc-config-report-latest.json",
        },
      },
      nextCommands: [
        `npm run provision:vercel-env -- --env-file .env.production.local --report ${vercelEnvReportPath} --release-id aais-2026-06-30-rc-live-ai-deepseek-v4-pro --deployment-git-commit 0123456789abcdef0123456789abcdef01234567 --output output/aais-vercel-env-provision-dry-run-latest.json`,
        `npm run provision:vercel-env -- --env-file .env.production.local --report ${vercelEnvReportPath} --release-id aais-2026-06-30-rc-live-ai-deepseek-v4-pro --deployment-git-commit 0123456789abcdef0123456789abcdef01234567 --apply --output output/aais-vercel-env-provision-apply-latest.json`,
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
    expect(template).toContain("# Provider placeholders intentionally fail closed in provision:vercel-env.");
    expect(template).toContain("# Some OIDC names may already exist in Vercel; they are included here for local verify:oidc-config only.");
    expect(template).toContain("# Live AI eval names may be included for local evidence only; fill them only in the private env file.");
    expect(template).toContain("# provision:vercel-env applies only names requested by the Vercel env report.");
    expect(template).toContain("# Suggested AAIS_OIDC_REDIRECT_URI: https://aais-six.vercel.app/api/auth/oidc/callback");
    expect(template).toContain("# Register this exact OIDC callback URL with the IdP: https://aais-six.vercel.app/api/auth/oidc/callback");
    expect(template).toContain("# Educator role mapping can use any one of AAIS_OIDC_TEACHER_GROUPS, AAIS_OIDC_TEACHER_EMAILS, AAIS_OIDC_ADMIN_GROUPS, or AAIS_OIDC_ADMIN_EMAILS.");
    expect(template).toContain("# Optional explicit OIDC endpoints are all-or-none: set AAIS_OIDC_AUTHORIZATION_ENDPOINT, AAIS_OIDC_TOKEN_ENDPOINT, and AAIS_OIDC_JWKS_URI together, or omit all three for issuer discovery.");
    expect(template).toContain("AAIS_RELEASE_ID=aais-2026-06-30-rc-live-ai-deepseek-v4-pro");
    expect(template).toContain("AAIS_DEPLOYMENT_GIT_COMMIT_SHA=0123456789abcdef0123456789abcdef01234567");
    expect(template).toContain("AAIS_DATABASE_URL=<REQUIRED:NEON_POSTGRES_URL>");
    expect(template).toContain("AAIS_OIDC_ISSUER=<REQUIRED:OIDC_ISSUER>");
    expect(template).toContain("AAIS_OIDC_CLIENT_ID=<REQUIRED:OIDC_CLIENT_ID>");
    expect(template).toContain("AAIS_OIDC_CLIENT_SECRET=<REQUIRED:OIDC_CLIENT_SECRET>");
    expect(template).toContain("AAIS_OIDC_REDIRECT_URI=https://aais-six.vercel.app/api/auth/oidc/callback");
    expect(template).toContain("AAIS_OIDC_TEACHER_GROUPS=<REQUIRED:OIDC_TEACHER_GROUPS>");
    expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual(report);

    const serialized = `${JSON.stringify(report)}\n${template}`;
    expect(serialized).not.toContain("postgres://aais:secret@example.neon.tech/aais");
    expect(serialized).not.toContain("secret@example");
  });

  it("adds OIDC redirect URI as a local validation-only variable when Vercel already has it", async () => {
    const vercelEnvReportPath = await writeJson("vercel-env.json", {
      schemaVersion: 1,
      status: "failed",
      required: {
        missing: [
          "AAIS_OIDC_ISSUER",
          "AAIS_OIDC_CLIENT_ID",
          "AAIS_OIDC_CLIENT_SECRET",
          "AAIS_OIDC_TEACHER_GROUPS",
        ],
      },
    });
    const outputPath = path.join(tempDir, "template.env");
    const reportPath = path.join(tempDir, "report.json");

    const report = await generateAaisPrivateEnvTemplate({
      vercelEnvReportPath,
      outputPath,
      reportPath,
      baseUrl: "https://www.aais.site",
      now: new Date("2026-06-30T07:30:00.000Z"),
    });

    expect(report.missing).toEqual([
      "AAIS_OIDC_ISSUER",
      "AAIS_OIDC_CLIENT_ID",
      "AAIS_OIDC_CLIENT_SECRET",
      "AAIS_OIDC_TEACHER_GROUPS",
    ]);
    expect(report.template).toMatchObject({
      variables: [
        "AAIS_OIDC_ISSUER",
        "AAIS_OIDC_CLIENT_ID",
        "AAIS_OIDC_CLIENT_SECRET",
        "AAIS_OIDC_TEACHER_GROUPS",
        "AAIS_OIDC_REDIRECT_URI",
      ],
      provisionVariables: [
        "AAIS_OIDC_ISSUER",
        "AAIS_OIDC_CLIENT_ID",
        "AAIS_OIDC_CLIENT_SECRET",
        "AAIS_OIDC_TEACHER_GROUPS",
      ],
      validationOnlyVariables: ["AAIS_OIDC_REDIRECT_URI"],
    });

    const template = await readFile(outputPath, "utf8");
    expect(template).toContain("AAIS_OIDC_REDIRECT_URI=https://www.aais.site/api/auth/oidc/callback");
    expect(template).toContain("# provision:vercel-env applies only names requested by the Vercel env report.");
  });

  it("adds live AI eval inputs from enterprise gap preflight as local evidence-only variables", async () => {
    const vercelEnvReportPath = await writeJson("vercel-env.json", {
      schemaVersion: 1,
      status: "failed",
      required: {
        missing: [
          "AAIS_OIDC_ISSUER",
          "AAIS_OIDC_CLIENT_ID",
          "AAIS_OIDC_CLIENT_SECRET",
          "AAIS_OIDC_TEACHER_GROUPS",
        ],
      },
    });
    const enterpriseGapEvidenceReportPath = await writeJson("gap-evidence.json", {
      schemaVersion: 1,
      status: "action-required",
      mode: "all",
      preflight: {
        status: "action-required",
        required: {
          missing: [
            "AAIS_VERIFY_OIDC_CALLBACK_URL",
            "AAIS_VERIFY_OIDC_STATE_COOKIE",
            "AAIS_AI_ENDPOINT",
            "AAIS_AI_API_KEY",
            "AAIS_AI_MODEL",
            "AAIS_AI_EVAL_VERSION",
          ],
          placeholders: ["AAIS_RESTORE_DATABASE_URL"],
          invalid: ["AAIS_RESTORE_TARGET_PURPOSE"],
        },
      },
    });
    const outputPath = path.join(tempDir, "template.env");
    const reportPath = path.join(tempDir, "report.json");

    const report = await generateAaisPrivateEnvTemplate({
      vercelEnvReportPath,
      enterpriseGapEvidenceReportPath,
      outputPath,
      reportPath,
      baseUrl: "https://www.aais.site",
      releaseId: "aais-2026-07-01-rc1",
      now: new Date("2026-07-01T07:30:00.000Z"),
    });

    expect(report.sourceReports).toEqual({
      vercelEnv: vercelEnvReportPath,
      enterpriseGapEvidence: enterpriseGapEvidenceReportPath,
    });
    expect(report.template.provisionVariables).toEqual([
      "AAIS_OIDC_ISSUER",
      "AAIS_OIDC_CLIENT_ID",
      "AAIS_OIDC_CLIENT_SECRET",
      "AAIS_OIDC_TEACHER_GROUPS",
    ]);
    expect(report.template.localEvidenceOnlyVariables).toEqual([
      "AAIS_AI_ENDPOINT",
      "AAIS_AI_API_KEY",
      "AAIS_AI_MODEL",
      "AAIS_AI_EVAL_VERSION",
    ]);
    expect(report.template.validationOnlyVariables).toEqual(["AAIS_OIDC_REDIRECT_URI"]);
    expect(report.template.variables).toEqual([
      "AAIS_OIDC_ISSUER",
      "AAIS_OIDC_CLIENT_ID",
      "AAIS_OIDC_CLIENT_SECRET",
      "AAIS_OIDC_TEACHER_GROUPS",
      "AAIS_AI_ENDPOINT",
      "AAIS_AI_API_KEY",
      "AAIS_AI_MODEL",
      "AAIS_AI_EVAL_VERSION",
      "AAIS_OIDC_REDIRECT_URI",
    ]);
    expect(report.suggestions.liveAiEval).toMatchObject({
      envFilePath: ".env.production.local",
      requiredNames: [
        "AAIS_AI_ENDPOINT",
        "AAIS_AI_API_KEY",
        "AAIS_AI_MODEL",
        "AAIS_AI_EVAL_VERSION",
      ],
      preflightCommand:
        "npm run verify:enterprise-gaps -- --mode live-ai-eval --preflight-only --ai-eval-env-file .env.production.local --output output/aais-enterprise-gap-evidence-latest.json --release-id aais-2026-07-01-rc1",
      evaluationCommand:
        "npm run ai:evaluate -- --env-file .env.production.local --output output/aais-ai-eval-deepseek-v4-pro.json --env-json-output output/aais-ai-eval-inline-latest.json --eval-version <AAIS_AI_EVAL_VERSION> --release-id aais-2026-07-01-rc1",
    });

    const template = await readFile(outputPath, "utf8");
    expect(template).toContain("AAIS_AI_ENDPOINT=<REQUIRED:AI_ENDPOINT>");
    expect(template).toContain("AAIS_AI_API_KEY=<REQUIRED:AI_API_KEY>");
    expect(template).toContain("AAIS_AI_MODEL=<REQUIRED:AI_MODEL>");
    expect(template).toContain("AAIS_AI_EVAL_VERSION=<REQUIRED:AI_EVAL_VERSION>");
    expect(template).toContain("AAIS_OIDC_REDIRECT_URI=https://www.aais.site/api/auth/oidc/callback");
    expect(template).not.toContain("AAIS_VERIFY_OIDC_CALLBACK_URL");
    expect(template).not.toContain("AAIS_VERIFY_OIDC_STATE_COOKIE");
    expect(template).not.toContain("AAIS_RESTORE_DATABASE_URL");
    expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual(report);
  });

  it("adds full OIDC validation shape when only one OIDC value is missing", async () => {
    const vercelEnvReportPath = await writeJson("vercel-env.json", {
      required: {
        missing: ["AAIS_OIDC_CLIENT_SECRET"],
      },
    });
    const outputPath = path.join(tempDir, "template.env");
    const reportPath = path.join(tempDir, "report.json");

    const report = await generateAaisPrivateEnvTemplate({
      vercelEnvReportPath,
      outputPath,
      reportPath,
      baseUrl: "https://www.aais.site",
      now: new Date("2026-06-30T07:30:00.000Z"),
    });

    expect(report.template.provisionVariables).toEqual(["AAIS_OIDC_CLIENT_SECRET"]);
    expect(report.template.validationOnlyVariables).toEqual([
      "AAIS_OIDC_ISSUER",
      "AAIS_OIDC_CLIENT_ID",
      "AAIS_OIDC_REDIRECT_URI",
      "AAIS_OIDC_TEACHER_GROUPS",
    ]);

    const template = await readFile(outputPath, "utf8");
    expect(template).toContain("AAIS_OIDC_CLIENT_SECRET=<REQUIRED:OIDC_CLIENT_SECRET>");
    expect(template).toContain("AAIS_OIDC_ISSUER=<REQUIRED:OIDC_ISSUER>");
    expect(template).toContain("AAIS_OIDC_CLIENT_ID=<REQUIRED:OIDC_CLIENT_ID>");
    expect(template).toContain("AAIS_OIDC_TEACHER_GROUPS=<REQUIRED:OIDC_TEACHER_GROUPS>");
    expect(template).toContain("AAIS_OIDC_REDIRECT_URI=https://www.aais.site/api/auth/oidc/callback");
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
    expect(report.suggestions.oidc.validationCommand).toBe(
      "npm run verify:oidc-config -- --env-file .env.production.local --base-url https://www.aais.site --output output/aais-oidc-config-report-latest.json",
    );
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
