create table if not exists aais_learner_task_state (
  student_id text not null,
  session_id text not null,
  task text not null,
  phase text not null,
  status text not null,
  artifact_characters integer not null default 0,
  self_report_characters integer not null default 0,
  scaffold_requests integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (student_id, task)
);

create index if not exists aais_learner_task_state_session_idx
  on aais_learner_task_state (session_id, task);

create index if not exists aais_learner_task_state_status_idx
  on aais_learner_task_state (phase, status, updated_at desc);

insert into aais_learner_task_state (
  student_id,
  session_id,
  task,
  phase,
  status,
  artifact_characters,
  self_report_characters,
  scaffold_requests,
  updated_at
)
select
  payload->>'studentId' as student_id,
  payload->>'sessionId' as session_id,
  task_payload->>'taskId' as task,
  task_payload->>'phase' as phase,
  task_payload->>'status' as status,
  length(coalesce(task_payload->>'artifactText', '')) as artifact_characters,
  length(coalesce(task_payload->>'selfReport', '')) as self_report_characters,
  coalesce((task_payload->>'scaffoldRequests')::integer, 0) as scaffold_requests,
  coalesce((payload->>'updatedAt')::timestamptz, now()) as updated_at
from aais_learner_sessions
cross join lateral jsonb_array_elements(coalesce(payload->'tasks', '[]'::jsonb)) as session_tasks(task_payload)
where payload ? 'studentId'
  and payload ? 'sessionId'
  and task_payload ? 'taskId'
  and task_payload ? 'phase'
  and task_payload ? 'status'
on conflict (student_id, task) do update
set
  session_id = excluded.session_id,
  phase = excluded.phase,
  status = excluded.status,
  artifact_characters = excluded.artifact_characters,
  self_report_characters = excluded.self_report_characters,
  scaffold_requests = excluded.scaffold_requests,
  updated_at = excluded.updated_at;
