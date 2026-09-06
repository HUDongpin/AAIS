\set ON_ERROR_STOP on

-- Open only inside the Owner-approved migration window for this local
-- PostgreSQL instance. The application role remains unchanged.
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'aais_migrator') then
    create role aais_migrator nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls
      connection limit 5;
  end if;
end
$roles$;

do $membership$
begin
  if exists (
    select 1
      from pg_auth_members membership
      join pg_roles member_role on member_role.oid = membership.member
     where member_role.rolname = 'aais_migrator'
  ) then
    raise exception 'AAIS migrator role must not belong to another role';
  end if;
end
$membership$;

alter role aais_migrator login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls
  connection limit 5;
-- 0009 creates a separate schema; the migration runner also uses pg_temp.
-- Neither capability is granted to the application role.
grant connect, create, temporary on database :"DBNAME" to aais_migrator;
grant usage, create on schema public to aais_migrator;
grant all privileges on all tables in schema public to aais_migrator;
grant all privileges on all sequences in schema public to aais_migrator;
grant execute on all functions in schema public to aais_migrator;
