-- Webull identity metadata used for lightweight company marks in the UI.
-- The price snapshot already returns instrument_id, so no extra quote request
-- is required to discover the corresponding Webull CDN icon.

begin;

alter table public.instruments
  add column if not exists webull_instrument_id text,
  add column if not exists logo_url text,
  add column if not exists logo_fetched_at timestamptz;

create index if not exists instruments_user_webull_id_idx
  on public.instruments (user_id, webull_instrument_id)
  where webull_instrument_id is not null;

create or replace function public.api_set_instrument_logos(p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_updated integer := 0;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Logo items must be a JSON array';
  end if;

  with normalized as (
    select distinct on (item.instrument_id)
      item.instrument_id,
      trim(item.webull_instrument_id) as webull_instrument_id,
      trim(item.logo_url) as logo_url
    from jsonb_to_recordset(p_items) as item(
      instrument_id uuid,
      webull_instrument_id text,
      logo_url text
    )
    where item.instrument_id is not null
      and trim(item.webull_instrument_id) ~ '^[0-9]+$'
      and trim(item.logo_url) like 'https://quotes-static.webullfintech.com/ticker-icon/%.png'
    order by item.instrument_id
  )
  update public.instruments as instrument
  set webull_instrument_id = normalized.webull_instrument_id,
      logo_url = normalized.logo_url,
      logo_fetched_at = now()
  from normalized
  where instrument.id = normalized.instrument_id
    and instrument.user_id = v_user
    and (
      instrument.webull_instrument_id is distinct from normalized.webull_instrument_id
      or instrument.logo_url is distinct from normalized.logo_url
    );

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

revoke all on function public.api_set_instrument_logos(jsonb) from public, anon;
grant execute on function public.api_set_instrument_logos(jsonb) to authenticated;

commit;
