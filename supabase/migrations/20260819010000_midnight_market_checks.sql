-- Portfolio Command Center: retain useful routine midnight checks without
-- turning them into material Continuations or member notifications.

alter table public.market_brief_updates
  drop constraint if exists market_brief_updates_kind;

alter table public.market_brief_updates
  add constraint market_brief_updates_kind
  check (update_kind in ('continuation', 'market_check'));

create or replace function public.api_agent_publish_midnight_market_check(
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
  v_brief_id uuid;
  v_update public.market_brief_updates;
begin
  if nullif(trim(p_summary), '') is null then raise exception 'summary is required'; end if;
  if jsonb_typeof(p_content) <> 'object' then raise exception 'content must be a JSON object'; end if;
  if jsonb_typeof(coalesce(p_source_context, '{}'::jsonb)) <> 'object' then
    raise exception 'source_context must be a JSON object';
  end if;
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
  ) then raise exception 'Agent is not authorized to publish shared brief updates'; end if;

  select brief.id into v_brief_id
  from public.market_briefs brief
  where brief.user_id = p_user_id
    and brief.brief_date = p_brief_date
    and brief.audience = 'shared'
  for update;
  if v_brief_id is null then raise exception 'Shared Daily Market Brief not found for %', p_brief_date; end if;

  insert into public.market_brief_updates (
    brief_id, user_id, update_kind, thesis_status, summary, content,
    source_context, material_score, idempotency_key, created_by_agent_id,
    published_at
  ) values (
    v_brief_id, p_user_id, 'market_check', 'unchanged', trim(p_summary),
    p_content, coalesce(p_source_context, '{}'::jsonb), null,
    trim(p_idempotency_key), p_agent_id, now()
  )
  on conflict (user_id, idempotency_key) do update
  set update_kind = 'market_check',
      thesis_status = 'unchanged',
      summary = excluded.summary,
      content = excluded.content,
      source_context = excluded.source_context,
      material_score = null,
      published_at = now()
  returning * into v_update;

  -- Routine checks are deliberately silent. Only the material Continuation
  -- RPC writes to pcc_notifications.
  return jsonb_build_object(
    'brief_id', v_brief_id,
    'update_id', v_update.id,
    'update_kind', v_update.update_kind,
    'brief_date', p_brief_date,
    'published_at', v_update.published_at,
    'notified_members', 0,
    'route', 'briefs'
  );
end;
$$;

revoke all on function public.api_agent_publish_midnight_market_check(uuid, uuid, date, text, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.api_agent_publish_midnight_market_check(uuid, uuid, date, text, jsonb, jsonb, text)
  to service_role;
