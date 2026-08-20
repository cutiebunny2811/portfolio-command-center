begin;

create table if not exists public.portfolio_fx_profiles (
  portfolio_id uuid primary key references public.portfolios(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  opening_usd_balance numeric not null check (opening_usd_balance >= 0),
  opening_thb_basis numeric not null check (opening_thb_basis >= 0),
  opening_rate numeric not null check (opening_rate > 0),
  effective_at timestamptz not null default now(),
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, portfolio_id)
);

create table if not exists public.portfolio_fx_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  cash_movement_id uuid not null unique references public.cash_movements(id) on delete cascade,
  direction text not null check (direction in ('deposit', 'withdrawal')),
  usd_amount numeric not null check (usd_amount > 0),
  thb_amount numeric not null check (thb_amount > 0),
  effective_rate numeric not null check (effective_rate > 0),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists portfolio_fx_entries_portfolio_time_idx
  on public.portfolio_fx_entries (portfolio_id, occurred_at, id);

create table if not exists public.pending_cash_fx (
  user_id uuid not null references auth.users(id) on delete cascade,
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  idempotency_key text not null,
  movement_type text not null check (movement_type in ('deposit', 'withdrawal', 'initial_funding')),
  usd_amount numeric not null check (usd_amount > 0),
  thb_amount numeric not null check (thb_amount > 0),
  effective_rate numeric not null check (effective_rate > 0),
  created_at timestamptz not null default now(),
  primary key (user_id, idempotency_key)
);

create table if not exists public.fx_market_rates (
  pair text primary key,
  base_currency text not null,
  quote_currency text not null,
  rate numeric not null check (rate > 0),
  source text not null,
  source_updated_at timestamptz,
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fx_market_rates_pair_check check (pair = base_currency || quote_currency)
);

comment on table public.portfolio_fx_profiles is
  'Private per-portfolio opening basis for weighted-average USD/THB funding analysis.';
comment on table public.portfolio_fx_entries is
  'Confirmed THB conversions linked one-to-one with canonical cash movements.';
comment on table public.pending_cash_fx is
  'Short-lived FX details waiting for an existing cash draft to be confirmed.';
comment on table public.fx_market_rates is
  'Shared read-only cache of external FX reference rates.';

alter table public.portfolio_fx_profiles enable row level security;
alter table public.portfolio_fx_entries enable row level security;
alter table public.pending_cash_fx enable row level security;
alter table public.fx_market_rates enable row level security;

drop policy if exists portfolio_fx_profiles_select_own on public.portfolio_fx_profiles;
create policy portfolio_fx_profiles_select_own
  on public.portfolio_fx_profiles for select to authenticated
  using (user_id = auth.uid());

drop policy if exists portfolio_fx_entries_select_own on public.portfolio_fx_entries;
create policy portfolio_fx_entries_select_own
  on public.portfolio_fx_entries for select to authenticated
  using (user_id = auth.uid());

drop policy if exists fx_market_rates_authenticated_read on public.fx_market_rates;
create policy fx_market_rates_authenticated_read
  on public.fx_market_rates for select to authenticated
  using (true);

grant select on public.portfolio_fx_profiles to authenticated;
grant select on public.portfolio_fx_entries to authenticated;
grant select on public.fx_market_rates to authenticated;
revoke all on public.pending_cash_fx from public, anon, authenticated;

create or replace function public.api_prepare_cash_fx(
  p_portfolio_id uuid,
  p_movement_type text,
  p_usd_amount numeric,
  p_thb_amount numeric,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_type text := lower(btrim(coalesce(p_movement_type, '')));
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_rate numeric;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if v_type not in ('deposit', 'withdrawal', 'initial_funding') then
    raise exception 'THB conversion is only available for funding movements';
  end if;
  if coalesce(p_usd_amount, 0) <= 0 or coalesce(p_thb_amount, 0) <= 0 then
    raise exception 'USD and THB amounts must be greater than zero';
  end if;
  if v_key = '' then raise exception 'Idempotency key is required'; end if;
  if not exists (
    select 1 from public.portfolios portfolio
    where portfolio.id = p_portfolio_id and portfolio.user_id = v_user
  ) then raise exception 'Portfolio not found'; end if;

  v_rate := p_thb_amount / p_usd_amount;
  delete from public.pending_cash_fx pending
  where pending.user_id = v_user and pending.created_at < now() - interval '1 day';

  insert into public.pending_cash_fx (
    user_id, portfolio_id, idempotency_key, movement_type,
    usd_amount, thb_amount, effective_rate
  ) values (
    v_user, p_portfolio_id, v_key, v_type,
    p_usd_amount, p_thb_amount, v_rate
  )
  on conflict (user_id, idempotency_key) do update set
    portfolio_id = excluded.portfolio_id,
    movement_type = excluded.movement_type,
    usd_amount = excluded.usd_amount,
    thb_amount = excluded.thb_amount,
    effective_rate = excluded.effective_rate,
    created_at = now();

  return jsonb_build_object(
    'usd_amount', p_usd_amount,
    'thb_amount', p_thb_amount,
    'effective_rate', v_rate
  );
end;
$$;

create or replace function public.capture_confirmed_cash_fx()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pending public.pending_cash_fx%rowtype;
begin
  select pending.* into v_pending
  from public.pending_cash_fx pending
  where pending.user_id = new.user_id
    and pending.portfolio_id = new.portfolio_id
    and pending.idempotency_key = new.idempotency_key
  for update;

  if not found then return new; end if;
  if abs(v_pending.usd_amount - abs(new.amount)) > 0.000001 then
    raise exception 'Confirmed cash amount does not match the prepared FX amount';
  end if;
  if lower(new.movement_type) <> v_pending.movement_type then
    raise exception 'Confirmed cash type does not match the prepared FX movement';
  end if;

  insert into public.portfolio_fx_entries (
    user_id, portfolio_id, cash_movement_id, direction,
    usd_amount, thb_amount, effective_rate, occurred_at
  ) values (
    new.user_id,
    new.portfolio_id,
    new.id,
    case when v_pending.movement_type = 'withdrawal' then 'withdrawal' else 'deposit' end,
    v_pending.usd_amount,
    v_pending.thb_amount,
    v_pending.effective_rate,
    new.occurred_at
  )
  on conflict (cash_movement_id) do nothing;

  delete from public.pending_cash_fx pending
  where pending.user_id = v_pending.user_id
    and pending.idempotency_key = v_pending.idempotency_key;
  return new;
end;
$$;

drop trigger if exists cash_movements_capture_fx on public.cash_movements;
create trigger cash_movements_capture_fx
after insert on public.cash_movements
for each row execute function public.capture_confirmed_cash_fx();

create or replace function public.api_set_fx_opening_basis(
  p_portfolio_id uuid,
  p_opening_usd_balance numeric,
  p_opening_rate numeric,
  p_effective_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_row public.portfolio_fx_profiles%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if coalesce(p_opening_usd_balance, -1) < 0 then raise exception 'Opening USD balance cannot be negative'; end if;
  if coalesce(p_opening_rate, 0) <= 0 then raise exception 'Opening FX rate must be greater than zero'; end if;
  if not exists (
    select 1 from public.portfolios portfolio
    where portfolio.id = p_portfolio_id and portfolio.user_id = v_user
  ) then raise exception 'Portfolio not found'; end if;
  if exists (
    select 1 from public.portfolio_fx_entries entry
    where entry.portfolio_id = p_portfolio_id and entry.user_id = v_user
  ) then raise exception 'Opening basis is locked after the first confirmed FX movement'; end if;

  insert into public.portfolio_fx_profiles (
    portfolio_id, user_id, opening_usd_balance, opening_thb_basis,
    opening_rate, effective_at, source
  ) values (
    p_portfolio_id, v_user, p_opening_usd_balance,
    p_opening_usd_balance * p_opening_rate,
    p_opening_rate, coalesce(p_effective_at, now()), 'manual'
  )
  on conflict (portfolio_id) do update set
    opening_usd_balance = excluded.opening_usd_balance,
    opening_thb_basis = excluded.opening_thb_basis,
    opening_rate = excluded.opening_rate,
    effective_at = excluded.effective_at,
    source = 'manual',
    updated_at = now()
  where public.portfolio_fx_profiles.user_id = v_user
  returning * into v_row;

  if v_row.portfolio_id is null then raise exception 'Opening basis could not be updated'; end if;
  return to_jsonb(v_row);
end;
$$;

revoke all on function public.api_prepare_cash_fx(uuid, text, numeric, numeric, text) from public, anon;
revoke all on function public.api_set_fx_opening_basis(uuid, numeric, numeric, timestamptz) from public, anon;
grant execute on function public.api_prepare_cash_fx(uuid, text, numeric, numeric, text) to authenticated;
grant execute on function public.api_set_fx_opening_basis(uuid, numeric, numeric, timestamptz) to authenticated;

with owner_user as (
  select portfolio.user_id
  from public.portfolios portfolio
  where portfolio.is_active = true
  group by portfolio.user_id
  having count(*) filter (where lower(btrim(portfolio.name)) = 'long term') = 1
     and count(*) filter (where lower(btrim(portfolio.name)) = 'swing trade') = 1
     and count(*) filter (where lower(btrim(portfolio.name)) = 'options') = 1
  order by count(*) desc
  limit 1
), owner_portfolios as (
  select
    portfolio.id as portfolio_id,
    portfolio.user_id,
    case lower(btrim(portfolio.name))
      when 'long term' then 33.8080::numeric
      when 'swing trade' then 31.3139::numeric
      when 'options' then 31.6564::numeric
    end as opening_rate,
    greatest(
      coalesce(cash.cash_balance, 0)
      + coalesce((
        select sum(position.cost_basis)
        from public.position_balances position
        where position.portfolio_id = portfolio.id
      ), 0),
      0
    ) as opening_usd_balance
  from public.portfolios portfolio
  join owner_user owner on owner.user_id = portfolio.user_id
  left join public.portfolio_cash_balances cash on cash.portfolio_id = portfolio.id
  where lower(btrim(portfolio.name)) in ('long term', 'swing trade', 'options')
)
insert into public.portfolio_fx_profiles (
  portfolio_id, user_id, opening_usd_balance, opening_thb_basis,
  opening_rate, effective_at, source
)
select
  portfolio_id,
  user_id,
  opening_usd_balance,
  opening_usd_balance * opening_rate,
  opening_rate,
  now(),
  'owner_seed_2026_08_21'
from owner_portfolios
on conflict (portfolio_id) do nothing;

commit;
