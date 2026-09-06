// Only an independently created, disposable Unix-socket cluster is accepted.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { createPgMigrationDatabaseClient, loadAaisPostgresMigrations,
  runAaisPostgresMigrations } from "../scripts/run-postgres-migrations.mjs";

const root = realpathSync(process.env.AAIS_TEST_POSTGRES_ROOT ?? "");
assert.match(root, /^\/(?:private\/)?tmp\/aais-pg-review-[A-Za-z0-9.]+$/);
const bin = process.env.AAIS_TEST_POSTGRES_BIN;
assert.ok(bin && path.isAbsolute(bin));
const socket = path.join(root, "socket");
const admin = new Client({ host: socket, database: "postgres", connectionTimeoutMillis: 5000 });
let app;
let migrator;
try {
  await admin.connect();
  const state = (await admin.query("select current_setting('data_directory') as data, current_setting('listen_addresses') as listen")).rows[0];
  assert.equal(realpathSync(state.data), path.join(root, "data"));
  assert.equal(state.listen, "");
  assert.equal((await admin.query("select count(*)::int as count from pg_roles where rolname in ('aais_migrator','aais_app_aliyun')")).rows[0].count, 0);
  await admin.query("create database aais");
  await admin.end();
  app = new Client({ host: socket, database: "aais", connectionTimeoutMillis: 5000 });
  await app.connect();
  // Do not rely on PostgreSQL's default PUBLIC TEMP grant.
  await app.query("revoke all on database aais from public");
  const sqlFile = (name) => execFileSync(path.join(bin, "psql"), [
    "-X", "-q", "-v", "ON_ERROR_STOP=1", "-v", "DBNAME=aais",
    "-h", socket, "-d", "aais", "-f", path.resolve("deploy/aliyun", name),
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  sqlFile("postgres-open-migrator.sql");
  migrator = new Client({ host: socket, database: "aais", user: "aais_migrator", connectionTimeoutMillis: 5000 });
  await migrator.connect();
  const database = createPgMigrationDatabaseClient({
    query: (...args) => migrator.query(...args),
    connect: async () => ({ query: (...args) => migrator.query(...args), release() {} }),
  });
  const migrations = await loadAaisPostgresMigrations();
  assert.equal(migrations.length, 29);
  // Reproduce the reviewed missing-CREATE defect without changing source files.
  await app.query("revoke create on database aais from aais_migrator");
  await assert.rejects(runAaisPostgresMigrations({ database, migrations }), { code: "42501" });
  assert.equal((await app.query("select count(*)::int as count from aais_schema_migrations")).rows[0].count, 8);
  sqlFile("postgres-open-migrator.sql");
  assert.equal((await runAaisPostgresMigrations({ database, migrations })).applied, 21);
  assert.equal((await runAaisPostgresMigrations({ database, migrations })).skipped, 29);
  await migrator.end();
  migrator = null;
  sqlFile("postgres-runtime-roles.sql");
  sqlFile("postgres-close-migrator.sql");
  const closed = (await app.query(`select rolcanlogin, rolpassword is null as cleared,
    has_database_privilege('aais_migrator','aais','CREATE') as can_create,
    has_database_privilege('aais_migrator','aais','TEMP') as can_temp,
    has_database_privilege('aais_migrator','aais','CONNECT') as can_connect
    from pg_authid where rolname='aais_migrator'`)).rows[0];
  assert.deepEqual(closed, { rolcanlogin: false, cleared: true, can_create: false, can_temp: false, can_connect: false });
  assert.equal((await app.query("select has_database_privilege('aais_app_aliyun','aais','CREATE') as ddl")).rows[0].ddl, false);
  // Closing the window must not make a subsequent guarded window unusable.
  sqlFile("postgres-open-migrator.sql");
  sqlFile("postgres-close-migrator.sql");
  assert.ok(readFileSync("deploy/aliyun/postgres-close-migrator.sql", "utf8").includes("revoke connect, create, temporary"));
  console.log(JSON.stringify({ status: "pass", missingCreateReproduced: true, migrationsApplied: 29, migrationsRechecked: 29,
    databasePrivilegesRevoked: true, applicationDDL: false,
    serverVersion: (await app.query("show server_version")).rows[0].server_version }));
} finally {
  await migrator?.end();
  await app?.end();
  await admin.end().catch(() => undefined);
}
