import { randomUUID } from "node:crypto";
import {
  getAaisDatabaseConfiguration,
  type AaisDatabaseClient,
} from "@/lib/server/aais-learning-store";
import {
  createAaisNeonQueryClient,
  getAaisSharedPostgresPool,
} from "@/lib/server/aais-postgres-pool";
import { getAaisReleaseMetadata } from "@/lib/server/aais-deployment-metadata";
import { requiresAaisDurableStorage } from "@/lib/server/aais-runtime";

export type AaisRuntimeLeaseKey = "auth-email-outbox" | "lrs-outbox";

export type AaisRuntimeLease = {
  status: "acquired" | "standby";
  required: boolean;
  leaseKey: AaisRuntimeLeaseKey;
  holderId: string;
  generation: number | null;
};

const runtimeLeaseTtlSeconds = 180;

export class AaisRuntimeLeaseUnavailableError extends Error {
  constructor() {
    super("AAIS runtime worker lease is unavailable.");
    this.name = "AaisRuntimeLeaseUnavailableError";
  }
}

export function isAaisRuntimeLeaseUnavailableError(
  error: unknown,
): error is AaisRuntimeLeaseUnavailableError {
  return error instanceof AaisRuntimeLeaseUnavailableError;
}

export async function acquireAaisRuntimeLease(
  leaseKey: AaisRuntimeLeaseKey,
  input: {
    database?: AaisDatabaseClient;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<AaisRuntimeLease> {
  const env = input.env ?? process.env;
  const holderId = getWorkerHolderId(env);
  const database = input.database ?? getRuntimeLeaseDatabase(env);
  if (!database) {
    if (requiresAaisDurableStorage(env as NodeJS.ProcessEnv)) {
      throw new AaisRuntimeLeaseUnavailableError();
    }
    return {
      status: "acquired",
      required: false,
      leaseKey,
      holderId,
      generation: null,
    };
  }
  try {
    const result = await database.query(
      `insert into public.aais_runtime_leases (
         lease_key,
         holder_id,
         generation,
         expires_at,
         updated_at
       ) values (
         $1,
         $2,
         1,
         clock_timestamp() + $3::integer * interval '1 second',
         clock_timestamp()
       )
       on conflict (lease_key) do update set
         holder_id = excluded.holder_id,
         generation = case
           when aais_runtime_leases.holder_id = excluded.holder_id
             then aais_runtime_leases.generation
           else aais_runtime_leases.generation + 1
         end,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at
       where aais_runtime_leases.expires_at <= clock_timestamp()
          or aais_runtime_leases.holder_id = excluded.holder_id
       returning holder_id, generation`,
      [leaseKey, holderId, runtimeLeaseTtlSeconds],
    );
    const row = result.rows[0];
    const generation = Number(row?.generation);
    if (!row || row.holder_id !== holderId || !Number.isSafeInteger(generation) || generation < 1) {
      return {
        status: "standby",
        required: true,
        leaseKey,
        holderId,
        generation: null,
      };
    }
    return {
      status: "acquired",
      required: true,
      leaseKey,
      holderId,
      generation,
    };
  } catch {
    throw new AaisRuntimeLeaseUnavailableError();
  }
}

export async function assertAaisRuntimeLeaseHeld(
  lease: AaisRuntimeLease,
  input: {
    database?: AaisDatabaseClient;
    env?: Record<string, string | undefined>;
  } = {},
) {
  if (!lease.required) {
    return;
  }
  if (lease.status !== "acquired" || lease.generation === null) {
    throw new AaisRuntimeLeaseUnavailableError();
  }
  const env = input.env ?? process.env;
  const database = input.database ?? getRuntimeLeaseDatabase(env);
  if (!database) {
    throw new AaisRuntimeLeaseUnavailableError();
  }
  try {
    const result = await database.query(
      `select 1 as held
         from public.aais_runtime_leases
        where lease_key = $1
          and holder_id = $2
          and generation = $3
          and expires_at > clock_timestamp()`,
      [lease.leaseKey, lease.holderId, lease.generation],
    );
    if (result.rows[0]?.held !== 1 && result.rows[0]?.held !== "1") {
      throw new AaisRuntimeLeaseUnavailableError();
    }
  } catch (error) {
    if (isAaisRuntimeLeaseUnavailableError(error)) {
      throw error;
    }
    throw new AaisRuntimeLeaseUnavailableError();
  }
}

export async function releaseAaisRuntimeLease(
  lease: AaisRuntimeLease,
  input: {
    database?: AaisDatabaseClient;
    env?: Record<string, string | undefined>;
  } = {},
) {
  if (!lease.required || lease.status !== "acquired" || lease.generation === null) {
    return;
  }
  const env = input.env ?? process.env;
  const database = input.database ?? getRuntimeLeaseDatabase(env);
  if (!database) {
    return;
  }
  try {
    await database.query(
      `delete from public.aais_runtime_leases
        where lease_key = $1
          and holder_id = $2
          and generation = $3`,
      [lease.leaseKey, lease.holderId, lease.generation],
    );
  } catch {
    // A failed release is safe: the short TTL remains the crash-recovery path.
  }
}

function getRuntimeLeaseDatabase(
  env: Record<string, string | undefined>,
): AaisDatabaseClient | null {
  const configuration = getAaisDatabaseConfiguration();
  if (!configuration) {
    return null;
  }
  if (shouldUseNeonServerlessDriver(configuration.url, env)) {
    return createAaisNeonQueryClient(configuration.url);
  }
  return getAaisSharedPostgresPool(configuration.url, env) as AaisDatabaseClient;
}

function getWorkerHolderId(env: Record<string, string | undefined>) {
  const explicit = env.AAIS_WORKER_INSTANCE_ID?.trim();
  if (explicit) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/.test(explicit)) {
      throw new AaisRuntimeLeaseUnavailableError();
    }
    return `${explicit}:${randomUUID()}`;
  }
  const release = getAaisReleaseMetadata(env);
  const prefix = `${release.deployment.provider}:${release.id ?? "development"}`.slice(0, 80);
  return `${prefix}:${randomUUID()}`;
}

function shouldUseNeonServerlessDriver(
  databaseUrl: string,
  env: Record<string, string | undefined>,
) {
  const configuredDriver = env.AAIS_DATABASE_DRIVER?.trim().toLowerCase();
  if (configuredDriver === "pg") {
    return false;
  }
  if (configuredDriver === "neon-serverless") {
    return true;
  }
  try {
    return new URL(databaseUrl).hostname.toLowerCase().endsWith(".neon.tech");
  } catch {
    return false;
  }
}
