import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  getAaisDatabaseConfiguration,
  type AaisDatabaseClient,
} from "@/lib/server/aais-learning-store";
import { createAaisPostgresPool } from "@/lib/server/aais-postgres-pool";

type AaisLoginRateLimitRecord = {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number | null;
  expiresAt: number;
  accountKey?: string;
};

const defaultMaxFailures = 5;
const defaultMaxClientAttempts = 50;
const defaultWindowMs = 15 * 60 * 1000;
const defaultLockMs = 15 * 60 * 1000;
const defaultPasswordResetAccountMaxRequests = 3;
const defaultPasswordResetClientMaxRequests = 10;
const defaultPasswordResetWindowMs = 60 * 60 * 1000;
const defaultPasswordResetLockMs = 60 * 60 * 1000;
const defaultSetPasswordTokenMaxRequests = 5;
const defaultSetPasswordClientMaxRequests = 20;
const defaultSetPasswordWindowMs = 15 * 60 * 1000;
const defaultSetPasswordLockMs = 15 * 60 * 1000;
const defaultMemoryMaxEntries = 10_000;
const defaultDatabaseCleanupBatchSize = 100;
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

export class AaisAuthRateLimitStorageUnavailableError extends Error {
  constructor() {
    super("AAIS durable authentication rate-limit storage is unavailable.");
    this.name = "AaisAuthRateLimitStorageUnavailableError";
  }
}

export async function checkAaisLoginRateLimit(input: {
  accountId: string;
  request: Request;
  now?: number;
  database?: AaisDatabaseClient | null;
}): Promise<AaisLoginRateLimitResult> {
  const database = resolveRateLimitDatabase(input.database);
  if (database) {
    return checkDatabaseLoginRateLimit({ ...input, database });
  }
  return checkMemoryLoginRateLimit(input);
}

/**
 * Atomically reserves one login attempt before password verification. A
 * successful authentication must clear the reservation; every other outcome
 * intentionally retains it as abuse-control evidence.
 */
export async function admitAaisLoginAttempt(input: {
  accountId: string;
  request: Request;
  now?: number;
  database?: AaisDatabaseClient | null;
}): Promise<AaisLoginRateLimitResult> {
  const database = resolveRateLimitDatabase(input.database);
  if (database) {
    return recordDatabaseLoginFailure({ ...input, database });
  }
  return recordMemoryLoginFailure(input);
}

export async function recordAaisLoginFailure(input: {
  accountId: string;
  request: Request;
  now?: number;
  database?: AaisDatabaseClient | null;
}): Promise<AaisLoginRateLimitResult> {
  const database = resolveRateLimitDatabase(input.database);
  if (database) {
    return recordDatabaseLoginFailure({ ...input, database });
  }
  return recordMemoryLoginFailure(input);
}

export async function recordAaisPasswordResetRequest(input: {
  accountId: string;
  request: Request;
  now?: number;
  database?: AaisDatabaseClient | null;
}): Promise<AaisLoginRateLimitResult> {
  const database = resolveRateLimitDatabase(input.database);
  if (database) {
    return recordDatabasePasswordResetRequest({ ...input, database });
  }
  return recordMemoryPasswordResetRequest(input);
}

export async function recordAaisSetPasswordRequest(input: {
  token: string;
  request: Request;
  now?: number;
  database?: AaisDatabaseClient | null;
}): Promise<AaisLoginRateLimitResult> {
  const database = resolveRateLimitDatabase(input.database);
  if (database) {
    return recordDatabaseSetPasswordRequest({ ...input, database });
  }
  return recordMemorySetPasswordRequest(input);
}

export async function clearAaisLoginFailures(input: {
  accountId: string;
  request: Request;
  database?: AaisDatabaseClient | null;
}) {
  const database = resolveRateLimitDatabase(input.database);
  const keys = createLoginRateLimitKeys(input.accountId, input.request);
  if (database) {
    await database.query(
      "delete from aais_login_rate_limits where account_key = $1",
      [keys.accountKey],
    );
    return;
  }
  prepareMemoryAttempts(Date.now());
  for (const [key, record] of attempts) {
    if (record.accountKey === keys.accountKey) {
      attempts.delete(key);
    }
  }
}

function checkMemoryLoginRateLimit(input: {
  accountId: string;
  request: Request;
  now?: number;
}): AaisLoginRateLimitResult {
  const now = input.now ?? Date.now();
  prepareMemoryAttempts(now);
  const keys = createLoginRateLimitKeys(input.accountId, input.request);
  return [keys.account, keys.accountClient, keys.clientGlobal]
    .filter((key): key is string => Boolean(key))
    .reduce<AaisLoginRateLimitResult>(
      (combined, key) => {
        const record = attempts.get(key);
        if (record) {
          touchMemoryAttempt(key, record);
        }
        return mergeRateLimitResults(
          combined,
          createRateLimitResult(record?.lockedUntil ?? null, now),
        );
      },
      { status: "allowed" },
    );
}

function recordMemoryLoginFailure(input: {
  accountId: string;
  request: Request;
  now?: number;
}): AaisLoginRateLimitResult {
  const now = input.now ?? Date.now();
  const config = readAaisLoginRateLimitConfig();
  prepareMemoryAttempts(now);
  const keys = createLoginRateLimitKeys(input.accountId, input.request);
  const clientResult = keys.clientGlobal
    ? recordMemoryRequestKey(
        keys.clientGlobal,
        config.maxClientAttempts,
        now,
        config.windowMs,
        config.lockMs,
      )
    : { status: "allowed" as const };
  if (clientResult.status === "blocked") {
    enforceMemoryAttemptCap();
    return clientResult;
  }
  const accountResult = recordMemoryRequestKey(
    keys.account,
    config.maxFailures,
    now,
    config.windowMs,
    config.lockMs,
    keys.accountKey,
  );
  const accountClientResult = recordMemoryRequestKey(
    keys.accountClient,
    config.maxFailures,
    now,
    config.windowMs,
    config.lockMs,
    keys.accountKey,
  );
  const result = mergeRateLimitResults(
    mergeRateLimitResults(accountResult, accountClientResult),
    clientResult,
  );
  enforceMemoryAttemptCap();
  return result;
}

function recordMemoryPasswordResetRequest(input: {
  accountId: string;
  request: Request;
  now?: number;
}): AaisLoginRateLimitResult {
  const now = input.now ?? Date.now();
  const config = readAaisPasswordResetRateLimitConfig();
  prepareMemoryAttempts(now);
  const keys = createPasswordResetRateLimitKeys(input.accountId, input.request);
  const clientResult = recordMemoryRequestKey(
    keys.client,
    config.clientMaxRequests,
    now,
    config.windowMs,
    config.lockMs,
  );
  if (clientResult.status === "blocked") {
    enforceMemoryAttemptCap();
    return clientResult;
  }
  const result = mergeRateLimitResults(
    recordMemoryRequestKey(
      keys.account,
      config.accountMaxRequests,
      now,
      config.windowMs,
      config.lockMs,
    ),
    clientResult,
  );
  enforceMemoryAttemptCap();
  return result;
}

function recordMemorySetPasswordRequest(input: {
  token: string;
  request: Request;
  now?: number;
}): AaisLoginRateLimitResult {
  const now = input.now ?? Date.now();
  const config = readAaisSetPasswordRateLimitConfig();
  prepareMemoryAttempts(now);
  const keys = createSetPasswordRateLimitKeys(input.token, input.request);
  const clientResult = recordMemoryRequestKey(
    keys.client,
    config.clientMaxRequests,
    now,
    config.windowMs,
    config.lockMs,
  );
  if (clientResult.status === "blocked") {
    enforceMemoryAttemptCap();
    return clientResult;
  }
  const result = mergeRateLimitResults(
    recordMemoryRequestKey(
      keys.token,
      config.tokenMaxRequests,
      now,
      config.windowMs,
      config.lockMs,
    ),
    clientResult,
  );
  enforceMemoryAttemptCap();
  return result;
}

function recordMemoryRequestKey(
  key: string,
  maxRequests: number,
  now: number,
  windowMs: number,
  lockMs: number,
  accountKey?: string,
) {
  const existing = attempts.get(key);
  if (existing?.lockedUntil && existing.lockedUntil > now) {
    touchMemoryAttempt(key, existing);
    return createRateLimitResult(existing.lockedUntil, now);
  }
  const inWindow = existing ? now - existing.firstFailureAt < windowMs : false;
  const failures = existing && inWindow ? existing.failures + 1 : 1;
  const record: AaisLoginRateLimitRecord = {
    failures,
    firstFailureAt: existing && inWindow ? existing.firstFailureAt : now,
    lockedUntil: failures > maxRequests ? now + lockMs : null,
    expiresAt: Math.max(
      (existing && inWindow ? existing.firstFailureAt : now) + windowMs,
      failures > maxRequests ? now + lockMs : 0,
    ),
    ...(accountKey === undefined ? {} : { accountKey }),
  };
  touchMemoryAttempt(key, record);
  return createRateLimitResult(record.lockedUntil, now);
}

function prepareMemoryAttempts(now: number) {
  for (const [key, record] of attempts) {
    if (record.expiresAt <= now) {
      attempts.delete(key);
    }
  }
  enforceMemoryAttemptCap();
}

function touchMemoryAttempt(key: string, record: AaisLoginRateLimitRecord) {
  attempts.delete(key);
  attempts.set(key, record);
}

function enforceMemoryAttemptCap() {
  const { memoryMaxEntries } = readAaisAuthRateLimitRetentionConfig();
  while (attempts.size > memoryMaxEntries) {
    const oldestKey = attempts.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    attempts.delete(oldestKey);
  }
}

export function getAaisAuthRateLimitMemoryDiagnostics(now = Date.now()) {
  prepareMemoryAttempts(now);
  return {
    entryCount: attempts.size,
    maxEntries: readAaisAuthRateLimitRetentionConfig().memoryMaxEntries,
  };
}

async function checkDatabaseLoginRateLimit(input: {
  accountId: string;
  request: Request;
  now?: number;
  database: AaisDatabaseClient;
}): Promise<AaisLoginRateLimitResult> {
  const now = input.now ?? Date.now();
  const keys = createLoginRateLimitKeys(input.accountId, input.request);
  const result = await input.database.query(
    `select locked_until
       from aais_login_rate_limits
      where rate_limit_key = any($1::text[])
        and expires_at > $2::timestamptz`,
    [
      [keys.account, keys.accountClient, keys.clientGlobal].filter(Boolean),
      new Date(now),
    ],
  );
  return result.rows.reduce<AaisLoginRateLimitResult>(
    (combined, row) => mergeRateLimitResults(
      combined,
      createRateLimitResult(readTime(row.locked_until), now),
    ),
    { status: "allowed" },
  );
}

async function recordDatabaseLoginFailure(input: {
  accountId: string;
  request: Request;
  now?: number;
  database: AaisDatabaseClient;
}): Promise<AaisLoginRateLimitResult> {
  const now = input.now ?? Date.now();
  const config = readAaisLoginRateLimitConfig();
  const keys = createLoginRateLimitKeys(input.accountId, input.request);
  return recordDatabaseRateLimitAdmission({
    database: input.database,
    now,
    windowMs: config.windowMs,
    lockMs: config.lockMs,
    gate: keys.clientGlobal
      ? {
          key: keys.clientGlobal,
          accountKey: hashRateLimitPart("login:client-global:any-account"),
          clientKey: keys.clientKey,
          maxRequests: config.maxClientAttempts,
        }
      : null,
    details: [
      {
        key: keys.account,
        accountKey: keys.accountKey,
        clientKey: keys.clientKey,
      },
      {
        key: keys.accountClient,
        accountKey: keys.accountKey,
        clientKey: keys.clientKey,
      },
    ],
    detailMaxRequests: config.maxFailures,
  });
}

async function recordDatabasePasswordResetRequest(input: {
  accountId: string;
  request: Request;
  now?: number;
  database: AaisDatabaseClient;
}): Promise<AaisLoginRateLimitResult> {
  const now = input.now ?? Date.now();
  const config = readAaisPasswordResetRateLimitConfig();
  const keys = createPasswordResetRateLimitKeys(input.accountId, input.request);
  const accountKey = hashRateLimitPart(normalizeAccount(input.accountId));
  const clientKey = hashRateLimitPart(getClientAddress(input.request));
  return recordDatabaseRateLimitAdmission({
    database: input.database,
    now,
    windowMs: config.windowMs,
    lockMs: config.lockMs,
    gate: {
      key: keys.client,
      accountKey: hashRateLimitPart("password-reset:any-account"),
      clientKey,
      maxRequests: config.clientMaxRequests,
    },
    details: [{ key: keys.account, accountKey, clientKey }],
    detailMaxRequests: config.accountMaxRequests,
  });
}

async function recordDatabaseSetPasswordRequest(input: {
  token: string;
  request: Request;
  now?: number;
  database: AaisDatabaseClient;
}): Promise<AaisLoginRateLimitResult> {
  const now = input.now ?? Date.now();
  const config = readAaisSetPasswordRateLimitConfig();
  const keys = createSetPasswordRateLimitKeys(input.token, input.request);
  const tokenKey = hashRateLimitPart(`set-password:token-key:${input.token}`);
  const clientKey = hashRateLimitPart(getClientAddress(input.request));
  return recordDatabaseRateLimitAdmission({
    database: input.database,
    now,
    windowMs: config.windowMs,
    lockMs: config.lockMs,
    gate: {
      key: keys.client,
      accountKey: hashRateLimitPart("set-password:any-token"),
      clientKey,
      maxRequests: config.clientMaxRequests,
    },
    details: [{ key: keys.token, accountKey: tokenKey, clientKey }],
    detailMaxRequests: config.tokenMaxRequests,
  });
}

type AaisDatabaseRateLimitKey = {
  key: string;
  accountKey: string;
  clientKey: string;
};

async function recordDatabaseRateLimitAdmission(input: {
  database: AaisDatabaseClient;
  now: number;
  windowMs: number;
  lockMs: number;
  gate: (AaisDatabaseRateLimitKey & { maxRequests: number }) | null;
  details: AaisDatabaseRateLimitKey[];
  detailMaxRequests: number;
}): Promise<AaisLoginRateLimitResult> {
  const protectedKeys = [
    ...(input.gate ? [input.gate.key] : []),
    ...input.details.map((detail) => detail.key),
  ];
  const result = await input.database.query(
    `with expired_rate_limits as (
       select rate_limit_key
         from aais_login_rate_limits
        where expires_at <= $1::timestamptz
          and not (rate_limit_key = any($2::text[]))
        order by expires_at, rate_limit_key
        limit $3::integer
        for update skip locked
     ), pruned_rate_limits as (
       delete from aais_login_rate_limits target
        using expired_rate_limits expired
        where target.rate_limit_key = expired.rate_limit_key
        returning target.rate_limit_key
     ), gate_admission as (
       insert into aais_login_rate_limits (
         rate_limit_key, account_key, client_key, failures,
         first_failure_at, locked_until, updated_at, expires_at
       )
       select $4::text, $5::text, $6::text, 1,
              $1::timestamptz, null, $1::timestamptz,
              $1::timestamptz
                + greatest($12::bigint, $13::bigint) * interval '1 millisecond'
        where $4::text is not null
       on conflict (rate_limit_key)
       do update set
         account_key = excluded.account_key,
         client_key = excluded.client_key,
         failures = case
           when aais_login_rate_limits.locked_until > $1::timestamptz
           then aais_login_rate_limits.failures
           when $1::timestamptz - aais_login_rate_limits.first_failure_at
             < $12::bigint * interval '1 millisecond'
           then aais_login_rate_limits.failures + 1
           else 1
         end,
         first_failure_at = case
           when aais_login_rate_limits.locked_until > $1::timestamptz
           then aais_login_rate_limits.first_failure_at
           when $1::timestamptz - aais_login_rate_limits.first_failure_at
             < $12::bigint * interval '1 millisecond'
           then aais_login_rate_limits.first_failure_at
           else $1::timestamptz
         end,
         locked_until = case
           when aais_login_rate_limits.locked_until > $1::timestamptz
           then aais_login_rate_limits.locked_until
           when (
             case
               when $1::timestamptz - aais_login_rate_limits.first_failure_at
                 < $12::bigint * interval '1 millisecond'
               then aais_login_rate_limits.failures + 1
               else 1
             end
           ) > $7::integer
           then $1::timestamptz + $13::bigint * interval '1 millisecond'
           else null
         end,
         updated_at = $1::timestamptz,
         expires_at = $1::timestamptz
           + greatest($12::bigint, $13::bigint) * interval '1 millisecond'
       returning locked_until
     ), detail_admission as (
       insert into aais_login_rate_limits (
         rate_limit_key, account_key, client_key, failures,
         first_failure_at, locked_until, updated_at, expires_at
       )
       select detail.rate_limit_key,
              detail.account_key,
              detail.client_key,
              1,
              $1::timestamptz,
              null,
              $1::timestamptz,
              $1::timestamptz
                + greatest($12::bigint, $13::bigint) * interval '1 millisecond'
         from unnest($8::text[], $9::text[], $10::text[])
           as detail(rate_limit_key, account_key, client_key)
        where not exists (
          select 1
            from gate_admission gate_result
           where gate_result.locked_until > $1::timestamptz
        )
       on conflict (rate_limit_key)
       do update set
         account_key = excluded.account_key,
         client_key = excluded.client_key,
         failures = case
           when aais_login_rate_limits.locked_until > $1::timestamptz
           then aais_login_rate_limits.failures
           when $1::timestamptz - aais_login_rate_limits.first_failure_at
             < $12::bigint * interval '1 millisecond'
           then aais_login_rate_limits.failures + 1
           else 1
         end,
         first_failure_at = case
           when aais_login_rate_limits.locked_until > $1::timestamptz
           then aais_login_rate_limits.first_failure_at
           when $1::timestamptz - aais_login_rate_limits.first_failure_at
             < $12::bigint * interval '1 millisecond'
           then aais_login_rate_limits.first_failure_at
           else $1::timestamptz
         end,
         locked_until = case
           when aais_login_rate_limits.locked_until > $1::timestamptz
           then aais_login_rate_limits.locked_until
           when (
             case
               when $1::timestamptz - aais_login_rate_limits.first_failure_at
                 < $12::bigint * interval '1 millisecond'
               then aais_login_rate_limits.failures + 1
               else 1
             end
           ) > $11::integer
           then $1::timestamptz + $13::bigint * interval '1 millisecond'
           else null
         end,
         updated_at = $1::timestamptz,
         expires_at = $1::timestamptz
           + greatest($12::bigint, $13::bigint) * interval '1 millisecond'
       returning locked_until
     )
     select locked_until from gate_admission
     union all
     select locked_until from detail_admission`,
    [
      new Date(input.now),
      protectedKeys,
      readAaisAuthRateLimitRetentionConfig().databaseCleanupBatchSize,
      input.gate?.key ?? null,
      input.gate?.accountKey ?? null,
      input.gate?.clientKey ?? null,
      input.gate?.maxRequests ?? 1,
      input.details.map((detail) => detail.key),
      input.details.map((detail) => detail.accountKey),
      input.details.map((detail) => detail.clientKey),
      input.detailMaxRequests,
      input.windowMs,
      input.lockMs,
    ],
  );
  return result.rows.reduce<AaisLoginRateLimitResult>(
    (combined, row) => mergeRateLimitResults(
      combined,
      createRateLimitResult(readTime(row.locked_until), input.now),
    ),
    { status: "allowed" },
  );
}

function resolveRateLimitDatabase(database: AaisDatabaseClient | null | undefined) {
  if (database !== undefined) {
    if (!database) {
      assertMemoryRateLimitFallbackAllowed();
      return undefined;
    }
    return database;
  }
  const config = getAaisDatabaseConfiguration();
  if (!config) {
    assertMemoryRateLimitFallbackAllowed();
    return undefined;
  }
  if (!cachedDatabase || cachedDatabase.url !== config.url) {
    if (cachedDatabase?.client.end) {
      void cachedDatabase.client.end().catch(() => undefined);
    }
    cachedDatabase = {
      url: config.url,
      client: createAaisPostgresPool(config.url) as AaisDatabaseClient,
    };
  }
  return cachedDatabase.client;
}

function assertMemoryRateLimitFallbackAllowed() {
  if (
    process.env.NODE_ENV === "production"
    || process.env.VERCEL === "1"
    || Boolean(process.env.VERCEL_ENV?.trim())
  ) {
    throw new AaisAuthRateLimitStorageUnavailableError();
  }
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
    maxClientAttempts: readBoundedInteger(
      env.AAIS_LOGIN_RATE_LIMIT_CLIENT_MAX_ATTEMPTS,
      defaultMaxClientAttempts,
      1,
      10_000,
    ),
    windowMs: readBoundedInteger(env.AAIS_LOGIN_RATE_LIMIT_WINDOW_SECONDS, defaultWindowMs / 1000, 10, 24 * 60 * 60) * 1000,
    lockMs: readBoundedInteger(env.AAIS_LOGIN_RATE_LIMIT_LOCK_SECONDS, defaultLockMs / 1000, 10, 24 * 60 * 60) * 1000,
  };
}

export function readAaisPasswordResetRateLimitConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return {
    accountMaxRequests: readBoundedInteger(
      env.AAIS_PASSWORD_RESET_ACCOUNT_MAX_REQUESTS,
      defaultPasswordResetAccountMaxRequests,
      1,
      100,
    ),
    clientMaxRequests: readBoundedInteger(
      env.AAIS_PASSWORD_RESET_CLIENT_MAX_REQUESTS,
      defaultPasswordResetClientMaxRequests,
      1,
      1_000,
    ),
    windowMs: readBoundedInteger(
      env.AAIS_PASSWORD_RESET_WINDOW_SECONDS,
      defaultPasswordResetWindowMs / 1000,
      60,
      24 * 60 * 60,
    ) * 1000,
    lockMs: readBoundedInteger(
      env.AAIS_PASSWORD_RESET_LOCK_SECONDS,
      defaultPasswordResetLockMs / 1000,
      60,
      24 * 60 * 60,
    ) * 1000,
  };
}

export function readAaisSetPasswordRateLimitConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return {
    tokenMaxRequests: readBoundedInteger(
      env.AAIS_SET_PASSWORD_TOKEN_MAX_REQUESTS,
      defaultSetPasswordTokenMaxRequests,
      1,
      100,
    ),
    clientMaxRequests: readBoundedInteger(
      env.AAIS_SET_PASSWORD_CLIENT_MAX_REQUESTS,
      defaultSetPasswordClientMaxRequests,
      1,
      1_000,
    ),
    windowMs: readBoundedInteger(
      env.AAIS_SET_PASSWORD_WINDOW_SECONDS,
      defaultSetPasswordWindowMs / 1000,
      10,
      24 * 60 * 60,
    ) * 1000,
    lockMs: readBoundedInteger(
      env.AAIS_SET_PASSWORD_LOCK_SECONDS,
      defaultSetPasswordLockMs / 1000,
      10,
      24 * 60 * 60,
    ) * 1000,
  };
}

export function readAaisAuthRateLimitRetentionConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return {
    memoryMaxEntries: readBoundedInteger(
      env.AAIS_AUTH_RATE_LIMIT_MEMORY_MAX_ENTRIES,
      defaultMemoryMaxEntries,
      4,
      100_000,
    ),
    databaseCleanupBatchSize: readBoundedInteger(
      env.AAIS_AUTH_RATE_LIMIT_DATABASE_CLEANUP_BATCH_SIZE,
      defaultDatabaseCleanupBatchSize,
      1,
      1_000,
    ),
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

function createLoginRateLimitKeys(accountId: string, request: Request) {
  const account = normalizeAccount(accountId);
  const client = getClientAddress(request);
  return {
    account: hashRateLimitPart(`login:account:${account}`),
    accountClient: hashRateLimitPart(`login:account-client:${account}:${client}`),
    accountKey: hashRateLimitPart(`login:account-key:${account}`),
    clientKey: hashRateLimitPart(`login:client-key:${client}`),
    clientGlobal: client === "unattributed"
      ? null
      : hashRateLimitPart(`login:client-global:${client}`),
  };
}

function createPasswordResetRateLimitKeys(accountId: string, request: Request) {
  const account = normalizeAccount(accountId);
  const client = getClientAddress(request);
  return {
    account: hashRateLimitPart(`password-reset:account:${account}`),
    client: hashRateLimitPart(
      client === "unattributed"
        ? `password-reset:client:unattributed:${account}`
        : `password-reset:client:${client}`,
    ),
  };
}

function createSetPasswordRateLimitKeys(token: string, request: Request) {
  const client = getClientAddress(request);
  const tokenDigest = hashRateLimitPart(`set-password:token-material:${token}`);
  return {
    token: hashRateLimitPart(`set-password:token:${tokenDigest}`),
    client: hashRateLimitPart(
      client === "unattributed"
        ? `set-password:client:unattributed:${tokenDigest}`
        : `set-password:client:${client}`,
    ),
  };
}

function mergeRateLimitResults(
  first: AaisLoginRateLimitResult,
  second: AaisLoginRateLimitResult,
): AaisLoginRateLimitResult {
  if (first.status === "allowed") {
    return second;
  }
  if (second.status === "allowed") {
    return first;
  }
  return {
    status: "blocked",
    retryAfterSeconds: Math.max(first.retryAfterSeconds, second.retryAfterSeconds),
  };
}

function hashRateLimitPart(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function normalizeAccount(accountId: string) {
  return accountId.trim().toLowerCase();
}

function getClientAddress(request: Request) {
  const configuredHeader = process.env.AAIS_TRUSTED_PROXY_IP_HEADER?.trim().toLowerCase();
  const trustedHeader = configuredHeader
    || (isVercelRuntime() ? "x-vercel-forwarded-for" : undefined);
  if (!isTrustedProxyIpHeader(trustedHeader)) {
    return "unattributed";
  }
  const raw = request.headers.get(trustedHeader);
  const candidate = trustedHeader === "x-forwarded-for"
    || trustedHeader === "x-vercel-forwarded-for"
    ? raw?.split(",").at(-1)?.trim()
    : raw?.trim();
  return candidate && isIP(candidate) ? candidate.toLowerCase() : "unattributed";
}

function isVercelRuntime() {
  return process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV?.trim());
}

function isTrustedProxyIpHeader(value: string | undefined): value is string {
  return value === "x-forwarded-for"
    || value === "x-vercel-forwarded-for"
    || value === "cf-connecting-ip"
    || value === "x-real-ip";
}
