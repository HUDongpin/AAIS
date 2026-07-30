#!/usr/bin/env node

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "pg";

const requiredRestorePurpose = "restored-staging";
const researchRestoreDatabaseEnv = "AAIS_RESEARCH_RESTORE_DATABASE_URL";
const researchRestoreIdentityKeyEnv =
  "AAIS_RESEARCH_RESTORE_IDENTITY_ENCRYPTION_KEY";
const requiredTables = [
  "aais_learner_sessions",
  "aais_lrs_outbox",
  "aais_login_rate_limits",
  "aais_events",
  "aais_learner_task_state",
  "aais_users",
  "aais_user_auth_tokens",
  "aais_session_revocations",
  "aais_courses",
  "aais_course_tasks",
  "aais_enrollments",
];
const requiredResearchTables = [
  {
    name: "aais_research_participants",
    relation: "public.aais_research_participants",
  },
  {
    name: "aais_research_identity.aais_research_identity_map",
    relation: "aais_research_identity.aais_research_identity_map",
  },
  {
    name: "aais_research_identity.aais_research_participation_ledger",
    relation: "aais_research_identity.aais_research_participation_ledger",
  },
  {
    name: "aais_research_visits",
    relation: "public.aais_research_visits",
  },
  {
    name: "aais_research_raw_write_leases",
    relation: "public.aais_research_raw_write_leases",
  },
  {
    name: "aais_research_events",
    relation: "public.aais_research_events",
  },
  {
    name: "aais_research_lrs_outbox",
    relation: "public.aais_research_lrs_outbox",
  },
  {
    name: "aais_research_export_audit",
    relation: "public.aais_research_export_audit",
  },
  {
    name: "aais_research_withdrawals",
    relation: "public.aais_research_withdrawals",
  },
  {
    name: "aais_research_lrs_deletions",
    relation: "public.aais_research_lrs_deletions",
  },
  {
    name: "aais_research_retention_runs",
    relation: "public.aais_research_retention_runs",
  },
  {
    name: "aais_research_legacy_archives",
    relation: "public.aais_research_legacy_archives",
  },
];
const requiredResearchConstraints = [
  "aais_research_identity_scope_key_iv_unique",
  "aais_research_participation_scope_fingerprint_unique",
  "aais_research_participation_scope_run_unique",
  "aais_research_participation_scope_visit_unique",
  "aais_research_participation_scope_key_iv_unique",
];
const requiredResearchColumns = [
  ["aais_research_export_audit", "schema_version"],
  ["aais_research_export_audit", "commit_sha"],
  ["aais_research_export_audit", "retention_due_at"],
  ["aais_research_retention_runs", "retention_due_at"],
  ["aais_research_lrs_deletions", "retention_due_at"],
  ["aais_research_lrs_deletions", "receipt_sha256"],
  ["aais_research_lrs_deletions", "provider_absence_confirmed_at"],
  ["aais_research_lrs_deletions", "provider_receipt_key_id"],
  ["aais_research_lrs_deletions", "provider_receipt_signature"],
  ["aais_research_legacy_archives", "retention_due_at"],
  ["aais_research_participation_ledger", "admission_fingerprint"],
  ["aais_research_participation_ledger", "identity_key_version"],
  ["aais_research_participation_ledger", "identity_iv"],
];
const requiredResearchFunctions = [
  {
    name: "aais_research_detail_is_safe",
    signature: "public.aais_research_detail_is_safe(jsonb)",
  },
  {
    name: "aais_research_apply_fact_retention",
    signature:
      "public.aais_research_apply_fact_retention(text,text,text,text,text,timestamp with time zone,integer)",
  },
  {
    name: "aais_research_create_visit",
    signature:
      "public.aais_research_create_visit(text,text,text,text,uuid,uuid,uuid,text,bytea,bytea,bytea,text,text[],integer,timestamp with time zone,timestamp with time zone)",
  },
  {
    name: "aais_research_record_event",
    signature:
      "public.aais_research_record_event(text,text,text,text,text,uuid,uuid,uuid,integer,text,text,timestamp with time zone,timestamp with time zone,text,text,integer,jsonb,timestamp with time zone)",
  },
  {
    name: "aais_research_acquire_raw_write_lease",
    signature:
      "public.aais_research_acquire_raw_write_lease(text,text,text,text,text,uuid,timestamp with time zone,timestamp with time zone)",
  },
  {
    name: "aais_research_begin_withdrawal",
    signature:
      "public.aais_research_begin_withdrawal(text,text,text,text,uuid,timestamp with time zone)",
  },
  {
    name: "aais_research_complete_visit",
    signature:
      "public.aais_research_complete_visit(text,text,text,text,uuid,timestamp with time zone,timestamp with time zone)",
  },
  {
    name: "aais_research_withdraw",
    signature:
      "public.aais_research_withdraw(text,text,text,text,uuid,uuid,text,boolean,text,timestamp with time zone)",
  },
];

export async function runAaisPostgresRestoreVerification(input = {}) {
  const checkedAt = new Date().toISOString();
  const targetPurpose = String(input.targetPurpose ?? "").trim();
  const issues = [];
  if (targetPurpose !== requiredRestorePurpose) {
    issues.push("AAIS_RESTORE_TARGET_PURPOSE");
  }

  const tableReport = await checkRequiredTables(input.database);
  if (!tableReport.present) {
    issues.push("AAIS_RESTORE_SCHEMA");
  }

  const rowCounts = tableReport.present
    ? await readRestoreRowCounts(input.database)
    : {
        learnerSessions: null,
        lrsOutbox: null,
        events: null,
        learnerTaskState: null,
        users: null,
        courses: null,
        courseTasks: null,
        enrollments: null,
      };
  const smoke = tableReport.present && targetPurpose === requiredRestorePurpose
    ? await runRolledBackSyntheticInsert(input.database, checkedAt)
    : {
        status: "skipped",
        insertAccepted: false,
        rolledBack: false,
      };
  if (smoke.status !== "passed") {
    issues.push("AAIS_RESTORE_SMOKE_INSERT");
  }

  return {
    schemaVersion: 1,
    status: issues.length ? "failed" : "passed",
    checkedAt,
    targetPurpose: targetPurpose || null,
    sourceEnv: input.sourceEnv ?? null,
    releaseId: normalizeOptionalString(input.releaseId),
    checks: {
      targetPurpose: {
        status: targetPurpose === requiredRestorePurpose ? "passed" : "failed",
        required: requiredRestorePurpose,
      },
      requiredTables: tableReport,
      rowCounts,
      smokeInsert: smoke,
    },
    issues,
    redaction: {
      databaseUrl: "omitted",
      learnerPayload: "synthetic-only",
      learnerIdentifiers: "omitted",
      secrets: "redacted",
    },
  };
}

export async function runAaisResearchPostgresRestoreVerification(input = {}) {
  const checkedAt = new Date().toISOString();
  const targetPurpose = String(input.targetPurpose ?? "").trim();
  const issues = [];
  if (targetPurpose !== requiredRestorePurpose) {
    issues.push("AAIS_RESEARCH_RESTORE_TARGET_PURPOSE");
  }

  const migration = await checkResearchMigration0009(input.database);
  if (migration.status !== "passed") {
    issues.push("AAIS_RESEARCH_RESTORE_MIGRATION_0009");
  }

  const [tableReport, functionReport, constraintReport, columnReport] = await Promise.all([
    checkRequiredResearchTables(input.database),
    checkRequiredResearchFunctions(input.database),
    checkRequiredResearchConstraints(input.database),
    checkRequiredResearchColumns(input.database),
  ]);
  if (!tableReport.present || !functionReport.present || !constraintReport.present
    || !columnReport.present) {
    issues.push("AAIS_RESEARCH_RESTORE_SCHEMA");
  }

  const schemaReady = migration.status === "passed"
    && tableReport.present
    && functionReport.present
    && constraintReport.present
    && columnReport.present;
  const rowCounts = tableReport.present
    ? await readResearchRestoreRowCounts(input.database)
    : emptyResearchRowCounts();
  const identityStructure = tableReport.present
    ? await checkResearchIdentityStructure(input.database)
    : skippedCheck("required research tables are missing");
  if (identityStructure.status !== "passed") {
    issues.push("AAIS_RESEARCH_RESTORE_IDENTITY_STRUCTURE");
  }

  const eventSequence = tableReport.present
    ? await checkResearchEventSequence(input.database)
    : skippedCheck("required research tables are missing");
  if (eventSequence.status !== "passed") {
    issues.push("AAIS_RESEARCH_RESTORE_EVENT_SEQUENCE");
  }

  const eventOutboxSet = tableReport.present
    ? await checkResearchEventOutboxSet(input.database)
    : skippedCheck("required research tables are missing");
  if (eventOutboxSet.status !== "passed") {
    issues.push("AAIS_RESEARCH_RESTORE_EVENT_OUTBOX_SET");
  }

  const withdrawalTombstones = tableReport.present
    ? await checkResearchWithdrawalTombstones(input.database)
    : skippedCheck("required research tables are missing");
  if (withdrawalTombstones.status !== "passed") {
    issues.push("AAIS_RESEARCH_RESTORE_WITHDRAWAL_TOMBSTONES");
  }

  const identityKey = parseIndependentResearchIdentityKey(
    input.identityEncryptionKey,
  );
  if (identityKey.status === "invalid") {
    issues.push("AAIS_RESEARCH_RESTORE_IDENTITY_KEY");
  }

  const syntheticFixture = schemaReady
    && targetPurpose === requiredRestorePurpose
    ? await runRolledBackResearchSyntheticFixture(input.database, {
        checkedAt,
        identityKey,
      })
    : skippedResearchSyntheticFixture(
        schemaReady
          ? "restore target purpose is not approved"
          : "required research migration objects are missing",
        identityKey.status,
      );
  if (syntheticFixture.status !== "passed") {
    issues.push("AAIS_RESEARCH_RESTORE_SYNTHETIC_FIXTURE");
  }
  if (syntheticFixture.identityDecryption.status === "failed") {
    issues.push("AAIS_RESEARCH_RESTORE_IDENTITY_DECRYPTION");
  }
  if (syntheticFixture.withdrawalTombstone.status === "failed") {
    issues.push("AAIS_RESEARCH_RESTORE_TOMBSTONE_REENROLLMENT");
  }

  return {
    schemaVersion: 1,
    mode: "research",
    status: issues.length ? "failed" : "passed",
    checkedAt,
    targetPurpose: targetPurpose || null,
    sourceEnv: input.sourceEnv === researchRestoreDatabaseEnv
      ? researchRestoreDatabaseEnv
      : null,
    releaseId: normalizeOptionalString(input.releaseId),
    checks: {
      targetPurpose: {
        status: targetPurpose === requiredRestorePurpose ? "passed" : "failed",
        required: requiredRestorePurpose,
      },
      migration0009: migration,
      requiredTables: tableReport,
      requiredFunctions: functionReport,
      requiredConstraints: constraintReport,
      requiredColumns: columnReport,
      rowCounts,
      identityStructure,
      eventSequence,
      eventOutboxSet,
      withdrawalTombstones,
      syntheticFixture,
    },
    issues: [...new Set(issues)],
    redaction: {
      databaseUrl: "omitted",
      identityPlaintext: "synthetic-only-omitted",
      identityCiphertext: "omitted",
      identityKey: "omitted",
      participantIdentifiers: "omitted",
      rawText: "not-collected",
      externalLrs: "not-contacted",
      secrets: "redacted",
    },
  };
}

export function getAaisRestoreDatabaseConfiguration(env = process.env) {
  const candidates = [
    "AAIS_RESTORE_DATABASE_URL",
    "RESTORE_DATABASE_URL",
  ];
  for (const sourceEnv of candidates) {
    const url = env[sourceEnv]?.trim();
    if (url) {
      return { url, sourceEnv };
    }
  }
  return null;
}

export function getAaisResearchRestoreDatabaseConfiguration(env = process.env) {
  const url = env[researchRestoreDatabaseEnv]?.trim();
  return url
    ? { url, sourceEnv: researchRestoreDatabaseEnv }
    : null;
}

export async function loadAaisRestoreEnvFile(envFilePath) {
  if (!envFilePath) {
    return {};
  }
  const raw = await readFile(envFilePath, "utf8");
  return parseAaisEnvFile(raw);
}

export function parseAaisEnvFile(raw) {
  const values = {};
  for (const line of String(raw).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const separator = normalized.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = normalized.slice(0, separator).trim();
    const value = normalized.slice(separator + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    values[key] = stripEnvQuotes(value);
  }
  return values;
}

async function checkResearchMigration0009(database) {
  const migrationSql = await readFile(
    resolveResearchMigrationPath(),
    "utf8",
  );
  const expectedChecksum = createHash("sha256").update(migrationSql).digest("hex");
  const ledgerResult = await database.query(
    `/* aais_restore_research_migration_ledger */
     select to_regclass('public.aais_schema_migrations') as migration_ledger`,
  );
  if (!ledgerResult.rows[0]?.migration_ledger) {
    return {
      status: "failed",
      version: "0009",
      ledgerEntry: false,
      nameMatched: false,
      checksumMatched: false,
    };
  }
  const result = await database.query(
    `/* aais_restore_research_migration_0009 */
     select name, checksum = $1 as checksum_matches
     from aais_schema_migrations
     where version = '0009'`,
    [expectedChecksum],
  );
  const row = result.rows[0] ?? null;
  const ledgerEntry = row !== null;
  const nameMatched = row?.name === "aais_research_study";
  const checksumMatched = row?.checksum_matches === true;
  return {
    status: ledgerEntry && nameMatched && checksumMatched ? "passed" : "failed",
    version: "0009",
    ledgerEntry,
    nameMatched,
    checksumMatched,
  };
}

function resolveResearchMigrationPath() {
  return import.meta.url.startsWith("file:")
    ? path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../migrations/postgres/0009_aais_research_study.sql",
      )
    : path.resolve("migrations/postgres/0009_aais_research_study.sql");
}

async function checkRequiredResearchTables(database) {
  const selections = requiredResearchTables.map((table, index) =>
    `to_regclass('${table.relation}') as research_table_${index}`);
  const result = await database.query(
    `/* aais_restore_research_tables */ select\n       ${selections.join(",\n       ")}`,
  );
  const row = result.rows[0] ?? {};
  const tables = Object.fromEntries(requiredResearchTables.map((table, index) => [
    table.name,
    row[`research_table_${index}`] !== null
      && row[`research_table_${index}`] !== undefined,
  ]));
  const missing = requiredResearchTables
    .map((table) => table.name)
    .filter((name) => !tables[name]);
  return {
    status: missing.length ? "failed" : "passed",
    present: missing.length === 0,
    tables,
    missing,
  };
}

async function checkRequiredResearchFunctions(database) {
  const selections = requiredResearchFunctions.map((researchFunction, index) =>
    `to_regprocedure('${researchFunction.signature}') as research_function_${index}`);
  const result = await database.query(
    `/* aais_restore_research_functions */ select\n       ${selections.join(",\n       ")}`,
  );
  const row = result.rows[0] ?? {};
  const functions = Object.fromEntries(requiredResearchFunctions.map((researchFunction, index) => [
    researchFunction.name,
    row[`research_function_${index}`] !== null
      && row[`research_function_${index}`] !== undefined,
  ]));
  const missing = requiredResearchFunctions
    .map((researchFunction) => researchFunction.name)
    .filter((functionName) => !functions[functionName]);
  return {
    status: missing.length ? "failed" : "passed",
    present: missing.length === 0,
    functions,
    missing,
  };
}

async function checkRequiredResearchConstraints(database) {
  const result = await database.query(
    `/* aais_restore_research_constraints */
     select c.conname
     from pg_constraint c
     join pg_namespace n on n.oid = c.connamespace
     where n.nspname = 'aais_research_identity'
       and c.contype = 'u'
       and c.conname = any($1::text[])
     order by c.conname`,
    [requiredResearchConstraints],
  );
  const presentNames = new Set(result.rows.map((row) => String(row.conname ?? "")));
  const missing = requiredResearchConstraints.filter((name) => !presentNames.has(name));
  return {
    status: missing.length ? "failed" : "passed",
    present: missing.length === 0,
    constraints: Object.fromEntries(requiredResearchConstraints.map((name) => [
      name,
      presentNames.has(name),
    ])),
    missing,
  };
}

async function checkRequiredResearchColumns(database) {
  const result = await database.query(
    `/* aais_restore_research_columns */
     select table_schema, table_name, column_name
     from information_schema.columns
     where (table_schema = 'public' and table_name = any($1::text[]))
        or (table_schema = 'aais_research_identity'
          and table_name = 'aais_research_participation_ledger')`,
    [[
      "aais_research_export_audit",
      "aais_research_retention_runs",
      "aais_research_lrs_deletions",
      "aais_research_legacy_archives",
    ]],
  );
  const presentNames = new Set(result.rows.map((row) => [
    String(row.table_name ?? ""),
    String(row.column_name ?? ""),
  ].join(".")));
  const requiredNames = requiredResearchColumns.map(([table, column]) =>
    `${table}.${column}`);
  const missing = requiredNames.filter((name) => !presentNames.has(name));
  return {
    status: missing.length ? "failed" : "passed",
    present: missing.length === 0,
    columns: Object.fromEntries(requiredNames.map((name) => [name, presentNames.has(name)])),
    missing,
  };
}

async function readResearchRestoreRowCounts(database) {
  const result = await database.query(
    `/* aais_restore_research_row_counts */
     select
       (select count(*)::int from aais_research_participants) as participants,
       (select count(*)::int from aais_research_identity.aais_research_identity_map) as identity_maps,
       (select count(*)::int from aais_research_identity.aais_research_participation_ledger) as participation_ledgers,
       (select count(*)::int from aais_research_visits) as visits,
       (select count(*)::int from aais_research_raw_write_leases) as raw_write_leases,
       (select count(*)::int from aais_research_events) as events,
       (select count(*)::int from aais_research_lrs_outbox) as lrs_outbox,
       (select count(*)::int from aais_research_export_audit) as export_audits,
       (select count(*)::int from aais_research_withdrawals) as withdrawals,
       (select count(*)::int from aais_research_lrs_deletions) as lrs_deletions,
       (select count(*)::int from aais_research_retention_runs) as retention_runs,
       (select count(*)::int from aais_research_legacy_archives) as legacy_archives`,
  );
  const row = result.rows[0] ?? {};
  return {
    participants: normalizeCount(row.participants),
    identityMaps: normalizeCount(row.identity_maps),
    participationLedgers: normalizeCount(row.participation_ledgers),
    visits: normalizeCount(row.visits),
    rawWriteLeases: normalizeCount(row.raw_write_leases),
    events: normalizeCount(row.events),
    lrsOutbox: normalizeCount(row.lrs_outbox),
    exportAudits: normalizeCount(row.export_audits),
    withdrawals: normalizeCount(row.withdrawals),
    lrsDeletions: normalizeCount(row.lrs_deletions),
    retentionRuns: normalizeCount(row.retention_runs),
    legacyArchives: normalizeCount(row.legacy_archives),
  };
}

async function checkResearchIdentityStructure(database) {
  const result = await database.query(
    `/* aais_restore_research_identity_structure */
     select
       count(*)::int as inspected_rows,
       count(*) filter (where octet_length(i.ciphertext) < 1)::int as invalid_ciphertext,
       count(*) filter (where octet_length(i.iv) <> 12)::int as invalid_iv,
       count(*) filter (where octet_length(i.authentication_tag) <> 16)::int as invalid_authentication_tag,
       count(*) filter (
         where i.key_version !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
       )::int as invalid_key_version,
       count(*) filter (
         where p.participant_id is null
           or p.project_id <> i.project_id
           or p.study_id <> i.study_id
           or p.environment <> i.environment
           or p.lrs_namespace <> i.lrs_namespace
       )::int as invalid_participant_scope,
       (select count(*)::int
        from aais_research_identity.aais_research_participation_ledger a
        where a.admission_fingerprint !~ '^[0-9a-f]{64}$') as invalid_admission_fingerprint,
       (select count(*)::int
        from aais_research_identity.aais_research_participation_ledger a
        left join aais_research_visits v
          on v.visit_id = a.visit_id
          and v.participant_id = a.participant_id
          and v.study_run_id = a.study_run_id
          and v.project_id = a.project_id
          and v.study_id = a.study_id
          and v.environment = a.environment
          and v.lrs_namespace = a.lrs_namespace
        where v.visit_id is null) as invalid_participation_scope,
       (select count(*)::int
        from aais_research_visits v
        left join aais_research_identity.aais_research_participation_ledger a
          on a.visit_id = v.visit_id
          and a.participant_id = v.participant_id
          and a.study_run_id = v.study_run_id
          and a.project_id = v.project_id
          and a.study_id = v.study_id
          and a.environment = v.environment
          and a.lrs_namespace = v.lrs_namespace
        where a.visit_id is null) as visits_without_participation,
       (select coalesce(sum(duplicate_count - 1), 0)::int
        from (
          select count(*) as duplicate_count
          from aais_research_identity.aais_research_identity_map nonce
          group by nonce.project_id, nonce.study_id, nonce.environment,
            nonce.lrs_namespace, nonce.key_version, nonce.iv
          having count(*) > 1
        ) duplicates) as identity_nonce_collisions,
       (select coalesce(sum(duplicate_count - 1), 0)::int
        from (
          select count(*) as duplicate_count
          from aais_research_identity.aais_research_participation_ledger nonce
          group by nonce.project_id, nonce.study_id, nonce.environment,
            nonce.lrs_namespace, nonce.identity_key_version, nonce.identity_iv
          having count(*) > 1
        ) duplicates) as participation_nonce_collisions,
       (select count(*)::int
        from aais_research_visits active_visit
        left join aais_research_identity.aais_research_identity_map active_identity
          on active_identity.participant_id = active_visit.participant_id
          and active_identity.project_id = active_visit.project_id
          and active_identity.study_id = active_visit.study_id
          and active_identity.environment = active_visit.environment
          and active_identity.lrs_namespace = active_visit.lrs_namespace
        where active_visit.status = 'active'
          and active_identity.participant_id is null) as active_visits_without_identity
     from aais_research_identity.aais_research_identity_map i
     left join aais_research_participants p on p.participant_id = i.participant_id`,
  );
  const row = result.rows[0] ?? {};
  const invalid = {
    ciphertext: normalizeCount(row.invalid_ciphertext),
    iv: normalizeCount(row.invalid_iv),
    authenticationTag: normalizeCount(row.invalid_authentication_tag),
    keyVersion: normalizeCount(row.invalid_key_version),
    admissionFingerprint: normalizeCount(row.invalid_admission_fingerprint),
    participantScope: normalizeCount(row.invalid_participant_scope),
    participationScope: normalizeCount(row.invalid_participation_scope),
    visitWithoutParticipation: normalizeCount(row.visits_without_participation),
    identityNonceCollision: normalizeCount(row.identity_nonce_collisions),
    participationNonceCollision: normalizeCount(row.participation_nonce_collisions),
    activeVisitWithoutIdentity: normalizeCount(
      row.active_visits_without_identity,
    ),
  };
  const invalidCount = Object.values(invalid).reduce((sum, count) => sum + count, 0);
  return {
    status: invalidCount === 0 ? "passed" : "failed",
    inspectedRows: normalizeCount(row.inspected_rows),
    invalid,
  };
}

async function checkResearchEventSequence(database) {
  const result = await database.query(
    `/* aais_restore_research_event_sequence */
     with ordered_events as (
       select e.visit_id, e.event_sequence,
         min(e.event_sequence) over (
           partition by e.project_id, e.study_id, e.environment, e.lrs_namespace, e.visit_id
         ) + row_number() over (
           partition by e.project_id, e.study_id, e.environment, e.lrs_namespace, e.visit_id
           order by e.event_sequence
         ) - 1 as expected_sequence
       from aais_research_events e
     ), sequence_gaps as (
       select distinct visit_id
       from ordered_events
       where event_sequence <> expected_sequence
     ), visit_maximums as (
       select e.visit_id, max(e.event_sequence) as maximum_sequence
       from aais_research_events e
       group by e.visit_id
     )
     select
       (select count(*)::int from aais_research_events) as event_count,
       (select count(*)::int from sequence_gaps) as visits_with_gaps,
       count(*) filter (
         where v.status <> 'withdrawn'
           and v.next_event_sequence <> coalesce(m.maximum_sequence, 0) + 1
       )::int as visits_with_next_sequence_mismatch
     from aais_research_visits v
     left join visit_maximums m on m.visit_id = v.visit_id`,
  );
  const row = result.rows[0] ?? {};
  const visitsWithGaps = normalizeCount(row.visits_with_gaps);
  const visitsWithNextSequenceMismatch = normalizeCount(
    row.visits_with_next_sequence_mismatch,
  );
  return {
    status: visitsWithGaps === 0 && visitsWithNextSequenceMismatch === 0
      ? "passed"
      : "failed",
    eventCount: normalizeCount(row.event_count),
    visitsWithGaps,
    visitsWithNextSequenceMismatch,
  };
}

async function checkResearchEventOutboxSet(database) {
  const result = await database.query(
    `/* aais_restore_research_event_outbox_set */
     select
       (select count(*)::int from aais_research_events) as event_count,
       (select count(*)::int from aais_research_lrs_outbox) as outbox_count,
       count(*) filter (where o.event_id is null)::int as events_without_outbox,
       count(*) filter (where e.event_id is null)::int as outbox_without_events,
       count(*) filter (
         where e.event_id is not null and o.statement_id <> e.event_id
       )::int as statement_id_mismatches,
       count(*) filter (
         where e.event_id is not null and o.event_id is not null and (
           e.project_id <> o.project_id
           or e.study_id <> o.study_id
           or e.environment <> o.environment
           or e.lrs_namespace <> o.lrs_namespace
           or e.lrs_eligible <> o.lrs_eligible
         )
       )::int as scope_or_eligibility_mismatches
     from aais_research_events e
     full outer join aais_research_lrs_outbox o on o.event_id = e.event_id`,
  );
  const row = result.rows[0] ?? {};
  const eventCount = normalizeCount(row.event_count);
  const outboxCount = normalizeCount(row.outbox_count);
  const differences = {
    eventsWithoutOutbox: normalizeCount(row.events_without_outbox),
    outboxWithoutEvents: normalizeCount(row.outbox_without_events),
    statementIdMismatches: normalizeCount(row.statement_id_mismatches),
    scopeOrEligibilityMismatches: normalizeCount(
      row.scope_or_eligibility_mismatches,
    ),
  };
  const differenceCount = Object.values(differences)
    .reduce((sum, count) => sum + count, 0);
  return {
    status: eventCount === outboxCount && differenceCount === 0
      ? "passed"
      : "failed",
    eventCount,
    outboxCount,
    differences,
  };
}

async function checkResearchWithdrawalTombstones(database) {
  const result = await database.query(
    `/* aais_restore_research_withdrawal_tombstones */
     select
       (select count(*)::int from aais_research_withdrawals) as tombstone_count,
       (select count(*)::int
        from aais_research_withdrawals w
        where w.identity_deleted is not true
          or w.restricted_raw_text_deleted is not true
          or w.raw_text_storage is null
          or w.raw_text_storage not in ('postgres', 'file')) as invalid_tombstone_count,
       (select count(*)::int
        from aais_research_withdrawals w
        join aais_research_identity.aais_research_identity_map i
          on i.participant_id = w.participant_id
          and i.project_id = w.project_id
          and i.study_id = w.study_id
          and i.environment = w.environment
          and i.lrs_namespace = w.lrs_namespace) as revived_identity_count,
       (select count(*)::int
        from aais_research_withdrawals w
        left join aais_research_identity.aais_research_participation_ledger a
          on a.participant_id = w.participant_id
          and a.visit_id = w.visit_id
          and a.study_run_id = w.study_run_id
          and a.project_id = w.project_id
          and a.study_id = w.study_id
          and a.environment = w.environment
          and a.lrs_namespace = w.lrs_namespace
          and a.admission_fingerprint = w.admission_fingerprint
        where a.participant_id is null or a.status <> 'withdrawn') as invalid_admission_count,
       (select count(*)::int
        from aais_research_withdrawals w
        join aais_research_events e on e.visit_id = w.visit_id) as revived_event_count,
       (select count(*)::int
        from aais_research_withdrawals w
        join aais_research_visits v on v.visit_id = w.visit_id
        where v.status <> 'withdrawn') as revived_visit_count,
       (select count(*)::int
        from aais_research_withdrawals w
        join aais_research_participants p on p.participant_id = w.participant_id
        where p.status <> 'withdrawn') as revived_participant_count`,
  );
  const row = result.rows[0] ?? {};
  const invalidTombstoneCount = normalizeCount(row.invalid_tombstone_count);
  const revived = {
    identities: normalizeCount(row.revived_identity_count),
    events: normalizeCount(row.revived_event_count),
    visits: normalizeCount(row.revived_visit_count),
    participants: normalizeCount(row.revived_participant_count),
  };
  const invalidAdmissionCount = normalizeCount(row.invalid_admission_count);
  const revivedCount = Object.values(revived).reduce((sum, count) => sum + count, 0);
  return {
    status: revivedCount === 0 && invalidTombstoneCount === 0
      && invalidAdmissionCount === 0
      ? "passed"
      : "failed",
    coverage: "restored-tombstones-only",
    externalRegisterCompared: false,
    tombstoneCount: normalizeCount(row.tombstone_count),
    invalidTombstoneCount,
    invalidAdmissionCount,
    revived,
  };
}

function parseIndependentResearchIdentityKey(value) {
  if (value === undefined || value === null || value === "") {
    return { status: "not_provided", key: null };
  }
  if (Buffer.isBuffer(value)) {
    return value.length === 32
      ? { status: "valid", key: Buffer.from(value) }
      : { status: "invalid", key: null };
  }
  const encoded = String(value).trim();
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return { status: "invalid", key: null };
  }
  const key = Buffer.from(encoded, "base64");
  const canonicalInput = encoded.replace(/=+$/, "");
  const canonicalDecoded = key.toString("base64").replace(/=+$/, "");
  return key.length === 32 && canonicalInput === canonicalDecoded
    ? { status: "valid", key }
    : { status: "invalid", key: null };
}

async function runRolledBackResearchSyntheticFixture(database, input) {
  const fixtureKey = input.identityKey.status === "valid"
    ? input.identityKey.key
    : randomBytes(32);
  const fixtureToken = randomUUID();
  const studyId = `restore-verifier-${fixtureToken}`;
  const scope = {
    projectId: "aais",
    studyId,
    environment: "research",
    lrsNamespace:
      `https://www.aais.site/xapi/studies/${studyId}/research/v1`,
  };
  const participantId = randomUUID();
  const studyRunId = randomUUID();
  const visitId = randomUUID();
  const actor = {
    actorId: `restore-actor-${fixtureToken}`,
    displayName: "Synthetic restore participant",
  };
  const identityFingerprint = createHash("sha256")
    .update(`aais-restore-fixture:${fixtureToken}`)
    .digest("hex");
  const requestedByFingerprint = createHash("sha256")
    .update(`aais-restore-verifier:${fixtureToken}`)
    .digest("hex");
  const encryptedIdentity = encryptSyntheticResearchIdentity({
    actor,
    key: fixtureKey,
    scope,
  });
  const identityRetentionDueAt = addDays(input.checkedAt, 90);
  const factRetentionDueAt = addDays(input.checkedAt, 1825);
  const transaction = await acquireTransactionClient(database);
  let transactionStarted = false;
  let rolledBack = false;
  let discardConnection = false;

  try {
    await transaction.client.query("begin");
    transactionStarted = true;

    const visitResult = await createSyntheticResearchVisit(transaction.client, {
      scope,
      participantId,
      studyRunId,
      visitId,
      identityFingerprint,
      encryptedIdentity,
      identityRetentionDueAt,
      factRetentionDueAt,
    });
    const visitCreated = visitResult.rows.length === 1
      && visitResult.rows[0]?.created === true;

    const storedIdentityResult = await transaction.client.query(
      `/* aais_restore_research_synthetic_identity */
       select ciphertext, iv, authentication_tag, key_version
       from aais_research_identity.aais_research_identity_map
       where participant_id = $1`,
      [participantId],
    );
    const storedIdentity = storedIdentityResult.rows[0] ?? {};
    const syntheticIdentityStructurePassed =
      Buffer.isBuffer(storedIdentity.ciphertext)
      && storedIdentity.ciphertext.length > 0
      && Buffer.isBuffer(storedIdentity.iv)
      && storedIdentity.iv.length === 12
      && Buffer.isBuffer(storedIdentity.authentication_tag)
      && storedIdentity.authentication_tag.length === 16
      && storedIdentity.key_version === "restore-v1";

    let identityDecryptionPassed = false;
    if (input.identityKey.status === "valid" && syntheticIdentityStructurePassed) {
      try {
        const decrypted = decryptSyntheticResearchIdentity({
          ciphertext: storedIdentity.ciphertext,
          iv: storedIdentity.iv,
          authenticationTag: storedIdentity.authentication_tag,
          key: fixtureKey,
          scope,
        });
        identityDecryptionPassed = decrypted.actorId === actor.actorId
          && decrypted.displayName === actor.displayName;
      } catch {
        identityDecryptionPassed = false;
      }
    }

    const syntheticEvents = createSyntheticResearchEvents();
    const recordedSequences = [];
    for (const [index, event] of syntheticEvents.entries()) {
      const eventResult = await transaction.client.query(
        `/* aais_restore_research_synthetic_record_event */
         select * from aais_research_record_event(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
           $13, $14, $15, $16, $17::jsonb, $18
         )`,
        [
          scope.projectId,
          scope.studyId,
          scope.environment,
          scope.lrsNamespace,
          "restore-verifier",
          visitId,
          event.eventId,
          event.clientEventId,
          1,
          "restore-verifier",
          "0000000",
          addMilliseconds(input.checkedAt, index),
          addMilliseconds(input.checkedAt, index + 10),
          event.eventName,
          event.outcome,
          null,
          JSON.stringify(event.detail),
          factRetentionDueAt,
        ],
      );
      const row = eventResult.rows[0] ?? {};
      if (row.created === true && row.recorded_lrs_eligible === true) {
        recordedSequences.push(normalizePositiveInteger(row.recorded_event_sequence));
      }
    }

    const syntheticSetResult = await transaction.client.query(
      `/* aais_restore_research_synthetic_event_outbox_set */
       select
         (select array_agg(event_sequence order by event_sequence)
          from aais_research_events where visit_id = $1) as event_sequences,
         (select count(*)::int
          from aais_research_events where visit_id = $1) as event_count,
         (select count(*)::int
          from aais_research_lrs_outbox o
          join aais_research_events e on e.event_id = o.event_id
          where e.visit_id = $1) as outbox_count,
         (select count(*)::int
          from aais_research_events e
          left join aais_research_lrs_outbox o on o.event_id = e.event_id
          where e.visit_id = $1
            and (o.event_id is null or o.statement_id <> e.event_id)) as difference_count`,
      [visitId],
    );
    const syntheticSet = syntheticSetResult.rows[0] ?? {};
    const storedSequences = normalizeSequenceArray(syntheticSet.event_sequences);
    const sequencePassed = arraysEqual(recordedSequences, [1, 2])
      && arraysEqual(storedSequences, [1, 2]);
    const syntheticEventCount = normalizeCount(syntheticSet.event_count);
    const syntheticOutboxCount = normalizeCount(syntheticSet.outbox_count);
    const syntheticDifferenceCount = normalizeCount(syntheticSet.difference_count);
    const eventOutboxSetPassed = syntheticEventCount === 2
      && syntheticOutboxCount === 2
      && syntheticDifferenceCount === 0;

    // Exercise the post-90-day state: the ciphertext is gone, while the
    // restricted HMAC admission/nonce reservation remains authoritative.
    await transaction.client.query(
      `/* aais_restore_research_synthetic_expire_identity */
       update aais_research_visits
       set status = 'completed', ended_at = $2, raw_text_deleted_at = $2,
         raw_text_storage = 'postgres'
       where visit_id = $1`,
      [visitId, addMilliseconds(input.checkedAt, 15)],
    );
    await transaction.client.query(
      `/* aais_restore_research_synthetic_delete_identity */
       delete from aais_research_identity.aais_research_identity_map
       where participant_id = $1`,
      [participantId],
    );
    const repeatAdmissionResult = await createSyntheticResearchVisit(transaction.client, {
      scope,
      participantId: randomUUID(),
      studyRunId: randomUUID(),
      visitId: randomUUID(),
      identityFingerprint,
      encryptedIdentity,
      identityRetentionDueAt,
      factRetentionDueAt,
    });
    const oneParticipationPreserved = repeatAdmissionResult.rows[0]?.created === false
      && repeatAdmissionResult.rows[0]?.participant_id === participantId
      && repeatAdmissionResult.rows[0]?.study_run_id === studyRunId
      && repeatAdmissionResult.rows[0]?.visit_id === visitId;

    await transaction.client.query("savepoint aais_research_nonce_collision_check");
    let nonceCollisionError = null;
    try {
      await createSyntheticResearchVisit(transaction.client, {
        scope,
        participantId: randomUUID(),
        studyRunId: randomUUID(),
        visitId: randomUUID(),
        identityFingerprint: createHash("sha256")
          .update(`aais-restore-fixture-nonce:${fixtureToken}`)
          .digest("hex"),
        encryptedIdentity,
        identityRetentionDueAt,
        factRetentionDueAt,
      });
    } catch (error) {
      nonceCollisionError = error;
    }
    await transaction.client.query("rollback to savepoint aais_research_nonce_collision_check");
    await transaction.client.query("release savepoint aais_research_nonce_collision_check");
    const nonceCollisionRejected = String(nonceCollisionError?.message ?? "")
      .includes("research identity nonce collision");

    const withdrawalBarrierResult = await transaction.client.query(
      `/* aais_restore_research_synthetic_begin_withdrawal */
       select * from aais_research_begin_withdrawal($1, $2, $3, $4, $5, $6)`,
      [
        scope.projectId,
        scope.studyId,
        scope.environment,
        scope.lrsNamespace,
        studyRunId,
        addMilliseconds(input.checkedAt, 19),
      ],
    );
    const withdrawalBarrier = withdrawalBarrierResult.rows[0] ?? {};
    const withdrawalBarrierClosed = withdrawalBarrier.status === "withdrawing"
      && normalizeCount(withdrawalBarrier.active_raw_write_lease_count) === 0;

    const withdrawalResult = await transaction.client.query(
      `/* aais_restore_research_synthetic_withdraw */
       select * from aais_research_withdraw(
         $1, $2, $3, $4, $5, $6, $7, true, 'postgres', $8
       )`,
      [
        scope.projectId,
        scope.studyId,
        scope.environment,
        scope.lrsNamespace,
        studyRunId,
        randomUUID(),
        requestedByFingerprint,
        addMilliseconds(input.checkedAt, 20),
      ],
    );
    const withdrawal = withdrawalResult.rows[0] ?? {};
    const withdrawalCreated = withdrawalBarrierClosed
      && withdrawal.created === true
      && withdrawal.identity_deleted === true
      && withdrawal.restricted_raw_text_deleted === true
      && normalizeCount(withdrawal.local_event_count) === 2
      && normalizeCount(withdrawal.deletion_request_count) === 2;

    await transaction.client.query("savepoint aais_research_tombstone_check");
    let reenrollmentError = null;
    try {
      await createSyntheticResearchVisit(transaction.client, {
        scope,
        participantId: randomUUID(),
        studyRunId: randomUUID(),
        visitId: randomUUID(),
        identityFingerprint,
        encryptedIdentity,
        identityRetentionDueAt,
        factRetentionDueAt,
      });
    } catch (error) {
      reenrollmentError = error;
    }
    await transaction.client.query("rollback to savepoint aais_research_tombstone_check");
    await transaction.client.query("release savepoint aais_research_tombstone_check");
    const reenrollmentRejected = String(reenrollmentError?.message ?? "")
      .includes("research participant withdrawn");

    const postWithdrawalResult = await transaction.client.query(
      `/* aais_restore_research_synthetic_post_withdrawal */
       select
         (select count(*)::int
          from aais_research_identity.aais_research_identity_map
          where participant_id = $1) as identity_count,
         (select count(*)::int
          from aais_research_events where visit_id = $2) as event_count,
         (select count(*)::int
          from aais_research_lrs_outbox
          where event_id = any($3::uuid[])) as outbox_count,
         (select count(*)::int
          from aais_research_withdrawals
          where visit_id = $2 and admission_fingerprint = $4) as tombstone_count,
         (select count(*)::int
          from aais_research_identity.aais_research_participation_ledger
          where visit_id = $2 and admission_fingerprint = $4
            and status = 'withdrawn') as admission_tombstone_count`,
      [
        participantId,
        visitId,
        syntheticEvents.map((event) => event.eventId),
        identityFingerprint,
      ],
    );
    const postWithdrawal = postWithdrawalResult.rows[0] ?? {};
    const postWithdrawalClean = normalizeCount(postWithdrawal.identity_count) === 0
      && normalizeCount(postWithdrawal.event_count) === 0
      && normalizeCount(postWithdrawal.outbox_count) === 0
      && normalizeCount(postWithdrawal.tombstone_count) === 1
      && normalizeCount(postWithdrawal.admission_tombstone_count) === 1;

    await transaction.client.query("rollback");
    transactionStarted = false;
    rolledBack = true;

    const identityDecryption = input.identityKey.status === "valid"
      ? {
          status: identityDecryptionPassed ? "passed" : "failed",
          independentKeyProvided: true,
          aadContract: "aais-research-identity:v1",
          evidence: "post-restore-round-trip",
        }
      : input.identityKey.status === "invalid"
        ? {
            status: "failed",
            independentKeyProvided: true,
            aadContract: "aais-research-identity:v1",
            evidence: "post-restore-round-trip",
            reason: "invalid independent restore key",
          }
        : {
            status: "not_requested",
            independentKeyProvided: false,
            aadContract: "aais-research-identity:v1",
            evidence: "post-restore-round-trip",
          };
    const withdrawalTombstonePassed = withdrawalCreated
      && postWithdrawalClean
      && reenrollmentRejected
      && oneParticipationPreserved
      && nonceCollisionRejected;
    const status = visitCreated
      && syntheticIdentityStructurePassed
      && identityDecryption.status !== "failed"
      && sequencePassed
      && eventOutboxSetPassed
      && withdrawalTombstonePassed
      && rolledBack
      ? "passed"
      : "failed";
    return {
      status,
      transaction: "rolled-back",
      rolledBack,
      externalLrsContacted: false,
      visitCreated,
      identityStructure: {
        status: syntheticIdentityStructurePassed ? "passed" : "failed",
      },
      identityDecryption,
      eventSequence: {
        status: sequencePassed ? "passed" : "failed",
        expectedCount: 2,
        observedCount: storedSequences.length,
      },
      eventOutboxSet: {
        status: eventOutboxSetPassed ? "passed" : "failed",
        eventCount: syntheticEventCount,
        outboxCount: syntheticOutboxCount,
        differenceCount: syntheticDifferenceCount,
      },
      withdrawalTombstone: {
        status: withdrawalTombstonePassed ? "passed" : "failed",
        withdrawalCreated,
        postWithdrawalClean,
        reenrollmentRejected,
        oneParticipationAfterIdentityDeletion: oneParticipationPreserved,
        nonceCollisionRejected,
      },
    };
  } catch (error) {
    if (transactionStarted) {
      try {
        await transaction.client.query("rollback");
        transactionStarted = false;
        rolledBack = true;
      } catch {
        discardConnection = true;
        rolledBack = false;
      }
    }
    return failedResearchSyntheticFixture({
      identityKeyStatus: input.identityKey.status,
      rolledBack,
      errorCategory: classifyDatabaseError(error),
    });
  } finally {
    transaction.release(discardConnection);
  }
}

async function createSyntheticResearchVisit(database, input) {
  return database.query(
    `/* aais_restore_research_synthetic_create_visit */
     select * from aais_research_create_visit(
       $1, $2, $3, $4, $5, $6, $7, $8, $9::bytea, $10::bytea,
       $11::bytea, $12, $13::text[], 30, $14, $15
     )`,
    [
      input.scope.projectId,
      input.scope.studyId,
      input.scope.environment,
      input.scope.lrsNamespace,
      input.participantId,
      input.studyRunId,
      input.visitId,
      input.identityFingerprint,
      input.encryptedIdentity.ciphertext,
      input.encryptedIdentity.iv,
      input.encryptedIdentity.authenticationTag,
      "restore-v1",
      ["control", "treatment"],
      input.identityRetentionDueAt,
      input.factRetentionDueAt,
    ],
  );
}

function createSyntheticResearchEvents() {
  return [
    {
      eventId: randomUUID(),
      clientEventId: randomUUID(),
      eventName: "workspace_session_load",
      outcome: "success",
      detail: {
        operation_id: `session-load-${randomUUID()}`,
        attempt_number: 1,
      },
    },
    {
      eventId: randomUUID(),
      clientEventId: randomUUID(),
      eventName: "ai_guide_submit",
      outcome: "retry",
      detail: {
        operation_id: `ai-guide-${randomUUID()}`,
        attempt_number: 2,
        retry_reason: "stream_protocol_fallback",
      },
    },
  ];
}

function encryptSyntheticResearchIdentity(input) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", input.key, iv);
  cipher.setAAD(createResearchIdentityAad(input.scope));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(input.actor), "utf8")),
    cipher.final(),
  ]);
  return {
    ciphertext,
    iv,
    authenticationTag: cipher.getAuthTag(),
  };
}

function decryptSyntheticResearchIdentity(input) {
  const decipher = createDecipheriv("aes-256-gcm", input.key, input.iv);
  decipher.setAAD(createResearchIdentityAad(input.scope));
  decipher.setAuthTag(input.authenticationTag);
  const plaintext = Buffer.concat([
    decipher.update(input.ciphertext),
    decipher.final(),
  ]).toString("utf8");
  const parsed = JSON.parse(plaintext);
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || typeof parsed.actorId !== "string"
    || typeof parsed.displayName !== "string"
  ) {
    throw new Error("Synthetic research identity fixture is invalid.");
  }
  return parsed;
}

function createResearchIdentityAad(scope) {
  return Buffer.from([
    "aais-research-identity:v1",
    scope.projectId,
    scope.studyId,
    scope.environment,
    scope.lrsNamespace,
  ].join("\u0000"), "utf8");
}

function skippedResearchSyntheticFixture(reason, identityKeyStatus) {
  const identityDecryption = identityKeyStatus === "invalid"
    ? {
        status: "failed",
        independentKeyProvided: true,
        aadContract: "aais-research-identity:v1",
        evidence: "post-restore-round-trip",
        reason: "invalid independent restore key",
      }
    : {
        status: "skipped",
        independentKeyProvided: identityKeyStatus === "valid",
        aadContract: "aais-research-identity:v1",
        evidence: "post-restore-round-trip",
      };
  return {
    status: "skipped",
    reason,
    transaction: "not-started",
    rolledBack: false,
    externalLrsContacted: false,
    identityDecryption,
    withdrawalTombstone: { status: "skipped" },
  };
}

function failedResearchSyntheticFixture(input) {
  return {
    status: "failed",
    transaction: "rolled-back",
    rolledBack: input.rolledBack,
    externalLrsContacted: false,
    errorCategory: input.errorCategory,
    identityDecryption: {
      status: input.identityKeyStatus === "not_provided"
        ? "not_requested"
        : "failed",
      independentKeyProvided: input.identityKeyStatus !== "not_provided",
      aadContract: "aais-research-identity:v1",
      evidence: "post-restore-round-trip",
    },
    withdrawalTombstone: { status: "failed" },
  };
}

function skippedCheck(reason) {
  return { status: "skipped", reason };
}

function emptyResearchRowCounts() {
  return {
    participants: null,
    identityMaps: null,
    participationLedgers: null,
    visits: null,
    rawWriteLeases: null,
    events: null,
    lrsOutbox: null,
    exportAudits: null,
    withdrawals: null,
    lrsDeletions: null,
    retentionRuns: null,
    legacyArchives: null,
  };
}

function addDays(isoDate, days) {
  return new Date(Date.parse(isoDate) + days * 86_400_000).toISOString();
}

function addMilliseconds(isoDate, milliseconds) {
  return new Date(Date.parse(isoDate) + milliseconds).toISOString();
}

function normalizePositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeSequenceArray(value) {
  return Array.isArray(value)
    ? value.map(normalizePositiveInteger).filter((item) => item !== null)
    : [];
}

function arraysEqual(left, right) {
  return left.length === right.length
    && left.every((item, index) => item === right[index]);
}

async function acquireTransactionClient(database) {
  if (typeof database.connect !== "function") {
    return { client: database, release() {} };
  }
  const client = await database.connect();
  return {
    client,
    release(discard = false) {
      client.release(discard);
    },
  };
}

async function checkRequiredTables(database) {
  const result = await database.query(
    `select
       to_regclass('public.aais_learner_sessions') as aais_learner_sessions,
       to_regclass('public.aais_lrs_outbox') as aais_lrs_outbox,
       to_regclass('public.aais_login_rate_limits') as aais_login_rate_limits,
       to_regclass('public.aais_events') as aais_events,
       to_regclass('public.aais_learner_task_state') as aais_learner_task_state,
       to_regclass('public.aais_users') as aais_users,
       to_regclass('public.aais_user_auth_tokens') as aais_user_auth_tokens,
       to_regclass('public.aais_session_revocations') as aais_session_revocations,
       to_regclass('public.aais_courses') as aais_courses,
       to_regclass('public.aais_course_tasks') as aais_course_tasks,
       to_regclass('public.aais_enrollments') as aais_enrollments`,
  );
  const row = result.rows[0] ?? {};
  const tables = Object.fromEntries(
    requiredTables.map((table) => [table, row[table] === table]),
  );
  const missing = requiredTables.filter((table) => !tables[table]);
  return {
    status: missing.length ? "failed" : "passed",
    present: missing.length === 0,
    tables,
    missing,
  };
}

async function readRestoreRowCounts(database) {
  const result = await database.query(
    `select
       (select count(*)::int from aais_learner_sessions) as learner_sessions,
       (select count(*)::int from aais_lrs_outbox) as lrs_outbox,
       (select count(*)::int from aais_events) as events,
       (select count(*)::int from aais_learner_task_state) as learner_task_state,
       (select count(*)::int from aais_users) as users,
       (select count(*)::int from aais_courses) as courses,
       (select count(*)::int from aais_course_tasks) as course_tasks,
       (select count(*)::int from aais_enrollments) as enrollments`,
  );
  const row = result.rows[0] ?? {};
  return {
    learnerSessions: normalizeCount(row.learner_sessions),
    lrsOutbox: normalizeCount(row.lrs_outbox),
    events: normalizeCount(row.events),
    learnerTaskState: normalizeCount(row.learner_task_state),
    users: normalizeCount(row.users),
    courses: normalizeCount(row.courses),
    courseTasks: normalizeCount(row.course_tasks),
    enrollments: normalizeCount(row.enrollments),
  };
}

async function runRolledBackSyntheticInsert(database, checkedAt) {
  const syntheticStudentId = `restore-smoke-${randomUUID()}`;
  const payload = {
    schemaVersion: 1,
    studentId: syntheticStudentId,
    sessionId: `restore-session-${randomUUID()}`,
    createdAt: checkedAt,
    updatedAt: checkedAt,
    activeTaskId: "training_task_1",
    activeStage: "training",
    tasks: [],
    guideMessages: [],
    events: [],
  };

  const transaction = await acquireTransactionClient(database);
  let transactionStarted = false;
  let rolledBack = false;
  let discardConnection = false;
  try {
    await transaction.client.query("begin");
    transactionStarted = true;
    const result = await transaction.client.query(
      `insert into aais_learner_sessions (student_id, payload, version, updated_at)
       values ($1, $2::jsonb, 0, $3::timestamptz)
       on conflict (student_id) do nothing
       returning student_id`,
      [syntheticStudentId, JSON.stringify(payload), checkedAt],
    );
    await transaction.client.query("rollback");
    transactionStarted = false;
    rolledBack = true;
    return {
      status: result.rows.length === 1 ? "passed" : "failed",
      insertAccepted: result.rows.length === 1,
      rolledBack,
      writeMode: "insert-only-rolled-back",
    };
  } catch (error) {
    if (transactionStarted) {
      try {
        await transaction.client.query("rollback");
        transactionStarted = false;
        rolledBack = true;
      } catch {
        discardConnection = true;
      }
    }
    return {
      status: "failed",
      insertAccepted: false,
      rolledBack,
      writeMode: "insert-only-rolled-back",
      errorCategory: classifyDatabaseError(error),
    };
  } finally {
    transaction.release(discardConnection);
  }
}

function normalizeCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

function stripEnvQuotes(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\""))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeOptionalString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function classifyDatabaseError(error) {
  const code = String(error?.code ?? error?.cause?.code ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
  if (code === "enotfound" || code === "eai_again") {
    return "dns";
  }
  if (code === "econnrefused" || code === "econnreset") {
    return "network";
  }
  if (code) {
    return "database";
  }
  return "unknown";
}

async function writeReportIfRequested(report, outputPath) {
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(outputPath, 0o600);
  }
  return report;
}

function parseArgs(argv) {
  const input = { research: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env-file") {
      input.envFile = argv[index + 1];
      index += 1;
    } else if (arg === "--target-purpose") {
      input.targetPurpose = argv[index + 1];
      index += 1;
    } else if (arg === "--release-id") {
      input.releaseId = argv[index + 1];
      index += 1;
    } else if (arg === "--output") {
      input.outputPath = argv[index + 1];
      index += 1;
    } else if (arg === "--research") {
      input.research = true;
    } else if (arg === "--help") {
      input.help = true;
    } else {
      throw new Error(`Unknown AAIS restore verification argument: ${arg}`);
    }
  }
  return input;
}

function printHelp() {
  console.log([
    "Usage: npm run verify:postgres-restore -- [--research] --env-file ./.env.postgres-restore.local --output ./aais-postgres-restore-report.json",
    "",
    "Product restore environment:",
    "  AAIS_RESTORE_DATABASE_URL (or RESTORE_DATABASE_URL)",
    "",
    "Research restore environment (--research):",
    `  ${researchRestoreDatabaseEnv}`,
    `  ${researchRestoreIdentityKeyEnv} (optional independent 32-byte base64 key)`,
    "  Research mode never reads the product or live research database URL.",
    "  It performs only Postgres checks and rolled-back synthetic writes; it never contacts an LRS.",
    "",
    "Required for either mode:",
    "  AAIS_RESTORE_TARGET_PURPOSE=restored-staging",
    "",
    "The report is redacted: database URLs, identities, ciphertext, payloads, and secrets are omitted.",
  ].join("\n"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const envFileValues = await loadAaisRestoreEnvFile(args.envFile);
  const env = {
    ...process.env,
    ...envFileValues,
  };
  const config = args.research
    ? getAaisResearchRestoreDatabaseConfiguration(env)
    : getAaisRestoreDatabaseConfiguration(env);
  if (!config) {
    throw new Error(args.research
      ? `AAIS research restore verification requires ${researchRestoreDatabaseEnv}.`
      : "AAIS restore verification requires AAIS_RESTORE_DATABASE_URL.");
  }
  const targetPurpose = args.targetPurpose ?? env.AAIS_RESTORE_TARGET_PURPOSE;
  const pool = new Pool({ connectionString: config.url });
  try {
    const sharedInput = {
      database: pool,
      targetPurpose,
      sourceEnv: config.sourceEnv,
      releaseId: args.releaseId ?? env.AAIS_RELEASE_ID,
    };
    const report = args.research
      ? await runAaisResearchPostgresRestoreVerification({
          ...sharedInput,
          identityEncryptionKey: env[researchRestoreIdentityKeyEnv],
        })
      : await runAaisPostgresRestoreVerification(sharedInput);
    const output = await writeReportIfRequested(
      report,
      args.outputPath ?? env.AAIS_RESTORE_REHEARSAL_REPORT_PATH,
    );
    console.log(JSON.stringify(args.research
      ? {
          status: output.status,
          mode: output.mode,
          targetPurpose: output.targetPurpose,
          sourceEnv: output.sourceEnv,
          issues: output.issues,
          tablesPresent: output.checks.requiredTables.present,
          functionsPresent: output.checks.requiredFunctions.present,
          constraintsPresent: output.checks.requiredConstraints.present,
          columnsPresent: output.checks.requiredColumns.present,
          syntheticFixture: output.checks.syntheticFixture.status,
          externalLrs: "not-contacted",
          secrets: "redacted",
        }
      : {
          status: output.status,
          targetPurpose: output.targetPurpose,
          sourceEnv: output.sourceEnv,
          issues: output.issues,
          tablesPresent: output.checks.requiredTables.present,
          smokeInsert: output.checks.smokeInsert.status,
          secrets: "redacted",
        }));
    if (output.status !== "passed") {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`AAIS restore verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
