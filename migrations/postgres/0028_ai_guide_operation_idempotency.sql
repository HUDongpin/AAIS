-- Bind one logical learner submission to one budget reservation and one
-- persisted exchange. Diagnostic details deliberately remain outside Postgres.
alter table public.aais_ai_guide_reservations
  add column if not exists data_generation bigint,
  add column if not exists operation_id uuid,
  add column if not exists payload_digest text,
  add column if not exists operation_state text,
  add column if not exists result_message_id text,
  add column if not exists operation_lease_expires_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'aais_ai_guide_reservations_operation_state_check'
      and conrelid = 'public.aais_ai_guide_reservations'::regclass
  ) then
    alter table public.aais_ai_guide_reservations
      add constraint aais_ai_guide_reservations_operation_state_check
      check (
        operation_state is null
        or operation_state in (
          'in_progress',
          'dispatched',
          'completed',
          'failed',
          'dispatched_uncertain'
        )
      );
  end if;
  if not exists (
    select 1
    from pg_constraint
    where conname = 'aais_ai_guide_reservations_payload_digest_check'
      and conrelid = 'public.aais_ai_guide_reservations'::regclass
  ) then
    alter table public.aais_ai_guide_reservations
      add constraint aais_ai_guide_reservations_payload_digest_check
      check (payload_digest is null or payload_digest ~ '^[a-f0-9]{64}$');
  end if;
end
$$;

create unique index if not exists aais_ai_guide_reservations_operation_idx
  on public.aais_ai_guide_reservations (student_id, data_generation, operation_id)
  where operation_id is not null;

create index if not exists aais_ai_guide_reservations_operation_lease_idx
  on public.aais_ai_guide_reservations (operation_lease_expires_at)
  where operation_state in ('in_progress', 'dispatched');

-- This overload preserves the seven-argument reservation function for rolling
-- rollback compatibility while new callers gain idempotent operation claims.
create or replace function public.aais_reserve_ai_guide_request(
  p_student_id text,
  p_usage_day date,
  p_now timestamptz,
  p_limit integer,
  p_reservation_id uuid,
  p_data_generation bigint,
  p_lease_seconds integer,
  p_operation_id uuid,
  p_payload_digest text
)
returns table (
  used integer,
  granted boolean,
  reservation_id text,
  operation_status text,
  result_message_id text
)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_existing public.aais_ai_guide_reservations%rowtype;
  v_used integer := 0;
  v_reserved_used integer;
  v_reserved_granted boolean;
  v_reserved_id text;
  v_status text;
begin
  if p_operation_id is null or p_operation_id <> p_reservation_id then
    raise exception 'AAIS guide operation and reservation ids must match.';
  end if;
  if p_payload_digest is null or p_payload_digest !~ '^[a-f0-9]{64}$' then
    raise exception 'AAIS guide operation payload digest is invalid.';
  end if;

  -- Serializing by the learner generation makes a concurrent duplicate see
  -- the first reservation after waiting instead of dispatching twice.
  perform 1
  from public.aais_learner_data_generations generation
  where generation.student_id = p_student_id
    and generation.data_generation = p_data_generation
  for update;
  if not found then
    return;
  end if;

  select reservation.*
  into v_existing
  from public.aais_ai_guide_reservations reservation
  where reservation.student_id = p_student_id
    and reservation.data_generation = p_data_generation
    and reservation.operation_id = p_operation_id
  for update;

  if found then
    select coalesce(usage_row.used, 0)
    into v_used
    from (select 1) singleton
    left join public.aais_ai_guide_daily_usage usage_row
      on usage_row.student_id = p_student_id
     and usage_row.usage_day = p_usage_day;

    if v_existing.payload_digest is distinct from p_payload_digest then
      return query select v_used, false, v_existing.id::text, 'conflict'::text, null::text;
      return;
    end if;

    if v_existing.operation_state in ('in_progress', 'dispatched')
      and coalesce(v_existing.operation_lease_expires_at, p_now) <= p_now then
      if v_existing.state = 'dispatched' then
        update public.aais_ai_guide_reservations reservation
        set operation_state = 'dispatched_uncertain'
        where reservation.id = v_existing.id
        returning * into v_existing;
      else
        update public.aais_ai_guide_reservations reservation
        set state = 'released',
            finalized_at = p_now,
            operation_state = 'failed'
        where reservation.id = v_existing.id
          and reservation.state = 'reserved'
        returning * into v_existing;

        if found then
          update public.aais_ai_guide_daily_usage usage_row
          set used = greatest(0, usage_row.used - 1),
              updated_at = p_now
          where usage_row.student_id = p_student_id
            and usage_row.usage_day = v_existing.usage_day;
          select coalesce(usage_row.used, 0)
          into v_used
          from (select 1) singleton
          left join public.aais_ai_guide_daily_usage usage_row
            on usage_row.student_id = p_student_id
           and usage_row.usage_day = p_usage_day;
        end if;
      end if;
    end if;

    v_status := case
      when v_existing.operation_state = 'completed' or v_existing.state = 'completed'
        then 'completed'
      when v_existing.operation_state = 'dispatched_uncertain'
        then 'dispatched_uncertain'
      when v_existing.operation_state = 'failed' or v_existing.state = 'released'
        then 'failed'
      else 'in_progress'
    end;
    return query select
      v_used,
      false,
      v_existing.id::text,
      v_status,
      v_existing.result_message_id;
    return;
  end if;

  select reservation.used, reservation.granted, reservation.reservation_id
  into v_reserved_used, v_reserved_granted, v_reserved_id
  from public.aais_reserve_ai_guide_request(
    p_student_id,
    p_usage_day,
    p_now,
    p_limit,
    p_reservation_id,
    p_data_generation,
    p_lease_seconds
  ) reservation;

  if v_reserved_id is null then
    return query select
      coalesce(v_reserved_used, p_limit),
      false,
      null::text,
      'exhausted'::text,
      null::text;
    return;
  end if;

  update public.aais_ai_guide_reservations reservation
  set data_generation = p_data_generation,
      operation_id = p_operation_id,
      payload_digest = p_payload_digest,
      operation_state = 'in_progress',
      operation_lease_expires_at = p_now + interval '60 seconds'
  where reservation.id = p_reservation_id;

  return query select
    coalesce(v_reserved_used, 1),
    coalesce(v_reserved_granted, true),
    v_reserved_id,
    'reserved'::text,
    null::text;
end
$$;
