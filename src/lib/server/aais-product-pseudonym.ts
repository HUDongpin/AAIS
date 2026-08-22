import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const productPseudonymDomain = "aais-product-pseudonym:v2";
const productPseudonymHexCharacters = 32;
const developmentProductPseudonymSecret = createHash("sha256")
  .update("aais-development-product-pseudonym-secret-do-not-use-in-production")
  .digest();
const publishedExampleProductPseudonymSecret = Buffer.from(
  Array.from({ length: 32 }, (_, index) => index + 1),
);
const publiclyKnownProductPseudonymSecrets = [
  developmentProductPseudonymSecret,
  publishedExampleProductPseudonymSecret,
] as const;

const forbiddenProductPseudonymSecretNames = [
  "AAIS_SESSION_SECRET",
  "CRON_SECRET",
  "AAIS_LRS_OUTBOX_FLUSH_TOKEN",
  "AAIS_AUTH_EMAIL_OUTBOX_FLUSH_TOKEN",
  "AAIS_READINESS_BEARER_TOKEN",
  "AAIS_RESEARCH_IDENTITY_ENCRYPTION_KEY",
  "AAIS_RESEARCH_IDENTITY_FINGERPRINT_KEY",
  "AAIS_RESEARCH_LRS_OUTBOX_FLUSH_TOKEN",
  "AAIS_RESEARCH_RETENTION_TOKEN",
  "LRS_PASSWORD",
  "AAIS_RESEARCH_LRS_PASSWORD",
  "RESEND_API_KEY",
  "AAIS_OIDC_CLIENT_SECRET",
  "AAIS_AI_API_KEY",
  "AAIS_AI_FALLBACK_API_KEY",
  "QWEN_API_KEY",
  "DASHSCOPE_API_KEY",
] as const;

const encodedKeyMaterialSecretNames = [
  "AAIS_RESEARCH_IDENTITY_ENCRYPTION_KEY",
  "AAIS_RESEARCH_IDENTITY_FINGERPRINT_KEY",
] as const;

export class AaisProductPseudonymConfigurationError extends Error {
  constructor() {
    super("AAIS product pseudonym secret is not configured securely.");
    this.name = "AaisProductPseudonymConfigurationError";
  }
}

export function getAaisProductPseudonymConfigurationStatus(
  env: NodeJS.ProcessEnv = process.env,
) {
  const configured = env.AAIS_PRODUCT_PSEUDONYM_SECRET ?? "";
  const production = env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
  if (!configured) {
    return {
      configured: false,
      valid: !production,
      formatValid: !production,
      distinct: true,
      algorithm: "hmac-sha256-128" as const,
      emitVersion: "v2" as const,
      source: production ? "missing" as const : "development-default" as const,
    };
  }
  const decoded = decodeAaisProductPseudonymSecret(configured);
  const forbiddenSecrets = forbiddenProductPseudonymSecretNames
    .map((name) => env[name]?.trim() ?? "")
    .filter(Boolean);
  const forbiddenKeyMaterial: Uint8Array[] = [];
  for (const name of encodedKeyMaterialSecretNames) {
    const candidate = decodeCanonical32ByteSecret(env[name]?.trim() ?? "");
    if (candidate !== null) {
      forbiddenKeyMaterial.push(candidate);
    }
  }
  const publiclyKnown = decoded !== null
    && publiclyKnownProductPseudonymSecrets.some((secret) =>
      equalSecretMaterial(decoded, secret)
    );
  const duplicatesEncodedKeyMaterial = decoded !== null
    && forbiddenKeyMaterial.some((secret) => equalSecretMaterial(decoded, secret));
  const distinct = !publiclyKnown
    && !duplicatesEncodedKeyMaterial
    && !forbiddenSecrets.includes(configured);
  return {
    configured: true,
    valid: decoded !== null && distinct,
    formatValid: decoded !== null,
    distinct,
    algorithm: "hmac-sha256-128" as const,
    emitVersion: "v2" as const,
    source: "environment" as const,
  };
}

export function requireAaisProductPseudonymSecret(
  env: NodeJS.ProcessEnv = process.env,
) {
  const status = getAaisProductPseudonymConfigurationStatus(env);
  if (!status.valid) {
    throw new AaisProductPseudonymConfigurationError();
  }
  return status.source === "development-default"
    ? developmentProductPseudonymSecret
    : decodeAaisProductPseudonymSecret(String(env.AAIS_PRODUCT_PSEUDONYM_SECRET))!;
}

export function createAaisProductPseudonym(
  scope: string,
  value: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const normalizedScope = scope.trim();
  const normalizedValue = value.trim();
  if (
    normalizedScope !== scope
    || normalizedValue !== value
    || !/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(normalizedScope)
    || !normalizedValue
    || Buffer.byteLength(normalizedValue, "utf8") > 4_096
  ) {
    throw new Error("Invalid AAIS product pseudonym input.");
  }
  return createHmac("sha256", requireAaisProductPseudonymSecret(env))
    .update(JSON.stringify([productPseudonymDomain, normalizedScope, normalizedValue]))
    .digest("hex")
    .slice(0, productPseudonymHexCharacters);
}

function decodeAaisProductPseudonymSecret(value: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
    return null;
  }
  return decoded;
}

function decodeCanonical32ByteSecret(value: string) {
  if (!value) {
    return null;
  }
  if (/^[A-Za-z0-9+/]{43}=?$/.test(value)) {
    const decoded = Buffer.from(value, "base64");
    if (
      decoded.length === 32
      && decoded.toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "")
    ) {
      return decoded;
    }
  }
  if (/^[A-Za-z0-9_-]{43}$/.test(value)) {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length === 32 && decoded.toString("base64url") === value) {
      return decoded;
    }
  }
  return null;
}

function equalSecretMaterial(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && timingSafeEqual(left, right);
}
