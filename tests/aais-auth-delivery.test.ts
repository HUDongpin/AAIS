import { describe, expect, it, vi } from "vitest";
import {
  AaisAuthDeliveryConfigurationError,
  AaisAuthEmailReconciliationConflictError,
  createAaisAuthEmailOutboxMessage,
  flushAaisAuthEmailOutbox,
  inspectAaisAuthDeliveryConfiguration,
  reconcileAaisAuthEmailOutbox,
  requireAaisAuthDeliveryConfiguration,
} from "@/lib/server/aais-auth-delivery";
import type { AaisDatabaseClient } from "@/lib/server/aais-learning-store";

const strongResendKey = "re_1234567890abcdefghijklmnopqrstuvwxyzABCD";
const strongSessionSecret = "auth-delivery-session-secret-0123456789-ABCDEFG";
const strongWorkerToken = "auth-delivery-worker-token-0123456789-ABCDEFG";
const inviteTokenId = "auth-invite-aaaaaaaaaaaaaaaaaaaaaaaa";
const resetTokenId = "auth-reset-bbbbbbbbbbbbbbbbbbbbbbbb";
const tokenHash = "c".repeat(64);

const configuredEnv = {
  NODE_ENV: "production",
  AAIS_APP_BASE_URL: "https://aais.example.test",
  AAIS_SESSION_SECRET: strongSessionSecret,
  RESEND_API_KEY: strongResendKey,
  AAIS_AUTH_EMAIL_FROM: "CAAIS <no-reply@example.test>",
  AAIS_AUTH_EMAIL_OUTBOX_FLUSH_TOKEN: strongWorkerToken,
} as const;

describe("AAIS authentication delivery configuration", () => {
  it("requires a canonical HTTPS application origin and a complete provider in production", () => {
    expect(inspectAaisAuthDeliveryConfiguration({ NODE_ENV: "production" }))
      .toMatchObject({
        status: "invalid",
        issues: [
          "AAIS_APP_BASE_URL",
          "AAIS_AUTH_EMAIL_PROVIDER",
          "AAIS_AUTH_EMAIL_ENCRYPTION_SECRET",
        ],
      });

    expect(inspectAaisAuthDeliveryConfiguration({
      ...configuredEnv,
    })).toEqual({
      status: "configured",
      appBaseUrlConfigured: true,
      appBaseUrlValid: true,
      emailProviderConfigured: true,
      emailProviderValid: true,
      encryptionSecretConfigured: true,
      encryptionSecretValid: true,
      issues: [],
    });
  });

  it("rejects plaintext, credential-bearing, path, query and fragment application URLs", () => {
    for (const appBaseUrl of [
      "http://aais.example.test",
      "https://user:secret@aais.example.test",
      "https://aais.example.test/login",
      "https://aais.example.test?redirect=evil",
      "https://aais.example.test#token",
    ]) {
      expect(inspectAaisAuthDeliveryConfiguration({
        NODE_ENV: "production",
        AAIS_APP_BASE_URL: appBaseUrl,
        AAIS_SESSION_SECRET: strongSessionSecret,
        RESEND_API_KEY: strongResendKey,
        AAIS_AUTH_EMAIL_FROM: "no-reply@example.test",
      })).toMatchObject({
        status: "invalid",
        appBaseUrlValid: false,
        issues: ["AAIS_APP_BASE_URL_INVALID"],
      });
    }
  });

  it("rejects partial, weak and header-injecting email provider configuration", () => {
    expect(inspectAaisAuthDeliveryConfiguration({
      NODE_ENV: "production",
      AAIS_APP_BASE_URL: "https://aais.example.test",
      AAIS_SESSION_SECRET: strongSessionSecret,
      RESEND_API_KEY: "short",
      AAIS_AUTH_EMAIL_FROM: "no-reply@example.test",
    })).toMatchObject({
      status: "invalid",
      issues: ["AAIS_AUTH_EMAIL_PROVIDER_INVALID"],
    });
    expect(inspectAaisAuthDeliveryConfiguration({
      NODE_ENV: "production",
      AAIS_APP_BASE_URL: "https://aais.example.test",
      AAIS_SESSION_SECRET: strongSessionSecret,
      RESEND_API_KEY: strongResendKey,
      AAIS_AUTH_EMAIL_FROM: "no-reply@example.test\r\nBcc: attacker@example.test",
    })).toMatchObject({
      status: "invalid",
      issues: ["AAIS_AUTH_EMAIL_PROVIDER_INVALID"],
    });
  });

  it("allows the local origin only outside production but still refuses delivery without a provider", () => {
    expect(inspectAaisAuthDeliveryConfiguration({ NODE_ENV: "test" })).toEqual({
      status: "not_configured",
      appBaseUrlConfigured: false,
      appBaseUrlValid: true,
      emailProviderConfigured: false,
      emailProviderValid: false,
      encryptionSecretConfigured: false,
      encryptionSecretValid: false,
      issues: [],
    });
    expect(() => requireAaisAuthDeliveryConfiguration({ NODE_ENV: "test" }))
      .toThrow(AaisAuthDeliveryConfigurationError);
  });

  it("returns normalized non-secret delivery values for configured callers", () => {
    expect(requireAaisAuthDeliveryConfiguration({
      ...configuredEnv,
      AAIS_APP_BASE_URL: "https://aais.example.test/",
    })).toEqual({
      appBaseUrl: "https://aais.example.test",
      apiKey: strongResendKey,
      from: "CAAIS <no-reply@example.test>",
      encryptionSecret: strongSessionSecret,
    });
  });

  it("rejects production localhost origins and missing payload-encryption material", () => {
    expect(inspectAaisAuthDeliveryConfiguration({
      ...configuredEnv,
      AAIS_APP_BASE_URL: "https://localhost:3000",
    })).toMatchObject({
      status: "invalid",
      appBaseUrlValid: false,
      issues: ["AAIS_APP_BASE_URL_INVALID"],
    });
    expect(inspectAaisAuthDeliveryConfiguration({
      ...configuredEnv,
      AAIS_SESSION_SECRET: "",
    })).toMatchObject({
      status: "invalid",
      encryptionSecretConfigured: false,
      encryptionSecretValid: false,
      issues: ["AAIS_AUTH_EMAIL_ENCRYPTION_SECRET"],
    });
  });
});

describe("AAIS authentication email outbox", () => {
  it("claims a row once across concurrent workers and sends with a stable idempotency key", async () => {
    const database = new FakeAuthEmailOutboxDatabase();
    const message = createAaisAuthEmailOutboxMessage({
      configuration: requireAaisAuthDeliveryConfiguration(configuredEnv),
      id: "10000000-0000-4000-8000-000000000001",
      purpose: "password_reset",
      authTokenId: resetTokenId,
      authTokenHash: tokenHash,
      recipient: "learner@example.test",
      subject: "AAIS password reset",
      text: "secret-reset-body-aais_reset_DO_NOT_STORE_IN_PLAINTEXT",
    });
    database.seed(message);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Response(null, { status: 202 });
    });

    const reports = await Promise.all([
      flushAaisAuthEmailOutbox({
        database,
        env: configuredEnv,
        fetchImpl: fetchMock as typeof fetch,
        now: () => new Date("2026-08-20T00:00:00.000Z"),
      }),
      flushAaisAuthEmailOutbox({
        database,
        env: configuredEnv,
        fetchImpl: fetchMock as typeof fetch,
        now: () => new Date("2026-08-20T00:00:00.000Z"),
      }),
    ]);

    expect(reports.map((report) => report.claimed).sort()).toEqual([0, 1]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "idempotency-key": message.idempotencyKey,
    });
    expect(database.rows.get(message.id)?.status).toBe("sent");
    expect(database.claimSql).toContain("for update of email skip locked");
  });

  it("retries uncertain transport failures with the same payload and idempotency key", async () => {
    const database = new FakeAuthEmailOutboxDatabase();
    const message = createAaisAuthEmailOutboxMessage({
      configuration: requireAaisAuthDeliveryConfiguration(configuredEnv),
      id: "10000000-0000-4000-8000-000000000002",
      purpose: "invite",
      authTokenId: inviteTokenId,
      authTokenHash: tokenHash,
      recipient: "teacher@example.test",
      subject: "AAIS account invitation",
      text: "secret-invite-body-aais_invite_DO_NOT_STORE_IN_PLAINTEXT",
    });
    database.seed(message);
    const idempotencyKeys: string[] = [];
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      idempotencyKeys.push(String((init?.headers as Record<string, string>)["idempotency-key"]));
      if (idempotencyKeys.length === 1) {
        throw new TypeError("simulated uncertain transport failure");
      }
      return new Response(null, { status: 202 });
    });

    const first = await flushAaisAuthEmailOutbox({
      database,
      env: configuredEnv,
      fetchImpl: fetchMock as typeof fetch,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    const second = await flushAaisAuthEmailOutbox({
      database,
      env: configuredEnv,
      fetchImpl: fetchMock as typeof fetch,
      now: () => new Date("2026-08-20T00:10:00.000Z"),
    });

    expect(first).toMatchObject({ retry: 1, sent: 0 });
    expect(second).toMatchObject({ retry: 0, sent: 1 });
    expect(idempotencyKeys).toEqual([message.idempotencyKey, message.idempotencyKey]);
    expect(database.rows.get(message.id)).toMatchObject({
      status: "sent",
      attempt_count: 2,
    });
  });

  it("dead-letters a conflicting idempotency payload without retrying", async () => {
    const database = new FakeAuthEmailOutboxDatabase();
    const message = createAaisAuthEmailOutboxMessage({
      configuration: requireAaisAuthDeliveryConfiguration(configuredEnv),
      id: "10000000-0000-4000-8000-000000000006",
      purpose: "invite",
      authTokenId: inviteTokenId,
      authTokenHash: tokenHash,
      recipient: "teacher@example.test",
      subject: "AAIS account invitation",
      text: "secret invite body",
    });
    database.seed(message);
    const fetchMock = vi.fn(async () =>
      Response.json(
        { name: "invalid_idempotent_request", message: "must stay private" },
        { status: 409 },
      ));

    const report = await flushAaisAuthEmailOutbox({
      database,
      env: configuredEnv,
      fetchImpl: fetchMock as typeof fetch,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });

    expect(report).toMatchObject({ sent: 0, retry: 0, deadLetter: 1 });
    expect(database.rows.get(message.id)?.status).toBe("dead");
    expect(database.tokens.get(message.authTokenId)?.deliveryState).toBe("idle");
  });

  it("retries concurrent idempotent requests with the same stable key", async () => {
    const database = new FakeAuthEmailOutboxDatabase();
    const message = createAaisAuthEmailOutboxMessage({
      configuration: requireAaisAuthDeliveryConfiguration(configuredEnv),
      id: "10000000-0000-4000-8000-000000000007",
      purpose: "invite",
      authTokenId: inviteTokenId,
      authTokenHash: tokenHash,
      recipient: "teacher@example.test",
      subject: "AAIS account invitation",
      text: "secret invite body",
    });
    database.seed(message);
    const keys: string[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      keys.push(String((init?.headers as Record<string, string>)["idempotency-key"]));
      return keys.length === 1
        ? Response.json({ name: "concurrent_idempotent_requests" }, { status: 409 })
        : new Response(null, { status: 202 });
    });

    const first = await flushAaisAuthEmailOutbox({
      database,
      env: configuredEnv,
      fetchImpl: fetchMock as typeof fetch,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    const second = await flushAaisAuthEmailOutbox({
      database,
      env: configuredEnv,
      fetchImpl: fetchMock as typeof fetch,
      now: () => new Date("2026-08-20T00:10:00.000Z"),
    });

    expect(first).toMatchObject({ retry: 1, sent: 0 });
    expect(second).toMatchObject({ retry: 0, sent: 1 });
    expect(keys).toEqual([message.idempotencyKey, message.idempotencyKey]);
  });

  it("uses the claim id as an ACK fence and leaves a superseded claim untouched", async () => {
    const database = new FakeAuthEmailOutboxDatabase();
    const message = createAaisAuthEmailOutboxMessage({
      configuration: requireAaisAuthDeliveryConfiguration(configuredEnv),
      id: "10000000-0000-4000-8000-000000000003",
      purpose: "invite",
      authTokenId: inviteTokenId,
      authTokenHash: tokenHash,
      recipient: "teacher@example.test",
      subject: "AAIS account invitation",
      text: "secret invite body",
    });
    database.seed(message);
    const fetchMock = vi.fn(async () => {
      const row = database.rows.get(message.id);
      if (row) {
        row.claim_id = "20000000-0000-4000-8000-000000000099";
      }
      return new Response(null, { status: 202 });
    });

    const report = await flushAaisAuthEmailOutbox({
      database,
      env: configuredEnv,
      fetchImpl: fetchMock as typeof fetch,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });

    expect(report).toMatchObject({ sent: 0, stale: 1 });
    expect(database.rows.get(message.id)?.status).toBe("sending");
    expect(database.ackSql).toContain("claim_id = $2::uuid");
  });

  it("dead-letters a poison envelope without stranding the rest of the claimed batch", async () => {
    const database = new FakeAuthEmailOutboxDatabase();
    const configuration = requireAaisAuthDeliveryConfiguration(configuredEnv);
    const poison = createAaisAuthEmailOutboxMessage({
      configuration,
      id: "10000000-0000-4000-8000-000000000008",
      purpose: "invite",
      authTokenId: inviteTokenId,
      authTokenHash: tokenHash,
      recipient: "teacher@example.test",
      subject: "AAIS account invitation",
      text: "secret invite body",
    });
    const valid = createAaisAuthEmailOutboxMessage({
      configuration,
      id: "10000000-0000-4000-8000-000000000009",
      purpose: "password_reset",
      authTokenId: resetTokenId,
      authTokenHash: "f".repeat(64),
      recipient: "learner@example.test",
      subject: "AAIS password reset",
      text: "secret reset body",
    });
    database.seed(poison);
    database.seed(valid);
    database.rows.get(poison.id)!.payload_envelope = {
      ...poison.payloadEnvelope,
      ciphertext: "*not-base64url*",
    };
    const fetchMock = vi.fn(async () =>
      new Response(null, { status: 202 }));

    const report = await flushAaisAuthEmailOutbox({
      database,
      env: configuredEnv,
      fetchImpl: fetchMock as typeof fetch,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });

    expect(report).toMatchObject({ claimed: 2, sent: 1, deadLetter: 1 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(database.rows.get(poison.id)?.status).toBe("dead");
    expect(database.rows.get(valid.id)?.status).toBe("sent");
  });

  it("never retries outside the provider idempotency window after a delayed crash recovery", async () => {
    const database = new FakeAuthEmailOutboxDatabase();
    const message = createAaisAuthEmailOutboxMessage({
      configuration: requireAaisAuthDeliveryConfiguration(configuredEnv),
      id: "10000000-0000-4000-8000-000000000010",
      purpose: "invite",
      authTokenId: inviteTokenId,
      authTokenHash: tokenHash,
      recipient: "teacher@example.test",
      subject: "AAIS account invitation",
      text: "secret invite body",
    });
    database.seed(message);
    const row = database.rows.get(message.id)!;
    row.status = "retry";
    row.first_attempt_at = "2026-08-20T00:00:00.000Z";
    const fetchMock = vi.fn(async () =>
      new Response(null, { status: 202 }));

    const report = await flushAaisAuthEmailOutbox({
      database,
      env: configuredEnv,
      fetchImpl: fetchMock as typeof fetch,
      now: () => new Date("2026-08-20T23:30:00.000Z"),
    });

    expect(report).toMatchObject({ sent: 0, retry: 0, deadLetter: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a lease that cannot cover the configured provider timeout", async () => {
    const database = new FakeAuthEmailOutboxDatabase();

    await expect(flushAaisAuthEmailOutbox({
      database,
      env: configuredEnv,
      leaseMs: 30_000,
      timeoutMs: 30_000,
    })).rejects.toThrow("lease must exceed the provider timeout");
    expect(database.claimSql).toBe("");
  });

  it("dead-letters a superseded token before any provider call", async () => {
    const database = new FakeAuthEmailOutboxDatabase();
    const message = createAaisAuthEmailOutboxMessage({
      configuration: requireAaisAuthDeliveryConfiguration(configuredEnv),
      id: "10000000-0000-4000-8000-000000000004",
      purpose: "password_reset",
      authTokenId: resetTokenId,
      authTokenHash: tokenHash,
      recipient: "learner@example.test",
      subject: "AAIS password reset",
      text: "secret reset body",
    });
    database.seed(message);
    database.supersedeToken(message.authTokenId, "d".repeat(64));
    const fetchMock = vi.fn(async () =>
      new Response(null, { status: 202 }));

    const report = await flushAaisAuthEmailOutbox({
      database,
      env: configuredEnv,
      fetchImpl: fetchMock as typeof fetch,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });

    expect(report).toMatchObject({ claimed: 0, sent: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(database.rows.get(message.id)?.status).toBe("dead");
  });

  it.each([
    ["an uncertain retry", "retry"],
    ["an expired sending claim", "sending"],
  ] as const)("does not release the operator fence when invalidating %s", async (_label, priorStatus) => {
    const database = new FakeAuthEmailOutboxDatabase();
    const message = createAaisAuthEmailOutboxMessage({
      configuration: requireAaisAuthDeliveryConfiguration(configuredEnv),
      id: "10000000-0000-4000-8000-000000000020",
      purpose: "password_reset",
      authTokenId: resetTokenId,
      authTokenHash: tokenHash,
      recipient: "learner@example.test",
      subject: "AAIS password reset",
      text: "secret reset body",
    });
    database.seed(message);
    const row = database.rows.get(message.id)!;
    const token = database.tokens.get(message.authTokenId)!;
    row.status = priorStatus;
    row.attempt_count = 1;
    row.first_attempt_at = "2026-08-20T00:00:00.000Z";
    token.expiresAt = "2026-08-20T00:01:00.000Z";
    token.deliveryOutboxId = row.id;
    if (priorStatus === "retry") {
      row.uncertain_since = "2026-08-20T00:00:00.000Z";
      token.deliveryState = "uncertain";
    } else {
      row.claim_id = "20000000-0000-4000-8000-000000000020";
      row.claimed_at = "2026-08-20T00:00:00.000Z";
      row.lease_expires_at = "2026-08-20T00:01:00.000Z";
      token.deliveryState = "in_flight";
      token.deliveryClaimId = row.claim_id;
    }
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));

    const report = await flushAaisAuthEmailOutbox({
      database,
      env: configuredEnv,
      fetchImpl: fetchMock as typeof fetch,
      now: () => new Date("2026-08-20T00:10:00.000Z"),
    });

    expect(report).toMatchObject({ claimed: 0, deadLetter: 1, sent: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(row.status).toBe("dead");
    expect(row.uncertain_since).toBeTruthy();
    expect(token).toMatchObject({
      deliveryClaimId: null,
      deliveryOutboxId: row.id,
      deliveryState: "uncertain",
    });
    expect(() => database.supersedeToken(message.authTokenId, "d".repeat(64)))
      .toThrow("AAIS_AUTH_EMAIL_DELIVERY_FENCED");
    expect(database.claimSql).toContain("when email.status = 'sending'");
    expect(database.claimSql).toContain("when invalidated.uncertain_since is null then 'idle'");
  });

  it("rechecks a same-slot token hash after claim and skips a superseded delivery", async () => {
    const database = new FakeAuthEmailOutboxDatabase();
    const message = createAaisAuthEmailOutboxMessage({
      configuration: requireAaisAuthDeliveryConfiguration(configuredEnv),
      id: "10000000-0000-4000-8000-000000000005",
      purpose: "password_reset",
      authTokenId: resetTokenId,
      authTokenHash: tokenHash,
      recipient: "learner@example.test",
      subject: "AAIS password reset",
      text: "secret reset body",
    });
    database.seed(message);
    database.beforeRenew = () => {
      database.forceSupersedeToken(message.authTokenId, "e".repeat(64));
    };
    const fetchMock = vi.fn(async () =>
      new Response(null, { status: 202 }));

    const report = await flushAaisAuthEmailOutbox({
      database,
      env: configuredEnv,
      fetchImpl: fetchMock as typeof fetch,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });

    expect(report).toMatchObject({ claimed: 1, sent: 0, stale: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(database.rows.get(message.id)?.status).toBe("sending");
  });

  it("preserves an existing uncertain fence when a retry row later becomes poison", async () => {
    const database = new FakeAuthEmailOutboxDatabase();
    const message = createAaisAuthEmailOutboxMessage({
      configuration: requireAaisAuthDeliveryConfiguration(configuredEnv),
      id: "10000000-0000-4000-8000-000000000011",
      purpose: "password_reset",
      authTokenId: resetTokenId,
      authTokenHash: tokenHash,
      recipient: "learner@example.test",
      subject: "AAIS password reset",
      text: "secret reset body",
    });
    database.seed(message);
    const fetchMock = vi.fn(async () => {
      throw new TypeError("simulated uncertain transport failure");
    });

    await flushAaisAuthEmailOutbox({
      database,
      env: configuredEnv,
      fetchImpl: fetchMock as typeof fetch,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    database.rows.get(message.id)!.payload_envelope = { version: 1 };

    const report = await flushAaisAuthEmailOutbox({
      database,
      env: configuredEnv,
      fetchImpl: fetchMock as typeof fetch,
      now: () => new Date("2026-08-20T00:10:00.000Z"),
    });

    expect(report).toMatchObject({ sent: 0, retry: 0, deadLetter: 1 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(database.rows.get(message.id)).toMatchObject({
      status: "dead",
      uncertain_since: "2026-08-20T00:00:00.000Z",
    });
    expect(database.tokens.get(message.authTokenId)).toMatchObject({
      deliveryState: "uncertain",
      deliveryOutboxId: message.id,
    });
  });

  it("filters unavailable token fences before applying the claim batch limit", async () => {
    const database = new FakeAuthEmailOutboxDatabase();
    const configuration = requireAaisAuthDeliveryConfiguration(configuredEnv);
    const blocked = createAaisAuthEmailOutboxMessage({
      configuration,
      id: "10000000-0000-4000-8000-000000000012",
      purpose: "invite",
      authTokenId: inviteTokenId,
      authTokenHash: tokenHash,
      recipient: "blocked@example.test",
      subject: "AAIS account invitation",
      text: "blocked body",
    });
    const valid = createAaisAuthEmailOutboxMessage({
      configuration,
      id: "10000000-0000-4000-8000-000000000013",
      purpose: "password_reset",
      authTokenId: resetTokenId,
      authTokenHash: "a".repeat(64),
      recipient: "valid@example.test",
      subject: "AAIS password reset",
      text: "valid body",
    });
    database.seed(blocked);
    database.seed(valid);
    const blockedToken = database.tokens.get(blocked.authTokenId)!;
    blockedToken.deliveryState = "uncertain";
    blockedToken.deliveryOutboxId = "10000000-0000-4000-8000-000000000099";
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));

    const report = await flushAaisAuthEmailOutbox({
      batchSize: 1,
      database,
      env: configuredEnv,
      fetchImpl: fetchMock as typeof fetch,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });

    expect(report).toMatchObject({ claimed: 1, sent: 1 });
    expect(database.rows.get(valid.id)?.status).toBe("sent");
    const claimableSql = database.claimSql.slice(
      database.claimSql.indexOf("claimable_email as materialized"),
      database.claimSql.indexOf("fenced_token as"),
    );
    expect(claimableSql).toContain("token.email_delivery_state = 'idle'");
    expect(claimableSql.indexOf("token.email_delivery_state = 'idle'")).toBeLessThan(
      claimableSql.indexOf("limit greatest"),
    );
  });

  it("does not ACK an outbox row unless the owned token fence transitions atomically", async () => {
    const database = new FakeAuthEmailOutboxDatabase();
    const message = createAaisAuthEmailOutboxMessage({
      configuration: requireAaisAuthDeliveryConfiguration(configuredEnv),
      id: "10000000-0000-4000-8000-000000000014",
      purpose: "invite",
      authTokenId: inviteTokenId,
      authTokenHash: tokenHash,
      recipient: "teacher@example.test",
      subject: "AAIS account invitation",
      text: "secret invite body",
    });
    database.seed(message);
    database.beforeAcknowledge = () => {
      database.tokens.get(message.authTokenId)!.deliveryClaimId =
        "20000000-0000-4000-8000-000000000099";
    };

    const report = await flushAaisAuthEmailOutbox({
      database,
      env: configuredEnv,
      fetchImpl: vi.fn(async () => new Response(null, { status: 202 })) as typeof fetch,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });

    expect(report).toMatchObject({ sent: 0, stale: 1 });
    expect(database.rows.get(message.id)?.status).toBe("sending");
    expect(database.ackSql.indexOf("updated_token_fence as")).toBeLessThan(
      database.ackSql.indexOf("acknowledged_email as"),
    );
    expect(database.ackSql).not.toContain("cross join (select count(*)");
  });

  it("stops at the invocation budget and atomically releases unstarted rows", async () => {
    const database = new FakeAuthEmailOutboxDatabase();
    const configuration = requireAaisAuthDeliveryConfiguration(configuredEnv);
    const first = createAaisAuthEmailOutboxMessage({
      configuration,
      id: "10000000-0000-4000-8000-000000000016",
      purpose: "invite",
      authTokenId: inviteTokenId,
      authTokenHash: tokenHash,
      recipient: "first@example.test",
      subject: "First message",
      text: "first body",
    });
    const second = createAaisAuthEmailOutboxMessage({
      configuration,
      id: "10000000-0000-4000-8000-000000000017",
      purpose: "password_reset",
      authTokenId: resetTokenId,
      authTokenHash: "b".repeat(64),
      recipient: "second@example.test",
      subject: "Second message",
      text: "second body",
    });
    database.seed(first);
    database.seed(second);
    let currentTime = Date.parse("2026-08-20T00:00:00.000Z");
    const fetchMock = vi.fn(async () => {
      currentTime += 4_000;
      return new Response(null, { status: 202 });
    });

    const report = await flushAaisAuthEmailOutbox({
      database,
      env: configuredEnv,
      fetchImpl: fetchMock as typeof fetch,
      now: () => new Date(currentTime),
      runtimeBudgetMs: 3_000,
      timeoutMs: 100,
    });

    expect(report).toMatchObject({
      claimed: 2,
      deferred: 1,
      hasMore: true,
      sent: 1,
      stale: 0,
      stoppedReason: "runtime_budget",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(database.rows.get(second.id)).toMatchObject({
      attempt_count: 0,
      claim_id: null,
      first_attempt_at: null,
      status: "pending",
    });
    expect(database.tokens.get(second.authTokenId)).toMatchObject({
      deliveryClaimId: null,
      deliveryOutboxId: null,
      deliveryState: "idle",
    });

    const continuation = await flushAaisAuthEmailOutbox({
      database,
      env: configuredEnv,
      fetchImpl: fetchMock as typeof fetch,
      now: () => new Date(currentTime),
      runtimeBudgetMs: 3_000,
      timeoutMs: 100,
    });
    expect(continuation).toMatchObject({ claimed: 1, sent: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not start a provider request that cannot finish inside the dispatch budget", async () => {
    const database = new FakeAuthEmailOutboxDatabase();
    const message = createAaisAuthEmailOutboxMessage({
      configuration: requireAaisAuthDeliveryConfiguration(configuredEnv),
      id: "10000000-0000-4000-8000-000000000018",
      purpose: "password_reset",
      authTokenId: resetTokenId,
      authTokenHash: tokenHash,
      recipient: "learner@example.test",
      subject: "AAIS password reset",
      text: "secret reset body",
    });
    database.seed(message);
    let currentTime = Date.parse("2026-08-20T00:00:00.000Z");
    database.beforeRenew = () => {
      currentTime += 1_000;
    };
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));

    const report = await flushAaisAuthEmailOutbox({
      database,
      env: configuredEnv,
      fetchImpl: fetchMock as typeof fetch,
      now: () => new Date(currentTime),
      runtimeBudgetMs: 3_000,
      timeoutMs: 100,
    });

    expect(report).toMatchObject({
      claimed: 1,
      deferred: 1,
      sent: 0,
      stoppedReason: "runtime_budget",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(database.rows.get(message.id)).toMatchObject({
      attempt_count: 0,
      claim_id: null,
      status: "pending",
    });
  });

  it.each([
    ["an existing uncertain retry", "retry"],
    ["an expired sending claim", "sending"],
  ] as const)("preserves the delivery fence when deferring %s", async (_label, priorStatus) => {
    const database = new FakeAuthEmailOutboxDatabase();
    const message = createAaisAuthEmailOutboxMessage({
      configuration: requireAaisAuthDeliveryConfiguration(configuredEnv),
      id: "10000000-0000-4000-8000-000000000019",
      purpose: "password_reset",
      authTokenId: resetTokenId,
      authTokenHash: tokenHash,
      recipient: "learner@example.test",
      subject: "AAIS password reset",
      text: "secret reset body",
    });
    database.seed(message);
    const row = database.rows.get(message.id)!;
    const token = database.tokens.get(message.authTokenId)!;
    row.status = priorStatus;
    row.attempt_count = 1;
    row.first_attempt_at = "2026-08-20T00:00:00.000Z";
    token.deliveryOutboxId = row.id;
    if (priorStatus === "retry") {
      row.uncertain_since = "2026-08-20T00:00:00.000Z";
      token.deliveryState = "uncertain";
    } else {
      row.claim_id = "20000000-0000-4000-8000-000000000019";
      row.claimed_at = "2026-08-20T00:00:00.000Z";
      row.lease_expires_at = "2026-08-20T00:00:01.000Z";
      token.deliveryState = "in_flight";
      token.deliveryClaimId = row.claim_id;
    }
    let currentTime = Date.parse("2026-08-20T00:10:00.000Z");
    database.beforeRenew = () => {
      currentTime += 1_000;
    };
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));

    const report = await flushAaisAuthEmailOutbox({
      database,
      env: configuredEnv,
      fetchImpl: fetchMock as typeof fetch,
      now: () => new Date(currentTime),
      runtimeBudgetMs: 3_000,
      timeoutMs: 100,
    });

    expect(report).toMatchObject({ deferred: 1, stoppedReason: "runtime_budget" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(row).toMatchObject({
      attempt_count: 1,
      claim_id: null,
      status: "retry",
    });
    expect(row.uncertain_since).toBeTruthy();
    expect(token).toMatchObject({
      deliveryClaimId: null,
      deliveryOutboxId: row.id,
      deliveryState: "uncertain",
    });
    expect(database.claimSql).toContain("when email.status = 'sending'");
    expect(database.releaseSql).toContain("when releasable.uncertain_since is null then 'idle'");
  });
});

describe("AAIS authentication email operator reconciliation", () => {
  it("idempotently confirms sent evidence while retaining a delivered token fence", async () => {
    const database = createUncertainDeadLetter();
    const input = {
      actorId: "admin-operator",
      database,
      disposition: "sent" as const,
      evidence: {
        provider: "resend" as const,
        messageId: "resend_message_1234567890",
        status: "delivered" as const,
        observedAt: "2026-08-20T00:20:00.000Z",
      },
      now: () => new Date("2026-08-20T00:30:00.000Z"),
      outboxId: "10000000-0000-4000-8000-000000000015",
    };

    const first = await reconcileAaisAuthEmailOutbox(input);
    const second = await reconcileAaisAuthEmailOutbox(input);

    expect(second).toEqual(first);
    expect(first).toEqual({
      disposition: "sent",
      outboxId: input.outboxId,
      reconciledAt: "2026-08-20T00:30:00.000Z",
      reissueAllowed: false,
      status: "sent",
      tokenState: "delivered",
    });
    expect(JSON.stringify(first)).not.toContain(input.evidence.messageId);
    expect(database.rows.get(input.outboxId)?.status).toBe("sent");
    expect(database.tokens.get(resetTokenId)).toMatchObject({
      consumed: false,
      deliveryState: "delivered",
      deliveryOutboxId: input.outboxId,
    });
  });

  it("only allows not-sent reconciliation after atomically consuming the old token", async () => {
    const database = createUncertainDeadLetter();

    const result = await reconcileAaisAuthEmailOutbox({
      actorId: "admin-operator",
      database,
      disposition: "not_sent",
      evidence: {
        provider: "resend",
        messageId: "resend_message_1234567890",
        status: "failed",
        observedAt: "2026-08-20T00:20:00.000Z",
      },
      now: () => new Date("2026-08-20T00:30:00.000Z"),
      outboxId: "10000000-0000-4000-8000-000000000015",
    });

    expect(result).toMatchObject({
      disposition: "not_sent",
      reissueAllowed: true,
      status: "dead",
      tokenState: "idle",
    });
    expect(database.tokens.get(resetTokenId)).toMatchObject({
      consumed: true,
      deliveryState: "idle",
      deliveryOutboxId: null,
    });
  });

  it("fails closed for conflicting evidence without mutating the completed reconciliation", async () => {
    const database = createUncertainDeadLetter();
    const common = {
      actorId: "admin-operator",
      database,
      evidence: {
        provider: "resend" as const,
        messageId: "resend_message_1234567890",
        status: "delivered" as const,
        observedAt: "2026-08-20T00:20:00.000Z",
      },
      now: () => new Date("2026-08-20T00:30:00.000Z"),
      outboxId: "10000000-0000-4000-8000-000000000015",
    };
    await reconcileAaisAuthEmailOutbox({ ...common, disposition: "sent" });

    await expect(reconcileAaisAuthEmailOutbox({
      ...common,
      disposition: "not_sent",
      evidence: { ...common.evidence, status: "failed" },
    })).rejects.toBeInstanceOf(AaisAuthEmailReconciliationConflictError);
    expect(database.rows.get(common.outboxId)?.status).toBe("sent");
    expect(database.tokens.get(resetTokenId)?.deliveryState).toBe("delivered");
  });

  it("rejects contradictory provider evidence before any database write", async () => {
    const database = createUncertainDeadLetter();

    await expect(reconcileAaisAuthEmailOutbox({
      actorId: "admin-operator",
      database,
      disposition: "not_sent",
      evidence: {
        provider: "resend",
        messageId: "resend_message_1234567890",
        status: "delivered",
        observedAt: "2026-08-20T00:20:00.000Z",
      },
      now: () => new Date("2026-08-20T00:30:00.000Z"),
      outboxId: "10000000-0000-4000-8000-000000000015",
    })).rejects.toThrow("does not match the disposition");
    expect(database.reconciliationQueryCount).toBe(0);
  });
});

type FakeAuthEmailOutboxRow = {
  id: string;
  purpose: "invite" | "password_reset";
  auth_token_id: string;
  auth_token_hash: string;
  auth_token_expires_at: string;
  recipient: string;
  payload_envelope: Record<string, unknown>;
  idempotency_key: string;
  status: "pending" | "sending" | "retry" | "sent" | "dead";
  attempt_count: number;
  next_attempt_at: string;
  claim_id: string | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
  first_attempt_at: string | null;
  uncertain_since: string | null;
  dead_lettered_at: string | null;
  sent_at: string | null;
  reconciliation_disposition: "sent" | "not_sent" | null;
  reconciliation_provider: "resend" | null;
  reconciliation_message_id: string | null;
  reconciliation_observed_status: string | null;
  reconciliation_observed_at: string | null;
  reconciled_at: string | null;
  reconciled_by: string | null;
};

type FakeAuthTokenFence = {
  id: string;
  hash: string;
  purpose: "invite" | "password_reset";
  expiresAt: string;
  consumed: boolean;
  userStatus: "active" | "invited" | "disabled";
  deliveryState: "idle" | "in_flight" | "uncertain" | "delivered";
  deliveryOutboxId: string | null;
  deliveryClaimId: string | null;
};

class FakeAuthEmailOutboxDatabase implements AaisDatabaseClient {
  readonly rows = new Map<string, FakeAuthEmailOutboxRow>();
  readonly tokens = new Map<string, FakeAuthTokenFence>();
  beforeRenew: (() => void) | null = null;
  beforeAcknowledge: (() => void) | null = null;
  claimSql = "";
  releaseSql = "";
  ackSql = "";
  reconciliationQueryCount = 0;

  seed(message: ReturnType<typeof createAaisAuthEmailOutboxMessage>) {
    this.rows.set(message.id, {
      id: message.id,
      purpose: message.purpose,
      auth_token_id: message.authTokenId,
      auth_token_hash: message.authTokenHash,
      auth_token_expires_at: "2026-08-21T00:00:00.000Z",
      recipient: message.recipient,
      payload_envelope: message.payloadEnvelope,
      idempotency_key: message.idempotencyKey,
      status: "pending",
      attempt_count: 0,
      next_attempt_at: "2026-08-20T00:00:00.000Z",
      claim_id: null,
      claimed_at: null,
      lease_expires_at: null,
      first_attempt_at: null,
      uncertain_since: null,
      dead_lettered_at: null,
      sent_at: null,
      reconciliation_disposition: null,
      reconciliation_provider: null,
      reconciliation_message_id: null,
      reconciliation_observed_status: null,
      reconciliation_observed_at: null,
      reconciled_at: null,
      reconciled_by: null,
    });
    this.tokens.set(message.authTokenId, {
      id: message.authTokenId,
      hash: message.authTokenHash,
      purpose: message.purpose,
      expiresAt: "2026-08-21T00:00:00.000Z",
      consumed: false,
      userStatus: "active",
      deliveryState: "idle",
      deliveryOutboxId: null,
      deliveryClaimId: null,
    });
  }

  supersedeToken(tokenId: string, hash: string) {
    const token = this.tokens.get(tokenId);
    if (token) {
      if (token.deliveryState !== "idle") {
        throw Object.assign(new Error("AAIS_AUTH_EMAIL_DELIVERY_FENCED"), { code: "P0001" });
      }
      token.hash = hash;
    }
  }

  forceSupersedeToken(tokenId: string, hash: string) {
    const token = this.tokens.get(tokenId);
    if (token) token.hash = hash;
  }

  async query(sql: string, params: unknown[] = []) {
    const normalized = sql.trim().toLowerCase();
    if (normalized.startsWith("with invalidatable_email as materialized")) {
      this.claimSql = normalized;
      const [nowValue, limitValue, claimIdValue, leaseExpiresValue] = params;
      const now = String(nowValue);
      const limit = Number(limitValue);
      const claimId = String(claimIdValue);
      const invalidated = [...this.rows.values()]
        .filter((row) => ["pending", "retry", "sending"].includes(row.status)
          && !this.tokenMatches(row, now))
        .slice(0, limit);
      for (const row of invalidated) {
          const invalidatedUnknownDelivery = row.status === "sending";
          row.status = "dead";
          if (invalidatedUnknownDelivery) {
            row.uncertain_since ??= now;
          }
          row.claim_id = null;
          row.claimed_at = null;
          row.lease_expires_at = null;
          const token = this.tokens.get(row.auth_token_id);
          if (token?.deliveryOutboxId === row.id) {
            token.deliveryState = row.uncertain_since ? "uncertain" : "idle";
            token.deliveryOutboxId = row.uncertain_since ? row.id : null;
            token.deliveryClaimId = null;
          }
      }
      const candidates = [...this.rows.values()]
        .filter((row) => (
          (["pending", "retry"].includes(row.status) && row.next_attempt_at <= now)
          || (row.status === "sending" && String(row.lease_expires_at) <= now)
        ) && this.tokenMatches(row, now) && this.tokenFenceAvailable(row))
        .sort((left, right) => left.next_attempt_at.localeCompare(right.next_attempt_at))
        .slice(0, Math.max(0, limit - invalidated.length));
      for (const row of candidates) {
        const reclaimedUnknownDelivery = row.status === "sending";
        row.status = "sending";
        row.attempt_count += 1;
        row.claim_id = claimId;
        row.claimed_at = now;
        row.lease_expires_at = String(leaseExpiresValue);
        row.first_attempt_at ??= now;
        if (reclaimedUnknownDelivery) {
          row.uncertain_since ??= now;
        }
        const token = this.tokens.get(row.auth_token_id)!;
        token.deliveryState = "in_flight";
        token.deliveryOutboxId = row.id;
        token.deliveryClaimId = claimId;
      }
      return {
        rows: [
          ...candidates.map((row) => ({ invalidated: false, ...row })),
          ...invalidated.map((row) => ({ invalidated: true, id: row.id })),
        ],
      };
    }
    if (normalized.startsWith("with releasable_email as materialized")) {
      this.releaseSql = normalized;
      const [claimIdValue, idsValue, releasedAtValue] = params;
      const claimId = String(claimIdValue);
      const ids = new Set((idsValue as unknown[]).map(String));
      const released: { id: string }[] = [];
      for (const row of this.rows.values()) {
        if (
          !ids.has(row.id)
          || row.status !== "sending"
          || row.claim_id !== claimId
          || !this.tokenFenceOwned(row, claimId)
        ) {
          continue;
        }
        const previousAttemptCount = row.attempt_count;
        row.status = previousAttemptCount <= 1 ? "pending" : "retry";
        row.attempt_count = Math.max(0, previousAttemptCount - 1);
        row.first_attempt_at = previousAttemptCount <= 1 ? null : row.first_attempt_at;
        row.next_attempt_at = String(releasedAtValue);
        row.claim_id = null;
        row.claimed_at = null;
        row.lease_expires_at = null;
        if (row.uncertain_since) {
          const token = this.tokens.get(row.auth_token_id);
          if (token) {
            token.deliveryState = "uncertain";
            token.deliveryOutboxId = row.id;
            token.deliveryClaimId = null;
          }
        } else {
          this.releaseTokenFence(row);
        }
        released.push({ id: row.id });
      }
      return { rows: released };
    }
    if (normalized.startsWith("update public.aais_auth_email_outbox email")
      && normalized.includes("set lease_expires_at = $6::timestamptz")) {
      this.beforeRenew?.();
      this.beforeRenew = null;
      const [idValue, claimIdValue, tokenIdValue, tokenHashValue, nowValue, leaseExpiresValue] = params;
      const row = this.rows.get(String(idValue));
      if (
        !row
        || row.status !== "sending"
        || row.claim_id !== String(claimIdValue)
        || row.auth_token_id !== String(tokenIdValue)
        || row.auth_token_hash !== String(tokenHashValue)
        || !this.tokenMatches(row, String(nowValue))
        || String(row.lease_expires_at) <= String(nowValue)
        || !this.tokenFenceOwned(row, String(claimIdValue))
      ) {
        return { rows: [] };
      }
      row.lease_expires_at = String(leaseExpiresValue);
      return { rows: [{ id: row.id }] };
    }
    if (normalized.startsWith("with acknowledged_email as")
      || normalized.startsWith("with acknowledged_candidate as materialized")) {
      this.ackSql = normalized;
      this.beforeAcknowledge?.();
      this.beforeAcknowledge = null;
      const [idValue, claimIdValue, nowValue] = params;
      const row = this.rows.get(String(idValue));
      if (
        !row
        || row.status !== "sending"
        || row.claim_id !== String(claimIdValue)
        || !this.tokenFenceOwned(row, String(claimIdValue))
      ) {
        return { rows: [] };
      }
      row.status = "sent";
      row.sent_at = String(nowValue);
      row.dead_lettered_at = null;
      row.claim_id = null;
      row.claimed_at = null;
      row.lease_expires_at = null;
      row.next_attempt_at = String(nowValue);
      const token = this.tokens.get(row.auth_token_id)!;
      token.deliveryState = "delivered";
      token.deliveryClaimId = null;
      return { rows: [{ id: row.id }] };
    }
    if ((normalized.startsWith("with failed_email as")
      || normalized.startsWith("with failed_candidate as materialized"))
      && normalized.includes("set status = $3")) {
      const [idValue, claimIdValue, statusValue, nextAttemptValue, , , uncertainSinceValue] = params;
      const row = this.rows.get(String(idValue));
      if (!row || row.status !== "sending" || row.claim_id !== String(claimIdValue)) {
        return { rows: [] };
      }
      row.status = String(statusValue) as FakeAuthEmailOutboxRow["status"];
      row.dead_lettered_at = row.status === "dead" ? String(nextAttemptValue) : null;
      row.next_attempt_at = String(nextAttemptValue);
      row.claim_id = null;
      row.claimed_at = null;
      row.lease_expires_at = null;
      if (uncertainSinceValue) {
        row.uncertain_since ??= String(uncertainSinceValue);
        const token = this.tokens.get(row.auth_token_id);
        if (token) {
          token.deliveryState = "uncertain";
          token.deliveryOutboxId = row.id;
          token.deliveryClaimId = null;
        }
      } else {
        this.releaseTokenFence(row);
      }
      return { rows: [{ id: row.id }] };
    }
    if (normalized.startsWith("with locked_reconciliation as materialized")) {
      this.reconciliationQueryCount += 1;
      const [idValue, dispositionValue, providerValue, messageIdValue, statusValue,
        observedAtValue, reconciledAtValue, actorIdValue] = params;
      const row = this.rows.get(String(idValue));
      const token = row ? this.tokens.get(row.auth_token_id) : null;
      if (!row || !token) return { rows: [] };
      const disposition = String(dispositionValue) as "sent" | "not_sent";
      const exactExisting = row.reconciliation_disposition === disposition
        && row.reconciliation_provider === String(providerValue)
        && row.reconciliation_message_id === String(messageIdValue)
        && row.reconciliation_observed_status === String(statusValue)
        && row.reconciliation_observed_at === String(observedAtValue);
      if (exactExisting) {
        return { rows: [{
          id: row.id,
          disposition,
          status: row.status,
          token_state: token.deliveryState,
          reconciled_at: row.reconciled_at,
        }] };
      }
      if (
        row.reconciliation_disposition !== null
        || row.status !== "dead"
        || row.uncertain_since === null
        || token.deliveryState !== "uncertain"
        || token.deliveryOutboxId !== row.id
        || token.deliveryClaimId !== null
      ) return { rows: [] };
      row.reconciliation_disposition = disposition;
      row.reconciliation_provider = String(providerValue) as "resend";
      row.reconciliation_message_id = String(messageIdValue);
      row.reconciliation_observed_status = String(statusValue);
      row.reconciliation_observed_at = String(observedAtValue);
      row.reconciled_at = String(reconciledAtValue);
      row.reconciled_by = String(actorIdValue);
      if (disposition === "sent") {
        row.status = "sent";
        row.sent_at = String(reconciledAtValue);
        row.dead_lettered_at = null;
        token.deliveryState = "delivered";
        token.deliveryClaimId = null;
      } else {
        row.status = "dead";
        token.consumed = true;
        token.deliveryState = "idle";
        token.deliveryOutboxId = null;
        token.deliveryClaimId = null;
      }
      return { rows: [{
        id: row.id,
        disposition,
        status: row.status,
        token_state: token.deliveryState,
        reconciled_at: row.reconciled_at,
      }] };
    }
    throw new Error(`Unexpected auth email outbox query: ${normalized}`);
  }

  private tokenMatches(row: FakeAuthEmailOutboxRow, now: string) {
    const token = this.tokens.get(row.auth_token_id);
    return Boolean(
      token
      && token.hash === row.auth_token_hash
      && token.purpose === row.purpose
      && !token.consumed
      && token.expiresAt > now
      && token.userStatus !== "disabled"
    );
  }

  private tokenFenceAvailable(row: FakeAuthEmailOutboxRow) {
    const token = this.tokens.get(row.auth_token_id);
    return Boolean(token && (
      token.deliveryState === "idle"
      || (
        ["in_flight", "uncertain"].includes(token.deliveryState)
        && token.deliveryOutboxId === row.id
      )
    ));
  }

  private tokenFenceOwned(row: FakeAuthEmailOutboxRow, claimId: string) {
    const token = this.tokens.get(row.auth_token_id);
    return Boolean(
      token
      && token.deliveryState === "in_flight"
      && token.deliveryOutboxId === row.id
      && token.deliveryClaimId === claimId
    );
  }

  private releaseTokenFence(row: FakeAuthEmailOutboxRow) {
    const token = this.tokens.get(row.auth_token_id);
    if (token?.deliveryOutboxId === row.id) {
      token.deliveryState = "idle";
      token.deliveryOutboxId = null;
      token.deliveryClaimId = null;
    }
  }
}

function createUncertainDeadLetter() {
  const database = new FakeAuthEmailOutboxDatabase();
  const message = createAaisAuthEmailOutboxMessage({
    configuration: requireAaisAuthDeliveryConfiguration(configuredEnv),
    id: "10000000-0000-4000-8000-000000000015",
    purpose: "password_reset",
    authTokenId: resetTokenId,
    authTokenHash: tokenHash,
    recipient: "learner@example.test",
    subject: "AAIS password reset",
    text: "secret reset body",
  });
  database.seed(message);
  const row = database.rows.get(message.id)!;
  row.status = "dead";
  row.uncertain_since = "2026-08-20T00:00:00.000Z";
  row.dead_lettered_at = "2026-08-20T00:10:00.000Z";
  const token = database.tokens.get(message.authTokenId)!;
  token.deliveryState = "uncertain";
  token.deliveryOutboxId = message.id;
  token.deliveryClaimId = null;
  return database;
}
