\set ON_ERROR_STOP on

-- Open only inside an approved migration window. This grants enough access
-- for the current additive migrations and migration ledger; ownership may
-- still be required for a future ALTER/DROP migration and must be reviewed.
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
grant connect on database :"DBNAME" to aais_migrator;
grant usage, create on schema public to aais_migrator;
grant all privileges on all tables in schema public to aais_migrator;
grant all privileges on all sequences in schema public to aais_migrator;
grant execute on all functions in schema public to aais_migrator;
