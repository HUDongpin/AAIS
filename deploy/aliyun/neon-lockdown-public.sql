\set ON_ERROR_STOP on

-- Run only after both providers have switched to and verified their dedicated
-- runtime roles. Keeping this separate prevents the role-grant step from
-- disconnecting the still-live legacy Vercel integration identity.
revoke connect, temporary on database :"DBNAME" from public;
revoke create on schema public from public;
revoke execute on all functions in schema public from public;

select not exists (
         select 1
           from pg_database database_row
           cross join lateral aclexplode(
             coalesce(database_row.datacl, acldefault('d', database_row.datdba))
           ) privilege
          where database_row.datname = current_database()
            and privilege.grantee = 0
            and privilege.privilege_type in ('CONNECT', 'TEMPORARY')
       ) as public_database_access_revoked,
       not exists (
         select 1
           from pg_namespace schema_row
           cross join lateral aclexplode(
             coalesce(schema_row.nspacl, acldefault('n', schema_row.nspowner))
           ) privilege
          where schema_row.nspname = 'public'
            and privilege.grantee = 0
            and privilege.privilege_type = 'CREATE'
       ) as public_schema_create_revoked,
       not exists (
         select 1
           from pg_proc function_row
           join pg_namespace function_schema on function_schema.oid = function_row.pronamespace
           cross join lateral aclexplode(
             coalesce(function_row.proacl, acldefault('f', function_row.proowner))
           ) privilege
          where function_schema.nspname = 'public'
            and privilege.grantee = 0
            and privilege.privilege_type = 'EXECUTE'
       ) as public_function_execute_revoked;
