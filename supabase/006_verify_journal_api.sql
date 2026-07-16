-- Read-only verification for 005_journal_api.sql.

select
  p.proname as function_name,
  pg_get_function_arguments(p.oid) as arguments,
  p.prosecdef as security_definer,
  pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute,
  pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'api_create_journal_entry',
    'api_update_journal_entry',
    'api_void_journal_entry',
    'api_record_instrument_price'
  )
order by p.proname;

select
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'journal_entries'
  and column_name in ('is_void', 'void_reason', 'voided_at')
order by ordinal_position;


