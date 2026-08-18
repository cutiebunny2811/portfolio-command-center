begin;

create table if not exists public.market_chart_cache (
  instrument_id uuid primary key references public.instruments(id) on delete cascade,
  symbol text not null,
  asset_type text not null check (asset_type in ('stock', 'etf')),
  timespan text not null default 'D' check (timespan = 'D'),
  bars jsonb not null default '[]'::jsonb check (jsonb_typeof(bars) = 'array'),
  source text not null default 'webull',
  fetched_at timestamptz not null default '1970-01-01 00:00:00+00',
  refresh_started_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

comment on table public.market_chart_cache is
  'Shared, cache-first daily OHLC bars for PCC stock and ETF charts. No member financial data is stored here.';

alter table public.market_chart_cache enable row level security;

drop policy if exists market_chart_cache_authenticated_read on public.market_chart_cache;
create policy market_chart_cache_authenticated_read
  on public.market_chart_cache
  for select
  to authenticated
  using (true);

create index if not exists market_chart_cache_fetched_at_idx
  on public.market_chart_cache (fetched_at);

create or replace function public.api_claim_market_chart_refresh(
  p_instrument_id uuid,
  p_symbol text,
  p_asset_type text,
  p_lease_seconds integer default 90
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  if p_asset_type not in ('stock', 'etf') then
    raise exception 'Unsupported chart asset type';
  end if;

  insert into public.market_chart_cache (
    instrument_id, symbol, asset_type, refresh_started_at
  ) values (
    p_instrument_id, upper(btrim(p_symbol)), p_asset_type, now()
  )
  on conflict (instrument_id) do update
    set refresh_started_at = now(),
        symbol = excluded.symbol,
        asset_type = excluded.asset_type,
        updated_at = now()
  where public.market_chart_cache.refresh_started_at is null
     or public.market_chart_cache.refresh_started_at < now() - make_interval(secs => greatest(p_lease_seconds, 30));

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function public.api_claim_market_chart_refresh(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.api_claim_market_chart_refresh(uuid, text, text, integer) to service_role;

commit;
