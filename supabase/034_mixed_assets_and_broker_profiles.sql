-- A portfolio is a broker account: it can contain stocks, ETFs and long
-- options together. The broker profile is immutable after its first trade.
-- Webull keeps its weighted-average, fee-inclusive convention. Dime keeps
-- price-only display cost and consumes open lots FIFO.

begin;

alter table public.portfolios
  add column if not exists broker_profile text not null default 'webull';

alter table public.portfolios
  drop constraint if exists portfolios_broker_profile_check;

alter table public.portfolios
  add constraint portfolios_broker_profile_check
  check (broker_profile in ('webull', 'dime'));

alter table public.portfolios
  drop constraint if exists portfolios_portfolio_mode_check;

alter table public.portfolios
  add constraint portfolios_portfolio_mode_check
  check (portfolio_mode in ('standard', 'options', 'mixed'));

-- Existing ledgers retain Webull accounting and become able to hold mixed
-- assets. Their historical executions and balances are not otherwise changed.
update public.portfolios
set portfolio_mode = 'mixed',
    allocation_basis = 'cost_basis',
    broker_profile = coalesce(nullif(broker_profile, ''), 'webull');

create table if not exists public.position_lots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  instrument_id uuid not null references public.instruments(id) on delete cascade,
  buy_execution_id uuid not null references public.executions(id) on delete cascade,
  opened_at timestamptz not null,
  quantity_open numeric not null check (quantity_open >= 0),
  unit_cost numeric not null check (unit_cost >= 0),
  fee_per_unit numeric not null default 0 check (fee_per_unit >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (buy_execution_id)
);

create index if not exists position_lots_fifo_idx
  on public.position_lots (user_id, portfolio_id, instrument_id, opened_at, buy_execution_id)
  where quantity_open > 0;

alter table public.position_lots enable row level security;

-- Rebuild one position from immutable executions. It is used for corrections,
-- profile backfill and each newly confirmed trade, so position_balances remain
-- a fast read model rather than a second source of truth.
create or replace function public.api_rebuild_position(
  p_user_id uuid,
  p_portfolio_id uuid,
  p_instrument_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile text;
  v_asset public.asset_type;
  v_row public.executions%rowtype;
  v_lot public.position_lots%rowtype;
  v_qty numeric := 0;
  v_cost numeric := 0;
  v_fee_basis numeric := 0;
  v_max_loss numeric := 0;
  v_notional numeric := null;
  v_realized_total numeric := 0;
  v_removed numeric := 0;
  v_fee_removed numeric := 0;
  v_realized numeric;
  v_remaining numeric;
  v_take numeric;
  v_underlying numeric;
  v_last_at timestamptz;
begin
  select p.broker_profile, i.asset_type
    into v_profile, v_asset
  from public.portfolios p
  join public.instruments i on i.id = p_instrument_id
  where p.id = p_portfolio_id and p.user_id = p_user_id;
  if not found then raise exception 'Portfolio or instrument not found'; end if;

  delete from public.position_lots
  where user_id = p_user_id and portfolio_id = p_portfolio_id and instrument_id = p_instrument_id;

  for v_row in
    select * from public.executions
    where user_id = p_user_id and portfolio_id = p_portfolio_id and instrument_id = p_instrument_id
    order by executed_at, created_at, id
    for update
  loop
    v_last_at := v_row.executed_at;
    v_underlying := nullif(v_row.metadata->>'underlying_price', '')::numeric;
    if v_row.side = 'buy' then
      v_qty := v_qty + v_row.quantity;
      if v_profile = 'dime' then
        v_cost := v_cost + (v_row.quantity * v_row.price * v_row.multiplier);
        v_fee_basis := v_fee_basis + v_row.fee;
        insert into public.position_lots (
          user_id, portfolio_id, instrument_id, buy_execution_id, opened_at,
          quantity_open, unit_cost, fee_per_unit
        ) values (
          p_user_id, p_portfolio_id, p_instrument_id, v_row.id, v_row.executed_at,
          v_row.quantity,
          case when v_row.quantity > 0 then (v_row.quantity * v_row.price * v_row.multiplier) / v_row.quantity else 0 end,
          case when v_row.quantity > 0 then v_row.fee / v_row.quantity else 0 end
        );
      else
        v_cost := v_cost + (v_row.quantity * v_row.price * v_row.multiplier) + v_row.fee;
      end if;
      if v_asset = 'option' then
        v_max_loss := v_max_loss + (v_row.quantity * v_row.price * v_row.multiplier) + v_row.fee;
        if v_underlying is not null then v_notional := v_qty * v_row.multiplier * v_underlying; end if;
      end if;
      update public.executions set realized_pnl = null where id = v_row.id;
    else
      if v_row.quantity > v_qty then raise exception 'A sell exceeds the available position'; end if;
      v_removed := 0;
      v_fee_removed := 0;
      if v_profile = 'dime' then
        v_remaining := v_row.quantity;
        for v_lot in
          select * from public.position_lots
          where user_id = p_user_id and portfolio_id = p_portfolio_id and instrument_id = p_instrument_id and quantity_open > 0
          order by opened_at, buy_execution_id
          for update
        loop
          exit when v_remaining <= 0;
          v_take := least(v_remaining, v_lot.quantity_open);
          v_removed := v_removed + (v_take * v_lot.unit_cost);
          v_fee_removed := v_fee_removed + (v_take * v_lot.fee_per_unit);
          update public.position_lots
          set quantity_open = quantity_open - v_take, updated_at = now()
          where id = v_lot.id;
          v_remaining := v_remaining - v_take;
        end loop;
        if v_remaining > 0.00000001 then raise exception 'FIFO lots do not cover this sell'; end if;
      else
        v_removed := case when v_qty > 0 then v_cost * v_row.quantity / v_qty else 0 end;
      end if;
      v_realized := (v_row.quantity * v_row.price * v_row.multiplier) - v_row.fee - v_removed - v_fee_removed;
      v_realized_total := v_realized_total + v_realized;
      if v_asset = 'option' and v_qty > 0 then
        v_max_loss := greatest(v_max_loss - (v_max_loss * v_row.quantity / v_qty), 0);
      end if;
      v_cost := greatest(v_cost - v_removed, 0);
      v_fee_basis := greatest(v_fee_basis - v_fee_removed, 0);
      v_qty := v_qty - v_row.quantity;
      if v_asset = 'option' then
        if v_underlying is not null then v_notional := v_qty * v_row.multiplier * v_underlying;
        elsif v_qty = 0 then v_notional := 0; end if;
      end if;
      update public.executions set realized_pnl = v_realized where id = v_row.id;
      insert into public.journal_entries (
        user_id, portfolio_id, campaign_id, instrument_id, execution_id,
        source, outcome, occurred_on, manual_pnl, strategy_label, notes
      ) values (
        p_user_id, p_portfolio_id, v_row.campaign_id, p_instrument_id, v_row.id,
        'derived', case when v_realized > 0 then 'win'::public.trade_outcome when v_realized < 0 then 'loss'::public.trade_outcome else 'breakeven'::public.trade_outcome end,
        (v_row.executed_at at time zone 'Asia/Bangkok')::date, v_realized, 'Automatic sell',
        format('Sold %s at %s; fee %s', v_row.quantity, v_row.price, v_row.fee)
      ) on conflict (execution_id) where execution_id is not null do update
      set outcome = excluded.outcome, occurred_on = excluded.occurred_on,
          manual_pnl = excluded.manual_pnl, notes = excluded.notes, updated_at = now();
    end if;
  end loop;

  insert into public.position_balances (
    user_id, portfolio_id, instrument_id, quantity, average_cost, cost_basis,
    fee_basis, maximum_loss, notional_value, realized_pnl, last_execution_at, updated_at
  ) values (
    p_user_id, p_portfolio_id, p_instrument_id, v_qty,
    case when v_qty > 0 then v_cost / (v_qty * coalesce((select multiplier from public.executions where user_id = p_user_id and portfolio_id = p_portfolio_id and instrument_id = p_instrument_id order by executed_at desc, created_at desc, id desc limit 1), 1)) else 0 end,
    v_cost, v_fee_basis,
    case when v_asset = 'option' then v_max_loss else null end,
    case when v_asset = 'option' then v_notional else null end,
    v_realized_total, v_last_at, now()
  ) on conflict (portfolio_id, instrument_id) do update
  set quantity = excluded.quantity, average_cost = excluded.average_cost,
      cost_basis = excluded.cost_basis, fee_basis = excluded.fee_basis,
      maximum_loss = excluded.maximum_loss, notional_value = excluded.notional_value,
      realized_pnl = excluded.realized_pnl, last_execution_at = excluded.last_execution_at,
      updated_at = excluded.updated_at;

  return jsonb_build_object(
    'position_quantity', v_qty,
    'average_cost', case when v_qty > 0 then v_cost / (v_qty * coalesce((select multiplier from public.executions where user_id = p_user_id and portfolio_id = p_portfolio_id and instrument_id = p_instrument_id order by executed_at desc, created_at desc, id desc limit 1), 1)) else 0 end,
    'cost_basis', v_cost, 'fee_basis_remaining', v_fee_basis,
    'maximum_loss', case when v_asset = 'option' then v_max_loss else null end,
    'notional_value', case when v_asset = 'option' then v_notional else null end,
    'realized_pnl_total', v_realized_total
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
  v_qty numeric;
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
  v_qty := (v_payload->>'quantity')::numeric;
  v_price := (v_payload->>'price')::numeric;
  v_multiplier := (v_payload->>'multiplier')::numeric;
  v_fee := coalesce((v_payload->>'fee')::numeric, 0);
  if not exists (select 1 from public.instruments where id = v_instrument and user_id = v_user) then raise exception 'Instrument not found'; end if;
  select coalesce(quantity, 0) into v_existing_qty from public.position_balances
  where portfolio_id = v_draft.portfolio_id and instrument_id = v_instrument for update;
  if v_side = 'sell' and v_qty > coalesce(v_existing_qty, 0) then raise exception 'Sell quantity exceeds current position'; end if;
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
    jsonb_build_object('draft_id', v_draft.id, 'underlying_price', nullif(v_payload->>'underlying_price', '')::numeric)
  ) returning id into v_execution;
  v_position := public.api_rebuild_position(v_user, v_draft.portfolio_id, v_instrument);
  update public.operation_drafts set status = 'confirmed', confirmed_at = now() where id = v_draft.id;
  insert into public.audit_log (user_id, actor_type, actor_id, action, entity_type, entity_id, request_id, after_data)
  values (v_user, 'user', v_user::text, 'confirm_trade', 'execution', v_execution::text, v_draft.idempotency_key,
          jsonb_build_object('side', v_side, 'quantity', v_qty, 'price', v_price, 'fee', v_fee, 'cash_after', v_cash_after, 'broker_rebuilt_position', v_position));
  return jsonb_build_object('execution_id', v_execution, 'cash_before', v_cash, 'cash_effect', v_effect, 'cash_after', v_cash_after) || v_position;
end;
$$;

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
  v_position jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Quantity must be greater than zero'; end if;
  if p_price is null or p_price < 0 then raise exception 'Price cannot be negative'; end if;
  if p_fee is null or p_fee < 0 then raise exception 'Fee cannot be negative'; end if;
  if p_executed_at is null then raise exception 'Execution time is required'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'Correction reason is required'; end if;
  select * into v_target from public.executions where id = p_execution_id and user_id = v_user for update;
  if not found then raise exception 'Execution not found'; end if;
  perform 1 from public.portfolios where id = v_target.portfolio_id and user_id = v_user for update;
  v_before := to_jsonb(v_target);
  update public.executions set quantity = p_quantity, price = p_price, fee = p_fee, executed_at = p_executed_at,
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('corrected_at', now(), 'correction_reason', trim(p_reason))
  where id = p_execution_id;
  v_position := public.api_rebuild_position(v_user, v_target.portfolio_id, v_target.instrument_id);
  insert into public.audit_log (user_id, actor_type, actor_id, action, entity_type, entity_id, request_id, before_data, after_data)
  values (v_user, 'user', v_user::text, 'correct_execution', 'execution', p_execution_id::text,
    concat('correction:', p_execution_id::text, ':', extract(epoch from now())::text), v_before,
    jsonb_build_object('quantity', p_quantity, 'price', p_price, 'fee', p_fee, 'executed_at', p_executed_at, 'reason', trim(p_reason), 'broker_rebuilt_position', v_position));
  return jsonb_build_object('execution_id', p_execution_id) || v_position;
end;
$$;

create or replace function public.api_create_portfolio(
  p_name text,
  p_portfolio_mode text,
  p_fixed_budget numeric,
  p_broker_profile text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_name text := nullif(btrim(p_name), '');
  v_broker text := lower(btrim(coalesce(p_broker_profile, 'webull')));
  v_portfolio public.portfolios%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if v_name is null then raise exception 'Portfolio name is required'; end if;
  if char_length(v_name) > 80 then raise exception 'Portfolio name is too long'; end if;
  if v_broker not in ('webull', 'dime') then raise exception 'Broker must be Webull or Dime'; end if;
  if coalesce(p_fixed_budget, 0) < 0 then raise exception 'Starting budget cannot be negative'; end if;
  insert into public.portfolios (
    user_id, kind, name, base_currency, fixed_budget, allocation_basis,
    cost_method, sort_order, is_active, portfolio_mode, archived_at, broker_profile
  ) values (
    v_user, 'long_term'::public.portfolio_kind, v_name, 'USD', coalesce(p_fixed_budget, 0), 'cost_basis',
    'weighted_average', coalesce((select max(sort_order) + 1 from public.portfolios where user_id = v_user), 1),
    true, 'mixed', null, v_broker
  ) returning * into v_portfolio;
  insert into public.audit_log (user_id, actor_type, actor_id, action, entity_type, entity_id, request_id, after_data)
  values (v_user, 'user', v_user::text, 'create_portfolio', 'portfolio', v_portfolio.id::text,
    concat('portfolio:create:', v_portfolio.id::text), to_jsonb(v_portfolio));
  return to_jsonb(v_portfolio);
end;
$$;

create or replace function public.api_set_portfolio_broker(
  p_portfolio_id uuid,
  p_broker_profile text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_profile text := lower(btrim(coalesce(p_broker_profile, '')));
  v_before public.portfolios%rowtype;
  v_after public.portfolios%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if v_profile not in ('webull', 'dime') then raise exception 'Broker must be Webull or Dime'; end if;
  select * into v_before from public.portfolios where id = p_portfolio_id and user_id = v_user and is_active = true for update;
  if not found then raise exception 'Active portfolio not found'; end if;
  if exists (select 1 from public.executions where portfolio_id = p_portfolio_id and user_id = v_user) then
    raise exception 'Broker profile is locked after the first transaction';
  end if;
  update public.portfolios set broker_profile = v_profile, portfolio_mode = 'mixed', allocation_basis = 'cost_basis'
  where id = p_portfolio_id returning * into v_after;
  insert into public.audit_log (user_id, actor_type, actor_id, action, entity_type, entity_id, request_id, before_data, after_data)
  values (v_user, 'user', v_user::text, 'set_portfolio_broker', 'portfolio', p_portfolio_id::text,
    concat('portfolio:broker:', p_portfolio_id::text), to_jsonb(v_before), to_jsonb(v_after));
  return to_jsonb(v_after);
end;
$$;

-- Backfill lot rows and refresh existing Webull balances under the unified
-- rebuild path. A pre-dashboard opening balance without executions is left as-is.
do $$
declare p record;
begin
  for p in select user_id, portfolio_id, instrument_id from public.executions group by user_id, portfolio_id, instrument_id loop
    -- A legacy opening snapshot can predate PCC's first recorded buy. Keep
    -- that balance untouched instead of inventing FIFO lots for historical
    -- sells that the app never recorded.
    if not exists (
      with running as (
        select sum(case when side = 'buy' then quantity else -quantity end)
          over (order by executed_at, created_at, id) as quantity_after
        from public.executions
        where user_id = p.user_id and portfolio_id = p.portfolio_id and instrument_id = p.instrument_id
      )
      select 1 from running where quantity_after < 0
    ) then
      perform public.api_rebuild_position(p.user_id, p.portfolio_id, p.instrument_id);
    end if;
  end loop;
end;
$$;

revoke all on function public.api_rebuild_position(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.api_confirm_trade_draft(uuid, text) to authenticated;
grant execute on function public.api_correct_execution(uuid, numeric, numeric, numeric, timestamptz, text) to authenticated;
grant execute on function public.api_create_portfolio(text, text, numeric, text) to authenticated;
grant execute on function public.api_set_portfolio_broker(uuid, text) to authenticated;

commit;
