-- Serialize every statement that removes one or more active administrators.
-- The singleton row is a transaction-scoped database lock: under READ COMMITTED
-- a waiter rechecks the committed state, while stricter isolation levels abort a
-- stale concurrent updater instead of allowing both removals to commit.
create table if not exists public.aais_active_admin_invariant_lock (
  singleton smallint primary key check (singleton = 1),
  lock_version bigint not null default 0 check (lock_version >= 0)
);

insert into public.aais_active_admin_invariant_lock (singleton, lock_version)
values (1, 0)
on conflict (singleton) do nothing;

create or replace function public.aais_enforce_active_admin_after_update()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_removed_active_admin boolean;
begin
  select
    (select count(*) from old_accounts account
      where account.role = 'admin' and account.status = 'active')
    >
    (select count(*) from new_accounts account
      where account.role = 'admin' and account.status = 'active')
  into v_removed_active_admin;

  if not v_removed_active_admin then
    return null;
  end if;

  update public.aais_active_admin_invariant_lock invariant_lock
     set lock_version = invariant_lock.lock_version + 1
   where invariant_lock.singleton = 1;

  if not found then
    raise exception 'AAIS active administrator invariant lock is unavailable.';
  end if;

  if not exists (
    select 1
      from public.aais_users account
     where account.role = 'admin'
       and account.status = 'active'
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'aais_users_active_admin_invariant',
      message = 'AAIS active administrator invariant violation.';
  end if;

  return null;
end
$$;

create or replace function public.aais_enforce_active_admin_after_delete()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if not exists (
    select 1
      from old_accounts account
     where account.role = 'admin'
       and account.status = 'active'
  ) then
    return null;
  end if;

  update public.aais_active_admin_invariant_lock invariant_lock
     set lock_version = invariant_lock.lock_version + 1
   where invariant_lock.singleton = 1;

  if not found then
    raise exception 'AAIS active administrator invariant lock is unavailable.';
  end if;

  if not exists (
    select 1
      from public.aais_users account
     where account.role = 'admin'
       and account.status = 'active'
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'aais_users_active_admin_invariant',
      message = 'AAIS active administrator invariant violation.';
  end if;

  return null;
end
$$;

drop trigger if exists aais_users_active_admin_update_guard on public.aais_users;

create trigger aais_users_active_admin_update_guard
after update on public.aais_users
referencing old table as old_accounts new table as new_accounts
for each statement
execute function public.aais_enforce_active_admin_after_update();

drop trigger if exists aais_users_active_admin_delete_guard on public.aais_users;

create trigger aais_users_active_admin_delete_guard
after delete on public.aais_users
referencing old table as old_accounts
for each statement
execute function public.aais_enforce_active_admin_after_delete();
