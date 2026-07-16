-- Journal + manual price API v1. Run after 003_portfolio_api.sql.
-- Journal rows are voided rather than deleted so historical changes remain auditable.

begin;

alter table public.journal_entries
  add column if not exists is_void boolean not null default false,
  add column if not exists void_reason text,
  add column if not exists voided_at timestamptz;

create index if not exists journal_entries_active_date_idx
  on public.journal_entries (user_id, occurred_on desc)
  where is_void = false;

create or replace function public.api_create_journal_entry(
  p_portfolio_id uuid,
  p_occurred_on date,
  p_manual_pnl numeric,
  p_strategy_label text default null,
  p_notes text default null,
  p_instrument_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_entry_id uuid;
  v_outcome public.trade_outcome;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_manual_pnl is null then raise exception 'P/L amount is required'; end if;
  if p_occurred_on is null then raise exception 'Trade date is required'; end if;
  if length(coalesce(p_strategy_label, '')) > 120 then raise exception 'Strategy label is too long'; end if;
  if length(coalesce(p_notes, '')) > 4000 then raise exception 'Notes are too long'; end if;

  if not exists (
    select 1 from public.portfolios p
    where p.id = p_portfolio_id and p.user_id = v_user
  ) then raise exception 'Portfolio not found'; end if;

  if p_instrument_id is not null and not exists (
    select 1 from public.instruments i
    where i.id = p_instrument_id and i.user_id = v_user
  ) then raise exception 'Instrument not found'; end if;

  v_outcome := case
    when p_manual_pnl > 0 then 'win'::public.trade_outcome
    when p_manual_pnl < 0 then 'loss'::public.trade_outcome
    else 'breakeven'::public.trade_outcome
  end;

  insert into public.journal_entries (
    user_id, portfolio_id, instrument_id, source, outcome,
    occurred_on, manual_pnl, strategy_label, notes
  ) values (
    v_user, p_portfolio_id, p_instrument_id, 'manual', v_outcome,
    p_occurred_on, p_manual_pnl, nullif(trim(p_strategy_label), ''),
    nullif(trim(p_notes), '')
  ) returning id into v_entry_id;

  insert into public.audit_log (
    user_id, actor_type, actor_id, action, entity_type, entity_id, after_data
  ) values (
    v_user, 'user', v_user::text, 'create_journal_entry', 'journal_entry',
    v_entry_id::text,
    jsonb_build_object(
      'portfolio_id', p_portfolio_id,
      'instrument_id', p_instrument_id,
      'occurred_on', p_occurred_on,
      'manual_pnl', p_manual_pnl,
      'outcome', v_outcome,
      'strategy_label', nullif(trim(p_strategy_label), '')
    )
  );

  return jsonb_build_object('journal_entry_id', v_entry_id, 'outcome', v_outcome);
end;
$$;

create or replace function public.api_update_journal_entry(
  p_entry_id uuid,
  p_occurred_on date,
  p_manual_pnl numeric,
  p_strategy_label text default null,
  p_notes text default null,
  p_instrument_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_entry public.journal_entries%rowtype;
  v_outcome public.trade_outcome;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_manual_pnl is null then raise exception 'P/L amount is required'; end if;
  if p_occurred_on is null then raise exception 'Trade date is required'; end if;
  if length(coalesce(p_strategy_label, '')) > 120 then raise exception 'Strategy label is too long'; end if;
  if length(coalesce(p_notes, '')) > 4000 then raise exception 'Notes are too long'; end if;

  select * into v_entry from public.journal_entries
  where id = p_entry_id and user_id = v_user for update;
  if not found then raise exception 'Journal entry not found'; end if;
  if v_entry.is_void then raise exception 'Voided journal entry cannot be edited'; end if;
  if v_entry.source = 'derived' then raise exception 'Derived journal entry cannot be edited'; end if;

  if p_instrument_id is not null and not exists (
    select 1 from public.instruments i
    where i.id = p_instrument_id and i.user_id = v_user
  ) then raise exception 'Instrument not found'; end if;

  v_outcome := case
    when p_manual_pnl > 0 then 'win'::public.trade_outcome
    when p_manual_pnl < 0 then 'loss'::public.trade_outcome
    else 'breakeven'::public.trade_outcome
  end;

  update public.journal_entries set
    instrument_id = p_instrument_id,
    outcome = v_outcome,
    occurred_on = p_occurred_on,
    manual_pnl = p_manual_pnl,
    strategy_label = nullif(trim(p_strategy_label), ''),
    notes = nullif(trim(p_notes), ''),
    updated_at = now()
  where id = p_entry_id;

  insert into public.audit_log (
    user_id, actor_type, actor_id, action, entity_type, entity_id,
    before_data, after_data
  ) values (
    v_user, 'user', v_user::text, 'update_journal_entry', 'journal_entry',
    p_entry_id::text,
    jsonb_build_object(
      'instrument_id', v_entry.instrument_id,
      'occurred_on', v_entry.occurred_on,
      'manual_pnl', v_entry.manual_pnl,
      'outcome', v_entry.outcome,
      'strategy_label', v_entry.strategy_label,
      'notes', v_entry.notes
    ),
    jsonb_build_object(
      'instrument_id', p_instrument_id,
      'occurred_on', p_occurred_on,
      'manual_pnl', p_manual_pnl,
      'outcome', v_outcome,
      'strategy_label', nullif(trim(p_strategy_label), ''),
      'notes', nullif(trim(p_notes), '')
    )
  );

  return jsonb_build_object('journal_entry_id', p_entry_id, 'outcome', v_outcome);
end;
$$;

create or replace function public.api_void_journal_entry(
  p_entry_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_entry public.journal_entries%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'Void reason is required'; end if;
  if length(p_reason) > 500 then raise exception 'Void reason is too long'; end if;

  select * into v_entry from public.journal_entries
  where id = p_entry_id and user_id = v_user for update;
  if not found then raise exception 'Journal entry not found'; end if;
  if v_entry.is_void then raise exception 'Journal entry is already voided'; end if;

  update public.journal_entries set
    is_void = true,
    void_reason = trim(p_reason),
    voided_at = now(),
    updated_at = now()
  where id = p_entry_id;

  insert into public.audit_log (
    user_id, actor_type, actor_id, action, entity_type, entity_id,
    before_data, after_data
  ) values (
    v_user, 'user', v_user::text, 'void_journal_entry', 'journal_entry',
    p_entry_id::text,
    to_jsonb(v_entry),
    jsonb_build_object('is_void', true, 'void_reason', trim(p_reason))
  );

  return jsonb_build_object('journal_entry_id', p_entry_id, 'is_void', true);
end;
$$;

create or replace function public.api_record_instrument_price(
  p_instrument_id uuid,
  p_price numeric,
  p_market_time timestamptz default now(),
  p_source text default 'manual'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_price_id bigint;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_price is null or p_price < 0 then raise exception 'Price must be non-negative'; end if;
  if nullif(trim(p_source), '') is null then raise exception 'Price source is required'; end if;
  if not exists (
    select 1 from public.instruments i
    where i.id = p_instrument_id and i.user_id = v_user
  ) then raise exception 'Instrument not found'; end if;

  insert into public.instrument_prices (
    user_id, instrument_id, price, source, market_time
  ) values (
    v_user, p_instrument_id, p_price, trim(p_source), p_market_time
  ) returning id into v_price_id;

  insert into public.audit_log (
    user_id, actor_type, actor_id, action, entity_type, entity_id, after_data
  ) values (
    v_user, 'user', v_user::text, 'record_instrument_price', 'instrument_price',
    v_price_id::text,
    jsonb_build_object(
      'instrument_id', p_instrument_id,
      'price', p_price,
      'source', trim(p_source),
      'market_time', p_market_time
    )
  );

  return jsonb_build_object('price_id', v_price_id, 'instrument_id', p_instrument_id, 'price', p_price);
end;
$$;

revoke all on function public.api_create_journal_entry(uuid, date, numeric, text, text, uuid) from public, anon;
revoke all on function public.api_update_journal_entry(uuid, date, numeric, text, text, uuid) from public, anon;
revoke all on function public.api_void_journal_entry(uuid, text) from public, anon;
revoke all on function public.api_record_instrument_price(uuid, numeric, timestamptz, text) from public, anon;

grant execute on function public.api_create_journal_entry(uuid, date, numeric, text, text, uuid) to authenticated;
grant execute on function public.api_update_journal_entry(uuid, date, numeric, text, text, uuid) to authenticated;
grant execute on function public.api_void_journal_entry(uuid, text) to authenticated;
grant execute on function public.api_record_instrument_price(uuid, numeric, timestamptz, text) to authenticated;

commit;


