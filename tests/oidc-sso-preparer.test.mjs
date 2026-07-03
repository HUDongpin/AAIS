import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareAaisOidcSso } from "../scripts/prepare-oidc-sso.mjs";

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-oidc-sso-"));
});

afterEach(async () => {
  await rm(tempDir, { force: true, recursive: true });
});

describe("AAIS OIDC SSO onboarding preparer", () => {
  it("is exposed through the package script without using Node's own env-file parser", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));

    expect(packageJson.scripts["prepare:oidc-sso"]).toBe(
      "node -- scripts/prepare-oidc-sso.mjs",
    );
  });

  it("writes an action-required onboarding packet when OIDC values are still absent", async () => {
    const outputPath = path.join(tempDir, "oidc-onboarding.json");
    const markdownOutputPath = path.join(tempDir, "oidc-onboarding.md");

    const report = await prepareAaisOidcSso({
      envFilePath: path.join(tempDir, "missing.env"),
      baseUrl: "https://www.aais.site",
      outputPath,
      markdownOutputPath,
      releaseId: "aais-2026-06-30-rc1",
      now: new Date("2026-07-01T10:00:00.000Z"),
      fetchImpl: async () => {
        throw new Error("discovery should be skipped");
      },
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "action-required",
      generatedAt: "2026-07-01T10:00:00.000Z",
      target: {
        baseUrl: "https://www.aais.site",
        callbackUrl: "https://www.aais.site/api/auth/oidc/callback",
      },
      idpRegistration: {
        applicationType: "confidential-web-application",
        redirectUris: ["https://www.aais.site/api/auth/oidc/callback"],
        responseType: "code",
        grantType: "authorization_code",
        pkce: {
          required: true,
          method: "S256",
        },
        scopes: ["openid", "email", "profile"],
        requiredClaims: ["sub", "email", "email_verified"],
        educatorRoleClaims: ["groups", "roles", "role"],
      },
      validation: {
        status: "failed",
        required: {
          missing: [
            "AAIS_OIDC_ISSUER",
            "AAIS_OIDC_CLIENT_ID",
            "AAIS_OIDC_CLIENT_SECRET",
            "AAIS_OIDC_REDIRECT_URI",
          ],
        },
        roleMapping: {
          status: "failed",
          missing: true,
        },
        discovery: {
          status: "skipped",
          reason: "base-config-invalid",
        },
      },
      redaction: {
        secrets: "omitted",
        values: "not-output",
        transientEvidence: "not-stored",
      },
    });
    expect(report.commands.realCallbackSmoke).toContain("<REQUIRED:TRANSIENT_OIDC_CALLBACK_URL>");
    expect(report.commands.teacherCohortSmoke).toContain("<REQUIRED:TRANSIENT_TEACHER_OR_ADMIN_OIDC_CALLBACK_URL>");
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(report);
    const markdown = await readFile(markdownOutputPath, "utf8");
    expect(markdown).toContain("AAIS OIDC SSO Onboarding");
    expect(markdown).toContain("https://www.aais.site/api/auth/oidc/callback");
  });

  it("validates a complete local OIDC env through discovery without leaking secrets or raw provider URLs", async () => {
    const envFilePath = path.join(tempDir, "production.env");
    await writeFile(envFilePath, [
      "AAIS_OIDC_ISSUER=https://issuer.example.test",
      "AAIS_OIDC_CLIENT_ID=client-id-secret",
      "AAIS_OIDC_CLIENT_SECRET=client-secret-value",
      "AAIS_OIDC_REDIRECT_URI=https://www.aais.site/api/auth/oidc/callback",
      "AAIS_OIDC_TEACHER_GROUPS=aais-teachers",
      "",
    ].join("\n"), "utf8");
    const outputPath = path.join(tempDir, "oidc-onboarding.json");

    const report = await prepareAaisOidcSso({
      envFilePath,
      baseUrl: "https://www.aais.site",
      outputPath,
      markdownOutputPath: path.join(tempDir, "oidc-onboarding.md"),
      releaseId: "aais-2026-06-30-rc1",
      now: new Date("2026-07-01T10:00:00.000Z"),
      fetchImpl: async (url) => {
        expect(url).toBe("https://issuer.example.test/.well-known/openid-configuration");
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              issuer: "https://issuer.example.test",
              authorization_endpoint: "https://issuer.example.test/oauth/authorize",
              token_endpoint: "https://issuer.example.test/oauth/token",
              jwks_uri: "https://issuer.example.test/.well-known/jwks.json",
              response_types_supported: ["code"],
              scopes_supported: ["openid", "email", "profile"],
            };
          },
        };
      },
    });

    expect(report).toMatchObject({
      status: "ready-for-vercel-provisioning",
      validation: {
        status: "passed",
        required: {
          present: [
            "AAIS_OIDC_ISSUER",
            "AAIS_OIDC_CLIENT_ID",
            "AAIS_OIDC_CLIENT_SECRET",
            "AAIS_OIDC_REDIRECT_URI",
          ],
          missing: [],
          placeholders: [],
        },
        roleMapping: {
          status: "passed",
          present: ["AAIS_OIDC_TEACHER_GROUPS"],
        },
        redirectUri: {
          status: "passed",
          usesHttps: true,
          matchesExpectedCallback: true,
        },
        discovery: {
          status: "passed",
          mode: "issuer-discovery",
          issuerMatches: true,
          authorizationEndpointHttps: true,
          tokenEndpointHttps: true,
          jwksUriHttps: true,
          supportsCodeFlow: true,
          supportsOpenidScope: true,
        },
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("client-secret-value");
    expect(serialized).not.toContain("client-id-secret");
    expect(serialized).not.toContain("issuer.example.test/oauth");
    expect(serialized).not.toContain("aais-teachers");
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(report);
  });
});
