-- A claimed outbox row is only a database lease; its frozen xAPI statement
-- can still be held in worker memory after the row is deleted.  Persist a
-- per-learner delivery fence immediately before the first external request so
-- privacy deletion can never report success while an old-generation request
-- is in flight or has an unknown acknowledgement outcome.
alter table public.aais_learner_data_generations
  add column if not exists lrs_delivery_state text not null default 'idle';

alter table public.aais_learner_data_generations
  add column if not exists lrs_delivery_claim_id uuid;

alter table public.aais_learner_data_generations
  add column if not exists lrs_delivery_started_at timestamptz;

alter table public.aais_learner_data_generations
  drop constraint if exists aais_learner_data_generations_lrs_delivery_state_check;

alter table public.aais_learner_data_generations
  add constraint aais_learner_data_generations_lrs_delivery_state_check
  check (
    (
      lrs_delivery_state = 'idle'
      and lrs_delivery_claim_id is null
      and lrs_delivery_started_at is null
    )
    or (
      lrs_delivery_state in ('in_flight', 'uncertain')
      and lrs_delivery_claim_id is not null
      and lrs_delivery_started_at is not null
    )
  );

create index if not exists aais_learner_data_generations_lrs_delivery_idx
  on public.aais_learner_data_generations (lrs_delivery_state, updated_at)
  where lrs_delivery_state <> 'idle';

-- Preserve the 0016 fresh-snapshot cleanup contract and its lock order:
-- generation row first, then learner-owned outbox/task/event/session rows.
-- An in-flight request cannot be cancelled safely.  A request without a 2xx
-- acknowledgement is even less safe to classify, so both states fail closed
-- with distinct private SQL errors rather than returning a deletion row.
create or replace function public.aais_delete_learner_data(
  p_student_id text,
  p_expected_generation bigint,
  p_deleted_at timestamptz
)
returns table (
  next_generation bigint,
  outbox_count integer,
  task_count integer,
  guide_usage_count integer,
  event_count integer,
  session_count integer
)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_current_generation bigint;
  v_delivery_state text;
  v_next_generation bigint;
  v_outbox_count integer := 0;
  v_task_count integer := 0;
  v_guide_usage_count integer := 0;
  v_event_count integer := 0;
  v_session_count integer := 0;
begin
  if p_student_id is null or btrim(p_student_id) = '' then
    raise exception 'AAIS learner deletion student id is required.';
  end if;
  if p_expected_generation is null or p_expected_generation < 1 then
    raise exception 'AAIS learner deletion generation must be positive.';
  end if;
  if p_deleted_at is null then
    raise exception 'AAIS learner deletion timestamp is required.';
  end if;

  select generation.data_generation, generation.lrs_delivery_state
    into v_current_generation, v_delivery_state
  from public.aais_learner_data_generations generation
  where generation.student_id = p_student_id
  for update;

  if not found or v_current_generation <> p_expected_generation then
    return;
  end if;

  if v_delivery_state = 'in_flight' then
    raise exception using
      errcode = 'P0001',
      message = 'AAIS_LRS_DELIVERY_IN_FLIGHT';
  end if;
  if v_delivery_state = 'uncertain' then
    raise exception using
      errcode = 'P0001',
      message = 'AAIS_LRS_DELIVERY_RECONCILIATION_REQUIRED';
  end if;
  if v_delivery_state <> 'idle' then
    raise exception using
      errcode = 'P0001',
      message = 'AAIS_LRS_DELIVERY_FENCE_INVALID';
  end if;

  update public.aais_learner_data_generations generation
  set data_generation = generation.data_generation + 1,
      deleted_at = p_deleted_at,
      updated_at = p_deleted_at
  where generation.student_id = p_student_id
    and generation.data_generation = p_expected_generation
  returning generation.data_generation into v_next_generation;

  if not found then
    return;
  end if;

  delete from public.aais_lrs_outbox outbox
  where outbox.payload->>'student_id' = p_student_id
     or outbox.pending_payload->>'student_id' = p_student_id;
  get diagnostics v_outbox_count = row_count;

  delete from public.aais_learner_task_state task_state
  where task_state.student_id = p_student_id;
  get diagnostics v_task_count = row_count;

  delete from public.aais_ai_guide_daily_usage guide_usage
  where guide_usage.student_id = p_student_id;
  get diagnostics v_guide_usage_count = row_count;

  delete from public.aais_events event_row
  where event_row.student_id = p_student_id;
  get diagnostics v_event_count = row_count;

  delete from public.aais_learner_sessions learner_session
  where learner_session.student_id = p_student_id;
  get diagnostics v_session_count = row_count;

  return query
  select
    v_next_generation,
    v_outbox_count,
    v_task_count,
    v_guide_usage_count,
    v_event_count,
    v_session_count;
end
$$;
