-- Multi-user beta follow-up: turn onboarding capital into real cash and let
-- every member read the shared public market-data corpus through their own
-- watchlist. Portfolio records and per-user reading state remain private.

begin;

create or replace function public.bootstrap_member_workspace(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_portfolio_id uuid;
  v_fixed_budget numeric;
  v_cash_seeded integer := 0;
  v_news_seeded integer := 0;
  v_source_matches_seeded integer := 0;
begin
  if p_user is null then
    raise exception 'Member user ID is required';
  end if;

  select portfolio.id, portfolio.fixed_budget
  into v_portfolio_id, v_fixed_budget
  from public.portfolios portfolio
  where portfolio.user_id = p_user
    and portfolio.is_active = true
  order by portfolio.sort_order, portfolio.created_at
  limit 1;

  if v_portfolio_id is not null
     and coalesce(v_fixed_budget, 0) > 0
     and not exists (
       select 1 from public.cash_movements movement
       where movement.portfolio_id = v_portfolio_id
     )
     and not exists (
       select 1 from public.executions execution
       where execution.portfolio_id = v_portfolio_id
     ) then
    insert into public.cash_movements (
      user_id, portfolio_id, movement_type, amount, occurred_at,
      idempotency_key, notes, metadata
    ) values (
      p_user, v_portfolio_id, 'deposit', v_fixed_budget, now(),
      'member-onboarding:' || v_portfolio_id::text || ':starting-capital',
      'Starting capital recorded during member onboarding',
      jsonb_build_object('source', 'member_onboarding', 'fixed_budget', v_fixed_budget)
    )
    on conflict do nothing;
    get diagnostics v_cash_seeded = row_count;
  end if;

  -- research_articles is the canonical public corpus. Matches are user-scoped
  -- so each member still gets independent read, saved and hidden state.
  insert into public.research_article_matches (
    user_id, article_id, instrument_id, is_watchlist, is_portfolio
  )
  select
    p_user,
    article.id,
    instrument.id,
    true,
    exists (
      select 1
      from public.position_balances position
      join public.portfolios portfolio on portfolio.id = position.portfolio_id
      where portfolio.user_id = p_user
        and position.instrument_id = instrument.id
        and position.quantity > 0
    )
  from public.watchlist_items watch
  join public.instruments instrument on instrument.id = watch.instrument_id
  join public.research_articles article on exists (
    select 1
    from unnest(article.tickers) ticker
    where upper(btrim(ticker)) = upper(btrim(instrument.symbol))
  )
  where watch.user_id = p_user
    and article.published_at >= now() - interval '90 days'
  on conflict (user_id, article_id, instrument_id) do update
  set is_watchlist = excluded.is_watchlist,
      is_portfolio = excluded.is_portfolio
  where public.research_article_matches.is_watchlist is distinct from excluded.is_watchlist
     or public.research_article_matches.is_portfolio is distinct from excluded.is_portfolio;
  get diagnostics v_news_seeded = row_count;

  -- Selected source subscriptions are copied as defaults, then remain fully
  -- independent so a member can add or remove sources without affecting peers.
  insert into public.research_source_subscriptions (
    user_id, source, source_key, display_name, external_user_id,
    last_resource_id, is_active, updated_at
  )
  select distinct on (subscription.source, subscription.source_key)
    p_user,
    subscription.source,
    subscription.source_key,
    subscription.display_name,
    subscription.external_user_id,
    subscription.last_resource_id,
    true,
    now()
  from public.research_source_subscriptions subscription
  where subscription.user_id <> p_user
    and subscription.is_active = true
  order by subscription.source, subscription.source_key, subscription.updated_at desc
  on conflict (user_id, source, source_key) do nothing;

  insert into public.research_source_article_matches (
    user_id, article_id, source, source_key
  )
  select distinct on (source_match.article_id, source_match.source, source_match.source_key)
    p_user,
    source_match.article_id,
    source_match.source,
    source_match.source_key
  from public.research_source_article_matches source_match
  join public.research_source_subscriptions subscription
    on subscription.user_id = p_user
   and subscription.source = source_match.source
   and subscription.source_key = source_match.source_key
   and subscription.is_active = true
  join public.research_articles article on article.id = source_match.article_id
  where source_match.user_id <> p_user
    and article.published_at >= now() - interval '90 days'
  order by source_match.article_id, source_match.source, source_match.source_key, source_match.created_at desc
  on conflict (user_id, article_id, source, source_key) do nothing;
  get diagnostics v_source_matches_seeded = row_count;

  return jsonb_build_object(
    'cash_seeded', v_cash_seeded,
    'news_matches_seeded', v_news_seeded,
    'source_matches_seeded', v_source_matches_seeded
  );
end;
$$;

revoke all on function public.bootstrap_member_workspace(uuid) from public, anon, authenticated;

create or replace function public.trigger_bootstrap_member_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.bootstrap_member_workspace(new.user_id);
  return new;
end;
$$;

revoke all on function public.trigger_bootstrap_member_workspace() from public, anon, authenticated;

drop trigger if exists pcc_members_bootstrap_workspace on public.pcc_members;
create trigger pcc_members_bootstrap_workspace
after update of onboarding_completed_at on public.pcc_members
for each row
when (old.onboarding_completed_at is null and new.onboarding_completed_at is not null)
execute function public.trigger_bootstrap_member_workspace();

-- Form 4 filings are public facts. Store them once, then remap the canonical
-- event to the requesting member's instrument ID so existing UI filters and RLS
-- semantics continue to work without duplicating thousands of rows per member.
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

  with watched as (
    select watch.instrument_id, upper(btrim(instrument.symbol)) as symbol
    from public.watchlist_items watch
    join public.instruments instrument on instrument.id = watch.instrument_id
    where watch.user_id = v_user
      and lower(instrument.asset_type::text) in ('stock', 'etf')
  ),
  canonical as (
    select distinct on (watched.symbol, event.accession_number, event.transaction_key)
      event.id,
      v_user as user_id,
      watched.instrument_id,
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
    from watched
    join public.instruments source_instrument
      on upper(btrim(source_instrument.symbol)) = watched.symbol
    join public.smart_money_events event
      on event.instrument_id = source_instrument.id
    where event.filed_at >= now() - interval '90 days'
    order by watched.symbol, event.accession_number, event.transaction_key, event.created_at desc
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

-- Repair members who completed onboarding before this migration. Every action
-- above is idempotent and starting cash is added only to untouched portfolios.
do $$
declare
  member record;
begin
  for member in
    select user_id
    from public.pcc_members
    where onboarding_completed_at is not null
  loop
    perform public.bootstrap_member_workspace(member.user_id);
  end loop;
end;
$$;

commit;
