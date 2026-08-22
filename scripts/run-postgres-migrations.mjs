import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import { Pool } from "pg";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultMigrationsDir = path.join(repoRoot, "migrations", "postgres");

const migrationLedgerSql = `create table if not exists public.aais_schema_migrations (
  version text primary key,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null default now()
)`;
const applyMigrationFunctionSql = `create or replace function pg_temp.aais_apply_schema_migration(
  p_version text,
  p_name text,
  p_checksum text,
  p_statements text[]
)
returns text
language plpgsql
volatile
security invoker
set search_path = public, pg_catalog, pg_temp
as $aais_apply_schema_migration$
declare
  v_applied_checksum text;
  v_statement text;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('aais:schema-migration:' || p_version, 0)
  );

  select migration.checksum
    into v_applied_checksum
    from public.aais_schema_migrations migration
   where migration.version = p_version;

  if found then
    if v_applied_checksum <> p_checksum then
      raise exception 'AAIS migration checksum mismatch for %.', p_version;
    end if;
    return 'skipped';
  end if;

  foreach v_statement in array p_statements loop
    execute v_statement;
  end loop;

  insert into public.aais_schema_migrations (
    version,
    name,
    checksum,
    applied_at
  ) values (
    p_version,
    p_name,
    p_checksum,
    pg_catalog.now()
  );
  return 'applied';
end
$aais_apply_schema_migration$`;
const callApplyMigrationFunctionSql = `select pg_temp.aais_apply_schema_migration(
  $1,
  $2,
  $3,
  $4::text[]
) as status`;

export async function loadAaisPostgresMigrations(
  migrationsDir = defaultMigrationsDir,
) {
  const files = (await readdir(migrationsDir))
    .filter((file) => /^\d+_[A-Za-z0-9_-]+\.sql$/.test(file))
    .sort();
  return Promise.all(files.map(async (fileName) => {
    const sql = await readFile(path.join(migrationsDir, fileName), "utf8");
    const [version, ...nameParts] = fileName.replace(/\.sql$/, "").split("_");
    return {
      version,
      name: nameParts.join("_"),
      fileName,
      sql,
      checksum: sha256(sql),
    };
  }));
}

export async function runAaisPostgresMigrations(input) {
  const database = input.database;
  const migrations = [...input.migrations].sort((left, right) =>
    left.version.localeCompare(right.version));
  await database.query(migrationLedgerSql);
  const appliedRows = await database.query(
    "select version, checksum from public.aais_schema_migrations order by version",
  );
  const appliedChecksums = new Map(appliedRows.rows.map((row) => [
    String(row.version),
    String(row.checksum),
  ]));
  const results = [];

  for (const migration of migrations) {
    const appliedChecksum = appliedChecksums.get(migration.version);
    if (appliedChecksum) {
      if (appliedChecksum !== migration.checksum) {
        throw new Error(`AAIS migration checksum mismatch for ${migration.version}.`);
      }
      results.push(toMigrationResult(migration, "skipped"));
      continue;
    }

    const status = await applyAaisPostgresMigration(database, migration);
    appliedChecksums.set(migration.version, migration.checksum);
    results.push(toMigrationResult(migration, status));
  }

  const applied = results.filter((result) => result.status === "applied").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  return {
    schemaVersion: 1,
    status: "pass",
    applied,
    skipped,
    migrations: results,
    secrets: "redacted",
  };
}

async function applyAaisPostgresMigration(database, migration) {
  if (typeof database.transaction !== "function") {
    throw new Error("AAIS migration database client requires atomic transaction support.");
  }
  const statements = splitAaisPostgresStatements(migration.sql);
  const transactionResults = await database.transaction([
    { sql: applyMigrationFunctionSql, params: [] },
    {
      sql: callApplyMigrationFunctionSql,
      params: [
        migration.version,
        migration.name,
        migration.checksum,
        statements,
      ],
    },
  ]);
  const status = transactionResults[1]?.rows?.[0]?.status;
  if (status !== "applied" && status !== "skipped") {
    throw new Error(`AAIS migration ${migration.version} returned an invalid transaction status.`);
  }
  return status;
}

export function getAaisMigrationDatabaseConfiguration(env = process.env) {
  const urlEnvNames = [
    "AAIS_DATABASE_URL",
    "DATABASE_URL",
    "POSTGRES_URL",
    "POSTGRES_PRISMA_URL",
    "POSTGRES_URL_NO_SSL",
    "DATABASE_URL_UNPOOLED",
    "POSTGRES_URL_NON_POOLING",
  ];
  for (const sourceEnv of urlEnvNames) {
    const url = env[sourceEnv]?.trim();
    if (url) {
      return { url, sourceEnv };
    }
  }
  return getRawPgDatabaseConfiguration(env, {
    hostNames: ["PGHOST", "PGHOST_UNPOOLED"],
    userName: "PGUSER",
    databaseName: "PGDATABASE",
    passwordName: "PGPASSWORD",
    portName: "PGPORT",
    sslmodeName: "PGSSLMODE",
    sourceEnv: "PG*",
  }) ?? getRawPgDatabaseConfiguration(env, {
    hostNames: ["POSTGRES_HOST", "POSTGRES_HOST_NON_POOLING"],
    userName: "POSTGRES_USER",
    databaseName: "POSTGRES_DATABASE",
    passwordName: "POSTGRES_PASSWORD",
    portName: "POSTGRES_PORT",
    sslmodeName: "POSTGRES_SSLMODE",
    sourceEnv: "POSTGRES_*",
  });
}

export function getAaisResearchMigrationDatabaseConfiguration(env = process.env) {
  const url = env.AAIS_RESEARCH_DATABASE_URL?.trim();
  return url
    ? { url, sourceEnv: "AAIS_RESEARCH_DATABASE_URL" }
    : null;
}

function getRawPgDatabaseConfiguration(env, input) {
  const host = input.hostNames.map((name) => env[name]?.trim()).find(Boolean);
  const user = env[input.userName]?.trim();
  const database = env[input.databaseName]?.trim();
  const password = env[input.passwordName]?.trim();
  if (!host || !user || !database || !password) {
    return null;
  }
  const url = new URL("postgres://localhost");
  url.hostname = host;
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  if (env[input.portName]?.trim()) {
    url.port = env[input.portName].trim();
  }
  url.searchParams.set("sslmode", env[input.sslmodeName]?.trim() || "require");
  return {
    url: url.toString(),
    sourceEnv: input.sourceEnv,
  };
}

function toMigrationResult(migration, status) {
  return {
    version: migration.version,
    name: migration.name,
    fileName: migration.fileName,
    status,
    checksum: migration.checksum.slice(0, 12),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function splitAaisPostgresStatements(sql) {
  const statements = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let lineComment = false;
  let blockComment = false;
  let dollarQuoteTag = "";

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1] ?? "";

    if (lineComment) {
      current += char;
      if (char === "\n") {
        lineComment = false;
      }
      continue;
    }

    if (blockComment) {
      current += char;
      if (char === "*" && next === "/") {
        current += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }

    if (dollarQuoteTag) {
      if (sql.startsWith(dollarQuoteTag, index)) {
        current += dollarQuoteTag;
        index += dollarQuoteTag.length - 1;
        dollarQuoteTag = "";
        continue;
      }
      current += char;
      continue;
    }

    if (inSingleQuote) {
      current += char;
      if (char === "'" && next === "'") {
        current += next;
        index += 1;
      } else if (char === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      current += char;
      if (char === "\"" && next === "\"") {
        current += next;
        index += 1;
      } else if (char === "\"") {
        inDoubleQuote = false;
      }
      continue;
    }

    if (char === "-" && next === "-") {
      current += char + next;
      index += 1;
      lineComment = true;
      continue;
    }

    if (char === "/" && next === "*") {
      current += char + next;
      index += 1;
      blockComment = true;
      continue;
    }

    if (char === "'") {
      current += char;
      inSingleQuote = true;
      continue;
    }

    if (char === "\"") {
      current += char;
      inDoubleQuote = true;
      continue;
    }

    if (char === "$") {
      const match = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        dollarQuoteTag = match[0];
        current += dollarQuoteTag;
        index += dollarQuoteTag.length - 1;
        continue;
      }
    }

    if (char === ";") {
      const statement = current.trim();
      if (statement) {
        statements.push(statement);
      }
      current = "";
      continue;
    }

    current += char;
  }

  const finalStatement = current.trim();
  if (finalStatement) {
    statements.push(finalStatement);
  }
  return statements;
}

function parseArgs(argv) {
  const options = {
    migrationsDir: defaultMigrationsDir,
    output: "",
    research: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--migrations-dir") {
      options.migrationsDir = path.resolve(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg === "--output") {
      options.output = path.resolve(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg === "--research") {
      options.research = true;
      continue;
    }
    throw new Error(`Unknown AAIS migration argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write([
      "Usage: npm run db:migrate -- [--research] [--migrations-dir <dir>] [--output <report.json>]",
      "",
      "Applies tracked AAIS Postgres migrations and writes only redacted status summaries.",
      "--research reads only AAIS_RESEARCH_DATABASE_URL and never falls back to the product database.",
      "",
    ].join("\n"));
    return;
  }
  const config = options.research
    ? getAaisResearchMigrationDatabaseConfiguration()
    : getAaisMigrationDatabaseConfiguration();
  if (!config) {
    throw new Error(options.research
      ? "AAIS research migrations require AAIS_RESEARCH_DATABASE_URL."
      : "AAIS Postgres migrations require a configured Postgres database environment.");
  }
  const pool = createAaisMigrationDatabaseClient(
    config.url,
    options.research
      ? process.env.AAIS_RESEARCH_DATABASE_DRIVER
      : process.env.AAIS_DATABASE_DRIVER,
  );
  try {
    const migrations = await loadAaisPostgresMigrations(options.migrationsDir);
    const report = await runAaisPostgresMigrations({
      database: pool,
      migrations,
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
      applied: output.applied,
      skipped: output.skipped,
      sourceEnv: output.sourceEnv,
      secrets: "redacted",
    }) + "\n");
  } finally {
    await pool.end();
  }
}

function createAaisMigrationDatabaseClient(databaseUrl, configuredDriver) {
  if (shouldUseNeonServerlessDriver(databaseUrl, configuredDriver)) {
    return createNeonServerlessMigrationDatabaseClient(databaseUrl);
  }
  return createPgMigrationDatabaseClient(new Pool({ connectionString: databaseUrl }));
}

export function createPgMigrationDatabaseClient(pool) {
  return {
    async query(query, params = []) {
      return normalizeDatabaseQueryResult(await pool.query(query, params));
    },
    async transaction(queries) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const results = [];
        for (const query of queries) {
          results.push(normalizeDatabaseQueryResult(
            await client.query(query.sql, query.params ?? []),
          ));
        }
        await client.query("commit");
        return results;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async end() {
      await pool.end();
    },
  };
}

function createNeonServerlessMigrationDatabaseClient(databaseUrl) {
  const sql = neon(databaseUrl);
  return {
    async query(query, params = []) {
      const result = await sql.query(query, params);
      return normalizeDatabaseQueryResult(result);
    },
    async transaction(queries) {
      const results = await sql.transaction((txn) =>
        queries.map((query) => txn.query(query.sql, query.params ?? [])));
      return results.map(normalizeDatabaseQueryResult);
    },
    async end() {},
  };
}

function normalizeDatabaseQueryResult(result) {
  if (Array.isArray(result)) {
    return { rows: result };
  }
  if (result && typeof result === "object" && Array.isArray(result.rows)) {
    return { rows: result.rows };
  }
  return { rows: [] };
}

function shouldUseNeonServerlessDriver(databaseUrl, configuredDriverValue) {
  const configuredDriver = configuredDriverValue?.trim().toLowerCase();
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS Postgres migration failed."}\n`);
    process.exitCode = 1;
  });
}
