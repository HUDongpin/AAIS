-- Authentication email issuance is committed atomically with its user/token
-- mutation.  Only an authenticated worker may decrypt and deliver the payload.
-- The token hash is intentionally duplicated as an immutable issuance fence:
-- token ids are stable slots and are updated when a link is reissued.
alter table public.aais_user_auth_tokens
  add column if not exists email_delivery_state text not null default 'idle';

alter table public.aais_user_auth_tokens
  add column if not exists email_delivery_outbox_id uuid;

alter table public.aais_user_auth_tokens
  add column if not exists email_delivery_claim_id uuid;

alter table public.aais_user_auth_tokens
  add column if not exists email_delivery_started_at timestamptz;

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
      email_delivery_state = 'uncertain'
      and email_delivery_outbox_id is not null
      and email_delivery_claim_id is null
      and email_delivery_started_at is not null
    )
  );

create table if not exists public.aais_auth_email_outbox (
  id uuid primary key,
  purpose text not null check (purpose in ('invite', 'password_reset')),
  auth_token_id text not null references public.aais_user_auth_tokens(id) on delete cascade,
  auth_token_hash text not null check (auth_token_hash ~ '^[a-f0-9]{64}$'),
  recipient text not null check (
    char_length(recipient) between 3 and 254
    and recipient !~ E'[\\r\\n]'
  ),
  payload_envelope jsonb not null check (
    jsonb_typeof(payload_envelope) = 'object'
    and payload_envelope ?& array['version', 'nonce', 'tag', 'ciphertext']
    and (payload_envelope - 'version' - 'nonce' - 'tag' - 'ciphertext') = '{}'::jsonb
    and jsonb_typeof(payload_envelope->'version') = 'number'
    and payload_envelope->>'version' = '1'
    and jsonb_typeof(payload_envelope->'nonce') = 'string'
    and jsonb_typeof(payload_envelope->'tag') = 'string'
    and jsonb_typeof(payload_envelope->'ciphertext') = 'string'
    and payload_envelope->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
    and payload_envelope->>'tag' ~ '^[A-Za-z0-9_-]{22}$'
    and payload_envelope->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
    and char_length(payload_envelope->>'ciphertext') <= 98304
    and not (payload_envelope ?| array['token', 'url', 'text', 'body', 'subject', 'from', 'to'])
  ),
  idempotency_key text not null unique
    check (idempotency_key = 'aais_auth_email_' || id::text),
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'retry', 'sent', 'dead')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  claim_id uuid,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  first_attempt_at timestamptz,
  uncertain_since timestamptz,
  sent_at timestamptz,
  dead_lettered_at timestamptz,
  last_error_code text check (
    last_error_code is null
    or last_error_code ~ '^[a-z0-9_]{1,64}$'
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint aais_auth_email_outbox_claim_state_check check (
    (
      status = 'sending'
      and claim_id is not null
      and claimed_at is not null
      and lease_expires_at is not null
      and lease_expires_at > claimed_at
    )
    or (
      status <> 'sending'
      and claim_id is null
      and claimed_at is null
      and lease_expires_at is null
    )
  ),
  constraint aais_auth_email_outbox_terminal_state_check check (
    (status = 'sent') = (sent_at is not null)
    and (status = 'dead') = (dead_lettered_at is not null)
  )
);

create index if not exists aais_auth_email_outbox_due_idx
  on public.aais_auth_email_outbox (next_attempt_at, created_at, id)
  where status in ('pending', 'retry');

create index if not exists aais_auth_email_outbox_lease_idx
  on public.aais_auth_email_outbox (lease_expires_at, id)
  where status = 'sending';

create index if not exists aais_auth_email_outbox_token_fence_idx
  on public.aais_auth_email_outbox (auth_token_id, auth_token_hash)
  where status in ('pending', 'retry', 'sending');

create or replace function public.aais_guard_auth_token_email_reissue()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if old.email_delivery_state <> 'idle' then
    raise exception using
      errcode = 'P0001',
      message = 'AAIS_AUTH_EMAIL_DELIVERY_FENCED';
  end if;
  return new;
end
$$;

drop trigger if exists aais_user_auth_tokens_email_reissue_guard
  on public.aais_user_auth_tokens;

create trigger aais_user_auth_tokens_email_reissue_guard
before update of user_id, purpose, token_hash, created_by, expires_at, created_at
on public.aais_user_auth_tokens
for each row
when (
  old.user_id is distinct from new.user_id
  or old.purpose is distinct from new.purpose
  or old.token_hash is distinct from new.token_hash
  or old.created_by is distinct from new.created_by
  or old.expires_at is distinct from new.expires_at
  or old.created_at is distinct from new.created_at
)
execute function public.aais_guard_auth_token_email_reissue();
