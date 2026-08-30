import { describe, expect, it } from "vitest";
import {
  createPgMigrationDatabaseClient,
  getAaisMigrationDatabaseConfiguration,
  getAaisResearchMigrationDatabaseConfiguration,
  loadAaisPostgresMigrations,
  runAaisPostgresMigrations,
} from "../scripts/run-postgres-migrations.mjs";

describe("AAIS Postgres migrations", () => {
  it("loads the baseline migration from disk", async () => {
    const migrations = await loadAaisPostgresMigrations();

    expect(migrations).toEqual([
      expect.objectContaining({
        version: "0001",
        name: "aais_baseline",
        fileName: "0001_aais_baseline.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0002",
        name: "login_rate_limits",
        fileName: "0002_login_rate_limits.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0003",
        name: "aais_events",
        fileName: "0003_aais_events.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0004",
        name: "learner_task_state",
        fileName: "0004_learner_task_state.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0005",
        name: "users_and_auth_tokens",
        fileName: "0005_users_and_auth_tokens.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0006",
        name: "session_revocations",
        fileName: "0006_session_revocations.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0007",
        name: "course_catalog",
        fileName: "0007_course_catalog.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0008",
        name: "ai_guide_daily_usage",
        fileName: "0008_ai_guide_daily_usage.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0009",
        name: "aais_research_study",
        fileName: "0009_aais_research_study.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0010",
        name: "user_auth_version",
        fileName: "0010_user_auth_version.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0011",
        name: "product_lrs_outbox_claims",
        fileName: "0011_product_lrs_outbox_claims.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0012",
        name: "ai_guide_reservations",
        fileName: "0012_ai_guide_reservations.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0013",
        name: "product_lrs_frozen_statements",
        fileName: "0013_product_lrs_frozen_statements.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0014",
        name: "learner_data_generations",
        fileName: "0014_learner_data_generations.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0015",
        name: "ai_guide_reservation_leases",
        fileName: "0015_ai_guide_reservation_leases.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0016",
        name: "atomic_learner_data_delete",
        fileName: "0016_atomic_learner_data_delete.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0017",
        name: "educator_enrollment_scope_index",
        fileName: "0017_educator_enrollment_scope_index.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0018",
        name: "active_admin_invariant",
        fileName: "0018_active_admin_invariant.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0019",
        name: "product_lrs_privacy_delivery_fence",
        fileName: "0019_product_lrs_privacy_delivery_fence.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0020",
        name: "auth_email_outbox",
        fileName: "0020_auth_email_outbox.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0021",
        name: "auth_email_operator_reconciliation",
        fileName: "0021_auth_email_operator_reconciliation.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0022",
        name: "research_withdrawal_safe_export",
        fileName: "0022_research_withdrawal_safe_export.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0023",
        name: "privacy_preserve_daily_guide_usage",
        fileName: "0023_privacy_preserve_daily_guide_usage.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0024",
        name: "research_visit_event_cap",
        fileName: "0024_research_visit_event_cap.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0025",
        name: "product_lrs_delivery_reconciliation",
        fileName: "0025_product_lrs_delivery_reconciliation.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0026",
        name: "auth_rate_limit_retention",
        fileName: "0026_auth_rate_limit_retention.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0027",
        name: "research_retention_stale_lease_signal",
        fileName: "0027_research_retention_stale_lease_signal.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0028",
        name: "runtime_worker_leases",
        fileName: "0028_runtime_worker_leases.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0029",
        name: "runtime_database_identity",
        fileName: "0029_runtime_database_identity.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(migrations[0].sql).toContain("create table if not exists aais_learner_sessions");
    expect(migrations[0].sql).toContain("create table if not exists aais_lrs_outbox");
    expect(migrations[1].sql).toContain("create table if not exists aais_login_rate_limits");
    expect(migrations[25].sql).toContain("add column if not exists expires_at timestamptz");
    expect(migrations[25].sql).toContain("alter column expires_at set not null");
    expect(migrations[25].sql).toContain("aais_login_rate_limits_expires_idx");
    expect(migrations[26].sql).toContain("stale_raw_text_write_lease_count");
    expect(migrations[26].sql).toContain("aais_research_retention_runs_blocked_signal_check");
    expect(migrations[27].sql).toContain("create table if not exists public.aais_runtime_leases");
    expect(migrations[27].sql).toContain("aais_runtime_leases_expiry_idx");
    expect(migrations[28].sql).toContain("create table if not exists public.aais_runtime_identity");
    expect(migrations[2].sql).toContain("create table if not exists aais_events");
    expect(migrations[2].sql).toContain("jsonb_array_elements");
    expect(migrations[2].sql).toContain("on conflict do nothing");
    expect(migrations[3].sql).toContain("create table if not exists aais_learner_task_state");
    expect(migrations[3].sql).toContain("artifact_characters");
    expect(migrations[3].sql).toContain("jsonb_array_elements");
    expect(migrations[3].sql).toContain("on conflict (student_id, task) do update");
    expect(migrations[4].sql).toContain("create table if not exists aais_users");
    expect(migrations[4].sql).toContain("create table if not exists aais_user_auth_tokens");
    expect(migrations[4].sql).toContain("token_hash");
    expect(migrations[5].sql).toContain("create table if not exists aais_session_revocations");
    expect(migrations[5].sql).toContain("token_hash");
    expect(migrations[6].sql).toContain("create table if not exists aais_courses");
    expect(migrations[6].sql).toContain("create table if not exists aais_course_tasks");
    expect(migrations[6].sql).toContain("create table if not exists aais_enrollments");
    expect(migrations[6].sql).toContain("Cognitive Apprenticeship: Metacognition Studio");
    expect(migrations[6].sql).toContain("practice_task_3");
    expect(migrations[7].sql).toContain("create table if not exists aais_ai_guide_daily_usage");
    expect(migrations[7].sql).toContain("primary key (student_id, usage_day)");
    expect(migrations[8].sql).toContain("create table if not exists aais_research_events");
    expect(migrations[8].sql).toContain("create table if not exists aais_research_raw_write_leases");
    expect(migrations[8].sql).toContain("create or replace function aais_research_record_event");
    expect(migrations[8].sql).toContain("create or replace function aais_research_begin_withdrawal");
    expect(migrations[9].sql).toContain("auth_version");
    expect(migrations[10].sql).toContain("delivery_claim_id");
    expect(migrations[10].sql).toContain("lease_expires_at");
    expect(migrations[10].sql).toContain("pending_payload");
    expect(migrations[10].sql).toContain("status = 'sending'");
    expect(migrations[11].sql).toContain("create table if not exists aais_ai_guide_reservations");
    expect(migrations[11].sql).toContain("state in ('reserved', 'completed', 'released')");
    expect(migrations[11].sql).toContain("references aais_ai_guide_daily_usage");
    expect(migrations[12].sql).toContain("xapi_statement jsonb");
    expect(migrations[12].sql).toContain("aais_lrs_outbox_xapi_statement_check");
    expect(migrations[12].sql).toContain("jsonb_typeof(xapi_statement)");
    expect(migrations[13].sql).toContain("create table if not exists aais_learner_data_generations");
    expect(migrations[13].sql).toContain("check (data_generation >= 1)");
    expect(migrations[13].sql).toContain("on conflict (student_id) do nothing");
    expect(migrations[13].sql).toContain("aais_learner_data_generations_deleted_idx");
    expect(migrations[14].sql).toContain("add column if not exists expires_at timestamptz");
    expect(migrations[14].sql).toContain("reserved_at + interval '600 seconds'");
    expect(migrations[14].sql).toContain("set default (now() + interval '600 seconds')");
    expect(migrations[14].sql).toContain("alter column expires_at set not null");
    expect(migrations[14].sql).toContain("check (expires_at > reserved_at)");
    expect(migrations[14].sql).toContain("where state = 'reserved'");
    expect(migrations[14].sql).toContain("create or replace function public.aais_reserve_ai_guide_request");
    expect(migrations[14].sql).toContain("volatile\nsecurity invoker");
    expect(migrations[14].sql).toContain("set search_path = pg_catalog, public, pg_temp");
    expect(migrations[14].sql).toContain("p_data_generation is null or p_data_generation < 1");
    expect(migrations[14].sql).toContain("p_lease_seconds > 600");
    const reservationFunctionSql = migrations[14].sql.slice(
      migrations[14].sql.indexOf("create or replace function public.aais_reserve_ai_guide_request"),
    );
    expect(reservationFunctionSql.indexOf("for update;")).toBeLessThan(
      reservationFunctionSql.indexOf("update public.aais_ai_guide_reservations"),
    );
    expect(reservationFunctionSql.indexOf("update public.aais_ai_guide_reservations")).toBeLessThan(
      reservationFunctionSql.indexOf("select usage.used"),
    );
    expect(reservationFunctionSql.indexOf("update public.aais_ai_guide_reservations")).toBeGreaterThan(-1);
    expect(reservationFunctionSql.indexOf("select usage.used")).toBeLessThan(
      reservationFunctionSql.indexOf("update public.aais_ai_guide_daily_usage"),
    );
    expect(reservationFunctionSql).toContain("if found then");
    expect(reservationFunctionSql).toContain("else\n    v_granted := true;");
    expect(migrations[15].sql).toContain(
      "create or replace function public.aais_delete_learner_data",
    );
    expect(migrations[15].sql).toContain("volatile\nsecurity invoker");
    expect(migrations[15].sql).toContain("set search_path = pg_catalog, public, pg_temp");
    expect(migrations[15].sql).toContain("returning generation.data_generation into v_next_generation");
    const learnerDeleteFunctionSql = migrations[15].sql.slice(
      migrations[15].sql.indexOf("create or replace function public.aais_delete_learner_data"),
    );
    expect(learnerDeleteFunctionSql.indexOf("update public.aais_learner_data_generations")).toBeLessThan(
      learnerDeleteFunctionSql.indexOf("delete from public.aais_lrs_outbox"),
    );
    expect(learnerDeleteFunctionSql.indexOf("delete from public.aais_lrs_outbox")).toBeLessThan(
      learnerDeleteFunctionSql.indexOf("delete from public.aais_learner_task_state"),
    );
    expect(learnerDeleteFunctionSql.indexOf("delete from public.aais_learner_task_state")).toBeLessThan(
      learnerDeleteFunctionSql.indexOf("delete from public.aais_ai_guide_daily_usage"),
    );
    expect(learnerDeleteFunctionSql.indexOf("delete from public.aais_ai_guide_daily_usage")).toBeLessThan(
      learnerDeleteFunctionSql.indexOf("delete from public.aais_events"),
    );
    expect(learnerDeleteFunctionSql.indexOf("delete from public.aais_events")).toBeLessThan(
      learnerDeleteFunctionSql.indexOf("delete from public.aais_learner_sessions"),
    );
    expect(migrations[16].sql).toContain("aais_enrollments_user_scope_idx");
    expect(migrations[16].sql).toContain("(user_id, role, status, course_id, cohort)");
    const activeAdminInvariantSql = migrations[17].sql;
    expect(activeAdminInvariantSql).toContain("aais_active_admin_invariant_lock");
    expect(activeAdminInvariantSql).toContain("security invoker");
    expect(activeAdminInvariantSql).toContain("set search_path = pg_catalog, public, pg_temp");
    expect(activeAdminInvariantSql).toContain("aais_users_active_admin_update_guard");
    expect(activeAdminInvariantSql).toContain("aais_users_active_admin_delete_guard");
    expect(activeAdminInvariantSql).toContain(
      "referencing old table as old_accounts new table as new_accounts",
    );
    expect(activeAdminInvariantSql).toContain(
      "constraint = 'aais_users_active_admin_invariant'",
    );
    expect(activeAdminInvariantSql.indexOf(
      "update public.aais_active_admin_invariant_lock invariant_lock",
    )).toBeLessThan(activeAdminInvariantSql.indexOf(
      "from public.aais_users account",
    ));
    const lrsPrivacyDeliveryFenceSql = migrations[18].sql;
    expect(lrsPrivacyDeliveryFenceSql).toContain("lrs_delivery_state");
    expect(lrsPrivacyDeliveryFenceSql).toContain("lrs_delivery_claim_id");
    expect(lrsPrivacyDeliveryFenceSql).toContain("lrs_delivery_started_at");
    expect(lrsPrivacyDeliveryFenceSql).toContain("AAIS_LRS_DELIVERY_IN_FLIGHT");
    expect(lrsPrivacyDeliveryFenceSql).toContain(
      "AAIS_LRS_DELIVERY_RECONCILIATION_REQUIRED",
    );
    expect(lrsPrivacyDeliveryFenceSql).toContain(
      "create or replace function public.aais_delete_learner_data",
    );
    expect(lrsPrivacyDeliveryFenceSql).toContain("volatile\nsecurity invoker");
    expect(lrsPrivacyDeliveryFenceSql).toContain(
      "set search_path = pg_catalog, public, pg_temp",
    );
    const authEmailOutboxSql = migrations[19].sql;
    expect(authEmailOutboxSql).toContain(
      "create table if not exists public.aais_auth_email_outbox",
    );
    expect(authEmailOutboxSql).toContain("auth_token_hash text not null");
    expect(authEmailOutboxSql).toContain("email_delivery_state text not null default 'idle'");
    expect(authEmailOutboxSql).toContain("email_delivery_outbox_id uuid");
    expect(authEmailOutboxSql).toContain("email_delivery_claim_id uuid");
    expect(authEmailOutboxSql).toContain("email_delivery_started_at timestamptz");
    expect(authEmailOutboxSql).toContain("aais_user_auth_tokens_email_delivery_state_check");
    expect(authEmailOutboxSql).toContain("aais_guard_auth_token_email_reissue");
    expect(authEmailOutboxSql).toContain("aais_user_auth_tokens_email_reissue_guard");
    expect(authEmailOutboxSql).toContain("AAIS_AUTH_EMAIL_DELIVERY_FENCED");
    expect(authEmailOutboxSql).toContain("volatile\nsecurity invoker");
    expect(authEmailOutboxSql).toContain("set search_path = pg_catalog, public, pg_temp");
    expect(authEmailOutboxSql).toContain("payload_envelope jsonb not null");
    expect(authEmailOutboxSql).toContain(
      "payload_envelope - 'version' - 'nonce' - 'tag' - 'ciphertext'",
    );
    expect(authEmailOutboxSql).toContain(
      "idempotency_key = 'aais_auth_email_' || id::text",
    );
    expect(authEmailOutboxSql).toContain("aais_auth_email_outbox_due_idx");
    expect(authEmailOutboxSql).toContain("aais_auth_email_outbox_lease_idx");
    expect(authEmailOutboxSql).toContain("aais_auth_email_outbox_token_fence_idx");
    expect(authEmailOutboxSql).not.toContain("reset_token");
    expect(authEmailOutboxSql).not.toContain("invite_token");
    const authEmailReconciliationSql = migrations[20].sql;
    expect(authEmailReconciliationSql).toContain("reconciliation_disposition");
    expect(authEmailReconciliationSql).toContain("reconciliation_message_id");
    expect(authEmailReconciliationSql).toContain("reconciliation_observed_status");
    expect(authEmailReconciliationSql).toContain("reconciliation_observed_at");
    expect(authEmailReconciliationSql).toContain("reconciled_at");
    expect(authEmailReconciliationSql).toContain("reconciled_by");
    expect(authEmailReconciliationSql).toContain(
      "aais_auth_email_outbox_reconciliation_evidence_key",
    );
    expect(authEmailReconciliationSql).toContain("email_delivery_state = 'delivered'");
    expect(authEmailReconciliationSql).toContain("aais_guard_auth_token_email_reissue");
    expect(authEmailReconciliationSql).toContain("old.email_delivery_state = 'uncertain'");
    expect(authEmailReconciliationSql).toContain("old.expires_at > new.created_at");
    expect(authEmailReconciliationSql).not.toContain("reset_token");
    expect(authEmailReconciliationSql).not.toContain("invite_token");
    const researchWithdrawalSafeExportSql = migrations[21].sql;
    expect(researchWithdrawalSafeExportSql).toContain(
      "create or replace function public.aais_research_export_events",
    );
    expect(researchWithdrawalSafeExportSql).toContain("volatile\nsecurity invoker");
    expect(researchWithdrawalSafeExportSql).toContain(
      "perform pg_catalog.pg_advisory_xact_lock",
    );
    expect(researchWithdrawalSafeExportSql).toContain(
      "if v_visit_status not in ('active', 'completed')",
    );
    expect(researchWithdrawalSafeExportSql.indexOf(
      "perform pg_catalog.pg_advisory_xact_lock",
    )).toBeLessThan(researchWithdrawalSafeExportSql.indexOf(
      "select v.status",
    ));
    const privacyPreserveDailyGuideUsageSql = migrations[22].sql;
    expect(privacyPreserveDailyGuideUsageSql).toContain(
      "state in ('reserved', 'dispatched', 'completed', 'released')",
    );
    expect(privacyPreserveDailyGuideUsageSql).toContain(
      "create or replace function public.aais_reserve_ai_guide_request",
    );
    expect(privacyPreserveDailyGuideUsageSql).toContain(
      "usage.usage_day < p_usage_day",
    );
    expect(privacyPreserveDailyGuideUsageSql).toContain(
      "delete from public.aais_ai_guide_reservations reservation",
    );
    expect(privacyPreserveDailyGuideUsageSql).toContain(
      "guide_usage.usage_day <> (p_deleted_at at time zone 'UTC')::date",
    );
    const privacyDeleteFunctionSql = privacyPreserveDailyGuideUsageSql.slice(
      privacyPreserveDailyGuideUsageSql.indexOf(
        "create or replace function public.aais_delete_learner_data",
      ),
    );
    expect(privacyDeleteFunctionSql).not.toContain(
      "delete from public.aais_ai_guide_daily_usage guide_usage\n  where guide_usage.student_id = p_student_id;",
    );
    expect(privacyDeleteFunctionSql.indexOf(
      "delete from public.aais_ai_guide_reservations reservation",
    )).toBeLessThan(privacyDeleteFunctionSql.indexOf(
      "delete from public.aais_events event_row",
    ));
    const researchVisitEventCapSql = migrations[23].sql;
    expect(researchVisitEventCapSql).toContain(
      "create or replace function public.aais_research_enforce_visit_event_cap",
    );
    expect(researchVisitEventCapSql).toContain("volatile\nsecurity invoker");
    expect(researchVisitEventCapSql).toContain("new.event_sequence > 10000");
    expect(researchVisitEventCapSql).toContain("research visit event limit reached");
    expect(researchVisitEventCapSql).toContain(
      "create trigger aais_research_events_visit_cap_guard",
    );
    const lrsDeliveryReconciliationSql = migrations[24].sql;
    expect(lrsDeliveryReconciliationSql).toContain(
      "create table if not exists public.aais_lrs_delivery_attempts",
    );
    expect(lrsDeliveryReconciliationSql).toContain(
      "create table if not exists public.aais_lrs_delivery_attempt_statements",
    );
    expect(lrsDeliveryReconciliationSql).toContain("statement_set_sha256");
    expect(lrsDeliveryReconciliationSql).toContain("statement_sha256");
    expect(lrsDeliveryReconciliationSql).toContain("frozen_statement jsonb not null");
    expect(lrsDeliveryReconciliationSql).toContain("reconcile_after timestamptz not null");
    expect(lrsDeliveryReconciliationSql).toContain("max_attempts integer not null");
    expect(lrsDeliveryReconciliationSql).toContain("max_attempts between 1 and 100");
    expect(lrsDeliveryReconciliationSql).toContain("reconciliation_status in ('stored', 'absent')");
    expect(lrsDeliveryReconciliationSql).toContain("on delete cascade");
    const fencedLearnerDeleteFunctionSql = lrsPrivacyDeliveryFenceSql.slice(
      lrsPrivacyDeliveryFenceSql.indexOf(
        "create or replace function public.aais_delete_learner_data",
      ),
    );
    expect(fencedLearnerDeleteFunctionSql.indexOf(
      "from public.aais_learner_data_generations generation",
    )).toBeLessThan(fencedLearnerDeleteFunctionSql.indexOf(
      "delete from public.aais_lrs_outbox",
    ));
    expect(fencedLearnerDeleteFunctionSql.indexOf(
      "delete from public.aais_lrs_outbox",
    )).toBeLessThan(fencedLearnerDeleteFunctionSql.indexOf(
      "delete from public.aais_learner_sessions",
    ));
  });

  it("applies pending migrations and records checksums", async () => {
    const database = new FakeTransactionMigrationDatabase();
    const migrations = [createMigration("0001", "aais_baseline", "create table aais_test (id text);")];

    const report = await runAaisPostgresMigrations({ database, migrations });

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "pass",
      applied: 1,
      skipped: 0,
      secrets: "redacted",
    });
    expect(report.migrations[0]).toMatchObject({
      version: "0001",
      name: "aais_baseline",
      status: "applied",
      checksum: "checksum-000",
    });
    expect(database.queries.map((query) => query.sql.trim().toLowerCase())).toEqual([
      expect.stringContaining("create table if not exists public.aais_schema_migrations"),
      "select version, checksum from public.aais_schema_migrations order by version",
      expect.stringContaining("create or replace function pg_temp.aais_apply_schema_migration"),
      expect.stringContaining("select pg_temp.aais_apply_schema_migration"),
    ]);
    expect(database.executedMigrationStatements).toEqual([
      "create table aais_test (id text)",
    ]);
    expect(database.applied.get("0001")).toEqual("checksum-0001");
  });

  it("fails closed when a migration database client has no atomic transaction support", async () => {
    const database = new FakeMigrationDatabase();
    const migrations = [createMigration("0001", "aais_baseline", "create table aais_test (id text);")];

    await expect(runAaisPostgresMigrations({ database, migrations }))
      .rejects.toThrow("AAIS migration database client requires atomic transaction support.");
    expect(database.applied.has("0001")).toBe(false);
  });

  it("skips already applied migrations with the same checksum", async () => {
    const database = new FakeMigrationDatabase({
      "0001": "checksum-0001",
    });
    const migrations = [createMigration("0001", "aais_baseline", "create table aais_test (id text);")];

    const report = await runAaisPostgresMigrations({ database, migrations });

    expect(report).toMatchObject({
      applied: 0,
      skipped: 1,
    });
    expect(report.migrations[0].status).toBe("skipped");
    expect(database.queries.map((query) => query.sql.trim().toLowerCase())).not.toContain("begin");
  });

  it("uses a non-interactive transaction client when available", async () => {
    const database = new FakeTransactionMigrationDatabase();
    const migrations = [createMigration(
      "0001",
      "aais_baseline",
      "create table aais_test (id text);\ninsert into aais_test (id) values ('quoted; semicolon');",
    )];

    const report = await runAaisPostgresMigrations({ database, migrations });

    expect(report).toMatchObject({
      applied: 1,
      skipped: 0,
    });
    expect(database.transactions).toEqual([
      [
        {
          sql: expect.stringContaining(
            "create or replace function pg_temp.aais_apply_schema_migration",
          ),
          params: [],
        },
        {
          sql: expect.stringContaining("select pg_temp.aais_apply_schema_migration"),
          params: [
            "0001",
            "aais_baseline",
            "checksum-0001",
            [
              "create table aais_test (id text)",
              "insert into aais_test (id) values ('quoted; semicolon')",
            ],
          ],
        },
      ],
    ]);
    expect(database.executedMigrationStatements).toEqual([
      "create table aais_test (id text)",
      "insert into aais_test (id) values ('quoted; semicolon')",
    ]);
    expect(database.queries.map((query) => query.sql.trim().toLowerCase())).not.toContain("begin");
    expect(database.queries.map((query) => query.sql.trim().toLowerCase())).not.toContain("commit");
    expect(database.applied.get("0001")).toEqual("checksum-0001");
  });

  it("serializes concurrent runners so the same checksum applies once and the loser skips", async () => {
    const database = new ConcurrentFakeTransactionMigrationDatabase();
    const migrations = [createMigration(
      "0042",
      "concurrent_same_checksum",
      "create table concurrent_once (id text);",
    )];

    const reports = await Promise.all([
      runAaisPostgresMigrations({ database, migrations }),
      runAaisPostgresMigrations({ database, migrations }),
    ]);

    expect(reports.map((report) => report.migrations[0].status).sort()).toEqual([
      "applied",
      "skipped",
    ]);
    expect(database.executedMigrationStatements).toEqual([
      "create table concurrent_once (id text)",
    ]);
    expect(database.applied.get("0042")).toBe("checksum-0042");
  });

  it("fails closed when concurrent runners present different checksums for one version", async () => {
    const database = new ConcurrentFakeTransactionMigrationDatabase();
    const first = createMigration(
      "0043",
      "concurrent_checksum_a",
      "create table concurrent_checksum_a (id text);",
    );
    const second = {
      ...createMigration(
        "0043",
        "concurrent_checksum_b",
        "create table concurrent_checksum_b (id text);",
      ),
      checksum: "different-checksum-0043",
    };

    const outcomes = await Promise.allSettled([
      runAaisPostgresMigrations({ database, migrations: [first] }),
      runAaisPostgresMigrations({ database, migrations: [second] }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(Error);
    expect(rejected?.reason.message).toBe("AAIS migration checksum mismatch for 0043.");
    expect(database.executedMigrationStatements).toHaveLength(1);
  });

  it("places the advisory lock, ledger recheck, migration statements, and ledger insert in one transaction", async () => {
    const database = new FakeTransactionMigrationDatabase();
    const migration = createMigration(
      "0044",
      "transaction_guard_contract",
      "create table guarded_one (id text); insert into guarded_one (id) values ('one');",
    );

    await runAaisPostgresMigrations({ database, migrations: [migration] });

    const migrationTransaction = database.transactions.find((transaction) =>
      transaction.some((query) => query.sql.includes("aais_apply_schema_migration"))
    );
    expect(migrationTransaction).toHaveLength(2);
    expect(migrationTransaction[0].sql).toContain(
      "create or replace function pg_temp.aais_apply_schema_migration",
    );
    expect(migrationTransaction[0].sql).toContain("pg_advisory_xact_lock");
    expect(migrationTransaction[0].sql).toContain("hashtextextended");
    expect(migrationTransaction[0].sql).toContain(
      "from public.aais_schema_migrations",
    );
    expect(migrationTransaction[0].sql).toContain(
      "AAIS migration checksum mismatch",
    );
    expect(migrationTransaction[0].sql).toContain("foreach v_statement in array p_statements");
    expect(migrationTransaction[0].sql).toContain(
      "insert into public.aais_schema_migrations",
    );
    expect(migrationTransaction[1]).toEqual({
      sql: expect.stringContaining("select pg_temp.aais_apply_schema_migration"),
      params: [
        "0044",
        "transaction_guard_contract",
        "checksum-0044",
        [
          "create table guarded_one (id text)",
          "insert into guarded_one (id) values ('one')",
        ],
      ],
    });
  });

  it("runs pg migration statements and the ledger write on one checked-out client", async () => {
    const calls = [];
    const client = {
      async query(sql, params = []) {
        calls.push({ sql: sql.trim().toLowerCase(), params });
        return { rows: [] };
      },
      release() {
        calls.push({ sql: "release", params: [] });
      },
    };
    const pool = {
      async query(sql, params = []) {
        calls.push({ sql: `pool:${sql.trim().toLowerCase()}`, params });
        return { rows: [] };
      },
      async connect() {
        calls.push({ sql: "connect", params: [] });
        return client;
      },
      async end() {},
    };
    const database = createPgMigrationDatabaseClient(pool);

    await database.transaction([
      { sql: "create table aais_test (id text)", params: [] },
      { sql: "insert into aais_schema_migrations values ($1)", params: ["0001"] },
    ]);

    expect(calls).toEqual([
      { sql: "connect", params: [] },
      { sql: "begin", params: [] },
      { sql: "create table aais_test (id text)", params: [] },
      { sql: "insert into aais_schema_migrations values ($1)", params: ["0001"] },
      { sql: "commit", params: [] },
      { sql: "release", params: [] },
    ]);
  });

  it("rolls back and releases the same pg client when a migration statement fails", async () => {
    const calls = [];
    const client = {
      async query(sql) {
        const normalized = sql.trim().toLowerCase();
        calls.push(normalized);
        if (normalized === "broken migration") {
          throw new Error("syntax failure");
        }
        return { rows: [] };
      },
      release() {
        calls.push("release");
      },
    };
    const database = createPgMigrationDatabaseClient({
      async query() {
        return { rows: [] };
      },
      async connect() {
        return client;
      },
      async end() {},
    });

    await expect(database.transaction([
      { sql: "create table before_failure (id text)", params: [] },
      { sql: "broken migration", params: [] },
      { sql: "must not run", params: [] },
    ])).rejects.toThrow("syntax failure");
    expect(calls).toEqual([
      "begin",
      "create table before_failure (id text)",
      "broken migration",
      "rollback",
      "release",
    ]);
  });

  it("fails when an applied migration checksum changes", async () => {
    const database = new FakeMigrationDatabase({
      "0001": "older-checksum",
    });
    const migrations = [createMigration("0001", "aais_baseline", "create table aais_test (id text);")];

    await expect(runAaisPostgresMigrations({ database, migrations }))
      .rejects.toThrow("AAIS migration checksum mismatch for 0001.");
  });

  it("resolves Postgres config from URL and raw PG environment without exposing values", () => {
    expect(getAaisMigrationDatabaseConfiguration({
      AAIS_DATABASE_URL: "postgres://user:pass@example.test/aais",
    })).toEqual({
      url: "postgres://user:pass@example.test/aais",
      sourceEnv: "AAIS_DATABASE_URL",
    });
    expect(getAaisMigrationDatabaseConfiguration({
      PGHOST: "db.example.test",
      PGUSER: "aais",
      PGPASSWORD: "secret",
      PGDATABASE: "prod",
      PGPORT: "5433",
    })).toEqual({
      url: "postgres://aais:secret@db.example.test:5433/prod?sslmode=require",
      sourceEnv: "PG*",
    });
  });

  it("resolves research migrations only from the dedicated research URL", () => {
    expect(getAaisResearchMigrationDatabaseConfiguration({
      AAIS_DATABASE_URL: "postgres://product:secret@example.test/aais",
    })).toBeNull();
    expect(getAaisResearchMigrationDatabaseConfiguration({
      AAIS_DATABASE_URL: "postgres://product:secret@example.test/aais",
      AAIS_RESEARCH_DATABASE_URL: "postgres://research:secret@example.test/aais_research",
    })).toEqual({
      url: "postgres://research:secret@example.test/aais_research",
      sourceEnv: "AAIS_RESEARCH_DATABASE_URL",
    });
  });
});

function createMigration(version, name, sql) {
  return {
    version,
    name,
    fileName: `${version}_${name}.sql`,
    sql,
    checksum: `checksum-${version}`,
  };
}

class FakeMigrationDatabase {
  constructor(applied = {}) {
    this.applied = new Map(Object.entries(applied));
    this.queries = [];
  }

  async query(sql, params = []) {
    this.queries.push({ sql, params });
    const normalized = sql.trim().toLowerCase();
    if (normalized.startsWith(
      "select version, checksum from public.aais_schema_migrations",
    )) {
      return {
        rows: [...this.applied.entries()].map(([version, checksum]) => ({
          version,
          checksum,
        })),
      };
    }
    if (normalized.startsWith("insert into aais_schema_migrations")) {
      this.applied.set(String(params[0]), String(params[2]));
    }
    return { rows: [] };
  }
}

class FakeTransactionMigrationDatabase extends FakeMigrationDatabase {
  executedMigrationStatements = [];
  transactions = [];

  async transaction(queries) {
    this.transactions.push(queries.map((query) => ({
      sql: query.sql.trim(),
      params: query.params ?? [],
    })));
    const guardedQuery = queries.find((query) =>
      query.sql.toLowerCase().includes("select pg_temp.aais_apply_schema_migration")
    );
    if (!guardedQuery) {
      for (const query of queries) {
        await this.query(query.sql, query.params);
      }
      return queries.map(() => ({ rows: [] }));
    }

    for (const query of queries) {
      await this.query(query.sql, query.params);
    }
    const [version, , checksum, statements] = guardedQuery.params;
    const normalizedVersion = String(version);
    const normalizedChecksum = String(checksum);
    const appliedChecksum = this.applied.get(normalizedVersion);
    if (appliedChecksum && appliedChecksum !== normalizedChecksum) {
      throw new Error(`AAIS migration checksum mismatch for ${normalizedVersion}.`);
    }
    const status = appliedChecksum ? "skipped" : "applied";
    if (!appliedChecksum) {
      this.executedMigrationStatements.push(
        ...statements.map((statement) => statement.trim()),
      );
      this.applied.set(normalizedVersion, normalizedChecksum);
    }
    return queries.map((query) =>
      query === guardedQuery ? { rows: [{ status }] } : { rows: [] }
    );
  }
}

class ConcurrentFakeTransactionMigrationDatabase extends FakeMigrationDatabase {
  executedMigrationStatements = [];
  #locks = new Map();
  #legacyTransactionsWaiting = 0;
  #releaseLegacyTransactions;
  #legacyTransactionGate = new Promise((resolve) => {
    this.#releaseLegacyTransactions = resolve;
  });

  async transaction(queries) {
    const guardedQuery = queries.find((query) =>
      query.sql.toLowerCase().includes("select pg_temp.aais_apply_schema_migration")
    );
    if (guardedQuery) {
      const [version, , checksum, statements] = guardedQuery.params;
      return this.#withVersionLock(String(version), async () => {
        const appliedChecksum = this.applied.get(String(version));
        if (appliedChecksum && appliedChecksum !== String(checksum)) {
          throw new Error(`AAIS migration checksum mismatch for ${version}.`);
        }
        const status = appliedChecksum ? "skipped" : "applied";
        if (!appliedChecksum) {
          this.executedMigrationStatements.push(...statements.map((statement) => statement.trim()));
          this.applied.set(String(version), String(checksum));
        }
        return queries.map((query) =>
          query === guardedQuery ? { rows: [{ status }] } : { rows: [] }
        );
      });
    }

    const isLegacyMigration = queries.some((query) =>
      query.sql.toLowerCase().includes("insert into aais_schema_migrations")
    );
    if (isLegacyMigration) {
      this.#legacyTransactionsWaiting += 1;
      if (this.#legacyTransactionsWaiting === 2) {
        this.#releaseLegacyTransactions();
      }
      await this.#legacyTransactionGate;
    }
    for (const query of queries) {
      const normalized = query.sql.trim().toLowerCase();
      if (normalized.startsWith("insert into aais_schema_migrations")) {
        const version = String(query.params[0]);
        if (this.applied.has(version)) {
          throw new Error("duplicate key value violates unique constraint");
        }
      } else if (isLegacyMigration) {
        this.executedMigrationStatements.push(query.sql.trim());
      }
      await this.query(query.sql, query.params);
    }
    return queries.map(() => ({ rows: [] }));
  }

  async #withVersionLock(version, operation) {
    const previous = this.#locks.get(version) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.#locks.set(version, previous.then(() => current));
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
