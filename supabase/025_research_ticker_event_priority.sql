-- Portfolio Command Center: explicit ticker events take priority over macro.
-- Backfills $TICKER and (TICKER) mentions already stored from X, then keeps
-- Market / Macro reserved for posts without a company-specific ticker.

begin;

with extracted as (
  select
    article.id,
    array_agg(distinct symbol.symbol) as symbols
  from public.research_articles article
  cross join lateral (
    select upper(match[1]) as symbol
    from regexp_matches(
      coalesce(article.raw_payload ->> 'text', ''),
      '\$([A-Z][A-Z0-9.-]{1,5})\y',
      'g'
    ) as match

    union

    select upper(match[1]) as symbol
    from regexp_matches(
      coalesce(article.raw_payload ->> 'text', ''),
      '\(([A-Z][A-Z0-9.-]{1,5})\)',
      'g'
    ) as match
    where upper(match[1]) !~ '^(Q[1-4]|FY[0-9]{2,4})$'
  ) symbol
  where article.source = 'x'
  group by article.id
)
update public.research_articles article
set
  tickers = (
    select coalesce(array_agg(distinct ticker), '{}'::text[])
    from unnest(coalesce(article.tickers, '{}'::text[]) || extracted.symbols) ticker
  ),
  keywords = (
    select coalesce(array_agg(distinct keyword), '{}'::text[])
    from unnest(coalesce(article.keywords, '{}'::text[]) || array['X_SIGNAL', 'TICKER_EVENT']) keyword
  ),
  updated_at = now()
from extracted
where article.id = extracted.id;

create or replace function public.api_get_research_feed(
  p_filter text default 'all',
  p_page integer default 1,
  p_page_size integer default 25,
  p_search text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_filter text := lower(coalesce(nullif(trim(p_filter), ''), 'all'));
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 25), 1), 50);
  v_search text := nullif(upper(trim(p_search)), '');
  v_total bigint;
  v_entries jsonb;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if v_filter not in ('all', 'unread', 'portfolio', 'macro', 'saved') then
    raise exception 'Unsupported Research filter';
  end if;

  with scope_links as (
    select
      match.user_id,
      match.article_id,
      bool_or(match.is_portfolio) as is_portfolio,
      bool_or(match.is_watchlist) as is_watchlist
    from public.research_article_matches match
    where match.user_id = v_user_id
    group by match.user_id, match.article_id

    union all

    select
      source_match.user_id,
      source_match.article_id,
      false as is_portfolio,
      false as is_watchlist
    from public.research_source_article_matches source_match
    where source_match.user_id = v_user_id
  ),
  scoped as (
    select
      article.id,
      article.source,
      article.source_article_id,
      article.canonical_url,
      article.title,
      article.description,
      article.publisher_name,
      article.publisher_homepage_url,
      article.publisher_logo_url,
      article.published_at,
      article.tickers,
      article.keywords,
      bool_or(link.is_portfolio) as is_portfolio,
      bool_or(link.is_watchlist) as is_watchlist,
      coalesce(state.is_read, false) as is_read,
      coalesce(state.is_saved, false) as is_saved,
      coalesce(state.is_hidden, false) as is_hidden
    from scope_links link
    join public.research_articles article on article.id = link.article_id
    left join public.research_article_state state
      on state.user_id = link.user_id
     and state.article_id = article.id
    where article.source <> 'x'
       or 'X_SIGNAL' = any(article.keywords)
    group by article.id, state.is_read, state.is_saved, state.is_hidden
  ),
  filtered as (
    select *
    from scoped
    where not is_hidden
      and (v_filter <> 'unread' or not is_read)
      and (v_filter <> 'portfolio' or is_portfolio)
      and (
        v_filter <> 'macro'
        or (
          'MARKET_MACRO' = any(keywords)
          and not ('TICKER_EVENT' = any(keywords))
        )
      )
      and (v_filter <> 'saved' or is_saved)
      and (
        v_search is null
        or exists (
          select 1
          from unnest(tickers) ticker
          where upper(trim(ticker)) = v_search
        )
      )
  ),
  paged as (
    select *
    from filtered
    order by published_at desc, id desc
    offset (v_page - 1) * v_page_size
    limit v_page_size
  )
  select
    (select count(*) from filtered),
    coalesce(jsonb_agg(to_jsonb(paged) order by published_at desc), '[]'::jsonb)
  into v_total, v_entries
  from paged;

  return jsonb_build_object(
    'entries', v_entries,
    'total_count', coalesce(v_total, 0),
    'page', v_page,
    'page_size', v_page_size,
    'filter', v_filter,
    'search_ticker', v_search
  );
end;
$$;

revoke all on function public.api_get_research_feed(text, integer, integer, text) from public, anon;
grant execute on function public.api_get_research_feed(text, integer, integer, text) to authenticated;

commit;
