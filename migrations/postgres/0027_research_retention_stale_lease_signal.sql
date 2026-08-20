alter table public.aais_research_retention_runs
  add column if not exists stale_raw_text_write_lease_count integer;

update public.aais_research_retention_runs
   set stale_raw_text_write_lease_count = 0
 where stale_raw_text_write_lease_count is null;

alter table public.aais_research_retention_runs
  alter column stale_raw_text_write_lease_count set default 0,
  alter column stale_raw_text_write_lease_count set not null;

alter table public.aais_research_retention_runs
  drop constraint if exists aais_research_retention_runs_stale_lease_count_check;

alter table public.aais_research_retention_runs
  add constraint aais_research_retention_runs_stale_lease_count_check
  check (stale_raw_text_write_lease_count >= 0);

alter table public.aais_research_retention_runs
  drop constraint if exists aais_research_retention_runs_blocked_signal_check;

alter table public.aais_research_retention_runs
  add constraint aais_research_retention_runs_blocked_signal_check
  check (
    (
      status = 'success'
      and blocked_active_visit_count = 0
      and stale_raw_text_write_lease_count = 0
    )
    or (
      status = 'blocked'
      and (
        blocked_active_visit_count > 0
        or stale_raw_text_write_lease_count > 0
      )
    )
  );
