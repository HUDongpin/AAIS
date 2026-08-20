export const aaisDevelopmentSessionSecret = "aais-dev-session-secret-do-not-use-for-production";

const minimumSessionSecretBytes = 32;
const maximumSessionSecretBytes = 512;
const obviousPlaceholderSecrets = new Set([
  "change-me",
  "changeme",
  "password",
  "replace-me",
  "replace-this",
  "secret",
  "your-secret",
]);

export class AaisSessionConfigurationError extends Error {
  constructor() {
    super("AAIS session secret is not configured securely.");
    this.name = "AaisSessionConfigurationError";
  }
}

export function getAaisSessionSecretConfigurationStatus(
  env: NodeJS.ProcessEnv = process.env,
) {
  const configured = env.AAIS_SESSION_SECRET?.trim() ?? "";
  const production = env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
  if (!configured) {
    return {
      configured: false,
      valid: !production,
      source: production ? "missing" as const : "development-default" as const,
    };
  }
  const byteLength = Buffer.byteLength(configured, "utf8");
  const normalized = configured.toLowerCase();
  const distinctCharacters = new Set([...configured]).size;
  const placeholder = configured === aaisDevelopmentSessionSecret
    || obviousPlaceholderSecrets.has(normalized)
    || /^(?:change|replace|todo|tbd|example|sample|test)[-_ ]?me/i.test(normalized);
  return {
    configured: true,
    valid: byteLength >= minimumSessionSecretBytes
      && byteLength <= maximumSessionSecretBytes
      && distinctCharacters >= 8
      && !placeholder,
    source: "environment" as const,
  };
}

export function requireAaisSessionSecret(env: NodeJS.ProcessEnv = process.env) {
  const status = getAaisSessionSecretConfigurationStatus(env);
  if (!status.valid) {
    throw new AaisSessionConfigurationError();
  }
  return status.source === "development-default"
    ? aaisDevelopmentSessionSecret
    : String(env.AAIS_SESSION_SECRET).trim();
}
