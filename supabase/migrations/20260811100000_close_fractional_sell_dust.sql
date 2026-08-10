-- Close sub-micro-share residuals caused by broker display precision.
-- A sell within 0.000001 shares of the full position is treated as sell all.

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
  v_requested numeric := p_quantity;
  v_quantity numeric := p_quantity;
  v_dust_adjusted boolean := false;
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

  if v_quantity > v_available then raise exception 'Sell quantity exceeds current position'; end if;
  if v_available > 0 and v_available - v_quantity between 0 and 0.000001 then
    v_quantity := v_available;
    v_dust_adjusted := v_quantity <> v_requested;
  end if;

  if v_profile = 'dime' then
    v_remaining := v_quantity;
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
    v_cost := case when v_available > 0 then v_position_cost * v_quantity / v_available else 0 end;
  end if;

  v_gross := v_quantity * p_price * v_multiplier;
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
    'requested_quantity', v_requested,
    'quantity', v_quantity,
    'dust_adjusted', v_dust_adjusted,
    'available_quantity', v_available,
    'position_average_cost', v_average,
    'position_quantity_after', v_available - v_quantity,
    'position_average_after', case
      when v_available - v_quantity > 0 and v_multiplier > 0
        then greatest(v_position_cost - v_cost, 0) / ((v_available - v_quantity) * v_multiplier)
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

create or replace function public.api_confirm_trade_draft(
  p_draft_id uuid,
  p_confirmation_token text
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
  v_instrument uuid;
  v_side public.execution_side;
  v_requested_qty numeric;
  v_qty numeric;
  v_dust_adjusted boolean := false;
  v_price numeric;
  v_multiplier numeric;
  v_fee numeric;
  v_gross numeric;
  v_effect numeric;
  v_cash numeric;
  v_cash_after numeric;
  v_existing_qty numeric;
  v_execution uuid;
  v_position jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_draft from public.operation_drafts
  where id = p_draft_id and user_id = v_user for update;
  if not found then raise exception 'Draft not found'; end if;
  if v_draft.operation_type <> 'trade' or v_draft.status <> 'pending' then raise exception 'Draft is not confirmable'; end if;
  if v_draft.expires_at <= now() then raise exception 'Draft has expired'; end if;
  if public.api_token_hash(p_confirmation_token) <> v_draft.confirmation_token_hash then raise exception 'Invalid confirmation token'; end if;
  perform 1 from public.portfolios where id = v_draft.portfolio_id and user_id = v_user for update;
  if not found then raise exception 'Portfolio not found'; end if;
  v_payload := v_draft.request_payload;
  v_instrument := (v_payload->>'instrument_id')::uuid;
  v_side := (v_payload->>'side')::public.execution_side;
  v_requested_qty := (v_payload->>'quantity')::numeric;
  v_qty := v_requested_qty;
  v_price := (v_payload->>'price')::numeric;
  v_multiplier := (v_payload->>'multiplier')::numeric;
  v_fee := coalesce((v_payload->>'fee')::numeric, 0);
  if not exists (select 1 from public.instruments where id = v_instrument and user_id = v_user) then raise exception 'Instrument not found'; end if;
  select coalesce(quantity, 0) into v_existing_qty from public.position_balances
  where portfolio_id = v_draft.portfolio_id and instrument_id = v_instrument for update;
  if v_side = 'sell' and v_qty > coalesce(v_existing_qty, 0) then raise exception 'Sell quantity exceeds current position'; end if;
  if v_side = 'sell' and v_existing_qty > 0 and v_existing_qty - v_qty between 0 and 0.000001 then
    v_qty := v_existing_qty;
    v_dust_adjusted := v_qty <> v_requested_qty;
  end if;
  v_gross := v_qty * v_price * v_multiplier;
  v_effect := case when v_side = 'buy' then -(v_gross + v_fee) else v_gross - v_fee end;
  v_cash := public.api_cash_balance(v_user, v_draft.portfolio_id);
  v_cash_after := v_cash + v_effect;
  if v_side = 'buy' and v_cash_after < 0 then raise exception 'Insufficient portfolio cash'; end if;
  insert into public.executions (
    user_id, portfolio_id, instrument_id, campaign_id, side, quantity, price, multiplier, fee,
    tranche_number, executed_at, idempotency_key, metadata
  ) values (
    v_user, v_draft.portfolio_id, v_instrument, nullif(v_payload->>'campaign_id', '')::uuid,
    v_side, v_qty, v_price, v_multiplier, v_fee, nullif(v_payload->>'tranche_number', '')::smallint,
    (v_payload->>'executed_at')::timestamptz, concat('draft:', v_draft.id::text),
    jsonb_build_object(
      'draft_id', v_draft.id,
      'underlying_price', nullif(v_payload->>'underlying_price', '')::numeric,
      'requested_quantity', case when v_dust_adjusted then v_requested_qty else null end,
      'dust_adjusted', v_dust_adjusted
    )
  ) returning id into v_execution;
  v_position := public.api_rebuild_position(v_user, v_draft.portfolio_id, v_instrument);
  update public.operation_drafts set status = 'confirmed', confirmed_at = now() where id = v_draft.id;
  insert into public.audit_log (user_id, actor_type, actor_id, action, entity_type, entity_id, request_id, after_data)
  values (v_user, 'user', v_user::text, 'confirm_trade', 'execution', v_execution::text, v_draft.idempotency_key,
          jsonb_build_object(
            'side', v_side, 'requested_quantity', v_requested_qty, 'quantity', v_qty,
            'dust_adjusted', v_dust_adjusted, 'price', v_price, 'fee', v_fee,
            'cash_after', v_cash_after, 'broker_rebuilt_position', v_position
          ));
  return jsonb_build_object(
    'execution_id', v_execution, 'requested_quantity', v_requested_qty,
    'quantity', v_qty, 'dust_adjusted', v_dust_adjusted,
    'cash_before', v_cash, 'cash_effect', v_effect, 'cash_after', v_cash_after
  ) || v_position;
end;
$$;

-- Repair only positions whose entire remainder is below the tolerance and whose
-- latest ledger event is a sell. At migration time this targets one AXTI row.
do $$
declare
  v_row record;
  v_before jsonb;
  v_position jsonb;
begin
  for v_row in
    select balance.user_id, balance.portfolio_id, balance.instrument_id,
           balance.quantity as dust_quantity, latest.id as execution_id,
           latest.quantity as execution_quantity
    from public.position_balances balance
    join lateral (
      select execution.id, execution.side, execution.quantity
      from public.executions execution
      where execution.user_id = balance.user_id
        and execution.portfolio_id = balance.portfolio_id
        and execution.instrument_id = balance.instrument_id
      order by execution.executed_at desc, execution.created_at desc, execution.id desc
      limit 1
    ) latest on latest.side = 'sell'
    where balance.quantity > 0
      and balance.quantity <= 0.000001
  loop
    v_before := jsonb_build_object(
      'execution_quantity', v_row.execution_quantity,
      'dust_quantity', v_row.dust_quantity
    );

    update public.executions
    set quantity = quantity + v_row.dust_quantity,
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'dust_closed_at', now(),
          'dust_closed_quantity', v_row.dust_quantity,
          'correction_reason', 'Closed sub-micro-share residual from broker display precision'
        )
    where id = v_row.execution_id;

    v_position := public.api_rebuild_position(v_row.user_id, v_row.portfolio_id, v_row.instrument_id);

    insert into public.audit_log (
      user_id, actor_type, actor_id, action, entity_type, entity_id,
      request_id, before_data, after_data
    ) values (
      v_row.user_id, 'user', v_row.user_id::text, 'normalize_sell_dust',
      'execution', v_row.execution_id::text,
      concat('dust-close:', v_row.execution_id::text), v_before,
      jsonb_build_object(
        'execution_quantity', v_row.execution_quantity + v_row.dust_quantity,
        'broker_rebuilt_position', v_position
      )
    );
  end loop;
end;
$$;

revoke all on function public.api_preview_sell(uuid, uuid, numeric, numeric, numeric, timestamptz) from public, anon;
grant execute on function public.api_preview_sell(uuid, uuid, numeric, numeric, numeric, timestamptz) to authenticated;
revoke all on function public.api_confirm_trade_draft(uuid, text) from public, anon;
grant execute on function public.api_confirm_trade_draft(uuid, text) to authenticated;

commit;
