\set ON_ERROR_STOP on

-- Run as the RDS administrative identity before closing the migration window.
alter role aais_migrator nologin;
revoke connect on database :"DBNAME" from aais_migrator;
revoke create on schema public from aais_migrator;

select pg_terminate_backend(pid)
  from pg_stat_activity
 where usename = 'aais_migrator'
   and pid <> pg_backend_pid();

select count(*)::integer as migrator_active_sessions
  from pg_stat_activity
 where usename = 'aais_migrator';
