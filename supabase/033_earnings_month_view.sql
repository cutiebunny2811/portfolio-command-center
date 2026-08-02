-- Portfolio Command Center: return the complete current-month earnings board.
-- The collector stores the canonical Alpha Vantage + Finnhub merge in the
-- existing `finnhub` compatibility bucket, so no frontend or RLS access widens.

begin;

create or replace function public.api_get_earnings_calendar()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_entries jsonb;
  v_tracked_count integer;
  v_last_synced timestamptz;
  v_month_from date := date_trunc('month', current_date)::date;
  v_month_to date := (date_trunc('month', current_date) + interval '1 month - 1 day')::date;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select count(distinct upper(trim(instrument.symbol)))
  into v_tracked_count
  from public.watchlist_items watch
  join public.instruments instrument on instrument.id = watch.instrument_id
  where watch.user_id = v_user_id
    and lower(instrument.asset_type::text) in ('stock', 'etf');

  select state.last_success_at
  into v_last_synced
  from public.earnings_sync_state state
  where state.source = 'finnhub';

  select coalesce(jsonb_agg(to_jsonb(scoped) order by scoped.earnings_date, scoped.report_sort, scoped.symbol), '[]'::jsonb)
  into v_entries
  from (
    select distinct on (event.symbol, event.earnings_date)
      event.id,
      event.symbol,
      instrument.id as instrument_id,
      instrument.display_name,
      instrument.asset_type,
      instrument.logo_url,
      event.earnings_date,
      event.report_hour,
      case event.report_hour when 'bmo' then 1 when 'dmh' then 2 when 'amc' then 3 else 4 end as report_sort,
      event.fiscal_quarter,
      event.fiscal_year,
      event.eps_estimate,
      event.eps_actual,
      event.revenue_estimate,
      event.revenue_actual,
      event.fetched_at
    from public.watchlist_items watch
    join public.instruments instrument on instrument.id = watch.instrument_id
    join public.earnings_events event on event.symbol = upper(trim(instrument.symbol))
    where watch.user_id = v_user_id
      and lower(instrument.asset_type::text) in ('stock', 'etf')
      and event.source = 'finnhub'
      and event.is_active = true
      and event.earnings_date between v_month_from and v_month_to
    order by event.symbol, event.earnings_date, event.fetched_at desc
  ) scoped;

  return jsonb_build_object(
    'entries', v_entries,
    'tracked_count', coalesce(v_tracked_count, 0),
    'last_synced_at', v_last_synced,
    'window_from', v_month_from,
    'window_to', v_month_to
  );
end;
$$;

revoke all on function public.api_get_earnings_calendar() from public, anon;
grant execute on function public.api_get_earnings_calendar() to authenticated;

commit;
