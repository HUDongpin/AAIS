\set ON_ERROR_STOP on

-- Read-only preflight for the newly-created AAIS database. Run as the database
-- Owner after migrations, roles, and target identity have been applied. No
-- passwords or row contents are emitted.
\if :{?TARGET_ID}
\else
  \echo 'TARGET_ID must be supplied with -v TARGET_ID=...'
  \quit 2
\endif

select set_config('aais.preflight_target_id', :'TARGET_ID', false);

select 'database_name' as check_name,
       current_database() = 'aais' as ok,
       current_database() as observed;

select 'postgresql_major' as check_name,
       current_setting('server_version_num')::integer >= 170000 as ok,
       split_part(current_setting('server_version'), ' ', 1) as observed;

select 'unix_socket_directory' as check_name,
       current_setting('unix_socket_directories') = '/run/aais/postgresql' as ok,
       current_setting('unix_socket_directories') as observed;

select 'public_tcp_listener' as check_name,
       current_setting('listen_addresses') = '' as ok,
       current_setting('listen_addresses') as observed;

select 'write_target' as check_name,
       (not pg_is_in_recovery())
       and current_setting('transaction_read_only') = 'off' as ok,
       json_build_object(
         'inRecovery', pg_is_in_recovery(),
         'transactionReadOnly', current_setting('transaction_read_only')
       ) as observed;

with expected(version) as (
  values
    ('0001'), ('0002'), ('0003'), ('0004'), ('0005'), ('0006'), ('0007'),
    ('0008'), ('0009'), ('0010'), ('0011'), ('0012'), ('0013'), ('0014'),
    ('0015'), ('0016'), ('0017'), ('0018'), ('0019'), ('0020'), ('0021'),
    ('0022'), ('0023'), ('0024'), ('0025'), ('0026'), ('0027'), ('0028'),
    ('0029')
), observed as (
  select version from public.aais_schema_migrations
)
select 'migration_ledger' as check_name,
       (select count(*) from observed) = (select count(*) from expected)
       and not exists (
         select 1 from expected
         where not exists (select 1 from observed where observed.version = expected.version)
       ) as ok,
       (select count(*) from observed) as observed_count;

select 'target_identity' as check_name,
       count(*) = 1 and max(target_id) = :'TARGET_ID' as ok,
       max(target_id) as observed
  from public.aais_runtime_identity
 where singleton = true;

with expected(rolname, can_login, connection_limit) as (
  values
    ('aais_app_aliyun', true, 10),
    ('aais_migrator', false, 5)
)
select 'role_boundary' as check_name,
       count(*) = 2
       and bool_and(
         role_row.rolcanlogin = expected.can_login
         and role_row.rolsuper = false
         and role_row.rolcreatedb = false
         and role_row.rolcreaterole = false
         and role_row.rolinherit = false
         and role_row.rolreplication = false
         and role_row.rolbypassrls = false
         and role_row.rolconnlimit = expected.connection_limit
       ) as ok,
       count(*) as observed_roles
  from expected
  left join pg_roles role_row on role_row.rolname = expected.rolname;

select 'role_memberships' as check_name,
       count(*) = 0 as ok,
       count(*) as observed_memberships
  from pg_auth_members membership
  join pg_roles member_role on member_role.oid = membership.member
 where member_role.rolname in ('aais_app_aliyun', 'aais_migrator');

select 'runtime_privileges' as check_name,
       has_schema_privilege('aais_app_aliyun', 'public', 'USAGE')
       and has_table_privilege('aais_app_aliyun', 'public.aais_runtime_leases', 'SELECT,INSERT,UPDATE,DELETE')
       and has_table_privilege('aais_app_aliyun', 'public.aais_runtime_identity', 'SELECT')
       and has_table_privilege('aais_app_aliyun', 'public.aais_schema_migrations', 'SELECT') as ok,
       'explicit AAIS runtime allowlist' as observed;

-- Fail closed after printing the diagnostic rows above. A zero exit status is
-- never allowed when a required binding is false.
do $assert$
declare
  observed_count integer;
begin
  if current_database() <> 'aais' then
    raise exception 'AAIS preflight database name mismatch';
  end if;
  if current_setting('server_version_num')::integer < 170000 then
    raise exception 'AAIS preflight requires PostgreSQL 17 or newer';
  end if;
  if current_setting('unix_socket_directories') <> '/run/aais/postgresql' then
    raise exception 'AAIS preflight Unix socket directory mismatch';
  end if;
  if current_setting('listen_addresses') <> '' then
    raise exception 'AAIS preflight requires listen_addresses to be empty';
  end if;
  if pg_is_in_recovery() or current_setting('transaction_read_only') <> 'off' then
    raise exception 'AAIS preflight write target is read-only or in recovery';
  end if;

  select count(*) into observed_count from public.aais_schema_migrations;
  if observed_count <> 29 or exists (
    with expected(version) as (
      values
        ('0001'), ('0002'), ('0003'), ('0004'), ('0005'), ('0006'), ('0007'),
        ('0008'), ('0009'), ('0010'), ('0011'), ('0012'), ('0013'), ('0014'),
        ('0015'), ('0016'), ('0017'), ('0018'), ('0019'), ('0020'), ('0021'),
        ('0022'), ('0023'), ('0024'), ('0025'), ('0026'), ('0027'), ('0028'),
        ('0029')
    )
    select 1 from expected
    where not exists (
      select 1 from public.aais_schema_migrations applied
      where applied.version = expected.version
    )
  ) then
    raise exception 'AAIS preflight migration ledger mismatch';
  end if;

  select count(*) into observed_count
    from public.aais_runtime_identity
   where singleton = true
     and target_id = current_setting('aais.preflight_target_id');
  if observed_count <> 1 then
    raise exception 'AAIS preflight target identity mismatch';
  end if;

  select count(*) into observed_count
    from pg_roles
   where rolname in ('aais_app_aliyun', 'aais_migrator');
  if observed_count <> 2 or exists (
    select 1 from pg_roles
     where rolname = 'aais_app_aliyun'
       and (not rolcanlogin or rolsuper or rolcreatedb or rolcreaterole
            or rolinherit or rolreplication or rolbypassrls or rolconnlimit <> 10)
  ) or exists (
    select 1 from pg_roles
     where rolname = 'aais_migrator'
       and (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole
            or rolinherit or rolreplication or rolbypassrls or rolconnlimit <> 5)
  ) then
    raise exception 'AAIS preflight role boundary mismatch';
  end if;

  if exists (
    select 1
      from pg_auth_members membership
      join pg_roles member_role on member_role.oid = membership.member
     where member_role.rolname in ('aais_app_aliyun', 'aais_migrator')
  ) then
    raise exception 'AAIS preflight role membership mismatch';
  end if;

  if not has_schema_privilege('aais_app_aliyun', 'public', 'USAGE')
     or not has_table_privilege(
       'aais_app_aliyun',
       'public.aais_runtime_leases',
       'SELECT,INSERT,UPDATE,DELETE'
     )
     or not has_table_privilege('aais_app_aliyun', 'public.aais_runtime_identity', 'SELECT')
     or not has_table_privilege('aais_app_aliyun', 'public.aais_schema_migrations', 'SELECT') then
    raise exception 'AAIS preflight runtime privilege mismatch';
  end if;
end
$assert$;

-- The initial database must contain no user, learner, event, outbox, or study
-- rows. The migrations deliberately seed the course catalog, the admin-lock
-- singleton, and one legacy-archive metadata row; those baseline counts are
-- checked below. The loop checks counts only and never selects row data.
do $empty$
declare
  table_row record;
  row_count bigint;
  expected_count bigint;
begin
  for table_row in
    select namespace.nspname as schema_name, relation.relname as table_name
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where relation.relkind = 'r'
       and (namespace.nspname = 'public' or namespace.nspname like 'aais_research%')
       and relation.relname not in ('aais_schema_migrations', 'aais_runtime_identity')
     order by namespace.nspname, relation.relname
  loop
    execute format(
      'select count(*) from %I.%I',
      table_row.schema_name,
      table_row.table_name
    ) into row_count;
    expected_count := case
      when table_row.schema_name = 'public'
        and table_row.table_name = 'aais_active_admin_invariant_lock' then 1
      when table_row.schema_name = 'public'
        and table_row.table_name = 'aais_courses' then 1
      when table_row.schema_name = 'public'
        and table_row.table_name = 'aais_course_tasks' then 4
      when table_row.schema_name = 'public'
        and table_row.table_name = 'aais_research_legacy_archives' then 1
      else 0
    end;
    if row_count <> expected_count then
      raise exception 'AAIS empty database baseline failed for %.% (expected %, observed %)',
        table_row.schema_name, table_row.table_name, expected_count, row_count;
    end if;
  end loop;
end
$empty$;

select 'application_tables_empty' as check_name,
       true as ok,
       'all application tables match the migration baseline; no user data exists' as observed;
