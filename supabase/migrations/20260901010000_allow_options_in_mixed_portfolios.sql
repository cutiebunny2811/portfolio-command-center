-- Portfolios are broker accounts and may hold stocks, ETFs and long options
-- together. Remove the pre-mixed-portfolio asset guard from both write paths.

begin;

do $migration$
declare
  v_function_name text;
  v_definition text;
  v_updated text;
begin
  foreach v_function_name in array array[
    'api_create_trade_draft',
    'api_set_opening_position'
  ]
  loop
    select pg_get_functiondef(p.oid)
      into v_definition
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = v_function_name;

    if v_definition is null then
      raise exception '% was not found', v_function_name;
    end if;

    -- Idempotent when a fresh database already contains the corrected body.
    if position('Instrument type does not match portfolio' in v_definition) = 0 then
      continue;
    end if;

    v_updated := regexp_replace(
      v_definition,
      $pattern$if\s+\([^;]+\)\s+then\s+raise\s+exception\s+'Instrument type does not match portfolio';\s+end\s+if;$pattern$,
      '',
      'i'
    );

    if v_updated = v_definition then
      raise exception 'Expected legacy asset guard was not found in %', v_function_name;
    end if;

    execute v_updated;
  end loop;
end
$migration$;

-- Verification: legacy guard removed from both mixed-portfolio write paths.
do $verification$
declare
  v_remaining integer;
begin
  select count(*)
    into v_remaining
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('api_create_trade_draft', 'api_set_opening_position')
    and position('Instrument type does not match portfolio' in pg_get_functiondef(p.oid)) > 0;

  if v_remaining <> 0 then
    raise exception 'Legacy portfolio asset guard remains in % function(s)', v_remaining;
  end if;
end
$verification$;

commit;
