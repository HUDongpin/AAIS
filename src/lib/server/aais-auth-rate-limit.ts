import { createHash } from "node:crypto";
import { Pool } from "pg";
import {
  getAaisDatabaseConfiguration,
  type AaisDatabaseClient,
} from "@/lib/server/aais-learning-store";

type AaisLoginRateLimitRecord = {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number | null;
};

const defaultMaxFailures = 5;
const defaultWindowMs = 15 * 60 * 1000;
const defaultLockMs = 15 * 60 * 1000;
const attempts = new Map<string, AaisLoginRateLimitRecord>();

let cachedDatabase:
  | {
      url: string;
      client: AaisDatabaseClient;
    }
  | undefined;

export type AaisLoginRateLimitResult =
  | {
      status: "allowed";
    }
  | {
      status: "blocked";
      retryAfterSeconds: number;
    };

export function checkAaisLoginRateLimit(input: {
  accountId: string;
  request: Request;
  now?: number;
  database?: AaisDatabaseClient | null;
}): Promise<AaisLoginRateLimitResult> {
  const database = resolveRateLimitDatabase(input.database);
  if (database) {
    return checkDatabaseLoginRateLimit({ ...input, database });
  }
  return Promise.resolve(checkMemoryLoginRateLimit(input));
}

export function recordAaisLoginFailure(input: {
  accountId: string;
  request: Request;
  now?: number;
  database?: AaisDatabaseClient | null;
}): Promise<AaisLoginRateLimitResult> {
  const database = resolveRateLimitDatabase(input.database);
  if (database) {
    return recordDatabaseLoginFailure({ ...input, database });
  }
  return Promise.resolve(recordMemoryLoginFailure(input));
}

export async function clearAaisLoginFailures(input: {
  accountId: string;
  request: Request;
  database?: AaisDatabaseClient | null;
}) {
  const database = resolveRateLimitDatabase(input.database);
  if (database) {
    await database.query(
      "delete from aais_login_rate_limits where rate_limit_key = $1",
      [createRateLimitKey(input.accountId, input.request)],
    );
    return;
  }
  attempts.delete(createRateLimitKey(input.accountId, input.request));
}

function checkMemoryLoginRateLimit(input: {
  accountId: string;
  request: Request;
  now?: number;
}): AaisLoginRateLimitResult {
  const now = input.now ?? Date.now();
  const record = attempts.get(createRateLimitKey(input.accountId, input.request));
  if (!record?.lockedUntil || record.lockedUntil <= now) {
    return {
      status: "allowed",
    };
  }
  return {
    status: "blocked",
    retryAfterSeconds: Math.max(1, Math.ceil((record.lockedUntil - now) / 1000)),
  };
}

function recordMemoryLoginFailure(input: {
  accountId: string;
  request: Request;
  now?: number;
}): AaisLoginRateLimitResult {
  const now = input.now ?? Date.now();
  const config = readAaisLoginRateLimitConfig();
  const key = createRateLimitKey(input.accountId, input.request);
  const existing = attempts.get(key);
  const record: AaisLoginRateLimitRecord =
    existing && now - existing.firstFailureAt < config.windowMs
      ? existing
      : {
          failures: 0,
          firstFailureAt: now,
          lockedUntil: null,
        };
  record.failures += 1;
  if (record.failures > config.maxFailures) {
    record.lockedUntil = now + config.lockMs;
  }
  attempts.set(key, record);
  return checkMemoryLoginRateLimit(input);
}

async function checkDatabaseLoginRateLimit(input: {
  accountId: string;
  request: Request;
  now?: number;
  database: AaisDatabaseClient;
}): Promise<AaisLoginRateLimitResult> {
  const now = input.now ?? Date.now();
  const result = await input.database.query(
    `select locked_until
       from aais_login_rate_limits
      where rate_limit_key = $1
      limit 1`,
    [createRateLimitKey(input.accountId, input.request)],
  );
  const lockedUntil = readTime(result.rows[0]?.locked_until);
  return createRateLimitResult(lockedUntil, now);
}

async function recordDatabaseLoginFailure(input: {
  accountId: string;
  request: Request;
  now?: number;
  database: AaisDatabaseClient;
}): Promise<AaisLoginRateLimitResult> {
  const now = input.now ?? Date.now();
  const config = readAaisLoginRateLimitConfig();
  const key = createRateLimitKey(input.accountId, input.request);
  const clientKey = hashRateLimitPart(getClientAddress(input.request));
  const accountKey = hashRateLimitPart(normalizeAccount(input.accountId));

  await input.database.query("begin");
  try {
    const result = await input.database.query(
      `select failures, first_failure_at, locked_until
         from aais_login_rate_limits
        where rate_limit_key = $1
        for update`,
      [key],
    );
    const existing = readRateLimitRecord(result.rows[0]);
    const inWindow = existing ? now - existing.firstFailureAt < config.windowMs : false;
    const failures = existing && inWindow ? existing.failures + 1 : 1;
    const firstFailureAt = inWindow && existing ? existing.firstFailureAt : now;
    const lockedUntil = failures > config.maxFailures ? now + config.lockMs : null;
    if (existing) {
      await input.database.query(
        `update aais_login_rate_limits
            set failures = $2,
                first_failure_at = $3,
                locked_until = $4,
                updated_at = $5
          where rate_limit_key = $1`,
        [
          key,
          failures,
          new Date(firstFailureAt),
          lockedUntil ? new Date(lockedUntil) : null,
          new Date(now),
        ],
      );
    } else {
      await input.database.query(
        `insert into aais_login_rate_limits (
            rate_limit_key,
            account_key,
            client_key,
            failures,
            first_failure_at,
            locked_until,
            updated_at
          ) values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          key,
          accountKey,
          clientKey,
          failures,
          new Date(firstFailureAt),
          lockedUntil ? new Date(lockedUntil) : null,
          new Date(now),
        ],
      );
    }
    await input.database.query("commit");
    return createRateLimitResult(lockedUntil, now);
  } catch (error) {
    await input.database.query("rollback").catch(() => undefined);
    throw error;
  }
}

function resolveRateLimitDatabase(database: AaisDatabaseClient | null | undefined) {
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

function readRateLimitRecord(row: Record<string, unknown> | undefined): AaisLoginRateLimitRecord | null {
  if (!row) {
    return null;
  }
  return {
    failures: Number(row.failures) || 0,
    firstFailureAt: readTime(row.first_failure_at) ?? 0,
    lockedUntil: readTime(row.locked_until),
  };
}

function createRateLimitResult(
  lockedUntil: number | null,
  now: number,
): AaisLoginRateLimitResult {
  if (!lockedUntil || lockedUntil <= now) {
    return {
      status: "allowed",
    };
  }
  return {
    status: "blocked",
    retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil - now) / 1000)),
  };
}

function readTime(value: unknown) {
  if (!value) {
    return null;
  }
  const time = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isFinite(time) ? time : null;
}

export function readAaisLoginRateLimitConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return {
    maxFailures: readBoundedInteger(env.AAIS_LOGIN_RATE_LIMIT_MAX_FAILURES, defaultMaxFailures, 1, 100),
    windowMs: readBoundedInteger(env.AAIS_LOGIN_RATE_LIMIT_WINDOW_SECONDS, defaultWindowMs / 1000, 10, 24 * 60 * 60) * 1000,
    lockMs: readBoundedInteger(env.AAIS_LOGIN_RATE_LIMIT_LOCK_SECONDS, defaultLockMs / 1000, 10, 24 * 60 * 60) * 1000,
  };
}

function readBoundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function createRateLimitKey(accountId: string, request: Request) {
  return hashRateLimitPart(`${normalizeAccount(accountId)}:${getClientAddress(request)}`);
}

function hashRateLimitPart(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function normalizeAccount(accountId: string) {
  return accountId.trim().toLowerCase();
}

function getClientAddress(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor
    || request.headers.get("cf-connecting-ip")?.trim()
    || request.headers.get("x-real-ip")?.trim()
    || "unknown";
}
