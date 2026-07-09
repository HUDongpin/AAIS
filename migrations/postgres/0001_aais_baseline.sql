create table if not exists aais_learner_sessions (
  student_id text primary key,
  payload jsonb not null,
  version integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table aais_learner_sessions
  add column if not exists version integer not null default 0;

create table if not exists aais_lrs_outbox (
  id text primary key,
  payload jsonb not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
