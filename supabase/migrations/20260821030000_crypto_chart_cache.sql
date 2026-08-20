begin;

create table if not exists public.crypto_chart_cache (
  symbol text not null,
  interval text not null,
  bars jsonb not null default '[]'::jsonb check (jsonb_typeof(bars) = 'array'),
  source text not null default 'binance_public',
  fetched_at timestamptz not null default '1970-01-01 00:00:00+00',
  refresh_started_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (symbol, interval),
  constraint crypto_chart_cache_symbol_check check (symbol ~ '^[A-Z0-9]{5,20}$'),
  constraint crypto_chart_cache_interval_check check (interval in ('15m', '1h', '4h', '1d'))
);

comment on table public.crypto_chart_cache is
  'Shared Binance public OHLCV cache for the PCC Crypto Pulse. Contains no member financial data.';

alter table public.crypto_chart_cache enable row level security;

drop policy if exists crypto_chart_cache_authenticated_read on public.crypto_chart_cache;
create policy crypto_chart_cache_authenticated_read
  on public.crypto_chart_cache
  for select
  to authenticated
  using (true);

grant select on public.crypto_chart_cache to authenticated;

create index if not exists crypto_chart_cache_fetched_at_idx
  on public.crypto_chart_cache (fetched_at);

create or replace function public.api_claim_crypto_chart_refresh(
  p_symbol text,
  p_interval text,
  p_lease_seconds integer default 45
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  if upper(btrim(p_symbol)) !~ '^[A-Z0-9]{5,20}$' then
    raise exception 'Unsupported crypto symbol';
  end if;

  if p_interval not in ('15m', '1h', '4h', '1d') then
    raise exception 'Unsupported crypto interval';
  end if;

  insert into public.crypto_chart_cache (symbol, interval, refresh_started_at)
  values (upper(btrim(p_symbol)), p_interval, now())
  on conflict (symbol, interval) do update
    set refresh_started_at = now(),
        updated_at = now()
  where public.crypto_chart_cache.refresh_started_at is null
     or public.crypto_chart_cache.refresh_started_at < now() - make_interval(secs => greatest(p_lease_seconds, 20));

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function public.api_claim_crypto_chart_refresh(text, text, integer) from public, anon, authenticated;
grant execute on function public.api_claim_crypto_chart_refresh(text, text, integer) to service_role;

commit;
