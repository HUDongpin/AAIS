#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { getAaisMigrationDatabaseConfiguration } from "./run-postgres-migrations.mjs";

export async function cleanupAaisRetentionRows(input) {
  const database = input.database;
  const dryRun = input.dryRun !== false;
  const now = input.now ?? new Date();
  const counts = dryRun
    ? await countExpiredRows(database, now)
    : await deleteExpiredRows(database, now);

  return {
    schemaVersion: 1,
    status: "pass",
    dryRun,
    checkedAt: now.toISOString(),
    expiredRows: counts,
    retention: {
      authTokens: "expires_at <= checkedAt",
      sessionRevocations: "expires_at <= checkedAt",
      loginRateLimits: "expires_at <= checkedAt",
    },
    redaction: {
      rowIds: "omitted",
      accountKeys: "omitted",
      tokenHashes: "omitted",
      databaseUrl: "omitted",
    },
    secrets: "redacted",
  };
}

async function countExpiredRows(database, now) {
  const [authTokens, sessionRevocations, loginRateLimits] = await Promise.all([
    countRows(database, `
      select count(*)::int as count
        from aais_user_auth_tokens
       where expires_at <= $1::timestamptz`,
    [now]),
    countRows(database, `
      select count(*)::int as count
        from aais_session_revocations
       where expires_at <= $1::timestamptz`,
    [now]),
    countRows(database, `
      select count(*)::int as count
        from aais_login_rate_limits
       where expires_at <= $1::timestamptz`,
    [now]),
  ]);
  return {
    authTokens,
    sessionRevocations,
    loginRateLimits,
  };
}

async function deleteExpiredRows(database, now) {
  const [authTokens, sessionRevocations, loginRateLimits] = await Promise.all([
    deleteRows(database, `
      with deleted as (
        delete from aais_user_auth_tokens
         where expires_at <= $1::timestamptz
         returning id
      )
      select count(*)::int as count from deleted`,
    [now]),
    deleteRows(database, `
      with deleted as (
        delete from aais_session_revocations
         where expires_at <= $1::timestamptz
         returning token_hash
      )
      select count(*)::int as count from deleted`,
    [now]),
    deleteRows(database, `
      with deleted as (
        delete from aais_login_rate_limits
         where expires_at <= $1::timestamptz
         returning rate_limit_key
      )
      select count(*)::int as count from deleted`,
    [now]),
  ]);
  return {
    authTokens,
    sessionRevocations,
    loginRateLimits,
  };
}

async function countRows(database, sql, params) {
  const result = await database.query(sql, params);
  return Number(result.rows[0]?.count ?? 0);
}

async function deleteRows(database, sql, params) {
  const result = await database.query(sql, params);
  return Number(result.rows[0]?.count ?? 0);
}

function parseArgs(argv) {
  const options = {
    dryRun: true,
    approved: false,
    output: "",
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--approved") {
      options.approved = true;
      options.dryRun = false;
      continue;
    }
    if (arg === "--output") {
      options.output = path.resolve(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    throw new Error(`Unknown AAIS retention cleanup argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  process.stdout.write([
    "Usage: npm run db:cleanup -- [--dry-run] [--approved] [--output report.json]",
    "",
    "Cleans expired AAIS security rows from Postgres without reading secrets:",
    "  - aais_user_auth_tokens where expires_at has passed",
    "  - aais_session_revocations where expires_at has passed",
    "  - aais_login_rate_limits where expires_at has passed",
    "",
    "Default mode is --dry-run. Use --approved to delete rows.",
    "",
  ].join("\n"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.dryRun && !options.approved) {
    throw new Error("AAIS retention cleanup deletion requires --approved.");
  }
  const config = getAaisMigrationDatabaseConfiguration();
  if (!config) {
    throw new Error("AAIS retention cleanup requires a configured Postgres database environment.");
  }
  const pool = new Pool({ connectionString: config.url });
  try {
    const report = await cleanupAaisRetentionRows({
      database: pool,
      dryRun: options.dryRun,
    });
    const output = {
      ...report,
      sourceEnv: config.sourceEnv,
    };
    if (options.output) {
      await writeFile(options.output, `${JSON.stringify(output, null, 2)}\n`);
    }
    process.stdout.write(JSON.stringify({
      status: output.status,
      dryRun: output.dryRun,
      expiredRows: output.expiredRows,
      sourceEnv: output.sourceEnv,
      secrets: "redacted",
    }) + "\n");
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS retention cleanup failed."}\n`);
    process.exitCode = 1;
  });
}
