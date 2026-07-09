import { describe, expect, it } from "vitest";
import { cleanupAaisRetentionRows } from "../scripts/cleanup-aais-retention.mjs";

describe("AAIS retention cleanup", () => {
  it("dry-runs expired security row cleanup without mutating tables", async () => {
    const database = new FakeRetentionDatabase();

    const report = await cleanupAaisRetentionRows({
      database,
      dryRun: true,
      now: new Date("2026-07-09T00:00:00.000Z"),
      loginRateLimitWindowSeconds: 900,
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "pass",
      dryRun: true,
      expiredRows: {
        authTokens: 1,
        sessionRevocations: 1,
        loginRateLimits: 2,
      },
      redaction: {
        rowIds: "omitted",
        accountKeys: "omitted",
        tokenHashes: "omitted",
        databaseUrl: "omitted",
      },
      secrets: "redacted",
    });
    expect(database.authTokens).toHaveLength(2);
    expect(database.sessionRevocations).toHaveLength(2);
    expect(database.loginRateLimits).toHaveLength(3);
    expect(database.writeQueries).toEqual([]);
  });

  it("deletes only expired short-lived security rows when approved", async () => {
    const database = new FakeRetentionDatabase();

    const report = await cleanupAaisRetentionRows({
      database,
      dryRun: false,
      now: new Date("2026-07-09T00:00:00.000Z"),
      loginRateLimitWindowSeconds: 900,
    });

    expect(report).toMatchObject({
      status: "pass",
      dryRun: false,
      expiredRows: {
        authTokens: 1,
        sessionRevocations: 1,
        loginRateLimits: 2,
      },
    });
    expect(database.authTokens.map((row) => row.id)).toEqual(["auth-active"]);
    expect(database.sessionRevocations.map((row) => row.token_hash)).toEqual(["token-active"]);
    expect(database.loginRateLimits.map((row) => row.rate_limit_key)).toEqual(["limit-active"]);
  });

  it("keeps reports free of raw ids, hashes, and account keys", async () => {
    const database = new FakeRetentionDatabase();

    const report = await cleanupAaisRetentionRows({
      database,
      dryRun: false,
      now: new Date("2026-07-09T00:00:00.000Z"),
      loginRateLimitWindowSeconds: 900,
    });
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain("auth-expired");
    expect(serialized).not.toContain("token-expired");
    expect(serialized).not.toContain("limit-window-expired");
    expect(serialized).not.toContain("account-secret");
    expect(serialized).not.toContain("client-secret");
  });
});

class FakeRetentionDatabase {
  constructor() {
    this.authTokens = [
      {
        id: "auth-expired",
        expires_at: new Date("2026-07-08T23:59:00.000Z"),
      },
      {
        id: "auth-active",
        expires_at: new Date("2026-07-09T00:01:00.000Z"),
      },
    ];
    this.sessionRevocations = [
      {
        token_hash: "token-expired",
        expires_at: new Date("2026-07-08T23:59:00.000Z"),
      },
      {
        token_hash: "token-active",
        expires_at: new Date("2026-07-09T00:01:00.000Z"),
      },
    ];
    this.loginRateLimits = [
      {
        rate_limit_key: "limit-window-expired",
        account_key: "account-secret",
        client_key: "client-secret",
        first_failure_at: new Date("2026-07-08T23:40:00.000Z"),
        locked_until: null,
      },
      {
        rate_limit_key: "limit-lock-expired",
        account_key: "account-secret",
        client_key: "client-secret",
        first_failure_at: new Date("2026-07-08T23:50:00.000Z"),
        locked_until: new Date("2026-07-08T23:59:00.000Z"),
      },
      {
        rate_limit_key: "limit-active",
        account_key: "account-secret",
        client_key: "client-secret",
        first_failure_at: new Date("2026-07-08T23:59:00.000Z"),
        locked_until: null,
      },
    ];
    this.writeQueries = [];
  }

  async query(sql, params = []) {
    const normalized = sql.toLowerCase();
    const now = params[0] instanceof Date ? params[0] : new Date(String(params[0]));
    const loginWindowSeconds = Number(params[1] ?? 900);
    if (normalized.includes("from aais_user_auth_tokens")) {
      const matches = this.authTokens.filter((row) => row.expires_at <= now);
      if (normalized.includes("delete from aais_user_auth_tokens")) {
        this.writeQueries.push({ sql, params });
        this.authTokens = this.authTokens.filter((row) => row.expires_at > now);
      }
      return { rows: [{ count: matches.length }] };
    }
    if (normalized.includes("from aais_session_revocations")) {
      const matches = this.sessionRevocations.filter((row) => row.expires_at <= now);
      if (normalized.includes("delete from aais_session_revocations")) {
        this.writeQueries.push({ sql, params });
        this.sessionRevocations = this.sessionRevocations.filter((row) => row.expires_at > now);
      }
      return { rows: [{ count: matches.length }] };
    }
    if (normalized.includes("from aais_login_rate_limits")) {
      const matches = this.loginRateLimits.filter((row) =>
        isExpiredRateLimit(row, now, loginWindowSeconds)
      );
      if (normalized.includes("delete from aais_login_rate_limits")) {
        this.writeQueries.push({ sql, params });
        this.loginRateLimits = this.loginRateLimits.filter((row) =>
          !isExpiredRateLimit(row, now, loginWindowSeconds)
        );
      }
      return { rows: [{ count: matches.length }] };
    }
    throw new Error(`Unexpected retention cleanup SQL: ${sql}`);
  }
}

function isExpiredRateLimit(row, now, loginWindowSeconds) {
  if (row.locked_until) {
    return row.locked_until <= now;
  }
  return row.first_failure_at.getTime() + loginWindowSeconds * 1000 <= now.getTime();
}
