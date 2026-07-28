-- Portfolio Command Center: make News search ticker-only and exact.
-- "BE" now matches ticker BE, never words such as "beating" or "enterprise".

begin;

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
  if v_filter not in ('all', 'unread', 'portfolio', 'saved') then
    raise exception 'Unsupported Research filter';
  end if;

  with scoped as (
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
      bool_or(match.is_portfolio) as is_portfolio,
      bool_or(match.is_watchlist) as is_watchlist,
      coalesce(state.is_read, false) as is_read,
      coalesce(state.is_saved, false) as is_saved,
      coalesce(state.is_hidden, false) as is_hidden
    from public.research_article_matches match
    join public.research_articles article on article.id = match.article_id
    left join public.research_article_state state
      on state.user_id = match.user_id
     and state.article_id = article.id
    where match.user_id = v_user_id
    group by article.id, state.is_read, state.is_saved, state.is_hidden
  ),
  filtered as (
    select *
    from scoped
    where not is_hidden
      and (v_filter <> 'unread' or not is_read)
      and (v_filter <> 'portfolio' or is_portfolio)
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
