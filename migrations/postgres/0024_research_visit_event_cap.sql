-- A formal research visit has a bounded telemetry inventory. Idempotent
-- retries do not reach this trigger because the record-event function returns
-- the existing row before INSERT; only a genuinely new event consumes a slot.

create or replace function public.aais_research_enforce_visit_event_cap()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public, pg_temp
as $function$
begin
  if new.event_sequence > 10000 then
    raise exception using
      errcode = '54000',
      message = 'research visit event limit reached';
  end if;
  return new;
end;
$function$;

drop trigger if exists aais_research_events_visit_cap_guard
  on public.aais_research_events;

create trigger aais_research_events_visit_cap_guard
before insert on public.aais_research_events
for each row
execute function public.aais_research_enforce_visit_event_cap();
