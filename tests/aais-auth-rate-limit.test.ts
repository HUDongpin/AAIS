import { afterEach, describe, expect, it, vi } from "vitest";
import {
  admitAaisLoginAttempt,
  checkAaisLoginRateLimit,
  clearAaisLoginFailures,
  getAaisAuthRateLimitMemoryDiagnostics,
  readAaisAuthRateLimitRetentionConfig,
  readAaisLoginRateLimitConfig,
  readAaisPasswordResetRateLimitConfig,
  readAaisSetPasswordRateLimitConfig,
  recordAaisLoginFailure,
  recordAaisPasswordResetRequest,
  recordAaisSetPasswordRequest,
} from "@/lib/server/aais-auth-rate-limit";

describe("AAIS login rate limiting", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.AAIS_TRUSTED_PROXY_IP_HEADER;
    delete process.env.AAIS_LOGIN_RATE_LIMIT_MAX_FAILURES;
    delete process.env.AAIS_LOGIN_RATE_LIMIT_CLIENT_MAX_ATTEMPTS;
    delete process.env.AAIS_LOGIN_RATE_LIMIT_WINDOW_SECONDS;
    delete process.env.AAIS_LOGIN_RATE_LIMIT_LOCK_SECONDS;
    delete process.env.AAIS_SET_PASSWORD_TOKEN_MAX_REQUESTS;
    delete process.env.AAIS_SET_PASSWORD_CLIENT_MAX_REQUESTS;
    delete process.env.AAIS_SET_PASSWORD_WINDOW_SECONDS;
    delete process.env.AAIS_SET_PASSWORD_LOCK_SECONDS;
    delete process.env.AAIS_AUTH_RATE_LIMIT_MEMORY_MAX_ENTRIES;
    delete process.env.AAIS_AUTH_RATE_LIMIT_DATABASE_CLEANUP_BATCH_SIZE;
  });

  it("fails closed instead of using process-local memory when durable storage is absent in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const request = createRequest("198.51.100.200");

    for (const operation of [
      () => checkAaisLoginRateLimit({ accountId: "production-user", request, database: null }),
      () => admitAaisLoginAttempt({ accountId: "production-user", request, database: null }),
      () => recordAaisPasswordResetRequest({
        accountId: "production-user@example.test",
        request,
        database: null,
      }),
      () => recordAaisSetPasswordRequest({
        token: `aais_reset_${"x".repeat(43)}`,
        request,
        database: null,
      }),
      () => clearAaisLoginFailures({ accountId: "production-user", request, database: null }),
    ]) {
      await expect(operation()).rejects.toThrow(
        "AAIS durable authentication rate-limit storage is unavailable.",
      );
    }
  });

  it("uses bounded process-local protection for the stateless Vercel Preview smoke", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    const request = createRequest("198.51.100.201");

    await expect(admitAaisLoginAttempt({
      accountId: "preview-smoke-user",
      request,
      database: null,
    })).resolves.toEqual({ status: "allowed" });
    await expect(clearAaisLoginFailures({
      accountId: "preview-smoke-user",
      request,
      database: null,
    })).resolves.toBeUndefined();
  });

  it("sweeps expired development entries and enforces a bounded LRU memory fallback", async () => {
    vi.stubEnv("AAIS_AUTH_RATE_LIMIT_MEMORY_MAX_ENTRIES", "4");
    vi.stubEnv("AAIS_LOGIN_RATE_LIMIT_MAX_FAILURES", "1");
    vi.stubEnv("AAIS_LOGIN_RATE_LIMIT_WINDOW_SECONDS", "10");
    vi.stubEnv("AAIS_LOGIN_RATE_LIMIT_LOCK_SECONDS", "10");
    const rateLimitModule = await import("@/lib/server/aais-auth-rate-limit");
    const now = Date.UTC(2026, 6, 8, 11, 0, 0);

    await rateLimitModule.recordAaisLoginFailure({
      accountId: "memory-lru-a",
      request: createRequest("198.51.100.1"),
      now,
      database: null,
    });
    await rateLimitModule.recordAaisLoginFailure({
      accountId: "memory-lru-b",
      request: createRequest("198.51.100.2"),
      now,
      database: null,
    });
    await rateLimitModule.checkAaisLoginRateLimit({
      accountId: "memory-lru-a",
      request: createRequest("198.51.100.3"),
      now,
      database: null,
    });
    await rateLimitModule.recordAaisLoginFailure({
      accountId: "memory-lru-c",
      request: createRequest("198.51.100.4"),
      now,
      database: null,
    });

    expect(getAaisAuthRateLimitMemoryDiagnostics(now).entryCount).toBeLessThanOrEqual(4);
    await expect(rateLimitModule.recordAaisLoginFailure({
      accountId: "memory-lru-a",
      request: createRequest("198.51.100.5"),
      now,
      database: null,
    })).resolves.toEqual({ status: "blocked", retryAfterSeconds: 10 });
    await expect(rateLimitModule.recordAaisLoginFailure({
      accountId: "memory-lru-b",
      request: createRequest("198.51.100.6"),
      now,
      database: null,
    })).resolves.toEqual({ status: "allowed" });

    expect(getAaisAuthRateLimitMemoryDiagnostics(now + 10_001)).toEqual({
      entryCount: 0,
      maxEntries: 4,
    });
  });

  it("keeps the development memory fallback behavior", async () => {
    const request = createRequest("198.51.100.7");
    const now = Date.UTC(2026, 6, 8, 12, 0, 0);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(recordAaisLoginFailure({
        accountId: "Bobie",
        request,
        now,
        database: null,
      })).resolves.toEqual({ status: "allowed" });
    }

    await expect(recordAaisLoginFailure({
      accountId: "Bobie",
      request,
      now,
      database: null,
    })).resolves.toEqual({
      status: "blocked",
      retryAfterSeconds: 900,
    });
  });

  it("bounds process-memory capacity and database cleanup work", () => {
    expect(readAaisAuthRateLimitRetentionConfig({
      AAIS_AUTH_RATE_LIMIT_MEMORY_MAX_ENTRIES: "1",
      AAIS_AUTH_RATE_LIMIT_DATABASE_CLEANUP_BATCH_SIZE: "999999",
    })).toEqual({
      memoryMaxEntries: 4,
      databaseCleanupBatchSize: 1_000,
    });
  });

  it("persists failed login attempts in Postgres with hashed account and client keys", async () => {
    const database = new FakeRateLimitDatabase();
    const request = createRequest("203.0.113.24");
    const nextInvocationRequest = createRequest("203.0.113.24");
    const now = Date.UTC(2026, 6, 8, 12, 0, 0);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(recordAaisLoginFailure({
        accountId: "Bobie",
        request,
        now,
        database,
      })).resolves.toEqual({ status: "allowed" });
    }
    const blocked = await recordAaisLoginFailure({
      accountId: "Bobie",
      request,
      now,
      database,
    });
    const checked = await checkAaisLoginRateLimit({
      accountId: "Bobie",
      request: nextInvocationRequest,
      now,
      database,
    });

    expect(blocked).toEqual({
      status: "blocked",
      retryAfterSeconds: 900,
    });
    expect(checked).toEqual(blocked);
    expect(database.rows.size).toBe(2);
    expect(database.queries.some((query) => query.sql.trim().toLowerCase() === "begin")).toBe(false);
    expect(JSON.stringify(database.queries)).not.toContain("Bobie");
    expect(JSON.stringify(database.queries)).not.toContain("203.0.113.24");

    await clearAaisLoginFailures({
      accountId: "Bobie",
      request,
      database,
    });
    await expect(checkAaisLoginRateLimit({
      accountId: "Bobie",
      request,
      now,
      database,
    })).resolves.toEqual({ status: "allowed" });
  });

  it("logically expires durable rows and opportunistically deletes them in bounded batches", async () => {
    const database = new FakeRateLimitDatabase();
    const request = createRequest("203.0.113.25");
    const now = Date.UTC(2026, 6, 8, 12, 0, 0);

    await recordAaisLoginFailure({
      accountId: "expired-durable-a",
      request,
      now,
      database,
    });
    expect(database.rows.size).toBe(2);

    await recordAaisLoginFailure({
      accountId: "active-durable-b",
      request,
      now: now + 15 * 60 * 1000 + 1,
      database,
    });
    expect(database.rows.size).toBe(2);
    await expect(checkAaisLoginRateLimit({
      accountId: "expired-durable-a",
      request,
      now: now + 15 * 60 * 1000 + 1,
      database,
    })).resolves.toEqual({ status: "allowed" });
  });

  it("atomically counts concurrent database failures without a pooled BEGIN sequence", async () => {
    const database = new FakeRateLimitDatabase();
    const request = createRequest("203.0.113.88");
    const now = Date.UTC(2026, 6, 8, 12, 30, 0);

    const results = await Promise.all(Array.from({ length: 20 }, () =>
      recordAaisLoginFailure({
        accountId: "Concurrent Learner",
        request,
        now,
        database,
      })
    ));

    expect(results.filter((result) => result.status === "blocked")).toHaveLength(15);
    expect(Array.from(database.rows.values())[0]?.failures).toBe(6);
    expect(database.queries).toHaveLength(20);
    expect(database.queries.every((query) =>
      query.sql.toLowerCase().includes("insert into aais_login_rate_limits")
    )).toBe(true);
  });

  it("atomically admits only one concurrent login before KDF work when capacity is one", async () => {
    process.env.AAIS_LOGIN_RATE_LIMIT_MAX_FAILURES = "1";
    const now = Date.UTC(2026, 6, 8, 12, 40, 0);
    const request = createRequest("203.0.113.89");
    const database = new FakeRateLimitDatabase();

    const databaseResults = await Promise.all(Array.from({ length: 20 }, () =>
      admitAaisLoginAttempt({
        accountId: "Concurrent Admission",
        request,
        now,
        database,
      })
    ));
    const memoryResults = await Promise.all(Array.from({ length: 20 }, () =>
      admitAaisLoginAttempt({
        accountId: "Memory Concurrent Admission",
        request,
        now,
        database: null,
      })
    ));

    expect(databaseResults.filter((result) => result.status === "allowed")).toHaveLength(1);
    expect(memoryResults.filter((result) => result.status === "allowed")).toHaveLength(1);
    expect(databaseResults.filter((result) => result.status === "blocked")).toHaveLength(19);
    expect(memoryResults.filter((result) => result.status === "blocked")).toHaveLength(19);
  });

  it("blocks one account across rotating trusted client addresses in memory and Postgres", async () => {
    process.env.AAIS_TRUSTED_PROXY_IP_HEADER = "x-forwarded-for";
    const now = Date.UTC(2026, 6, 8, 12, 45, 0);
    const accountId = "rotating-client@example.test";
    const database = new FakeRateLimitDatabase();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const request = createRequest(`203.0.113.${attempt + 1}`);
      await expect(recordAaisLoginFailure({
        accountId,
        request,
        now,
        database: null,
      })).resolves.toEqual({ status: "allowed" });
      await expect(recordAaisLoginFailure({
        accountId,
        request,
        now,
        database,
      })).resolves.toEqual({ status: "allowed" });
    }

    const sixthClient = createRequest("203.0.113.200");
    const expected = {
      status: "blocked" as const,
      retryAfterSeconds: 900,
    };
    await expect(recordAaisLoginFailure({
      accountId,
      request: sixthClient,
      now,
      database: null,
    })).resolves.toEqual(expected);
    await expect(recordAaisLoginFailure({
      accountId,
      request: sixthClient,
      now,
      database,
    })).resolves.toEqual(expected);

    await expect(checkAaisLoginRateLimit({
      accountId,
      request: createRequest("198.51.100.250"),
      now,
      database,
    })).resolves.toEqual(expected);
    expect(database.queries).toHaveLength(7);
    expect(database.queries.every((query) =>
      query.sql.toLowerCase().includes("insert into aais_login_rate_limits")
      || query.sql.trim().toLowerCase().startsWith("select locked_until")
    )).toBe(true);
  });

  it("ignores spoofable forwarding headers unless a trusted proxy header is explicitly configured", async () => {
    const database = new FakeRateLimitDatabase();
    const now = Date.UTC(2026, 6, 8, 12, 50, 0);

    for (const spoofedAddress of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) {
      await recordAaisLoginFailure({
        accountId: "spoof-resistant@example.test",
        request: createRequest(spoofedAddress),
        now,
        database,
      });
    }

    expect(database.rows.size).toBe(2);
    expect(JSON.stringify(database.queries)).not.toContain("203.0.113.");
  });

  it("trusts Vercel's protected forwarding header instead of a conflicting X-Forwarded-For value", async () => {
    const previousVercel = process.env.VERCEL;
    process.env.VERCEL = "1";
    const database = new FakeRateLimitDatabase();
    const now = Date.UTC(2026, 6, 8, 12, 52, 0);
    try {
      for (const vercelAddress of ["198.51.100.10", "198.51.100.11"]) {
        await recordAaisLoginFailure({
          accountId: "vercel-client@example.test",
          request: new Request("https://aais.example.test/api/auth/app-session", {
            headers: {
              "x-forwarded-for": "203.0.113.250",
              "x-vercel-forwarded-for": vercelAddress,
            },
          }),
          now,
          database,
        });
      }
      expect(database.rows.size).toBe(5);
      expect(JSON.stringify(database.queries)).not.toContain("203.0.113.250");
      expect(JSON.stringify(database.queries)).not.toContain("198.51.100.");
    } finally {
      if (previousVercel === undefined) {
        delete process.env.VERCEL;
      } else {
        process.env.VERCEL = previousVercel;
      }
    }
  });

  it("does not turn an unattributed password-reset client into one global denial key", async () => {
    const database = new FakeRateLimitDatabase();
    const now = Date.UTC(2026, 6, 8, 12, 53, 0);

    for (let attempt = 0; attempt < 11; attempt += 1) {
      await expect(recordAaisPasswordResetRequest({
        accountId: `unattributed-${attempt}@example.test`,
        request: createRequest(`203.0.113.${attempt + 1}`),
        now,
        database,
      })).resolves.toEqual({ status: "allowed" });
    }
  });

  it("clears every per-client login failure for an account after successful authentication", async () => {
    process.env.AAIS_TRUSTED_PROXY_IP_HEADER = "x-forwarded-for";
    const database = new FakeRateLimitDatabase();
    const now = Date.UTC(2026, 6, 8, 12, 55, 0);
    const accountId = "recovered-account@example.test";

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const request = createRequest(`198.51.100.${attempt + 1}`);
      await recordAaisLoginFailure({ accountId, request, now, database: null });
      await recordAaisLoginFailure({ accountId, request, now, database });
    }
    const successRequest = createRequest("198.51.100.250");
    await clearAaisLoginFailures({ accountId, request: successRequest, database: null });
    await clearAaisLoginFailures({ accountId, request: successRequest, database });

    for (const request of [createRequest("198.51.100.1"), successRequest]) {
      await expect(checkAaisLoginRateLimit({
        accountId,
        request,
        now,
        database: null,
      })).resolves.toEqual({ status: "allowed" });
      await expect(checkAaisLoginRateLimit({
        accountId,
        request,
        now,
        database,
      })).resolves.toEqual({ status: "allowed" });
    }
    expect(database.rows.size).toBe(6);
  });

  it("releases each successful client-global admission while preserving unrelated failures", async () => {
    process.env.AAIS_TRUSTED_PROXY_IP_HEADER = "x-forwarded-for";
    process.env.AAIS_LOGIN_RATE_LIMIT_MAX_FAILURES = "100";
    process.env.AAIS_LOGIN_RATE_LIMIT_CLIENT_MAX_ATTEMPTS = "3";
    const now = Date.now();
    const request = createRequest("203.0.113.191");

    for (const database of [null, new FakeRateLimitDatabase()] as const) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(admitAaisLoginAttempt({
          accountId: `persistent-failure-${attempt}`,
          request,
          now,
          database,
        })).resolves.toEqual({ status: "allowed" });
      }

      for (let run = 0; run < 2; run += 1) {
        for (let account = 0; account < 42; account += 1) {
          const accountId = `successful-${run}-${account}`;
          await expect(admitAaisLoginAttempt({
            accountId,
            request,
            now,
            database,
          })).resolves.toEqual({ status: "allowed" });
          await clearAaisLoginFailures({ accountId, request, database });
        }
      }

      await expect(admitAaisLoginAttempt({
        accountId: "persistent-failure-2",
        request,
        now,
        database,
      })).resolves.toEqual({ status: "allowed" });
      await expect(admitAaisLoginAttempt({
        accountId: "persistent-failure-3",
        request,
        now,
        database,
      })).resolves.toEqual({ status: "blocked", retryAfterSeconds: 900 });
    }
  });

  it("supports bounded env-configured lockout thresholds", async () => {
    const request = createRequest("203.0.113.99");
    const now = Date.UTC(2026, 6, 8, 12, 0, 0);
    const env = {
      AAIS_LOGIN_RATE_LIMIT_MAX_FAILURES: "2",
      AAIS_LOGIN_RATE_LIMIT_WINDOW_SECONDS: "60",
      AAIS_LOGIN_RATE_LIMIT_LOCK_SECONDS: "30",
    };

    expect(readAaisLoginRateLimitConfig(env)).toEqual({
      maxFailures: 2,
      maxClientAttempts: 50,
      windowMs: 60_000,
      lockMs: 30_000,
    });
    process.env.AAIS_LOGIN_RATE_LIMIT_MAX_FAILURES = "2";
    process.env.AAIS_LOGIN_RATE_LIMIT_WINDOW_SECONDS = "60";
    process.env.AAIS_LOGIN_RATE_LIMIT_LOCK_SECONDS = "30";
    try {
      await expect(recordAaisLoginFailure({
        accountId: "configured-lockout",
        request,
        now,
        database: null,
      })).resolves.toEqual({ status: "allowed" });
      await expect(recordAaisLoginFailure({
        accountId: "configured-lockout",
        request,
        now,
        database: null,
      })).resolves.toEqual({ status: "allowed" });
      await expect(recordAaisLoginFailure({
        accountId: "configured-lockout",
        request,
        now,
        database: null,
      })).resolves.toEqual({
        status: "blocked",
        retryAfterSeconds: 30,
      });
    } finally {
      delete process.env.AAIS_LOGIN_RATE_LIMIT_MAX_FAILURES;
      delete process.env.AAIS_LOGIN_RATE_LIMIT_WINDOW_SECONDS;
      delete process.env.AAIS_LOGIN_RATE_LIMIT_LOCK_SECONDS;
    }
  });

  it("blocks rotating random accounts with an attributed client-global admission bucket", async () => {
    process.env.AAIS_TRUSTED_PROXY_IP_HEADER = "x-forwarded-for";
    process.env.AAIS_LOGIN_RATE_LIMIT_MAX_FAILURES = "100";
    process.env.AAIS_LOGIN_RATE_LIMIT_CLIENT_MAX_ATTEMPTS = "2";
    const now = Date.UTC(2026, 6, 8, 12, 41, 0);
    const request = createRequest("203.0.113.190");

    const durableDatabase = new FakeRateLimitDatabase();
    for (const database of [null, durableDatabase] as const) {
      await expect(admitAaisLoginAttempt({
        accountId: "random-u1",
        request,
        now,
        database,
      })).resolves.toEqual({ status: "allowed" });
      await expect(admitAaisLoginAttempt({
        accountId: "random-u2",
        request,
        now,
        database,
      })).resolves.toEqual({ status: "allowed" });
      await expect(admitAaisLoginAttempt({
        accountId: "random-u3",
        request,
        now,
        database,
      })).resolves.toEqual({ status: "blocked", retryAfterSeconds: 900 });
    }
    expect(durableDatabase.rows.size).toBe(5);
    expect(durableDatabase.queries.at(-1)?.sql).toContain(
      "delete from aais_login_rate_limits",
    );
    expect(durableDatabase.queries.at(-1)?.sql).toContain("expires_at");
    expect(durableDatabase.queries.at(-1)?.sql).toMatch(/limit \$\d+/i);
  });

  it("does not collapse unattributed login clients into one global denial bucket", async () => {
    process.env.AAIS_LOGIN_RATE_LIMIT_MAX_FAILURES = "100";
    process.env.AAIS_LOGIN_RATE_LIMIT_CLIENT_MAX_ATTEMPTS = "1";
    const now = Date.UTC(2026, 6, 8, 12, 42, 0);
    const database = new FakeRateLimitDatabase();

    await expect(admitAaisLoginAttempt({
      accountId: "unattributed-u1",
      request: createRequest("203.0.113.201"),
      now,
      database,
    })).resolves.toEqual({ status: "allowed" });
    await expect(admitAaisLoginAttempt({
      accountId: "unattributed-u2",
      request: createRequest("203.0.113.202"),
      now,
      database,
    })).resolves.toEqual({ status: "allowed" });

    expect(database.rows.size).toBe(4);
    expect(database.queries.every(({ params }) => params.length === 13 && params[3] === null)).toBe(true);
  });

  it("bounds the attributed client-global admission threshold", () => {
    expect(readAaisLoginRateLimitConfig({
      AAIS_LOGIN_RATE_LIMIT_CLIENT_MAX_ATTEMPTS: "999999",
    }).maxClientAttempts).toBe(10_000);
  });

  it("limits password-reset requests independently by normalized account and client", async () => {
    const database = new FakeRateLimitDatabase();
    const now = Date.UTC(2026, 6, 8, 13, 0, 0);
    process.env.AAIS_PASSWORD_RESET_ACCOUNT_MAX_REQUESTS = "2";
    process.env.AAIS_PASSWORD_RESET_CLIENT_MAX_REQUESTS = "2";
    process.env.AAIS_PASSWORD_RESET_WINDOW_SECONDS = "60";
    process.env.AAIS_PASSWORD_RESET_LOCK_SECONDS = "60";
    process.env.AAIS_TRUSTED_PROXY_IP_HEADER = "x-forwarded-for";
    try {
      await expect(recordAaisPasswordResetRequest({
        accountId: "Learner@Example.TEST",
        request: createRequest("203.0.113.10"),
        now,
        database,
      })).resolves.toEqual({ status: "allowed" });
      await expect(recordAaisPasswordResetRequest({
        accountId: "learner@example.test",
        request: createRequest("203.0.113.11"),
        now,
        database,
      })).resolves.toEqual({ status: "allowed" });
      await expect(recordAaisPasswordResetRequest({
        accountId: "LEARNER@example.test",
        request: createRequest("203.0.113.12"),
        now,
        database,
      })).resolves.toEqual({
        status: "blocked",
        retryAfterSeconds: 60,
      });
      const clientDatabase = new FakeRateLimitDatabase();
      const sharedClient = createRequest("198.51.100.55");
      for (const accountId of ["one@example.test", "two@example.test"]) {
        await expect(recordAaisPasswordResetRequest({
          accountId,
          request: sharedClient,
          now,
          database: clientDatabase,
        })).resolves.toEqual({ status: "allowed" });
      }
      await expect(recordAaisPasswordResetRequest({
        accountId: "three@example.test",
        request: sharedClient,
        now,
        database: clientDatabase,
      })).resolves.toEqual({
        status: "blocked",
        retryAfterSeconds: 60,
      });
      expect(clientDatabase.rows.size).toBe(3);

      const serializedQueries = JSON.stringify([...database.queries, ...clientDatabase.queries]);
      expect(serializedQueries).not.toContain("learner@example.test");
      expect(serializedQueries).not.toContain("198.51.100.55");
      expect(serializedQueries).not.toContain("203.0.113.10");
      expect([...database.queries, ...clientDatabase.queries].every((query) =>
        query.sql.toLowerCase().includes("insert into aais_login_rate_limits")
      )).toBe(true);
    } finally {
      delete process.env.AAIS_PASSWORD_RESET_ACCOUNT_MAX_REQUESTS;
      delete process.env.AAIS_PASSWORD_RESET_CLIENT_MAX_REQUESTS;
      delete process.env.AAIS_PASSWORD_RESET_WINDOW_SECONDS;
      delete process.env.AAIS_PASSWORD_RESET_LOCK_SECONDS;
    }
  });

  it("keeps password-reset abuse-control configuration within safe bounds", () => {
    expect(readAaisPasswordResetRateLimitConfig({
      AAIS_PASSWORD_RESET_ACCOUNT_MAX_REQUESTS: "0",
      AAIS_PASSWORD_RESET_CLIENT_MAX_REQUESTS: "99999",
      AAIS_PASSWORD_RESET_WINDOW_SECONDS: "1",
      AAIS_PASSWORD_RESET_LOCK_SECONDS: "999999",
    })).toEqual({
      accountMaxRequests: 1,
      clientMaxRequests: 1_000,
      windowMs: 60_000,
      lockMs: 86_400_000,
    });
  });

  it("atomically limits set-password work by token and trusted client without storing either raw value", async () => {
    process.env.AAIS_TRUSTED_PROXY_IP_HEADER = "x-forwarded-for";
    process.env.AAIS_SET_PASSWORD_TOKEN_MAX_REQUESTS = "1";
    process.env.AAIS_SET_PASSWORD_CLIENT_MAX_REQUESTS = "2";
    process.env.AAIS_SET_PASSWORD_WINDOW_SECONDS = "60";
    process.env.AAIS_SET_PASSWORD_LOCK_SECONDS = "60";
    const now = Date.UTC(2026, 6, 8, 14, 0, 0);
    const database = new FakeRateLimitDatabase();
    const token = `aais_reset_${"sensitive-token".repeat(3)}`;

    await expect(recordAaisSetPasswordRequest({
      token,
      request: createRequest("203.0.113.20"),
      now,
      database,
    })).resolves.toEqual({ status: "allowed" });
    await expect(recordAaisSetPasswordRequest({
      token,
      request: createRequest("203.0.113.21"),
      now,
      database,
    })).resolves.toEqual({ status: "blocked", retryAfterSeconds: 60 });
    const sharedClientDatabase = new FakeRateLimitDatabase();
    const sharedClient = createRequest("198.51.100.77");
    for (const suffix of ["a", "b"]) {
      await expect(recordAaisSetPasswordRequest({
        token: `aais_reset_${suffix.repeat(43)}`,
        request: sharedClient,
        now,
        database: sharedClientDatabase,
      })).resolves.toEqual({ status: "allowed" });
    }
    await expect(recordAaisSetPasswordRequest({
      token: `aais_reset_${"c".repeat(43)}`,
      request: sharedClient,
      now,
      database: sharedClientDatabase,
    })).resolves.toEqual({ status: "blocked", retryAfterSeconds: 60 });
    expect(sharedClientDatabase.rows.size).toBe(3);

    const queries = [...database.queries, ...sharedClientDatabase.queries];
    expect(queries.every(({ sql }) =>
      sql.toLowerCase().includes("insert into aais_login_rate_limits")
    )).toBe(true);
    expect(JSON.stringify(queries)).not.toContain(token);
    expect(JSON.stringify(queries)).not.toContain("203.0.113.20");
    expect(JSON.stringify(queries)).not.toContain("198.51.100.77");
  });

  it("bounds set-password limiter configuration", () => {
    expect(readAaisSetPasswordRateLimitConfig({
      AAIS_SET_PASSWORD_TOKEN_MAX_REQUESTS: "0",
      AAIS_SET_PASSWORD_CLIENT_MAX_REQUESTS: "99999",
      AAIS_SET_PASSWORD_WINDOW_SECONDS: "1",
      AAIS_SET_PASSWORD_LOCK_SECONDS: "999999",
    })).toEqual({
      tokenMaxRequests: 1,
      clientMaxRequests: 1_000,
      windowMs: 10_000,
      lockMs: 86_400_000,
    });
  });
});

function createRequest(clientIp: string) {
  return new Request("http://localhost/api/auth/app-session", {
    headers: {
      "x-forwarded-for": clientIp,
    },
  });
}

class FakeRateLimitDatabase {
  rows = new Map<string, {
    account_key: string;
    client_key: string;
    failures: number;
    first_failure_at: Date;
    locked_until: Date | null;
    expires_at: Date;
  }>();

  queries: Array<{
    sql: string;
    params: unknown[];
  }> = [];

  async query(sql: string, params: unknown[] = []) {
    this.queries.push({ sql, params });
    const normalized = sql.trim().toLowerCase();
    if (normalized.startsWith("select locked_until")) {
      const keys = Array.isArray(params[0]) ? params[0].map(String) : [String(params[0] ?? "")];
      const now = params[1] instanceof Date
        ? params[1].getTime()
        : Number.NEGATIVE_INFINITY;
      return {
        rows: keys.flatMap((key) => {
          const row = this.rows.get(key);
          return row && row.expires_at.getTime() > now
            ? [{ locked_until: row.locked_until }]
            : [];
        }),
      };
    }
    if (normalized.startsWith("with expired_rate_limits as")) {
      const now = (params[0] as Date).getTime();
      const protectedKeys = new Set((params[1] as unknown[]).map(String));
      const cleanupLimit = Number(params[2]);
      const expiredKeys = [...this.rows.entries()]
        .filter(([key, row]) =>
          !protectedKeys.has(key) && row.expires_at.getTime() <= now)
        .sort((left, right) =>
          left[1].expires_at.getTime() - right[1].expires_at.getTime()
          || left[0].localeCompare(right[0]))
        .slice(0, cleanupLimit)
        .map(([key]) => key);
      for (const key of expiredKeys) {
        this.rows.delete(key);
      }

      const windowMs = Number(params[11]);
      const lockMs = Number(params[12]);
      const expiresAt = now + Math.max(windowMs, lockMs);
      const lockedUntil = [] as Array<Date | null>;
      const gateKey = params[3] === null ? null : String(params[3]);
      if (gateKey) {
        lockedUntil.push(this.recordRequest(
          gateKey,
          String(params[4]),
          now,
          windowMs,
          Number(params[6]),
          lockMs,
          String(params[5]),
          expiresAt,
        ));
      }
      const gateBlocked = lockedUntil.some((value) =>
        value !== null && value.getTime() > now);
      if (!gateBlocked) {
        const detailKeys = (params[7] as unknown[]).map(String);
        const accountKeys = (params[8] as unknown[]).map(String);
        const clientKeys = (params[9] as unknown[]).map(String);
        for (const [index, key] of detailKeys.entries()) {
          lockedUntil.push(this.recordRequest(
            key,
            accountKeys[index] ?? "",
            now,
            windowMs,
            Number(params[10]),
            lockMs,
            clientKeys[index] ?? "",
            expiresAt,
          ));
        }
      }
      return { rows: lockedUntil.map((value) => ({ locked_until: value })) };
    }
    if (normalized.startsWith("with released_client_global as")) {
      const accountKey = String(params[0] ?? "");
      const clientGlobalKey = params[1] === null ? null : String(params[1]);
      const maxClientAttempts = Number(params[2]);
      if (clientGlobalKey) {
        const row = this.rows.get(clientGlobalKey);
        if (row) {
          row.failures = Math.max(row.failures - 1, 0);
          if (row.failures <= maxClientAttempts) {
            row.locked_until = null;
          }
        }
      }
      for (const [key, row] of this.rows) {
        if (row.account_key === accountKey) {
          this.rows.delete(key);
        }
      }
      return { rows: [] };
    }
    if (normalized.startsWith("insert into aais_login_rate_limits")) {
      if (params.length === 11) {
        const now = (params[6] as Date).getTime();
        const windowMs = Number(params[7]);
        const accountMaxRequests = Number(params[8]);
        const clientMaxRequests = Number(params[9]);
        const lockMs = Number(params[10]);
        const lockedUntil = [
          this.recordRequest(
            String(params[0]),
            String(params[1]),
            now,
            windowMs,
            accountMaxRequests,
            lockMs,
          ),
          this.recordRequest(
            String(params[3]),
            String(params[1]),
            now,
            windowMs,
            accountMaxRequests,
            lockMs,
          ),
          ...(params[4] === null
            ? []
            : [this.recordRequest(
                String(params[4]),
                String(params[5]),
                now,
                windowMs,
                clientMaxRequests,
                lockMs,
              )]),
        ];
        return { rows: lockedUntil.map((value) => ({ locked_until: value })) };
      }
      if (params.length === 10) {
        const now = (params[5] as Date).getTime();
        const windowMs = Number(params[6]);
        const accountMaxRequests = Number(params[7]);
        const clientMaxRequests = Number(params[8]);
        const lockMs = Number(params[9]);
        const lockedUntil = [
          this.recordRequest(
            String(params[0]),
            String(params[1]),
            now,
            windowMs,
            accountMaxRequests,
            lockMs,
          ),
          this.recordRequest(
            String(params[3]),
            String(params[4]),
            now,
            windowMs,
            clientMaxRequests,
            lockMs,
          ),
        ];
        return { rows: lockedUntil.map((value) => ({ locked_until: value })) };
      }
      const now = (params[4] as Date).getTime();
      const windowMs = Number(params[5]);
      const maxFailures = Number(params[6]);
      const lockMs = Number(params[7]);
      const lockedUntil = [
        this.recordRequest(
          String(params[0]),
          String(params[1]),
          now,
          windowMs,
          maxFailures,
          lockMs,
        ),
        this.recordRequest(
          String(params[3]),
          String(params[1]),
          now,
          windowMs,
          maxFailures,
          lockMs,
        ),
      ];
      return { rows: lockedUntil.map((value) => ({ locked_until: value })) };
    }
    if (normalized.startsWith("delete from aais_login_rate_limits")) {
      const accountKey = String(params[0] ?? "");
      for (const [key, row] of this.rows) {
        if (row.account_key === accountKey) {
          this.rows.delete(key);
        }
      }
    }
    return { rows: [] };
  }

  private recordRequest(
    key: string,
    accountKey: string,
    now: number,
    windowMs: number,
    maxRequests: number,
    lockMs: number,
    clientKey = "",
    expiresAt = now + Math.max(windowMs, lockMs),
  ) {
    const existing = this.rows.get(key);
    if (existing?.locked_until && existing.locked_until.getTime() > now) {
      return existing.locked_until;
    }
    const inWindow = existing
      ? now - existing.first_failure_at.getTime() < windowMs
      : false;
    const failures = existing && inWindow ? existing.failures + 1 : 1;
    const firstFailureAt = existing && inWindow
      ? existing.first_failure_at
      : new Date(now);
    const lockedUntil = failures > maxRequests ? new Date(now + lockMs) : null;
    this.rows.set(key, {
      account_key: accountKey,
      client_key: clientKey,
      failures,
      first_failure_at: firstFailureAt,
      locked_until: lockedUntil,
      expires_at: new Date(expiresAt),
    });
    return lockedUntil;
  }
}
