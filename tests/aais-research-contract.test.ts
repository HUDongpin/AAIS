// @vitest-environment node

import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AaisResearchConfigurationError,
  AaisResearchValidationError,
  decryptAaisResearchIdentity,
  encryptAaisResearchIdentity,
  getAaisResearchConfiguration,
  isAaisResearchModeEnabled,
  parseAaisResearchEventInput,
  requiresAaisResearchDataPlaneIsolation,
  type AaisResearchConfiguration,
} from "@/lib/server/aais-research-contract";
import {
  buildAaisResearchXapiStatement,
  createAaisResearchLrsAbsenceReceiptEnvelope,
  deleteAaisResearchStatement,
  getAaisResearchLrsConfigurationStatus,
  sendAaisResearchStatement,
} from "@/lib/server/aais-research-lrs";
import {
  assertAaisResearchCollectionLaunchGate,
  getAaisResearchCollectionLaunchGate,
} from "@/lib/server/aais-research-launch";

const encryptionKey = Buffer.alloc(32, 7);
const receiptKeyId = "provider-ed25519-2026-01";
const receiptKeyPair = generateKeyPairSync("ed25519");
const receiptVerifyingSpki = receiptKeyPair.publicKey
  .export({ format: "der", type: "spki" })
  .toString("base64");

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
  identityEncryptionKey: encryptionKey,
  identityFingerprintKey: Buffer.alloc(32, 8),
  identityKeyVersion: "v1",
  identityRetentionDays: 90,
  rawTextRetentionDays: 180,
  factRetentionDays: 1825,
  backupRetentionDays: 35,
};

describe("AAIS research contract", () => {
  it("enables only literal true research mode", () => {
    expect(isAaisResearchModeEnabled({ AAIS_RESEARCH_MODE: "true" })).toBe(true);
    expect(isAaisResearchModeEnabled({ AAIS_RESEARCH_MODE: "enabled" })).toBe(false);
    expect(isAaisResearchModeEnabled({ AAIS_RESEARCH_MODE: "false" })).toBe(false);
    expect(isAaisResearchModeEnabled({})).toBe(false);
  });

  it("keeps the legacy product data plane isolated when mode is active or required", () => {
    expect(requiresAaisResearchDataPlaneIsolation({
      AAIS_RESEARCH_MODE: "true",
    })).toBe(true);
    expect(requiresAaisResearchDataPlaneIsolation({
      AAIS_RESEARCH_MODE: "false",
      AAIS_RESEARCH_REQUIRED: "true",
    })).toBe(true);
    expect(requiresAaisResearchDataPlaneIsolation({
      AAIS_RESEARCH_MODE: "false",
      AAIS_RESEARCH_REQUIRED: "false",
    })).toBe(false);
  });

  it("blocks formal collection until distinct access, workers, LRS configuration, and receipts exist", () => {
    const env = createFormalLaunchEnvironment();
    expect(getAaisResearchCollectionLaunchGate(env)).toEqual({
      ready: true,
      rehearsal: false,
      accessReady: true,
      workersReady: true,
      lrsConfigurationReady: true,
      evidenceReady: true,
    });
    expect(() => assertAaisResearchCollectionLaunchGate(env)).not.toThrow();

    expect(() => assertAaisResearchCollectionLaunchGate({
      ...env,
      AAIS_RESEARCH_LRS_ZERO_BASELINE_RECEIPT_SHA256:
        env.AAIS_RESEARCH_LRS_ISOLATION_RECEIPT_SHA256,
    })).toThrow(AaisResearchConfigurationError);
    expect(() => assertAaisResearchCollectionLaunchGate({
      ...env,
      AAIS_RESEARCH_RETENTION_TOKEN: env.AAIS_RESEARCH_LRS_OUTBOX_FLUSH_TOKEN,
    })).toThrow(AaisResearchConfigurationError);
    expect(() => assertAaisResearchCollectionLaunchGate({
      ...env,
      AAIS_RESEARCH_EXPORT_ACTOR_IDS: "",
    })).toThrow(AaisResearchConfigurationError);
    expect(() => assertAaisResearchCollectionLaunchGate({
      ...env,
      AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_ID: "",
      AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_SPKI: "",
    })).toThrow(AaisResearchConfigurationError);
    expect(() => assertAaisResearchCollectionLaunchGate({
      ...env,
      AAIS_RESEARCH_CONSENT_LEGAL_BASIS_RECEIPT_SHA256: "",
    })).toThrow(AaisResearchConfigurationError);
    expect(() => assertAaisResearchCollectionLaunchGate({
      ...env,
      AAIS_RESEARCH_DPA_RECEIPT_SHA256:
        env.AAIS_RESEARCH_DATA_REGION_RECEIPT_SHA256,
    })).toThrow(AaisResearchConfigurationError);
    expect(() => assertAaisResearchCollectionLaunchGate({
      ...env,
      AAIS_RESEARCH_DAILY_BACKUP_COMPLETED_AT:
        new Date(Date.now() - 37 * 60 * 60 * 1_000).toISOString(),
    })).toThrow(AaisResearchConfigurationError);
    expect(() => assertAaisResearchCollectionLaunchGate({
      ...env,
      AAIS_RESEARCH_BACKUP_DESTRUCTION_OBSERVED_AT:
        new Date(Date.now() - 46 * 24 * 60 * 60 * 1_000).toISOString(),
    })).toThrow(AaisResearchConfigurationError);
    expect(() => assertAaisResearchCollectionLaunchGate({
      ...env,
      AAIS_RESEARCH_GOVERNANCE_MANIFEST_VALID_UNTIL:
        new Date(Date.now() - 1_000).toISOString(),
    })).toThrow(AaisResearchConfigurationError);
    expect(() => assertAaisResearchCollectionLaunchGate({
      ...env,
      AAIS_RESEARCH_GOVERNANCE_MANIFEST_VERIFIED_AT:
        new Date(Date.now() - 37 * 60 * 60 * 1_000).toISOString(),
    })).toThrow(AaisResearchConfigurationError);
    expect(() => assertAaisResearchCollectionLaunchGate({
      ...env,
      AAIS_RESEARCH_DAILY_BACKUP_COMPLETED_AT: "2026-02-31T00:00:00Z",
    })).toThrow(AaisResearchConfigurationError);
  });

  it("allows only an explicitly approved 3-5 participant research rehearsal to bypass formal receipts", () => {
    const env = createResearchEnvironment();
    expect(getAaisResearchCollectionLaunchGate(env)).toMatchObject({
      ready: true,
      rehearsal: true,
    });
    expect(() => assertAaisResearchCollectionLaunchGate(env)).not.toThrow();
    expect(() => assertAaisResearchCollectionLaunchGate({
      ...env,
      AAIS_RESEARCH_REHEARSAL_APPROVED: "false",
    })).toThrow(AaisResearchConfigurationError);
  });

  it("requires a dedicated scoped Postgres configuration and a real commit SHA", () => {
    const config = getAaisResearchConfiguration({
      AAIS_RESEARCH_MODE: "true",
      AAIS_RESEARCH_PROJECT_ID: "aais",
      AAIS_RESEARCH_STUDY_ID: "ca-pilot-2026",
      AAIS_RESEARCH_ENVIRONMENT: "research",
      AAIS_APP_VERSION: "0.1.0",
      AAIS_COMMIT_SHA: "0123456789abcdef",
      AAIS_RESEARCH_DATABASE_URL: "postgres://test:test@localhost/research",
      AAIS_RESEARCH_DATABASE_INSTANCE_ID: "research-db-test",
      AAIS_RESEARCH_LRS_STORE_ID: "research-lrs-test",
      AAIS_RESEARCH_REHEARSAL_MODE: "true",
      AAIS_RESEARCH_REHEARSAL_APPROVED: "true",
      AAIS_RESEARCH_PARTICIPANT_ACTOR_IDS: "student-1,student-2,student-3",
      AAIS_RESEARCH_IDENTITY_ENCRYPTION_KEY: encryptionKey.toString("base64"),
      AAIS_RESEARCH_IDENTITY_FINGERPRINT_KEY: Buffer.alloc(32, 8).toString("base64"),
    });

    expect(config).toMatchObject({
      projectId: "aais",
      studyId: "ca-pilot-2026",
      environment: "research",
      lrsNamespace: "https://www.aais.site/xapi/studies/ca-pilot-2026/research/v1",
      conditions: ["control", "treatment"],
      identityRetentionDays: 90,
      rawTextRetentionDays: 180,
      factRetentionDays: 1825,
      backupRetentionDays: 35,
    });
    expect(() => getAaisResearchConfiguration({
      AAIS_RESEARCH_MODE: "true",
      AAIS_RESEARCH_PROJECT_ID: "mais",
      AAIS_RESEARCH_STUDY_ID: "ca-pilot-2026",
      AAIS_RESEARCH_ENVIRONMENT: "research",
      AAIS_APP_VERSION: "0.1.0",
      AAIS_COMMIT_SHA: "local",
      AAIS_DATABASE_URL: "postgres://test:test@localhost/old-mixed-pool",
      AAIS_RESEARCH_DATABASE_INSTANCE_ID: "research-db-test",
      AAIS_RESEARCH_LRS_STORE_ID: "research-lrs-test",
      AAIS_RESEARCH_REHEARSAL_MODE: "true",
      AAIS_RESEARCH_REHEARSAL_APPROVED: "true",
      AAIS_RESEARCH_PARTICIPANT_ACTOR_IDS: "student-1,student-2,student-3",
      AAIS_RESEARCH_IDENTITY_ENCRYPTION_KEY: encryptionKey.toString("base64"),
      AAIS_RESEARCH_IDENTITY_FINGERPRINT_KEY: Buffer.alloc(32, 8).toString("base64"),
    })).toThrow(AaisResearchConfigurationError);
  });

  it("enforces all four retention ceilings instead of accepting no-op settings", () => {
    const baseEnv = createResearchEnvironment();
    const shortened = getAaisResearchConfiguration({
      ...baseEnv,
      AAIS_RESEARCH_IDENTITY_RETENTION_DAYS: "30",
      AAIS_RESEARCH_RAW_TEXT_RETENTION_DAYS: "60",
      AAIS_RESEARCH_EVENT_RETENTION_DAYS: "365",
      AAIS_RESEARCH_BACKUP_RETENTION_DAYS: "14",
    });
    expect(shortened).toMatchObject({
      identityRetentionDays: 30,
      rawTextRetentionDays: 60,
      factRetentionDays: 365,
      backupRetentionDays: 14,
    });
    expect(() => getAaisResearchConfiguration({
      ...baseEnv,
      AAIS_RESEARCH_RAW_TEXT_RETENTION_DAYS: "181",
    })).toThrow(AaisResearchConfigurationError);
    expect(() => getAaisResearchConfiguration({
      ...baseEnv,
      AAIS_RESEARCH_BACKUP_RETENTION_DAYS: "36",
    })).toThrow(AaisResearchConfigurationError);
    expect(() => getAaisResearchConfiguration({
      ...baseEnv,
      AAIS_STAGING_DATABASE_INSTANCE_ID: "research-db-test",
    })).toThrow(AaisResearchConfigurationError);
  });

  it("rejects shared identity keys and product databases configured through raw PG variables", () => {
    const baseEnv = createResearchEnvironment();
    expect(() => getAaisResearchConfiguration({
      ...baseEnv,
      AAIS_RESEARCH_IDENTITY_FINGERPRINT_KEY:
        baseEnv.AAIS_RESEARCH_IDENTITY_ENCRYPTION_KEY,
    })).toThrow(AaisResearchConfigurationError);
    expect(() => getAaisResearchConfiguration({
      ...baseEnv,
      PGHOST: "localhost",
      PGDATABASE: "research",
      PGPORT: "5432",
    })).toThrow(AaisResearchConfigurationError);
    expect(() => getAaisResearchConfiguration({
      ...baseEnv,
      POSTGRES_HOST: "localhost",
      POSTGRES_DATABASE: "research",
      POSTGRES_PORT: "5432",
    })).toThrow(AaisResearchConfigurationError);
  });

  it("encrypts the identity map with authenticated AES-256-GCM and detects tampering", () => {
    const encrypted = encryptAaisResearchIdentity({
      actor: { id: "student-1", displayName: "Participant One" },
      configuration,
      randomBytesImpl: () => Buffer.alloc(12, 5),
    });

    expect(encrypted.ciphertext.toString("utf8")).not.toContain("student-1");
    expect(encrypted.ciphertext.toString("utf8")).not.toContain("Participant One");
    expect(encrypted.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(decryptAaisResearchIdentity({ ...encrypted, configuration })).toEqual({
      actorId: "student-1",
      displayName: "Participant One",
    });

    const tampered = Buffer.from(encrypted.ciphertext);
    tampered[0] ^= 1;
    expect(() => decryptAaisResearchIdentity({
      ...encrypted,
      ciphertext: tampered,
      configuration,
    })).toThrow();
  });

  it("accepts only declared UI facts and derives retry/disconnect counters server-side", () => {
    const retry = parseAaisResearchEventInput({
      clientEventId: randomUUID(),
      clientTime: "2026-07-30T10:00:00.000Z",
      expectedVisitId: randomUUID(),
      eventName: "ai_guide_submit",
      outcome: "retry",
      aiLatencyMs: 432,
      detail: {
        operation_id: "ai-guide-10000000-0000-4000-8000-000000000010",
        attempt_number: 3,
        prompt_length: 42,
        delta_characters: -8,
        delta_px: -12,
      },
    });
    const disconnected = parseAaisResearchEventInput({
      clientEventId: randomUUID(),
      clientTime: "2026-07-30T10:00:01.000Z",
      expectedVisitId: randomUUID(),
      eventName: "client_connectivity",
      outcome: "disconnected",
      detail: { trigger: "browser_offline" },
    });
    const retryAfterDisconnect = parseAaisResearchEventInput({
      clientEventId: randomUUID(),
      clientTime: "2026-07-30T10:00:02.000Z",
      expectedVisitId: randomUUID(),
      eventName: "ai_guide_submit",
      outcome: "retry",
      detail: { attempt_number: 2, error_kind: "stream_disconnected" },
    });

    expect(retry).toMatchObject({ retryCount: 2, disconnectCount: 0 });
    expect(disconnected).toMatchObject({ retryCount: 0, disconnectCount: 1 });
    expect(retryAfterDisconnect).toMatchObject({ retryCount: 1, disconnectCount: 1 });
    expect(() => parseAaisResearchEventInput({
      clientTime: "2026-07-30T10:00:00.000Z",
      eventName: "ai_guide_submit",
      outcome: "success",
      retryCount: 99,
      detail: {},
    })).toThrow(AaisResearchValidationError);
    expect(() => parseAaisResearchEventInput({
      clientTime: "2026-07-30T10:00:00.000Z",
      eventName: "ai_guide_submit",
      outcome: "success",
      detail: { prompt: "raw learner text" },
    })).toThrow(AaisResearchValidationError);
    expect(() => parseAaisResearchEventInput({
      clientTime: "2026-07-30T10:00:00.000Z",
      eventName: "ai_guide_submit",
      outcome: "success",
      detail: { source: "raw learner text" },
    })).toThrow(AaisResearchValidationError);
    expect(() => parseAaisResearchEventInput({
      clientTime: "2026-07-30T10:00:00.000Z",
      eventName: "unknown_action",
      outcome: "success",
      detail: {},
    })).toThrow(AaisResearchValidationError);
    expect(() => parseAaisResearchEventInput({
      clientTime: "2026-07-30T10:00:00.000Z",
      eventName: "content_tab_selected",
      outcome: "success",
      aiLatencyMs: 50,
      detail: {},
    })).toThrow(AaisResearchValidationError);
  });

  it("accepts only the fixed controlled vocabulary and identifier patterns", () => {
    const detail = {
      operation_id: "ai-guide-10000000-0000-4000-8000-000000000010",
      task_id: "training_task_1",
      trigger: "page_mount",
      tab_id: "editor",
      content_id: "theory",
      document_id: "training_task_1-1722333600000",
      format_id: "heading",
      value_id: "h1",
      quick_start_id: "clarify_goal",
      input_mode: "typed",
      mime_type: "text/plain",
      error_kind: "request_failed",
      retry_reason: "stream_protocol_fallback",
      source: "ai_response",
      input_method: "pointer",
      download_method: "browser_download",
      link_protocol: "https:",
      link_host: "external",
    };

    expect(parseAaisResearchEventInput({
      clientEventId: randomUUID(),
      clientTime: "2026-07-30T10:00:00.000Z",
      expectedVisitId: randomUUID(),
      eventName: "ai_guide_submit",
      outcome: "success",
      detail,
    }).detail).toEqual(detail);
  });

  it.each([
    "operation_id",
    "task_id",
    "trigger",
    "tab_id",
    "content_id",
    "document_id",
    "format_id",
    "value_id",
    "quick_start_id",
    "input_mode",
    "mime_type",
    "error_kind",
    "retry_reason",
    "source",
    "input_method",
    "download_method",
    "link_protocol",
    "link_host",
  ] as const)("rejects a PII-shaped token disguised as %s", (key) => {
    expect(() => parseAaisResearchEventInput({
      clientEventId: randomUUID(),
      clientTime: "2026-07-30T10:00:00.000Z",
      expectedVisitId: randomUUID(),
      eventName: "ai_guide_submit",
      outcome: "success",
      detail: { [key]: "MySSN123-45-6789" },
    })).toThrow(AaisResearchValidationError);
  });

  it("builds an isolated research statement whose id is exactly the event id", () => {
    const payload = createOutboxPayload();
    const statement = buildAaisResearchXapiStatement(payload);

    expect(statement.id).toBe(payload.eventId);
    expect(statement.object.id).toContain(configuration.lrsNamespace);
    expect(statement.context.extensions).toMatchObject({
      [`${configuration.lrsNamespace}/extensions/project-id`]: "aais",
      [`${configuration.lrsNamespace}/extensions/study-id`]: "ca-pilot-2026",
      [`${configuration.lrsNamespace}/extensions/environment`]: "research",
      [`${configuration.lrsNamespace}/extensions/event-sequence`]: 1,
    });
  });

  it("never treats generic LRS credentials as research credentials", () => {
    expect(getAaisResearchLrsConfigurationStatus(createFormalLaunchEnvironment()))
      .toMatchObject({
        configured: true,
        isolatedFromGenericLrs: true,
        receiptVerificationConfigured: true,
        receiptVerifyingKeyIdConfigured: true,
      });
    expect(getAaisResearchLrsConfigurationStatus({
      ...createFormalLaunchEnvironment(),
      AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_SPKI:
        Buffer.from("not-an-spki", "utf8").toString("base64"),
    })).toMatchObject({
      configured: false,
      receiptVerificationConfigured: false,
      receiptVerifyingKeyIdConfigured: false,
    });
    expect(getAaisResearchLrsConfigurationStatus({
      AAIS_RESEARCH_REHEARSAL_MODE: "true",
      AAIS_RESEARCH_LRS_ENDPOINT: "https://provider.example/xapi/statements",
      AAIS_RESEARCH_LRS_USERNAME: "synthetic-writer",
      AAIS_RESEARCH_LRS_PASSWORD: "synthetic-password",
      AAIS_RESEARCH_LRS_STORE_ID: "synthetic-store",
    })).toMatchObject({
      configured: true,
      receiptVerificationConfigured: false,
      receiptVerifyingKeyIdConfigured: false,
    });
    expect(getAaisResearchLrsConfigurationStatus({
      LRS_ENDPOINT: "https://old.example.test/xapi",
      LRS_USERNAME: "old",
      LRS_PASSWORD: "old",
    })).toMatchObject({ configured: false, isolatedFromGenericLrs: true });
    expect(getAaisResearchLrsConfigurationStatus({
      AAIS_RESEARCH_LRS_ENDPOINT: "https://provider.example/xapi/statements",
      AAIS_RESEARCH_LRS_USERNAME: "research-writer",
      AAIS_RESEARCH_LRS_PASSWORD: "research-password",
      AAIS_RESEARCH_LRS_STORE_ID: "shared-store",
      AAIS_STAGING_LRS_ENDPOINT: "https://provider.example/xapi/statements",
      AAIS_STAGING_LRS_USERNAME: "staging-writer",
      AAIS_STAGING_LRS_STORE_ID: "shared-store",
    })).toMatchObject({ configured: false, isolatedFromGenericLrs: true });
    expect(getAaisResearchLrsConfigurationStatus({
      AAIS_RESEARCH_LRS_ENDPOINT: "https://provider.example/xapi/statements",
      AAIS_RESEARCH_LRS_USERNAME: "research-writer",
      AAIS_RESEARCH_LRS_PASSWORD: "reused-secret",
      AAIS_RESEARCH_LRS_STORE_ID: "aais-research-store",
      MAIS_LRS_ENDPOINT: "https://other-provider.example/xapi/statements",
      MAIS_LRS_USERNAME: "mais-writer",
      MAIS_LRS_PASSWORD: "reused-secret",
      MAIS_LRS_STORE_ID: "mais-store",
    })).toMatchObject({ configured: false, isolatedFromGenericLrs: true });
    expect(getAaisResearchLrsConfigurationStatus({
      AAIS_RESEARCH_LRS_ENDPOINT: "https://embedded:secret@provider.example/xapi/statements",
      AAIS_RESEARCH_LRS_USERNAME: "research-writer",
      AAIS_RESEARCH_LRS_PASSWORD: "research-password",
      AAIS_RESEARCH_LRS_STORE_ID: "aais-research-store",
    })).toMatchObject({ configured: false, isolatedFromGenericLrs: true });
    expect(getAaisResearchLrsConfigurationStatus({
      NODE_ENV: "production",
      AAIS_RESEARCH_REHEARSAL_MODE: "true",
      AAIS_RESEARCH_LRS_ENDPOINT: "http://localhost:43239/xapi/statements",
      AAIS_RESEARCH_LRS_USERNAME: "research-writer",
      AAIS_RESEARCH_LRS_PASSWORD: "research-password",
      AAIS_RESEARCH_LRS_STORE_ID: "aais-research-store",
    })).toMatchObject({ configured: false, isolatedFromGenericLrs: true });
  });

  it("bounds and cancels an oversized provider deletion receipt", async () => {
    let cancelled = false;
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(deleteAaisResearchStatement({
      statementId: createOutboxPayload().eventId,
      expectedStoreId: configuration.lrsStoreId,
      configuration: {
        endpoint: "https://aais-research-lrs.example/xapi/statements",
        username: "least-privilege-writer",
        password: "test-only",
        storeId: configuration.lrsStoreId,
      },
      fetchImpl: async () => new Response(responseBody),
    })).rejects.toThrow(/too large/i);

    expect(cancelled).toBe(true);
  });

  it("does not send Basic credentials through an unsafe injected LRS endpoint", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return new Response("", { status: 200 });
    };

    await expect(sendAaisResearchStatement({
      payload: createOutboxPayload(),
      configuration: {
        endpoint: "http://provider.example.test/xapi/statements",
        username: "least-privilege-writer",
        password: "test-only",
        storeId: configuration.lrsStoreId,
      },
      fetchImpl,
    })).rejects.toThrow(/HTTPS/i);

    expect(called).toBe(false);
  });

  it("keeps the LRS timeout active while streaming a deletion receipt", async () => {
    let aborted = false;
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const timer = setTimeout(() => {
            controller.enqueue(new TextEncoder().encode("late receipt"));
            controller.close();
          }, 40);
          signal?.addEventListener("abort", () => {
            aborted = true;
            clearTimeout(timer);
            controller.error(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        },
      }));
    };

    await expect(deleteAaisResearchStatement({
      statementId: createOutboxPayload().eventId,
      expectedStoreId: configuration.lrsStoreId,
      configuration: {
        endpoint: "https://aais-research-lrs.example/xapi/statements",
        username: "least-privilege-writer",
        password: "test-only",
        storeId: configuration.lrsStoreId,
      },
      fetchImpl,
      timeoutMs: 5,
    })).rejects.toThrow();

    expect(aborted).toBe(true);
  });

  it("consumes a bounded LRS PUT response body before returning its HTTP status", async () => {
    const providerResponse = new Response("provider acknowledgement", { status: 201 });

    const delivery = await sendAaisResearchStatement({
      payload: createOutboxPayload(),
      configuration: {
        endpoint: "https://aais-research-lrs.example/xapi/statements",
        username: "least-privilege-writer",
        password: "test-only",
        storeId: configuration.lrsStoreId,
      },
      fetchImpl: async () => providerResponse,
    });

    expect(delivery).toEqual({ ok: true, httpStatus: 201 });
    expect(providerResponse.bodyUsed).toBe(true);
  });

  it("cancels an oversized LRS PUT response body while preserving its HTTP status", async () => {
    let cancelled = false;
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });

    const delivery = await sendAaisResearchStatement({
      payload: createOutboxPayload(),
      configuration: {
        endpoint: "https://aais-research-lrs.example/xapi/statements",
        username: "least-privilege-writer",
        password: "test-only",
        storeId: configuration.lrsStoreId,
      },
      fetchImpl: async () => new Response(responseBody, { status: 413 }),
    });

    expect(delivery).toEqual({ ok: false, httpStatus: 413 });
    expect(cancelled).toBe(true);
  });

  it("keeps the LRS timeout active while discarding a slow PUT response body", async () => {
    let aborted = false;
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const timer = setTimeout(() => {
            controller.enqueue(new TextEncoder().encode("late acknowledgement"));
            controller.close();
          }, 40);
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            clearTimeout(timer);
            controller.error(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        },
      }), { status: 503 });

    const delivery = await sendAaisResearchStatement({
      payload: createOutboxPayload(),
      configuration: {
        endpoint: "https://aais-research-lrs.example/xapi/statements",
        username: "least-privilege-writer",
        password: "test-only",
        storeId: configuration.lrsStoreId,
      },
      fetchImpl,
      timeoutMs: 5,
    });

    expect(delivery).toEqual({ ok: false, httpStatus: 503 });
    expect(aborted).toBe(true);
  });

  it("bounds a never-closing PUT body even when stream cancellation rejects", async () => {
    let cancelAttempts = 0;
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial acknowledgement"));
      },
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelAttempts += 1;
        return Promise.reject(new Error("provider cancellation failed"));
      },
    });

    const delivery = await sendAaisResearchStatement({
      payload: createOutboxPayload(),
      configuration: {
        endpoint: "https://aais-research-lrs.example/xapi/statements",
        username: "least-privilege-writer",
        password: "test-only",
        storeId: configuration.lrsStoreId,
      },
      fetchImpl: async () => new Response(responseBody, { status: 429 }),
      timeoutMs: 5,
    });

    expect(delivery).toEqual({ ok: false, httpStatus: 429 });
    expect(cancelAttempts).toBe(1);
  });

  it("accepts an empty 204 LRS PUT response without manufacturing a body failure", async () => {
    const delivery = await sendAaisResearchStatement({
      payload: createOutboxPayload(),
      configuration: {
        endpoint: "https://aais-research-lrs.example/xapi/statements",
        username: "least-privilege-writer",
        password: "test-only",
        storeId: configuration.lrsStoreId,
      },
      fetchImpl: async () => new Response(null, { status: 204 }),
    });

    expect(delivery).toEqual({ ok: true, httpStatus: 204 });
  });

  it("uses deterministic PUT delivery and requires provider absence evidence after DELETE", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const payload = createOutboxPayload();
    const lrsConfiguration = {
      endpoint: "https://aais-research-lrs.example/xapi/statements",
      username: "least-privilege-writer",
      password: "test-only",
      storeId: "aais-research-test-store",
      receiptVerification: {
        keyId: receiptKeyId,
        publicKey: receiptKeyPair.publicKey,
      },
    };
    const receipt = "provider-signed-final-absence-receipt";
    const confirmedAt = "2026-07-30T10:30:00.000Z";
    const receiptSha256 = createHash("sha256").update(receipt).digest("hex");
    const receiptSignature = sign(
      null,
      createAaisResearchLrsAbsenceReceiptEnvelope({
        storeId: lrsConfiguration.storeId,
        statementId: payload.eventId,
        confirmedAt,
        receiptSha256,
        keyId: receiptKeyId,
      }),
      receiptKeyPair.privateKey,
    ).toString("base64url");
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (init?.method !== "DELETE") {
        return new Response("", { status: 200 });
      }
      return new Response(receipt, {
        status: 200,
        headers: {
          "x-aais-lrs-absence-confirmed-at": confirmedAt,
          "x-aais-lrs-absence-receipt-sha256": receiptSha256,
          "x-aais-lrs-absence-receipt-key-id": receiptKeyId,
          "x-aais-lrs-absence-receipt-signature": receiptSignature,
        },
      });
    };

    await sendAaisResearchStatement({ payload, configuration: lrsConfiguration, fetchImpl });
    const deletion = await deleteAaisResearchStatement({
      statementId: payload.eventId,
      expectedStoreId: payload.lrsStoreId,
      configuration: lrsConfiguration,
      fetchImpl,
    });

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.init?.method)).toEqual(["PUT", "DELETE"]);
    expect(requests.every((request) =>
      new URL(request.url).searchParams.get("statementId") === payload.eventId
    )).toBe(true);
    expect(requests[0]?.init?.headers).toMatchObject({
      "x-experience-api-version": "1.0.3",
    });
    expect(deletion).toMatchObject({
      ok: true,
      httpStatus: 200,
      receiptSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      absenceConfirmation: {
        confirmedAt,
        receiptKeyId,
        receiptSignature,
      },
    });
  });

  it("rejects unconfigured, invalid, or scope-mismatched absence signatures", async () => {
    const statementId = randomUUID();
    const storeId = configuration.lrsStoreId;
    const confirmedAt = "2026-07-30T10:30:00.000Z";
    const receipt = "provider-signed-final-absence-receipt";
    const receiptSha256 = createHash("sha256").update(receipt).digest("hex");
    const createSignature = (overrides: Partial<{
      storeId: string;
      statementId: string;
      confirmedAt: string;
      receiptSha256: string;
    }> = {}) => sign(
      null,
      createAaisResearchLrsAbsenceReceiptEnvelope({
        storeId: overrides.storeId ?? storeId,
        statementId: overrides.statementId ?? statementId,
        confirmedAt: overrides.confirmedAt ?? confirmedAt,
        receiptSha256: overrides.receiptSha256 ?? receiptSha256,
        keyId: receiptKeyId,
      }),
      receiptKeyPair.privateKey,
    ).toString("base64url");
    const createFetch = (
      receiptSignature: string,
      responseKeyId = receiptKeyId,
    ) => async () => new Response(receipt, {
      status: 200,
      headers: {
        "x-aais-lrs-absence-confirmed-at": confirmedAt,
        "x-aais-lrs-absence-receipt-sha256": receiptSha256,
        "x-aais-lrs-absence-receipt-key-id": responseKeyId,
        "x-aais-lrs-absence-receipt-signature": receiptSignature,
      },
    });
    const verifiedConfiguration = {
      endpoint: "https://aais-research-lrs.example/xapi/statements",
      username: "least-privilege-writer",
      password: "test-only",
      storeId,
      receiptVerification: {
        keyId: receiptKeyId,
        publicKey: receiptKeyPair.publicKey,
      },
    };
    const validSignature = createSignature();
    const tamperedSignature =
      `${validSignature.startsWith("A") ? "B" : "A"}${validSignature.slice(1)}`;

    for (const signature of [
      createSignature({ storeId: "other-store" }),
      createSignature({ statementId: randomUUID() }),
      createSignature({ confirmedAt: "2026-07-30T10:31:00.000Z" }),
      createSignature({ receiptSha256: "f".repeat(64) }),
      tamperedSignature,
    ]) {
      const deletion = await deleteAaisResearchStatement({
        statementId,
        expectedStoreId: storeId,
        configuration: verifiedConfiguration,
        fetchImpl: createFetch(signature),
      });
      expect(deletion.absenceConfirmation).toBeNull();
    }

    const wrongKeyId = await deleteAaisResearchStatement({
      statementId,
      expectedStoreId: storeId,
      configuration: verifiedConfiguration,
      fetchImpl: createFetch(validSignature, "other-provider-key"),
    });
    expect(wrongKeyId.absenceConfirmation).toBeNull();

    const unconfigured = await deleteAaisResearchStatement({
      statementId,
      expectedStoreId: storeId,
      configuration: {
        endpoint: verifiedConfiguration.endpoint,
        username: verifiedConfiguration.username,
        password: verifiedConfiguration.password,
        storeId,
      },
      fetchImpl: createFetch(validSignature),
    });
    expect(unconfigured.absenceConfirmation).toBeNull();
  });

  it.each([200, 204, 404])(
    "does not treat an ordinary DELETE response with status %s as final absence evidence",
    async (status) => {
      const deletion = await deleteAaisResearchStatement({
        statementId: createOutboxPayload().eventId,
        expectedStoreId: configuration.lrsStoreId,
        configuration: {
          endpoint: "https://aais-research-lrs.example/xapi/statements",
          username: "least-privilege-writer",
          password: "test-only",
          storeId: configuration.lrsStoreId,
        },
        fetchImpl: async () => new Response(status === 204 ? null : "ordinary-delete-response", {
          status,
        }),
      });

      expect(deletion).toMatchObject({
        httpStatus: status,
        absenceConfirmation: null,
      });
    },
  );
});

function createOutboxPayload() {
  return {
    eventId: randomUUID(),
    participantId: randomUUID(),
    studyRunId: randomUUID(),
    visitId: randomUUID(),
    projectId: "aais" as const,
    studyId: "ca-pilot-2026",
    environment: "research" as const,
    lrsNamespace: configuration.lrsNamespace,
    lrsStoreId: configuration.lrsStoreId,
    condition: "control",
    schemaVersion: 1 as const,
    appVersion: "0.1.0",
    commitSha: "0123456789abcdef",
    eventSequence: 1,
    clientTime: "2026-07-30T10:00:00.000Z",
    serverReceivedAt: "2026-07-30T10:00:00.100Z",
    eventName: "document_artifact_save",
    outcome: "success" as const,
    retryCount: 0,
    disconnectCount: 0,
    aiLatencyMs: null,
    detail: { artifact_length: 120 },
    lrsEligible: true as const,
  };
}

function createResearchEnvironment() {
  return {
    AAIS_RESEARCH_MODE: "true",
    AAIS_RESEARCH_PROJECT_ID: "aais",
    AAIS_RESEARCH_STUDY_ID: "ca-pilot-2026",
    AAIS_RESEARCH_ENVIRONMENT: "research",
    AAIS_APP_VERSION: "0.1.0",
    AAIS_COMMIT_SHA: "0123456789abcdef",
    AAIS_RESEARCH_DATABASE_URL: "postgres://test:test@localhost/research",
    AAIS_RESEARCH_DATABASE_INSTANCE_ID: "research-db-test",
    AAIS_RESEARCH_LRS_STORE_ID: "research-lrs-test",
    AAIS_RESEARCH_REHEARSAL_MODE: "true",
    AAIS_RESEARCH_REHEARSAL_APPROVED: "true",
    AAIS_RESEARCH_PARTICIPANT_ACTOR_IDS: "student-1,student-2,student-3",
    AAIS_RESEARCH_IDENTITY_ENCRYPTION_KEY: encryptionKey.toString("base64"),
    AAIS_RESEARCH_IDENTITY_FINGERPRINT_KEY: Buffer.alloc(32, 8).toString("base64"),
  };
}

function createFormalLaunchEnvironment() {
  const now = Date.now();
  return {
    AAIS_RESEARCH_MODE: "true",
    AAIS_RESEARCH_REHEARSAL_MODE: "false",
    AAIS_RESEARCH_PI_ACTOR_IDS: "pi-1",
    AAIS_RESEARCH_DATA_CUSTODIAN_ACTOR_IDS: "custodian-1",
    AAIS_RESEARCH_EXPORT_ACTOR_IDS: "researcher-1",
    AAIS_RESEARCH_EXPORT_ENABLED: "true",
    AAIS_RESEARCH_LRS_ENDPOINT: "https://provider.example/xapi/statements",
    AAIS_RESEARCH_LRS_USERNAME: "research-writer",
    AAIS_RESEARCH_LRS_PASSWORD: "research-lrs-secret",
    AAIS_RESEARCH_LRS_STORE_ID: "aais-research-store",
    AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_ID: receiptKeyId,
    AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_SPKI: receiptVerifyingSpki,
    AAIS_RESEARCH_LRS_OUTBOX_FLUSH_TOKEN:
      "research-flush-token-with-at-least-32-characters",
    AAIS_RESEARCH_RETENTION_TOKEN:
      "research-retention-token-with-at-least-32-characters",
    AAIS_RESEARCH_LRS_EVENT_FLUSH_SCHEDULE_ID: "event-flush-v1",
    AAIS_RESEARCH_LRS_DELETION_SCHEDULE_ID: "deletion-flush-v1",
    AAIS_RESEARCH_RETENTION_SCHEDULE_ID: "retention-v1",
    AAIS_RESEARCH_DATABASE_ISOLATION_RECEIPT_SHA256: "1".repeat(64),
    AAIS_RESEARCH_LRS_ISOLATION_RECEIPT_SHA256: "2".repeat(64),
    AAIS_RESEARCH_LRS_ZERO_BASELINE_RECEIPT_SHA256: "3".repeat(64),
    AAIS_RESEARCH_LRS_PUT_DELETE_RECEIPT_SHA256: "4".repeat(64),
    AAIS_RESEARCH_BACKUP_POLICY_RECEIPT_SHA256: "5".repeat(64),
    AAIS_RESEARCH_RESTORE_RECEIPT_SHA256: "6".repeat(64),
    AAIS_RESEARCH_LEGACY_ARCHIVE_RECEIPT_SHA256: "7".repeat(64),
    AAIS_RESEARCH_ACCESS_REGISTER_RECEIPT_SHA256: "8".repeat(64),
    AAIS_RESEARCH_CONSENT_LEGAL_BASIS_RECEIPT_SHA256: "9".repeat(64),
    AAIS_RESEARCH_DPA_RECEIPT_SHA256: "a".repeat(64),
    AAIS_RESEARCH_DATA_REGION_RECEIPT_SHA256: "b".repeat(64),
    AAIS_RESEARCH_DAILY_BACKUP_RECEIPT_SHA256: "c".repeat(64),
    AAIS_RESEARCH_BACKUP_DESTRUCTION_RECEIPT_SHA256: "d".repeat(64),
    AAIS_RESEARCH_GOVERNANCE_MANIFEST_RECEIPT_SHA256: "e".repeat(64),
    AAIS_RESEARCH_GOVERNANCE_MANIFEST_VERIFIED_AT:
      new Date(now - 60 * 60 * 1_000).toISOString(),
    AAIS_RESEARCH_GOVERNANCE_MANIFEST_VALID_UNTIL:
      new Date(now + 30 * 24 * 60 * 60 * 1_000).toISOString(),
    AAIS_RESEARCH_DAILY_BACKUP_COMPLETED_AT:
      new Date(now - 12 * 60 * 60 * 1_000).toISOString(),
    AAIS_RESEARCH_BACKUP_DESTRUCTION_OBSERVED_AT:
      new Date(now - 7 * 24 * 60 * 60 * 1_000).toISOString(),
  };
}
