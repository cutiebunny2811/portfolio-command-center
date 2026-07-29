-- Portfolio Command Center: selected X accounts as first-class Research sources.
-- Source subscriptions are user-scoped. Posts can appear in the feed even when
-- they do not mention a ticker; cashtags still attach them to portfolio assets.

begin;

create table if not exists public.research_source_subscriptions (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  source text not null check (source in ('x')),
  source_key text not null,
  display_name text,
  external_user_id text,
  last_resource_id text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, source, source_key)
);

create table if not exists public.research_source_article_matches (
  user_id uuid not null references auth.users(id) on delete cascade,
  article_id uuid not null references public.research_articles(id) on delete cascade,
  source text not null,
  source_key text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, article_id, source, source_key)
);

create index if not exists research_source_matches_user_article_idx
  on public.research_source_article_matches (user_id, article_id);

alter table public.research_source_subscriptions enable row level security;
alter table public.research_source_article_matches enable row level security;

drop policy if exists research_source_subscriptions_select_own on public.research_source_subscriptions;
create policy research_source_subscriptions_select_own
  on public.research_source_subscriptions for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists research_source_subscriptions_insert_own on public.research_source_subscriptions;
create policy research_source_subscriptions_insert_own
  on public.research_source_subscriptions for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists research_source_subscriptions_update_own on public.research_source_subscriptions;
create policy research_source_subscriptions_update_own
  on public.research_source_subscriptions for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists research_source_subscriptions_delete_own on public.research_source_subscriptions;
create policy research_source_subscriptions_delete_own
  on public.research_source_subscriptions for delete
  to authenticated
  using (user_id = auth.uid());

drop policy if exists research_source_matches_select_own on public.research_source_article_matches;
create policy research_source_matches_select_own
  on public.research_source_article_matches for select
  to authenticated
  using (user_id = auth.uid());

grant select, insert, update, delete on public.research_source_subscriptions to authenticated;
grant select on public.research_source_article_matches to authenticated;
revoke insert, update, delete on public.research_source_article_matches from anon, authenticated;

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

create or replace function public.api_set_research_article_state(
  p_article_id uuid,
  p_action text,
  p_value boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_action text := lower(coalesce(trim(p_action), ''));
  v_result public.research_article_state;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if v_action not in ('read', 'saved', 'hidden') then
    raise exception 'Unsupported Research action';
  end if;
  if not exists (
    select 1
    from public.research_article_matches
    where user_id = v_user_id
      and article_id = p_article_id
    union all
    select 1
    from public.research_source_article_matches
    where user_id = v_user_id
      and article_id = p_article_id
  ) then
    raise exception 'Article is not part of this Research feed';
  end if;

  insert into public.research_article_state (user_id, article_id)
  values (v_user_id, p_article_id)
  on conflict (user_id, article_id) do nothing;

  update public.research_article_state
  set
    is_read = case when v_action = 'read' then p_value else is_read end,
    is_saved = case
      when v_action = 'saved' then p_value
      when v_action = 'hidden' and p_value then false
      else is_saved
    end,
    is_hidden = case
      when v_action = 'hidden' then p_value
      when v_action = 'saved' and p_value then false
      else is_hidden
    end,
    read_at = case when v_action = 'read' then case when p_value then now() else null end else read_at end,
    saved_at = case
      when v_action = 'saved' then case when p_value then now() else null end
      when v_action = 'hidden' and p_value then null
      else saved_at
    end,
    hidden_at = case
      when v_action = 'hidden' then case when p_value then now() else null end
      when v_action = 'saved' and p_value then null
      else hidden_at
    end,
    updated_at = now()
  where user_id = v_user_id
    and article_id = p_article_id
  returning * into v_result;

  return to_jsonb(v_result);
end;
$$;

revoke all on function public.api_get_research_feed(text, integer, integer, text) from public, anon;
revoke all on function public.api_set_research_article_state(uuid, text, boolean) from public, anon;
grant execute on function public.api_get_research_feed(text, integer, integer, text) to authenticated;
grant execute on function public.api_set_research_article_state(uuid, text, boolean) to authenticated;

commit;
