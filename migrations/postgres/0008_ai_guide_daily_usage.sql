create table if not exists aais_ai_guide_daily_usage (
  student_id text not null,
  usage_day date not null,
  used integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (student_id, usage_day)
);
