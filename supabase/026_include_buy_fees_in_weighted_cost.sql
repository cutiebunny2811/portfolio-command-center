-- Broker-aligned weighted-average cost (Webull convention).
--
-- Buy commissions are part of the acquisition cost:
--   cost_basis = sum(buy quantity * buy price * multiplier + buy fee)
-- A sell removes the same proportional cost basis. Its own fee reduces proceeds.
--
-- Migration 020 kept buy fees in a separate fee_basis ledger. Folding that
-- remaining ledger into cost_basis is mathematically neutral for realized P/L,
-- cash, and quantity, while making average_cost and remaining cost match Webull.

begin;

-- Fold every remaining acquisition fee into the open position once. Clearing
-- fee_basis makes this data conversion idempotent if the script is rerun.
update public.position_balances pb
set cost_basis = pb.cost_basis + pb.fee_basis,
    average_cost = case
      when pb.quantity > 0 then
        (pb.cost_basis + pb.fee_basis) /
        (
          pb.quantity *
          coalesce(
            (
              select e.multiplier
              from public.executions e
              where e.user_id = pb.user_id
                and e.portfolio_id = pb.portfolio_id
                and e.instrument_id = pb.instrument_id
              order by e.executed_at desc, e.created_at desc, e.id desc
              limit 1
            ),
            1
          )
        )
      else 0
    end,
    fee_basis = 0,
    updated_at = now()
where pb.fee_basis <> 0;

-- Patch the two authoritative ledger functions installed by migration 020.
-- Keeping the surrounding audited implementation intact minimizes the surface
-- area of this accounting-rule change.
do $patch$
declare
  v_sql text;
  v_before text;
begin
  select pg_get_functiondef(
    'public.api_confirm_trade_draft(uuid,text)'::regprocedure
  ) into v_sql;
  v_before := v_sql;

  v_sql := replace(
    v_sql,
    'v_new_cost := v_old_cost + v_gross;',
    'v_new_cost := v_old_cost + v_gross + v_fee;'
  );
  v_sql := replace(
    v_sql,
    'v_new_fee_basis := v_old_fee_basis + v_fee;',
    'v_new_fee_basis := 0;'
  );
  v_sql := replace(
    v_sql,
    'v_realized := v_gross - v_fee - v_cost_removed - v_fee_removed;',
    'v_realized := v_gross - v_fee - v_cost_removed;'
  );
  v_sql := replace(
    v_sql,
    'v_new_fee_basis := greatest(v_old_fee_basis - v_fee_removed, 0);',
    'v_new_fee_basis := 0;'
  );
  v_sql := replace(v_sql, '''cost_basis_ex_fee''', '''cost_basis_including_buy_fees''');

  if v_sql = v_before
     or position('v_new_cost := v_old_cost + v_gross + v_fee;' in v_sql) = 0
     or position('v_realized := v_gross - v_fee - v_cost_removed;' in v_sql) = 0
  then
    raise exception 'api_confirm_trade_draft does not match the expected migration 020 definition';
  end if;

  execute v_sql;

  select pg_get_functiondef(
    'public.api_correct_execution(uuid,numeric,numeric,numeric,timestamp with time zone,text)'::regprocedure
  ) into v_sql;
  v_before := v_sql;

  v_sql := replace(
    v_sql,
    'v_cost := v_cost + (v_row.quantity * v_row.price * v_row.multiplier);',
    'v_cost := v_cost + (v_row.quantity * v_row.price * v_row.multiplier) + v_row.fee;'
  );
  v_sql := replace(
    v_sql,
    'v_fee_basis := v_fee_basis + v_row.fee;',
    'v_fee_basis := 0;'
  );
  v_sql := replace(
    v_sql,
    'v_realized := (v_row.quantity * v_row.price * v_row.multiplier) - v_row.fee - v_removed - v_fee_removed;',
    'v_realized := (v_row.quantity * v_row.price * v_row.multiplier) - v_row.fee - v_removed;'
  );
  v_sql := replace(
    v_sql,
    'v_fee_basis := greatest(v_fee_basis - v_fee_removed, 0);',
    'v_fee_basis := 0;'
  );
  v_sql := replace(v_sql, '''position_cost_basis_ex_fee''', '''position_cost_basis_including_buy_fees''');

  if v_sql = v_before
     or position(
       'v_cost := v_cost + (v_row.quantity * v_row.price * v_row.multiplier) + v_row.fee;'
       in v_sql
     ) = 0
     or position(
       'v_realized := (v_row.quantity * v_row.price * v_row.multiplier) - v_row.fee - v_removed;'
       in v_sql
     ) = 0
  then
    raise exception 'api_correct_execution does not match the expected migration 020 definition';
  end if;

  execute v_sql;
end
$patch$;

commit;

-- Verification: average_cost should equal cost_basis / quantity for stocks/ETFs,
-- and fee_basis should be zero because acquisition fees are now included.
select
  i.symbol,
  pb.quantity,
  pb.average_cost,
  pb.cost_basis,
  pb.fee_basis
from public.position_balances pb
join public.instruments i on i.id = pb.instrument_id
where pb.quantity > 0
order by i.symbol;
