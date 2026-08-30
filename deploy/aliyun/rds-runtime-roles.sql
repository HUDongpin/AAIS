\set ON_ERROR_STOP on

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'aais_app_aliyun') then
    create role aais_app_aliyun login nosuperuser nocreatedb nocreaterole noinherit
      connection limit 12;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'aais_migrator') then
    create role aais_migrator nologin nosuperuser nocreatedb nocreaterole noinherit
      connection limit 5;
  end if;
end
$roles$;

alter role aais_migrator nologin;

revoke connect on database :"DBNAME" from public;
grant connect on database :"DBNAME" to aais_app_aliyun;
revoke connect on database :"DBNAME" from aais_migrator;
revoke create on schema public from public;
grant usage on schema public to aais_app_aliyun;
revoke create on schema public from aais_migrator;

revoke all privileges on all tables in schema public from aais_app_aliyun;
revoke all privileges on all sequences in schema public from aais_app_aliyun;
revoke all privileges on all functions in schema public from aais_app_aliyun;

grant select, insert, update, delete on table
  public.aais_ai_guide_daily_usage,
  public.aais_ai_guide_reservations,
  public.aais_auth_email_outbox,
  public.aais_course_tasks,
  public.aais_courses,
  public.aais_enrollments,
  public.aais_events,
  public.aais_learner_data_generations,
  public.aais_learner_sessions,
  public.aais_learner_task_state,
  public.aais_login_rate_limits,
  public.aais_lrs_delivery_attempt_statements,
  public.aais_lrs_delivery_attempts,
  public.aais_lrs_outbox,
  public.aais_runtime_leases,
  public.aais_session_revocations,
  public.aais_user_auth_tokens,
  public.aais_users
to aais_app_aliyun;

grant select, update on table public.aais_active_admin_invariant_lock
to aais_app_aliyun;
grant select on table
  public.aais_runtime_identity,
  public.aais_schema_migrations
to aais_app_aliyun;

do $runtime_functions$
declare
  runtime_function regprocedure;
begin
  for runtime_function in
    select function_row.oid::regprocedure
      from pg_proc function_row
      join pg_namespace function_schema on function_schema.oid = function_row.pronamespace
     where function_schema.nspname = 'public'
       and function_row.proname in (
         'aais_delete_learner_data',
         'aais_reserve_ai_guide_request'
       )
  loop
    execute format('grant execute on function %s to aais_app_aliyun', runtime_function);
  end loop;
end
$runtime_functions$;

-- New migrations are fail-closed: they do not automatically grant the app
-- access to future product, operations, or research objects. Review and amend
-- this explicit allowlist when a runtime migration truly needs access.
alter default privileges for role aais_migrator in schema public
  revoke execute on functions from public;

-- Vercel is intentionally absent: the zero-extra-cost cold backup has no RDS
-- login or grant. Passwords are deliberately absent. The Owner must set each LOGIN role's
-- password through a hidden provider/psql prompt and store it in the matching
-- workload secret manager. Never add ALTER ROLE ... PASSWORD to this file.
