import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

type Bootstrap = (input: {
  context: FakeContext;
  baseURL?: string;
  bypass?: string;
}) => Promise<unknown>;

describe("AAIS Preview Playwright trust boundary", () => {
  it("disables retained artifacts and parallelism only for external Preview", async () => {
    const external = await loadPlaywrightConfig("https://aais-git-recovery.example.vercel.app");

    expect(external.workers).toBe(1);
    expect(external.fullyParallel).toBe(false);
    expect(external.reporter).toEqual([["list"]]);
    expect(external.preserveOutput).toBe("never");
    expect(external.use).toMatchObject({
      trace: "off",
      video: "off",
      screenshot: "off",
    });
    expect(external.use).not.toHaveProperty("recordHar");
    expect(external.use).not.toHaveProperty("storageState");
    expect(external.use).not.toHaveProperty("extraHTTPHeaders");
    expect(JSON.stringify(external.reporter)).not.toMatch(/html|blob|junit/i);
  });

  it("preserves local parallel behavior and on-first-retry tracing", async () => {
    const local = await loadPlaywrightConfig();

    expect(local.workers).toBeUndefined();
    expect(local.fullyParallel).toBe(true);
    expect(local.use?.trace).toBe("on-first-retry");
    expect(local.webServer).toBeDefined();
    expect(local.use).not.toHaveProperty("extraHTTPHeaders");
  });

  it("routes all seven specs through the automatic fixture", () => {
    for (const file of [
      "ai-guide.spec.ts",
      "core-accessibility.spec.ts",
      "dashboard-access.spec.ts",
      "learning-persistence.spec.ts",
      "login-failure.spec.ts",
      "login-learning.spec.ts",
      "mobile-learning.spec.ts",
    ]) {
      const source = readFileSync(path.join("tests/e2e", file), "utf8");
      expect(source).toMatch(/from "\.\/aais-e2e-fixtures"/);
      expect(source).not.toMatch(/from "@playwright\/test"/);
    }
  });

  it("sends the two reviewed headers exactly once to same-origin /login", async () => {
    const bootstrap = await loadBootstrap();
    expect(bootstrap).toBeTypeOf("function");
    const context = trustedContext();

    await bootstrap?.({
      context,
      baseURL: "https://aais-git-recovery.example.vercel.app",
      bypass: "opaque-bypass-value",
    });

    expect(context.request.get).toHaveBeenCalledTimes(1);
    expect(context.request.get).toHaveBeenCalledWith(
      "https://aais-git-recovery.example.vercel.app/login",
      {
        headers: {
          "x-vercel-protection-bypass": "opaque-bypass-value",
          "x-vercel-set-bypass-cookie": "true",
        },
        maxRedirects: 0,
      },
    );
    expect(context.cookies).toHaveBeenCalledWith("https://aais-git-recovery.example.vercel.app");
  });

  it("skips bootstrap for the local server without reading a bypass", async () => {
    const bootstrap = await loadBootstrap();
    expect(bootstrap).toBeTypeOf("function");
    const context = trustedContext();

    await expect(bootstrap?.({
      context,
      baseURL: "http://127.0.0.1:3000",
    })).resolves.toBeUndefined();
    expect(context.request.get).not.toHaveBeenCalled();
    expect(context.cookies).not.toHaveBeenCalled();
  });

  it.each([
    "http://preview.example.vercel.app",
    "https://preview.example.vercel.app.evil.test",
    "https://evilvercel.app",
    "https://user:pass@preview.example.vercel.app",
    "https://preview.example.vercel.app?secret=value",
    "https://preview.example.vercel.app#fragment",
    "https://preview.example.vercel.app/redirect",
  ])("rejects untrusted base URL %s before making a request", async (baseURL) => {
    const bootstrap = await loadBootstrap();
    expect(bootstrap).toBeTypeOf("function");
    const context = trustedContext();

    await expect(bootstrap?.({ context, baseURL, bypass: "opaque" }))
      .rejects.toThrowError(new Error("AAIS_PREVIEW_TRUST_URL"));
    expect(context.request.get).not.toHaveBeenCalled();
  });

  it("fails closed without an external bypass secret", async () => {
    const bootstrap = await loadBootstrap();
    expect(bootstrap).toBeTypeOf("function");
    const context = trustedContext();

    await expect(bootstrap?.({
      context,
      baseURL: "https://preview.example.vercel.app",
      bypass: "",
    })).rejects.toThrowError(new Error("AAIS_PREVIEW_TRUST_SECRET"));
    expect(context.request.get).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "redirect",
      response: fakeResponse({ status: 307, url: "https://evil.test/login" }),
    },
    {
      name: "cross-origin response",
      response: fakeResponse({ status: 200, url: "https://lookalike.vercel.app.evil.test/login" }),
    },
    {
      name: "non-AAIS path",
      response: fakeResponse({ status: 200, url: "https://preview.example.vercel.app/other" }),
    },
    {
      name: "unsuccessful status",
      response: fakeResponse({ status: 401, url: "https://preview.example.vercel.app/login" }),
    },
  ])("returns only the fixed response error for $name", async ({ response }) => {
    const bootstrap = await loadBootstrap();
    expect(bootstrap).toBeTypeOf("function");
    const context = trustedContext({ response });

    await expect(bootstrap?.({
      context,
      baseURL: "https://preview.example.vercel.app",
      bypass: "opaque",
    })).rejects.toThrowError(new Error("AAIS_PREVIEW_TRUST_RESPONSE"));
    expect(context.request.get.mock.calls[0]?.[1]).toMatchObject({ maxRedirects: 0 });
  });

  it("maps provider/network details to the fixed response error", async () => {
    const bootstrap = await loadBootstrap();
    expect(bootstrap).toBeTypeOf("function");
    const context = trustedContext({ requestError: new Error("private provider detail") });

    await expect(bootstrap?.({
      context,
      baseURL: "https://preview.example.vercel.app",
      bypass: "opaque",
    })).rejects.toThrowError(new Error("AAIS_PREVIEW_TRUST_RESPONSE"));
  });

  it("requires an in-memory secure Vercel bypass cookie for the trusted origin", async () => {
    const bootstrap = await loadBootstrap();
    expect(bootstrap).toBeTypeOf("function");
    const context = trustedContext({
      cookies: [],
      response: fakeResponse({
        status: 200,
        url: "https://preview.example.vercel.app/login",
      }),
    });

    await expect(bootstrap?.({
      context,
      baseURL: "https://preview.example.vercel.app",
      bypass: "opaque",
    })).rejects.toThrowError(new Error("AAIS_PREVIEW_TRUST_COOKIE"));
  });

  it("rejects an unrelated pre-existing secure cookie on the exact host", async () => {
    const bootstrap = await loadBootstrap();
    expect(bootstrap).toBeTypeOf("function");
    const context = trustedContext({
      cookies: [{
        name: "aais_session",
        domain: "preview.example.vercel.app",
        secure: true,
      }],
      response: fakeResponse({
        status: 200,
        url: "https://preview.example.vercel.app/login",
      }),
    });

    await expect(bootstrap?.({
      context,
      baseURL: "https://preview.example.vercel.app",
      bypass: "opaque",
    })).rejects.toThrowError(new Error("AAIS_PREVIEW_TRUST_COOKIE"));
  });

  it("rejects a Vercel bypass cookie scoped to the broader parent domain", async () => {
    const bootstrap = await loadBootstrap();
    expect(bootstrap).toBeTypeOf("function");
    const context = trustedContext({
      cookies: [{
        name: "_vercel_jwt",
        domain: ".vercel.app",
        secure: true,
      }],
      response: fakeResponse({
        status: 200,
        url: "https://preview.example.vercel.app/login",
      }),
    });

    await expect(bootstrap?.({
      context,
      baseURL: "https://preview.example.vercel.app",
      bypass: "opaque",
    })).rejects.toThrowError(new Error("AAIS_PREVIEW_TRUST_COOKIE"));
  });

  it("accepts only the exact secure Vercel bypass cookie for the trusted host", async () => {
    const bootstrap = await loadBootstrap();
    expect(bootstrap).toBeTypeOf("function");
    const context = trustedContext({
      cookies: [{
        name: "_vercel_jwt",
        domain: ".preview.example.vercel.app",
        secure: true,
      }],
      response: fakeResponse({
        status: 200,
        url: "https://preview.example.vercel.app/login",
      }),
    });

    await expect(bootstrap?.({
      context,
      baseURL: "https://preview.example.vercel.app",
      bypass: "opaque",
    })).resolves.toBeUndefined();
    expect(context.request.get).toHaveBeenCalledTimes(1);
  });

  it("does not persist or attach bypass material", () => {
    const source = readFileSync("tests/e2e/aais-e2e-fixtures.ts", "utf8");
    expect(source).not.toContain("storageState(");
    expect(source).not.toContain("testInfo.attach");
    expect(source).not.toContain("extraHTTPHeaders");
    expect(source).not.toContain("writeFile");
  });
});

async function loadPlaywrightConfig(externalBaseURL?: string) {
  vi.resetModules();
  vi.unstubAllEnvs();
  if (externalBaseURL) {
    vi.stubEnv("AAIS_E2E_BASE_URL", externalBaseURL);
  } else {
    delete process.env.AAIS_E2E_BASE_URL;
  }
  const configModule = await import("../playwright.config");
  vi.unstubAllEnvs();
  return configModule.default;
}

async function loadBootstrap(): Promise<Bootstrap | undefined> {
  try {
    const modulePath = "./e2e/aais-e2e-fixtures";
    const fixtureModule = await import(/* @vite-ignore */ modulePath);
    return fixtureModule.bootstrapAaisPreviewOrigin as Bootstrap;
  } catch {
    return undefined;
  }
}

function fakeResponse(input: { status: number; url: string }) {
  return {
    status: () => input.status,
    url: () => input.url,
  };
}

class FakeContext {
  request: { get: ReturnType<typeof vi.fn> };
  cookies: ReturnType<typeof vi.fn>;

  constructor(input: {
    response?: ReturnType<typeof fakeResponse>;
    requestError?: Error;
    cookies?: Array<{ name: string; domain: string; secure: boolean }>;
  } = {}) {
    this.request = {
      get: vi.fn(async () => {
        if (input.requestError) {
          throw input.requestError;
        }
        return input.response ?? fakeResponse({
          status: 200,
          url: "https://aais-git-recovery.example.vercel.app/login",
        });
      }),
    };
    this.cookies = vi.fn(async () => input.cookies ?? [{
      name: "_vercel_jwt",
      domain: "aais-git-recovery.example.vercel.app",
      secure: true,
    }]);
  }
}

function trustedContext(input?: ConstructorParameters<typeof FakeContext>[0]) {
  return new FakeContext(input);
}
