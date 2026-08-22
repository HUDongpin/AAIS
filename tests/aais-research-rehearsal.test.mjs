import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseAaisResearchEventInput } from "@/lib/server/aais-research-contract";
import {
  aaisResearchSyntheticActionManifest,
  reconcileAaisResearchSets,
} from "../scripts/rehearse-aais-research.mjs";

describe("AAIS research synthetic reconciliation", () => {
  it("passes only when operation, Postgres, outbox, and statement id sets are identical", () => {
    const ids = ["event-a", "event-b", "event-c"];
    expect(reconcileAaisResearchSets({
      expectedEventIds: ids,
      postgresEventIds: [...ids].reverse(),
      lrsEligibleEventIds: ids,
      lrsStatementIds: ids,
    })).toEqual({
      status: "pass",
      counts: {
        actualSemanticOperations: 3,
        postgresEvents: 3,
        shouldEnterLrs: 3,
        mockLrsStatements: 3,
      },
      differences: {
        missingFromPostgres: [],
        unexpectedInPostgres: [],
        missingFromLrsEligible: [],
        unexpectedInLrsEligible: [],
        missingStatementIds: [],
        unexpectedStatementIds: [],
      },
    });
  });

  it("reports id-level differences even when all counts happen to match", () => {
    const result = reconcileAaisResearchSets({
      expectedEventIds: ["event-a", "event-b"],
      postgresEventIds: ["event-a", "event-c"],
      lrsEligibleEventIds: ["event-a", "event-b"],
      lrsStatementIds: ["event-a", "event-b"],
    });
    expect(result).toMatchObject({
      status: "fail",
      counts: {
        actualSemanticOperations: 2,
        postgresEvents: 2,
        shouldEnterLrs: 2,
        mockLrsStatements: 2,
      },
      differences: {
        missingFromPostgres: ["event-b"],
        unexpectedInPostgres: ["event-c"],
      },
    });
  });

  it("uses production-compatible AAD and a distinct fingerprint key for committed ciphertext", async () => {
    const source = await readFile("scripts/rehearse-aais-research.mjs", "utf8");
    expect(source).toContain("aais-research-identity:v1");
    expect(source).toContain("aais-research-identity-fingerprint:v1:");
    expect(source).toContain("AAIS_RESEARCH_IDENTITY_ENCRYPTION_KEY");
    expect(source).toContain("AAIS_RESEARCH_IDENTITY_FINGERPRINT_KEY");
    expect(source).toContain("productionAadDecryptionVerified");
    expect(source).toContain("independentFingerprintKey: true");
  });

  it("records latency only on AI guide events", () => {
    expect(
      aaisResearchSyntheticActionManifest
        .filter((action) => action.latencyMs !== undefined)
        .map((action) => action.eventName),
    ).toEqual(["ai_guide_submit"]);
  });

  it("keeps every synthetic action inside the production controlled metadata contract", () => {
    for (const action of aaisResearchSyntheticActionManifest) {
      expect(() => parseAaisResearchEventInput({
        clientEventId: randomUUID(),
        clientTime: "2026-07-30T10:00:00.000Z",
        expectedVisitId: randomUUID(),
        eventName: action.eventName,
        outcome: action.outcome,
        ...(action.latencyMs === undefined ? {} : { aiLatencyMs: action.latencyMs }),
        detail: {
          operation_id: `${action.operationPrefix}-${randomUUID()}`,
          ...action.detail,
        },
      })).not.toThrow();
    }
  });
});
