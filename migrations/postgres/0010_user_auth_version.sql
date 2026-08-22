alter table aais_users
  add column if not exists auth_version integer not null default 1;

alter table aais_users
  drop constraint if exists aais_users_auth_version_check;

alter table aais_users
  add constraint aais_users_auth_version_check
  check (auth_version >= 1);
