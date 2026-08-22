-- Privacy deletion must take a fresh READ COMMITTED snapshot after waiting on
-- the per-learner generation row. A single writable-CTE statement cannot do
-- that: newly inserted rows committed while it waits can be invisible to the
-- statement's original snapshot. A VOLATILE PL/pgSQL function executes each
-- cleanup command with a fresh snapshot while keeping the whole call atomic.
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
