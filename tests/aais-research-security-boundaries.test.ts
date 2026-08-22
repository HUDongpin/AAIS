// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { AaisResearchConfiguration } from "@/lib/server/aais-research-contract";
import { getAaisResearchErrorResponseInput } from "@/lib/server/aais-research-api";
import {
  AaisResearchEventConflictError,
  AaisResearchEventLimitError,
  createAaisResearchStore,
  type AaisResearchDatabaseClient,
} from "@/lib/server/aais-research-store";

const visitId = "10000000-0000-4000-8000-000000000003";
const clientEventId = "10000000-0000-4000-8000-000000000004";

const configuration: AaisResearchConfiguration = {
  enabled: true,
  projectId: "aais",
  studyId: "ca-pilot-2026",
  environment: "research",
  lrsNamespace: "https://www.aais.site/xapi/studies/ca-pilot-2026/research/v1",
  lrsStoreId: "aais-research-test-store",
  appVersion: "0.1.0",
  commitSha: "0123456789abcdef",
  conditions: ["control", "treatment"],
  databaseUrl: "postgres://test:test@localhost/aais_research",
  databaseInstanceId: "aais-research-test-db",
  databaseDriver: "pg",
  rehearsalMode: true,
  participantActorIds: ["student-1"],
  identityEncryptionKey: Buffer.alloc(32, 9),
  identityFingerprintKey: Buffer.alloc(32, 10),
  identityKeyVersion: "v1",
  identityRetentionDays: 90,
  rawTextRetentionDays: 180,
  factRetentionDays: 1825,
  backupRetentionDays: 35,
};

describe("AAIS research security boundaries", () => {
  it("maps a changed payload under an existing client event id to a stable 409", async () => {
    const query = vi.fn<AaisResearchDatabaseClient["query"]>()
      .mockResolvedValueOnce({
        rows: [{
          participant_id: "10000000-0000-4000-8000-000000000001",
          study_run_id: "10000000-0000-4000-8000-000000000002",
          visit_id: visitId,
          condition: "control",
          status: "active",
        }],
      })
      .mockRejectedValueOnce(new Error("research event idempotency conflict"));
    const store = createAaisResearchStore({
      configuration,
      database: { query },
      now: () => new Date("2026-07-30T10:00:00.100Z"),
    });

    const promise = store.recordEvent({
      id: "student-1",
      role: "student",
      displayName: "Student One",
    }, {
      clientEventId,
      clientTime: "2026-07-30T10:00:00.000Z",
      expectedVisitId: visitId,
      eventName: "document_artifact_save",
      outcome: "success",
      aiLatencyMs: null,
      detail: {
        operation_id: "artifact-save-10000000-0000-4000-8000-000000000010",
        artifact_length: 12,
      },
    });

    await expect(promise).rejects.toThrow(AaisResearchEventConflictError);
    const response = getAaisResearchErrorResponseInput(
      new AaisResearchEventConflictError(),
      "/api/research/events",
    );
    expect(response).toMatchObject({
      code: "AAIS_RESEARCH_EVENT_CONFLICT",
      status: 409,
      extra: { secrets: "redacted" },
    });
  });

  it("maps a visit event inventory overflow to a stable retry-limited response", () => {
    const response = getAaisResearchErrorResponseInput(
      new AaisResearchEventLimitError(),
      "/api/research/events",
    );

    expect(response).toMatchObject({
      code: "AAIS_RESEARCH_EVENT_LIMIT_REACHED",
      status: 429,
      extra: { secrets: "redacted" },
    });
  });
});
