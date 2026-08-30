\set ON_ERROR_STOP on

select current_setting('server_version') as server_version,
       current_setting('server_encoding') as server_encoding,
       current_setting('lc_collate') as lc_collate,
       current_setting('lc_ctype') as lc_ctype;

select extname, extversion
  from pg_extension
 order by extname;

select pg_database_size(current_database()) as database_bytes;

select version, checksum
  from public.aais_schema_migrations
 order by version;
