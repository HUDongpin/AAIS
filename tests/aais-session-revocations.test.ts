import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAaisSessionToken,
  verifyAaisSessionTokenWithMetadata,
} from "@/lib/server/aais-session";
import {
  AaisSessionRevocationConfigurationError,
  clearAaisSessionRevocationsForTest,
  isAaisSessionTokenRevoked,
  revokeAaisSessionToken,
} from "@/lib/server/aais-session-revocations";

afterEach(() => {
  clearAaisSessionRevocationsForTest();
  vi.unstubAllEnvs();
});

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

  it("keeps the development memory fallback explicitly process-local across module instances", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL_ENV", "preview");
    const { verified, now } = createVerifiedToken();
    const firstWorker = await import("@/lib/server/aais-session-revocations");
    firstWorker.clearAaisSessionRevocationsForTest();

    await firstWorker.revokeAaisSessionToken({
      tokenHash: verified.tokenHash,
      actorId: verified.actor.id,
      expiresAt: verified.expiresAt,
      now,
      database: null,
    });
    await expect(firstWorker.isAaisSessionTokenRevoked({
      tokenHash: verified.tokenHash,
      now,
      database: null,
    })).resolves.toBe(true);

    vi.resetModules();
    const secondWorker = await import("@/lib/server/aais-session-revocations");
    await expect(secondWorker.isAaisSessionTokenRevoked({
      tokenHash: verified.tokenHash,
      now,
      database: null,
    })).resolves.toBe(false);
    secondWorker.clearAaisSessionRevocationsForTest();
  });

  it("allows an explicitly non-production Vercel Preview to use stateless revocations", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("AAIS_SESSION_SECRET", "preview-test-session-secret-with-32-bytes");
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
    });
  });

  it("refuses process-local revocation reads and writes in production", async () => {
    const { verified, now } = createVerifiedToken();
    vi.stubEnv("NODE_ENV", "production");

    await expect(isAaisSessionTokenRevoked({
      tokenHash: verified.tokenHash,
      now,
      database: null,
    })).rejects.toBeInstanceOf(AaisSessionRevocationConfigurationError);
    await expect(revokeAaisSessionToken({
      tokenHash: verified.tokenHash,
      actorId: verified.actor.id,
      expiresAt: verified.expiresAt,
      now,
      database: null,
    })).rejects.toBeInstanceOf(AaisSessionRevocationConfigurationError);
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
  const now = new Date(Date.UTC(2026, 6, 9, 12, 1, 0));
  const token = createAaisSessionToken(
    {
      id: "S001",
      role: "student",
      displayName: "Student",
    },
    new Date(Date.UTC(2026, 6, 9, 12, 0, 0)),
  );
  const verified = verifyAaisSessionTokenWithMetadata(
    token,
    now,
  );
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
