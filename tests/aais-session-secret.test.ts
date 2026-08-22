import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAaisCsrfToken } from "@/lib/server/aais-csrf";
import { createAaisOidcState } from "@/lib/server/aais-oidc";
import {
  AaisSessionConfigurationError,
  createAaisSessionToken,
  verifyAaisSessionTokenWithMetadata,
} from "@/lib/server/aais-session";
import {
  aaisDevelopmentSessionSecret,
  getAaisSessionSecretConfigurationStatus,
} from "@/lib/server/aais-session-secret";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("AAIS shared session secret policy", () => {
  it.each([
    ["one-byte secret", "x"],
    ["development placeholder", aaisDevelopmentSessionSecret],
    ["obvious placeholder", "change-me"],
    ["long repeated value", "x".repeat(64)],
    ["long placeholder phrase", "change-me-for-production-deployment-secret"],
    ["oversized secret", "x".repeat(513)],
  ])("rejects %s consistently across session, CSRF, and OIDC state", (_label, secret) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AAIS_SESSION_SECRET", secret);

    expect(() => createAaisSessionToken({
      id: "student-1",
      displayName: "Student",
      role: "student",
    })).toThrow(AaisSessionConfigurationError);
    expect(() => createAaisCsrfToken("student-1")).toThrow(AaisSessionConfigurationError);
    expect(() => createAaisOidcState("/learning")).toThrow(AaisSessionConfigurationError);
    expect(getAaisSessionSecretConfigurationStatus()).toMatchObject({
      configured: true,
      valid: false,
    });
  });

  it("accepts a bounded strong production secret", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AAIS_SESSION_SECRET", "aais-production-secret-with-at-least-32-bytes");

    expect(() => createAaisSessionToken({
      id: "student-1",
      displayName: "Student",
      role: "student",
    })).not.toThrow();
    expect(() => createAaisCsrfToken("student-1")).not.toThrow();
    expect(() => createAaisOidcState("/learning")).not.toThrow();
    expect(getAaisSessionSecretConfigurationStatus()).toMatchObject({
      configured: true,
      valid: true,
    });
  });

  it("uses the known development-only default only outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AAIS_SESSION_SECRET", "");
    expect(() => createAaisSessionToken({
      id: "student-1",
      displayName: "Student",
      role: "student",
    })).not.toThrow();
    expect(getAaisSessionSecretConfigurationStatus()).toMatchObject({
      configured: false,
      valid: true,
      source: "development-default",
    });
  });

  it("signs and verifies explicit v3 source metadata with a bounded OIDC lifetime", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AAIS_SESSION_SECRET", "test-session-secret-with-at-least-32-characters");
    const issuedAt = new Date("2026-08-19T00:00:00.000Z");
    const token = createAaisSessionToken({
      id: `oidc:v2:${"a".repeat(64)}`,
      displayName: "Teacher",
      role: "teacher",
    }, issuedAt, {
      authSource: "oidc",
      oidcPolicyFingerprint: "b".repeat(64),
      ttlSeconds: 15 * 60,
    });

    expect(verifyAaisSessionTokenWithMetadata(token, issuedAt)).toMatchObject({
      authSource: "oidc",
      authVersion: null,
      oidcPolicyFingerprint: "b".repeat(64),
      expiresAt: new Date("2026-08-19T00:15:00.000Z"),
    });
    expect(verifyAaisSessionTokenWithMetadata(
      token,
      new Date("2026-08-19T00:15:00.000Z"),
    )).toBeNull();
  });

  it("rejects contradictory source metadata before minting a session", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AAIS_SESSION_SECRET", "test-session-secret-with-at-least-32-characters");
    const actor = { id: "student-1", displayName: "Student", role: "student" as const };

    expect(() => createAaisSessionToken(actor, new Date(), {
      authSource: "oidc",
    })).toThrow("Invalid AAIS OIDC session policy fingerprint.");
    expect(() => createAaisSessionToken(actor, new Date(), {
      authSource: "trial",
      authVersion: 1,
    })).toThrow("Only AAIS database sessions may include an auth version.");
    expect(() => createAaisSessionToken(actor, new Date(), {
      authSource: "trial",
    })).toThrow("Invalid AAIS trial session policy fingerprint.");
    expect(() => createAaisSessionToken(actor, new Date(), {
      authSource: "database",
    })).toThrow("Invalid AAIS database session source metadata.");
  });

  it("fails closed for legacy trial v3 payloads without a credential policy fingerprint", () => {
    vi.stubEnv("NODE_ENV", "test");
    const secret = "test-session-secret-with-at-least-32-characters";
    vi.stubEnv("AAIS_SESSION_SECRET", secret);
    const verificationTime = new Date("2026-08-20T00:00:00.000Z");
    const issuedAt = Math.floor(verificationTime.getTime() / 1000) - 60;
    const encodedPayload = Buffer.from(JSON.stringify({
      v: 3,
      actor: { id: "trial:v1:legacy", displayName: "Legacy", role: "student" },
      iat: issuedAt,
      exp: issuedAt + 8 * 60 * 60,
      authSource: "trial",
    }), "utf8").toString("base64url");
    const signature = createHmac("sha256", secret)
      .update(encodedPayload)
      .digest("base64url");

    expect(verifyAaisSessionTokenWithMetadata(
      `${encodedPayload}.${signature}`,
      verificationTime,
    )).toBeNull();
  });

  it("rejects a trial fingerprint changed without a matching session signature", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AAIS_SESSION_SECRET", "test-session-secret-with-at-least-32-characters");
    const issuedAt = new Date("2026-08-20T00:00:00.000Z");
    const token = createAaisSessionToken({
      id: "trial:v1:bound",
      displayName: "Bound Trial",
      role: "student",
    }, issuedAt, {
      authSource: "trial",
      trialPolicyFingerprint: "a".repeat(64),
    });
    const [encodedPayload, signature] = token.split(".");
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    payload.trialPolicyFingerprint = "b".repeat(64);
    const tamperedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

    expect(verifyAaisSessionTokenWithMetadata(
      `${tamperedPayload}.${signature}`,
      issuedAt,
    )).toBeNull();
  });
});
