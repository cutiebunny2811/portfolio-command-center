-- Allocation targets are guidance, not a hard trading limit.
-- Cash and position checks remain enforced; buys above target return a warning.

do $migration$
declare
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef(p.oid)
  into v_definition
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'api_create_trade_draft';

  if v_definition is null then
    raise exception 'api_create_trade_draft was not found';
  end if;

  v_updated := regexp_replace(
    v_definition,
    $pattern$if\s+p_side\s*=\s*'buy'\s+and\s+v_limit_pct\s+is\s+not\s+null\s+and\s+v_deployed_after\s*>\s*v_budget\s*\*\s*v_limit_pct\s*/\s*100\s+then\s+raise\s+exception\s+'Trade exceeds allocation maximum';\s+end\s+if;$pattern$,
    '',
    'i'
  );

  if v_updated = v_definition then
    raise exception 'Expected allocation guard was not found in api_create_trade_draft';
  end if;

  v_definition := v_updated;
  v_updated := regexp_replace(
    v_definition,
    $pattern$'warning'\s*,\s*case\s+when\s+v_limit_pct\s+is\s+null\s+then\s+'NO_ALLOCATION_TARGET'\s+else\s+null\s+end$pattern$,
    $replacement$'warning', case
      when v_limit_pct is null then 'NO_ALLOCATION_TARGET'
      when p_side = 'buy'
        and v_deployed_after > v_budget * v_limit_pct / 100
        then 'OVER_ALLOCATION_TARGET'
      else null
    end$replacement$,
    'i'
  );

  if v_updated = v_definition then
    raise exception 'Expected warning expression was not found in api_create_trade_draft';
  end if;

  execute v_updated;

  select pg_get_functiondef(p.oid)
  into v_definition
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'api_confirm_trade_draft';

  if v_definition is null then
    raise exception 'api_confirm_trade_draft was not found';
  end if;

  v_updated := regexp_replace(
    v_definition,
    $pattern$if\s+v_side\s*=\s*'buy'\s+and\s+v_limit_pct\s+is\s+not\s+null\s+and\s+v_deployed_after\s*>\s*v_budget\s*\*\s*v_limit_pct\s*/\s*100\s+then\s+raise\s+exception\s+'Trade exceeds allocation maximum';\s+end\s+if;$pattern$,
    '',
    'i'
  );

  if v_updated = v_definition then
    raise exception 'Expected allocation guard was not found in api_confirm_trade_draft';
  end if;

  execute v_updated;
end
$migration$;

-- Verification: both values must be true.
select
  position('Trade exceeds allocation maximum' in pg_get_functiondef(p.oid)) = 0 as hard_limit_removed,
  case
    when p.proname = 'api_create_trade_draft'
      then position('OVER_ALLOCATION_TARGET' in pg_get_functiondef(p.oid)) > 0
    else true
  end as warning_enabled,
  p.proname as function_name
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('api_create_trade_draft', 'api_confirm_trade_draft')
order by p.proname;
