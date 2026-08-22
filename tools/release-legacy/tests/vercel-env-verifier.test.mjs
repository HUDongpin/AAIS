import { describe, expect, it } from "vitest";
import { verifyAaisVercelEnvironment } from "../scripts/verify-vercel-env.mjs";

const requiredProductionEnv = [
  "AAIS_SESSION_SECRET",
  "AAIS_PRODUCT_PSEUDONYM_SECRET",
  "AAIS_RELEASE_ID",
  "AAIS_DEPLOYMENT_GIT_COMMIT_SHA",
  "AAIS_DATABASE_URL",
  "AAIS_DATABASE_PROVIDER",
  "AAIS_TRIAL_LOGIN_ENABLED",
  "AAIS_OIDC_ISSUER",
  "AAIS_OIDC_CLIENT_ID",
  "AAIS_OIDC_CLIENT_SECRET",
  "AAIS_OIDC_REDIRECT_URI",
  "AAIS_OIDC_TEACHER_GROUPS",
  "AAIS_AI_PROVIDER",
  "AAIS_AI_ENDPOINT",
  "AAIS_AI_API_KEY",
  "AAIS_AI_MODEL",
  "AAIS_AI_EVAL_APPROVED",
  "AAIS_AI_EVAL_VERSION",
  "AAIS_AI_EVAL_MANIFEST_PATH",
  "LRS_ENDPOINT",
  "LRS_USERNAME",
  "LRS_PASSWORD",
  "CRON_SECRET",
];

const requiredTrialProductionEnv = [
  "AAIS_SESSION_SECRET",
  "AAIS_PRODUCT_PSEUDONYM_SECRET",
  "AAIS_RELEASE_ID",
  "AAIS_DEPLOYMENT_GIT_COMMIT_SHA",
  "AAIS_DATABASE_URL",
  "AAIS_DATABASE_PROVIDER",
  "AAIS_TRIAL_ACCOUNTS_JSON",
  "AAIS_AI_PROVIDER",
  "AAIS_AI_ENDPOINT",
  "AAIS_AI_API_KEY",
  "AAIS_AI_MODEL",
  "AAIS_AI_EVAL_APPROVED",
  "AAIS_AI_EVAL_VERSION",
  "AAIS_AI_EVAL_MANIFEST_PATH",
  "LRS_ENDPOINT",
  "LRS_USERNAME",
  "LRS_PASSWORD",
  "CRON_SECRET",
];

const acceptedStorageEnvNames = [
  "AAIS_DATABASE_URL",
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NO_SSL",
  "DATABASE_URL_UNPOOLED",
  "POSTGRES_URL_NON_POOLING",
  "PGHOST/PGUSER/PGDATABASE/PGPASSWORD",
  "POSTGRES_HOST/POSTGRES_USER/POSTGRES_DATABASE/POSTGRES_PASSWORD",
];

const acceptedOidcRoleMappingEnvNames = [
  "AAIS_OIDC_TEACHER_GROUPS",
  "AAIS_OIDC_TEACHER_EMAILS",
  "AAIS_OIDC_ADMIN_GROUPS",
  "AAIS_OIDC_ADMIN_EMAILS",
];

describe("AAIS Vercel environment verifier", () => {
  it("defaults the current-stage production gate to trial auth without OIDC provider variables", async () => {
    const report = await verifyAaisVercelEnvironment({
      now: new Date("2026-07-01T08:00:00.000Z"),
      rows: requiredTrialProductionEnv.map((name) => ({
        name,
        environments: ["Production"],
      })),
    });

    expect(report.status).toBe("passed");
    expect(report.target).toEqual({
      environment: "Production",
      authMode: "trial",
      aiMode: "live",
    });
    expect(report.required.missing).toEqual([]);
    expect(report.required.present).toContain("AAIS_TRIAL_ACCOUNTS_JSON");
    expect(report.required.present).not.toContain("AAIS_TRIAL_LOGIN_ENABLED");
    expect(report.required.present).not.toContain("AAIS_OIDC_ISSUER");
    expect(report.categories.oidc).toEqual([]);
    expect(report.categories.oidcRoleMapping).toEqual([]);
  });

  it("passes when all enterprise production variable names are present without reading values", async () => {
    const report = await verifyAaisVercelEnvironment({
      authMode: "sso-only",
      now: new Date("2026-06-30T06:00:00.000Z"),
      rows: requiredProductionEnv.map((name) => ({
        name,
        environments: ["Production"],
      })),
    });

    expect(report).toEqual({
      schemaVersion: 1,
      status: "passed",
      checkedAt: "2026-06-30T06:00:00.000Z",
      target: {
        environment: "Production",
        authMode: "sso-only",
        aiMode: "live",
      },
      required: {
        present: requiredProductionEnv,
        missing: [],
      },
      categories: {
        core: [],
        storage: [],
        releaseMode: [],
        oidc: [],
        oidcRoleMapping: [],
        ai: [],
        lrs: [],
      },
      storageUrl: {
        present: true,
        sourceEnv: "AAIS_DATABASE_URL",
        acceptedNames: acceptedStorageEnvNames,
      },
      aiEvalManifest: {
        present: true,
        sourceEnv: "AAIS_AI_EVAL_MANIFEST_PATH",
        acceptedNames: ["AAIS_AI_EVAL_MANIFEST_PATH", "AAIS_AI_EVAL_MANIFEST_JSON"],
      },
      oidcRoleMapping: {
        present: true,
        sourceEnv: "AAIS_OIDC_TEACHER_GROUPS",
        acceptedNames: acceptedOidcRoleMappingEnvNames,
      },
      provisioningPlan: {
        status: "not-needed",
        environment: "Production",
        actions: [],
        redaction: {
          values: "not-included",
        },
      },
      redaction: {
        secrets: "omitted",
        values: "not-read",
      },
    });
  });

  it("accepts a standard Vercel Neon DATABASE_URL in place of AAIS_DATABASE_URL", async () => {
    const rows = requiredProductionEnv
      .filter((name) => name !== "AAIS_DATABASE_URL")
      .concat("DATABASE_URL")
      .map((name) => ({
        name,
        environments: ["Production"],
      }));

    const report = await verifyAaisVercelEnvironment({
      authMode: "sso-only",
      now: new Date("2026-06-30T06:00:00.000Z"),
      rows,
    });

    expect(report.status).toBe("passed");
    expect(report.required.missing).toEqual([]);
    expect(report.required.present).toContain("DATABASE_URL");
    expect(report.required.present).not.toContain("AAIS_DATABASE_URL");
    expect(report.categories.storage).toEqual([]);
    expect(report.storageUrl).toEqual({
      present: true,
      sourceEnv: "DATABASE_URL",
      acceptedNames: acceptedStorageEnvNames,
    });
  });

  it("accepts a Vercel Neon direct DATABASE_URL_UNPOOLED in place of AAIS_DATABASE_URL", async () => {
    const rows = requiredProductionEnv
      .filter((name) => name !== "AAIS_DATABASE_URL")
      .concat("DATABASE_URL_UNPOOLED")
      .map((name) => ({
        name,
        environments: ["Production"],
      }));

    const report = await verifyAaisVercelEnvironment({
      authMode: "sso-only",
      now: new Date("2026-06-30T06:00:00.000Z"),
      rows,
    });

    expect(report.status).toBe("passed");
    expect(report.required.missing).toEqual([]);
    expect(report.required.present).toContain("DATABASE_URL_UNPOOLED");
    expect(report.required.present).not.toContain("AAIS_DATABASE_URL");
    expect(report.categories.storage).toEqual([]);
    expect(report.storageUrl).toEqual({
      present: true,
      sourceEnv: "DATABASE_URL_UNPOOLED",
      acceptedNames: acceptedStorageEnvNames,
    });
  });

  it("accepts legacy Vercel Postgres Neon URL aliases in place of AAIS_DATABASE_URL", async () => {
    const rows = requiredProductionEnv
      .filter((name) => name !== "AAIS_DATABASE_URL")
      .concat("POSTGRES_URL_NON_POOLING")
      .map((name) => ({
        name,
        environments: ["Production"],
      }));

    const report = await verifyAaisVercelEnvironment({
      authMode: "sso-only",
      now: new Date("2026-06-30T06:00:00.000Z"),
      rows,
    });

    expect(report.status).toBe("passed");
    expect(report.required.missing).toEqual([]);
    expect(report.required.present).toContain("POSTGRES_URL_NON_POOLING");
    expect(report.required.present).not.toContain("AAIS_DATABASE_URL");
    expect(report.categories.storage).toEqual([]);
    expect(report.storageUrl).toEqual({
      present: true,
      sourceEnv: "POSTGRES_URL_NON_POOLING",
      acceptedNames: acceptedStorageEnvNames,
    });
  });

  it("accepts the Vercel Postgres POSTGRES_URL_NO_SSL alias in place of AAIS_DATABASE_URL", async () => {
    const rows = requiredProductionEnv
      .filter((name) => name !== "AAIS_DATABASE_URL")
      .concat("POSTGRES_URL_NO_SSL")
      .map((name) => ({
        name,
        environments: ["Production"],
      }));

    const report = await verifyAaisVercelEnvironment({
      authMode: "sso-only",
      now: new Date("2026-06-30T06:00:00.000Z"),
      rows,
    });

    expect(report.status).toBe("passed");
    expect(report.required.missing).toEqual([]);
    expect(report.required.present).toContain("POSTGRES_URL_NO_SSL");
    expect(report.required.present).not.toContain("AAIS_DATABASE_URL");
    expect(report.categories.storage).toEqual([]);
    expect(report.storageUrl).toEqual({
      present: true,
      sourceEnv: "POSTGRES_URL_NO_SSL",
      acceptedNames: acceptedStorageEnvNames,
    });
  });

  it("accepts Vercel Neon raw PG environment pieces in place of AAIS_DATABASE_URL", async () => {
    const rows = requiredProductionEnv
      .filter((name) => name !== "AAIS_DATABASE_URL")
      .concat("PGHOST", "PGUSER", "PGDATABASE", "PGPASSWORD")
      .map((name) => ({
        name,
        environments: ["Production"],
      }));

    const report = await verifyAaisVercelEnvironment({
      authMode: "sso-only",
      now: new Date("2026-06-30T06:00:00.000Z"),
      rows,
    });

    expect(report.status).toBe("passed");
    expect(report.required.missing).toEqual([]);
    expect(report.required.present).toContain("PGHOST/PGUSER/PGDATABASE/PGPASSWORD");
    expect(report.required.present).not.toContain("AAIS_DATABASE_URL");
    expect(report.categories.storage).toEqual([]);
    expect(report.storageUrl).toEqual({
      present: true,
      sourceEnv: "PGHOST/PGUSER/PGDATABASE/PGPASSWORD",
      acceptedNames: acceptedStorageEnvNames,
    });
  });

  it("accepts legacy Vercel Postgres raw environment pieces in place of AAIS_DATABASE_URL", async () => {
    const rows = requiredProductionEnv
      .filter((name) => name !== "AAIS_DATABASE_URL")
      .concat("POSTGRES_HOST", "POSTGRES_USER", "POSTGRES_DATABASE", "POSTGRES_PASSWORD")
      .map((name) => ({
        name,
        environments: ["Production"],
      }));

    const report = await verifyAaisVercelEnvironment({
      authMode: "sso-only",
      now: new Date("2026-06-30T06:00:00.000Z"),
      rows,
    });

    expect(report.status).toBe("passed");
    expect(report.required.missing).toEqual([]);
    expect(report.required.present).toContain("POSTGRES_HOST/POSTGRES_USER/POSTGRES_DATABASE/POSTGRES_PASSWORD");
    expect(report.required.present).not.toContain("AAIS_DATABASE_URL");
    expect(report.categories.storage).toEqual([]);
    expect(report.storageUrl).toEqual({
      present: true,
      sourceEnv: "POSTGRES_HOST/POSTGRES_USER/POSTGRES_DATABASE/POSTGRES_PASSWORD",
      acceptedNames: acceptedStorageEnvNames,
    });
  });

  it("accepts an inline AI evaluation manifest JSON in place of a server file path", async () => {
    const rows = requiredProductionEnv
      .filter((name) => name !== "AAIS_AI_EVAL_MANIFEST_PATH")
      .concat("AAIS_AI_EVAL_MANIFEST_JSON")
      .map((name) => ({
        name,
        environments: ["Production"],
      }));

    const report = await verifyAaisVercelEnvironment({
      authMode: "sso-only",
      now: new Date("2026-06-30T06:00:00.000Z"),
      rows,
    });

    expect(report.status).toBe("passed");
    expect(report.required.missing).toEqual([]);
    expect(report.required.present).toContain("AAIS_AI_EVAL_MANIFEST_JSON");
    expect(report.required.present).not.toContain("AAIS_AI_EVAL_MANIFEST_PATH");
    expect(report.categories.ai).toEqual([]);
    expect(report.aiEvalManifest).toEqual({
      present: true,
      sourceEnv: "AAIS_AI_EVAL_MANIFEST_JSON",
      acceptedNames: ["AAIS_AI_EVAL_MANIFEST_PATH", "AAIS_AI_EVAL_MANIFEST_JSON"],
    });
  });

  it("accepts an admin email mapping in place of the canonical OIDC teacher group mapping", async () => {
    const rows = requiredProductionEnv
      .filter((name) => name !== "AAIS_OIDC_TEACHER_GROUPS")
      .concat("AAIS_OIDC_ADMIN_EMAILS")
      .map((name) => ({
        name,
        environments: ["Production"],
      }));

    const report = await verifyAaisVercelEnvironment({
      authMode: "sso-only",
      now: new Date("2026-06-30T06:00:00.000Z"),
      rows,
    });

    expect(report.status).toBe("passed");
    expect(report.required.missing).toEqual([]);
    expect(report.required.present).toContain("AAIS_OIDC_ADMIN_EMAILS");
    expect(report.required.present).not.toContain("AAIS_OIDC_TEACHER_GROUPS");
    expect(report.categories.oidcRoleMapping).toEqual([]);
    expect(report.oidcRoleMapping).toEqual({
      present: true,
      sourceEnv: "AAIS_OIDC_ADMIN_EMAILS",
      acceptedNames: acceptedOidcRoleMappingEnvNames,
    });
  });

  it("fails with a redacted missing-variable inventory when production only has LRS variables", async () => {
    const report = await verifyAaisVercelEnvironment({
      authMode: "sso-only",
      now: new Date("2026-06-30T06:00:00.000Z"),
      envListText: `
 name               value               environments        created
 LRS_PASSWORD       Encrypted           Production          11h ago
 LRS_USERNAME       Encrypted           Production          11h ago
 LRS_ENDPOINT       Encrypted           Production          11h ago
      `,
    });

    expect(report.status).toBe("failed");
    expect(report.target).toEqual({
      environment: "Production",
      authMode: "sso-only",
      aiMode: "live",
    });
    expect(report.required.present).toEqual(["LRS_ENDPOINT", "LRS_USERNAME", "LRS_PASSWORD"]);
    expect(report.required.missing).toEqual(
      requiredProductionEnv.filter((name) => !name.startsWith("LRS_")),
    );
    expect(report.categories).toMatchObject({
      core: [
        "AAIS_SESSION_SECRET",
        "AAIS_PRODUCT_PSEUDONYM_SECRET",
        "AAIS_RELEASE_ID",
        "AAIS_DEPLOYMENT_GIT_COMMIT_SHA",
      ],
      storage: ["AAIS_DATABASE_URL", "AAIS_DATABASE_PROVIDER"],
      releaseMode: ["AAIS_TRIAL_LOGIN_ENABLED"],
      oidc: [
        "AAIS_OIDC_ISSUER",
        "AAIS_OIDC_CLIENT_ID",
        "AAIS_OIDC_CLIENT_SECRET",
        "AAIS_OIDC_REDIRECT_URI",
      ],
      oidcRoleMapping: ["AAIS_OIDC_TEACHER_GROUPS"],
      ai: [
        "AAIS_AI_PROVIDER",
        "AAIS_AI_ENDPOINT",
        "AAIS_AI_API_KEY",
        "AAIS_AI_MODEL",
        "AAIS_AI_EVAL_APPROVED",
        "AAIS_AI_EVAL_VERSION",
        "AAIS_AI_EVAL_MANIFEST_PATH",
      ],
      lrs: ["CRON_SECRET"],
    });
    expect(report.storageUrl).toEqual({
      present: false,
      sourceEnv: null,
      acceptedNames: acceptedStorageEnvNames,
    });
    expect(report.aiEvalManifest).toEqual({
      present: false,
      sourceEnv: null,
      acceptedNames: ["AAIS_AI_EVAL_MANIFEST_PATH", "AAIS_AI_EVAL_MANIFEST_JSON"],
    });
    expect(report.provisioningPlan).toEqual({
      status: "required",
      environment: "Production",
      actions: [
        {
          category: "core",
          missing: [
            "AAIS_SESSION_SECRET",
            "AAIS_PRODUCT_PSEUDONYM_SECRET",
            "AAIS_RELEASE_ID",
            "AAIS_DEPLOYMENT_GIT_COMMIT_SHA",
          ],
          commands: [
            "vercel env add AAIS_SESSION_SECRET production",
            "vercel env add AAIS_PRODUCT_PSEUDONYM_SECRET production",
            "vercel env add AAIS_RELEASE_ID production",
            "vercel env add AAIS_DEPLOYMENT_GIT_COMMIT_SHA production",
          ],
          note: "Set these Vercel Production variables from the owner-approved secret source, then rerun the verifier.",
        },
        {
          category: "storage",
          missing: ["AAIS_DATABASE_URL", "AAIS_DATABASE_PROVIDER"],
          commands: [
            "vercel env add AAIS_DATABASE_URL production",
            "vercel env add AAIS_DATABASE_PROVIDER production",
          ],
          note: "Use the Neon production Postgres connection string. AAIS prefers AAIS_DATABASE_URL but also accepts Vercel/Neon DATABASE_URL, POSTGRES_URL, POSTGRES_PRISMA_URL, POSTGRES_URL_NO_SSL, DATABASE_URL_UNPOOLED, POSTGRES_URL_NON_POOLING, raw PGHOST/PGUSER/PGDATABASE/PGPASSWORD pieces, or legacy POSTGRES_HOST/POSTGRES_USER/POSTGRES_DATABASE/POSTGRES_PASSWORD pieces; set AAIS_DATABASE_PROVIDER to neon when the host cannot be inspected here.",
        },
        {
          category: "releaseMode",
          missing: ["AAIS_TRIAL_LOGIN_ENABLED"],
          commands: ["vercel env add AAIS_TRIAL_LOGIN_ENABLED production"],
          note: "Current-stage AAIS uses trial auth in production; set AAIS_TRIAL_ACCOUNTS_JSON for the trial gate, and only set AAIS_TRIAL_LOGIN_ENABLED to false after enterprise SSO access is verified.",
        },
        {
          category: "oidc",
          missing: [
            "AAIS_OIDC_ISSUER",
            "AAIS_OIDC_CLIENT_ID",
            "AAIS_OIDC_CLIENT_SECRET",
            "AAIS_OIDC_REDIRECT_URI",
          ],
          commands: [
            "vercel env add AAIS_OIDC_ISSUER production",
            "vercel env add AAIS_OIDC_CLIENT_ID production",
            "vercel env add AAIS_OIDC_CLIENT_SECRET production",
            "vercel env add AAIS_OIDC_REDIRECT_URI production",
          ],
          note: "Use the enterprise IdP issuer, client, secret, and production callback URL. AAIS discovers provider endpoints from the issuer unless explicit endpoint variables are supplied.",
        },
        {
          category: "oidcRoleMapping",
          missing: ["AAIS_OIDC_TEACHER_GROUPS"],
          commands: ["vercel env add AAIS_OIDC_TEACHER_GROUPS production"],
          note: "Configure at least one verified teacher/admin OIDC role mapping so SSO-only cohort analytics can authorize educator sessions. AAIS accepts AAIS_OIDC_TEACHER_GROUPS, AAIS_OIDC_TEACHER_EMAILS, AAIS_OIDC_ADMIN_GROUPS, or AAIS_OIDC_ADMIN_EMAILS.",
        },
        {
          category: "ai",
          missing: [
            "AAIS_AI_PROVIDER",
            "AAIS_AI_ENDPOINT",
            "AAIS_AI_API_KEY",
            "AAIS_AI_MODEL",
            "AAIS_AI_EVAL_APPROVED",
            "AAIS_AI_EVAL_VERSION",
            "AAIS_AI_EVAL_MANIFEST_PATH",
          ],
          commands: [
            "vercel env add AAIS_AI_PROVIDER production",
            "vercel env add AAIS_AI_ENDPOINT production",
            "vercel env add AAIS_AI_API_KEY production",
            "vercel env add AAIS_AI_MODEL production",
            "vercel env add AAIS_AI_EVAL_APPROVED production",
            "vercel env add AAIS_AI_EVAL_VERSION production",
            "vercel env add AAIS_AI_EVAL_MANIFEST_PATH production",
            "vercel env add AAIS_AI_EVAL_MANIFEST_JSON production",
          ],
          note: "Use the reviewed live-AI provider, model, approval flag, eval version, and either a server-readable eval manifest path or a redacted inline eval manifest JSON.",
        },
        {
          category: "lrs",
          missing: ["CRON_SECRET"],
          commands: ["vercel env add CRON_SECRET production"],
          note: "Use a long random value so Vercel Cron can call the persistent LRS outbox drain with Authorization: Bearer <CRON_SECRET> without exposing the token in reports.",
        },
      ],
      redaction: {
        values: "not-included",
      },
    });
    expect(JSON.stringify(report)).not.toContain("Encrypted");
    expect(report.redaction).toEqual({
      secrets: "omitted",
      values: "not-read",
    });
  });

  it("fails the LRS operations category when CRON_SECRET is missing", async () => {
    const rows = requiredProductionEnv
      .filter((name) => name !== "CRON_SECRET")
      .map((name) => ({
        name,
        environments: ["Production"],
      }));

    const report = await verifyAaisVercelEnvironment({
      authMode: "sso-only",
      now: new Date("2026-06-30T06:00:00.000Z"),
      rows,
    });

    expect(report.status).toBe("failed");
    expect(report.categories.lrs).toEqual(["CRON_SECRET"]);
    expect(report.provisioningPlan.actions).toContainEqual({
      category: "lrs",
      missing: ["CRON_SECRET"],
      commands: ["vercel env add CRON_SECRET production"],
      note: "Use a long random value so Vercel Cron can call the persistent LRS outbox drain with Authorization: Bearer <CRON_SECRET> without exposing the token in reports.",
    });
  });

  it("does not require live-AI variables when deterministic AI mode is requested explicitly", async () => {
    const nonAiEnv = requiredProductionEnv
      .filter((name) => !name.startsWith("AAIS_AI_"))
      .map((name) => ({
        name,
        environments: ["Production"],
      }));

    const report = await verifyAaisVercelEnvironment({
      authMode: "sso-only",
      aiMode: "deterministic",
      now: new Date("2026-06-30T06:00:00.000Z"),
      rows: nonAiEnv,
    });

    expect(report.status).toBe("passed");
    expect(report.categories.ai).toEqual([]);
  });

  it("requires trial accounts instead of SSO-only mode when trial auth mode is requested explicitly", async () => {
    const trialEnv = requiredProductionEnv
      .filter((name) => name !== "AAIS_TRIAL_LOGIN_ENABLED")
      .filter((name) => !name.startsWith("AAIS_OIDC_"))
      .concat("AAIS_TRIAL_ACCOUNTS_JSON")
      .map((name) => ({
        name,
        environments: ["Production"],
      }));

    const report = await verifyAaisVercelEnvironment({
      authMode: "trial",
      now: new Date("2026-06-30T06:00:00.000Z"),
      rows: trialEnv,
    });

    expect(report.status).toBe("passed");
    expect(report.required.present).toContain("AAIS_TRIAL_ACCOUNTS_JSON");
    expect(report.required.present).not.toContain("AAIS_TRIAL_LOGIN_ENABLED");
    expect(report.required.present).not.toContain("AAIS_OIDC_ISSUER");
    expect(report.categories.oidc).toEqual([]);
    expect(report.categories.oidcRoleMapping).toEqual([]);
  });
});
