-- Portfolio Command Center: canonical Daily Market Briefs, continuations and notifications.
-- Hermes may publish through service-role-only RPCs after the Edge Function
-- validates a token with the briefings:write scope.

begin;
create table if not exists public.market_briefs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  brief_date date not null,
  title text not null default 'Daily Market Brief',
  summary text not null,
  content jsonb not null,
  source_context jsonb not null default '{}'::jsonb,
  status text not null default 'published',
  idempotency_key text not null,
  created_by_agent_id uuid references public.agent_api_tokens(id) on delete set null,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint market_briefs_content_object check (jsonb_typeof(content) = 'object'),
  constraint market_briefs_source_context_object check (jsonb_typeof(source_context) = 'object'),
  constraint market_briefs_status check (status in ('draft', 'published')),
  constraint market_briefs_summary_length check (char_length(summary) between 1 and 1200),
  constraint market_briefs_idempotency_length check (char_length(idempotency_key) between 8 and 160),
  unique (user_id, brief_date),
  unique (user_id, idempotency_key)
);
create index if not exists market_briefs_user_published_idx
  on public.market_briefs (user_id, published_at desc);
create table if not exists public.market_brief_updates (
  id uuid primary key default gen_random_uuid(),
  brief_id uuid not null references public.market_briefs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  update_kind text not null default 'continuation',
  thesis_status text not null,
  summary text not null,
  content jsonb not null,
  source_context jsonb not null default '{}'::jsonb,
  material_score numeric(5,2),
  idempotency_key text not null,
  created_by_agent_id uuid references public.agent_api_tokens(id) on delete set null,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint market_brief_updates_kind check (update_kind = 'continuation'),
  constraint market_brief_updates_thesis check (thesis_status in ('unchanged', 'updated')),
  constraint market_brief_updates_content_object check (jsonb_typeof(content) = 'object'),
  constraint market_brief_updates_source_context_object check (jsonb_typeof(source_context) = 'object'),
  constraint market_brief_updates_summary_length check (char_length(summary) between 1 and 1200),
  constraint market_brief_updates_material_score check (material_score is null or material_score between 0 and 100),
  constraint market_brief_updates_idempotency_length check (char_length(idempotency_key) between 8 and 160),
  unique (user_id, idempotency_key)
);
create index if not exists market_brief_updates_brief_published_idx
  on public.market_brief_updates (brief_id, published_at);
create table if not exists public.pcc_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  notification_type text not null,
  title text not null,
  preview text not null,
  route text not null default 'briefs',
  entity_type text not null,
  entity_id uuid not null,
  dedupe_key text not null,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint pcc_notifications_type check (notification_type in ('daily_brief', 'brief_continuation')),
  constraint pcc_notifications_route check (route = 'briefs'),
  constraint pcc_notifications_entity_type check (entity_type in ('market_brief', 'market_brief_update')),
  constraint pcc_notifications_title_length check (char_length(title) between 1 and 160),
  constraint pcc_notifications_preview_length check (char_length(preview) between 1 and 500),
  unique (user_id, dedupe_key)
);
create index if not exists pcc_notifications_user_created_idx
  on public.pcc_notifications (user_id, created_at desc);
create index if not exists pcc_notifications_user_unread_idx
  on public.pcc_notifications (user_id, created_at desc)
  where read_at is null;
alter table public.market_briefs enable row level security;
alter table public.market_brief_updates enable row level security;
alter table public.pcc_notifications enable row level security;
drop policy if exists market_briefs_select_own on public.market_briefs;
create policy market_briefs_select_own on public.market_briefs
  for select to authenticated using (user_id = auth.uid());
drop policy if exists market_brief_updates_select_own on public.market_brief_updates;
create policy market_brief_updates_select_own on public.market_brief_updates
  for select to authenticated using (user_id = auth.uid());
drop policy if exists pcc_notifications_select_own on public.pcc_notifications;
create policy pcc_notifications_select_own on public.pcc_notifications
  for select to authenticated using (user_id = auth.uid());
revoke all on public.market_briefs from public, anon, authenticated;
revoke all on public.market_brief_updates from public, anon, authenticated;
revoke all on public.pcc_notifications from public, anon, authenticated;
grant select on public.market_briefs to authenticated;
grant select on public.market_brief_updates to authenticated;
grant select on public.pcc_notifications to authenticated;
create or replace function public.api_get_market_brief_feed(p_limit integer default 30)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  with owned_briefs as (
    select brief.*
    from public.market_briefs brief
    where brief.user_id = auth.uid()
      and brief.status = 'published'
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
              and update_row.user_id = auth.uid()
          ), '[]'::jsonb)
        ) order by brief.brief_date desc, brief.published_at desc
      )
      from owned_briefs brief
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
create or replace function public.api_mark_notification_read(p_notification_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_count integer;
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  update public.pcc_notifications notice
  set read_at = coalesce(notice.read_at, now())
  where notice.user_id = v_user
    and (p_notification_id is null or notice.id = p_notification_id)
    and notice.read_at is null;

  get diagnostics v_count = row_count;
  return v_count;
end;
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
    select 1 from public.agent_api_tokens token
    where token.id = p_agent_id and token.user_id = p_user_id
      and token.revoked_at is null
  ) then raise exception 'Agent token is not active for this user'; end if;

  insert into public.market_briefs (
    user_id, brief_date, summary, content, source_context, status,
    idempotency_key, created_by_agent_id, published_at
  ) values (
    p_user_id, p_brief_date, trim(p_summary), p_content,
    coalesce(p_source_context, '{}'::jsonb), 'published',
    trim(p_idempotency_key), p_agent_id, now()
  )
  on conflict (user_id, brief_date) do update
  set summary = excluded.summary,
      content = excluded.content,
      source_context = excluded.source_context,
      status = 'published',
      idempotency_key = excluded.idempotency_key,
      created_by_agent_id = excluded.created_by_agent_id,
      published_at = now(),
      updated_at = now()
  returning * into v_brief;

  insert into public.pcc_notifications (
    user_id, notification_type, title, preview, route,
    entity_type, entity_id, dedupe_key
  ) values (
    p_user_id, 'daily_brief', 'Daily Market Brief', left(trim(p_summary), 500), 'briefs',
    'market_brief', v_brief.id, 'daily-brief:' || p_brief_date::text
  )
  on conflict (user_id, dedupe_key) do update
  set preview = excluded.preview,
      entity_id = excluded.entity_id,
      read_at = null,
      created_at = now();

  return jsonb_build_object(
    'brief_id', v_brief.id,
    'brief_date', v_brief.brief_date,
    'published_at', v_brief.published_at,
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
    select 1 from public.agent_api_tokens token
    where token.id = p_agent_id and token.user_id = p_user_id
      and token.revoked_at is null
  ) then raise exception 'Agent token is not active for this user'; end if;

  select brief.id into v_brief_id
  from public.market_briefs brief
  where brief.user_id = p_user_id and brief.brief_date = p_brief_date
  for update;
  if v_brief_id is null then raise exception 'Daily Market Brief not found for %', p_brief_date; end if;

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
  ) values (
    p_user_id, 'brief_continuation', 'Daily Market Brief · Continuation',
    left(trim(p_summary), 500), 'briefs', 'market_brief_update', v_update.id,
    'brief-continuation:' || trim(p_idempotency_key)
  )
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
    'route', 'briefs'
  );
end;
$$;
-- Add the new write scope to token creation and grant it to active Hermes
-- tokens because this migration is the explicit opt-in to canonical briefs.
create or replace function public.api_create_agent_token(
  p_name text default 'Hermes',
  p_scopes text[] default array['read', 'drafts:write', 'watchlist:write', 'briefings:write']::text[],
  p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_allowed constant text[] := array['read', 'drafts:write', 'watchlist:write', 'briefings:write'];
  v_scopes text[];
  v_token text;
  v_id uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if nullif(trim(p_name), '') is null then raise exception 'Token name is required'; end if;
  if char_length(trim(p_name)) > 80 then raise exception 'Token name is too long'; end if;
  if p_expires_at is not null and p_expires_at <= now() then raise exception 'Expiry must be in the future'; end if;

  select array_agg(distinct scope order by scope)
  into v_scopes
  from unnest(coalesce(p_scopes, array[]::text[])) as scope
  where scope = any(v_allowed);

  if coalesce(cardinality(v_scopes), 0) = 0 or not ('read' = any(v_scopes)) then
    raise exception 'The read scope is required';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_scopes, array[]::text[])) as requested(scope)
    where not (requested.scope = any(v_allowed))
  ) then raise exception 'Unsupported agent scope'; end if;

  v_token := 'pcc_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.agent_api_tokens (user_id, name, token_hash, scopes, expires_at)
  values (v_user, trim(p_name), public.api_token_hash(v_token), v_scopes, p_expires_at)
  returning id into v_id;

  insert into public.audit_log (user_id, actor_type, actor_id, action, entity_type, entity_id, after_data)
  values (
    v_user, 'user', v_user::text, 'create_agent_token', 'agent_api_token', v_id::text,
    jsonb_build_object('name', trim(p_name), 'scopes', to_jsonb(v_scopes), 'expires_at', p_expires_at)
  );

  return jsonb_build_object(
    'token_id', v_id, 'token', v_token, 'name', trim(p_name),
    'scopes', to_jsonb(v_scopes), 'expires_at', p_expires_at
  );
end;
$$;
update public.agent_api_tokens
set scopes = array_append(scopes, 'briefings:write')
where revoked_at is null
  and lower(name) like 'hermes%'
  and not ('briefings:write' = any(scopes));
revoke all on function public.api_get_market_brief_feed(integer) from public, anon;
revoke all on function public.api_mark_notification_read(uuid) from public, anon;
revoke all on function public.api_agent_publish_market_brief(uuid, uuid, date, text, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.api_agent_publish_brief_continuation(uuid, uuid, date, text, text, jsonb, jsonb, numeric, text) from public, anon, authenticated;
revoke all on function public.api_create_agent_token(text, text[], timestamptz) from public, anon;
grant execute on function public.api_get_market_brief_feed(integer) to authenticated;
grant execute on function public.api_mark_notification_read(uuid) to authenticated;
grant execute on function public.api_agent_publish_market_brief(uuid, uuid, date, text, jsonb, jsonb, text) to service_role;
grant execute on function public.api_agent_publish_brief_continuation(uuid, uuid, date, text, text, jsonb, jsonb, numeric, text) to service_role;
grant execute on function public.api_create_agent_token(text, text[], timestamptz) to authenticated;
commit;
