-- Watchlist-only market pulse cache.
-- One row per user and symbol keeps the dashboard fast without retaining
-- every 15-minute snapshot forever.

create table if not exists public.market_pulse_latest (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  instrument_id uuid null references public.instruments(id) on delete set null,
  symbol text not null,
  display_name text,
  asset_type text not null check (asset_type in ('stock', 'etf')),
  is_watchlist boolean not null default false,
  is_benchmark boolean not null default false,
  is_sector boolean not null default false,
  sector_name text,
  price numeric not null default 0 check (price >= 0),
  previous_close numeric,
  change_value numeric,
  change_percent numeric,
  volume numeric,
  turnover numeric,
  return_1w numeric,
  return_1m numeric,
  return_3m numeric,
  return_ytd numeric,
  sector_bars_at timestamptz,
  market_time timestamptz,
  fetched_at timestamptz not null default now(),
  primary key (user_id, symbol)
);

create index if not exists market_pulse_latest_user_watchlist_idx
  on public.market_pulse_latest (user_id, is_watchlist, change_percent desc);

create index if not exists market_pulse_latest_user_sector_idx
  on public.market_pulse_latest (user_id, is_sector, symbol);

alter table public.market_pulse_latest enable row level security;

drop policy if exists "market pulse select own" on public.market_pulse_latest;
create policy "market pulse select own"
on public.market_pulse_latest
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "market pulse insert own" on public.market_pulse_latest;
create policy "market pulse insert own"
on public.market_pulse_latest
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "market pulse update own" on public.market_pulse_latest;
create policy "market pulse update own"
on public.market_pulse_latest
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "market pulse delete own" on public.market_pulse_latest;
create policy "market pulse delete own"
on public.market_pulse_latest
for delete
to authenticated
using (user_id = auth.uid());

grant select, insert, update, delete on public.market_pulse_latest to authenticated;
