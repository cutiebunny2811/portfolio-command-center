begin;

drop function if exists public.api_claim_market_chart_refresh(uuid, text, text, integer);

alter table public.market_chart_cache
  drop constraint if exists market_chart_cache_pkey;

alter table public.market_chart_cache
  drop constraint if exists market_chart_cache_timespan_check;

alter table public.market_chart_cache
  add constraint market_chart_cache_timespan_check
  check (timespan in ('D', 'M60', 'M240'));

alter table public.market_chart_cache
  add primary key (instrument_id, timespan);

create or replace function public.api_claim_market_chart_refresh(
  p_instrument_id uuid,
  p_symbol text,
  p_asset_type text,
  p_timespan text,
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

  if p_timespan not in ('D', 'M60', 'M240') then
    raise exception 'Unsupported chart timespan';
  end if;

  insert into public.market_chart_cache (
    instrument_id, symbol, asset_type, timespan, refresh_started_at
  ) values (
    p_instrument_id, upper(btrim(p_symbol)), p_asset_type, p_timespan, now()
  )
  on conflict (instrument_id, timespan) do update
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

revoke all on function public.api_claim_market_chart_refresh(uuid, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.api_claim_market_chart_refresh(uuid, text, text, text, integer) to service_role;

commit;
