create table if not exists aais_session_revocations (
  token_hash text primary key,
  actor_key text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz not null default now()
);

create index if not exists aais_session_revocations_expires_idx
  on aais_session_revocations (expires_at);
