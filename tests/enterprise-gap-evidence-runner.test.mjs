import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAaisEnterpriseGapEvidence } from "../scripts/run-enterprise-gap-evidence.mjs";

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-enterprise-gaps-"));
});

afterEach(async () => {
  await rm(tempDir, { force: true, recursive: true });
});

describe("AAIS enterprise gap evidence runner", () => {
  it("is exposed through a package script", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));

    expect(packageJson.scripts["verify:enterprise-gaps"]).toBe(
      "node -- scripts/run-enterprise-gap-evidence.mjs",
    );
  });

  it("fails closed when transient OIDC callback evidence is still a placeholder", async () => {
    const envFilePath = path.join(tempDir, "enterprise-smoke.env");
    const outputPath = path.join(tempDir, "gap-report.json");
    await writeFile(envFilePath, [
      "AAIS_VERIFY_BASE_URL=https://aais.example.test",
      "AAIS_VERIFY_OIDC_CALLBACK_URL=<REQUIRED:TRANSIENT_TEACHER_OR_ADMIN_OIDC_CALLBACK_URL>",
      "AAIS_VERIFY_OIDC_STATE_COOKIE=<REQUIRED:TRANSIENT_OIDC_STATE_COOKIE>",
      "AAIS_VERIFY_EXPECTED_SESSION_ROLE=<REQUIRED:TEACHER_OR_ADMIN_SESSION_ROLE>",
      "",
    ].join("\n"), "utf8");

    const report = await runAaisEnterpriseGapEvidence({
      mode: "cohort-sso",
      envFilePath,
      outputPath,
      now: new Date("2026-07-01T10:30:00.000Z"),
      enterpriseVerifier: async () => {
        throw new Error("should not run with placeholder callback evidence");
      },
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "action-required",
      generatedAt: "2026-07-01T10:30:00.000Z",
      mode: "cohort-sso",
      preflight: {
        status: "action-required",
        required: {
          missing: [],
          placeholders: [
            "AAIS_VERIFY_OIDC_CALLBACK_URL",
            "AAIS_VERIFY_OIDC_STATE_COOKIE",
            "AAIS_VERIFY_EXPECTED_SESSION_ROLE",
          ],
        },
        oidcTransientEvidence: {
          callbackUrlPresent: true,
          stateCookiePresent: true,
          expectedSessionRole: "unknown",
          expectedEducatorRole: false,
        },
      },
      redaction: {
        secrets: "omitted",
        transientEvidence: "presence-only",
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("TRANSIENT_TEACHER_OR_ADMIN");
    expect(serialized).not.toContain("TRANSIENT_OIDC_STATE_COOKIE");
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(report);
  });

  it("fails closed when cohort SSO evidence does not declare a teacher/admin session role", async () => {
    const envFilePath = path.join(tempDir, "enterprise-smoke.env");
    const outputPath = path.join(tempDir, "gap-report.json");
    await writeFile(envFilePath, [
      "AAIS_VERIFY_BASE_URL=https://aais.example.test",
      "AAIS_VERIFY_OIDC_CALLBACK_URL=https://aais.example.test/api/auth/oidc/callback?code=secret-code&state=secret-state",
      "AAIS_VERIFY_OIDC_STATE_COOKIE=secret-state-cookie",
      "",
    ].join("\n"), "utf8");

    const missingRoleReport = await runAaisEnterpriseGapEvidence({
      mode: "cohort-sso",
      envFilePath,
      outputPath,
      now: new Date("2026-07-01T10:35:00.000Z"),
      enterpriseVerifier: async () => {
        throw new Error("should not run without expected educator role evidence");
      },
    });

    expect(missingRoleReport.preflight.required).toMatchObject({
      missing: ["AAIS_VERIFY_EXPECTED_SESSION_ROLE"],
      placeholders: [],
      invalid: [],
    });

    await writeFile(envFilePath, [
      "AAIS_VERIFY_BASE_URL=https://aais.example.test",
      "AAIS_VERIFY_OIDC_CALLBACK_URL=https://aais.example.test/api/auth/oidc/callback?code=secret-code&state=secret-state",
      "AAIS_VERIFY_OIDC_STATE_COOKIE=secret-state-cookie",
      "AAIS_VERIFY_EXPECTED_SESSION_ROLE=student",
      "",
    ].join("\n"), "utf8");

    const studentRoleReport = await runAaisEnterpriseGapEvidence({
      mode: "cohort-sso",
      envFilePath,
      outputPath,
      now: new Date("2026-07-01T10:36:00.000Z"),
      enterpriseVerifier: async () => {
        throw new Error("should not run with a student expected role");
      },
    });

    expect(studentRoleReport.preflight.required).toMatchObject({
      missing: [],
      placeholders: [],
      invalid: ["AAIS_VERIFY_EXPECTED_SESSION_ROLE"],
    });
    expect(studentRoleReport.preflight.oidcTransientEvidence).toMatchObject({
      expectedSessionRole: "student",
      expectedEducatorRole: false,
    });
  });

  it("combines enterprise and restore evidence without serializing secrets", async () => {
    const envFilePath = path.join(tempDir, "enterprise-smoke.env");
    const restoreEnvFilePath = path.join(tempDir, "restore.env");
    const aiEvalEnvFilePath = path.join(tempDir, "ai-eval.env");
    const outputPath = path.join(tempDir, "gap-report.json");
    const enterpriseOutputPath = path.join(tempDir, "enterprise.json");
    const restoreOutputPath = path.join(tempDir, "restore.json");
    const aiEvalOutputPath = path.join(tempDir, "ai-eval.json");
    const aiEvalInlineOutputPath = path.join(tempDir, "ai-eval-inline.json");
    const sourceEnvFilePath = path.join(tempDir, "production.env");
    await writeFile(envFilePath, [
      "AAIS_VERIFY_BASE_URL=https://aais.example.test",
      "AAIS_VERIFY_TRIAL_ACCOUNT=student-a",
      "AAIS_VERIFY_TRIAL_CORRECT_PASSWORD=trial-secret",
      "AAIS_VERIFY_TRIAL_WRONG_PASSWORD=wrong-secret",
      "AAIS_VERIFY_EDUCATOR_ACCOUNT=teacher-a",
      "AAIS_VERIFY_EDUCATOR_CORRECT_PASSWORD=teacher-secret",
      "AAIS_RELEASE_ID=aais-2026-07-01-rc1",
      "",
    ].join("\n"), "utf8");
    await writeFile(restoreEnvFilePath, [
      "AAIS_RESTORE_DATABASE_URL=postgres://restore-user:restore-secret@ep-restored.us-east-1.aws.neon.tech/aais_restore",
      "AAIS_RESTORE_DATABASE_PROVIDER=neon",
      "AAIS_RESTORE_TARGET_PURPOSE=restored-staging",
      "",
    ].join("\n"), "utf8");
    await writeFile(aiEvalEnvFilePath, [
      "AAIS_AI_ENDPOINT=https://api.secret-provider.example/v1/chat/completions",
      "AAIS_AI_API_KEY=secret-ai-api-key",
      "AAIS_AI_MODEL=deepseek-v4-pro",
      "AAIS_AI_EVAL_VERSION=aais-a1-a4-ca-eval-v2",
      "",
    ].join("\n"), "utf8");
    const calls = [];

    const report = await runAaisEnterpriseGapEvidence({
      mode: "all",
      envFilePath,
      restoreEnvFilePath,
      sourceEnvFilePath,
      aiEvalEnvFilePath,
      outputPath,
      enterpriseOutputPath,
      restoreOutputPath,
      aiEvalOutputPath,
      aiEvalInlineOutputPath,
      now: new Date("2026-07-01T10:30:00.000Z"),
      enterpriseVerifier: async (input) => {
        calls.push(["enterprise", input]);
        return {
          status: "passed",
          checkedAt: "2026-07-01T10:31:00.000Z",
          checks: [
            { name: "cohort-analytics", status: "passed" },
            { name: "trial-learning-session", status: "passed" },
            { name: "trial-login-throttle", status: "passed" },
          ],
          redaction: {
            secrets: "omitted",
            cookies: "attributes-only",
          },
        };
      },
      restoreVerifier: async (input) => {
        calls.push(["restore", input]);
        return {
          status: "passed",
          checkedAt: "2026-07-01T10:32:00.000Z",
          target: {
            provider: "neon",
            purpose: "restored-staging",
            sameAsSource: false,
            databaseUrl: "redacted",
          },
          checks: {
            tablePresent: true,
            lrsOutboxTablePresent: true,
            smokeInsertOnly: true,
            smokeInserted: true,
            smokeReadBack: true,
            smokeDeleted: true,
          },
          redaction: {
            secrets: "omitted",
          },
        };
      },
      aiEvalRunner: async (input) => {
        calls.push(["live-ai-eval", input]);
        return {
          schemaVersion: 1,
          evalVersion: "aais-a1-a4-ca-eval-v2",
          provider: "openai-compatible",
          model: "deepseek-v4-pro",
          status: "passed",
          passedAt: "2026-07-01T10:33:00.000Z",
          sampleCount: 4,
          blockedCount: 0,
          guardrailPolicy: "aais-age-appropriate-output-v1",
          results: [
            { id: "a1-guide-training", agentId: "A1", status: "passed" },
            { id: "a2-expert-modelling-coaching", agentId: "A2", status: "passed" },
            { id: "a3-supervision-a1-signal", agentId: "A3", status: "passed" },
            { id: "a4-articulation-reflection", agentId: "A4", status: "passed" },
          ],
          agentEvidence: {
            contractVersion: "aais-a1-a4-ca-eval-v2",
            complete: true,
            requiredAgents: ["A1", "A2", "A3", "A4"],
            coveredAgents: ["A1", "A2", "A3", "A4"],
            requiredCaModules: ["Modelling", "Coaching", "Scaffolding", "Fading", "Articulation", "Reflection"],
            coveredCaModules: ["Modelling", "Coaching", "Scaffolding", "Fading", "Articulation", "Reflection"],
            caBackgroundIncluded: true,
            rawPromptsStored: false,
            rawOutputsStored: false,
          },
          redaction: {
            prompts: "summarized",
            secrets: "omitted",
          },
        };
      },
    });

    expect(calls).toHaveLength(3);
    expect(calls[0][1]).toMatchObject({
      baseUrl: "https://aais.example.test",
      releaseId: "aais-2026-07-01-rc1",
      outputPath: enterpriseOutputPath,
      requireSsoOnly: false,
      requireCohortAnalytics: true,
      trialLogin: {
        account: "student-a",
        correctPassword: "trial-secret",
        wrongPassword: "wrong-secret",
        clientIp: expect.stringMatching(/^203\.0\.113\.\d+$/),
        throttleClientIp: expect.stringMatching(/^198\.51\.100\.\d+$/),
      },
      educatorLogin: {
        account: "teacher-a",
        correctPassword: "teacher-secret",
      },
    });
    expect(calls[1][1]).toMatchObject({
      envFilePath: restoreEnvFilePath,
      sourceEnvFilePath,
      outputPath: restoreOutputPath,
      releaseId: "aais-2026-07-01-rc1",
      databaseProvider: "neon",
      targetPurpose: "restored-staging",
    });
    expect(calls[2][1]).toMatchObject({
      envFilePath: aiEvalEnvFilePath,
      outputPath: aiEvalOutputPath,
      envJsonOutputPath: aiEvalInlineOutputPath,
      releaseId: "aais-2026-07-01-rc1",
    });
    expect(report).toMatchObject({
      status: "passed",
      mode: "all",
      outputs: {
        sourceEnvFilePath,
        aiEvalEnvFilePath,
        aiEvalManifestPath: aiEvalOutputPath,
        aiEvalInlineManifestPath: aiEvalInlineOutputPath,
      },
      results: {
        enterprise: {
          status: "passed",
          requiredEvidence: {
            cohortAnalytics: true,
            trialLearningSession: true,
            trialLoginThrottle: true,
          },
        },
        postgresRestore: {
          status: "passed",
          target: {
            provider: "neon",
            purpose: "restored-staging",
            databaseUrl: "redacted",
          },
        },
        liveAiEval: {
          status: "passed",
          sampleCount: 4,
          blockedCount: 0,
          agentEvidence: {
            contractVersion: "aais-a1-a4-ca-eval-v2",
            complete: true,
            coveredAgents: ["A1", "A2", "A3", "A4"],
            caBackgroundIncluded: true,
            rawPromptsStored: false,
            rawOutputsStored: false,
          },
        },
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("trial-secret");
    expect(serialized).not.toContain("wrong-secret");
    expect(serialized).not.toContain("teacher-secret");
    expect(serialized).not.toContain("restore-secret");
    expect(serialized).not.toContain("ep-restored.us-east-1.aws.neon.tech");
    expect(serialized).not.toContain("secret-ai-api-key");
    expect(serialized).not.toContain("api.secret-provider.example");
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(report);
  });

  it("supports preflight-only mode without consuming transient OIDC evidence or touching restore databases", async () => {
    const envFilePath = path.join(tempDir, "enterprise-smoke.env");
    const restoreEnvFilePath = path.join(tempDir, "restore.env");
    const aiEvalEnvFilePath = path.join(tempDir, "ai-eval.env");
    const outputPath = path.join(tempDir, "gap-preflight.json");
    await writeFile(envFilePath, [
      "AAIS_VERIFY_BASE_URL=https://aais.example.test",
      "AAIS_VERIFY_TRIAL_ACCOUNT=student-a",
      "AAIS_VERIFY_TRIAL_CORRECT_PASSWORD=trial-secret",
      "AAIS_VERIFY_TRIAL_WRONG_PASSWORD=wrong-secret",
      "AAIS_VERIFY_EDUCATOR_ACCOUNT=teacher-a",
      "AAIS_VERIFY_EDUCATOR_CORRECT_PASSWORD=teacher-secret",
      "AAIS_RELEASE_ID=aais-2026-07-01-rc1",
      "",
    ].join("\n"), "utf8");
    await writeFile(restoreEnvFilePath, [
      "AAIS_RESTORE_DATABASE_URL=postgres://restore-user:restore-secret@ep-restored.us-east-1.aws.neon.tech/aais_restore",
      "AAIS_RESTORE_DATABASE_PROVIDER=neon",
      "AAIS_RESTORE_TARGET_PURPOSE=restored-staging",
      "",
    ].join("\n"), "utf8");
    await writeFile(aiEvalEnvFilePath, [
      "AAIS_AI_ENDPOINT=https://api.secret-provider.example/v1/chat/completions",
      "AAIS_AI_API_KEY=secret-ai-api-key",
      "AAIS_AI_MODEL=deepseek-v4-pro",
      "AAIS_AI_EVAL_VERSION=aais-a1-a4-ca-eval-v2",
      "",
    ].join("\n"), "utf8");

    const report = await runAaisEnterpriseGapEvidence({
      mode: "all",
      envFilePath,
      restoreEnvFilePath,
      aiEvalEnvFilePath,
      outputPath,
      preflightOnly: true,
      now: new Date("2026-07-01T10:40:00.000Z"),
      enterpriseVerifier: async () => {
        throw new Error("preflight-only must not run OIDC callback smoke");
      },
      restoreVerifier: async () => {
        throw new Error("preflight-only must not open the restore database");
      },
      aiEvalRunner: async () => {
        throw new Error("preflight-only must not call the live AI provider");
      },
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "preflight-ready",
      generatedAt: "2026-07-01T10:40:00.000Z",
      mode: "all",
      preflightOnly: true,
      preflight: {
        status: "ready",
        required: {
          missing: [],
          placeholders: [],
          invalid: [],
        },
        oidcTransientEvidence: null,
        trialAuthEvidence: {
          trialAccountPresent: true,
          trialPasswordPresent: true,
          educatorAccountPresent: true,
          educatorPasswordPresent: true,
        },
        restoreEvidence: {
          databaseUrlPresent: true,
          databaseUrlPlaceholder: false,
          targetPurpose: "restored-staging",
          provider: "neon",
        },
        liveAiEvalEvidence: {
          endpointPresent: true,
          endpointHttps: true,
          apiKeyPresent: true,
          modelPresent: true,
          evalVersionPresent: true,
        },
      },
      results: {},
      redaction: {
        secrets: "omitted",
        transientEvidence: "presence-only",
        databaseUrls: "redacted",
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("trial-secret");
    expect(serialized).not.toContain("wrong-secret");
    expect(serialized).not.toContain("teacher-secret");
    expect(serialized).not.toContain("restore-secret");
    expect(serialized).not.toContain("ep-restored.us-east-1.aws.neon.tech");
    expect(serialized).not.toContain("secret-ai-api-key");
    expect(serialized).not.toContain("api.secret-provider.example");
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(report);
  });

  it("fails closed when live AI eval provider evidence is missing or placeholder", async () => {
    const aiEvalEnvFilePath = path.join(tempDir, "ai-eval.env");
    const outputPath = path.join(tempDir, "gap-ai-eval.json");
    await writeFile(aiEvalEnvFilePath, [
      "AAIS_AI_ENDPOINT=<REQUIRED:OPENAI_COMPATIBLE_ENDPOINT>",
      "AAIS_AI_MODEL=deepseek-v4-flash",
      "AAIS_AI_EVAL_VERSION=aais-a1-a4-ca-eval-v2",
      "",
    ].join("\n"), "utf8");

    const report = await runAaisEnterpriseGapEvidence({
      mode: "live-ai-eval",
      aiEvalEnvFilePath,
      outputPath,
      now: new Date("2026-07-01T10:45:00.000Z"),
      aiEvalRunner: async () => {
        throw new Error("should not call provider without a complete env file");
      },
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "action-required",
      generatedAt: "2026-07-01T10:45:00.000Z",
      mode: "live-ai-eval",
      outputs: {
        aiEvalEnvFilePath,
      },
      preflight: {
        status: "action-required",
        required: {
          missing: ["AAIS_AI_API_KEY"],
          placeholders: ["AAIS_AI_ENDPOINT"],
          invalid: [],
        },
        liveAiEvalEvidence: {
          endpointPresent: true,
          endpointHttps: false,
          apiKeyPresent: false,
          modelPresent: true,
          evalVersionPresent: true,
        },
      },
      results: {},
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("OPENAI_COMPATIBLE_ENDPOINT");
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(report);
  });
});
