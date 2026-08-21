import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probeMocks = vi.hoisted(() => ({
  run: vi.fn(),
}));

vi.mock("@/lib/server/aais-ai-live-probe", () => ({
  isAaisAiLiveProbeSyntheticId: (value: unknown) => [
    "aais-live-primary-a1-zh-v1",
    "aais-live-primary-a1-en-v1",
    "aais-live-primary-a2-zh-v1",
    "aais-live-primary-a2-en-v1",
    "aais-live-secondary-a1-zh-v1",
    "aais-live-secondary-a1-en-v1",
    "aais-live-secondary-a2-zh-v1",
    "aais-live-secondary-a2-en-v1",
  ].includes(String(value)),
  projectAaisAiLiveProbePublicReport: (report: {
    status: string;
    target: { providerRole: string };
    release: { modelFingerprint: string; manifestSha256: string };
    runtime: { latencyMs: number };
    diagnosticId: string;
  }) => ({
    status: report.status,
    role: report.target.providerRole,
    modelFingerprint: report.release.modelFingerprint,
    evalManifestSha256: report.release.manifestSha256,
    latencyMs: report.runtime.latencyMs,
    diagnosticId: report.diagnosticId,
  }),
  runAaisAiLiveProbe: probeMocks.run,
}));

const probeBearer = "live-probe-bearer-with-at-least-32-characters";

describe("POST /api/system/ai-live-probe", () => {
  beforeEach(() => {
    probeMocks.run.mockReset();
    vi.stubEnv("AAIS_AI_LIVE_PROBE_BEARER_TOKEN", probeBearer);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("authorizes before reading the body or invoking a provider", async () => {
    const { POST } = await import("@/app/api/system/ai-live-probe/route");
    const response = await POST(new Request(
      "http://localhost/api/system/ai-live-probe",
      {
        method: "POST",
        body: "not-json",
      },
    ));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "AAIS_AI_LIVE_PROBE_AUTH_REQUIRED" },
      secrets: "redacted",
    });
    expect(probeMocks.run).not.toHaveBeenCalled();
  });

  it("fails closed when the dedicated bearer is missing or weak", async () => {
    vi.stubEnv("AAIS_AI_LIVE_PROBE_BEARER_TOKEN", "weak");
    const { POST } = await import("@/app/api/system/ai-live-probe/route");
    const response = await POST(createProbeRequest(
      { syntheticId: "aais-live-primary-a1-zh-v1" },
      "weak",
    ));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "AAIS_AI_LIVE_PROBE_NOT_CONFIGURED" },
      secrets: "redacted",
    });
    expect(probeMocks.run).not.toHaveBeenCalled();
  });

  it("rejects a non-matching bearer without returning diagnostics", async () => {
    const { POST } = await import("@/app/api/system/ai-live-probe/route");
    const response = await POST(createProbeRequest(
      { syntheticId: "aais-live-primary-a1-zh-v1" },
      "different-live-probe-bearer-with-at-least-32-characters",
    ));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      error: { code: "AAIS_AI_LIVE_PROBE_FORBIDDEN" },
      secrets: "redacted",
    });
    expect(JSON.stringify(body)).not.toContain(probeBearer);
    expect(probeMocks.run).not.toHaveBeenCalled();
  });

  it("accepts only one allowlisted syntheticId and no free-form input", async () => {
    const { POST } = await import("@/app/api/system/ai-live-probe/route");
    for (const body of [
      { syntheticId: "invented-id" },
      {
        syntheticId: "aais-live-primary-a1-zh-v1",
        learnerInput: "arbitrary operator prompt",
      },
      { learnerInput: "arbitrary operator prompt" },
    ]) {
      const response = await POST(createProbeRequest(body));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "AAIS_AI_LIVE_PROBE_ID_INVALID" },
      });
    }
    expect(probeMocks.run).not.toHaveBeenCalled();
  });

  it("maps malformed and oversized bodies to bounded client errors", async () => {
    const { POST } = await import("@/app/api/system/ai-live-probe/route");
    const malformed = await POST(new Request(
      "http://localhost/api/system/ai-live-probe",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${probeBearer}`,
          "content-type": "application/json",
        },
        body: "not-json",
      },
    ));
    const oversized = await POST(new Request(
      "http://localhost/api/system/ai-live-probe",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${probeBearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ syntheticId: "x".repeat(300) }),
      },
    ));

    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      error: { code: "AAIS_AI_LIVE_PROBE_BODY_INVALID" },
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: "AAIS_AI_LIVE_PROBE_BODY_TOO_LARGE" },
    });
    expect(probeMocks.run).not.toHaveBeenCalled();
  });

  it("returns only the probe service's redacted report with private no-store caching", async () => {
    probeMocks.run.mockResolvedValue({
      httpStatus: 200,
      report: {
        status: "live",
        diagnosticId: "71000000-0000-4000-8000-000000000008",
        target: { providerRole: "secondary" },
        release: {
          modelFingerprint: "1234567890abcdef",
          manifestSha256: "2".repeat(64),
        },
        runtime: { latencyMs: 123 },
        secretInternalField: "must-not-project",
      },
    });
    const { POST } = await import("@/app/api/system/ai-live-probe/route");
    const response = await POST(createProbeRequest({
      syntheticId: "aais-live-secondary-a2-en-v1",
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(probeMocks.run).toHaveBeenCalledWith(
      "aais-live-secondary-a2-en-v1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(body).toEqual({
      status: "live",
      role: "secondary",
      modelFingerprint: "1234567890abcdef",
      evalManifestSha256: "2".repeat(64),
      latencyMs: 123,
      diagnosticId: "71000000-0000-4000-8000-000000000008",
    });
    expect(JSON.stringify(body)).not.toContain(probeBearer);
  });
});

function createProbeRequest(
  body: unknown,
  bearer = probeBearer,
) {
  return new Request("http://localhost/api/system/ai-live-probe", {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
