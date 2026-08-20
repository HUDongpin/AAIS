import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createAaisProductPseudonym,
  getAaisProductPseudonymConfigurationStatus,
} from "@/lib/server/aais-product-pseudonym";

const firstSecret = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 33))
  .toString("base64url");
const secondSecret = Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index))
  .toString("base64url");
const firstSessionSecret = "first-session-secret-with-at-least-32-characters";
const secondSessionSecret = "second-session-secret-with-at-least-32-characters";
const publishedExampleSecret = Buffer.from(
  Array.from({ length: 32 }, (_, index) => index + 1),
).toString("base64url");
const developmentDefaultSecret = createHash("sha256")
  .update("aais-development-product-pseudonym-secret-do-not-use-in-production")
  .digest("base64url");

describe("AAIS product pseudonyms", () => {
  it("is stable across session-secret rotation and separated by purpose", () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      AAIS_SESSION_SECRET: firstSessionSecret,
      AAIS_PRODUCT_PSEUDONYM_SECRET: firstSecret,
    };
    const learner = createAaisProductPseudonym("analytics-learner", "user@example.test", env);

    expect(learner).toMatch(/^[a-f0-9]{32}$/);
    expect(createAaisProductPseudonym("analytics-learner", "user@example.test", env))
      .toBe(learner);
    expect(createAaisProductPseudonym("analytics-session", "user@example.test", env))
      .not.toBe(learner);
    expect(createAaisProductPseudonym("analytics-learner", "user@example.test", {
      NODE_ENV: "production",
      AAIS_SESSION_SECRET: secondSessionSecret,
      AAIS_PRODUCT_PSEUDONYM_SECRET: firstSecret,
    })).toBe(learner);
    expect(createAaisProductPseudonym("analytics-learner", "user@example.test", {
      NODE_ENV: "production",
      AAIS_SESSION_SECRET: secondSessionSecret,
      AAIS_PRODUCT_PSEUDONYM_SECRET: secondSecret,
    })).not.toBe(learner);
  });

  it("cannot be reproduced by the former public SHA-256 dictionary transform", () => {
    const email = "known-learner@example.test";
    const studentId = `user-${createHash("sha256")
      .update(`aais-user:${email}`)
      .digest("hex")
      .slice(0, 16)}`;
    const formerPublicKey = `learner-${createHash("sha256")
      .update(`aais-analytics:${studentId}`)
      .digest("hex")
      .slice(0, 12)}`;
    const keyed = `learner-v2-${createAaisProductPseudonym("analytics-learner", studentId, {
      NODE_ENV: "production",
      AAIS_SESSION_SECRET: firstSessionSecret,
      AAIS_PRODUCT_PSEUDONYM_SECRET: firstSecret,
    })}`;

    expect(keyed).not.toBe(formerPublicKey);
    expect(keyed).toMatch(/^learner-v2-[a-f0-9]{32}$/);
  });

  it("fails closed when production pseudonym key material is missing or malformed", () => {
    expect(() => createAaisProductPseudonym("analytics-learner", "S001", {
      NODE_ENV: "production",
    })).toThrow("product pseudonym secret is not configured securely");
    expect(() => createAaisProductPseudonym("analytics-learner", "S001", {
      NODE_ENV: "production",
      AAIS_PRODUCT_PSEUDONYM_SECRET: "weak",
    })).toThrow("product pseudonym secret is not configured securely");
    expect(() => createAaisProductPseudonym("analytics-learner", "S001", {
      NODE_ENV: "production",
      AAIS_PRODUCT_PSEUDONYM_SECRET: `${firstSecret}=`,
    })).toThrow("product pseudonym secret is not configured securely");
  });

  it("rejects reuse of protected secrets without exposing their values", () => {
    const status = getAaisProductPseudonymConfigurationStatus({
      NODE_ENV: "production",
      AAIS_PRODUCT_PSEUDONYM_SECRET: firstSecret,
      AAIS_SESSION_SECRET: firstSecret,
    });

    expect(status).toMatchObject({
      configured: true,
      formatValid: true,
      distinct: false,
      valid: false,
    });
    expect(JSON.stringify(status)).not.toContain(firstSecret);
  });

  it.each([publishedExampleSecret, developmentDefaultSecret])(
    "rejects publicly known key material in production",
    (secret) => {
      const status = getAaisProductPseudonymConfigurationStatus({
        NODE_ENV: "production",
        AAIS_PRODUCT_PSEUDONYM_SECRET: secret,
      });

      expect(status).toMatchObject({
        configured: true,
        formatValid: true,
        distinct: false,
        valid: false,
      });
      expect(() => createAaisProductPseudonym("analytics-learner", "S001", {
        NODE_ENV: "production",
        AAIS_PRODUCT_PSEUDONYM_SECRET: secret,
      })).toThrow("product pseudonym secret is not configured securely");
      expect(JSON.stringify(status)).not.toContain(secret);
    },
  );

  it("detects equal 32-byte research key material across different encodings", () => {
    const sharedBytes = Buffer.alloc(32, 0xff);
    const productSecret = sharedBytes.toString("base64url");
    const sameBytesAsUnpaddedStandardBase64 = sharedBytes
      .toString("base64")
      .replace(/=+$/, "");
    const status = getAaisProductPseudonymConfigurationStatus({
      NODE_ENV: "production",
      AAIS_PRODUCT_PSEUDONYM_SECRET: productSecret,
      AAIS_RESEARCH_IDENTITY_ENCRYPTION_KEY: sameBytesAsUnpaddedStandardBase64,
    });

    expect(status).toMatchObject({
      configured: true,
      formatValid: true,
      distinct: false,
      valid: false,
    });
    expect(JSON.stringify(status)).not.toContain(productSecret);
    expect(JSON.stringify(status)).not.toContain(sameBytesAsUnpaddedStandardBase64);
  });

  it("rejects ambiguous whitespace instead of silently normalizing inputs", () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      AAIS_PRODUCT_PSEUDONYM_SECRET: firstSecret,
    };
    expect(() => createAaisProductPseudonym(" analytics-learner", "S001", env))
      .toThrow("Invalid AAIS product pseudonym input");
    expect(() => createAaisProductPseudonym("analytics-learner", "S001 ", env))
      .toThrow("Invalid AAIS product pseudonym input");
  });
});
