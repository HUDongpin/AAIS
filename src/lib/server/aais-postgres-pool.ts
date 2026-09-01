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
const aaisAliyunPostgresSocketPath = "/run/aais/postgresql";
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
  assertAaisProductionPostgresTransport(connectionString, env);
  return {
    connectionString,
    max: getAaisPostgresPoolMax(env),
    connectionTimeoutMillis: aaisPostgresConnectionTimeoutMs,
    statement_timeout: aaisPostgresStatementTimeoutMs,
    query_timeout: aaisPostgresQueryTimeoutMs,
    idle_in_transaction_session_timeout: aaisPostgresIdleTransactionTimeoutMs,
  };
}

function assertAaisProductionPostgresTransport(
  connectionString: string,
  env: Record<string, string | undefined>,
) {
  const production = env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
  if (!production) {
    return;
  }
  const normalizedConnectionString = connectionString.trim();
  const researchConnectionString = env.AAIS_RESEARCH_DATABASE_URL?.trim();
  if (researchConnectionString && normalizedConnectionString === researchConnectionString) {
    // The formal research plane is a separately governed database target and
    // is outside this product-Neon rollout. Its own readiness contract remains
    // responsible for research-provider isolation and transport evidence.
    return;
  }
  try {
    const parsed = new URL(connectionString);
    const sslModes = parsed.searchParams.getAll("sslmode");
    const databaseProvider = env.AAIS_DATABASE_PROVIDER?.trim().toLowerCase();
    const rootCertificates = parsed.searchParams.getAll("sslrootcert");
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)
      || rootCertificates.length !== 0
      || env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
      throw new Error();
    }
    if (databaseProvider === "neon") {
      if (
        !parsed.hostname.toLowerCase().endsWith(".neon.tech")
        || sslModes.length !== 1
        || sslModes[0]?.toLowerCase() !== "verify-full"
      ) {
        throw new Error();
      }
      return;
    }
    if (databaseProvider === "aliyun-postgres") {
      const socketHosts = parsed.searchParams.getAll("host");
      const transport = env.AAIS_DATABASE_TRANSPORT?.trim().toLowerCase();
      if (
        transport !== "unix"
        || parsed.hostname.toLowerCase() !== "localhost"
        || socketHosts.length !== 1
        || socketHosts[0] !== aaisAliyunPostgresSocketPath
        || sslModes.length !== 1
        || sslModes[0]?.toLowerCase() !== "disable"
      ) {
        throw new Error();
      }
      return;
    }
    throw new Error();
  } catch {
    throw new Error(
      "AAIS production Postgres requires AAIS_DATABASE_PROVIDER=neon, a neon.tech hostname, system CA trust, and TLS verify-full, or AAIS_DATABASE_PROVIDER=aliyun-postgres with AAIS_DATABASE_TRANSPORT=unix and the AAIS local PostgreSQL socket.",
    );
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

export function createAaisNeonQueryClient(
  connectionString: string,
  env: Record<string, string | undefined> = process.env,
) {
  if (!connectionString.trim()) {
    throw new Error("AAIS Neon connection string is required.");
  }
  assertAaisProductionNeonConnection(connectionString, env);
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

function assertAaisProductionNeonConnection(
  connectionString: string,
  env: Record<string, string | undefined>,
) {
  if (env.NODE_ENV !== "production" && env.VERCEL_ENV !== "production") {
    return;
  }
  try {
    const parsed = new URL(connectionString);
    const sslModes = parsed.searchParams.getAll("sslmode");
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol)
      || !parsed.hostname.toLowerCase().endsWith(".neon.tech")
      || sslModes.length !== 1
      || sslModes[0]?.toLowerCase() !== "verify-full"
      || env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
    ) {
      throw new Error();
    }
  } catch {
    throw new Error("AAIS production Neon requires a neon.tech URL with TLS verify-full.");
  }
}
