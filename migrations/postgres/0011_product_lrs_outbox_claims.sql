alter table aais_lrs_outbox
  add column if not exists delivery_claim_id uuid;

alter table aais_lrs_outbox
  add column if not exists lease_expires_at timestamptz;

alter table aais_lrs_outbox
  add column if not exists pending_payload jsonb;

alter table aais_lrs_outbox
  drop constraint if exists aais_lrs_outbox_delivery_claim_check;

alter table aais_lrs_outbox
  add constraint aais_lrs_outbox_delivery_claim_check
  check (
    (
      status = 'sending'
      and delivery_claim_id is not null
      and lease_expires_at is not null
    )
    or (
      status <> 'sending'
      and delivery_claim_id is null
      and lease_expires_at is null
    )
  );

alter table aais_lrs_outbox
  drop constraint if exists aais_lrs_outbox_pending_payload_check;

alter table aais_lrs_outbox
  add constraint aais_lrs_outbox_pending_payload_check
  check (
    pending_payload is null
    or status in ('sending', 'retry', 'dead_letter')
  );

create index if not exists aais_lrs_outbox_delivery_idx
  on aais_lrs_outbox (status, lease_expires_at, created_at, id);
