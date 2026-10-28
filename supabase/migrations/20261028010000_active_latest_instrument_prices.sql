-- Keep price reads proportional to the member's active instruments instead of
-- sorting their complete historical price ledger on every app open.

begin;

create index if not exists instrument_prices_user_instrument_latest_idx
  on public.instrument_prices (user_id, instrument_id, fetched_at desc, id desc);

create or replace function public.api_get_latest_instrument_prices()
returns setof public.instrument_prices
language sql
stable
security definer
set search_path = ''
as $$
  with active_instruments as (
    select position.instrument_id
    from public.position_balances position
    where position.user_id = auth.uid()
      and position.quantity > 0
    union
    select target.instrument_id
    from public.allocation_targets target
    join public.portfolios portfolio on portfolio.id = target.portfolio_id
    where portfolio.user_id = auth.uid()
      and target.is_active = true
    union
    select watch.instrument_id
    from public.watchlist_items watch
    where watch.user_id = auth.uid()
  )
  select latest.*
  from active_instruments active
  cross join lateral (
    select price.*
    from public.instrument_prices price
    where price.user_id = auth.uid()
      and price.instrument_id = active.instrument_id
    order by price.fetched_at desc, price.id desc
    limit 1
  ) latest
  order by latest.instrument_id;
$$;

revoke all on function public.api_get_latest_instrument_prices() from public, anon;
grant execute on function public.api_get_latest_instrument_prices() to authenticated;

commit;
