import { afterEach, describe, expect, it, vi } from "vitest";

const { recordMonitoringIssue } = vi.hoisted(() => ({
  recordMonitoringIssue: vi.fn(),
}));

vi.mock("@/lib/server/aais-monitoring", () => ({
  recordAaisMonitoringIssue: recordMonitoringIssue,
}));

import {
  createAaisAiGuideDiagnosticRecord,
  projectAaisGuideProviderAttemptsForDiagnostic,
  recordAaisAiGuideDiagnostic,
} from "@/lib/server/aais-ai-guide-diagnostics";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  recordMonitoringIssue.mockReset();
});

describe("AAIS AI guide diagnostics", () => {
  it("emits only the fixed redacted schema", () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123def456");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_safe123");
    const diagnosticId = "10000000-0000-4000-8000-000000000010";
    const record = createAaisAiGuideDiagnosticRecord({
      event: "aais.ai.guide.failed",
      outcome: "failed",
      category: "provider",
      reason: "auth_failed",
      providerRole: "primary",
      agent: "A1",
      locale: "zh-CN",
      modelFingerprint: "https://secret.example.test/model?token=secret",
      evalManifestDigest: `sha256:${"a".repeat(64)}`,
      retryable: false,
      attempts: 1,
      latencyMs: 1_234,
      persistence: "not-started",
      budgetDisposition: "charged-once",
      transport: "sse",
      diagnosticId,
      operationId: diagnosticId,
      requestAttemptId: "20000000-0000-4000-8000-000000000020",
      prompt: "student secret prompt",
      response: "provider secret response",
      endpoint: "https://secret.example.test",
    } as Parameters<typeof createAaisAiGuideDiagnosticRecord>[0] & Record<string, unknown>);

    expect(record).toMatchObject({
      schemaVersion: 1,
      event: "aais.ai.guide.failed",
      category: "provider",
      reason: "auth_failed",
      diagnosticId,
      modelFingerprint: null,
      evalManifestDigest: `sha256:${"a".repeat(64)}`,
      redaction: {
        secrets: "omitted",
        endpoints: "omitted",
        prompt: "omitted",
        response: "omitted",
        learnerIdentity: "omitted",
        providerBody: "omitted",
      },
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("student secret prompt");
    expect(serialized).not.toContain("provider secret response");
    expect(serialized).not.toContain("secret.example.test");
    expect(serialized).not.toContain("token=secret");
  });

  it("keeps correlation ids out of Sentry tags", () => {
    const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const diagnosticId = "10000000-0000-4000-8000-000000000010";

    recordAaisAiGuideDiagnostic({
      event: "aais.ai.guide.failover",
      outcome: "live_secondary",
      category: "provider",
      reason: "response_timeout",
      providerRole: "secondary",
      agent: "A2",
      locale: "en-US",
      diagnosticId,
      operationId: diagnosticId,
      requestAttemptId: "20000000-0000-4000-8000-000000000020",
    });

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(recordMonitoringIssue).toHaveBeenCalledOnce();
    const monitoringInput = recordMonitoringIssue.mock.calls[0]?.[0];
    expect(JSON.stringify(monitoringInput.tags)).not.toContain(diagnosticId);
    expect(monitoringInput.extra).toMatchObject({ diagnosticId });
  });

  it("uses the same fixed allowlist for probe diagnostics and ignores raw extras", () => {
    const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const diagnosticId = "30000000-0000-4000-8000-000000000030";
    const record = recordAaisAiGuideDiagnostic({
      event: "aais.ai.probe.failed",
      outcome: "failed",
      category: "provider",
      reason: "observed_revision_mismatch",
      providerRole: "secondary",
      agent: "A2",
      locale: "en-US",
      modelFingerprint: "a".repeat(16),
      evalManifestDigest: "b".repeat(64),
      attempts: 1,
      transport: "probe",
      route: "probe",
      diagnosticId,
      rawError: "provider secret response",
      prompt: "student secret prompt",
      endpoint: "https://secret.example.test",
    } as Parameters<typeof recordAaisAiGuideDiagnostic>[0] & Record<string, unknown>);

    expect(record).toMatchObject({
      event: "aais.ai.probe.failed",
      route: "/api/system/ai-live-probe",
      transport: "probe",
      reason: "observed_revision_mismatch",
      diagnosticId,
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("provider secret response");
    expect(serialized).not.toContain("student secret prompt");
    expect(serialized).not.toContain("secret.example.test");
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(recordMonitoringIssue).toHaveBeenCalledOnce();
  });

  it("keeps both provider reasons under one diagnostic id without raw fields", () => {
    const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const diagnosticId = "40000000-0000-4000-8000-000000000040";
    const providerAttempts = projectAaisGuideProviderAttemptsForDiagnostic([
      {
        role: "primary",
        outcome: "failed",
        attempts: 1,
        modelFingerprint: "a".repeat(64),
        observedModel: "matched",
        observedRevision: "matched",
        observedRevisionSha256: "b".repeat(64),
        reason: "auth-failed",
        rawError: "primary provider credential and response",
      },
      {
        role: "fallback",
        outcome: "failed",
        attempts: 1,
        modelFingerprint: "c".repeat(64),
        observedModel: "mismatch",
        observedRevision: "mismatch",
        observedRevisionSha256: "d".repeat(64),
        reason: "observed-revision-mismatch",
        endpoint: "https://secret.example.test/chat/completions",
      },
      {
        role: "fallback",
        outcome: "failed",
        attempts: 99,
        observedModel: "missing",
        reason: "payment-required",
      },
    ] as Parameters<typeof projectAaisGuideProviderAttemptsForDiagnostic>[0]
      & Array<Record<string, unknown>>);

    const record = recordAaisAiGuideDiagnostic({
      event: "aais.ai.guide.failed",
      outcome: "failed",
      category: "provider",
      reason: "chain_exhausted",
      providerRole: "secondary",
      diagnosticId,
      providerAttempts,
    });

    expect(record.providerAttempts).toEqual([
      expect.objectContaining({
        role: "primary",
        outcome: "failed",
        reason: "auth_failed",
        attempts: 1,
        observedRevisionSha256: "b".repeat(64),
      }),
      expect.objectContaining({
        role: "secondary",
        outcome: "failed",
        reason: "payment_required",
        attempts: 99,
      }),
    ]);
    expect(record.diagnosticId).toBe(diagnosticId);
    const serialized = JSON.stringify(recordMonitoringIssue.mock.calls[0]?.[0]?.extra);
    expect(serialized).toContain(diagnosticId);
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("secret.example.test");
    expect(serialized).not.toContain("primary provider credential and response");
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it("projects a source-lock gate without exposing lock or provider contents", () => {
    expect(projectAaisGuideProviderAttemptsForDiagnostic([{
      role: "primary",
      outcome: "skipped",
      attempts: 0,
      observedModel: "not-reported",
      observedRevision: "not-reported",
      gateReason: "release-lock-blocked",
    }])).toEqual([{
      role: "primary",
      outcome: "blocked",
      reason: "release_lock_blocked",
      attempts: 0,
      modelFingerprint: null,
      observedModel: "not-reported",
      observedRevision: "not-reported",
      observedRevisionSha256: null,
    }]);
  });
});
