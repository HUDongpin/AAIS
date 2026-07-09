import { describe, expect, it } from "vitest";
import {
  checkAaisLoginRateLimit,
  clearAaisLoginFailures,
  readAaisLoginRateLimitConfig,
  recordAaisLoginFailure,
} from "@/lib/server/aais-auth-rate-limit";

describe("AAIS login rate limiting", () => {
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
    expect(database.rows.size).toBe(1);
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
    failures: number;
    first_failure_at: Date;
    locked_until: Date | null;
  }>();

  queries: Array<{
    sql: string;
    params: unknown[];
  }> = [];

  async query(sql: string, params: unknown[] = []) {
    this.queries.push({ sql, params });
    const normalized = sql.trim().toLowerCase();
    const key = String(params[0] ?? "");
    if (normalized.startsWith("select locked_until")) {
      const row = this.rows.get(key);
      return {
        rows: row ? [{ locked_until: row.locked_until }] : [],
      };
    }
    if (normalized.startsWith("select failures")) {
      const row = this.rows.get(key);
      return {
        rows: row ? [row] : [],
      };
    }
    if (normalized.startsWith("insert into aais_login_rate_limits")) {
      this.rows.set(key, {
        failures: Number(params[3]),
        first_failure_at: params[4] as Date,
        locked_until: params[5] as Date | null,
      });
    }
    if (normalized.startsWith("update aais_login_rate_limits")) {
      this.rows.set(key, {
        failures: Number(params[1]),
        first_failure_at: params[2] as Date,
        locked_until: params[3] as Date | null,
      });
    }
    if (normalized.startsWith("delete from aais_login_rate_limits")) {
      this.rows.delete(key);
    }
    return { rows: [] };
  }
}
