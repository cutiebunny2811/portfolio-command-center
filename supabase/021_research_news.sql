-- Portfolio Command Center: source-first Research News inbox.
-- V1 is intentionally news-only. It stores no financial-statement calculations
-- and applies no AI-generated signal score.

begin;

create table if not exists public.research_articles (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  source_article_id text not null,
  canonical_url text not null,
  title text not null,
  description text,
  publisher_name text,
  publisher_homepage_url text,
  publisher_logo_url text,
  published_at timestamptz not null,
  tickers text[] not null default '{}'::text[],
  keywords text[] not null default '{}'::text[],
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, source_article_id)
);

create index if not exists research_articles_published_idx
  on public.research_articles (published_at desc);
create index if not exists research_articles_tickers_idx
  on public.research_articles using gin (tickers);

create table if not exists public.research_article_matches (
  user_id uuid not null references auth.users(id) on delete cascade,
  article_id uuid not null references public.research_articles(id) on delete cascade,
  instrument_id uuid not null references public.instruments(id) on delete cascade,
  is_watchlist boolean not null default false,
  is_portfolio boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (user_id, article_id, instrument_id)
);

create index if not exists research_matches_user_article_idx
  on public.research_article_matches (user_id, article_id);
create index if not exists research_matches_user_portfolio_idx
  on public.research_article_matches (user_id, is_portfolio, article_id);

create table if not exists public.research_article_state (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  article_id uuid not null references public.research_articles(id) on delete cascade,
  is_read boolean not null default false,
  is_saved boolean not null default false,
  is_hidden boolean not null default false,
  read_at timestamptz,
  saved_at timestamptz,
  hidden_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, article_id)
);

create table if not exists public.research_sync_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_published_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (user_id, source)
);

alter table public.research_articles enable row level security;
alter table public.research_article_matches enable row level security;
alter table public.research_article_state enable row level security;
alter table public.research_sync_state enable row level security;

drop policy if exists research_matches_select_own on public.research_article_matches;
create policy research_matches_select_own
  on public.research_article_matches for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists research_state_select_own on public.research_article_state;
create policy research_state_select_own
  on public.research_article_state for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists research_state_insert_own on public.research_article_state;
create policy research_state_insert_own
  on public.research_article_state for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists research_state_update_own on public.research_article_state;
create policy research_state_update_own
  on public.research_article_state for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists research_state_delete_own on public.research_article_state;
create policy research_state_delete_own
  on public.research_article_state for delete
  to authenticated
  using (user_id = auth.uid());

drop policy if exists research_sync_select_own on public.research_sync_state;
create policy research_sync_select_own
  on public.research_sync_state for select
  to authenticated
  using (user_id = auth.uid());

-- Raw articles are reachable only through the user-scoped RPC below. The
-- collector is the only writer and uses the service role.
revoke all on public.research_articles from anon, authenticated;
revoke insert, update, delete on public.research_article_matches from anon, authenticated;
revoke insert, update, delete on public.research_sync_state from anon, authenticated;
grant select on public.research_article_matches to authenticated;
grant select, insert, update, delete on public.research_article_state to authenticated;
grant select on public.research_sync_state to authenticated;

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
  v_search text := nullif(trim(p_search), '');
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
        or title ilike '%' || v_search || '%'
        or coalesce(description, '') ilike '%' || v_search || '%'
        or coalesce(publisher_name, '') ilike '%' || v_search || '%'
        or exists (
          select 1
          from unnest(tickers) ticker
          where ticker ilike '%' || v_search || '%'
        )
      )
  )
  select count(*) into v_total from filtered;

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
        or title ilike '%' || v_search || '%'
        or coalesce(description, '') ilike '%' || v_search || '%'
        or coalesce(publisher_name, '') ilike '%' || v_search || '%'
        or exists (
          select 1
          from unnest(tickers) ticker
          where ticker ilike '%' || v_search || '%'
        )
      )
    order by published_at desc, id desc
    offset (v_page - 1) * v_page_size
    limit v_page_size
  )
  select coalesce(jsonb_agg(to_jsonb(filtered) order by published_at desc), '[]'::jsonb)
  into v_entries
  from filtered;

  return jsonb_build_object(
    'entries', v_entries,
    'total_count', v_total,
    'page', v_page,
    'page_size', v_page_size,
    'filter', v_filter
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

