\set ON_ERROR_STOP on

-- Runtime roles for the new self-managed PostgreSQL authority on the Aliyun
-- ECS. Run after the empty database has been created and all migrations have
-- completed. This file intentionally contains no passwords.
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'aais_app_aliyun') then
    create role aais_app_aliyun login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls
      connection limit 10;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'aais_migrator') then
    create role aais_migrator nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls
      connection limit 5;
  end if;
end
$roles$;

alter role aais_app_aliyun login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls
  connection limit 10;
alter role aais_migrator nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls
  connection limit 5;

do $memberships$
begin
  if exists (
    select 1
      from pg_auth_members membership
      join pg_roles member_role on member_role.oid = membership.member
     where member_role.rolname in ('aais_app_aliyun', 'aais_migrator')
  ) then
    raise exception 'AAIS runtime roles must not belong to another role';
  end if;
end
$memberships$;

grant connect on database :"DBNAME" to aais_app_aliyun;
revoke connect, temporary on database :"DBNAME" from aais_migrator;

revoke all privileges on schema public
  from aais_app_aliyun, aais_migrator;
grant usage on schema public to aais_app_aliyun;

revoke all privileges on all tables in schema public
  from aais_app_aliyun, aais_migrator;
revoke all privileges on all sequences in schema public
  from aais_app_aliyun, aais_migrator;
revoke all privileges on all functions in schema public
  from aais_app_aliyun, aais_migrator;
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
    execute format(
      'grant execute on function %s to aais_app_aliyun',
      runtime_function
    );
  end loop;
end
$runtime_functions$;

-- Future migrations stay fail-closed until the explicit migrator window is
-- opened by the Owner. The app role never receives DDL privileges.
alter default privileges for role aais_migrator in schema public
  revoke execute on functions from public;
