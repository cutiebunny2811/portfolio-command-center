-- Weekly, shared Smart Money briefs with deterministic event-level deduplication.

begin;

create table if not exists public.smart_money_briefs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  report_date date not null,
  window_days integer not null default 30,
  title text not null default 'Smart Money Brief',
  summary text not null,
  content jsonb not null,
  source_context jsonb not null default '{}'::jsonb,
  reported_event_keys text[] not null default '{}'::text[],
  status text not null default 'published',
  audience text not null default 'shared',
  idempotency_key text not null,
  created_by_agent_id uuid references public.agent_api_tokens(id) on delete set null,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint smart_money_briefs_window check (window_days = 30),
  constraint smart_money_briefs_content_object check (jsonb_typeof(content) = 'object'),
  constraint smart_money_briefs_source_context_object check (jsonb_typeof(source_context) = 'object'),
  constraint smart_money_briefs_reported_events check (cardinality(reported_event_keys) between 1 and 5000),
  constraint smart_money_briefs_status check (status in ('draft', 'published')),
  constraint smart_money_briefs_audience check (audience in ('private', 'shared')),
  constraint smart_money_briefs_summary_length check (char_length(summary) between 1 and 1200),
  constraint smart_money_briefs_idempotency_length check (char_length(idempotency_key) between 8 and 160),
  unique (user_id, report_date),
  unique (user_id, idempotency_key)
);

create index if not exists smart_money_briefs_user_published_idx
  on public.smart_money_briefs (user_id, published_at desc);

alter table public.smart_money_briefs enable row level security;

drop policy if exists smart_money_briefs_select_visible on public.smart_money_briefs;
create policy smart_money_briefs_select_visible on public.smart_money_briefs
  for select to authenticated
  using (status = 'published' and (audience = 'shared' or user_id = auth.uid()));

revoke all on public.smart_money_briefs from public, anon, authenticated;
grant select on public.smart_money_briefs to authenticated;

alter table public.pcc_notifications drop constraint if exists pcc_notifications_type;
alter table public.pcc_notifications drop constraint if exists pcc_notifications_route;
alter table public.pcc_notifications drop constraint if exists pcc_notifications_entity_type;
alter table public.pcc_notifications
  add constraint pcc_notifications_type
  check (notification_type in ('daily_brief', 'brief_continuation', 'smart_money_brief'));
alter table public.pcc_notifications
  add constraint pcc_notifications_route
  check (route in ('briefs', 'smart-money', 'smart-money-briefs'));
alter table public.pcc_notifications
  add constraint pcc_notifications_entity_type
  check (entity_type in ('market_brief', 'market_brief_update', 'smart_money_brief'));

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
  ),
  visible_smart_money_briefs as (
    select brief.*
    from public.smart_money_briefs brief
    where brief.status = 'published'
      and (brief.audience = 'shared' or brief.user_id = auth.uid())
    order by brief.report_date desc, brief.published_at desc
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
    'smart_money_briefs', coalesce((
      select jsonb_agg(to_jsonb(brief) order by brief.report_date desc, brief.published_at desc)
      from visible_smart_money_briefs brief
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

create or replace function public.api_agent_publish_smart_money_brief(
  p_user_id uuid,
  p_agent_id uuid,
  p_report_date date,
  p_summary text,
  p_content jsonb,
  p_source_context jsonb,
  p_reported_event_keys text[],
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_brief public.smart_money_briefs;
begin
  if p_user_id is null or p_agent_id is null then raise exception 'Agent identity is required'; end if;
  if p_report_date is null then raise exception 'report_date is required'; end if;
  if nullif(trim(p_summary), '') is null then raise exception 'summary is required'; end if;
  if jsonb_typeof(p_content) <> 'object' then raise exception 'content must be a JSON object'; end if;
  if jsonb_typeof(coalesce(p_source_context, '{}'::jsonb)) <> 'object' then raise exception 'source_context must be a JSON object'; end if;
  if coalesce(p_source_context ->> 'freshness_status', 'stale') not in ('fresh', 'partial') then
    raise exception 'Smart Money source is stale; publication refused';
  end if;
  if coalesce((p_source_context ->> 'window_days')::integer, 0) <> 30 then
    raise exception 'Smart Money brief must use the canonical 30-day window';
  end if;
  if coalesce(cardinality(p_reported_event_keys), 0) = 0 then
    raise exception 'No new Smart Money events to publish';
  end if;
  if cardinality(p_reported_event_keys) > 5000 then raise exception 'Too many reported event keys'; end if;
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
  ) then raise exception 'Agent is not authorized to publish the shared Smart Money brief'; end if;

  if exists (
    select 1
    from public.smart_money_briefs prior
    where prior.user_id = p_user_id
      and prior.report_date <> p_report_date
      and prior.published_at > now() - interval '6 days'
  ) then raise exception 'Smart Money Brief is limited to one edition per week'; end if;

  if exists (
    select 1
    from public.smart_money_briefs prior
    cross join unnest(prior.reported_event_keys) prior_key
    where prior.user_id = p_user_id
      and prior.report_date <> p_report_date
      and prior_key = any(p_reported_event_keys)
  ) then raise exception 'Smart Money brief contains an event reported in an earlier edition'; end if;

  insert into public.smart_money_briefs (
    user_id, report_date, window_days, summary, content, source_context,
    reported_event_keys, status, audience, idempotency_key,
    created_by_agent_id, published_at
  ) values (
    p_user_id, p_report_date, 30, trim(p_summary), p_content,
    coalesce(p_source_context, '{}'::jsonb), p_reported_event_keys,
    'published', 'shared', trim(p_idempotency_key), p_agent_id, now()
  )
  on conflict (user_id, report_date) do update
  set summary = excluded.summary,
      content = excluded.content,
      source_context = excluded.source_context,
      reported_event_keys = excluded.reported_event_keys,
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
    member.user_id, 'smart_money_brief', 'Smart Money Brief', left(trim(p_summary), 500),
    'smart-money-briefs', 'smart_money_brief', v_brief.id,
    'smart-money-brief:' || p_report_date::text
  from public.pcc_members member
  where member.onboarding_completed_at is not null
  on conflict (user_id, dedupe_key) do update
  set preview = excluded.preview,
      entity_id = excluded.entity_id,
      read_at = null,
      created_at = now();

  return jsonb_build_object(
    'brief_id', v_brief.id,
    'report_date', v_brief.report_date,
    'published_at', v_brief.published_at,
    'audience', v_brief.audience,
    'reported_event_count', cardinality(v_brief.reported_event_keys),
    'notified_members', (
      select count(*) from public.pcc_members member
      where member.onboarding_completed_at is not null
    ),
    'route', 'smart-money-briefs'
  );
end;
$$;

revoke all on function public.api_get_market_brief_feed(integer) from public, anon;
revoke all on function public.api_agent_publish_smart_money_brief(uuid, uuid, date, text, jsonb, jsonb, text[], text) from public, anon, authenticated;
grant execute on function public.api_get_market_brief_feed(integer) to authenticated;
grant execute on function public.api_agent_publish_smart_money_brief(uuid, uuid, date, text, jsonb, jsonb, text[], text) to service_role;

commit;
