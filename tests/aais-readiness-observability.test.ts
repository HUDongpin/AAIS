import { afterEach, describe, expect, it, vi } from "vitest";
import { recordAaisReadinessOutcome } from "@/lib/server/aais-readiness-observability";

describe("AAIS readiness observability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs only redacted issue codes and rate-limits an unchanged not-ready outcome", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const notReady = {
      status: "not_ready" as const,
      readinessMode: "traffic" as const,
      issues: ["AAIS_AI_EVAL_MANIFEST", "AAIS_AI_EVAL_APPROVED/AAIS_AI_EVAL_VERSION"],
      warnings: ["private-warning-detail-that-must-not-be-logged"],
      releaseGitCommitShortSha: "8475495",
    };

    recordAaisReadinessOutcome(notReady, 1_000);
    recordAaisReadinessOutcome(notReady, 2_000);

    expect(warn).toHaveBeenCalledTimes(1);
    const diagnostic = JSON.parse(String(warn.mock.calls[0]?.[0]));
    expect(diagnostic).toEqual({
      event: "aais.readiness.not_ready",
      readinessMode: "traffic",
      issueCount: 2,
      issues: ["AAIS_AI_EVAL_APPROVED/AAIS_AI_EVAL_VERSION", "AAIS_AI_EVAL_MANIFEST"],
      warningCount: 1,
      releaseGitCommitShortSha: "8475495",
      secrets: "redacted",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("private-warning-detail");

    recordAaisReadinessOutcome({ ...notReady, status: "ready", issues: [] }, 3_000);
    recordAaisReadinessOutcome(notReady, 4_000);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
