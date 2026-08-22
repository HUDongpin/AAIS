alter table public.aais_login_rate_limits
  add column if not exists expires_at timestamptz;

update public.aais_login_rate_limits
   set expires_at = greatest(
     first_failure_at + interval '24 hours',
     coalesce(locked_until, first_failure_at)
   )
 where expires_at is null;

alter table public.aais_login_rate_limits
  alter column expires_at set default (now() + interval '24 hours'),
  alter column expires_at set not null;

create index if not exists aais_login_rate_limits_expires_idx
  on public.aais_login_rate_limits (expires_at, rate_limit_key);
