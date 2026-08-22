-- Operator reconciliation is the only way to resolve an authentication email
-- whose provider result remains uncertain after its retry window.  Uncertain
-- fences are never released by elapsed time: an administrator must supply a
-- bounded Resend message/status observation through the audited reconciliation
-- route.  A confirmed not-sent result consumes the old token before reissue is
-- allowed; a confirmed sent result keeps the delivered token issuance fenced
-- until it is consumed or safely superseded after expiry.

alter table public.aais_auth_email_outbox
  add column if not exists reconciliation_disposition text;

alter table public.aais_auth_email_outbox
  add column if not exists reconciliation_provider text;

alter table public.aais_auth_email_outbox
  add column if not exists reconciliation_message_id text;

alter table public.aais_auth_email_outbox
  add column if not exists reconciliation_observed_status text;

alter table public.aais_auth_email_outbox
  add column if not exists reconciliation_observed_at timestamptz;

alter table public.aais_auth_email_outbox
  add column if not exists reconciled_at timestamptz;

alter table public.aais_auth_email_outbox
  add column if not exists reconciled_by text;

alter table public.aais_auth_email_outbox
  drop constraint if exists aais_auth_email_outbox_reconciliation_check;

alter table public.aais_auth_email_outbox
  add constraint aais_auth_email_outbox_reconciliation_check check (
    (
      reconciliation_disposition is null
      and reconciliation_provider is null
      and reconciliation_message_id is null
      and reconciliation_observed_status is null
      and reconciliation_observed_at is null
      and reconciled_at is null
      and reconciled_by is null
    )
    or (
      reconciliation_disposition is not null
      and reconciliation_provider is not null
      and reconciliation_message_id is not null
      and reconciliation_observed_status is not null
      and reconciliation_observed_at is not null
      and reconciled_at is not null
      and reconciled_by is not null
      and reconciliation_disposition in ('sent', 'not_sent')
      and reconciliation_provider = 'resend'
      and reconciliation_message_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
      and reconciled_at >= reconciliation_observed_at
      and reconciled_by ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      and (
        (
          reconciliation_disposition = 'sent'
          and reconciliation_observed_status in ('sent', 'delivered')
          and status = 'sent'
        )
        or (
          reconciliation_disposition = 'not_sent'
          and reconciliation_observed_status in ('failed', 'bounced', 'canceled', 'suppressed')
          and status = 'dead'
        )
      )
    )
  );

create unique index if not exists aais_auth_email_outbox_reconciliation_evidence_key
  on public.aais_auth_email_outbox (
    reconciliation_provider,
    reconciliation_message_id
  )
  where reconciliation_message_id is not null;

alter table public.aais_user_auth_tokens
  drop constraint if exists aais_user_auth_tokens_email_delivery_state_check;

alter table public.aais_user_auth_tokens
  add constraint aais_user_auth_tokens_email_delivery_state_check check (
    (
      email_delivery_state = 'idle'
      and email_delivery_outbox_id is null
      and email_delivery_claim_id is null
      and email_delivery_started_at is null
    )
    or (
      email_delivery_state = 'in_flight'
      and email_delivery_outbox_id is not null
      and email_delivery_claim_id is not null
      and email_delivery_started_at is not null
    )
    or (
      email_delivery_state in ('uncertain', 'delivered')
      and email_delivery_outbox_id is not null
      and email_delivery_claim_id is null
      and email_delivery_started_at is not null
    )
  );

create or replace function public.aais_guard_auth_token_email_reissue()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if old.email_delivery_state = 'in_flight'
    or old.email_delivery_state = 'uncertain'
    or (
      old.email_delivery_state = 'delivered'
      and old.consumed_at is null
      and old.expires_at > new.created_at
    )
  then
    raise exception using
      errcode = 'P0001',
      message = 'AAIS_AUTH_EMAIL_DELIVERY_FENCED';
  end if;
  return new;
end
$$;
