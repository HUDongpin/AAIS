\set ON_ERROR_STOP on

-- Run as the RDS administrative identity only inside the approved migration
-- window, after the Owner has set the password through a hidden prompt.
grant connect on database :"DBNAME" to aais_migrator;
grant usage, create on schema public to aais_migrator;
alter role aais_migrator login;
