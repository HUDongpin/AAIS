-- Serialize controlled event exports with the withdrawal write barrier.
--
-- A single SELECT that waits on the advisory lock would keep the statement
-- snapshot from before the wait.  This VOLATILE PL/pgSQL function deliberately
-- takes the lock in one SPI command and reads the visit in the next command, so
-- under the supported READ COMMITTED isolation level it observes a withdrawal
-- that committed while the export was waiting.

create or replace function public.aais_research_export_events(
  p_project_id text,
  p_study_id text,
  p_environment text,
  p_lrs_namespace text,
  p_study_run_id uuid,
  p_limit integer
)
returns table (
  event_id uuid,
  participant_id uuid,
  study_run_id uuid,
  visit_id uuid,
  project_id text,
  study_id text,
  environment text,
  lrs_namespace text,
  condition text,
  schema_version integer,
  app_version text,
  commit_sha text,
  event_sequence bigint,
  client_time timestamptz,
  server_received_at timestamptz,
  event_name text,
  outcome text,
  retry_count integer,
  disconnect_count integer,
  ai_latency_ms integer,
  detail jsonb,
  lrs_eligible boolean
)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_visit_status text;
begin
  if p_project_id is null or btrim(p_project_id) = ''
    or p_study_id is null or btrim(p_study_id) = ''
    or p_environment is null or btrim(p_environment) = ''
    or p_lrs_namespace is null or btrim(p_lrs_namespace) = ''
    or p_study_run_id is null
    or p_limit is null or p_limit < 1 or p_limit > 10000
  then
    raise exception 'research export input is invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(
    p_project_id || ':' || p_study_id || ':' || p_environment || ':' || p_lrs_namespace
  ));

  select v.status
  into v_visit_status
  from public.aais_research_visits v
  where v.project_id = p_project_id
    and v.study_id = p_study_id
    and v.environment = p_environment
    and v.lrs_namespace = p_lrs_namespace
    and v.study_run_id = p_study_run_id
  for share;

  if not found then
    raise exception 'research study run not found';
  end if;
  if v_visit_status not in ('active', 'completed') then
    raise exception 'research study run is not exportable';
  end if;

  return query
  select
    e.event_id, e.participant_id, e.study_run_id, e.visit_id, e.project_id,
    e.study_id, e.environment, e.lrs_namespace, e.condition, e.schema_version,
    e.app_version, e.commit_sha, e.event_sequence, e.client_time,
    e.server_received_at, e.event_name, e.outcome, e.retry_count,
    e.disconnect_count, e.ai_latency_ms, e.detail, e.lrs_eligible
  from public.aais_research_events e
  where e.project_id = p_project_id
    and e.study_id = p_study_id
    and e.environment = p_environment
    and e.lrs_namespace = p_lrs_namespace
    and e.study_run_id = p_study_run_id
  order by e.participant_id, e.visit_id, e.event_sequence
  limit p_limit;
end;
$function$;
