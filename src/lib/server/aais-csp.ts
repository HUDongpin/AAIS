export function createAaisCspNonce() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let value = "";
  for (const byte of bytes) {
    value += String.fromCharCode(byte);
  }
  return globalThis.btoa(value);
}

export function createAaisContentSecurityPolicy(input: {
  nonce?: string;
  env?: NodeJS.ProcessEnv;
} = {}) {
  const env = input.env ?? process.env;
  const nonce = input.nonce?.trim();
  const isProduction = isAaisProductionRuntime(env);
  const scriptSources = ["'self'"];
  const styleSources = ["'self'"];
  const connectSources = ["'self'", "https:"];

  if (nonce) {
    scriptSources.push(`'nonce-${nonce}'`, "'strict-dynamic'");
    styleSources.push(`'nonce-${nonce}'`);
  } else {
    scriptSources.push("'unsafe-inline'");
    styleSources.push("'unsafe-inline'");
  }

  if (!isProduction) {
    scriptSources.push("'unsafe-eval'");
    if (nonce) {
      styleSources.push("'unsafe-inline'");
    }
    connectSources.push("http:", "ws:", "wss:");
  }

  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    `style-src ${styleSources.join(" ")}`,
    "img-src 'self' data: blob:",
    "font-src 'self' data: https://cdn.prod.website-files.com",
    `connect-src ${connectSources.join(" ")}`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

function isAaisProductionRuntime(env: NodeJS.ProcessEnv) {
  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
}
