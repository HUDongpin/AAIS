import {
  expect,
  test as base,
  type BrowserContext,
} from "@playwright/test";

export { expect };
export type { Page } from "@playwright/test";

export async function bootstrapAaisPreviewOrigin(input: {
  context: BrowserContext;
  baseURL?: string;
  bypass?: string;
}): Promise<void> {
  const trusted = readTrustedOrigin(input.baseURL);
  if (trusted.local) {
    return;
  }
  if (typeof input.bypass !== "string" || !input.bypass.trim()) {
    throw new Error("AAIS_PREVIEW_TRUST_SECRET");
  }

  let existingCookies;
  try {
    existingCookies = await input.context.cookies(trusted.origin);
  } catch {
    throw new Error("AAIS_PREVIEW_TRUST_COOKIE");
  }
  if (existingCookies.some((cookie) =>
    cookie.name === "_vercel_jwt"
      && cookieDomainMatches(cookie.domain, trusted.hostname))) {
    throw new Error("AAIS_PREVIEW_TRUST_COOKIE");
  }

  const loginUrl = `${trusted.origin}/login`;
  let response;
  try {
    response = await input.context.request.get(loginUrl, {
      headers: {
        "x-vercel-protection-bypass": input.bypass,
        "x-vercel-set-bypass-cookie": "true",
      },
      maxRedirects: 0,
    });
  } catch {
    throw new Error("AAIS_PREVIEW_TRUST_RESPONSE");
  }

  if (response.status() !== 200 || !isExactLoginResponse(response.url(), trusted.origin)) {
    throw new Error("AAIS_PREVIEW_TRUST_RESPONSE");
  }

  let cookies;
  try {
    cookies = await input.context.cookies(trusted.origin);
  } catch {
    throw new Error("AAIS_PREVIEW_TRUST_COOKIE");
  }
  const hasOriginCookie = cookies.some((cookie) =>
    cookie.name === "_vercel_jwt"
      && cookie.secure
      && cookieDomainMatches(cookie.domain, trusted.hostname));
  if (!hasOriginCookie) {
    throw new Error("AAIS_PREVIEW_TRUST_COOKIE");
  }
}

const test = base.extend<{ aaisPreviewTrust: void }>({
  aaisPreviewTrust: [async ({ context, baseURL }, use) => {
    await bootstrapAaisPreviewOrigin({
      context,
      baseURL,
      bypass: process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
    });
    await use();
  }, { auto: true }],
});

export { test };

function readTrustedOrigin(baseURL: string | undefined): {
  hostname: string;
  local: boolean;
  origin: string;
} {
  let url: URL;
  try {
    url = new URL(baseURL ?? "");
  } catch {
    throw new Error("AAIS_PREVIEW_TRUST_URL");
  }
  const hasExactOriginShape = !url.username
    && !url.password
    && !url.search
    && !url.hash
    && url.pathname === "/";
  const local = url.protocol === "http:"
    && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
    && hasExactOriginShape;
  if (local) {
    return { hostname: url.hostname, local: true, origin: url.origin };
  }
  if (url.protocol !== "https:"
    || url.port
    || !hasExactOriginShape
    || !url.hostname.endsWith(".vercel.app")) {
    throw new Error("AAIS_PREVIEW_TRUST_URL");
  }
  return { hostname: url.hostname, local: false, origin: url.origin };
}

function isExactLoginResponse(value: string, origin: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === origin
      && url.pathname === "/login"
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function cookieDomainMatches(domain: string, hostname: string): boolean {
  const normalized = domain.trim().replace(/^\./, "").toLowerCase();
  return normalized === hostname;
}
