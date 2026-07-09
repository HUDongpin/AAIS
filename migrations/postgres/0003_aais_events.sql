create table if not exists aais_events (
  id text primary key,
  student_id text not null,
  session_id text not null,
  phase text not null,
  task text not null,
  agent text not null,
  event text not null,
  event_time timestamptz not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists aais_events_student_time_idx
  on aais_events (student_id, event_time desc);

create index if not exists aais_events_cohort_analytics_idx
  on aais_events (phase, agent, event, event_time desc);

create index if not exists aais_events_session_idx
  on aais_events (session_id, event_time asc);

create unique index if not exists aais_events_natural_unique_idx
  on aais_events (
    student_id,
    session_id,
    phase,
    task,
    agent,
    event,
    event_time,
    md5(detail::text)
  );

insert into aais_events (
  id,
  student_id,
  session_id,
  phase,
  task,
  agent,
  event,
  event_time,
  detail
)
select
  md5(event_payload::text) as id,
  event_payload->>'student_id' as student_id,
  event_payload->>'session_id' as session_id,
  event_payload->>'phase' as phase,
  event_payload->>'task' as task,
  event_payload->>'agent' as agent,
  event_payload->>'event' as event,
  (event_payload->>'time')::timestamptz as event_time,
  coalesce(event_payload->'detail', '{}'::jsonb) as detail
from aais_learner_sessions
cross join lateral jsonb_array_elements(coalesce(payload->'events', '[]'::jsonb)) as session_events(event_payload)
where event_payload ? 'student_id'
  and event_payload ? 'session_id'
  and event_payload ? 'phase'
  and event_payload ? 'task'
  and event_payload ? 'agent'
  and event_payload ? 'event'
  and event_payload ? 'time'
on conflict do nothing;
