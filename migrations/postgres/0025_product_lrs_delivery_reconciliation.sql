-- A worker can disappear after acquiring the learner privacy fence and before
-- recording an HTTP result.  The outbox lease alone cannot prove whether the
-- frozen xAPI statements reached the LRS, so persist the exact attempt before
-- the first network request and require statement-by-statement operator
-- evidence before an abandoned attempt is released.
create table if not exists public.aais_lrs_delivery_attempts (
  claim_id uuid primary key,
  state text not null,
  statement_count integer not null,
  statement_set_sha256 text not null,
  started_at timestamptz not null,
  request_timeout_ms integer not null,
  max_attempts integer not null,
  reconcile_after timestamptz not null,
  completed_at timestamptz,
  reconciliation_result text,
  reconciliation_evidence_sha256 text,
  reconciliation_observed_at timestamptz,
  reconciled_at timestamptz,
  reconciled_by text,
  stored_count integer,
  absent_count integer,
  constraint aais_lrs_delivery_attempts_state_check check (
    state in (
      'in_flight',
      'uncertain',
      'acknowledged',
      'rejected',
      'partially_acknowledged',
      'not_dispatched',
      'reconciled'
    )
  ),
  constraint aais_lrs_delivery_attempts_snapshot_check check (
    statement_count between 1 and 50
    and statement_set_sha256 ~ '^[a-f0-9]{64}$'
    and request_timeout_ms between 1 and 60000
    and max_attempts between 1 and 100
    and reconcile_after > started_at
  ),
  constraint aais_lrs_delivery_attempts_completion_check check (
    (state in ('in_flight', 'uncertain') and completed_at is null)
    or (state in (
      'acknowledged',
      'rejected',
      'partially_acknowledged',
      'not_dispatched',
      'reconciled'
    )
      and completed_at is not null)
  ),
  constraint aais_lrs_delivery_attempts_reconciliation_check check (
    (
      state <> 'reconciled'
      and reconciliation_result is null
      and reconciliation_evidence_sha256 is null
      and reconciliation_observed_at is null
      and reconciled_at is null
      and reconciled_by is null
      and stored_count is null
      and absent_count is null
    )
    or (
      state = 'reconciled'
      and reconciliation_result in ('stored', 'absent', 'mixed')
      and reconciliation_evidence_sha256 ~ '^[a-f0-9]{64}$'
      and reconciliation_observed_at is not null
      and reconciled_at is not null
      and reconciled_at >= reconciliation_observed_at
      and reconciled_by ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      and stored_count is not null
      and absent_count is not null
      and stored_count >= 0
      and absent_count >= 0
      and stored_count + absent_count = statement_count
      and (
        (reconciliation_result = 'stored' and stored_count = statement_count)
        or (reconciliation_result = 'absent' and absent_count = statement_count)
        or (reconciliation_result = 'mixed'
          and stored_count > 0 and absent_count > 0)
      )
    )
  )
);

create table if not exists public.aais_lrs_delivery_attempt_statements (
  claim_id uuid not null,
  outbox_id text not null,
  student_id text not null,
  data_generation bigint not null,
  statement_id uuid not null,
  statement_sha256 text not null,
  frozen_statement jsonb not null,
  reconciliation_status text,
  primary key (claim_id, outbox_id),
  constraint aais_lrs_delivery_attempt_statements_attempt_fkey
    foreign key (claim_id) references public.aais_lrs_delivery_attempts(claim_id)
    on delete cascade,
  constraint aais_lrs_delivery_attempt_statements_outbox_fkey
    foreign key (outbox_id) references public.aais_lrs_outbox(id)
    on delete cascade,
  constraint aais_lrs_delivery_attempt_statements_identity_key
    unique (claim_id, statement_id),
  constraint aais_lrs_delivery_attempt_statements_snapshot_check check (
    btrim(student_id) <> ''
    and data_generation >= 1
    and statement_sha256 ~ '^[a-f0-9]{64}$'
    and jsonb_typeof(frozen_statement) = 'object'
    and frozen_statement->>'id' = statement_id::text
  ),
  constraint aais_lrs_delivery_attempt_statements_reconciliation_check check (
    reconciliation_status is null
    or reconciliation_status in ('stored', 'absent')
  )
);

create index if not exists aais_lrs_delivery_attempts_reconciliation_idx
  on public.aais_lrs_delivery_attempts (state, reconcile_after, started_at)
  where state in ('in_flight', 'uncertain');

create index if not exists aais_lrs_delivery_attempt_statements_student_idx
  on public.aais_lrs_delivery_attempt_statements (
    student_id,
    data_generation,
    claim_id
  );
