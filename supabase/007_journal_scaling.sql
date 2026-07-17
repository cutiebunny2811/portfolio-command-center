-- Server-paged journal view and filtered analytics.
-- Run after 005_journal_api.sql.

begin;

create index if not exists journal_entries_active_portfolio_date_v2_idx
  on public.journal_entries (user_id, portfolio_id, occurred_on desc, created_at desc)
  where is_void = false;

create index if not exists journal_entries_active_outcome_date_idx
  on public.journal_entries (user_id, outcome, occurred_on desc, created_at desc)
  where is_void = false;

create or replace function public.api_get_journal_view(
  p_page integer default 1,
  p_page_size integer default 50,
  p_portfolio_id uuid default null,
  p_date_from date default null,
  p_date_to date default null,
  p_outcome public.trade_outcome default null,
  p_search text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 50), 1), 100);
  v_offset integer;
  v_search text := nullif(trim(coalesce(p_search, '')), '');
  v_result jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_date_from is not null and p_date_to is not null and p_date_from > p_date_to then
    raise exception 'Start date must be on or before end date';
  end if;
  if length(coalesce(v_search, '')) > 100 then raise exception 'Search is too long'; end if;

  if p_portfolio_id is not null and not exists (
    select 1 from public.portfolios p
    where p.id = p_portfolio_id and p.user_id = v_user
  ) then raise exception 'Portfolio not found'; end if;

  v_offset := (v_page - 1) * v_page_size;

  with filtered as materialized (
    select
      j.id,
      j.portfolio_id,
      j.campaign_id,
      j.instrument_id,
      j.source,
      j.outcome,
      j.occurred_on,
      j.manual_pnl,
      j.strategy_label,
      j.notes,
      j.created_at,
      j.updated_at,
      i.symbol
    from public.journal_entries j
    left join public.instruments i
      on i.id = j.instrument_id and i.user_id = v_user
    where j.user_id = v_user
      and j.is_void = false
      and (p_portfolio_id is null or j.portfolio_id = p_portfolio_id)
      and (p_date_from is null or j.occurred_on >= p_date_from)
      and (p_date_to is null or j.occurred_on <= p_date_to)
      and (p_outcome is null or j.outcome = p_outcome)
      and (
        v_search is null
        or i.symbol ilike '%' || v_search || '%'
        or j.strategy_label ilike '%' || v_search || '%'
        or j.notes ilike '%' || v_search || '%'
      )
  ),
  page_rows as (
    select *
    from filtered
    order by occurred_on desc, created_at desc, id desc
    limit v_page_size offset v_offset
  ),
  summary as (
    select
      count(*)::integer as total_count,
      count(manual_pnl)::integer as performance_count,
      coalesce(sum(manual_pnl), 0) as net_pnl,
      count(*) filter (where manual_pnl > 0)::integer as win_count,
      count(*) filter (where manual_pnl < 0)::integer as loss_count,
      count(*) filter (where manual_pnl = 0)::integer as breakeven_count,
      coalesce(sum(manual_pnl) filter (where manual_pnl > 0), 0) as gross_win,
      coalesce(abs(sum(manual_pnl) filter (where manual_pnl < 0)), 0) as gross_loss,
      coalesce(avg(manual_pnl) filter (where manual_pnl > 0), 0) as avg_win,
      coalesce(avg(manual_pnl) filter (where manual_pnl < 0), 0) as avg_loss
    from filtered
  ),
  daily_data as (
    select occurred_on, coalesce(sum(manual_pnl), 0) as pnl
    from filtered
    where manual_pnl is not null
    group by occurred_on
  ),
  monthly_data as (
    select date_trunc('month', occurred_on)::date as month_start,
      coalesce(sum(manual_pnl), 0) as pnl,
      count(manual_pnl)::integer as trade_count
    from filtered
    where manual_pnl is not null
    group by date_trunc('month', occurred_on)::date
  )
  select jsonb_build_object(
    'page', v_page,
    'page_size', v_page_size,
    'total_count', s.total_count,
    'summary', jsonb_build_object(
      'performance_count', s.performance_count,
      'net_pnl', s.net_pnl,
      'win_count', s.win_count,
      'loss_count', s.loss_count,
      'breakeven_count', s.breakeven_count,
      'gross_win', s.gross_win,
      'gross_loss', s.gross_loss,
      'avg_win', s.avg_win,
      'avg_loss', s.avg_loss
    ),
    'entries', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.occurred_on desc, p.created_at desc, p.id desc)
      from page_rows p
    ), '[]'::jsonb),
    'daily', coalesce((
      select jsonb_agg(
        jsonb_build_object('date', d.occurred_on, 'pnl', d.pnl)
        order by d.occurred_on
      )
      from daily_data d
    ), '[]'::jsonb),
    'monthly', coalesce((
      select jsonb_agg(
        jsonb_build_object('month', m.month_start, 'pnl', m.pnl, 'count', m.trade_count)
        order by m.month_start
      )
      from monthly_data m
    ), '[]'::jsonb)
  ) into v_result
  from summary s;

  return v_result;
end;
$$;

revoke all on function public.api_get_journal_view(integer, integer, uuid, date, date, public.trade_outcome, text)
  from public, anon;
grant execute on function public.api_get_journal_view(integer, integer, uuid, date, date, public.trade_outcome, text)
  to authenticated;

commit;
