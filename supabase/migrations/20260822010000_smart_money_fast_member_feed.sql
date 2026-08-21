-- Prefer the member's indexed Form 4 rows. The shared corpus remains a bounded
-- fallback for a newly onboarded member whose first collector run has not run.

begin;

create index if not exists smart_money_events_user_filed_created_idx
  on public.smart_money_events (user_id, filed_at desc, created_at desc)
  include (instrument_id);

create index if not exists smart_money_events_filed_created_global_idx
  on public.smart_money_events (filed_at desc, created_at desc, instrument_id);

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

  -- The collector writes one row per member. This path uses the user/date index
  -- and only checks that the instrument still belongs to the current watchlist.
  with paged as (
    select
      event.id,
      event.user_id,
      event.instrument_id,
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
    from public.smart_money_events event
    where event.user_id = v_user
      and event.filed_at >= now() - interval '90 days'
      and exists (
        select 1
        from public.watchlist_items watch
        where watch.user_id = v_user
          and watch.instrument_id = event.instrument_id
      )
    order by event.filed_at desc, event.created_at desc
    limit v_limit
  )
  select coalesce(
    jsonb_agg(to_jsonb(paged) order by filed_at desc, created_at desc),
    '[]'::jsonb
  )
  into v_entries
  from paged;

  if jsonb_array_length(v_entries) > 0 then
    return v_entries;
  end if;

  -- A new member can read shared public filings before their collector backfill.
  -- Bound the cross-member candidate set before DISTINCT so this fallback cannot
  -- sort the complete 90-day corpus and trip the database statement timeout.
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
  candidates as materialized (
    select
      watched.instrument_id as member_instrument_id,
      watched.symbol,
      event.*
    from public.smart_money_events event
    join public.instruments source_instrument on source_instrument.id = event.instrument_id
    join watched on watched.symbol = upper(btrim(source_instrument.symbol))
    where event.filed_at >= now() - interval '90 days'
    order by event.filed_at desc, event.created_at desc
    limit greatest(v_limit * 8, 1000)
  ),
  canonical as (
    select distinct on (candidate.symbol, candidate.accession_number, candidate.transaction_key)
      candidate.id,
      v_user as user_id,
      candidate.member_instrument_id as instrument_id,
      candidate.source,
      candidate.accession_number,
      candidate.transaction_key,
      candidate.form_type,
      candidate.filer_cik,
      candidate.filer_name,
      candidate.filer_title,
      candidate.relationship,
      candidate.transaction_code,
      candidate.side,
      candidate.security_title,
      candidate.transaction_date,
      candidate.filed_at,
      candidate.shares,
      candidate.price,
      candidate.transaction_value,
      candidate.post_transaction_shares,
      candidate.ownership_nature,
      candidate.is_derivative,
      candidate.sec_url,
      candidate.created_at
    from candidates candidate
    order by candidate.symbol, candidate.accession_number, candidate.transaction_key, candidate.created_at desc
  ),
  paged as (
    select *
    from canonical
    order by filed_at desc, created_at desc
    limit v_limit
  )
  select coalesce(
    jsonb_agg(to_jsonb(paged) order by filed_at desc, created_at desc),
    '[]'::jsonb
  )
  into v_entries
  from paged;

  return v_entries;
end;
$$;

revoke all on function public.api_get_smart_money_feed(integer) from public, anon;
grant execute on function public.api_get_smart_money_feed(integer) to authenticated;

commit;
