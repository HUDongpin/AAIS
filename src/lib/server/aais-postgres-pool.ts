import { Pool, type PoolConfig } from "pg";
import { neon } from "@neondatabase/serverless";

const aaisPostgresConnectionTimeoutMs = 5_000;
const aaisPostgresStatementTimeoutMs = 30_000;
const aaisPostgresQueryTimeoutMs = 35_000;
const aaisPostgresIdleTransactionTimeoutMs = 30_000;
const aaisNeonQueryTimeoutMs = 35_000;
const aaisPostgresDefaultPoolMax = 5;
const aaisPostgresVercelPoolMax = 2;
const aaisPostgresMaximumPoolMax = 20;
const sharedPostgresPools = new Map<string, Pool>();

export function getAaisPostgresPoolMax(
  env: Record<string, string | undefined> = process.env,
) {
  const configured = env.AAIS_DATABASE_POOL_MAX?.trim();
  if (!configured) {
    return env.VERCEL ? aaisPostgresVercelPoolMax : aaisPostgresDefaultPoolMax;
  }
  if (!/^\d+$/.test(configured)) {
    throw new Error("AAIS_DATABASE_POOL_MAX must be an integer between 1 and 20.");
  }
  const parsed = Number(configured);
  if (parsed < 1 || parsed > aaisPostgresMaximumPoolMax) {
    throw new Error("AAIS_DATABASE_POOL_MAX must be an integer between 1 and 20.");
  }
  return parsed;
}

export function getAaisPostgresPoolConfig(
  connectionString: string,
  env: Record<string, string | undefined> = process.env,
): PoolConfig {
  if (!connectionString.trim()) {
    throw new Error("AAIS Postgres connection string is required.");
  }
  assertAaisProductionPostgresTls(connectionString, env);
  return {
    connectionString,
    max: getAaisPostgresPoolMax(env),
    connectionTimeoutMillis: aaisPostgresConnectionTimeoutMs,
    statement_timeout: aaisPostgresStatementTimeoutMs,
    query_timeout: aaisPostgresQueryTimeoutMs,
    idle_in_transaction_session_timeout: aaisPostgresIdleTransactionTimeoutMs,
  };
}

function assertAaisProductionPostgresTls(
  connectionString: string,
  env: Record<string, string | undefined>,
) {
  const provider = env.AAIS_DEPLOYMENT_PROVIDER?.trim().toLowerCase();
  const production = env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
  if (!production || provider !== "aliyun") {
    return;
  }
  try {
    const parsed = new URL(connectionString);
    const sslModes = parsed.searchParams.getAll("sslmode");
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol)
      || sslModes.length !== 1
      || sslModes[0]?.toLowerCase() !== "verify-full"
      || env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
    ) {
      throw new Error();
    }
    if (env.AAIS_DATABASE_PROVIDER?.trim().toLowerCase() === "rds") {
      const rootCertificates = parsed.searchParams.getAll("sslrootcert");
      if (
        rootCertificates.length !== 1
        || rootCertificates[0] !== "/etc/aais/rds-ca.pem"
      ) {
        throw new Error();
      }
    }
  } catch {
    throw new Error("AAIS Aliyun production Postgres requires TLS verify-full.");
  }
}

export function createAaisPostgresPool(
  connectionString: string,
  env: Record<string, string | undefined> = process.env,
) {
  return new Pool(getAaisPostgresPoolConfig(connectionString, env));
}

export function getAaisSharedPostgresPool(
  connectionString: string,
  env: Record<string, string | undefined> = process.env,
) {
  const normalizedConnectionString = connectionString.trim();
  if (!normalizedConnectionString) {
    throw new Error("AAIS Postgres connection string is required.");
  }
  const poolMax = getAaisPostgresPoolMax(env);
  const cacheKey = `${poolMax}:${normalizedConnectionString}`;
  const cached = sharedPostgresPools.get(cacheKey);
  if (cached) {
    return cached;
  }
  const pool = createAaisPostgresPool(normalizedConnectionString, env);
  sharedPostgresPools.set(cacheKey, pool);
  return pool;
}

export function createAaisNeonQueryClient(connectionString: string) {
  if (!connectionString.trim()) {
    throw new Error("AAIS Neon connection string is required.");
  }
  const sql = neon(connectionString);
  return {
    async query(query: string, params: unknown[] = []) {
      const result = await sql.query(query, params, {
        fetchOptions: { signal: AbortSignal.timeout(aaisNeonQueryTimeoutMs) },
      });
      if (Array.isArray(result)) {
        return { rows: result as Array<Record<string, unknown>> };
      }
      if (result && typeof result === "object" && "rows" in result) {
        const rows = (result as { rows?: unknown }).rows;
        return { rows: Array.isArray(rows) ? rows as Array<Record<string, unknown>> : [] };
      }
      return { rows: [] };
    },
    async end() {},
  };
}
