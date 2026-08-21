import { afterEach, describe, expect, it, vi } from "vitest";

const monitoring = vi.hoisted(() => ({ record: vi.fn() }));

vi.mock("@/lib/server/aais-monitoring", () => ({
  recordAaisMonitoringIssue: monitoring.record,
}));

describe("AAIS API error diagnostic projection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    monitoring.record.mockReset();
  });

  it("never emits a caller-controlled Error.name", async () => {
    const sentinel = "PROVIDER_BODY_SENTINEL_DO_NOT_CAPTURE";
    const cause = new Error("raw body is intentionally not inspected");
    cause.name = sentinel;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { createAaisApiErrorResponse } = await import("@/lib/server/aais-api-error");

    const response = createAaisApiErrorResponse({
      code: "AAIS_TEST_FAILURE",
      message: "A fixed public failure.",
      status: 503,
      cause,
      route: "/api/learning/ai-guide",
    });

    expect(response.status).toBe(503);
    const serialized = JSON.stringify({
      console: consoleError.mock.calls,
      monitoring: monitoring.record.mock.calls,
    });
    expect(serialized).not.toContain(sentinel);
    expect(JSON.parse(String(consoleError.mock.calls[0]?.[0]))).toMatchObject({
      event: "aais.api.error",
      causeKind: "error",
    });
    expect(monitoring.record).toHaveBeenCalledWith(expect.objectContaining({
      tags: expect.objectContaining({ "aais.cause_kind": "error" }),
      extra: expect.objectContaining({ causeKind: "error" }),
    }));
  });
});
