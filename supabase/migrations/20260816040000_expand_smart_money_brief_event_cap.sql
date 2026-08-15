-- Let the first weekly edition consume a large imported watchlist backlog in one pass.

begin;

alter table public.smart_money_briefs
  drop constraint if exists smart_money_briefs_reported_events;
alter table public.smart_money_briefs
  add constraint smart_money_briefs_reported_events
  check (cardinality(reported_event_keys) between 1 and 5000);

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
    'smart-money', 'smart_money_brief', v_brief.id,
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
    'route', 'smart-money'
  );
end;
$$;

revoke all on function public.api_agent_publish_smart_money_brief(uuid, uuid, date, text, jsonb, jsonb, text[], text)
  from public, anon, authenticated;
grant execute on function public.api_agent_publish_smart_money_brief(uuid, uuid, date, text, jsonb, jsonb, text[], text)
  to service_role;

commit;
