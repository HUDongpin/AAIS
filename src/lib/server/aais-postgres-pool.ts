import { Pool, type PoolConfig } from "pg";
import { neon } from "@neondatabase/serverless";

const aaisPostgresConnectionTimeoutMs = 5_000;
const aaisPostgresStatementTimeoutMs = 30_000;
const aaisPostgresQueryTimeoutMs = 35_000;
const aaisPostgresIdleTransactionTimeoutMs = 30_000;
const aaisNeonQueryTimeoutMs = 35_000;

export function getAaisPostgresPoolConfig(connectionString: string): PoolConfig {
  if (!connectionString.trim()) {
    throw new Error("AAIS Postgres connection string is required.");
  }
  return {
    connectionString,
    connectionTimeoutMillis: aaisPostgresConnectionTimeoutMs,
    statement_timeout: aaisPostgresStatementTimeoutMs,
    query_timeout: aaisPostgresQueryTimeoutMs,
    idle_in_transaction_session_timeout: aaisPostgresIdleTransactionTimeoutMs,
  };
}

export function createAaisPostgresPool(connectionString: string) {
  return new Pool(getAaisPostgresPoolConfig(connectionString));
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
