-- Audited correction for a confirmed execution.
-- Replays the affected instrument chronologically so weighted-average cost,
-- realized P/L and the linked derived journal entries stay consistent.

begin;

create or replace function public.api_correct_execution(
  p_execution_id uuid,
  p_quantity numeric,
  p_price numeric,
  p_fee numeric,
  p_executed_at timestamptz,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_target public.executions%rowtype;
  v_before jsonb;
  v_row public.executions%rowtype;
  v_asset public.asset_type;
  v_qty numeric := 0;
  v_cost numeric := 0;
  v_max_loss numeric := 0;
  v_notional numeric := null;
  v_realized_total numeric := 0;
  v_removed numeric;
  v_realized numeric;
  v_underlying numeric;
  v_sell_count integer := 0;
  v_last_at timestamptz;
begin
  if v_user is null then
    raise exception 'Authentication required';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be greater than zero';
  end if;
  if p_price is null or p_price < 0 then
    raise exception 'Price cannot be negative';
  end if;
  if p_fee is null or p_fee < 0 then
    raise exception 'Fee cannot be negative';
  end if;
  if p_executed_at is null then
    raise exception 'Execution time is required';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'Correction reason is required';
  end if;

  select *
  into v_target
  from public.executions
  where id = p_execution_id
    and user_id = v_user
  for update;

  if not found then
    raise exception 'Execution not found';
  end if;

  perform 1
  from public.portfolios
  where id = v_target.portfolio_id
    and user_id = v_user
  for update;

  select i.asset_type
  into v_asset
  from public.instruments i
  where i.id = v_target.instrument_id
    and i.user_id = v_user;

  v_before := to_jsonb(v_target);

  update public.executions
  set quantity = p_quantity,
      price = p_price,
      fee = p_fee,
      executed_at = p_executed_at,
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'corrected_at', now(),
        'correction_reason', trim(p_reason)
      )
  where id = p_execution_id;

  for v_row in
    select *
    from public.executions
    where user_id = v_user
      and portfolio_id = v_target.portfolio_id
      and instrument_id = v_target.instrument_id
    order by executed_at, created_at, id
    for update
  loop
    v_last_at := v_row.executed_at;
    v_underlying := nullif(v_row.metadata->>'underlying_price', '')::numeric;

    if v_row.side = 'buy' then
      v_qty := v_qty + v_row.quantity;
      v_cost := v_cost + (v_row.quantity * v_row.price * v_row.multiplier) + v_row.fee;
      if v_asset = 'option' then
        v_max_loss := v_max_loss + (v_row.quantity * v_row.price * v_row.multiplier) + v_row.fee;
        if v_underlying is not null then
          v_notional := v_qty * v_row.multiplier * v_underlying;
        end if;
      end if;
      update public.executions set realized_pnl = null where id = v_row.id;
    else
      if v_row.quantity > v_qty then
        raise exception 'Correction would make a later sell exceed the available position';
      end if;
      v_removed := case when v_qty > 0 then v_cost * v_row.quantity / v_qty else 0 end;
      v_realized := (v_row.quantity * v_row.price * v_row.multiplier) - v_row.fee - v_removed;
      v_realized_total := v_realized_total + v_realized;

      if v_asset = 'option' and v_qty > 0 then
        v_max_loss := greatest(v_max_loss - (v_max_loss * v_row.quantity / v_qty), 0);
      end if;
      v_cost := greatest(v_cost - v_removed, 0);
      v_qty := v_qty - v_row.quantity;
      if v_asset = 'option' then
        if v_underlying is not null then
          v_notional := v_qty * v_row.multiplier * v_underlying;
        elsif v_qty = 0 then
          v_notional := 0;
        end if;
      end if;

      update public.executions
      set realized_pnl = v_realized
      where id = v_row.id;

      insert into public.journal_entries (
        user_id, portfolio_id, campaign_id, instrument_id, execution_id,
        source, outcome, occurred_on, manual_pnl, strategy_label, notes
      ) values (
        v_row.user_id, v_row.portfolio_id, v_row.campaign_id, v_row.instrument_id, v_row.id,
        'derived',
        case
          when v_realized > 0 then 'win'::public.trade_outcome
          when v_realized < 0 then 'loss'::public.trade_outcome
          else 'breakeven'::public.trade_outcome
        end,
        (v_row.executed_at at time zone 'Asia/Bangkok')::date,
        v_realized,
        'Automatic sell',
        format('Sold %s at %s; fee %s', v_row.quantity, v_row.price, v_row.fee)
      )
      on conflict (execution_id) where execution_id is not null
      do update set
        outcome = excluded.outcome,
        occurred_on = excluded.occurred_on,
        manual_pnl = excluded.manual_pnl,
        notes = excluded.notes,
        updated_at = now();
      v_sell_count := v_sell_count + 1;
    end if;
  end loop;

  insert into public.position_balances (
    user_id, portfolio_id, instrument_id, quantity, average_cost, cost_basis,
    maximum_loss, notional_value, realized_pnl, last_execution_at, updated_at
  ) values (
    v_user, v_target.portfolio_id, v_target.instrument_id,
    v_qty,
    case when v_qty > 0 then v_cost / (v_qty * v_target.multiplier) else 0 end,
    v_cost,
    case when v_asset = 'option' then v_max_loss else null end,
    case when v_asset = 'option' then v_notional else null end,
    v_realized_total,
    v_last_at,
    now()
  )
  on conflict (portfolio_id, instrument_id)
  do update set
    quantity = excluded.quantity,
    average_cost = excluded.average_cost,
    cost_basis = excluded.cost_basis,
    maximum_loss = excluded.maximum_loss,
    notional_value = excluded.notional_value,
    realized_pnl = excluded.realized_pnl,
    last_execution_at = excluded.last_execution_at,
    updated_at = excluded.updated_at;

  insert into public.audit_log (
    user_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_data, after_data
  ) values (
    v_user, 'user', v_user::text, 'correct_execution', 'execution', p_execution_id::text,
    concat('correction:', p_execution_id::text, ':', extract(epoch from now())::text),
    v_before,
    jsonb_build_object(
      'quantity', p_quantity,
      'price', p_price,
      'fee', p_fee,
      'executed_at', p_executed_at,
      'reason', trim(p_reason),
      'position_quantity', v_qty,
      'position_cost_basis', v_cost,
      'realized_pnl_total', v_realized_total,
      'recalculated_sells', v_sell_count
    )
  );

  return jsonb_build_object(
    'execution_id', p_execution_id,
    'position_quantity', v_qty,
    'average_cost', case when v_qty > 0 then v_cost / (v_qty * v_target.multiplier) else 0 end,
    'cost_basis', v_cost,
    'realized_pnl_total', v_realized_total,
    'recalculated_sells', v_sell_count
  );
end;
$$;

revoke all on function public.api_correct_execution(uuid, numeric, numeric, numeric, timestamptz, text)
  from public, anon;
grant execute on function public.api_correct_execution(uuid, numeric, numeric, numeric, timestamptz, text)
  to authenticated;

commit;
