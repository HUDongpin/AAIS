import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluateAaisVercelProductionDeploy,
  getAaisProductCronScheduleState,
  hasAllAaisProductCronSchedules,
} from "../scripts/guard-vercel-production-deploy.mjs";

const fullGitSha = "0123456789abcdef0123456789abcdef01234567";
const validServerActionsKey = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");
const validCronSecret = "AAIS-cron-secret-2026-08-31-7cY4vN9pQ2mK";

function validProductionEnv(overrides = {}) {
  return {
    VERCEL: "1",
    VERCEL_ENV: "production",
    AAIS_DEPLOYMENT_PROVIDER: "vercel",
    VERCEL_GIT_COMMIT_REF: "main",
    VERCEL_GIT_COMMIT_SHA: fullGitSha,
    VERCEL_GIT_PROVIDER: "github",
    AAIS_RUNTIME_LEASE_SCHEMA_CONFIRMED: "true",
    AAIS_DATABASE_URL:
      "postgres://aais_app_vercel:valid-db-password-2026@ep-example.neon.tech/aais?sslmode=verify-full",
    AAIS_DATABASE_PROVIDER: "neon",
    AAIS_DATABASE_DRIVER: "pg",
    AAIS_DATABASE_POOL_MAX: "2",
    AAIS_DATABASE_TARGET_ID: "aais-neon-production",
    AAIS_RESEARCH_MODE: "false",
    AAIS_RESEARCH_REQUIRED: "false",
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: validServerActionsKey,
    CRON_SECRET: validCronSecret,
    ...overrides,
  };
}

describe("AAIS Vercel production deploy guard", () => {
  it("does not block local builds", () => {
    const report = evaluateAaisVercelProductionDeploy({ env: {} });

    expect(report.status).toBe("skipped");
    expect(report.reason).toBe("AAIS_NOT_RUNNING_ON_VERCEL");
  });

  it("allows non-production Vercel builds", () => {
    const report = evaluateAaisVercelProductionDeploy({
      env: {
        VERCEL: "1",
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_REF: "codex/advisory-fixes",
      },
    });

    expect(report.status).toBe("passed");
    expect(report.reason).toBe("AAIS_NON_PRODUCTION_VERCEL_BUILD");
  });

  it("allows production Vercel builds from Git-connected main", () => {
    const report = evaluateAaisVercelProductionDeploy({
      env: validProductionEnv(),
    });

    expect(report.status).toBe("passed");
    expect(report.reason).toBe("AAIS_PRODUCTION_DEPLOY_GIT_MAIN_CONFIRMED");
    expect(report.issues).toEqual([]);
  });

  it("blocks cron-free production builds", () => {
    const report = evaluateAaisVercelProductionDeploy({
      productCronScheduleState: "removed",
      env: validProductionEnv(),
    });

    expect(report.status).toBe("failed");
    expect(report.reason).toBe("AAIS_PRODUCTION_DEPLOY_SCHEDULER_STATE_INVALID");
    expect(report.issues).toEqual([
      "AAIS_PRODUCTION_DEPLOY_REQUIRES_EXACT_VERCEL_PRODUCT_CRONS",
    ]);
  });

  it("does not let an Aliyun scheduler marker authorize cron removal", () => {
    const report = evaluateAaisVercelProductionDeploy({
      productCronScheduleState: "removed",
      env: validProductionEnv({
        AAIS_ALIYUN_PRIMARY_SCHEDULERS_CONFIRMED: "true",
      }),
    });

    expect(report.status).toBe("failed");
    expect(report.reason).toBe("AAIS_PRODUCTION_DEPLOY_SCHEDULER_STATE_INVALID");
    expect(report.checks.productCronScheduleState).toBe("removed");
    expect(report.issues).toEqual([
      "AAIS_PRODUCTION_DEPLOY_REQUIRES_EXACT_VERCEL_PRODUCT_CRONS",
    ]);
  });

  it("blocks the lease-aware production build until migrations and target identity are evidenced", () => {
    const report = evaluateAaisVercelProductionDeploy({
      env: validProductionEnv({
        AAIS_RUNTIME_LEASE_SCHEMA_CONFIRMED: undefined,
      }),
    });

    expect(report.status).toBe("failed");
    expect(report.reason).toBe(
      "AAIS_PRODUCTION_DEPLOY_RUNTIME_LEASE_SCHEMA_NOT_CONFIRMED",
    );
    expect(report.issues).toEqual([
      "AAIS_PRODUCTION_DEPLOY_REQUIRES_RUNTIME_LEASE_SCHEMA",
    ]);
  });

  it("blocks production Vercel builds without Git main metadata", () => {
    const report = evaluateAaisVercelProductionDeploy({
      env: validProductionEnv({
        VERCEL_GIT_COMMIT_REF: "codex/manual-upload",
        VERCEL_GIT_COMMIT_SHA: undefined,
        VERCEL_GIT_PROVIDER: undefined,
      }),
    });

    expect(report.status).toBe("failed");
    expect(report.reason).toBe("AAIS_PRODUCTION_DEPLOY_NOT_GIT_MAIN");
    expect(report.issues).toEqual([
      "AAIS_PRODUCTION_DEPLOY_REQUIRES_MAIN_GIT_REF",
      "AAIS_PRODUCTION_DEPLOY_REQUIRES_GIT_COMMIT_SHA",
      "AAIS_PRODUCTION_DEPLOY_REQUIRES_GIT_PROVIDER",
    ]);
  });

  it("rejects a partial product-cron configuration", () => {
    const partialConfig = {
      crons: [
        {
          path: "/api/learning/lrs/outbox/flush",
          schedule: "*/2 * * * *",
        },
      ],
    };
    expect(hasAllAaisProductCronSchedules(partialConfig)).toBe(false);
    expect(getAaisProductCronScheduleState(partialConfig)).toBe("partial");
  });

  it("rejects a product Cron with the wrong schedule", () => {
    expect(getAaisProductCronScheduleState({
      crons: [
        {
          path: "/api/learning/lrs/outbox/flush",
          schedule: "*/5 * * * *",
        },
        {
          path: "/api/auth/email-outbox/flush",
          schedule: "*/2 * * * *",
        },
      ],
    })).toBe("partial");
  });

  it("keeps both Vercel product crons after the Aliyun handoff", () => {
    const report = evaluateAaisVercelProductionDeploy({
      env: validProductionEnv({
        AAIS_ALIYUN_PRIMARY_SCHEDULERS_CONFIRMED: "true",
      }),
    });

    expect(report.status).toBe("passed");
    expect(report.reason).toBe("AAIS_PRODUCTION_DEPLOY_GIT_MAIN_CONFIRMED");
    expect(report.issues).toEqual([]);
  });

  it("blocks production when a Vercel database alias remains configured", () => {
    const report = evaluateAaisVercelProductionDeploy({
      env: validProductionEnv({
        DATABASE_URL: "postgres://must-not-be-reported@legacy.example.test/aais",
      }),
    });

    expect(report.status).toBe("failed");
    expect(report.reason).toBe("AAIS_PRODUCTION_DEPLOY_DATABASE_BINDING_INVALID");
    expect(report.checks.forbiddenDatabaseBindings).toEqual(["DATABASE_URL"]);
    expect(JSON.stringify(report)).not.toContain("must-not-be-reported");
    expect(report.issues).toContain(
      "AAIS_PRODUCTION_DEPLOY_REQUIRES_ONLY_AAIS_DATABASE_URL",
    );
  });

  it("blocks a malformed canonical Neon production binding without reporting its value", () => {
    const report = evaluateAaisVercelProductionDeploy({
      env: validProductionEnv({
        AAIS_DATABASE_URL: "postgres://secret@evil.example.test/aais?sslmode=require",
      }),
    });

    expect(report.status).toBe("failed");
    expect(report.reason).toBe("AAIS_PRODUCTION_DEPLOY_DATABASE_BINDING_INVALID");
    expect(report.checks.canonicalDatabaseBindingConfigured).toBe(true);
    expect(report.checks.canonicalDatabaseBindingValid).toBe(false);
    expect(JSON.stringify(report)).not.toContain("evil.example.test");
    expect(JSON.stringify(report)).not.toContain("secret");
  });

  it("blocks a Vercel production build that claims to be the Aliyun provider", () => {
    const report = evaluateAaisVercelProductionDeploy({
      env: validProductionEnv({
        AAIS_DEPLOYMENT_PROVIDER: "aliyun",
      }),
    });

    expect(report.status).toBe("failed");
    expect(report.reason).toBe("AAIS_PRODUCTION_DEPLOY_PROVIDER_INVALID");
    expect(report.issues).toContain(
      "AAIS_PRODUCTION_DEPLOY_REQUIRES_VERCEL_PROVIDER",
    );
  });

  it.each([undefined, "5", "20"])(
    "blocks a Vercel production pool max of %s",
    (poolMax) => {
      const report = evaluateAaisVercelProductionDeploy({
        env: validProductionEnv({ AAIS_DATABASE_POOL_MAX: poolMax }),
      });

      expect(report.status).toBe("failed");
      expect(report.reason).toBe("AAIS_PRODUCTION_DEPLOY_DATABASE_CONTRACT_INVALID");
      expect(report.checks.databasePoolMaxValid).toBe(false);
      expect(report.issues).toContain(
        "AAIS_PRODUCTION_DEPLOY_REQUIRES_DATABASE_POOL_MAX_2",
      );
    },
  );

  it.each([undefined, "x", "unsafe target/id"])(
    "blocks a missing or malformed database target ID of %s",
    (targetId) => {
      const report = evaluateAaisVercelProductionDeploy({
        env: validProductionEnv({ AAIS_DATABASE_TARGET_ID: targetId }),
      });

      expect(report.status).toBe("failed");
      expect(report.reason).toBe("AAIS_PRODUCTION_DEPLOY_DATABASE_CONTRACT_INVALID");
      expect(report.checks.databaseTargetIdValid).toBe(false);
      expect(JSON.stringify(report)).not.toContain("unsafe target/id");
    },
  );

  it.each([
    { AAIS_RESEARCH_MODE: "true" },
    { AAIS_RESEARCH_REQUIRED: "true" },
    { AAIS_RESEARCH_MODE: undefined },
  ])("keeps the production research plane disabled", (override) => {
    const report = evaluateAaisVercelProductionDeploy({
      env: validProductionEnv(override),
    });

    expect(report.status).toBe("failed");
    expect(report.reason).toBe("AAIS_PRODUCTION_DEPLOY_RESEARCH_BOUNDARY_INVALID");
    expect(report.checks.researchDisabled).toBe(false);
  });

  it("requires the dedicated Vercel runtime database role", () => {
    const report = evaluateAaisVercelProductionDeploy({
      env: validProductionEnv({
        AAIS_DATABASE_URL:
          "postgres://legacy_owner:valid-db-password-2026@ep-example.neon.tech/aais?sslmode=verify-full",
      }),
    });

    expect(report.status).toBe("failed");
    expect(report.reason).toBe("AAIS_PRODUCTION_DEPLOY_DATABASE_BINDING_INVALID");
    expect(report.checks.canonicalDatabaseBindingValid).toBe(false);
    expect(JSON.stringify(report)).not.toContain("legacy_owner");
  });

  it.each(["AAIS_RELEASE_ID", "AAIS_DEPLOYMENT_GIT_COMMIT_SHA"])(
    "rejects stale static release metadata in %s",
    (name) => {
      const report = evaluateAaisVercelProductionDeploy({
        env: validProductionEnv({ [name]: "a".repeat(40) }),
      });

      expect(report.status).toBe("failed");
      expect(report.reason).toBe("AAIS_PRODUCTION_DEPLOY_RELEASE_METADATA_INVALID");
      expect(report.checks.providerOwnedReleaseMetadata).toBe(false);
    },
  );

  it.each([undefined, "main", "a".repeat(39)])(
    "rejects a non-full Vercel Git SHA of %s",
    (gitSha) => {
      const report = evaluateAaisVercelProductionDeploy({
        env: validProductionEnv({ VERCEL_GIT_COMMIT_SHA: gitSha }),
      });

      expect(report.status).toBe("failed");
      expect(report.reason).toBe("AAIS_PRODUCTION_DEPLOY_NOT_GIT_MAIN");
      expect(report.checks.gitShaValid).toBe(false);
    },
  );

  it.each([undefined, "gitlab", "GitHub Enterprise"])(
    "requires the exact GitHub provider metadata for %s",
    (gitProvider) => {
      const report = evaluateAaisVercelProductionDeploy({
        env: validProductionEnv({ VERCEL_GIT_PROVIDER: gitProvider }),
      });

      expect(report.status).toBe("failed");
      expect(report.reason).toBe("AAIS_PRODUCTION_DEPLOY_NOT_GIT_MAIN");
      expect(report.checks.gitProviderValid).toBe(false);
    },
  );

  it.each([
    undefined,
    "not-base64",
    Buffer.from("too-short", "utf8").toString("base64"),
  ])("requires a canonical 32-byte Server Actions encryption key", (key) => {
    const report = evaluateAaisVercelProductionDeploy({
      env: validProductionEnv({ NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: key }),
    });

    expect(report.status).toBe("failed");
    expect(report.reason).toBe("AAIS_PRODUCTION_DEPLOY_SERVER_ACTIONS_KEY_INVALID");
    expect(report.checks.serverActionsEncryptionKeyValid).toBe(false);
    expect(JSON.stringify(report)).not.toContain("not-base64");
  });

  it.each([undefined, "short", "x".repeat(64), "change-me-to-a-production-secret-value-now"])(
    "requires a strong Vercel Cron secret",
    (cronSecret) => {
      const report = evaluateAaisVercelProductionDeploy({
        env: validProductionEnv({ CRON_SECRET: cronSecret }),
      });

      expect(report.status).toBe("failed");
      expect(report.reason).toBe("AAIS_PRODUCTION_DEPLOY_WORKER_AUTH_INVALID");
      expect(report.checks.cronSecretValid).toBe(false);
      expect(JSON.stringify(report)).not.toContain("change-me-to-a-production-secret-value-now");
    },
  );

  it.each([
    "AAIS_LRS_OUTBOX_FLUSH_TOKEN",
    "AAIS_AUTH_EMAIL_OUTBOX_FLUSH_TOKEN",
  ])("forbids the Aliyun-only worker token %s on Vercel", (name) => {
    const report = evaluateAaisVercelProductionDeploy({
      env: validProductionEnv({
        [name]: "Aliyun-only-worker-token-2026-08-31-q7F4nP9c",
      }),
    });

    expect(report.status).toBe("failed");
    expect(report.reason).toBe("AAIS_PRODUCTION_DEPLOY_WORKER_AUTH_INVALID");
    expect(report.checks.forbiddenWorkerTokenBindings).toEqual([name]);
    expect(JSON.stringify(report)).not.toContain("Aliyun-only-worker-token");
  });

  it("treats a query-string worker schedule as a product Cron reintroduction", () => {
    expect(getAaisProductCronScheduleState({
      crons: [
        {
          path: "/api/auth/email-outbox/flush?source=vercel-cron",
          schedule: "*/2 * * * *",
        },
      ],
    })).toBe("partial");
  });

  it("rejects additional schedules beyond the two exact product Crons", () => {
    const vercelConfig = JSON.parse(readFileSync("vercel.json", "utf8"));

    expect(getAaisProductCronScheduleState({
      crons: [
        ...vercelConfig.crons,
        {
          path: "/api/system/readiness",
          schedule: "0 * * * *",
        },
      ],
    })).toBe("partial");
  });

  it("wires the guard into the Vercel build command", () => {
    const vercelConfig = JSON.parse(readFileSync("vercel.json", "utf8"));
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const vercelIgnore = readFileSync(".vercelignore", "utf8");
    const packageScripts = Object.values(packageJson.scripts ?? {}).join("\n");

    expect(vercelConfig.buildCommand).toBe(
      "node -- scripts/guard-vercel-production-deploy.mjs && npm run build",
    );
    expect(hasAllAaisProductCronSchedules(vercelConfig)).toBe(true);
    expect(vercelConfig.crons).toHaveLength(2);
    expect(vercelIgnore).toMatch(/^\/\*\.docx$/m);
    expect(vercelIgnore).toMatch(/^docs\/figures\/$/m);
    expect(packageScripts).not.toContain("vercel deploy --prod");
  });

  it("keeps dynamic file-store paths out of Next server trace expansion", () => {
    const learningStoreSource = readFileSync(
      "src/lib/server/aais-learning-store.ts",
      "utf8",
    );

    expect(learningStoreSource).not.toContain(
      'path.join(process.cwd(), ".aais-data")',
    );
    expect(learningStoreSource.match(/\/\*turbopackIgnore: true\*\//g)?.length ?? 0)
      .toBeGreaterThanOrEqual(7);
  });
});
