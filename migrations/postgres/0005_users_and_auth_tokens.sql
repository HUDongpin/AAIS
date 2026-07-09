create table if not exists aais_users (
  id text primary key,
  email text not null,
  normalized_email text not null unique,
  display_name text not null,
  role text not null check (role in ('student', 'teacher', 'admin')),
  status text not null check (status in ('invited', 'active', 'disabled')),
  password jsonb,
  invited_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);

create index if not exists aais_users_role_status_idx
  on aais_users (role, status, updated_at desc);

create table if not exists aais_user_auth_tokens (
  id text primary key,
  user_id text not null references aais_users(id) on delete cascade,
  purpose text not null check (purpose in ('invite', 'password_reset')),
  token_hash text not null unique,
  created_by text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists aais_user_auth_tokens_user_idx
  on aais_user_auth_tokens (user_id, purpose, expires_at desc);

create index if not exists aais_user_auth_tokens_active_idx
  on aais_user_auth_tokens (purpose, expires_at desc)
  where consumed_at is null;
