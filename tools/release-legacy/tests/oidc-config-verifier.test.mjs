import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyAaisOidcConfiguration } from "../scripts/verify-oidc-configuration.mjs";

let tempDir;

afterEach(async () => {
  vi.restoreAllMocks();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("AAIS OIDC configuration verifier", () => {
  it("passes for discovery-backed production OIDC without leaking secret values", async () => {
    const envFilePath = await writeEnvFile(`
      AAIS_OIDC_ISSUER=https://idp.example.edu
      AAIS_OIDC_CLIENT_ID=aais-client
      AAIS_OIDC_CLIENT_SECRET=super-secret-client-value
      AAIS_OIDC_REDIRECT_URI=https://www.aais.site/api/auth/oidc/callback
      AAIS_OIDC_TEACHER_GROUPS=aais-teachers
    `);
    const fetchImpl = vi.fn(async (url) => {
      expect(String(url)).toBe("https://idp.example.edu/.well-known/openid-configuration");
      return Response.json({
        issuer: "https://idp.example.edu",
        authorization_endpoint: "https://idp.example.edu/oauth2/authorize",
        token_endpoint: "https://idp.example.edu/oauth2/token",
        jwks_uri: "https://idp.example.edu/oauth2/jwks",
        response_types_supported: ["code"],
        scopes_supported: ["openid", "profile", "email"],
      });
    });

    const report = await verifyAaisOidcConfiguration({
      now: new Date("2026-07-01T00:00:00.000Z"),
      envFilePath,
      baseUrl: "https://www.aais.site",
      fetchImpl,
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "passed",
      checkedAt: "2026-07-01T00:00:00.000Z",
      target: {
        baseUrl: "https://www.aais.site",
        callbackPath: "/api/auth/oidc/callback",
      },
      required: {
        missing: [],
        placeholders: [],
      },
      redirectUri: {
        status: "passed",
        matchesExpectedCallback: true,
        usesHttps: true,
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
      roleMapping: {
        status: "passed",
        present: ["AAIS_OIDC_TEACHER_GROUPS"],
        missing: false,
        placeholders: [],
        invalid: [],
      },
      redaction: {
        secrets: "omitted",
        values: "not-output",
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("super-secret-client-value");
    expect(serialized).not.toContain("aais-client");
    expect(serialized).not.toContain("aais-teachers");
    expect(serialized).not.toContain("idp.example.edu");
  });

  it("fails closed when no teacher or admin OIDC role mapping is configured", async () => {
    const envFilePath = await writeEnvFile(`
      AAIS_OIDC_ISSUER=https://idp.example.edu
      AAIS_OIDC_CLIENT_ID=aais-client
      AAIS_OIDC_CLIENT_SECRET=super-secret-client-value
      AAIS_OIDC_REDIRECT_URI=https://www.aais.site/api/auth/oidc/callback
    `);

    const report = await verifyAaisOidcConfiguration({
      envFilePath,
      baseUrl: "https://www.aais.site",
      fetchImpl: vi.fn(async () => Response.json({
        issuer: "https://idp.example.edu",
        authorization_endpoint: "https://idp.example.edu/oauth2/authorize",
        token_endpoint: "https://idp.example.edu/oauth2/token",
        jwks_uri: "https://idp.example.edu/oauth2/jwks",
        response_types_supported: ["code"],
        scopes_supported: ["openid"],
      })),
    });

    expect(report.status).toBe("failed");
    expect(report.roleMapping).toEqual({
      status: "failed",
      present: [],
      missing: true,
      placeholders: [],
      invalid: [],
      acceptedNames: [
        "AAIS_OIDC_TEACHER_GROUPS",
        "AAIS_OIDC_TEACHER_EMAILS",
        "AAIS_OIDC_ADMIN_GROUPS",
        "AAIS_OIDC_ADMIN_EMAILS",
      ],
    });
    expect(JSON.stringify(report)).not.toContain("super-secret-client-value");
  });

  it("accepts admin email role mapping without exposing the mapped email", async () => {
    const envFilePath = await writeEnvFile(`
      AAIS_OIDC_ISSUER=https://idp.example.edu
      AAIS_OIDC_CLIENT_ID=aais-client
      AAIS_OIDC_CLIENT_SECRET=super-secret-client-value
      AAIS_OIDC_REDIRECT_URI=https://www.aais.site/api/auth/oidc/callback
      AAIS_OIDC_ADMIN_EMAILS=admin@example.edu
    `);

    const report = await verifyAaisOidcConfiguration({
      envFilePath,
      baseUrl: "https://www.aais.site",
      fetchImpl: vi.fn(async () => Response.json({
        issuer: "https://idp.example.edu",
        authorization_endpoint: "https://idp.example.edu/oauth2/authorize",
        token_endpoint: "https://idp.example.edu/oauth2/token",
        jwks_uri: "https://idp.example.edu/oauth2/jwks",
        response_types_supported: ["code"],
        scopes_supported: ["openid"],
      })),
    });

    expect(report.status).toBe("passed");
    expect(report.roleMapping).toMatchObject({
      status: "passed",
      present: ["AAIS_OIDC_ADMIN_EMAILS"],
      missing: false,
      placeholders: [],
      invalid: [],
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("admin@example.edu");
    expect(serialized).not.toContain("super-secret-client-value");
  });

  it("fails closed for missing values, placeholders, and redirect URI mismatch", async () => {
    const envFilePath = await writeEnvFile(`
      AAIS_OIDC_ISSUER=<REQUIRED:AAIS_OIDC_ISSUER>
      AAIS_OIDC_CLIENT_ID=aais-client
      AAIS_OIDC_CLIENT_SECRET=<REQUIRED:AAIS_OIDC_CLIENT_SECRET>
      AAIS_OIDC_REDIRECT_URI=https://wrong.example.edu/api/auth/oidc/callback
      AAIS_OIDC_TEACHER_GROUPS=<REQUIRED:OIDC_TEACHER_GROUPS>
    `);

    const report = await verifyAaisOidcConfiguration({
      envFilePath,
      baseUrl: "https://www.aais.site",
      fetchImpl: vi.fn(),
    });

    expect(report.status).toBe("failed");
    expect(report.required).toMatchObject({
      missing: [],
      placeholders: ["AAIS_OIDC_ISSUER", "AAIS_OIDC_CLIENT_SECRET"],
    });
    expect(report.roleMapping).toMatchObject({
      status: "failed",
      present: [],
      missing: false,
      placeholders: ["AAIS_OIDC_TEACHER_GROUPS"],
      invalid: [],
    });
    expect(report.redirectUri).toMatchObject({
      status: "failed",
      matchesExpectedCallback: false,
      usesHttps: true,
    });
    expect(report.discovery).toMatchObject({
      status: "skipped",
      reason: "base-config-invalid",
    });
    expect(JSON.stringify(report)).not.toContain("aais-client");
  });

  it("reports discovery_unreachable when issuer discovery cannot be fetched", async () => {
    const envFilePath = await writeEnvFile(`
      AAIS_OIDC_ISSUER=https://idp.example.edu
      AAIS_OIDC_CLIENT_ID=aais-client
      AAIS_OIDC_CLIENT_SECRET=super-secret-client-value
      AAIS_OIDC_REDIRECT_URI=https://www.aais.site/api/auth/oidc/callback
      AAIS_OIDC_TEACHER_EMAILS=teacher@example.edu
    `);

    const report = await verifyAaisOidcConfiguration({
      envFilePath,
      baseUrl: "https://www.aais.site",
      fetchImpl: vi.fn(async () => new Response("unavailable", { status: 503 })),
    });

    expect(report.status).toBe("failed");
    expect(report.discovery).toMatchObject({
      status: "failed",
      reason: "discovery_unreachable",
      httpStatus: 503,
    });
    expect(JSON.stringify(report)).not.toContain("super-secret-client-value");
  });

  it("uses explicit endpoint overrides without discovery when all endpoints are valid HTTPS URLs", async () => {
    const envFilePath = await writeEnvFile(`
      AAIS_OIDC_ISSUER=https://idp.example.edu
      AAIS_OIDC_CLIENT_ID=aais-client
      AAIS_OIDC_CLIENT_SECRET=super-secret-client-value
      AAIS_OIDC_REDIRECT_URI=https://www.aais.site/api/auth/oidc/callback
      AAIS_OIDC_TEACHER_GROUPS=aais-teachers
      AAIS_OIDC_AUTHORIZATION_ENDPOINT=https://idp.example.edu/oauth2/authorize
      AAIS_OIDC_TOKEN_ENDPOINT=https://idp.example.edu/oauth2/token
      AAIS_OIDC_JWKS_URI=https://idp.example.edu/oauth2/jwks
    `);
    const outputPath = path.join(path.dirname(envFilePath), "oidc-report.json");
    const fetchImpl = vi.fn();

    const report = await verifyAaisOidcConfiguration({
      envFilePath,
      outputPath,
      baseUrl: "https://www.aais.site",
      fetchImpl,
    });
    const written = JSON.parse(await readFile(outputPath, "utf8"));

    expect(report.status).toBe("passed");
    expect(report.discovery).toMatchObject({
      status: "passed",
      mode: "explicit-endpoints",
      authorizationEndpointHttps: true,
      tokenEndpointHttps: true,
      jwksUriHttps: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(written).toEqual(report);
  });

  it("fails closed for partial explicit endpoint overrides instead of silently falling back to discovery", async () => {
    const envFilePath = await writeEnvFile(`
      AAIS_OIDC_ISSUER=https://idp.example.edu
      AAIS_OIDC_CLIENT_ID=aais-client
      AAIS_OIDC_CLIENT_SECRET=super-secret-client-value
      AAIS_OIDC_REDIRECT_URI=https://www.aais.site/api/auth/oidc/callback
      AAIS_OIDC_TEACHER_GROUPS=aais-teachers
      AAIS_OIDC_AUTHORIZATION_ENDPOINT=https://idp.example.edu/oauth2/authorize
    `);
    const fetchImpl = vi.fn(async () => Response.json({
      issuer: "https://idp.example.edu",
      authorization_endpoint: "https://idp.example.edu/oauth2/authorize",
      token_endpoint: "https://idp.example.edu/oauth2/token",
      jwks_uri: "https://idp.example.edu/oauth2/jwks",
      response_types_supported: ["code"],
      scopes_supported: ["openid"],
    }));

    const report = await verifyAaisOidcConfiguration({
      envFilePath,
      baseUrl: "https://www.aais.site",
      fetchImpl,
    });

    expect(report.status).toBe("failed");
    expect(report.discovery).toMatchObject({
      status: "failed",
      mode: "explicit-endpoints",
      reason: "explicit_endpoints_incomplete",
      present: ["AAIS_OIDC_AUTHORIZATION_ENDPOINT"],
      missing: ["AAIS_OIDC_TOKEN_ENDPOINT", "AAIS_OIDC_JWKS_URI"],
      placeholders: [],
      authorizationEndpointHttps: true,
      tokenEndpointHttps: false,
      jwksUriHttps: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("super-secret-client-value");
    expect(serialized).not.toContain("aais-client");
    expect(serialized).not.toContain("idp.example.edu");
  });
});

async function writeEnvFile(contents) {
  tempDir = tempDir ?? await mkdtemp(path.join(os.tmpdir(), "aais-oidc-config-"));
  const filePath = path.join(tempDir, "oidc.env");
  await writeFile(filePath, contents.replace(/^\n/, ""), "utf8");
  return filePath;
}
