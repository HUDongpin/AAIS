import { createHash } from "node:crypto";
import { Pool } from "pg";
import {
  getAaisDatabaseConfiguration,
  type AaisDatabaseClient,
} from "@/lib/server/aais-learning-store";

type MemoryRevocation = {
  actorId: string;
  expiresAt: number;
  revokedAt: number;
};

const memoryRevocations = new Map<string, MemoryRevocation>();

let cachedDatabase:
  | {
      url: string;
      client: AaisDatabaseClient;
    }
  | undefined;

export async function revokeAaisSessionToken(input: {
  tokenHash: string;
  actorId: string;
  expiresAt: Date;
  now?: Date;
  database?: AaisDatabaseClient | null;
}) {
  const now = input.now ?? new Date();
  const database = resolveSessionRevocationDatabase(input.database);
  if (database) {
    await revokeDatabaseSessionToken({ ...input, now, database });
    return {
      status: "revoked" as const,
      storageMode: "postgres" as const,
      secrets: "redacted" as const,
    };
  }
  cleanupMemoryRevocations(now.getTime());
  memoryRevocations.set(input.tokenHash, {
    actorId: input.actorId,
    expiresAt: input.expiresAt.getTime(),
    revokedAt: now.getTime(),
  });
  return {
    status: "revoked" as const,
    storageMode: "memory" as const,
    secrets: "redacted" as const,
  };
}

export async function isAaisSessionTokenRevoked(input: {
  tokenHash: string;
  now?: Date;
  database?: AaisDatabaseClient | null;
}) {
  const now = input.now ?? new Date();
  const database = resolveSessionRevocationDatabase(input.database);
  if (database) {
    const result = await database.query(
      `select 1
         from aais_session_revocations
        where token_hash = $1
          and expires_at > $2::timestamptz
        limit 1`,
      [input.tokenHash, now],
    );
    return result.rows.length > 0;
  }
  cleanupMemoryRevocations(now.getTime());
  const revocation = memoryRevocations.get(input.tokenHash);
  return Boolean(revocation && revocation.expiresAt > now.getTime());
}

export function clearAaisSessionRevocationsForTest() {
  memoryRevocations.clear();
  cachedDatabase = undefined;
}

async function revokeDatabaseSessionToken(input: {
  tokenHash: string;
  actorId: string;
  expiresAt: Date;
  now: Date;
  database: AaisDatabaseClient;
}) {
  await input.database.query(
    `delete from aais_session_revocations
      where expires_at <= $1::timestamptz`,
    [input.now],
  );
  await input.database.query(
    `insert into aais_session_revocations (
       token_hash,
       actor_key,
       expires_at,
       revoked_at
     )
     values ($1, $2, $3::timestamptz, $4::timestamptz)
     on conflict (token_hash)
     do update set
       actor_key = excluded.actor_key,
       expires_at = excluded.expires_at,
       revoked_at = excluded.revoked_at`,
    [
      input.tokenHash,
      createActorKey(input.actorId),
      input.expiresAt,
      input.now,
    ],
  );
}

function cleanupMemoryRevocations(now: number) {
  for (const [tokenHash, revocation] of memoryRevocations.entries()) {
    if (revocation.expiresAt <= now) {
      memoryRevocations.delete(tokenHash);
    }
  }
}

function resolveSessionRevocationDatabase(database: AaisDatabaseClient | null | undefined) {
  if (database !== undefined) {
    return database ?? undefined;
  }
  const config = getAaisDatabaseConfiguration();
  if (!config) {
    return undefined;
  }
  if (!cachedDatabase || cachedDatabase.url !== config.url) {
    cachedDatabase = {
      url: config.url,
      client: new Pool({ connectionString: config.url }) as AaisDatabaseClient,
    };
  }
  return cachedDatabase.client;
}

function createActorKey(actorId: string) {
  return `actor-${createHash("sha256")
    .update(`aais-session-revocation:${actorId}`)
    .digest("hex")
    .slice(0, 16)}`;
}
