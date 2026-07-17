-- Read-only checks for 007_journal_scaling.sql.

select
  p.proname as function_name,
  pg_catalog.pg_get_function_identity_arguments(p.oid) as arguments,
  p.prosecdef as security_definer,
  pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute,
  pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'api_get_journal_view';

select indexname, indexdef
from pg_catalog.pg_indexes
where schemaname = 'public'
  and indexname in (
    'journal_entries_active_portfolio_date_v2_idx',
    'journal_entries_active_outcome_date_idx'
  )
order by indexname;
