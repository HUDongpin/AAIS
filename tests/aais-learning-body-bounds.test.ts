import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAaisCsrfToken, getAaisCsrfCookieName } from "@/lib/server/aais-csrf";
import { createAaisSessionToken } from "@/lib/server/aais-session";

const guideBodyLimit = 16 * 1024 * 1024;
const sessionBodyLimit = 16 * 1024 * 1024;
const privacyBodyLimit = 16 * 1024;
const scaffoldBodyLimit = 16 * 1024;

let getLearningStore: ReturnType<typeof vi.fn>;
let runGuideGraph: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.AAIS_SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
  getLearningStore = vi.fn(() => {
    throw new Error("learner storage must not be reached for an invalid body");
  });
  runGuideGraph = vi.fn(() => {
    throw new Error("AI provider orchestration must not be reached for an invalid body");
  });
  vi.doMock("@/lib/server/aais-learning-store", async () => {
    const actual = await vi.importActual<typeof import("@/lib/server/aais-learning-store")>(
      "@/lib/server/aais-learning-store",
    );
    return {
      ...actual,
      getAaisLearningStore: getLearningStore,
    };
  });
  vi.doMock("@/lib/ai/orchestration/aais-learning-guide-graph", async () => {
    const actual = await vi.importActual<
      typeof import("@/lib/ai/orchestration/aais-learning-guide-graph")
    >("@/lib/ai/orchestration/aais-learning-guide-graph");
    return {
      ...actual,
      runAaisLearningGuideGraph: runGuideGraph,
    };
  });
  vi.resetModules();
});

afterEach(() => {
  delete process.env.AAIS_SESSION_SECRET;
  vi.doUnmock("@/lib/server/aais-learning-store");
  vi.doUnmock("@/lib/ai/orchestration/aais-learning-guide-graph");
  vi.unstubAllEnvs();
});

describe("AAIS learning mutation request body limits", () => {
  it.each([
    ["guide", "/api/learning/ai-guide", "POST", "AAIS_GUIDE_BODY_INVALID"],
    ["session", "/api/learning/session", "PATCH", "AAIS_SESSION_BODY_INVALID"],
    ["scaffold", "/api/learning/scaffold", "POST", "AAIS_SCAFFOLD_BODY_INVALID"],
  ])("rejects malformed authenticated %s JSON before storage, quota, or provider work", async (
    routeName,
    pathname,
    method,
    code,
  ) => {
    const route = await importRoute(routeName);
    const response = await route(
      new Request(`http://localhost${pathname}`, {
        method,
        headers: authenticatedHeaders("malformed-body-learner"),
        body: "{not-json",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(getLearningStore).not.toHaveBeenCalled();
    expect(runGuideGraph).not.toHaveBeenCalled();
  });

  it("rejects an invalid UTF-8 guide body before storage, quota, or provider work", async () => {
    const { POST } = await import("@/app/api/learning/ai-guide/route");
    const response = await POST(new Request("http://localhost/api/learning/ai-guide", {
      method: "POST",
      headers: authenticatedHeaders("invalid-utf8-learner"),
      body: new Uint8Array([0xff, 0xfe]),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "AAIS_GUIDE_BODY_INVALID" },
    });
    expect(getLearningStore).not.toHaveBeenCalled();
    expect(runGuideGraph).not.toHaveBeenCalled();
  });

  it.each([
    ["guide", "/api/learning/ai-guide", "POST", guideBodyLimit, "AAIS_GUIDE_BODY_TOO_LARGE"],
    ["session", "/api/learning/session", "PATCH", sessionBodyLimit, "AAIS_SESSION_BODY_TOO_LARGE"],
    ["scaffold", "/api/learning/scaffold", "POST", scaffoldBodyLimit, "AAIS_SCAFFOLD_BODY_TOO_LARGE"],
  ])("rejects a declared oversized %s body before consuming it or doing downstream work", async (
    routeName,
    pathname,
    method,
    limit,
    code,
  ) => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    });
    const route = await importRoute(routeName);
    const request = new Request(`http://localhost${pathname}`, {
      method,
      headers: {
        ...authenticatedHeaders("oversized-body-learner"),
        "content-length": String(limit + 1),
      },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await route(request);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(request.bodyUsed).toBe(false);
    expect(getLearningStore).not.toHaveBeenCalled();
    expect(runGuideGraph).not.toHaveBeenCalled();
  });

  it.each([
    ["guide", "/api/learning/ai-guide", "POST", "AAIS_AUTH_REQUIRED"],
    ["session", "/api/learning/session", "PATCH", "AAIS_AUTH_REQUIRED"],
    ["scaffold", "/api/learning/scaffold", "POST", "AAIS_AUTH_REQUIRED"],
  ])("rejects an unauthenticated %s mutation without consuming its request body", async (
    routeName,
    pathname,
    method,
    code,
  ) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const route = await importRoute(routeName);
    const request = new Request(`http://localhost${pathname}`, {
      method,
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await route(request);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(request.bodyUsed).toBe(false);
    expect(getLearningStore).not.toHaveBeenCalled();
    expect(runGuideGraph).not.toHaveBeenCalled();
  });

  it.each([
    ["guide", "/api/learning/ai-guide", "POST"],
    ["session", "/api/learning/session", "PATCH"],
    ["scaffold", "/api/learning/scaffold", "POST"],
  ])("rejects an authenticated %s mutation without CSRF before consuming its body", async (
    routeName,
    pathname,
    method,
  ) => {
    const csrf = createAaisCsrfToken("csrf-order-learner");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const route = await importRoute(routeName);
    const request = new Request(`http://localhost${pathname}`, {
      method,
      headers: {
        cookie: createAuthedCookie("csrf-order-learner", csrf),
      },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await route(request);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "AAIS_CSRF_REQUIRED" },
    });
    expect(request.bodyUsed).toBe(false);
    expect(getLearningStore).not.toHaveBeenCalled();
    expect(runGuideGraph).not.toHaveBeenCalled();
  });

  it("cancels a chunked oversized authenticated scaffold body before storage", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(scaffoldBodyLimit));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { POST } = await import("@/app/api/learning/scaffold/route");
    const response = await POST(new Request("http://localhost/api/learning/scaffold", {
      method: "POST",
      headers: authenticatedHeaders("oversized-scaffold-learner"),
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "AAIS_SCAFFOLD_BODY_TOO_LARGE" },
    });
    expect(cancelled).toBe(true);
    expect(getLearningStore).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed", "{not-json", undefined, 400, "AAIS_PRIVACY_BODY_INVALID"],
    ["declared oversized", "{}", privacyBodyLimit + 1, 413, "AAIS_PRIVACY_BODY_TOO_LARGE"],
  ])("rejects an authenticated %s privacy deletion body without mutating storage", async (
    _label,
    body,
    contentLength,
    status,
    code,
  ) => {
    const studentId = "privacy-body-learner";
    const csrf = createAaisCsrfToken(studentId);
    const { DELETE } = await import("@/app/api/learning/privacy/route");
    const response = await DELETE(new Request("http://localhost/api/learning/privacy", {
      method: "DELETE",
      headers: {
        cookie: createAuthedCookie(studentId, csrf),
        "x-aais-csrf": csrf,
        ...(contentLength ? { "content-length": String(contentLength) } : {}),
      },
      body,
    }));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({
      error: { code },
      secrets: "redacted",
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(getLearningStore).not.toHaveBeenCalled();
  });
});

async function importRoute(routeName: unknown) {
  if (routeName === "guide") {
    return (await import("@/app/api/learning/ai-guide/route")).POST;
  }
  if (routeName === "session") {
    return (await import("@/app/api/learning/session/route")).PATCH;
  }
  return (await import("@/app/api/learning/scaffold/route")).POST;
}

function createAuthedCookie(studentId: string, csrfToken: string) {
  const sessionToken = createAaisSessionToken({
    id: studentId,
    role: "student",
    displayName: studentId,
  }, new Date(), { authSource: "development" });
  return `aais_session=${sessionToken}; ${getAaisCsrfCookieName()}=${csrfToken}`;
}

function authenticatedHeaders(studentId: string) {
  const csrf = createAaisCsrfToken(studentId);
  return {
    cookie: createAuthedCookie(studentId, csrf),
    "x-aais-csrf": csrf,
  };
}
