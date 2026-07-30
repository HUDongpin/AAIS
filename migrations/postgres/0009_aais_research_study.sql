alter table aais_users
  drop constraint if exists aais_users_role_check;

alter table aais_users
  add constraint aais_users_role_check
  check (role in ('student', 'teacher', 'researcher', 'admin'));

alter table aais_enrollments
  drop constraint if exists aais_enrollments_role_check;

alter table aais_enrollments
  add constraint aais_enrollments_role_check
  check (role in ('student', 'teacher', 'researcher', 'admin'));

create schema if not exists aais_research_identity;
revoke all on schema aais_research_identity from public;

create or replace function aais_research_detail_is_safe(input_value jsonb)
returns boolean
language plpgsql
immutable
strict
as $function$
declare
  item record;
  text_value text;
  numeric_value numeric;
  allowed_keys constant text[] := array[
    'operation_id', 'task_id', 'trigger', 'tab_id', 'content_id', 'document_id',
    'format_id', 'value_id', 'quick_start_id', 'input_mode', 'prompt_length',
    'attachment_count', 'file_count', 'mime_type', 'size_bytes', 'total_size_bytes',
    'error_kind', 'attempt_number', 'retry_reason', 'fallback', 'agent_count',
    'title_length', 'artifact_length', 'previous_characters', 'current_characters',
    'delta_characters', 'width_px', 'delta_px', 'input_method', 'download_method',
    'confirmed', 'pending_save', 'source', 'http_status', 'link_protocol',
    'link_host', 'target_agent_count', 'has_attachments'
  ];
  numeric_keys constant text[] := array[
    'prompt_length', 'attachment_count', 'file_count', 'size_bytes',
    'total_size_bytes', 'attempt_number', 'agent_count', 'title_length',
    'artifact_length', 'previous_characters', 'current_characters',
    'delta_characters', 'width_px', 'delta_px', 'http_status',
    'target_agent_count'
  ];
  boolean_keys constant text[] := array[
    'fallback', 'confirmed', 'pending_save', 'has_attachments'
  ];
begin
  if jsonb_typeof(input_value) <> 'object' then
    return false;
  end if;

  for item in select entry.key, entry.value as child from jsonb_each(input_value) as entry
  loop
    if not (item.key = any(allowed_keys)) then
      return false;
    end if;

    if jsonb_typeof(item.child) = 'null' then
      continue;
    elsif item.key = any(numeric_keys) then
      if jsonb_typeof(item.child) <> 'number' then
        return false;
      end if;
      numeric_value := (item.child #>> '{}')::numeric;
      if numeric_value <> trunc(numeric_value)
        or numeric_value < -9007199254740991
        or numeric_value > 9007199254740991
        or (
          item.key not in ('delta_characters', 'delta_px')
          and numeric_value < 0
        )
        or (item.key = 'attempt_number' and numeric_value < 1)
      then
        return false;
      end if;
    elsif item.key = any(boolean_keys) then
      if jsonb_typeof(item.child) <> 'boolean' then
        return false;
      end if;
    elsif jsonb_typeof(item.child) = 'string' then
      text_value := item.child #>> '{}';
      if length(text_value) > 128
        or text_value !~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$'
      then
        return false;
      end if;

      case item.key
        when 'operation_id' then
          if text_value !~ '^(account-logout|account-menu|ai-guide|artifact-save|attachment-add|attachment-picker|attachment-remove|connectivity|content-back|content-item|content-tab|document-download|document-save-close|document-title|editor-format|guide-link|history-document|learner-delete|learner-export|panel-resize|quick-start|session-load)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
            return false;
          end if;
        when 'task_id' then
          if text_value not in (
            'training_task_1', 'practice_task_1', 'practice_task_2', 'practice_task_3'
          ) then
            return false;
          end if;
        when 'trigger' then
          if text_value not in (
            'manual', 'debounce', 'save_close', 'download', 'blur', 'page_mount',
            'browser_online', 'browser_offline', 'upload_button', 'pointer_start',
            'pointer_cancel', 'pointer_end', 'arrowleft', 'arrowright', 'home',
            'end', 'server_session_revoke'
          ) then
            return false;
          end if;
        when 'tab_id' then
          if text_value not in ('display', 'editor') then
            return false;
          end if;
        when 'content_id' then
          if text_value not in ('platform', 'theory', 'history') then
            return false;
          end if;
        when 'document_id' then
          if text_value !~ '^(training_task_1|practice_task_[1-3])-[0-9]{13}$' then
            return false;
          end if;
        when 'format_id' then
          if text_value not in (
            'heading', 'list', 'font_family', 'font_size', 'bold', 'italic',
            'underline', 'align_left', 'align_center', 'align_right'
          ) then
            return false;
          end if;
        when 'value_id' then
          if text_value not in (
            'open', 'closed', 'h1', 'h2', 'h3', 'unordered', 'ordered', 'system',
            'serif', 'mono', '17', '20', '24', '28', 'bold', 'italic', 'underline',
            'justifyLeft', 'justifyCenter', 'justifyRight'
          ) then
            return false;
          end if;
        when 'quick_start_id' then
          if text_value not in (
            'clarify_goal', 'expert_model', 'request_scaffold', 'organize_reflection'
          ) then
            return false;
          end if;
        when 'input_mode' then
          if text_value not in ('typed', 'quick_start', 'attachment_only') then
            return false;
          end if;
        when 'mime_type' then
          if text_value not in (
            'text/plain', 'text/markdown', 'text/csv', 'application/pdf'
          ) then
            return false;
          end if;
        when 'error_kind' then
          if text_value not in (
            'offline', 'timeout', 'stream_disconnected', 'network', 'request_failed',
            'user_cancelled', 'session_revoke_failed', 'attachment_validation',
            'validation', 'file_count_limit', 'file_read_failed'
          ) then
            return false;
          end if;
        when 'retry_reason' then
          if text_value <> 'stream_protocol_fallback' then
            return false;
          end if;
        when 'source' then
          if text_value <> 'ai_response' then
            return false;
          end if;
        when 'input_method' then
          if text_value not in ('pointer', 'keyboard') then
            return false;
          end if;
        when 'download_method' then
          if text_value not in ('file_picker', 'browser_download') then
            return false;
          end if;
        when 'link_protocol' then
          if text_value not in ('https:', 'http:', 'mailto:') then
            return false;
          end if;
        when 'link_host' then
          if text_value not in ('aais_site', 'external') then
            return false;
          end if;
        else
          return false;
      end case;
    else
      return false;
    end if;
  end loop;

  return true;
end;
$function$;

create or replace function aais_research_apply_fact_retention(
  p_project_id text,
  p_study_id text,
  p_environment text,
  p_lrs_namespace text,
  p_lrs_store_id text,
  p_retention_now timestamptz,
  p_limit integer
)
returns table (
  local_event_deleted_count integer,
  lrs_deletion_request_count integer,
  participation_ledger_deleted_count integer,
  withdrawal_deleted_count integer,
  visit_deleted_count integer,
  participant_deleted_count integer,
  export_audit_deleted_count integer,
  retention_receipt_deleted_count integer,
  lrs_deletion_receipt_deleted_count integer,
  legacy_archive_receipt_deleted_count integer
)
language plpgsql
as $function$
declare
  due_event_ids uuid[];
  event_count integer := 0;
  deletion_count integer := 0;
  deleted_participation_rows integer := 0;
  deleted_withdrawals integer := 0;
  deleted_visits integer := 0;
  deleted_participants integer := 0;
  deleted_export_audits integer := 0;
  deleted_retention_receipts integer := 0;
  deleted_lrs_deletion_receipts integer := 0;
  deleted_legacy_archive_receipts integer := 0;
  coordination_now timestamptz;
  deletion_barrier_at timestamptz;
begin
  if p_limit < 1 or p_limit > 10000 then
    raise exception 'research retention limit is invalid';
  end if;

  perform pg_advisory_xact_lock(hashtext(
    p_project_id || ':' || p_study_id || ':' || p_environment || ':' || p_lrs_namespace
  ));

  select coalesce(array_agg(due.event_id), array[]::uuid[])
  into due_event_ids
  from (
    select e.event_id
    from aais_research_events e
    where e.project_id = p_project_id
      and e.study_id = p_study_id
      and e.environment = p_environment
      and e.lrs_namespace = p_lrs_namespace
      and e.retention_due_at <= p_retention_now
    order by e.retention_due_at, e.event_id
    for update skip locked
    limit p_limit
  ) due;

  event_count := cardinality(due_event_ids);
  if event_count > 0 then
    perform o.outbox_id
    from aais_research_lrs_outbox o
    where o.project_id = p_project_id
      and o.study_id = p_study_id
      and o.environment = p_environment
      and o.lrs_namespace = p_lrs_namespace
      and o.event_id = any(due_event_ids)
    for update;

    coordination_now := clock_timestamp();
    select greatest(
      coordination_now,
      coalesce(max(o.lease_expires_at) filter (where o.status = 'sending'), coordination_now)
    ) + interval '5 seconds'
    into deletion_barrier_at
    from aais_research_lrs_outbox o
    where o.project_id = p_project_id
      and o.study_id = p_study_id
      and o.environment = p_environment
      and o.lrs_namespace = p_lrs_namespace
      and o.event_id = any(due_event_ids);

    insert into aais_research_lrs_deletions (
      deletion_id, withdrawal_id, reason, event_id, statement_id, project_id,
      study_id, environment, lrs_namespace, lrs_store_id, created_at, not_before,
      updated_at, retention_due_at
    )
    select gen_random_uuid(), null, 'retention', o.event_id, o.statement_id,
      p_project_id, p_study_id, p_environment, p_lrs_namespace, p_lrs_store_id,
      coordination_now, deletion_barrier_at, coordination_now,
      greatest(o.retention_due_at, coordination_now + interval '35 days')
    from aais_research_lrs_outbox o
    where o.project_id = p_project_id
      and o.study_id = p_study_id
      and o.environment = p_environment
      and o.lrs_namespace = p_lrs_namespace
      and o.event_id = any(due_event_ids)
    on conflict (project_id, study_id, environment, lrs_namespace, statement_id)
    do update set
      reason = case
        when aais_research_lrs_deletions.reason = 'withdrawal' then 'withdrawal'
        else 'retention'
      end,
      lrs_store_id = excluded.lrs_store_id,
      status = 'pending',
      attempts = 0,
      deletion_claim_id = null,
      lease_expires_at = null,
      last_http_status = null,
      receipt_sha256 = null,
      provider_absence_confirmed_at = null,
      provider_receipt_key_id = null,
      provider_receipt_signature = null,
      last_error = null,
      not_before = greatest(aais_research_lrs_deletions.not_before, excluded.not_before),
      retention_due_at = greatest(
        aais_research_lrs_deletions.retention_due_at,
        excluded.retention_due_at
      ),
      updated_at = excluded.updated_at,
      confirmed_at = null;
    get diagnostics deletion_count = row_count;

    update aais_research_lrs_outbox o
    set status = 'cancelled', delivery_claim_id = null, lease_expires_at = null,
      updated_at = coordination_now
    where o.project_id = p_project_id
      and o.study_id = p_study_id
      and o.environment = p_environment
      and o.lrs_namespace = p_lrs_namespace
      and o.event_id = any(due_event_ids)
      and o.status in ('pending', 'retry', 'sending', 'dead_letter');

    delete from aais_research_events e
    where e.project_id = p_project_id
      and e.study_id = p_study_id
      and e.environment = p_environment
      and e.lrs_namespace = p_lrs_namespace
      and e.event_id = any(due_event_ids);
  end if;

  -- A withdrawn admission cannot be purged until every possible external
  -- statement deletion has a positive provider receipt. Detach those durable,
  -- de-identified receipts before removing the HMAC withdrawal tombstone.
  update aais_research_lrs_deletions d
  set withdrawal_id = null, updated_at = clock_timestamp()
  where d.withdrawal_id in (
    select w.withdrawal_id
    from aais_research_withdrawals w
    join aais_research_identity.aais_research_participation_ledger a
      on a.participant_id = w.participant_id
      and a.visit_id = w.visit_id
      and a.study_run_id = w.study_run_id
      and a.project_id = w.project_id
      and a.study_id = w.study_id
      and a.environment = w.environment
      and a.lrs_namespace = w.lrs_namespace
    where w.project_id = p_project_id
      and w.study_id = p_study_id
      and w.environment = p_environment
      and w.lrs_namespace = p_lrs_namespace
      and a.retention_due_at <= p_retention_now
      and not exists (
        select 1
        from aais_research_lrs_deletions pending
        where pending.withdrawal_id = w.withdrawal_id
          and pending.status <> 'confirmed'
      )
  )
    and d.status = 'confirmed';

  delete from aais_research_withdrawals w
  using aais_research_identity.aais_research_participation_ledger a
  where a.participant_id = w.participant_id
    and a.visit_id = w.visit_id
    and a.study_run_id = w.study_run_id
    and a.project_id = w.project_id
    and a.study_id = w.study_id
    and a.environment = w.environment
    and a.lrs_namespace = w.lrs_namespace
    and w.project_id = p_project_id
    and w.study_id = p_study_id
    and w.environment = p_environment
    and w.lrs_namespace = p_lrs_namespace
    and a.retention_due_at <= p_retention_now
    and not exists (
      select 1 from aais_research_lrs_deletions d
      where d.withdrawal_id = w.withdrawal_id
    );
  get diagnostics deleted_withdrawals = row_count;

  -- The restricted HMAC admission row outlives the 90-day ciphertext map so
  -- one-participation remains enforceable. It is itself a bounded research
  -- fact and is removed only after the visit has no local events or live
  -- withdrawal tombstone at the fact-retention deadline.
  delete from aais_research_identity.aais_research_participation_ledger a
  using aais_research_visits v
  where v.visit_id = a.visit_id
    and v.participant_id = a.participant_id
    and v.study_run_id = a.study_run_id
    and a.project_id = p_project_id
    and a.study_id = p_study_id
    and a.environment = p_environment
    and a.lrs_namespace = p_lrs_namespace
    and a.retention_due_at <= p_retention_now
    and v.status in ('completed', 'withdrawn')
    and v.raw_text_deleted_at is not null
    and not exists (select 1 from aais_research_events e where e.visit_id = v.visit_id)
    and not exists (select 1 from aais_research_withdrawals w where w.visit_id = v.visit_id);
  get diagnostics deleted_participation_rows = row_count;

  delete from aais_research_visits v
  where v.project_id = p_project_id
    and v.study_id = p_study_id
    and v.environment = p_environment
    and v.lrs_namespace = p_lrs_namespace
    and v.status in ('completed', 'withdrawn')
    and v.raw_text_deleted_at is not null
    and v.retention_due_at <= p_retention_now
    and not exists (select 1 from aais_research_events e where e.visit_id = v.visit_id)
    and not exists (select 1 from aais_research_withdrawals w where w.visit_id = v.visit_id)
    and not exists (
      select 1 from aais_research_identity.aais_research_participation_ledger a
      where a.visit_id = v.visit_id
    );
  get diagnostics deleted_visits = row_count;

  delete from aais_research_participants p
  where p.project_id = p_project_id
    and p.study_id = p_study_id
    and p.environment = p_environment
    and p.lrs_namespace = p_lrs_namespace
    and p.retention_due_at <= p_retention_now
    and not exists (select 1 from aais_research_visits v where v.participant_id = p.participant_id)
    and not exists (
      select 1 from aais_research_identity.aais_research_identity_map i
      where i.participant_id = p.participant_id
    )
    and not exists (
      select 1 from aais_research_identity.aais_research_participation_ledger a
      where a.participant_id = p.participant_id
    );
  get diagnostics deleted_participants = row_count;

  delete from aais_research_export_audit a
  where a.project_id = p_project_id
    and a.study_id = p_study_id
    and a.environment = p_environment
    and a.lrs_namespace = p_lrs_namespace
    and a.retention_due_at <= p_retention_now;
  get diagnostics deleted_export_audits = row_count;

  delete from aais_research_retention_runs r
  where r.project_id = p_project_id
    and r.study_id = p_study_id
    and r.environment = p_environment
    and r.lrs_namespace = p_lrs_namespace
    and r.retention_due_at <= p_retention_now;
  get diagnostics deleted_retention_receipts = row_count;

  delete from aais_research_lrs_deletions d
  where d.project_id = p_project_id
    and d.study_id = p_study_id
    and d.environment = p_environment
    and d.lrs_namespace = p_lrs_namespace
    and d.status = 'confirmed'
    and d.withdrawal_id is null
    and d.retention_due_at <= p_retention_now;
  get diagnostics deleted_lrs_deletion_receipts = row_count;

  delete from aais_research_legacy_archives a
  where a.project_id = p_project_id
    and a.study_id = p_study_id
    and a.environment = p_environment
    and a.lrs_namespace = p_lrs_namespace
    and a.status = 'archived'
    and a.retention_due_at <= p_retention_now;
  get diagnostics deleted_legacy_archive_receipts = row_count;

  return query select event_count, deletion_count, deleted_participation_rows,
    deleted_withdrawals, deleted_visits, deleted_participants,
    deleted_export_audits, deleted_retention_receipts,
    deleted_lrs_deletion_receipts, deleted_legacy_archive_receipts;
end;
$function$;

create table if not exists aais_research_participants (
  participant_id uuid primary key,
  project_id text not null default 'aais' check (project_id = 'aais'),
  study_id text not null,
  environment text not null check (environment in ('production', 'staging', 'research')),
  lrs_namespace text not null check (lrs_namespace like 'https://www.aais.site/xapi/%'),
  status text not null default 'active' check (status in ('active', 'withdrawn')),
  created_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  retention_due_at timestamptz not null
);

create unique index if not exists aais_research_participants_scope_id_idx
  on aais_research_participants (project_id, study_id, environment, lrs_namespace, participant_id);
create index if not exists aais_research_participants_scope_status_idx
  on aais_research_participants (project_id, study_id, environment, lrs_namespace, status, created_at);
create index if not exists aais_research_participants_scope_retention_idx
  on aais_research_participants (project_id, study_id, environment, lrs_namespace, retention_due_at);

create table if not exists aais_research_identity.aais_research_identity_map (
  participant_id uuid primary key references aais_research_participants(participant_id) on delete cascade,
  project_id text not null default 'aais' check (project_id = 'aais'),
  study_id text not null,
  environment text not null check (environment in ('production', 'staging', 'research')),
  lrs_namespace text not null check (lrs_namespace like 'https://www.aais.site/xapi/%'),
  ciphertext bytea not null,
  iv bytea not null check (octet_length(iv) = 12),
  authentication_tag bytea not null check (octet_length(authentication_tag) = 16),
  key_version text not null check (key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  created_at timestamptz not null default now(),
  retention_due_at timestamptz not null,
  constraint aais_research_identity_scope_key_iv_unique
    unique (project_id, study_id, environment, lrs_namespace, key_version, iv)
);

revoke all on table aais_research_identity.aais_research_identity_map from public;
create index if not exists aais_research_identity_scope_retention_idx
  on aais_research_identity.aais_research_identity_map
    (project_id, study_id, environment, lrs_namespace, retention_due_at);

create table if not exists aais_research_visits (
  visit_id uuid primary key,
  participant_id uuid not null references aais_research_participants(participant_id),
  study_run_id uuid not null,
  project_id text not null default 'aais' check (project_id = 'aais'),
  study_id text not null,
  environment text not null check (environment in ('production', 'staging', 'research')),
  lrs_namespace text not null check (lrs_namespace like 'https://www.aais.site/xapi/%'),
  condition text not null check (condition ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  status text not null default 'active'
    check (status in ('active', 'completed', 'withdrawing', 'withdrawn')),
  next_event_sequence bigint not null default 1 check (next_event_sequence > 0),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  withdrawn_at timestamptz,
  raw_text_retention_due_at timestamptz,
  raw_text_deleted_at timestamptz,
  raw_text_storage text check (raw_text_storage in ('postgres', 'file')),
  retention_due_at timestamptz not null,
  unique (project_id, study_id, environment, lrs_namespace, participant_id),
  unique (project_id, study_id, environment, lrs_namespace, study_run_id),
  unique (project_id, study_id, environment, lrs_namespace, visit_id)
);

create index if not exists aais_research_visits_scope_condition_idx
  on aais_research_visits (project_id, study_id, environment, lrs_namespace, condition, started_at);
create index if not exists aais_research_visits_scope_status_idx
  on aais_research_visits (project_id, study_id, environment, lrs_namespace, status, started_at);
create index if not exists aais_research_visits_scope_retention_idx
  on aais_research_visits (project_id, study_id, environment, lrs_namespace, retention_due_at);
create index if not exists aais_research_visits_scope_raw_retention_idx
  on aais_research_visits
    (project_id, study_id, environment, lrs_namespace, raw_text_retention_due_at)
  where raw_text_deleted_at is null;

create table if not exists aais_research_identity.aais_research_participation_ledger (
  participant_id uuid primary key references aais_research_participants(participant_id),
  study_run_id uuid not null,
  visit_id uuid not null references aais_research_visits(visit_id),
  project_id text not null default 'aais' check (project_id = 'aais'),
  study_id text not null,
  environment text not null check (environment in ('production', 'staging', 'research')),
  lrs_namespace text not null check (lrs_namespace like 'https://www.aais.site/xapi/%'),
  admission_fingerprint text not null check (admission_fingerprint ~ '^[0-9a-f]{64}$'),
  identity_key_version text not null
    check (identity_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  identity_iv bytea not null check (octet_length(identity_iv) = 12),
  status text not null default 'admitted' check (status in ('admitted', 'withdrawn')),
  admitted_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  retention_due_at timestamptz not null,
  constraint aais_research_participation_scope_fingerprint_unique
    unique (project_id, study_id, environment, lrs_namespace, admission_fingerprint),
  constraint aais_research_participation_scope_run_unique
    unique (project_id, study_id, environment, lrs_namespace, study_run_id),
  constraint aais_research_participation_scope_visit_unique
    unique (project_id, study_id, environment, lrs_namespace, visit_id),
  constraint aais_research_participation_scope_key_iv_unique
    unique (project_id, study_id, environment, lrs_namespace, identity_key_version, identity_iv)
);

revoke all on table aais_research_identity.aais_research_participation_ledger from public;
create index if not exists aais_research_participation_scope_status_idx
  on aais_research_identity.aais_research_participation_ledger
    (project_id, study_id, environment, lrs_namespace, status, admitted_at);
create index if not exists aais_research_participation_scope_retention_idx
  on aais_research_identity.aais_research_participation_ledger
    (project_id, study_id, environment, lrs_namespace, retention_due_at);

-- An opaque lease serializes product-store raw-text writes against research
-- erasure. The table contains no learner text or plaintext actor identity.
-- expires_at is an operational stale-lease signal only: it is never authority
-- to erase or ignore an unreleased lease. A withdrawal closes the visit first
-- and refuses to delete raw text until every admitted writer explicitly ends.
create table if not exists aais_research_raw_write_leases (
  lease_id uuid primary key,
  participant_id uuid not null
    references aais_research_participants(participant_id) on delete cascade,
  visit_id uuid not null references aais_research_visits(visit_id) on delete cascade,
  project_id text not null default 'aais' check (project_id = 'aais'),
  study_id text not null,
  environment text not null check (environment in ('production', 'staging', 'research')),
  lrs_namespace text not null check (lrs_namespace like 'https://www.aais.site/xapi/%'),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  check (expires_at > created_at),
  unique (project_id, study_id, environment, lrs_namespace, lease_id)
);

revoke all on table aais_research_raw_write_leases from public;
create index if not exists aais_research_raw_write_leases_scope_expiry_idx
  on aais_research_raw_write_leases
    (project_id, study_id, environment, lrs_namespace, visit_id, expires_at);

create table if not exists aais_research_events (
  event_id uuid primary key,
  client_event_id uuid not null,
  participant_id uuid not null references aais_research_participants(participant_id),
  study_run_id uuid not null,
  visit_id uuid not null references aais_research_visits(visit_id),
  project_id text not null default 'aais' check (project_id = 'aais'),
  study_id text not null,
  environment text not null check (environment in ('production', 'staging', 'research')),
  lrs_namespace text not null check (lrs_namespace like 'https://www.aais.site/xapi/%'),
  condition text not null,
  schema_version integer not null default 1 check (schema_version = 1),
  app_version text not null,
  commit_sha text not null check (commit_sha ~ '^[0-9A-Fa-f]{7,64}$'),
  event_sequence bigint not null check (event_sequence > 0),
  client_time timestamptz not null,
  server_received_at timestamptz not null default now(),
  event_name text not null check (event_name in (
    'workspace_session_load', 'client_connectivity', 'account_menu_toggled',
    'learner_data_export', 'learner_data_delete', 'account_logout',
    'content_tab_selected', 'content_item_opened', 'content_item_back',
    'history_document_opened', 'panel_resize_completed', 'guide_quick_start_selected',
    'guide_attachment_picker_opened', 'guide_attachment_add', 'guide_attachment_removed',
    'ai_guide_submit', 'guide_response_link_opened', 'document_artifact_save',
    'document_title_committed', 'editor_format_applied', 'document_save_closed',
    'document_download'
  )),
  outcome text not null check (outcome in ('attempted', 'success', 'failure', 'retry', 'disconnected')),
  retry_count integer not null default 0 check (retry_count >= 0),
  disconnect_count integer not null default 0 check (disconnect_count >= 0),
  ai_latency_ms integer check (ai_latency_ms is null or ai_latency_ms >= 0),
  detail jsonb not null default '{}'::jsonb check (aais_research_detail_is_safe(detail)),
  lrs_eligible boolean not null,
  retention_due_at timestamptz not null,
  unique (project_id, study_id, environment, lrs_namespace, visit_id, client_event_id),
  unique (project_id, study_id, environment, lrs_namespace, visit_id, event_sequence)
);

create index if not exists aais_research_events_scope_run_order_idx
  on aais_research_events
    (project_id, study_id, environment, lrs_namespace, study_run_id, participant_id, visit_id, event_sequence);
create index if not exists aais_research_events_scope_name_idx
  on aais_research_events (project_id, study_id, environment, lrs_namespace, event_name, server_received_at);
create index if not exists aais_research_events_scope_retention_idx
  on aais_research_events (project_id, study_id, environment, lrs_namespace, retention_due_at);

create table if not exists aais_research_lrs_outbox (
  outbox_id uuid primary key,
  event_id uuid not null unique references aais_research_events(event_id) on delete cascade,
  statement_id uuid not null unique,
  project_id text not null default 'aais' check (project_id = 'aais'),
  study_id text not null,
  environment text not null check (environment in ('production', 'staging', 'research')),
  lrs_namespace text not null check (lrs_namespace like 'https://www.aais.site/xapi/%'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  lrs_eligible boolean not null,
  status text not null default 'pending' check (status in ('pending', 'retry', 'sending', 'sent', 'dead_letter', 'cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  delivery_claim_id uuid,
  lease_expires_at timestamptz,
  check (
    (status = 'sending' and delivery_claim_id is not null and lease_expires_at is not null)
    or (status <> 'sending' and delivery_claim_id is null and lease_expires_at is null)
  ),
  last_http_status integer,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  retention_due_at timestamptz not null
);

create index if not exists aais_research_outbox_scope_status_idx
  on aais_research_lrs_outbox
    (project_id, study_id, environment, lrs_namespace, status, created_at);
create index if not exists aais_research_outbox_scope_retention_idx
  on aais_research_lrs_outbox
    (project_id, study_id, environment, lrs_namespace, retention_due_at);

create table if not exists aais_research_export_audit (
  export_audit_id uuid primary key,
  project_id text not null default 'aais' check (project_id = 'aais'),
  study_id text not null,
  environment text not null check (environment in ('production', 'staging', 'research')),
  lrs_namespace text not null check (lrs_namespace like 'https://www.aais.site/xapi/%'),
  actor_fingerprint text not null check (actor_fingerprint ~ '^[0-9a-f]{64}$'),
  purpose text not null check (purpose in ('approved_analysis', 'reconciliation', 'quality_audit', 'replication')),
  outcome text not null check (outcome in ('success', 'failure')),
  filters jsonb not null check (jsonb_typeof(filters) = 'object'),
  export_format text not null check (export_format in ('json', 'csv')),
  schema_version integer not null default 1 check (schema_version = 1),
  commit_sha text not null check (commit_sha ~ '^[0-9A-Fa-f]{7,64}$'),
  row_count integer not null check (row_count >= 0),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  retention_due_at timestamptz not null
);

create index if not exists aais_research_export_audit_scope_time_idx
  on aais_research_export_audit
    (project_id, study_id, environment, lrs_namespace, created_at desc);
create index if not exists aais_research_export_audit_scope_retention_idx
  on aais_research_export_audit
    (project_id, study_id, environment, lrs_namespace, retention_due_at);

create table if not exists aais_research_withdrawals (
  withdrawal_id uuid primary key,
  participant_id uuid not null references aais_research_participants(participant_id),
  visit_id uuid not null references aais_research_visits(visit_id),
  study_run_id uuid not null,
  project_id text not null default 'aais' check (project_id = 'aais'),
  study_id text not null,
  environment text not null check (environment in ('production', 'staging', 'research')),
  lrs_namespace text not null check (lrs_namespace like 'https://www.aais.site/xapi/%'),
  admission_fingerprint text not null check (admission_fingerprint ~ '^[0-9a-f]{64}$'),
  requested_by_fingerprint text not null check (requested_by_fingerprint ~ '^[0-9a-f]{64}$'),
  local_event_count integer not null default 0 check (local_event_count >= 0),
  deletion_request_count integer not null default 0 check (deletion_request_count >= 0),
  identity_deleted boolean not null default false,
  restricted_raw_text_deleted boolean not null default false,
  raw_text_storage text check (raw_text_storage in ('postgres', 'file')),
  created_at timestamptz not null default now(),
  unique (project_id, study_id, environment, lrs_namespace, visit_id),
  unique (project_id, study_id, environment, lrs_namespace, admission_fingerprint)
);

create index if not exists aais_research_withdrawals_scope_time_idx
  on aais_research_withdrawals
    (project_id, study_id, environment, lrs_namespace, created_at desc);

create table if not exists aais_research_lrs_deletions (
  deletion_id uuid primary key,
  withdrawal_id uuid references aais_research_withdrawals(withdrawal_id),
  reason text not null check (reason in ('withdrawal', 'retention')),
  event_id uuid not null,
  statement_id uuid not null,
  project_id text not null default 'aais' check (project_id = 'aais'),
  study_id text not null,
  environment text not null check (environment in ('production', 'staging', 'research')),
  lrs_namespace text not null check (lrs_namespace like 'https://www.aais.site/xapi/%'),
  lrs_store_id text not null check (lrs_store_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  status text not null default 'pending' check (status in ('pending', 'retry', 'deleting', 'confirmed', 'dead_letter')),
  attempts integer not null default 0 check (attempts >= 0),
  deletion_claim_id uuid,
  lease_expires_at timestamptz,
  check (
    (status = 'deleting' and deletion_claim_id is not null and lease_expires_at is not null)
    or (status <> 'deleting' and deletion_claim_id is null and lease_expires_at is null)
  ),
  last_http_status integer,
  receipt_sha256 text,
  provider_absence_confirmed_at timestamptz,
  provider_receipt_key_id text,
  provider_receipt_signature text,
  last_error text,
  created_at timestamptz not null default now(),
  not_before timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  retention_due_at timestamptz not null,
  unique (project_id, study_id, environment, lrs_namespace, statement_id),
  check (receipt_sha256 is null or receipt_sha256 ~ '^[0-9a-f]{64}$'),
  check (
    (status = 'confirmed'
      and receipt_sha256 is not null
      and provider_absence_confirmed_at is not null
      and provider_receipt_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      and provider_receipt_signature ~ '^[A-Za-z0-9_-]{86}$'
      and confirmed_at is not null)
    or (status <> 'confirmed'
      and provider_absence_confirmed_at is null
      and provider_receipt_key_id is null
      and provider_receipt_signature is null
      and confirmed_at is null)
  )
);

create index if not exists aais_research_deletions_scope_status_idx
  on aais_research_lrs_deletions
    (project_id, study_id, environment, lrs_namespace, status, created_at);
create index if not exists aais_research_deletions_scope_retention_idx
  on aais_research_lrs_deletions
    (project_id, study_id, environment, lrs_namespace, retention_due_at);

create table if not exists aais_research_retention_runs (
  retention_run_id uuid primary key,
  project_id text not null default 'aais' check (project_id = 'aais'),
  study_id text not null,
  environment text not null check (environment in ('production', 'staging', 'research')),
  lrs_namespace text not null check (lrs_namespace like 'https://www.aais.site/xapi/%'),
  cutoff_at timestamptz not null,
  raw_text_deleted_count integer not null check (raw_text_deleted_count >= 0),
  identity_deleted_count integer not null check (identity_deleted_count >= 0),
  participation_ledger_deleted_count integer not null
    check (participation_ledger_deleted_count >= 0),
  withdrawal_deleted_count integer not null check (withdrawal_deleted_count >= 0),
  local_event_deleted_count integer not null check (local_event_deleted_count >= 0),
  lrs_deletion_request_count integer not null check (lrs_deletion_request_count >= 0),
  visit_deleted_count integer not null check (visit_deleted_count >= 0),
  participant_deleted_count integer not null check (participant_deleted_count >= 0),
  export_audit_deleted_count integer not null check (export_audit_deleted_count >= 0),
  retention_receipt_deleted_count integer not null
    check (retention_receipt_deleted_count >= 0),
  lrs_deletion_receipt_deleted_count integer not null
    check (lrs_deletion_receipt_deleted_count >= 0),
  legacy_archive_receipt_deleted_count integer not null
    check (legacy_archive_receipt_deleted_count >= 0),
  blocked_active_visit_count integer not null check (blocked_active_visit_count >= 0),
  status text not null check (status in ('success', 'blocked')),
  created_at timestamptz not null default now(),
  retention_due_at timestamptz not null
);

create index if not exists aais_research_retention_runs_scope_time_idx
  on aais_research_retention_runs
    (project_id, study_id, environment, lrs_namespace, created_at desc);
create index if not exists aais_research_retention_runs_scope_retention_idx
  on aais_research_retention_runs
    (project_id, study_id, environment, lrs_namespace, retention_due_at);

create table if not exists aais_research_legacy_archives (
  legacy_archive_id uuid primary key,
  project_id text not null default 'aais' check (project_id = 'aais'),
  study_id text not null,
  environment text not null check (environment in ('production', 'staging', 'research')),
  lrs_namespace text not null check (
    lrs_namespace = 'https://www.aais.site/xapi'
    or lrs_namespace like 'https://www.aais.site/xapi/%'
  ),
  statement_count integer not null check (statement_count >= 0),
  source_pool text not null,
  status text not null check (status in ('inventory_declared', 'archived')),
  archived_at timestamptz,
  manifest_sha256 text,
  note text not null,
  created_at timestamptz not null default now(),
  retention_due_at timestamptz not null,
  unique (project_id, study_id, environment, lrs_namespace, source_pool)
);

create index if not exists aais_research_legacy_archives_scope_idx
  on aais_research_legacy_archives
    (project_id, study_id, environment, lrs_namespace, status);
create index if not exists aais_research_legacy_archives_scope_retention_idx
  on aais_research_legacy_archives
    (project_id, study_id, environment, lrs_namespace, retention_due_at);

insert into aais_research_legacy_archives (
  legacy_archive_id,
  project_id,
  study_id,
  environment,
  lrs_namespace,
  statement_count,
  source_pool,
  status,
  archived_at,
  manifest_sha256,
  note,
  retention_due_at
) values (
  '00000000-0000-4000-8000-000000000828'::uuid,
  'aais',
  'legacy-aais',
  'production',
  'https://www.aais.site/xapi',
  828,
  'legacy-mixed-aais-mais',
  'inventory_declared',
  null,
  null,
  'Inventory only; external archive or migration receipt remains pending.',
  now() + interval '1825 days'
)
on conflict (project_id, study_id, environment, lrs_namespace, source_pool) do nothing;

create or replace function aais_research_create_visit(
  p_project_id text,
  p_study_id text,
  p_environment text,
  p_lrs_namespace text,
  p_participant_id uuid,
  p_study_run_id uuid,
  p_visit_id uuid,
  p_admission_fingerprint text,
  p_ciphertext bytea,
  p_iv bytea,
  p_authentication_tag bytea,
  p_key_version text,
  p_conditions text[],
  p_max_participants integer,
  p_identity_retention_due_at timestamptz,
  p_fact_retention_due_at timestamptz
)
returns table (
  participant_id uuid,
  study_run_id uuid,
  visit_id uuid,
  condition text,
  visit_status text,
  created boolean
)
language plpgsql
as $function$
declare
  existing_record record;
  selected_condition text;
  participant_count integer;
begin
  if p_project_id <> 'aais'
    or p_environment not in ('production', 'staging', 'research')
    or p_lrs_namespace not like 'https://www.aais.site/xapi/%'
    or coalesce(array_length(p_conditions, 1), 0) = 0
    or p_max_participants <> 30
  then
    raise exception 'invalid research study scope';
  end if;

  perform pg_advisory_xact_lock(hashtext(
    p_project_id || ':' || p_study_id || ':' || p_environment || ':' || p_lrs_namespace
  ));

  select p.participant_id, v.study_run_id, v.visit_id, v.condition, v.status,
    a.status as admission_status
  into existing_record
  from aais_research_identity.aais_research_participation_ledger a
  join aais_research_participants p on p.participant_id = a.participant_id
  join aais_research_visits v
    on v.visit_id = a.visit_id
    and v.participant_id = a.participant_id
    and v.study_run_id = a.study_run_id
  where a.project_id = p_project_id
    and a.study_id = p_study_id
    and a.environment = p_environment
    and a.lrs_namespace = p_lrs_namespace
    and a.admission_fingerprint = p_admission_fingerprint;

  if found then
    if existing_record.admission_status = 'withdrawn'
      or existing_record.status = 'withdrawn'
    then
      raise exception 'research participant withdrawn';
    end if;
    return query select
      existing_record.participant_id,
      existing_record.study_run_id,
      existing_record.visit_id,
      existing_record.condition,
      existing_record.status,
      false;
    return;
  end if;

  -- AES-GCM nonce reuse under one scope and key version is a security failure,
  -- including after the 90-day ciphertext row has been destroyed. The
  -- participation ledger therefore preserves the nonce reservation for the
  -- bounded fact lifecycle and this transaction fails closed on collision.
  if exists (
    select 1
    from aais_research_identity.aais_research_participation_ledger a
    where a.project_id = p_project_id
      and a.study_id = p_study_id
      and a.environment = p_environment
      and a.lrs_namespace = p_lrs_namespace
      and a.identity_key_version = p_key_version
      and a.identity_iv = p_iv
  ) then
    raise exception 'research identity nonce collision';
  end if;

  select count(*)::integer into participant_count
  from aais_research_identity.aais_research_participation_ledger a
  where a.project_id = p_project_id
    and a.study_id = p_study_id
    and a.environment = p_environment
    and a.lrs_namespace = p_lrs_namespace;

  if participant_count >= 30 then
    raise exception 'research participant capacity reached';
  end if;

  select candidate.condition
  into selected_condition
  from unnest(p_conditions) with ordinality as candidate(condition, ordinal)
  left join aais_research_visits v
    on v.project_id = p_project_id
    and v.study_id = p_study_id
    and v.environment = p_environment
    and v.lrs_namespace = p_lrs_namespace
    and v.condition = candidate.condition
  group by candidate.condition, candidate.ordinal
  order by count(v.visit_id), candidate.ordinal
  limit 1;

  insert into aais_research_participants (
    participant_id, project_id, study_id, environment, lrs_namespace, retention_due_at
  ) values (
    p_participant_id, p_project_id, p_study_id, p_environment, p_lrs_namespace,
    p_fact_retention_due_at
  );

  insert into aais_research_identity.aais_research_identity_map (
    participant_id, project_id, study_id, environment, lrs_namespace,
    ciphertext, iv, authentication_tag, key_version, retention_due_at
  ) values (
    p_participant_id, p_project_id, p_study_id, p_environment, p_lrs_namespace,
    p_ciphertext, p_iv, p_authentication_tag, p_key_version, p_identity_retention_due_at
  );

  insert into aais_research_visits (
    visit_id, participant_id, study_run_id, project_id, study_id, environment,
    lrs_namespace, condition, retention_due_at
  ) values (
    p_visit_id, p_participant_id, p_study_run_id, p_project_id, p_study_id,
    p_environment, p_lrs_namespace, selected_condition, p_fact_retention_due_at
  );

  insert into aais_research_identity.aais_research_participation_ledger (
    participant_id, study_run_id, visit_id, project_id, study_id, environment,
    lrs_namespace, admission_fingerprint, identity_key_version, identity_iv,
    retention_due_at
  ) values (
    p_participant_id, p_study_run_id, p_visit_id, p_project_id, p_study_id,
    p_environment, p_lrs_namespace, p_admission_fingerprint, p_key_version, p_iv,
    p_fact_retention_due_at
  );

  return query select
    p_participant_id, p_study_run_id, p_visit_id, selected_condition, 'active'::text, true;
end;
$function$;

create or replace function aais_research_acquire_raw_write_lease(
  p_project_id text,
  p_study_id text,
  p_environment text,
  p_lrs_namespace text,
  p_admission_fingerprint text,
  p_lease_id uuid,
  p_acquired_at timestamptz,
  p_expires_at timestamptz
)
returns table (
  lease_id uuid,
  visit_id uuid,
  expires_at timestamptz
)
language plpgsql
as $function$
declare
  visit_record record;
begin
  if p_expires_at <= p_acquired_at
    or p_expires_at > p_acquired_at + interval '5 minutes'
  then
    raise exception 'research raw-text write lease duration is invalid';
  end if;

  select v.visit_id, v.participant_id, v.status, a.status as admission_status
  into visit_record
  from aais_research_identity.aais_research_participation_ledger a
  join aais_research_visits v
    on v.participant_id = a.participant_id
    and v.visit_id = a.visit_id
    and v.study_run_id = a.study_run_id
    and v.project_id = a.project_id
    and v.study_id = a.study_id
    and v.environment = a.environment
    and v.lrs_namespace = a.lrs_namespace
  where a.project_id = p_project_id
    and a.study_id = p_study_id
    and a.environment = p_environment
    and a.lrs_namespace = p_lrs_namespace
    and a.admission_fingerprint = p_admission_fingerprint
  for update of v;

  if not found then
    raise exception 'research visit not found';
  end if;
  if visit_record.status <> 'active' or visit_record.admission_status <> 'admitted' then
    raise exception 'research visit is not active';
  end if;

  insert into aais_research_raw_write_leases (
    lease_id, participant_id, visit_id, project_id, study_id, environment,
    lrs_namespace, created_at, expires_at
  ) values (
    p_lease_id, visit_record.participant_id, visit_record.visit_id,
    p_project_id, p_study_id, p_environment, p_lrs_namespace,
    p_acquired_at, p_expires_at
  );

  return query select p_lease_id, visit_record.visit_id, p_expires_at;
end;
$function$;

create or replace function aais_research_record_event(
  p_project_id text,
  p_study_id text,
  p_environment text,
  p_lrs_namespace text,
  p_lrs_store_id text,
  p_visit_id uuid,
  p_event_id uuid,
  p_client_event_id uuid,
  p_schema_version integer,
  p_app_version text,
  p_commit_sha text,
  p_client_time timestamptz,
  p_server_received_at timestamptz,
  p_event_name text,
  p_outcome text,
  p_ai_latency_ms integer,
  p_detail jsonb,
  p_retention_due_at timestamptz
)
returns table (
  recorded_event_id uuid,
  recorded_event_sequence bigint,
  recorded_lrs_eligible boolean,
  created boolean
)
language plpgsql
as $function$
declare
  visit_record record;
  existing_record record;
  assigned_sequence bigint;
  derived_lrs_eligible boolean;
  derived_retry_count integer;
  derived_disconnect_count integer;
begin
  if p_lrs_store_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' then
    raise exception 'invalid research LRS store id';
  end if;
  if p_event_name <> 'ai_guide_submit' and p_ai_latency_ms is not null then
    raise exception 'research AI latency is valid only for AI guide events';
  end if;

  select v.participant_id, v.study_run_id, v.condition, v.status, v.next_event_sequence
  into visit_record
  from aais_research_visits v
  where v.project_id = p_project_id
    and v.study_id = p_study_id
    and v.environment = p_environment
    and v.lrs_namespace = p_lrs_namespace
    and v.visit_id = p_visit_id
  for update;

  if not found then
    raise exception 'research visit not found';
  end if;

  select e.event_id, e.event_sequence, e.lrs_eligible, e.client_time,
    e.event_name, e.outcome, e.ai_latency_ms, e.detail
  into existing_record
  from aais_research_events e
  where e.project_id = p_project_id
    and e.study_id = p_study_id
    and e.environment = p_environment
    and e.lrs_namespace = p_lrs_namespace
    and e.visit_id = p_visit_id
    and e.client_event_id = p_client_event_id;

  if found then
    if existing_record.client_time <> p_client_time
      or existing_record.event_name <> p_event_name
      or existing_record.outcome <> p_outcome
      or existing_record.ai_latency_ms is distinct from p_ai_latency_ms
      or existing_record.detail <> p_detail then
      raise exception 'research event idempotency conflict';
    end if;
    return query select
      existing_record.event_id,
      existing_record.event_sequence,
      existing_record.lrs_eligible,
      false;
    return;
  end if;

  if visit_record.status <> 'active' then
    raise exception 'research visit is not active';
  end if;

  assigned_sequence := visit_record.next_event_sequence;
  derived_lrs_eligible := true;
  derived_retry_count := greatest(
    case
      when coalesce(p_detail->>'attempt_number', '') ~ '^[1-9][0-9]*$'
        then (p_detail->>'attempt_number')::integer - 1
      else 0
    end,
    case when p_outcome = 'retry' then 1 else 0 end
  );
  derived_disconnect_count := case
    when p_outcome = 'disconnected'
      or p_detail->>'error_kind' in ('offline', 'network', 'stream_disconnected')
    then 1
    else 0
  end;

  insert into aais_research_events (
    event_id, client_event_id, participant_id, study_run_id, visit_id,
    project_id, study_id, environment, lrs_namespace, condition, schema_version,
    app_version, commit_sha, event_sequence, client_time, server_received_at,
    event_name, outcome, retry_count, disconnect_count, ai_latency_ms, detail,
    lrs_eligible, retention_due_at
  ) values (
    p_event_id, p_client_event_id, visit_record.participant_id, visit_record.study_run_id,
    p_visit_id, p_project_id, p_study_id, p_environment, p_lrs_namespace,
    visit_record.condition, p_schema_version, p_app_version, p_commit_sha,
    assigned_sequence, p_client_time, p_server_received_at, p_event_name, p_outcome,
    derived_retry_count, derived_disconnect_count, p_ai_latency_ms, p_detail,
    derived_lrs_eligible, p_retention_due_at
  );

  update aais_research_visits v
  set next_event_sequence = assigned_sequence + 1
  where v.project_id = p_project_id
    and v.study_id = p_study_id
    and v.environment = p_environment
    and v.lrs_namespace = p_lrs_namespace
    and v.visit_id = p_visit_id;

  insert into aais_research_lrs_outbox (
    outbox_id, event_id, statement_id, project_id, study_id, environment,
    lrs_namespace, payload, lrs_eligible, status, retention_due_at
  ) values (
    gen_random_uuid(), p_event_id, p_event_id, p_project_id, p_study_id,
    p_environment, p_lrs_namespace,
    jsonb_build_object(
      'eventId', p_event_id,
      'participantId', visit_record.participant_id,
      'studyRunId', visit_record.study_run_id,
      'visitId', p_visit_id,
      'projectId', p_project_id,
      'studyId', p_study_id,
      'environment', p_environment,
      'lrsNamespace', p_lrs_namespace,
      'lrsStoreId', p_lrs_store_id,
      'condition', visit_record.condition,
      'schemaVersion', p_schema_version,
      'appVersion', p_app_version,
      'commitSha', p_commit_sha,
      'eventSequence', assigned_sequence,
      'clientTime', p_client_time,
      'serverReceivedAt', p_server_received_at,
      'eventName', p_event_name,
      'outcome', p_outcome,
      'retryCount', derived_retry_count,
      'disconnectCount', derived_disconnect_count,
      'aiLatencyMs', p_ai_latency_ms,
      'detail', p_detail,
      'lrsEligible', derived_lrs_eligible
    ),
    derived_lrs_eligible,
    case when derived_lrs_eligible then 'pending' else 'cancelled' end,
    p_retention_due_at
  );

  return query select p_event_id, assigned_sequence, derived_lrs_eligible, true;
end;
$function$;

create or replace function aais_research_complete_visit(
  p_project_id text,
  p_study_id text,
  p_environment text,
  p_lrs_namespace text,
  p_study_run_id uuid,
  p_completed_at timestamptz,
  p_raw_text_retention_due_at timestamptz
)
returns table (
  visit_id uuid,
  participant_id uuid,
  study_run_id uuid,
  status text,
  ended_at timestamptz,
  raw_text_retention_due_at timestamptz,
  completed boolean
)
language plpgsql
as $function$
declare
  visit_record record;
begin
  if p_raw_text_retention_due_at <= p_completed_at then
    raise exception 'research raw-text retention deadline is invalid';
  end if;

  perform pg_advisory_xact_lock(hashtext(
    p_project_id || ':' || p_study_id || ':' || p_environment || ':' || p_lrs_namespace
  ));

  select v.visit_id, v.participant_id, v.study_run_id, v.status, v.ended_at,
    v.raw_text_retention_due_at
  into visit_record
  from aais_research_visits v
  where v.project_id = p_project_id
    and v.study_id = p_study_id
    and v.environment = p_environment
    and v.lrs_namespace = p_lrs_namespace
    and v.study_run_id = p_study_run_id
  for update;

  if not found then
    raise exception 'research study run not found';
  end if;
  if visit_record.status = 'withdrawn' then
    raise exception 'research participant withdrawn';
  end if;
  if visit_record.status = 'withdrawing' then
    raise exception 'research participant withdrawal in progress';
  end if;
  if visit_record.status = 'completed' then
    return query select visit_record.visit_id, visit_record.participant_id,
      visit_record.study_run_id, visit_record.status, visit_record.ended_at,
      visit_record.raw_text_retention_due_at, false;
    return;
  end if;

  update aais_research_visits v
  set status = 'completed', ended_at = p_completed_at,
    raw_text_retention_due_at = p_raw_text_retention_due_at
  where v.visit_id = visit_record.visit_id;

  return query select visit_record.visit_id, visit_record.participant_id,
    visit_record.study_run_id, 'completed'::text, p_completed_at,
    p_raw_text_retention_due_at, true;
end;
$function$;

create or replace function aais_research_begin_withdrawal(
  p_project_id text,
  p_study_id text,
  p_environment text,
  p_lrs_namespace text,
  p_study_run_id uuid,
  p_requested_at timestamptz
)
returns table (
  visit_id uuid,
  participant_id uuid,
  status text,
  active_raw_write_lease_count integer
)
language plpgsql
as $function$
declare
  visit_record record;
  live_lease_count integer;
  next_status text;
begin
  perform pg_advisory_xact_lock(hashtext(
    p_project_id || ':' || p_study_id || ':' || p_environment || ':' || p_lrs_namespace
  ));

  select v.visit_id, v.participant_id, v.status
  into visit_record
  from aais_research_visits v
  where v.project_id = p_project_id
    and v.study_id = p_study_id
    and v.environment = p_environment
    and v.lrs_namespace = p_lrs_namespace
    and v.study_run_id = p_study_run_id
  for update;

  if not found then
    raise exception 'research study run not found';
  end if;

  if visit_record.status = 'withdrawn' then
    next_status := 'withdrawn';
  elsif visit_record.status in ('active', 'completed', 'withdrawing') then
    next_status := 'withdrawing';
    update aais_research_visits v
    set status = 'withdrawing'
    where v.project_id = p_project_id
      and v.study_id = p_study_id
      and v.environment = p_environment
      and v.lrs_namespace = p_lrs_namespace
      and v.visit_id = visit_record.visit_id
      and v.status <> 'withdrawn';
  else
    raise exception 'research visit status is invalid';
  end if;

  select count(*)::integer into live_lease_count
  from aais_research_raw_write_leases l
  where l.project_id = p_project_id
    and l.study_id = p_study_id
    and l.environment = p_environment
    and l.lrs_namespace = p_lrs_namespace
    and l.visit_id = visit_record.visit_id;

  return query select visit_record.visit_id, visit_record.participant_id,
    next_status, live_lease_count;
end;
$function$;

create or replace function aais_research_withdraw(
  p_project_id text,
  p_study_id text,
  p_environment text,
  p_lrs_namespace text,
  p_study_run_id uuid,
  p_withdrawal_id uuid,
  p_requested_by_fingerprint text,
  p_restricted_raw_text_deleted boolean,
  p_raw_text_storage text,
  p_requested_at timestamptz
)
returns table (
  withdrawal_id uuid,
  participant_id uuid,
  visit_id uuid,
  local_event_count integer,
  deletion_request_count integer,
  identity_deleted boolean,
  restricted_raw_text_deleted boolean,
  created boolean
)
language plpgsql
as $function$
declare
  visit_record record;
  existing_record record;
  event_count integer;
  deletion_count integer;
  did_delete_identity boolean;
  coordination_now timestamptz;
  deletion_barrier_at timestamptz;
begin
  if p_restricted_raw_text_deleted is not true
    or p_raw_text_storage not in ('postgres', 'file')
  then
    raise exception 'restricted raw text deletion evidence is required';
  end if;

  perform pg_advisory_xact_lock(hashtext(
    p_project_id || ':' || p_study_id || ':' || p_environment || ':' || p_lrs_namespace
  ));

  select w.withdrawal_id, w.participant_id, w.visit_id, w.local_event_count,
    w.deletion_request_count, w.identity_deleted, w.restricted_raw_text_deleted
  into existing_record
  from aais_research_withdrawals w
  where w.project_id = p_project_id
    and w.study_id = p_study_id
    and w.environment = p_environment
    and w.lrs_namespace = p_lrs_namespace
    and w.study_run_id = p_study_run_id;

  if found then
    return query select existing_record.withdrawal_id, existing_record.participant_id,
      existing_record.visit_id, existing_record.local_event_count,
      existing_record.deletion_request_count, existing_record.identity_deleted,
      existing_record.restricted_raw_text_deleted, false;
    return;
  end if;

  select v.visit_id, v.participant_id, v.study_run_id, v.status,
    a.admission_fingerprint
  into visit_record
  from aais_research_visits v
  join aais_research_identity.aais_research_participation_ledger a
    on a.participant_id = v.participant_id
    and a.visit_id = v.visit_id
    and a.study_run_id = v.study_run_id
    and a.project_id = v.project_id
    and a.study_id = v.study_id
    and a.environment = v.environment
    and a.lrs_namespace = v.lrs_namespace
  where v.project_id = p_project_id
    and v.study_id = p_study_id
    and v.environment = p_environment
    and v.lrs_namespace = p_lrs_namespace
    and v.study_run_id = p_study_run_id
  for update;

  if not found then
    raise exception 'research study run not found';
  end if;
  if visit_record.status <> 'withdrawing' then
    raise exception 'research withdrawal write barrier is not closed';
  end if;

  if exists (
    select 1 from aais_research_raw_write_leases l
    where l.project_id = p_project_id
      and l.study_id = p_study_id
      and l.environment = p_environment
      and l.lrs_namespace = p_lrs_namespace
      and l.visit_id = visit_record.visit_id
  ) then
    raise exception 'research withdrawal has active raw-text write lease';
  end if;

  select count(*)::integer into event_count
  from aais_research_events e
  where e.project_id = p_project_id
    and e.study_id = p_study_id
    and e.environment = p_environment
    and e.lrs_namespace = p_lrs_namespace
    and e.visit_id = visit_record.visit_id;

  -- Serialize withdrawal against the worker's SKIP LOCKED claim. If a sender
  -- already claimed a row, this waits for that short claim transaction and
  -- captures its lease below. If withdrawal owns the row first, a concurrent
  -- sender skips it and cannot start a new PUT.
  perform o.outbox_id
  from aais_research_lrs_outbox o
  where o.project_id = p_project_id
    and o.study_id = p_study_id
    and o.environment = p_environment
    and o.lrs_namespace = p_lrs_namespace
    and exists (
      select 1 from aais_research_events e
      where e.event_id = o.event_id and e.visit_id = visit_record.visit_id
    )
  for update;

  coordination_now := clock_timestamp();
  select greatest(
    coordination_now,
    coalesce(max(o.lease_expires_at) filter (where o.status = 'sending'), coordination_now)
  ) + interval '5 seconds'
  into deletion_barrier_at
  from aais_research_lrs_outbox o
  where o.project_id = p_project_id
    and o.study_id = p_study_id
    and o.environment = p_environment
    and o.lrs_namespace = p_lrs_namespace
    and exists (
      select 1 from aais_research_events e
      where e.event_id = o.event_id and e.visit_id = visit_record.visit_id
    );

  insert into aais_research_withdrawals (
    withdrawal_id, participant_id, visit_id, study_run_id, project_id, study_id,
    environment, lrs_namespace, admission_fingerprint, requested_by_fingerprint,
    local_event_count, deletion_request_count, identity_deleted,
    restricted_raw_text_deleted, raw_text_storage, created_at
  ) values (
    p_withdrawal_id, visit_record.participant_id, visit_record.visit_id,
    visit_record.study_run_id, p_project_id, p_study_id, p_environment,
    p_lrs_namespace, visit_record.admission_fingerprint, p_requested_by_fingerprint,
    event_count, 0, false, p_restricted_raw_text_deleted, p_raw_text_storage,
    p_requested_at
  );

  insert into aais_research_lrs_deletions (
    deletion_id, withdrawal_id, reason, event_id, statement_id, project_id,
    study_id, environment, lrs_namespace, lrs_store_id, created_at, not_before,
    updated_at, retention_due_at
  )
  select gen_random_uuid(), p_withdrawal_id, 'withdrawal', o.event_id, o.statement_id,
    p_project_id, p_study_id, p_environment, p_lrs_namespace,
    o.payload->>'lrsStoreId',
    p_requested_at, deletion_barrier_at, coordination_now,
    greatest(o.retention_due_at, coordination_now + interval '35 days')
  from aais_research_lrs_outbox o
  where o.project_id = p_project_id
    and o.study_id = p_study_id
    and o.environment = p_environment
    and o.lrs_namespace = p_lrs_namespace
    and exists (
      select 1 from aais_research_events e
      where e.event_id = o.event_id and e.visit_id = visit_record.visit_id
    )
  on conflict (project_id, study_id, environment, lrs_namespace, statement_id)
  do update set
    withdrawal_id = excluded.withdrawal_id,
    reason = 'withdrawal',
    lrs_store_id = excluded.lrs_store_id,
    status = 'pending',
    attempts = 0,
    deletion_claim_id = null,
    lease_expires_at = null,
    last_http_status = null,
    receipt_sha256 = null,
    provider_absence_confirmed_at = null,
    provider_receipt_key_id = null,
    provider_receipt_signature = null,
    last_error = null,
    not_before = greatest(aais_research_lrs_deletions.not_before, excluded.not_before),
    retention_due_at = greatest(
      aais_research_lrs_deletions.retention_due_at,
      excluded.retention_due_at
    ),
    updated_at = excluded.updated_at,
    confirmed_at = null;

  get diagnostics deletion_count = row_count;

  update aais_research_lrs_outbox o
  set status = 'cancelled', delivery_claim_id = null, lease_expires_at = null,
    updated_at = coordination_now
  where o.project_id = p_project_id
    and o.study_id = p_study_id
    and o.environment = p_environment
    and o.lrs_namespace = p_lrs_namespace
    and o.status in ('pending', 'retry', 'sending', 'dead_letter')
    and exists (
      select 1 from aais_research_events e
      where e.event_id = o.event_id and e.visit_id = visit_record.visit_id
    );

  delete from aais_research_events e
  where e.project_id = p_project_id
    and e.study_id = p_study_id
    and e.environment = p_environment
    and e.lrs_namespace = p_lrs_namespace
    and e.visit_id = visit_record.visit_id;

  delete from aais_research_identity.aais_research_identity_map i
  where i.project_id = p_project_id
    and i.study_id = p_study_id
    and i.environment = p_environment
    and i.lrs_namespace = p_lrs_namespace
    and i.participant_id = visit_record.participant_id;
  select not exists (
    select 1
    from aais_research_identity.aais_research_identity_map i
    where i.project_id = p_project_id
      and i.study_id = p_study_id
      and i.environment = p_environment
      and i.lrs_namespace = p_lrs_namespace
      and i.participant_id = visit_record.participant_id
  ) into did_delete_identity;

  update aais_research_visits v
  set status = 'withdrawn', withdrawn_at = p_requested_at,
    ended_at = coalesce(ended_at, p_requested_at),
    raw_text_deleted_at = coalesce(raw_text_deleted_at, p_requested_at),
    raw_text_storage = coalesce(raw_text_storage, p_raw_text_storage)
  where v.project_id = p_project_id
    and v.study_id = p_study_id
    and v.environment = p_environment
    and v.lrs_namespace = p_lrs_namespace
    and v.visit_id = visit_record.visit_id;

  update aais_research_identity.aais_research_participation_ledger a
  set status = 'withdrawn', withdrawn_at = p_requested_at
  where a.project_id = p_project_id
    and a.study_id = p_study_id
    and a.environment = p_environment
    and a.lrs_namespace = p_lrs_namespace
    and a.visit_id = visit_record.visit_id;

  update aais_research_participants p
  set status = 'withdrawn', withdrawn_at = p_requested_at
  where p.project_id = p_project_id
    and p.study_id = p_study_id
    and p.environment = p_environment
    and p.lrs_namespace = p_lrs_namespace
    and p.participant_id = visit_record.participant_id;

  update aais_research_withdrawals w
  set deletion_request_count = deletion_count, identity_deleted = did_delete_identity
  where w.withdrawal_id = p_withdrawal_id;

  return query select p_withdrawal_id, visit_record.participant_id,
    visit_record.visit_id, event_count, deletion_count, did_delete_identity,
    p_restricted_raw_text_deleted, true;
end;
$function$;
