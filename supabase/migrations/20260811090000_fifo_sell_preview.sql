-- Read-only exit preview for broker-specific sell accounting.
-- Dime consumes open lots FIFO; Webull removes weighted-average cost.

begin;

create or replace function public.api_preview_sell(
  p_portfolio_id uuid,
  p_instrument_id uuid,
  p_quantity numeric,
  p_price numeric,
  p_fee numeric default 0,
  p_executed_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_profile text;
  v_symbol text;
  v_asset public.asset_type;
  v_multiplier numeric := 1;
  v_available numeric := 0;
  v_average numeric := 0;
  v_position_cost numeric := 0;
  v_last_execution timestamptz;
  v_lot public.position_lots%rowtype;
  v_remaining numeric;
  v_take numeric;
  v_cost numeric := 0;
  v_buy_fees numeric := 0;
  v_gross numeric;
  v_net numeric;
  v_realized numeric;
  v_basis numeric;
  v_lots jsonb := '[]'::jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Quantity must be greater than zero'; end if;
  if p_price is null or p_price < 0 then raise exception 'Price cannot be negative'; end if;
  if p_fee is null or p_fee < 0 then raise exception 'Fee cannot be negative'; end if;
  if p_executed_at is null then raise exception 'Execution time is required'; end if;

  select portfolio.broker_profile, instrument.symbol, instrument.asset_type,
         coalesce(instrument.multiplier, 1), coalesce(balance.quantity, 0),
         coalesce(balance.average_cost, 0), coalesce(balance.cost_basis, 0),
         balance.last_execution_at
    into v_profile, v_symbol, v_asset, v_multiplier, v_available,
         v_average, v_position_cost, v_last_execution
  from public.portfolios portfolio
  join public.instruments instrument
    on instrument.id = p_instrument_id and instrument.user_id = v_user
  left join public.position_balances balance
    on balance.portfolio_id = portfolio.id and balance.instrument_id = instrument.id
  where portfolio.id = p_portfolio_id
    and portfolio.user_id = v_user
    and portfolio.is_active = true;

  if not found then raise exception 'Active portfolio or instrument not found'; end if;
  if v_last_execution is not null and p_executed_at < v_last_execution then
    return jsonb_build_object(
      'status', 'backdated',
      'broker_profile', v_profile,
      'symbol', v_symbol,
      'available_quantity', v_available,
      'last_execution_at', v_last_execution,
      'message', 'This sell predates the latest ledger entry. Final FIFO must be rebuilt in chronological order.'
    );
  end if;

  if p_quantity > v_available then raise exception 'Sell quantity exceeds current position'; end if;

  if v_profile = 'dime' then
    v_remaining := p_quantity;
    for v_lot in
      select *
      from public.position_lots lot
      where lot.user_id = v_user
        and lot.portfolio_id = p_portfolio_id
        and lot.instrument_id = p_instrument_id
        and lot.quantity_open > 0
      order by lot.opened_at, lot.buy_execution_id
    loop
      exit when v_remaining <= 0;
      v_take := least(v_remaining, v_lot.quantity_open);
      v_cost := v_cost + (v_take * v_lot.unit_cost);
      v_buy_fees := v_buy_fees + (v_take * v_lot.fee_per_unit);
      v_lots := v_lots || jsonb_build_array(jsonb_build_object(
        'buy_execution_id', v_lot.buy_execution_id,
        'opened_at', v_lot.opened_at,
        'quantity', v_take,
        'quote_price', case when v_multiplier > 0 then v_lot.unit_cost / v_multiplier else v_lot.unit_cost end,
        'cost_consumed', v_take * v_lot.unit_cost,
        'buy_fee_consumed', v_take * v_lot.fee_per_unit
      ));
      v_remaining := v_remaining - v_take;
    end loop;
    if v_remaining > 0.00000001 then
      return jsonb_build_object(
        'status', 'unavailable',
        'broker_profile', v_profile,
        'symbol', v_symbol,
        'available_quantity', v_available,
        'message', 'Open FIFO lots do not cover this sell. Rebuild the position before estimating an exit.'
      );
    end if;
  else
    v_cost := case when v_available > 0 then v_position_cost * p_quantity / v_available else 0 end;
  end if;

  v_gross := p_quantity * p_price * v_multiplier;
  v_net := v_gross - p_fee;
  v_realized := v_gross - p_fee - v_cost - v_buy_fees;
  v_basis := v_cost + v_buy_fees;

  return jsonb_build_object(
    'status', 'ready',
    'broker_profile', v_profile,
    'method', case when v_profile = 'dime' then 'fifo' else 'weighted_average' end,
    'symbol', v_symbol,
    'asset_type', v_asset,
    'multiplier', v_multiplier,
    'quantity', p_quantity,
    'price', p_price,
    'available_quantity', v_available,
    'position_average_cost', v_average,
    'position_quantity_after', v_available - p_quantity,
    'position_average_after', case
      when v_available - p_quantity > 0 and v_multiplier > 0
        then greatest(v_position_cost - v_cost, 0) / ((v_available - p_quantity) * v_multiplier)
      else 0
    end,
    'gross_proceeds', v_gross,
    'sell_fee', p_fee,
    'net_proceeds', v_net,
    'cost_consumed', v_cost,
    'buy_fees_consumed', v_buy_fees,
    'estimated_realized_pnl', v_realized,
    'estimated_return_percent', case when v_basis > 0 then v_realized / v_basis * 100 else 0 end,
    'lots_consumed', v_lots,
    'estimated_at', now()
  );
end;
$$;

create or replace function public.api_preview_agent_draft_sell(
  p_draft_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_draft public.operation_drafts%rowtype;
  v_payload jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_draft
  from public.operation_drafts draft
  where draft.id = p_draft_id
    and draft.user_id = v_user
    and draft.status = 'pending';
  if not found then raise exception 'Pending draft not found'; end if;
  if v_draft.operation_type <> 'trade' then
    return jsonb_build_object('status', 'not_applicable');
  end if;

  v_payload := v_draft.request_payload;
  if coalesce(v_payload->>'side', '') <> 'sell' then
    return jsonb_build_object('status', 'not_applicable');
  end if;

  return public.api_preview_sell(
    v_draft.portfolio_id,
    (v_payload->>'instrument_id')::uuid,
    (v_payload->>'quantity')::numeric,
    (v_payload->>'price')::numeric,
    coalesce((v_payload->>'fee')::numeric, 0),
    (v_payload->>'executed_at')::timestamptz
  );
end;
$$;

revoke all on function public.api_preview_sell(uuid, uuid, numeric, numeric, numeric, timestamptz) from public, anon;
revoke all on function public.api_preview_agent_draft_sell(uuid) from public, anon;
grant execute on function public.api_preview_sell(uuid, uuid, numeric, numeric, numeric, timestamptz) to authenticated;
grant execute on function public.api_preview_agent_draft_sell(uuid) to authenticated;

do $$
begin
  if to_regprocedure('public.api_preview_sell(uuid,uuid,numeric,numeric,numeric,timestamp with time zone)') is null then
    raise exception 'api_preview_sell was not created';
  end if;
  if to_regprocedure('public.api_preview_agent_draft_sell(uuid)') is null then
    raise exception 'api_preview_agent_draft_sell was not created';
  end if;
end;
$$;

commit;
