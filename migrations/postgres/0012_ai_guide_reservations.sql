create table if not exists aais_ai_guide_reservations (
  id uuid primary key,
  student_id text not null,
  usage_day date not null,
  state text not null,
  reserved_at timestamptz not null default now(),
  finalized_at timestamptz,
  constraint aais_ai_guide_reservations_state_check
    check (state in ('reserved', 'completed', 'released')),
  constraint aais_ai_guide_reservations_finalized_check
    check (
      (state = 'reserved' and finalized_at is null)
      or (state in ('completed', 'released') and finalized_at is not null)
    ),
  constraint aais_ai_guide_reservations_usage_fk
    foreign key (student_id, usage_day)
    references aais_ai_guide_daily_usage(student_id, usage_day)
    on delete cascade
);

create index if not exists aais_ai_guide_reservations_student_day_idx
  on aais_ai_guide_reservations (student_id, usage_day, state);
