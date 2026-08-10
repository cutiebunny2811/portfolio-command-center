-- Portfolio Command Center: curated United States market-moving macro events.
-- Official schedules and FRED observations are cached globally. Authenticated
-- users read the calendar only through the narrow RPC below.

begin;
create table if not exists public.macro_events (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  external_id text not null,
  series_id text,
  event_group text not null
    check (event_group in ('policy', 'inflation', 'labor', 'growth', 'consumption', 'activity')),
  signal_family text not null
    check (signal_family in ('policy', 'inflation', 'labor_strength', 'labor_inverse', 'growth')),
  event_name text not null,
  category text,
  reference_period text,
  scheduled_at timestamptz not null,
  actual text,
  forecast text,
  previous text,
  revised text,
  importance smallint not null default 3 check (importance between 1 and 3),
  currency text not null default 'USD',
  unit text,
  source_name text not null,
  source_url text not null,
  is_active boolean not null default true,
  raw_payload jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, external_id)
);
create index if not exists macro_events_active_schedule_idx
  on public.macro_events (scheduled_at, event_group)
  where is_active = true;
create table if not exists public.macro_sync_state (
  source text primary key,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  window_from date,
  window_to date,
  fetched_count integer not null default 0,
  matched_count integer not null default 0,
  last_error text,
  updated_at timestamptz not null default now()
);
alter table public.macro_events enable row level security;
alter table public.macro_sync_state enable row level security;
revoke all on public.macro_events from anon, authenticated;
revoke all on public.macro_sync_state from anon, authenticated;
create or replace function public.api_get_macro_calendar(
  p_from date default (current_date - 2),
  p_to date default (current_date + 120)
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_from date := coalesce(p_from, current_date - 2);
  v_to date := coalesce(p_to, current_date + 120);
  v_entries jsonb;
  v_next_event jsonb;
  v_next_fomc jsonb;
  v_last_synced timestamptz;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if v_to < v_from or v_to > v_from + 366 then
    raise exception 'Macro calendar window must be between 1 and 367 days';
  end if;

  select coalesce(jsonb_agg(to_jsonb(event_row) order by event_row.scheduled_at, event_row.event_name), '[]'::jsonb)
  into v_entries
  from (
    select
      event.id,
      event.external_id,
      event.series_id,
      event.event_group,
      event.signal_family,
      event.event_name,
      event.category,
      event.reference_period,
      event.scheduled_at,
      event.actual,
      event.forecast,
      event.previous,
      event.revised,
      event.importance,
      event.currency,
      event.unit,
      event.source_name,
      event.source_url,
      event.fetched_at
    from public.macro_events event
    where event.is_active = true
      and event.scheduled_at >= v_from::timestamptz
      and event.scheduled_at < (v_to + 1)::timestamptz
  ) event_row;

  select to_jsonb(next_row)
  into v_next_event
  from (
    select id, external_id, series_id, event_group, signal_family, event_name,
      category, reference_period, scheduled_at, actual, forecast, previous,
      revised, importance, currency, unit, source_name, source_url, fetched_at
    from public.macro_events
    where is_active = true and scheduled_at >= now()
    order by scheduled_at, event_name
    limit 1
  ) next_row;

  select to_jsonb(fomc_row)
  into v_next_fomc
  from (
    select id, external_id, series_id, event_group, signal_family, event_name,
      category, reference_period, scheduled_at, actual, forecast, previous,
      revised, importance, currency, unit, source_name, source_url, fetched_at
    from public.macro_events
    where is_active = true
      and event_group = 'policy'
      and scheduled_at >= now()
      and event_name ~* '^FOMC Rate Decision'
    order by scheduled_at
    limit 1
  ) fomc_row;

  select state.last_success_at
  into v_last_synced
  from public.macro_sync_state state
  where state.source = 'fred_official';

  return jsonb_build_object(
    'entries', v_entries,
    'next_event', v_next_event,
    'next_fomc', v_next_fomc,
    'last_synced_at', v_last_synced,
    'window_from', v_from,
    'window_to', v_to
  );
end;
$$;
revoke all on function public.api_get_macro_calendar(date, date) from public, anon;
grant execute on function public.api_get_macro_calendar(date, date) to authenticated;
commit;
