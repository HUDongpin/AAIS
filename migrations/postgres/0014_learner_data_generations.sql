create table if not exists aais_learner_data_generations (
  student_id text primary key,
  data_generation bigint not null default 1,
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint aais_learner_data_generations_positive_check
    check (data_generation >= 1)
);

insert into aais_learner_data_generations (student_id, data_generation, updated_at)
select distinct learner.student_id, 1, now()
from (
  select student_id from aais_learner_sessions
  union
  select student_id from aais_learner_task_state
  union
  select student_id from aais_events
  union
  select student_id from aais_ai_guide_daily_usage
  union
  select payload->>'student_id' as student_id
  from aais_lrs_outbox
  where payload ? 'student_id'
  union
  select pending_payload->>'student_id' as student_id
  from aais_lrs_outbox
  where pending_payload ? 'student_id'
) learner
where learner.student_id is not null
  and learner.student_id <> ''
on conflict (student_id) do nothing;

-- Existing learner rows predate the request-generation contract. Stamp only
-- the initial generation; a later tombstone must never be used to bless a
-- stale payload left behind by an interrupted or downgraded writer.
update aais_learner_sessions session
set payload = jsonb_set(
  session.payload,
  '{dataGeneration}',
  to_jsonb(generation.data_generation),
  true
)
from aais_learner_data_generations generation
where generation.student_id = session.student_id
  and generation.data_generation = 1
  and not (session.payload ? 'dataGeneration');

create index if not exists aais_learner_data_generations_deleted_idx
  on aais_learner_data_generations (deleted_at desc)
  where deleted_at is not null;
