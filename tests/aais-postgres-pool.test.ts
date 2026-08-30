import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const poolConstructor = vi.hoisted(() => vi.fn());
const neonQuery = vi.hoisted(() => vi.fn());

vi.mock("pg", () => ({
  Pool: class MockPool {
    constructor(config: unknown) {
      poolConstructor(config);
    }
  },
}));

vi.mock("@neondatabase/serverless", () => ({
  neon: () => ({ query: neonQuery }),
}));

import {
  createAaisNeonQueryClient,
  createAaisPostgresPool,
  getAaisPostgresPoolMax,
  getAaisPostgresPoolConfig,
  getAaisSharedPostgresPool,
} from "@/lib/server/aais-postgres-pool";

describe("AAIS Postgres pool deadlines", () => {
  beforeEach(() => {
    poolConstructor.mockClear();
    neonQuery.mockReset();
  });

  it("bounds connection, statement, query, and idle transaction waits", () => {
    const config = getAaisPostgresPoolConfig("postgres://example.invalid/aais");

    expect(config).toMatchObject({
      connectionString: "postgres://example.invalid/aais",
      max: 5,
      connectionTimeoutMillis: expect.any(Number),
      statement_timeout: expect.any(Number),
      query_timeout: expect.any(Number),
      idle_in_transaction_session_timeout: expect.any(Number),
    });
    expect(Number(config.connectionTimeoutMillis)).toBeGreaterThan(0);
    expect(Number(config.statement_timeout)).toBeGreaterThan(0);
    expect(Number(config.query_timeout)).toBeGreaterThan(Number(config.statement_timeout));
    expect(Number(config.idle_in_transaction_session_timeout)).toBeGreaterThan(0);
  });

  it("uses bounded provider defaults and validates an explicit pool limit", () => {
    expect(getAaisPostgresPoolMax({})).toBe(5);
    expect(getAaisPostgresPoolMax({ VERCEL: "1" })).toBe(2);
    expect(getAaisPostgresPoolMax({ AAIS_DATABASE_POOL_MAX: "7" })).toBe(7);
    expect(() => getAaisPostgresPoolMax({ AAIS_DATABASE_POOL_MAX: "0" }))
      .toThrow("AAIS_DATABASE_POOL_MAX must be an integer between 1 and 20");
    expect(() => getAaisPostgresPoolMax({ AAIS_DATABASE_POOL_MAX: "many" }))
      .toThrow("AAIS_DATABASE_POOL_MAX must be an integer between 1 and 20");
  });

  it("requires hostname-verifying TLS for Aliyun production Postgres", () => {
    const productionEnv = {
      NODE_ENV: "production",
      AAIS_DEPLOYMENT_PROVIDER: "aliyun",
    };

    expect(() => getAaisPostgresPoolConfig(
      "postgres://user:password@db.example.test/aais?sslmode=require",
      productionEnv,
    )).toThrow("TLS verify-full");
    expect(getAaisPostgresPoolConfig(
      "postgres://user:password@db.example.test/aais?sslmode=verify-full",
      productionEnv,
    ).max).toBe(5);
    for (const downgrade of ["disable", "no-verify", "require"]) {
      expect(() => getAaisPostgresPoolConfig(
        `postgres://user:password@db.example.test/aais?sslmode=verify-full&sslmode=${downgrade}`,
        productionEnv,
      )).toThrow("TLS verify-full");
    }
    expect(() => getAaisPostgresPoolConfig(
      "postgres://user:password@db.example.test/aais?sslmode=verify-full",
      { ...productionEnv, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    )).toThrow("TLS verify-full");
    expect(() => getAaisPostgresPoolConfig(
      "postgres://user:password@db.example.test/aais?sslmode=verify-full",
      { ...productionEnv, AAIS_DATABASE_PROVIDER: "rds" },
    )).toThrow("TLS verify-full");
    expect(getAaisPostgresPoolConfig(
      "postgres://user:password@db.example.test/aais?sslmode=verify-full&sslrootcert=%2Fetc%2Faais%2Frds-ca.pem",
      { ...productionEnv, AAIS_DATABASE_PROVIDER: "rds" },
    ).max).toBe(5);
  });

  it("reuses one process-level pool for the same product database and pool limit", () => {
    const first = getAaisSharedPostgresPool(
      "postgres://shared.example.invalid/aais",
      { AAIS_DATABASE_POOL_MAX: "5" },
    );
    const second = getAaisSharedPostgresPool(
      "postgres://shared.example.invalid/aais",
      { AAIS_DATABASE_POOL_MAX: "5" },
    );

    expect(second).toBe(first);
    expect(poolConstructor).toHaveBeenCalledOnce();
  });

  it("constructs every shared product and research pool with the bounded config", () => {
    createAaisPostgresPool("postgres://example.invalid/aais");

    expect(poolConstructor).toHaveBeenCalledOnce();
    expect(poolConstructor).toHaveBeenCalledWith(expect.objectContaining({
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
      query_timeout: 35_000,
      idle_in_transaction_session_timeout: 30_000,
    }));
  });

  it("rejects an empty connection string before constructing a pool", () => {
    expect(() => createAaisPostgresPool("   ")).toThrow("connection string is required");
    expect(poolConstructor).not.toHaveBeenCalled();
  });

  it("passes a fresh 35-second abort deadline to every Neon HTTP query", async () => {
    neonQuery.mockResolvedValue([{ ok: 1 }]);
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const client = createAaisNeonQueryClient(
      "postgres://example.invalid/neon",
    );

    await expect(client.query("select $1::integer as ok", [1])).resolves.toEqual({
      rows: [{ ok: 1 }],
    });
    expect(timeout).toHaveBeenCalledOnce();
    expect(timeout).toHaveBeenCalledWith(35_000);
    expect(neonQuery).toHaveBeenCalledWith(
      "select $1::integer as ok",
      [1],
      { fetchOptions: { signal } },
    );
  });

  it("routes every product Postgres client through the shared bounded pool", () => {
    for (const file of [
      "src/lib/server/aais-auth-delivery.ts",
      "src/lib/server/aais-auth-rate-limit.ts",
      "src/lib/server/aais-learning-store.ts",
      "src/lib/server/aais-session-revocations.ts",
      "src/lib/server/aais-users.ts",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/new Pool\s*\(/);
      expect(source, file).toContain("getAaisSharedPostgresPool");
    }
    const readinessSource = readFileSync("src/lib/server/aais-readiness.ts", "utf8");
    expect(readinessSource).not.toMatch(/new Pool\s*\(/);
    expect(readinessSource).toContain("createAaisPostgresPool");
    const helperSource = readFileSync("src/lib/server/aais-postgres-pool.ts", "utf8");
    expect(helperSource).toContain("AbortSignal.timeout(aaisNeonQueryTimeoutMs)");
    expect(helperSource).toContain("fetchOptions: { signal:");
    const learningStoreSource = readFileSync("src/lib/server/aais-learning-store.ts", "utf8");
    expect(learningStoreSource).toContain("createAaisNeonQueryClient");
    expect(learningStoreSource).not.toContain('from "@neondatabase/serverless"');
  });
});
