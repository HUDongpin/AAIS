create table if not exists public.aais_runtime_leases (
  lease_key text primary key,
  holder_id text not null,
  generation bigint not null default 1,
  expires_at timestamptz not null,
  updated_at timestamptz not null default clock_timestamp(),
  constraint aais_runtime_leases_key_check
    check (lease_key ~ '^[a-z0-9][a-z0-9._:-]{2,63}$'),
  constraint aais_runtime_leases_holder_check
    check (holder_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'),
  constraint aais_runtime_leases_generation_check
    check (generation >= 1),
  constraint aais_runtime_leases_expiry_check
    check (expires_at > updated_at)
);

create index if not exists aais_runtime_leases_expiry_idx
  on public.aais_runtime_leases (expires_at, lease_key);
