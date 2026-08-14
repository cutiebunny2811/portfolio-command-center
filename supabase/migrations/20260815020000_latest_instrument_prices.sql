-- Return one current observation per instrument so high-volume stock history
-- cannot push slower EOD option prices out of the client result window.

begin;

create or replace function public.api_get_latest_instrument_prices()
returns setof public.instrument_prices
language sql
stable
security definer
set search_path = ''
as $$
  select distinct on (price.instrument_id)
    price.*
  from public.instrument_prices price
  where price.user_id = auth.uid()
  order by price.instrument_id, price.fetched_at desc, price.id desc;
$$;

revoke all on function public.api_get_latest_instrument_prices() from public, anon;
grant execute on function public.api_get_latest_instrument_prices() to authenticated;

commit;
