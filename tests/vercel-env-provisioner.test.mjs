import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  provisionAaisVercelEnvironment,
} from "../scripts/provision-vercel-env.mjs";

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-vercel-provision-"));
});

afterEach(async () => {
  await rm(tempDir, { force: true, recursive: true });
});

describe("AAIS Vercel env provisioner", () => {
  it("keeps npm script arguments out of Node's own --env-file parser", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));

    expect(packageJson.scripts["provision:vercel-env"]).toBe(
      "node -- scripts/provision-vercel-env.mjs",
    );
  });

  it("dry-runs only missing Vercel variables from a local env file without outputting values", async () => {
    const envFilePath = await writeText("production.env", [
      "AAIS_DATABASE_URL=postgres://user:database-secret@example.neon.tech/aais?sslmode=require",
      "AAIS_OIDC_ISSUER=https://issuer.example.test",
      "AAIS_OIDC_CLIENT_ID=client-id-secret",
      "AAIS_OIDC_CLIENT_SECRET=client-secret-value",
      "AAIS_OIDC_REDIRECT_URI=https://aais-six.vercel.app/api/auth/oidc/callback",
      "UNRELATED_SECRET=do-not-use",
      "",
    ].join("\n"));
    const reportPath = await writeJson("vercel-env-report.json", {
      schemaVersion: 1,
      status: "failed",
      required: {
        missing: [
          "AAIS_DATABASE_URL",
          "AAIS_OIDC_ISSUER",
          "AAIS_OIDC_CLIENT_ID",
          "AAIS_OIDC_CLIENT_SECRET",
          "AAIS_OIDC_REDIRECT_URI",
        ],
      },
    });

    const report = await provisionAaisVercelEnvironment({
      envFilePath,
      vercelEnvReportPath: reportPath,
      environment: "production",
      apply: false,
      now: new Date("2026-06-30T07:00:00.000Z"),
    });

    expect(report).toEqual({
      schemaVersion: 1,
      status: "ready",
      checkedAt: "2026-06-30T07:00:00.000Z",
      mode: "dry-run",
      target: {
        environment: "production",
        source: "vercel-env-report",
      },
      required: {
        requested: [
          "AAIS_DATABASE_URL",
          "AAIS_OIDC_ISSUER",
          "AAIS_OIDC_CLIENT_ID",
          "AAIS_OIDC_CLIENT_SECRET",
          "AAIS_OIDC_REDIRECT_URI",
        ],
        localValuesPresent: [
          "AAIS_DATABASE_URL",
          "AAIS_OIDC_ISSUER",
          "AAIS_OIDC_CLIENT_ID",
          "AAIS_OIDC_CLIENT_SECRET",
          "AAIS_OIDC_REDIRECT_URI",
        ],
        localValuesMissing: [],
      },
      actions: [
        {
          name: "AAIS_DATABASE_URL",
          command: "vercel env add AAIS_DATABASE_URL production",
          status: "dry_run",
        },
        {
          name: "AAIS_OIDC_ISSUER",
          command: "vercel env add AAIS_OIDC_ISSUER production",
          status: "dry_run",
        },
        {
          name: "AAIS_OIDC_CLIENT_ID",
          command: "vercel env add AAIS_OIDC_CLIENT_ID production",
          status: "dry_run",
        },
        {
          name: "AAIS_OIDC_CLIENT_SECRET",
          command: "vercel env add AAIS_OIDC_CLIENT_SECRET production",
          status: "dry_run",
        },
        {
          name: "AAIS_OIDC_REDIRECT_URI",
          command: "vercel env add AAIS_OIDC_REDIRECT_URI production",
          status: "dry_run",
        },
      ],
      postApply: {
        redeployRequired: true,
        command: "vercel deploy --prod -y --no-wait",
        inspectCommand: "npm run verify:vercel-deployment -- --deployment-url <deployment-url> --output output/aais-vercel-deployment-report-latest.json",
        note: "Run a fresh production deployment after apply, inspect the returned deployment URL until it is ready, then rerun Vercel env, enterprise, and final release evidence verification.",
      },
      redaction: {
        secrets: "omitted",
        values: "read-transiently-not-output",
      },
    });
    expect(JSON.stringify(report)).not.toContain("database-secret");
    expect(JSON.stringify(report)).not.toContain("client-secret-value");
    expect(JSON.stringify(report)).not.toContain("UNRELATED_SECRET");
  });

  it("treats owner-fillable placeholder values as missing so private templates fail closed", async () => {
    const envFilePath = await writeText("owner-template.env", [
      "AAIS_DATABASE_URL=<REQUIRED:NEON_POSTGRES_URL>",
      "AAIS_OIDC_ISSUER=<REQUIRED:OIDC_ISSUER>",
      "AAIS_OIDC_CLIENT_ID=<REQUIRED:OIDC_CLIENT_ID>",
      "AAIS_OIDC_CLIENT_SECRET=<REQUIRED:OIDC_CLIENT_SECRET>",
      "AAIS_OIDC_REDIRECT_URI=<REQUIRED:OIDC_REDIRECT_URI>",
      "",
    ].join("\n"));
    const outputPath = path.join(tempDir, "provision-report.json");
    const requested = [
      "AAIS_DATABASE_URL",
      "AAIS_OIDC_ISSUER",
      "AAIS_OIDC_CLIENT_ID",
      "AAIS_OIDC_CLIENT_SECRET",
      "AAIS_OIDC_REDIRECT_URI",
    ];

    const report = await provisionAaisVercelEnvironment({
      envFilePath,
      names: requested,
      environment: "production",
      apply: false,
      now: new Date("2026-06-30T07:00:00.000Z"),
      outputPath,
    });

    expect(report.status).toBe("failed");
    expect(report.required).toEqual({
      requested,
      localValuesPresent: [],
      localValuesMissing: requested,
    });
    expect(report.actions).toEqual(requested.map((name) => ({
      name,
      command: `vercel env add ${name} production`,
      status: "missing_local_value",
    })));
    expect(report.postApply).toMatchObject({
      redeployRequired: true,
      command: "vercel deploy --prod -y --no-wait",
      inspectCommand: "npm run verify:vercel-deployment -- --deployment-url <deployment-url> --output output/aais-vercel-deployment-report-latest.json",
    });

    const serialized = await readFile(outputPath, "utf8");
    expect(serialized).not.toContain("<REQUIRED:NEON_POSTGRES_URL>");
    expect(serialized).not.toContain("<REQUIRED:OIDC_CLIENT_SECRET>");
  });

  it("writes a failed redacted report when the owner env file has not been created yet", async () => {
    const reportPath = await writeJson("vercel-env-report.json", {
      schemaVersion: 1,
      status: "failed",
      required: {
        missing: ["AAIS_DATABASE_URL", "AAIS_OIDC_ISSUER"],
      },
    });
    const outputPath = path.join(tempDir, "provision-report.json");

    const report = await provisionAaisVercelEnvironment({
      envFilePath: path.join(tempDir, ".env.production.local"),
      vercelEnvReportPath: reportPath,
      outputPath,
      environment: "production",
      now: new Date("2026-06-30T07:05:00.000Z"),
    });

    expect(report).toMatchObject({
      status: "failed",
      checkedAt: "2026-06-30T07:05:00.000Z",
      required: {
        requested: ["AAIS_DATABASE_URL", "AAIS_OIDC_ISSUER"],
        localValuesPresent: [],
        localValuesMissing: ["AAIS_DATABASE_URL", "AAIS_OIDC_ISSUER"],
      },
      actions: [
        {
          name: "AAIS_DATABASE_URL",
          command: "vercel env add AAIS_DATABASE_URL production",
          status: "missing_local_value",
        },
        {
          name: "AAIS_OIDC_ISSUER",
          command: "vercel env add AAIS_OIDC_ISSUER production",
          status: "missing_local_value",
        },
      ],
      postApply: {
        redeployRequired: true,
      },
    });
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(report);
  });

  it("applies values through the runner stdin while keeping the report redacted", async () => {
    const envFilePath = await writeText("production.env", [
      "AAIS_DATABASE_URL=postgres://user:database-secret@example.neon.tech/aais?sslmode=require",
      "AAIS_OIDC_ISSUER=https://issuer.example.test",
      "",
    ].join("\n"));
    const calls = [];

    const report = await provisionAaisVercelEnvironment({
      envFilePath,
      names: ["AAIS_DATABASE_URL", "AAIS_OIDC_ISSUER"],
      environment: "production",
      apply: true,
      now: new Date("2026-06-30T07:00:00.000Z"),
      runner: async (call) => {
        calls.push(call);
        return { ok: true };
      },
    });

    expect(calls).toEqual([
      {
        name: "AAIS_DATABASE_URL",
        environment: "production",
        value: "postgres://user:database-secret@example.neon.tech/aais?sslmode=require",
      },
      {
        name: "AAIS_OIDC_ISSUER",
        environment: "production",
        value: "https://issuer.example.test",
      },
    ]);
    expect(report.status).toBe("applied");
    expect(report.actions.map((action) => action.status)).toEqual(["applied", "applied"]);
    expect(report.postApply).toEqual({
      redeployRequired: true,
      command: "vercel deploy --prod -y --no-wait",
      inspectCommand: "npm run verify:vercel-deployment -- --deployment-url <deployment-url> --output output/aais-vercel-deployment-report-latest.json",
      note: "Run a fresh production deployment after apply, inspect the returned deployment URL until it is ready, then rerun Vercel env, enterprise, and final release evidence verification.",
    });
    expect(JSON.stringify(report)).not.toContain("database-secret");
    expect(JSON.stringify(report)).not.toContain("issuer.example.test");
  });

  it("uses a Vercel Neon DATABASE_URL alias when AAIS_DATABASE_URL is requested", async () => {
    const envFilePath = await writeText("production.env", [
      "DATABASE_URL=postgres://user:database-secret@example.neon.tech/aais?sslmode=require",
      "AAIS_OIDC_ISSUER=https://issuer.example.test",
      "",
    ].join("\n"));
    const reportPath = await writeJson("vercel-env-report.json", {
      schemaVersion: 1,
      status: "failed",
      required: {
        missing: ["AAIS_DATABASE_URL", "AAIS_OIDC_ISSUER"],
      },
    });

    const report = await provisionAaisVercelEnvironment({
      envFilePath,
      vercelEnvReportPath: reportPath,
      environment: "production",
      apply: false,
    });

    expect(report.status).toBe("ready");
    expect(report.required).toMatchObject({
      requested: ["AAIS_DATABASE_URL", "AAIS_OIDC_ISSUER"],
      localValuesPresent: ["DATABASE_URL", "AAIS_OIDC_ISSUER"],
      localValuesMissing: [],
    });
    expect(report.actions).toMatchObject([
      {
        name: "DATABASE_URL",
        requestedName: "AAIS_DATABASE_URL",
        command: "vercel env add DATABASE_URL production",
        status: "dry_run",
      },
      {
        name: "AAIS_OIDC_ISSUER",
        command: "vercel env add AAIS_OIDC_ISSUER production",
        status: "dry_run",
      },
    ]);
    expect(JSON.stringify(report)).not.toContain("database-secret");
  });

  it("uses any configured OIDC educator role mapping when the canonical teacher group mapping is requested", async () => {
    const envFilePath = await writeText("production.env", [
      "AAIS_OIDC_ADMIN_EMAILS=admin@example.edu",
      "",
    ].join("\n"));

    const report = await provisionAaisVercelEnvironment({
      envFilePath,
      names: ["AAIS_OIDC_TEACHER_GROUPS"],
      environment: "production",
      apply: false,
    });

    expect(report.status).toBe("ready");
    expect(report.required).toMatchObject({
      requested: ["AAIS_OIDC_TEACHER_GROUPS"],
      localValuesPresent: ["AAIS_OIDC_ADMIN_EMAILS"],
      localValuesMissing: [],
    });
    expect(report.actions).toMatchObject([
      {
        name: "AAIS_OIDC_ADMIN_EMAILS",
        requestedName: "AAIS_OIDC_TEACHER_GROUPS",
        command: "vercel env add AAIS_OIDC_ADMIN_EMAILS production",
        status: "dry_run",
      },
    ]);
    expect(JSON.stringify(report)).not.toContain("admin@example.edu");
  });

  it("uses release metadata arguments without requiring them in the private env file", async () => {
    const envFilePath = await writeText("production.env", [
      "AAIS_OIDC_ISSUER=https://issuer.example.test",
      "",
    ].join("\n"));
    const reportPath = await writeJson("vercel-env-report.json", {
      schemaVersion: 1,
      status: "failed",
      required: {
        missing: [
          "AAIS_RELEASE_ID",
          "AAIS_DEPLOYMENT_GIT_COMMIT_SHA",
          "AAIS_OIDC_ISSUER",
          "AAIS_OIDC_CLIENT_SECRET",
        ],
      },
    });
    const calls = [];

    const dryRun = await provisionAaisVercelEnvironment({
      envFilePath,
      vercelEnvReportPath: reportPath,
      environment: "production",
      releaseId: "aais-2026-06-30-rc-live-ai-deepseek-v4-flash",
      deploymentGitCommit: "0123456789abcdef0123456789abcdef01234567",
      apply: false,
    });

    expect(dryRun).toMatchObject({
      status: "failed",
      required: {
        requested: [
          "AAIS_RELEASE_ID",
          "AAIS_DEPLOYMENT_GIT_COMMIT_SHA",
          "AAIS_OIDC_ISSUER",
          "AAIS_OIDC_CLIENT_SECRET",
        ],
        localValuesPresent: [
          "AAIS_RELEASE_ID",
          "AAIS_DEPLOYMENT_GIT_COMMIT_SHA",
          "AAIS_OIDC_ISSUER",
        ],
        localValuesMissing: ["AAIS_OIDC_CLIENT_SECRET"],
      },
      actions: [
        {
          name: "AAIS_RELEASE_ID",
          command: "vercel env add AAIS_RELEASE_ID production",
          status: "dry_run",
        },
        {
          name: "AAIS_DEPLOYMENT_GIT_COMMIT_SHA",
          command: "vercel env add AAIS_DEPLOYMENT_GIT_COMMIT_SHA production",
          status: "dry_run",
        },
        {
          name: "AAIS_OIDC_ISSUER",
          command: "vercel env add AAIS_OIDC_ISSUER production",
          status: "dry_run",
        },
        {
          name: "AAIS_OIDC_CLIENT_SECRET",
          command: "vercel env add AAIS_OIDC_CLIENT_SECRET production",
          status: "missing_local_value",
        },
      ],
    });
    expect(JSON.stringify(dryRun)).not.toContain("issuer.example.test");
    expect(JSON.stringify(dryRun)).not.toContain("0123456789abcdef0123456789abcdef01234567");

    const applied = await provisionAaisVercelEnvironment({
      envFilePath,
      names: ["AAIS_RELEASE_ID", "AAIS_DEPLOYMENT_GIT_COMMIT_SHA"],
      environment: "production",
      releaseId: "aais-2026-06-30-rc-live-ai-deepseek-v4-flash",
      deploymentGitCommit: "0123456789abcdef0123456789abcdef01234567",
      apply: true,
      runner: async (call) => {
        calls.push(call);
        return { ok: true };
      },
    });

    expect(applied.status).toBe("applied");
    expect(calls).toEqual([
      {
        name: "AAIS_RELEASE_ID",
        environment: "production",
        value: "aais-2026-06-30-rc-live-ai-deepseek-v4-flash",
      },
      {
        name: "AAIS_DEPLOYMENT_GIT_COMMIT_SHA",
        environment: "production",
        value: "0123456789abcdef0123456789abcdef01234567",
      },
    ]);
    expect(JSON.stringify(applied)).not.toContain("aais-2026-06-30-rc-live-ai-deepseek-v4-flash");
    expect(JSON.stringify(applied)).not.toContain("0123456789abcdef0123456789abcdef01234567");
  });

  it("uses a legacy Vercel Postgres Neon URL alias when AAIS_DATABASE_URL is requested", async () => {
    const envFilePath = await writeText("production.env", [
      "POSTGRES_URL_NON_POOLING=postgres://user:database-secret@example.neon.tech/aais?sslmode=require",
      "",
    ].join("\n"));

    const report = await provisionAaisVercelEnvironment({
      envFilePath,
      names: ["AAIS_DATABASE_URL"],
      environment: "production",
      apply: false,
    });

    expect(report.status).toBe("ready");
    expect(report.required).toMatchObject({
      requested: ["AAIS_DATABASE_URL"],
      localValuesPresent: ["POSTGRES_URL_NON_POOLING"],
      localValuesMissing: [],
    });
    expect(report.actions).toMatchObject([
      {
        name: "POSTGRES_URL_NON_POOLING",
        requestedName: "AAIS_DATABASE_URL",
        command: "vercel env add POSTGRES_URL_NON_POOLING production",
        status: "dry_run",
      },
    ]);
    expect(JSON.stringify(report)).not.toContain("database-secret");
  });

  it("expands raw PG pieces when AAIS_DATABASE_URL is requested", async () => {
    const envFilePath = await writeText("production.env", [
      "PGHOST=ep-prod.us-east-1.aws.neon.tech",
      "PGUSER=aais",
      "PGDATABASE=aais",
      "PGPASSWORD=database-secret",
      "PGPORT=6543",
      "PGSSLMODE=require",
      "",
    ].join("\n"));

    const report = await provisionAaisVercelEnvironment({
      envFilePath,
      names: ["AAIS_DATABASE_URL"],
      environment: "production",
      apply: false,
    });

    expect(report.status).toBe("ready");
    expect(report.required).toMatchObject({
      requested: ["AAIS_DATABASE_URL"],
      localValuesPresent: ["PGHOST/PGUSER/PGDATABASE/PGPASSWORD"],
      localValuesMissing: [],
    });
    expect(report.actions).toMatchObject([
      { name: "PGHOST", requestedName: "AAIS_DATABASE_URL", status: "dry_run" },
      { name: "PGUSER", requestedName: "AAIS_DATABASE_URL", status: "dry_run" },
      { name: "PGDATABASE", requestedName: "AAIS_DATABASE_URL", status: "dry_run" },
      { name: "PGPASSWORD", requestedName: "AAIS_DATABASE_URL", status: "dry_run" },
      { name: "PGPORT", requestedName: "AAIS_DATABASE_URL", status: "dry_run" },
      { name: "PGSSLMODE", requestedName: "AAIS_DATABASE_URL", status: "dry_run" },
    ]);
    expect(JSON.stringify(report)).not.toContain("database-secret");
  });

  it("expands legacy Vercel Postgres raw pieces when AAIS_DATABASE_URL is requested", async () => {
    const envFilePath = await writeText("production.env", [
      "POSTGRES_HOST=ep-prod.us-east-1.aws.neon.tech",
      "POSTGRES_USER=aais",
      "POSTGRES_DATABASE=aais",
      "POSTGRES_PASSWORD=database-secret",
      "POSTGRES_PORT=6543",
      "POSTGRES_SSLMODE=require",
      "",
    ].join("\n"));

    const report = await provisionAaisVercelEnvironment({
      envFilePath,
      names: ["AAIS_DATABASE_URL"],
      environment: "production",
      apply: false,
    });

    expect(report.status).toBe("ready");
    expect(report.required).toMatchObject({
      requested: ["AAIS_DATABASE_URL"],
      localValuesPresent: ["POSTGRES_HOST/POSTGRES_USER/POSTGRES_DATABASE/POSTGRES_PASSWORD"],
      localValuesMissing: [],
    });
    expect(report.actions).toMatchObject([
      { name: "POSTGRES_HOST", requestedName: "AAIS_DATABASE_URL", status: "dry_run" },
      { name: "POSTGRES_USER", requestedName: "AAIS_DATABASE_URL", status: "dry_run" },
      { name: "POSTGRES_DATABASE", requestedName: "AAIS_DATABASE_URL", status: "dry_run" },
      { name: "POSTGRES_PASSWORD", requestedName: "AAIS_DATABASE_URL", status: "dry_run" },
      { name: "POSTGRES_PORT", requestedName: "AAIS_DATABASE_URL", status: "dry_run" },
      { name: "POSTGRES_SSLMODE", requestedName: "AAIS_DATABASE_URL", status: "dry_run" },
    ]);
    expect(JSON.stringify(report)).not.toContain("database-secret");
  });

  it("fails closed when a requested value is absent locally", async () => {
    const envFilePath = await writeText("production.env", "AAIS_DATABASE_URL=postgres://user:database-secret@example.neon.tech/aais\n");
    const calls = [];

    const report = await provisionAaisVercelEnvironment({
      envFilePath,
      names: ["AAIS_DATABASE_URL", "AAIS_OIDC_CLIENT_SECRET"],
      environment: "production",
      apply: true,
      runner: async (call) => {
        calls.push(call);
        return { ok: true };
      },
    });

    expect(report).toMatchObject({
      status: "failed",
      required: {
        localValuesPresent: ["AAIS_DATABASE_URL"],
        localValuesMissing: ["AAIS_OIDC_CLIENT_SECRET"],
      },
      actions: [
        {
          name: "AAIS_DATABASE_URL",
          status: "blocked",
        },
        {
          name: "AAIS_OIDC_CLIENT_SECRET",
          status: "missing_local_value",
        },
      ],
      postApply: {
        redeployRequired: true,
      },
    });
    expect(calls).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("database-secret");
  });
});

async function writeText(fileName, text) {
  const filePath = path.join(tempDir, fileName);
  await writeFile(filePath, text, "utf8");
  return filePath;
}

async function writeJson(fileName, value) {
  return writeText(fileName, `${JSON.stringify(value, null, 2)}\n`);
}
