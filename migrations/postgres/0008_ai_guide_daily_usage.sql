create table if not exists aais_ai_guide_daily_usage (
  student_id text not null,
  usage_day date not null,
  used integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (student_id, usage_day)
);

with utc_day as (
  select
    date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' as starts_at,
    (date_trunc('day', now() at time zone 'UTC') + interval '1 day') at time zone 'UTC' as ends_at
)
insert into aais_ai_guide_daily_usage (
  student_id,
  usage_day,
  used,
  updated_at
)
select
  student_id,
  (event_time at time zone 'UTC')::date,
  count(*)::integer,
  now()
from aais_events
cross join utc_day
where event = 'ai_prompt_submitted'
  and event_time >= utc_day.starts_at
  and event_time < utc_day.ends_at
group by student_id, (event_time at time zone 'UTC')::date
on conflict (student_id, usage_day)
do update set
  used = greatest(aais_ai_guide_daily_usage.used, excluded.used),
  updated_at = case
    when excluded.used > aais_ai_guide_daily_usage.used then excluded.updated_at
    else aais_ai_guide_daily_usage.updated_at
  end;
