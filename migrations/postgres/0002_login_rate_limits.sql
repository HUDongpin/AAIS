create table if not exists aais_login_rate_limits (
  rate_limit_key text primary key,
  account_key text not null,
  client_key text not null,
  failures integer not null default 0,
  first_failure_at timestamptz not null,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);
