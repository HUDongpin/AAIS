alter table public.aais_ai_guide_reservations
  add column if not exists expires_at timestamptz;

-- Reservations created before leases existed receive the same bounded lifetime
-- as new reservations. A crashed request can therefore no longer consume a
-- learner's daily allowance forever.
update public.aais_ai_guide_reservations
set expires_at = reserved_at + interval '600 seconds'
where expires_at is null;

alter table public.aais_ai_guide_reservations
  alter column expires_at set default (now() + interval '600 seconds'),
  alter column expires_at set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'aais_ai_guide_reservations_expiry_check'
      and conrelid = 'aais_ai_guide_reservations'::regclass
  ) then
    alter table public.aais_ai_guide_reservations
      add constraint aais_ai_guide_reservations_expiry_check
      check (expires_at > reserved_at);
  end if;
end
$$;

create index if not exists aais_ai_guide_reservations_reserved_expiry_idx
  on public.aais_ai_guide_reservations (student_id, usage_day, expires_at)
  where state = 'reserved';

-- A function is used instead of one writable-CTE statement because a second
-- concurrent statement can take its MVCC snapshot before waiting on the
-- learner-generation row. Each command inside PL/pgSQL gets the fresh
-- READ COMMITTED snapshot needed to observe the preceding reservation after
-- that lock wait. The daily-usage row is changed by exactly one of the mutually
-- exclusive UPDATE/INSERT branches.
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
