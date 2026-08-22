alter table aais_lrs_outbox
  add column if not exists xapi_statement jsonb;

alter table aais_lrs_outbox
  drop constraint if exists aais_lrs_outbox_xapi_statement_check;

alter table aais_lrs_outbox
  add constraint aais_lrs_outbox_xapi_statement_check
  check (
    xapi_statement is null
    or (
      jsonb_typeof(xapi_statement) = 'object'
      and coalesce(jsonb_typeof(xapi_statement->'id') = 'string', false)
      and coalesce(
        (xapi_statement->>'id') ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
        false
      )
    )
  );
