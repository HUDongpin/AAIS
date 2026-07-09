create table if not exists aais_courses (
  id text primary key,
  title jsonb not null check (jsonb_typeof(title) = 'object'),
  status text not null default 'active' check (status in ('active', 'archived')),
  source text not null default 'seed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists aais_course_tasks (
  course_id text not null references aais_courses(id) on delete cascade,
  task_id text not null,
  phase text not null check (phase in ('training', 'practice')),
  phase_title jsonb not null check (jsonb_typeof(phase_title) = 'object'),
  sequence_index integer not null check (sequence_index > 0),
  title jsonb not null check (jsonb_typeof(title) = 'object'),
  difficulty text not null check (difficulty in ('training', 'easy', 'medium', 'hard')),
  locked_until_previous_complete boolean not null default false,
  brief jsonb not null check (jsonb_typeof(brief) = 'object'),
  expert_trace jsonb not null check (jsonb_typeof(expert_trace) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (course_id, task_id),
  unique (course_id, phase, sequence_index)
);

create index if not exists aais_course_tasks_course_phase_idx
  on aais_course_tasks (course_id, phase, sequence_index);

create table if not exists aais_enrollments (
  course_id text not null references aais_courses(id) on delete cascade,
  user_id text not null references aais_users(id) on delete cascade,
  cohort text not null default 'default',
  role text not null check (role in ('student', 'teacher', 'admin')),
  status text not null default 'active' check (status in ('active', 'completed', 'withdrawn')),
  enrolled_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (course_id, user_id)
);

create index if not exists aais_enrollments_cohort_idx
  on aais_enrollments (course_id, cohort, role, status);

insert into aais_courses (
  id,
  title,
  status,
  source,
  updated_at
) values (
  'cognitive-apprenticeship',
  '{"zh-CN":"Cognitive Apprenticeship: 元认知训练","en-US":"Cognitive Apprenticeship: Metacognition Studio"}'::jsonb,
  'active',
  'src/data/aais.ts',
  now()
)
on conflict (id) do update
set
  title = excluded.title,
  status = excluded.status,
  source = excluded.source,
  updated_at = now();

insert into aais_course_tasks (
  course_id,
  task_id,
  phase,
  phase_title,
  sequence_index,
  title,
  difficulty,
  locked_until_previous_complete,
  brief,
  expert_trace,
  updated_at
) values
(
  'cognitive-apprenticeship',
  'training_task_1',
  'training',
  '{"zh-CN":"训练阶段","en-US":"Training Stage"}'::jsonb,
  1,
  '{"zh-CN":"专家示范后的案例训练","en-US":"Guided case after expert modeling"}'::jsonb,
  'training',
  false,
  '{"zh-CN":"阅读一个学习案例，说明任务要求、规划步骤、AI 可以帮助的位置，以及完成前的自我检查标准。","en-US":"Read a learning case, restate the task, plan steps, decide where AI can help, and define a final self-check."}'::jsonb,
  '[{"zh-CN":"专家先复述目标，再标出不确定条件。","en-US":"The expert restates the goal and marks uncertain conditions first."},{"zh-CN":"专家将 AI 放在生成备选解释的位置，而不是直接接受答案。","en-US":"The expert uses AI for alternative explanations, not direct acceptance."},{"zh-CN":"专家完成前回到评分标准，检查证据和边界情况。","en-US":"Before finishing, the expert revisits the rubric, evidence, and boundary cases."}]'::jsonb,
  now()
),
(
  'cognitive-apprenticeship',
  'practice_task_1',
  'practice',
  '{"zh-CN":"练习阶段","en-US":"Practice Stage"}'::jsonb,
  1,
  '{"zh-CN":"L1 挑战：复述与计划","en-US":"L1 Challenge: Restate and Plan"}'::jsonb,
  'easy',
  false,
  '{"zh-CN":"独立完成一个低难度任务，重点展示你如何理解题目和制定计划。","en-US":"Complete an easier task independently, focusing on task interpretation and planning."}'::jsonb,
  '[{"zh-CN":"专家先写出产出物格式，再写步骤。","en-US":"The expert states the output format before writing steps."},{"zh-CN":"专家只向 AI 询问可能遗漏的检查点。","en-US":"The expert asks AI only for possible missed checkpoints."}]'::jsonb,
  now()
),
(
  'cognitive-apprenticeship',
  'practice_task_2',
  'practice',
  '{"zh-CN":"练习阶段","en-US":"Practice Stage"}'::jsonb,
  2,
  '{"zh-CN":"L2 挑战：执行与监控","en-US":"L2 Challenge: Execute and Monitor"}'::jsonb,
  'medium',
  true,
  '{"zh-CN":"完成一个进阶任务，重点记录删改、采纳 AI 建议与偏离计划的原因。","en-US":"Complete a medium task, recording revisions, AI acceptance, and plan changes."}'::jsonb,
  '[{"zh-CN":"专家每次采纳 AI 建议都会写下理由。","en-US":"The expert records a reason for every accepted AI suggestion."},{"zh-CN":"专家发现偏离计划时，先判断是问题变化还是执行失误。","en-US":"When drifting from plan, the expert distinguishes task change from execution error."}]'::jsonb,
  now()
),
(
  'cognitive-apprenticeship',
  'practice_task_3',
  'practice',
  '{"zh-CN":"练习阶段","en-US":"Practice Stage"}'::jsonb,
  3,
  '{"zh-CN":"L3 挑战：迁移与自评","en-US":"L3 Challenge: Transfer and Self-Evaluate"}'::jsonb,
  'hard',
  true,
  '{"zh-CN":"完成一个高难度迁移任务，提交最终成果和对专家差异的自评报告。","en-US":"Complete a harder transfer task, then submit the product and self-evaluation."}'::jsonb,
  '[{"zh-CN":"专家先列反例和失败条件，再完善答案。","en-US":"The expert lists counterexamples and failure conditions before polishing."},{"zh-CN":"专家自评分数不只看结果，也看过程证据是否完整。","en-US":"The expert score considers process evidence as well as final output."}]'::jsonb,
  now()
)
on conflict (course_id, task_id) do update
set
  phase = excluded.phase,
  phase_title = excluded.phase_title,
  sequence_index = excluded.sequence_index,
  title = excluded.title,
  difficulty = excluded.difficulty,
  locked_until_previous_complete = excluded.locked_until_previous_complete,
  brief = excluded.brief,
  expert_trace = excluded.expert_trace,
  updated_at = now();
