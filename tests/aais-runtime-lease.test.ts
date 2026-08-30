import { describe, expect, it } from "vitest";
import {
  acquireAaisRuntimeLease,
  assertAaisRuntimeLeaseHeld,
  isAaisRuntimeLeaseUnavailableError,
  releaseAaisRuntimeLease,
} from "@/lib/server/aais-runtime-lease";
import type { AaisDatabaseClient } from "@/lib/server/aais-learning-store";

describe("AAIS provider-neutral runtime worker lease", () => {
  it("atomically acquires or renews one lease with a three-minute TTL", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const database: AaisDatabaseClient = {
      async query(sql, params = []) {
        queries.push({ sql, params });
        return { rows: [{ holder_id: params[1], generation: "7" }] };
      },
    };

    const lease = await acquireAaisRuntimeLease("lrs-outbox", {
      database,
      env: { AAIS_WORKER_INSTANCE_ID: "aliyun:worker-a" },
    });
    expect(lease).toMatchObject({
      status: "acquired",
      required: true,
      leaseKey: "lrs-outbox",
      generation: 7,
    });
    expect(lease.holderId).toMatch(/^aliyun:worker-a:[0-9a-f-]{36}$/);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("on conflict (lease_key) do update");
    expect(queries[0].sql).toContain("aais_runtime_leases.generation + 1");
    expect(queries[0].sql).toContain("aais_runtime_leases.expires_at <= clock_timestamp()");
    expect(queries[0].params).toEqual(["lrs-outbox", lease.holderId, 180]);
  });

  it("returns standby when another live holder owns the lease", async () => {
    const database: AaisDatabaseClient = {
      async query() {
        return { rows: [] };
      },
    };

    const lease = await acquireAaisRuntimeLease("auth-email-outbox", {
      database,
      env: { AAIS_WORKER_INSTANCE_ID: "vercel:worker-b" },
    });
    expect(lease).toMatchObject({
      status: "standby",
      required: true,
      leaseKey: "auth-email-outbox",
      generation: null,
    });
    expect(lease.holderId).toMatch(/^vercel:worker-b:[0-9a-f-]{36}$/);
  });

  it("uses a unique invocation holder even for the same configured worker role", async () => {
    const holders: string[] = [];
    const database: AaisDatabaseClient = {
      async query(_sql, params = []) {
        holders.push(String(params[1]));
        return { rows: [] };
      },
    };

    await acquireAaisRuntimeLease("lrs-outbox", {
      database,
      env: { AAIS_WORKER_INSTANCE_ID: "aliyun:aais-primary" },
    });
    await acquireAaisRuntimeLease("lrs-outbox", {
      database,
      env: { AAIS_WORKER_INSTANCE_ID: "aliyun:aais-primary" },
    });

    expect(holders).toHaveLength(2);
    expect(holders[0]).not.toBe(holders[1]);
  });

  it("releases only the exact holder and fencing generation", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const database: AaisDatabaseClient = {
      async query(sql, params = []) {
        queries.push({ sql, params });
        return { rows: [] };
      },
    };

    await releaseAaisRuntimeLease({
      status: "acquired",
      required: true,
      leaseKey: "lrs-outbox",
      holderId: "aliyun:worker-a:00000000-0000-4000-8000-000000000000",
      generation: 9,
    }, { database });

    expect(queries[0].sql).toContain("delete from public.aais_runtime_leases");
    expect(queries[0].params).toEqual([
      "lrs-outbox",
      "aliyun:worker-a:00000000-0000-4000-8000-000000000000",
      9,
    ]);
  });

  it("checks the holder and fencing generation immediately before dispatch", async () => {
    const database: AaisDatabaseClient = {
      async query(sql, params = []) {
        expect(sql).toContain("generation = $3");
        expect(params).toEqual(["lrs-outbox", "aliyun:worker-a", 4]);
        return { rows: [{ held: 1 }] };
      },
    };

    await expect(assertAaisRuntimeLeaseHeld({
      status: "acquired",
      required: true,
      leaseKey: "lrs-outbox",
      holderId: "aliyun:worker-a",
      generation: 4,
    }, { database })).resolves.toBeUndefined();
  });

  it("fails closed when a fencing generation is no longer current", async () => {
    const database: AaisDatabaseClient = {
      async query() {
        return { rows: [] };
      },
    };

    await expect(assertAaisRuntimeLeaseHeld({
      status: "acquired",
      required: true,
      leaseKey: "lrs-outbox",
      holderId: "aliyun:stale-worker",
      generation: 3,
    }, { database })).rejects.toSatisfy(isAaisRuntimeLeaseUnavailableError);
  });

  it("rejects an unsafe explicit worker identifier without reflecting it", async () => {
    const database: AaisDatabaseClient = {
      async query() {
        throw new Error("must not be reached");
      },
    };
    const unsafe = "worker id containing a secret value";

    try {
      await acquireAaisRuntimeLease("lrs-outbox", {
        database,
        env: { AAIS_WORKER_INSTANCE_ID: unsafe },
      });
      throw new Error("expected acquisition to fail");
    } catch (error) {
      expect(isAaisRuntimeLeaseUnavailableError(error)).toBe(true);
      expect(String(error)).not.toContain(unsafe);
    }
  });
});
