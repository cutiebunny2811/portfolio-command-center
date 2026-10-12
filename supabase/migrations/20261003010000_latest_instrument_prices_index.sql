-- Keep the per-member latest-price lookup bounded as price history grows.

begin;

create index if not exists instrument_prices_user_instrument_latest_idx
  on public.instrument_prices (user_id, instrument_id, fetched_at desc, id desc);

commit;
