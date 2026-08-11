-- Keep the shared Form 4 feed fast for large starter watchlists.

begin;

create index if not exists instruments_symbol_normalized_idx
  on public.instruments ((upper(btrim(symbol))));

create index if not exists smart_money_events_instrument_filed_global_idx
  on public.smart_money_events (instrument_id, filed_at desc, created_at desc);

create or replace function public.api_get_smart_money_feed(p_limit integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 1000);
  v_entries jsonb;
begin
  if v_user is null then
    raise exception 'Authentication required';
  end if;

  with watched as materialized (
    select distinct on (upper(btrim(instrument.symbol)))
      watch.instrument_id,
      upper(btrim(instrument.symbol)) as symbol
    from public.watchlist_items watch
    join public.instruments instrument on instrument.id = watch.instrument_id
    where watch.user_id = v_user
      and lower(instrument.asset_type::text) in ('stock', 'etf')
    order by upper(btrim(instrument.symbol)), watch.created_at
  ),
  source_instruments as materialized (
    select watched.instrument_id, watched.symbol, source_instrument.id as source_instrument_id
    from watched
    join public.instruments source_instrument
      on upper(btrim(source_instrument.symbol)) = watched.symbol
  ),
  canonical as (
    select distinct on (source_instruments.symbol, event.accession_number, event.transaction_key)
      event.id,
      v_user as user_id,
      source_instruments.instrument_id,
      event.source,
      event.accession_number,
      event.transaction_key,
      event.form_type,
      event.filer_cik,
      event.filer_name,
      event.filer_title,
      event.relationship,
      event.transaction_code,
      event.side,
      event.security_title,
      event.transaction_date,
      event.filed_at,
      event.shares,
      event.price,
      event.transaction_value,
      event.post_transaction_shares,
      event.ownership_nature,
      event.is_derivative,
      event.sec_url,
      event.created_at
    from source_instruments
    join public.smart_money_events event
      on event.instrument_id = source_instruments.source_instrument_id
     and event.filed_at >= now() - interval '90 days'
    order by source_instruments.symbol, event.accession_number, event.transaction_key, event.created_at desc
  ),
  paged as (
    select *
    from canonical
    order by filed_at desc, created_at desc
    limit v_limit
  )
  select coalesce(jsonb_agg(to_jsonb(paged) order by filed_at desc, created_at desc), '[]'::jsonb)
  into v_entries
  from paged;

  return v_entries;
end;
$$;

revoke all on function public.api_get_smart_money_feed(integer) from public, anon;
grant execute on function public.api_get_smart_money_feed(integer) to authenticated;

commit;
