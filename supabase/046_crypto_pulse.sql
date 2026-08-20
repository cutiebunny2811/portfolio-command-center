begin;

create table if not exists public.crypto_watchlist_items (
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null,
  display_symbol text not null,
  display_name text not null,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  primary key (user_id, symbol),
  constraint crypto_watchlist_items_symbol_check
    check (symbol in ('BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'LINKUSDT', 'AVAXUSDT'))
);

create table if not exists public.crypto_market_snapshots (
  symbol text primary key,
  display_symbol text not null,
  display_name text not null,
  price numeric,
  price_change numeric,
  price_change_percent_24h numeric,
  high_24h numeric,
  low_24h numeric,
  quote_volume_24h numeric,
  mark_price numeric,
  index_price numeric,
  funding_rate numeric,
  next_funding_time timestamptz,
  open_interest numeric,
  source text not null default 'binance_public',
  spot_fetched_at timestamptz,
  derivatives_fetched_at timestamptz,
  fetched_at timestamptz not null default '1970-01-01 00:00:00+00',
  last_error text,
  updated_at timestamptz not null default now()
);

comment on table public.crypto_watchlist_items is
  'Per-member curated crypto research list. It is separate from portfolio instruments and equity research workflows.';

comment on table public.crypto_market_snapshots is
  'Shared cache of public Binance spot and USD-M futures market data. No exchange credentials or financial ledger data are stored here.';

alter table public.crypto_watchlist_items enable row level security;
alter table public.crypto_market_snapshots enable row level security;

drop policy if exists crypto_watchlist_items_select_own on public.crypto_watchlist_items;
create policy crypto_watchlist_items_select_own
  on public.crypto_watchlist_items for select to authenticated
  using (user_id = auth.uid());

drop policy if exists crypto_market_snapshots_authenticated_read on public.crypto_market_snapshots;
create policy crypto_market_snapshots_authenticated_read
  on public.crypto_market_snapshots for select to authenticated
  using (true);

grant select on public.crypto_watchlist_items to authenticated;
grant select on public.crypto_market_snapshots to authenticated;

create or replace function public.api_add_crypto_watchlist_item(p_symbol text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_symbol text := upper(btrim(coalesce(p_symbol, '')));
  v_display_symbol text;
  v_display_name text;
  v_sort_order integer;
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  select item.display_symbol, item.display_name, item.sort_order
    into v_display_symbol, v_display_name, v_sort_order
  from (values
    ('BTCUSDT', 'BTC', 'Bitcoin', 10),
    ('ETHUSDT', 'ETH', 'Ethereum', 20),
    ('SOLUSDT', 'SOL', 'Solana', 30),
    ('BNBUSDT', 'BNB', 'BNB', 40),
    ('XRPUSDT', 'XRP', 'XRP', 50),
    ('LINKUSDT', 'LINK', 'Chainlink', 60),
    ('AVAXUSDT', 'AVAX', 'Avalanche', 70)
  ) as item(symbol, display_symbol, display_name, sort_order)
  where item.symbol = v_symbol;

  if v_display_symbol is null then raise exception 'Unsupported curated crypto symbol'; end if;

  insert into public.crypto_watchlist_items (user_id, symbol, display_symbol, display_name, sort_order)
  values (v_user, v_symbol, v_display_symbol, v_display_name, v_sort_order)
  on conflict (user_id, symbol) do nothing;
end;
$$;

create or replace function public.api_remove_crypto_watchlist_item(p_symbol text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  delete from public.crypto_watchlist_items
  where user_id = auth.uid()
    and symbol = upper(btrim(coalesce(p_symbol, '')));
end;
$$;

revoke all on function public.api_add_crypto_watchlist_item(text) from public, anon;
revoke all on function public.api_remove_crypto_watchlist_item(text) from public, anon;
grant execute on function public.api_add_crypto_watchlist_item(text) to authenticated;
grant execute on function public.api_remove_crypto_watchlist_item(text) to authenticated;

insert into public.crypto_watchlist_items (user_id, symbol, display_symbol, display_name, sort_order)
select users.id, defaults.symbol, defaults.display_symbol, defaults.display_name, defaults.sort_order
from auth.users users
cross join (values
  ('BTCUSDT', 'BTC', 'Bitcoin', 10),
  ('ETHUSDT', 'ETH', 'Ethereum', 20),
  ('SOLUSDT', 'SOL', 'Solana', 30)
) as defaults(symbol, display_symbol, display_name, sort_order)
on conflict (user_id, symbol) do nothing;

commit;
