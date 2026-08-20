// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAaisCsrfToken } from "@/lib/server/aais-csrf";

const mocks = vi.hoisted(() => ({
  actor: {
    id: "Synthetic1",
    role: "student" as const,
    displayName: "Synthetic 1",
  },
  requireActor: vi.fn(),
  getStore: vi.fn(),
  recordEvent: vi.fn(),
  completeStudyRun: vi.fn(),
  withdrawStudyRun: vi.fn(),
}));

vi.mock("@/lib/server/aais-request-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/aais-request-auth")>();
  return {
    ...actual,
    requireAaisSessionActor: mocks.requireActor,
  };
});

vi.mock("@/lib/server/aais-research-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/aais-research-store")>();
  return {
    ...actual,
    getAaisResearchStore: mocks.getStore,
  };
});

type ResearchMutationRoute = {
  name: string;
  path: string;
  validBody: Record<string, unknown>;
  load: () => Promise<(request: Request) => Promise<Response>>;
};

const studyRunId = "10000000-0000-4000-8000-000000000001";

const researchMutationRoutes: ResearchMutationRoute[] = [
  {
    name: "event",
    path: "/api/research/events",
    validBody: {
      clientEventId: "10000000-0000-4000-8000-000000000002",
      clientTime: "2026-08-19T00:00:00.000Z",
      expectedVisitId: "10000000-0000-4000-8000-000000000003",
      eventName: "workspace_session_load",
      outcome: "success",
      detail: {},
    },
    load: async () => (await import("@/app/api/research/events/route")).POST,
  },
  {
    name: "completion",
    path: "/api/research/visit/complete",
    validBody: { studyRunId },
    load: async () => (await import("@/app/api/research/visit/complete/route")).POST,
  },
  {
    name: "withdrawal",
    path: "/api/research/withdrawal",
    validBody: { studyRunId },
    load: async () => (await import("@/app/api/research/withdrawal/route")).POST,
  },
];

beforeEach(() => {
  process.env.AAIS_RESEARCH_MODE = "true";
  process.env.AAIS_SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
  mocks.requireActor.mockResolvedValue(mocks.actor);
  mocks.recordEvent.mockResolvedValue({ created: true, eventId: "event-1" });
  mocks.completeStudyRun.mockResolvedValue({ status: "completed" });
  mocks.withdrawStudyRun.mockResolvedValue({ status: "withdrawn" });
  mocks.getStore.mockReturnValue({
    recordEvent: mocks.recordEvent,
    completeStudyRun: mocks.completeStudyRun,
    withdrawStudyRun: mocks.withdrawStudyRun,
  });
});

afterEach(() => {
  delete process.env.AAIS_RESEARCH_MODE;
  delete process.env.AAIS_SESSION_SECRET;
  vi.clearAllMocks();
});

describe("AAIS research mutation request body bounds", () => {
  it.each(researchMutationRoutes)(
    "accepts an in-bounds $name request",
    async ({ path, validBody, load }) => {
      const response = await (await load())(createResearchRequest(path, {
        body: JSON.stringify(validBody),
      }));

      expect(response.status).toBe(path === "/api/research/events" ? 201 : 200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(mocks.getStore).toHaveBeenCalledOnce();
    },
  );

  it.each(researchMutationRoutes)(
    "rejects malformed chunked JSON for $name before obtaining the store",
    async ({ path, load }) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"broken":'));
          controller.enqueue(new TextEncoder().encode("not-json"));
          controller.close();
        },
      });

      const response = await (await load())(createResearchRequest(path, { body }));

      await expectInvalidBodyResponse(response, 400, "AAIS_RESEARCH_REQUEST_INVALID");
      expectNoStoreMutation();
    },
  );

  it.each(researchMutationRoutes)(
    "rejects a declared oversized $name request before obtaining the store",
    async ({ path, load }) => {
      const request = createResearchRequest(path, {
        body: "{}",
        headers: { "content-length": String(64 * 1024) },
      });

      const response = await (await load())(request);

      await expectInvalidBodyResponse(response, 413, "AAIS_RESEARCH_REQUEST_TOO_LARGE");
      expect(request.bodyUsed).toBe(false);
      expectNoStoreMutation();
    },
  );

  it.each(researchMutationRoutes)(
    "stops an oversized chunked $name request before obtaining the store",
    async ({ path, load }) => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(20 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      });

      const response = await (await load())(createResearchRequest(path, { body }));

      await expectInvalidBodyResponse(response, 413, "AAIS_RESEARCH_REQUEST_TOO_LARGE");
      expect(cancelled).toBe(true);
      expectNoStoreMutation();
    },
  );
});

function createResearchRequest(
  path: string,
  input: {
    body: BodyInit | ReadableStream<Uint8Array>;
    headers?: HeadersInit;
  },
) {
  const csrf = createAaisCsrfToken(mocks.actor.id);
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      cookie: `aais_csrf=${encodeURIComponent(csrf)}`,
      "x-aais-csrf": csrf,
      ...input.headers,
    },
    body: input.body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

async function expectInvalidBodyResponse(
  response: Response,
  status: 400 | 413,
  code: "AAIS_RESEARCH_REQUEST_INVALID" | "AAIS_RESEARCH_REQUEST_TOO_LARGE",
) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({
    error: { code },
    secrets: "redacted",
  });
}

function expectNoStoreMutation() {
  expect(mocks.getStore).not.toHaveBeenCalled();
  expect(mocks.recordEvent).not.toHaveBeenCalled();
  expect(mocks.completeStudyRun).not.toHaveBeenCalled();
  expect(mocks.withdrawStudyRun).not.toHaveBeenCalled();
}
