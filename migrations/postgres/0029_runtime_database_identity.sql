create table if not exists public.aais_runtime_identity (
  singleton boolean primary key default true check (singleton),
  target_id text not null unique,
  updated_at timestamptz not null default clock_timestamp(),
  constraint aais_runtime_identity_target_check
    check (target_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$')
);

-- Deliberately do not seed target_id. The operator must bind a distinct,
-- non-secret identity on the source, rehearsal, and production databases.
