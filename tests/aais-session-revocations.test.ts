import { describe, expect, it } from "vitest";
import {
  createAaisSessionToken,
  verifyAaisSessionTokenWithMetadata,
} from "@/lib/server/aais-session";
import {
  clearAaisSessionRevocationsForTest,
  isAaisSessionTokenRevoked,
  revokeAaisSessionToken,
} from "@/lib/server/aais-session-revocations";

describe("AAIS session revocations", () => {
  it("revokes tokens with the local memory fallback", async () => {
    clearAaisSessionRevocationsForTest();
    const { verified, now } = createVerifiedToken();

    await expect(isAaisSessionTokenRevoked({
      tokenHash: verified.tokenHash,
      now,
      database: null,
    })).resolves.toBe(false);

    await expect(revokeAaisSessionToken({
      tokenHash: verified.tokenHash,
      actorId: verified.actor.id,
      expiresAt: verified.expiresAt,
      now,
      database: null,
    })).resolves.toMatchObject({
      status: "revoked",
      storageMode: "memory",
      secrets: "redacted",
    });

    await expect(isAaisSessionTokenRevoked({
      tokenHash: verified.tokenHash,
      now,
      database: null,
    })).resolves.toBe(true);
  });

  it("persists revocations in Postgres without storing raw tokens or actor ids", async () => {
    const database = new FakeSessionRevocationDatabase();
    const { token, verified, now } = createVerifiedToken();

    await expect(isAaisSessionTokenRevoked({
      tokenHash: verified.tokenHash,
      now,
      database,
    })).resolves.toBe(false);
    await revokeAaisSessionToken({
      tokenHash: verified.tokenHash,
      actorId: verified.actor.id,
      expiresAt: verified.expiresAt,
      now,
      database,
    });

    await expect(isAaisSessionTokenRevoked({
      tokenHash: verified.tokenHash,
      now,
      database,
    })).resolves.toBe(true);
    expect(database.rows.get(verified.tokenHash)).toMatchObject({
      actor_key: expect.stringMatching(/^actor-[a-f0-9]{16}$/),
      expires_at: verified.expiresAt,
    });
    expect(JSON.stringify(database.queries)).not.toContain("S001");
    expect(JSON.stringify(database.queries)).not.toContain(token);
  });
});

function createVerifiedToken() {
  const issuedAt = new Date(Date.UTC(2026, 6, 9, 12, 0, 0));
  const now = new Date(Date.UTC(2026, 6, 9, 12, 1, 0));
  const token = createAaisSessionToken(
    {
      id: "S001",
      role: "student",
      displayName: "Student",
    },
    issuedAt,
  );
  const verified = verifyAaisSessionTokenWithMetadata(token, now);
  if (!verified) {
    throw new Error("Expected test AAIS session token to verify.");
  }
  return { token, verified, now };
}

class FakeSessionRevocationDatabase {
  rows = new Map<string, {
    actor_key: string;
    expires_at: Date;
    revoked_at: Date;
  }>();

  queries: Array<{
    sql: string;
    params: unknown[];
  }> = [];

  async query(sql: string, params: unknown[] = []) {
    this.queries.push({ sql, params });
    const normalized = sql.trim().toLowerCase();
    if (normalized.startsWith("select 1")) {
      const row = this.rows.get(String(params[0]));
      const now = params[1] instanceof Date ? params[1].getTime() : new Date(String(params[1])).getTime();
      return {
        rows: row && row.expires_at.getTime() > now ? [{ "?column?": 1 }] : [],
      };
    }
    if (normalized.startsWith("delete from aais_session_revocations")) {
      const now = params[0] instanceof Date ? params[0].getTime() : new Date(String(params[0])).getTime();
      for (const [tokenHash, row] of this.rows.entries()) {
        if (row.expires_at.getTime() <= now) {
          this.rows.delete(tokenHash);
        }
      }
    }
    if (normalized.startsWith("insert into aais_session_revocations")) {
      this.rows.set(String(params[0]), {
        actor_key: String(params[1]),
        expires_at: params[2] as Date,
        revoked_at: params[3] as Date,
      });
    }
    return { rows: [] };
  }
}
