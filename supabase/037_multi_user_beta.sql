-- Portfolio Command Center: private multi-user beta.
-- Financial data stays user-owned. Market briefs are shared publications,
-- while watchlists and notification read state remain independent per user.

begin;

create table if not exists public.pcc_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  onboarding_completed_at timestamptz,
  starter_watchlist_version integer not null default 0,
  can_publish_shared_briefs boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pcc_members_display_name_length
    check (display_name is null or char_length(display_name) between 1 and 80),
  constraint pcc_members_starter_version
    check (starter_watchlist_version >= 0)
);

alter table public.pcc_members enable row level security;

drop policy if exists pcc_members_select_own on public.pcc_members;
create policy pcc_members_select_own on public.pcc_members
  for select to authenticated using (user_id = auth.uid());

drop policy if exists pcc_members_update_own on public.pcc_members;
create policy pcc_members_update_own on public.pcc_members
  for update to authenticated using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke all on public.pcc_members from public, anon, authenticated;
grant select on public.pcc_members to authenticated;

create table if not exists public.starter_watchlist_symbols (
  symbol text primary key,
  display_name text,
  asset_type public.asset_type not null,
  exchange text,
  currency text not null default 'USD',
  webull_instrument_id text,
  logo_url text,
  sort_order integer not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint starter_watchlist_asset_type check (asset_type in ('stock', 'etf')),
  constraint starter_watchlist_symbol check (symbol = upper(btrim(symbol)) and char_length(symbol) between 1 and 24),
  constraint starter_watchlist_currency check (currency ~ '^[A-Z]{3}$'),
  unique (sort_order)
);

alter table public.starter_watchlist_symbols enable row level security;

drop policy if exists starter_watchlist_select_authenticated on public.starter_watchlist_symbols;
create policy starter_watchlist_select_authenticated on public.starter_watchlist_symbols
  for select to authenticated using (active = true);

revoke all on public.starter_watchlist_symbols from public, anon, authenticated;
grant select on public.starter_watchlist_symbols to authenticated;

-- Seed the shared catalog from the current curated watchlist. DISTINCT ON
-- makes this safe if more than one existing account tracks the same symbol.
with curated as (
  select distinct on (upper(btrim(instrument.symbol)))
    upper(btrim(instrument.symbol)) as symbol,
    instrument.display_name,
    instrument.asset_type,
    instrument.exchange,
    upper(coalesce(instrument.currency, 'USD')) as currency,
    instrument.webull_instrument_id,
    instrument.logo_url
  from public.watchlist_items item
  join public.instruments instrument on instrument.id = item.instrument_id
  where instrument.asset_type in ('stock', 'etf')
  order by upper(btrim(instrument.symbol)), item.created_at, instrument.created_at
), ordered as (
  select curated.*, row_number() over (order by symbol)::integer as sort_order
  from curated
)
insert into public.starter_watchlist_symbols (
  symbol, display_name, asset_type, exchange, currency,
  webull_instrument_id, logo_url, sort_order
)
select symbol, display_name, asset_type, exchange, currency,
       webull_instrument_id, logo_url, sort_order
from ordered
on conflict (symbol) do update
set display_name = excluded.display_name,
    asset_type = excluded.asset_type,
    exchange = excluded.exchange,
    currency = excluded.currency,
    webull_instrument_id = coalesce(excluded.webull_instrument_id, public.starter_watchlist_symbols.webull_instrument_id),
    logo_url = coalesce(excluded.logo_url, public.starter_watchlist_symbols.logo_url),
    sort_order = excluded.sort_order,
    active = true,
    updated_at = now();

-- Existing accounts keep their current data and skip first-run onboarding.
insert into public.pcc_members (
  user_id, display_name, onboarding_completed_at,
  starter_watchlist_version, can_publish_shared_briefs
)
select
  auth_user.id,
  nullif(split_part(auth_user.email, '@', 1), ''),
  now(),
  case when exists (
    select 1 from public.watchlist_items item where item.user_id = auth_user.id
  ) then 1 else 0 end,
  exists (
    select 1
    from public.agent_api_tokens token
    where token.user_id = auth_user.id
      and token.revoked_at is null
      and (token.expires_at is null or token.expires_at > now())
      and 'briefings:write' = any(token.scopes)
  )
from auth.users auth_user
on conflict (user_id) do nothing;

alter table public.market_briefs
  add column if not exists audience text not null default 'shared';

alter table public.market_briefs
  drop constraint if exists market_briefs_audience_check;
alter table public.market_briefs
  add constraint market_briefs_audience_check
  check (audience in ('private', 'shared'));

update public.market_briefs
set audience = 'shared'
where status = 'published';

insert into public.pcc_notifications (
  user_id, notification_type, title, preview, route,
  entity_type, entity_id, dedupe_key
)
select
  member.user_id, 'daily_brief', 'Daily Market Brief', left(brief.summary, 500),
  'briefs', 'market_brief', brief.id, 'daily-brief:' || brief.brief_date::text
from public.pcc_members member
cross join public.market_briefs brief
where member.onboarding_completed_at is not null
  and brief.status = 'published'
  and brief.audience = 'shared'
on conflict (user_id, dedupe_key) do nothing;

drop policy if exists market_briefs_select_own on public.market_briefs;
drop policy if exists market_briefs_select_visible on public.market_briefs;
create policy market_briefs_select_visible on public.market_briefs
  for select to authenticated
  using (user_id = auth.uid() or audience = 'shared');

drop policy if exists market_brief_updates_select_own on public.market_brief_updates;
drop policy if exists market_brief_updates_select_visible on public.market_brief_updates;
create policy market_brief_updates_select_visible on public.market_brief_updates
  for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1
      from public.market_briefs brief
      where brief.id = market_brief_updates.brief_id
        and brief.audience = 'shared'
    )
  );

create or replace function public.api_get_member_onboarding()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'member_exists', member.user_id is not null,
    'display_name', member.display_name,
    'onboarding_complete', member.onboarding_completed_at is not null,
    'onboarding_completed_at', member.onboarding_completed_at,
    'starter_watchlist_version', coalesce(member.starter_watchlist_version, 0),
    'starter_symbol_count', (
      select count(*) from public.starter_watchlist_symbols starter where starter.active = true
    ),
    'portfolio_count', (
      select count(*) from public.portfolios portfolio
      where portfolio.user_id = auth.uid() and portfolio.is_active = true
    ),
    'watchlist_count', (
      select count(*) from public.watchlist_items item where item.user_id = auth.uid()
    )
  )
  from (select auth.uid() as user_id) identity
  left join public.pcc_members member on member.user_id = identity.user_id;
$$;

create or replace function public.api_complete_member_onboarding(
  p_display_name text,
  p_portfolio_name text default 'Long Term',
  p_fixed_budget numeric default 0,
  p_broker_profile text default 'webull'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_display_name text := nullif(btrim(p_display_name), '');
  v_portfolio_name text := nullif(btrim(p_portfolio_name), '');
  v_broker text := lower(btrim(coalesce(p_broker_profile, 'webull')));
  v_portfolio_id uuid;
  v_instrument_id uuid;
  v_started_at timestamptz := clock_timestamp();
  v_starter record;
  v_watchlist_count integer;
  v_portfolio_count integer;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if v_display_name is null then raise exception 'Display name is required'; end if;
  if char_length(v_display_name) > 80 then raise exception 'Display name is too long'; end if;
  if v_portfolio_name is null then raise exception 'Portfolio name is required'; end if;
  if char_length(v_portfolio_name) > 80 then raise exception 'Portfolio name is too long'; end if;
  if coalesce(p_fixed_budget, 0) < 0 then raise exception 'Starting capital cannot be negative'; end if;
  if v_broker not in ('webull', 'dime') then raise exception 'Broker must be Webull or Dime'; end if;

  insert into public.pcc_members (user_id, display_name)
  values (v_user, v_display_name)
  on conflict (user_id) do update
  set display_name = excluded.display_name,
      updated_at = now();

  select portfolio.id into v_portfolio_id
  from public.portfolios portfolio
  where portfolio.user_id = v_user and portfolio.is_active = true
  order by portfolio.sort_order, portfolio.created_at
  limit 1;

  if v_portfolio_id is null then
    insert into public.portfolios (
      user_id, kind, name, base_currency, fixed_budget, allocation_basis,
      cost_method, sort_order, is_active, portfolio_mode, archived_at, broker_profile
    ) values (
      v_user, 'long_term'::public.portfolio_kind, v_portfolio_name, 'USD',
      coalesce(p_fixed_budget, 0), 'cost_basis', 'weighted_average', 1,
      true, 'mixed', null, v_broker
    ) returning id into v_portfolio_id;

    insert into public.audit_log (
      user_id, actor_type, actor_id, action, entity_type,
      entity_id, request_id, after_data
    ) values (
      v_user, 'user', v_user::text, 'complete_onboarding', 'portfolio',
      v_portfolio_id::text, concat('onboarding:', v_user::text),
      jsonb_build_object(
        'name', v_portfolio_name,
        'fixed_budget', coalesce(p_fixed_budget, 0),
        'broker_profile', v_broker,
        'portfolio_mode', 'mixed'
      )
    );
  end if;

  if not exists (select 1 from public.watchlist_items item where item.user_id = v_user) then
    for v_starter in
      select *
      from public.starter_watchlist_symbols starter
      where starter.active = true
      order by starter.sort_order
    loop
      insert into public.instruments (
        user_id, instrument_key, asset_type, symbol, display_name,
        exchange, currency, multiplier, webull_instrument_id,
        logo_url, logo_fetched_at
      ) values (
        v_user, concat(v_starter.asset_type::text, ':', v_starter.symbol),
        v_starter.asset_type, v_starter.symbol, v_starter.display_name,
        v_starter.exchange, v_starter.currency, 1,
        v_starter.webull_instrument_id, v_starter.logo_url,
        case when v_starter.logo_url is not null then now() else null end
      )
      on conflict (user_id, instrument_key) do update
      set display_name = coalesce(excluded.display_name, public.instruments.display_name),
          exchange = coalesce(excluded.exchange, public.instruments.exchange),
          currency = excluded.currency,
          webull_instrument_id = coalesce(excluded.webull_instrument_id, public.instruments.webull_instrument_id),
          logo_url = coalesce(excluded.logo_url, public.instruments.logo_url),
          logo_fetched_at = case
            when coalesce(excluded.logo_url, public.instruments.logo_url) is not null then now()
            else public.instruments.logo_fetched_at
          end,
          updated_at = now()
      returning id into v_instrument_id;

      insert into public.watchlist_items (
        user_id, instrument_id, created_at, updated_at
      ) values (
        v_user, v_instrument_id,
        v_started_at + (v_starter.sort_order * interval '1 millisecond'),
        now()
      )
      on conflict (user_id, instrument_id) do nothing;
    end loop;
  end if;

  update public.pcc_members
  set display_name = v_display_name,
      onboarding_completed_at = coalesce(onboarding_completed_at, now()),
      starter_watchlist_version = case
        when exists (select 1 from public.watchlist_items item where item.user_id = v_user) then 1
        else starter_watchlist_version
      end,
      updated_at = now()
  where user_id = v_user;

  insert into public.pcc_notifications (
    user_id, notification_type, title, preview, route,
    entity_type, entity_id, dedupe_key
  )
  select
    v_user, 'daily_brief', 'Daily Market Brief', left(brief.summary, 500),
    'briefs', 'market_brief', brief.id, 'daily-brief:' || brief.brief_date::text
  from public.market_briefs brief
  where brief.status = 'published' and brief.audience = 'shared'
  order by brief.brief_date desc, brief.published_at desc
  limit 1
  on conflict (user_id, dedupe_key) do nothing;

  select count(*) into v_portfolio_count
  from public.portfolios portfolio
  where portfolio.user_id = v_user and portfolio.is_active = true;

  select count(*) into v_watchlist_count
  from public.watchlist_items item
  where item.user_id = v_user;

  return jsonb_build_object(
    'onboarding_complete', true,
    'display_name', v_display_name,
    'portfolio_id', v_portfolio_id,
    'portfolio_count', v_portfolio_count,
    'watchlist_count', v_watchlist_count,
    'starter_watchlist_version', 1
  );
end;
$$;

create or replace function public.api_get_market_brief_feed(p_limit integer default 30)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  with visible_briefs as (
    select brief.*
    from public.market_briefs brief
    where brief.status = 'published'
      and (brief.audience = 'shared' or brief.user_id = auth.uid())
    order by brief.brief_date desc, brief.published_at desc
    limit greatest(1, least(coalesce(p_limit, 30), 100))
  )
  select jsonb_build_object(
    'briefs', coalesce((
      select jsonb_agg(
        to_jsonb(brief) || jsonb_build_object(
          'updates', coalesce((
            select jsonb_agg(to_jsonb(update_row) order by update_row.published_at)
            from public.market_brief_updates update_row
            where update_row.brief_id = brief.id
          ), '[]'::jsonb)
        ) order by brief.brief_date desc, brief.published_at desc
      )
      from visible_briefs brief
    ), '[]'::jsonb),
    'notifications', coalesce((
      select jsonb_agg(to_jsonb(notification) order by notification.created_at desc)
      from (
        select notice.*
        from public.pcc_notifications notice
        where notice.user_id = auth.uid()
        order by notice.created_at desc
        limit 30
      ) notification
    ), '[]'::jsonb)
  );
$$;

create or replace function public.api_agent_publish_market_brief(
  p_user_id uuid,
  p_agent_id uuid,
  p_brief_date date,
  p_summary text,
  p_content jsonb,
  p_source_context jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_brief public.market_briefs;
begin
  if p_user_id is null or p_agent_id is null then raise exception 'Agent identity is required'; end if;
  if p_brief_date is null then raise exception 'brief_date is required'; end if;
  if nullif(trim(p_summary), '') is null then raise exception 'summary is required'; end if;
  if jsonb_typeof(p_content) <> 'object' then raise exception 'content must be a JSON object'; end if;
  if jsonb_typeof(coalesce(p_source_context, '{}'::jsonb)) <> 'object' then raise exception 'source_context must be a JSON object'; end if;
  if nullif(trim(p_idempotency_key), '') is null then raise exception 'idempotency_key is required'; end if;
  if not exists (
    select 1
    from public.agent_api_tokens token
    join public.pcc_members member on member.user_id = token.user_id
    where token.id = p_agent_id
      and token.user_id = p_user_id
      and token.revoked_at is null
      and (token.expires_at is null or token.expires_at > now())
      and 'briefings:write' = any(token.scopes)
      and member.can_publish_shared_briefs = true
  ) then raise exception 'Agent is not authorized to publish the shared brief'; end if;

  insert into public.market_briefs (
    user_id, brief_date, summary, content, source_context, status,
    audience, idempotency_key, created_by_agent_id, published_at
  ) values (
    p_user_id, p_brief_date, trim(p_summary), p_content,
    coalesce(p_source_context, '{}'::jsonb), 'published', 'shared',
    trim(p_idempotency_key), p_agent_id, now()
  )
  on conflict (user_id, brief_date) do update
  set summary = excluded.summary,
      content = excluded.content,
      source_context = excluded.source_context,
      status = 'published',
      audience = 'shared',
      idempotency_key = excluded.idempotency_key,
      created_by_agent_id = excluded.created_by_agent_id,
      published_at = now(),
      updated_at = now()
  returning * into v_brief;

  insert into public.pcc_notifications (
    user_id, notification_type, title, preview, route,
    entity_type, entity_id, dedupe_key
  )
  select
    member.user_id, 'daily_brief', 'Daily Market Brief', left(trim(p_summary), 500),
    'briefs', 'market_brief', v_brief.id, 'daily-brief:' || p_brief_date::text
  from public.pcc_members member
  where member.onboarding_completed_at is not null
  on conflict (user_id, dedupe_key) do update
  set preview = excluded.preview,
      entity_id = excluded.entity_id,
      read_at = null,
      created_at = now();

  return jsonb_build_object(
    'brief_id', v_brief.id,
    'brief_date', v_brief.brief_date,
    'published_at', v_brief.published_at,
    'audience', v_brief.audience,
    'notified_members', (
      select count(*) from public.pcc_members member
      where member.onboarding_completed_at is not null
    ),
    'route', 'briefs'
  );
end;
$$;

create or replace function public.api_agent_publish_brief_continuation(
  p_user_id uuid,
  p_agent_id uuid,
  p_brief_date date,
  p_thesis_status text,
  p_summary text,
  p_content jsonb,
  p_source_context jsonb,
  p_material_score numeric,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_brief_id uuid;
  v_update public.market_brief_updates;
begin
  if p_thesis_status not in ('unchanged', 'updated') then
    raise exception 'thesis_status must be unchanged or updated';
  end if;
  if nullif(trim(p_summary), '') is null then raise exception 'summary is required'; end if;
  if jsonb_typeof(p_content) <> 'object' then raise exception 'content must be a JSON object'; end if;
  if p_material_score is not null and (p_material_score < 0 or p_material_score > 100) then
    raise exception 'material_score must be between 0 and 100';
  end if;
  if not exists (
    select 1
    from public.agent_api_tokens token
    join public.pcc_members member on member.user_id = token.user_id
    where token.id = p_agent_id
      and token.user_id = p_user_id
      and token.revoked_at is null
      and (token.expires_at is null or token.expires_at > now())
      and 'briefings:write' = any(token.scopes)
      and member.can_publish_shared_briefs = true
  ) then raise exception 'Agent is not authorized to publish shared brief updates'; end if;

  select brief.id into v_brief_id
  from public.market_briefs brief
  where brief.user_id = p_user_id
    and brief.brief_date = p_brief_date
    and brief.audience = 'shared'
  for update;
  if v_brief_id is null then raise exception 'Shared Daily Market Brief not found for %', p_brief_date; end if;

  insert into public.market_brief_updates (
    brief_id, user_id, thesis_status, summary, content, source_context,
    material_score, idempotency_key, created_by_agent_id, published_at
  ) values (
    v_brief_id, p_user_id, p_thesis_status, trim(p_summary), p_content,
    coalesce(p_source_context, '{}'::jsonb), p_material_score,
    trim(p_idempotency_key), p_agent_id, now()
  )
  on conflict (user_id, idempotency_key) do update
  set thesis_status = excluded.thesis_status,
      summary = excluded.summary,
      content = excluded.content,
      source_context = excluded.source_context,
      material_score = excluded.material_score,
      published_at = now()
  returning * into v_update;

  insert into public.pcc_notifications (
    user_id, notification_type, title, preview, route,
    entity_type, entity_id, dedupe_key
  )
  select
    member.user_id, 'brief_continuation', 'Daily Market Brief - Continuation',
    left(trim(p_summary), 500), 'briefs', 'market_brief_update', v_update.id,
    'brief-continuation:' || trim(p_idempotency_key)
  from public.pcc_members member
  where member.onboarding_completed_at is not null
  on conflict (user_id, dedupe_key) do update
  set preview = excluded.preview,
      entity_id = excluded.entity_id,
      read_at = null,
      created_at = now();

  return jsonb_build_object(
    'brief_id', v_brief_id,
    'update_id', v_update.id,
    'brief_date', p_brief_date,
    'published_at', v_update.published_at,
    'notified_members', (
      select count(*) from public.pcc_members member
      where member.onboarding_completed_at is not null
    ),
    'route', 'briefs'
  );
end;
$$;

revoke all on function public.api_get_member_onboarding() from public, anon;
revoke all on function public.api_complete_member_onboarding(text, text, numeric, text) from public, anon;
revoke all on function public.api_get_market_brief_feed(integer) from public, anon;
revoke all on function public.api_agent_publish_market_brief(uuid, uuid, date, text, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.api_agent_publish_brief_continuation(uuid, uuid, date, text, text, jsonb, jsonb, numeric, text) from public, anon, authenticated;

grant execute on function public.api_get_member_onboarding() to authenticated;
grant execute on function public.api_complete_member_onboarding(text, text, numeric, text) to authenticated;
grant execute on function public.api_get_market_brief_feed(integer) to authenticated;
grant execute on function public.api_agent_publish_market_brief(uuid, uuid, date, text, jsonb, jsonb, text) to service_role;
grant execute on function public.api_agent_publish_brief_continuation(uuid, uuid, date, text, text, jsonb, jsonb, numeric, text) to service_role;

commit;
