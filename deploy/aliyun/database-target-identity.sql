\set ON_ERROR_STOP on

insert into public.aais_runtime_identity (singleton, target_id, updated_at)
values (true, :'TARGET_ID', clock_timestamp())
on conflict (singleton) do update
set target_id = excluded.target_id,
    updated_at = excluded.updated_at;

select target_id, updated_at
  from public.aais_runtime_identity
 where singleton = true;
