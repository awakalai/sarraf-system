-- LEGACY ENTRY POINT — DO NOT USE FOR INSTALLATION.
--
-- The original project shipped this single SQL file with only a fraction of the production
-- schema and broad browser-write policies. Running it can create an incomplete, insecure
-- database that cannot satisfy the application contract.
--
-- Canonical schema source:
--   supabase/migrations/*.sql
--
-- Fresh local verification:
--   supabase start
--   supabase db reset
--
-- Remote deployment (after backup and staging):
--   supabase migration list
--   supabase db push --dry-run
--   supabase db push
--
-- See GUIDE.md for the existing-production procedure. This explicit failure is intentional:
-- it prevents an operator from following an obsolete screenshot and silently installing the
-- five-table legacy schema.

do $$
begin
  raise exception using
    errcode = '55000',
    message = 'supabase_schema.sql is retired; apply the ordered supabase/migrations directory';
end;
$$;
