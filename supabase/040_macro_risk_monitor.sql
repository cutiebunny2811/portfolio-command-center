-- Portfolio Command Center: shared US economic risk and market sentiment snapshots.
-- The collector owns writes; authenticated members read only through the narrow RPC.

begin;

create table if not exists public.macro_risk_snapshots (
  snapshot_date date primary key,
  risk_score smallint not null check (risk_score between 0 and 100),
  risk_label text not null,
  fear_greed_score smallint not null check (fear_greed_score between 0 and 100),
  fear_greed_label text not null,
  risk_components jsonb not null default '[]'::jsonb check (jsonb_typeof(risk_components) = 'array'),
  fear_greed_components jsonb not null default '[]'::jsonb check (jsonb_typeof(fear_greed_components) = 'array'),
  source_dates jsonb not null default '{}'::jsonb check (jsonb_typeof(source_dates) = 'object'),
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.macro_risk_snapshots enable row level security;
revoke all on public.macro_risk_snapshots from anon, authenticated;

create or replace function public.api_get_macro_risk_monitor()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_latest_date date;
  v_latest jsonb;
  v_week jsonb;
  v_month jsonb;
  v_year jsonb;
  v_last_synced timestamptz;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select snapshot.snapshot_date, to_jsonb(snapshot)
  into v_latest_date, v_latest
  from public.macro_risk_snapshots snapshot
  order by snapshot.snapshot_date desc
  limit 1;

  if v_latest_date is not null then
    select to_jsonb(snapshot) into v_week
    from public.macro_risk_snapshots snapshot
    where snapshot.snapshot_date <= v_latest_date - 7
    order by snapshot.snapshot_date desc limit 1;

    select to_jsonb(snapshot) into v_month
    from public.macro_risk_snapshots snapshot
    where snapshot.snapshot_date <= v_latest_date - 30
    order by snapshot.snapshot_date desc limit 1;

    select to_jsonb(snapshot) into v_year
    from public.macro_risk_snapshots snapshot
    where snapshot.snapshot_date <= v_latest_date - 365
    order by snapshot.snapshot_date desc limit 1;
  end if;

  select state.last_success_at into v_last_synced
  from public.macro_sync_state state
  where state.source = 'fred_official';

  return jsonb_build_object(
    'latest', v_latest,
    'history', jsonb_build_object(
      'now', v_latest,
      'week', v_week,
      'month', v_month,
      'year', v_year
    ),
    'last_synced_at', v_last_synced,
    'methodology', 'PCC transparent composite from FRED observations',
    'sources', jsonb_build_array('FRED')
  );
end;
$$;

revoke all on function public.api_get_macro_risk_monitor() from public, anon;
grant execute on function public.api_get_macro_risk_monitor() to authenticated;

commit;
