\set ON_ERROR_STOP on

-- Close immediately after the migration and verification window.
alter role aais_migrator nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls
  connection limit 5;
alter role aais_migrator password null;

select pg_terminate_backend(pid)
  from pg_stat_activity
 where usename = 'aais_migrator'
   and pid <> pg_backend_pid();

revoke connect, temporary on database :"DBNAME" from aais_migrator;
revoke all privileges on schema public from aais_migrator;
revoke all privileges on all tables in schema public from aais_migrator;
revoke all privileges on all sequences in schema public from aais_migrator;
revoke all privileges on all functions in schema public from aais_migrator;

select pg_terminate_backend(pid)
  from pg_stat_activity
 where usename = 'aais_migrator'
   and pid <> pg_backend_pid();

select count(*)::integer as migrator_active_sessions
  from pg_stat_activity
 where usename = 'aais_migrator';
