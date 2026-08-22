import { describe, expect, it, vi } from "vitest";
import {
  listAaisPendingLrsDeliveryAttempts,
  type AaisDatabaseClient,
} from "@/lib/server/aais-learning-store";

const claimId = "10000000-0000-4000-8000-000000000025";
const statementIds = [
  "20000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
];

describe("AAIS pending product LRS delivery attempt discovery", () => {
  it("returns only the bounded exact-evidence projection with sorted statement ids", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        claim_id: claimId,
        state: "uncertain",
        started_at: "2026-08-20T00:00:00.000Z",
        reconcile_after: "2026-08-20T00:01:00.000Z",
        statement_count: 2,
        statement_ids: [statementIds[1], statementIds[0]],
        student_id: "learner-must-not-leak",
        frozen_statement: { actor: "must-not-leak" },
      }],
    }));
    const database: AaisDatabaseClient = { query };

    const attempts = await listAaisPendingLrsDeliveryAttempts({ database, limit: 3 });

    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/where attempt\.state in \('in_flight', 'uncertain'\)/),
      [3],
    );
    expect(attempts).toEqual([{
      claimId,
      state: "uncertain",
      startedAt: "2026-08-20T00:00:00.000Z",
      reconcileAfter: "2026-08-20T00:01:00.000Z",
      statementCount: 2,
      statementIds,
    }]);
    expect(JSON.stringify(attempts)).not.toContain("learner-must-not-leak");
    expect(JSON.stringify(attempts)).not.toContain("frozen_statement");
  });

  it("rejects invalid limits before querying and fails closed without a database", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const database: AaisDatabaseClient = { query };

    await expect(listAaisPendingLrsDeliveryAttempts({ database, limit: 0 }))
      .rejects.toThrow("Invalid AAIS pending LRS delivery attempt limit.");
    await expect(listAaisPendingLrsDeliveryAttempts({ database, limit: 51 }))
      .rejects.toThrow("Invalid AAIS pending LRS delivery attempt limit.");
    expect(query).not.toHaveBeenCalled();
    await expect(listAaisPendingLrsDeliveryAttempts({ database: null }))
      .rejects.toMatchObject({ name: "AaisLrsDeliveryReconciliationStoreError" });
  });

  it("maps missing reconciliation schema to not-ready and preserves unknown failures", async () => {
    const schemaError = Object.assign(new Error("private missing relation"), { code: "42P01" });
    const schemaDatabase: AaisDatabaseClient = {
      query: vi.fn(async () => {
        throw schemaError;
      }),
    };
    await expect(listAaisPendingLrsDeliveryAttempts({ database: schemaDatabase }))
      .rejects.toMatchObject({ name: "AaisLrsDeliveryReconciliationStoreError" });

    const unknownError = new Error("private database failure");
    const unknownDatabase: AaisDatabaseClient = {
      query: vi.fn(async () => {
        throw unknownError;
      }),
    };
    await expect(listAaisPendingLrsDeliveryAttempts({ database: unknownDatabase }))
      .rejects.toBe(unknownError);
  });

  it("fails closed on incomplete or duplicate statement snapshots", async () => {
    const createDatabase = (statementIdsValue: string[]): AaisDatabaseClient => ({
      query: vi.fn(async () => ({
        rows: [{
          claim_id: claimId,
          state: "in_flight",
          started_at: "2026-08-20T00:00:00.000Z",
          reconcile_after: "2026-08-20T00:01:00.000Z",
          statement_count: 2,
          statement_ids: statementIdsValue,
        }],
      })),
    });

    await expect(listAaisPendingLrsDeliveryAttempts({
      database: createDatabase([statementIds[0]]),
    })).rejects.toThrow("Invalid AAIS pending LRS delivery attempt row.");
    await expect(listAaisPendingLrsDeliveryAttempts({
      database: createDatabase([statementIds[0], statementIds[0]]),
    })).rejects.toThrow("Invalid AAIS pending LRS delivery attempt statement set.");
  });
});
