-- Agent-created drafts must follow the same mixed-asset portfolio rules as
-- drafts created in PCC. Portfolios may contain stocks, ETFs and options.

begin;

do $migration$
declare
  v_function record;
  v_definition text;
  v_updated text;
begin
  for v_function in
    select p.oid, p.proname
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'api_create_trade_draft',
        'api_set_opening_position',
        'api_agent_create_trade_draft'
      )
  loop
    v_definition := pg_get_functiondef(v_function.oid);
    if position('Instrument type does not match portfolio' in v_definition) = 0 then
      continue;
    end if;

    v_updated := regexp_replace(
      v_definition,
      $pattern$if\s+\([^;]+\)\s+then\s+raise\s+exception\s+'Instrument type does not match portfolio';\s+end\s+if;$pattern$,
      '',
      'gi'
    );

    if v_updated = v_definition then
      raise exception 'Expected legacy asset guard was not removed from %', v_function.proname;
    end if;
    execute v_updated;
  end loop;
end
$migration$;

do $verification$
declare
  v_agent_function_count integer;
  v_remaining integer;
begin
  select count(*)
    into v_agent_function_count
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'api_agent_create_trade_draft';

  if v_agent_function_count = 0 then
    raise exception 'api_agent_create_trade_draft was not found';
  end if;

  select count(*)
    into v_remaining
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'api_create_trade_draft',
      'api_set_opening_position',
      'api_agent_create_trade_draft'
    )
    and position('Instrument type does not match portfolio' in pg_get_functiondef(p.oid)) > 0;

  if v_remaining <> 0 then
    raise exception 'Legacy portfolio asset guard remains in % function(s)', v_remaining;
  end if;
end
$verification$;

commit;
