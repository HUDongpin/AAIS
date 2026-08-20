-- A dispatch is the non-refundable point: after the graph/provider is invoked,
-- external cost may already exist even if the request is cancelled. Keep that
-- state distinct until a successful exchange atomically marks it completed.
alter table public.aais_ai_guide_reservations
  drop constraint if exists aais_ai_guide_reservations_state_check;

alter table public.aais_ai_guide_reservations
  add constraint aais_ai_guide_reservations_state_check
  check (state in ('reserved', 'dispatched', 'completed', 'released'));

alter table public.aais_ai_guide_reservations
  drop constraint if exists aais_ai_guide_reservations_finalized_check;

alter table public.aais_ai_guide_reservations
  add constraint aais_ai_guide_reservations_finalized_check
  check (
    (state = 'reserved' and finalized_at is null)
    or (state in ('dispatched', 'completed', 'released') and finalized_at is not null)
  );

-- A quota interaction on a new UTC day is also the bounded maintenance point
-- for prior daily aggregates. Deleting the parent usage row cascades only
-- prior-day reservation metadata and never changes today's count.
create or replace function public.aais_reserve_ai_guide_request(
  p_student_id text,
  p_usage_day date,
  p_now timestamptz,
  p_limit integer,
  p_reservation_id uuid,
  p_data_generation bigint,
  p_lease_seconds integer
)
returns table (
  used integer,
  granted boolean,
  reservation_id text
)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_generation bigint;
  v_expired_count integer := 0;
  v_existing_used integer;
  v_adjusted_used integer;
  v_next_used integer;
  v_granted boolean;
begin
  if p_student_id is null or btrim(p_student_id) = '' then
    raise exception 'AAIS guide reservation student id is required.';
  end if;
  if p_usage_day is null or p_now is null or p_reservation_id is null then
    raise exception 'AAIS guide reservation identity and time are required.';
  end if;
  if p_limit is null or p_limit < 1
    or p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 600
    or p_data_generation is null or p_data_generation < 1 then
    raise exception 'AAIS guide reservation limits and generation must be positive.';
  end if;

  select generation.data_generation
  into v_generation
  from public.aais_learner_data_generations generation
  where generation.student_id = p_student_id
    and generation.data_generation = p_data_generation
  for update;

  if not found then
    return;
  end if;

  delete from public.aais_ai_guide_daily_usage usage
  where usage.student_id = p_student_id
    and usage.usage_day < p_usage_day;

  update public.aais_ai_guide_reservations reservation
  set state = 'released', finalized_at = p_now
  where reservation.student_id = p_student_id
    and reservation.usage_day = p_usage_day
    and reservation.state = 'reserved'
    and reservation.expires_at <= p_now;
  get diagnostics v_expired_count = row_count;

  select usage.used
  into v_existing_used
  from public.aais_ai_guide_daily_usage usage
  where usage.student_id = p_student_id
    and usage.usage_day = p_usage_day
  for update;

  if found then
    v_adjusted_used := greatest(0, v_existing_used - v_expired_count);
    v_granted := v_adjusted_used < p_limit;
    v_next_used := v_adjusted_used + case when v_granted then 1 else 0 end;

    update public.aais_ai_guide_daily_usage usage
    set used = v_next_used, updated_at = p_now
    where usage.student_id = p_student_id
      and usage.usage_day = p_usage_day;
  else
    v_granted := true;
    v_next_used := 1;

    insert into public.aais_ai_guide_daily_usage (student_id, usage_day, used, updated_at)
    values (p_student_id, p_usage_day, v_next_used, p_now);
  end if;

  if v_granted then
    insert into public.aais_ai_guide_reservations (
      id,
      student_id,
      usage_day,
      state,
      reserved_at,
      finalized_at,
      expires_at
    ) values (
      p_reservation_id,
      p_student_id,
      p_usage_day,
      'reserved',
      p_now,
      null,
      p_now + (p_lease_seconds * interval '1 second')
    );
  end if;

  return query
  select
    v_next_used,
    v_granted,
    case when v_granted then p_reservation_id::text else null end;
end
$$;

-- Learner-content deletion retains the authenticated account. Its current UTC
-- daily guide count is therefore an account anti-abuse control, not learner
-- content: erasing it would let the same account delete/recreate its session to
-- bypass the daily limit. Reservation identifiers can be erased safely once
-- their aggregate used count is retained.
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

  select generation.lrs_delivery_state
    into v_delivery_state
    from public.aais_learner_data_generations generation
   where generation.student_id = p_student_id
     and generation.data_generation = p_expected_generation
   for update;

  if not found then
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

  -- IDs, leases, and completion timestamps are request-level records and can
  -- be erased. The aggregate aais_ai_guide_daily_usage row is deliberately
  -- retained so this account cannot regain quota before the UTC day resets.
  delete from public.aais_ai_guide_reservations reservation
  where reservation.student_id = p_student_id;

  -- Only the current UTC day's content-free aggregate is retained. Older (or
  -- malformed future) rows have no anti-abuse purpose for this deletion and
  -- are removed immediately; guide_usage_count reports those removed rows.
  delete from public.aais_ai_guide_daily_usage guide_usage
  where guide_usage.student_id = p_student_id
    and guide_usage.usage_day <> (p_deleted_at at time zone 'UTC')::date;
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
