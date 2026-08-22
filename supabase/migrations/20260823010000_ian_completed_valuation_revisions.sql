begin;

alter table public.valuation_research_revisions
  add column if not exists completed_research jsonb,
  add column if not exists completed_valuation jsonb,
  add column if not exists research_format text not null default 'legacy_pcc_dcf';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.valuation_research_revisions'::regclass
      and conname = 'valuation_research_revisions_format_check'
  ) then
    alter table public.valuation_research_revisions
      add constraint valuation_research_revisions_format_check
      check (research_format in ('legacy_pcc_dcf', 'ian_completed_v1'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.valuation_research_revisions'::regclass
      and conname = 'valuation_research_revisions_completed_research_object'
  ) then
    alter table public.valuation_research_revisions
      add constraint valuation_research_revisions_completed_research_object
      check (completed_research is null or jsonb_typeof(completed_research) = 'object');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.valuation_research_revisions'::regclass
      and conname = 'valuation_research_revisions_completed_valuation_object'
  ) then
    alter table public.valuation_research_revisions
      add constraint valuation_research_revisions_completed_valuation_object
      check (completed_valuation is null or jsonb_typeof(completed_valuation) = 'object');
  end if;
end;
$$;

create or replace function public.api_request_valuation_research(p_instrument_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_instrument public.instruments;
  v_active public.valuation_research_jobs;
  v_job public.valuation_research_jobs;
  v_period text := public.pcc_latest_completed_quarter(current_date);
  v_sequence integer;
  v_code text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  select instrument.* into v_instrument
  from public.instruments instrument
  where instrument.id = p_instrument_id
    and instrument.user_id = v_user
    and instrument.asset_type::text = 'stock';
  if v_instrument.id is null then raise exception 'A user-owned Watchlist stock is required'; end if;
  if not exists (
    select 1 from public.watchlist_items item
    where item.user_id = v_user and item.instrument_id = p_instrument_id
  ) then raise exception 'Add this stock to Watchlist before requesting research'; end if;

  select job.* into v_active
  from public.valuation_research_jobs job
  where job.user_id = v_user
    and job.instrument_id = p_instrument_id
    and job.status in ('queued', 'researching')
  order by job.requested_at desc
  for update
  limit 1;
  if v_active.id is not null then
    if v_active.status = 'researching'
       and v_active.claim_expires_at is not null
       and v_active.claim_expires_at <= now() then
      update public.valuation_research_jobs job
      set status = 'queued', claimed_at = null, claimed_by_agent_id = null,
          claim_token = null, claim_expires_at = null, failure_message = null,
          updated_at = now()
      where job.id = v_active.id
      returning * into v_active;
      return jsonb_build_object('created', false, 'requeued', true, 'job', to_jsonb(v_active));
    end if;
    return jsonb_build_object('created', false, 'requeued', false, 'job', to_jsonb(v_active));
  end if;

  select count(*)::integer + 1 into v_sequence
  from public.valuation_research_jobs job
  where job.user_id = v_user
    and job.symbol = upper(btrim(v_instrument.symbol))
    and job.request_period = v_period;
  v_code := upper(btrim(v_instrument.symbol)) || '-' || v_period
    || case when v_sequence > 1 then '-R' || lpad(v_sequence::text, 2, '0') else '' end;

  insert into public.valuation_research_jobs (
    user_id, instrument_id, symbol, request_period, job_code
  ) values (
    v_user, p_instrument_id, upper(btrim(v_instrument.symbol)), v_period, v_code
  ) returning * into v_job;

  return jsonb_build_object('created', true, 'requeued', false, 'job', to_jsonb(v_job));
end;
$$;

create or replace function public.api_agent_complete_valuation_research(
  p_user_id uuid,
  p_agent_id uuid,
  p_job_id uuid,
  p_claim_token uuid,
  p_report_period text,
  p_completed_research jsonb,
  p_completed_valuation jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.valuation_research_jobs;
  v_revision public.valuation_research_revisions;
  v_revision_no integer;
begin
  if not exists (
    select 1 from public.agent_api_tokens token
    where token.id = p_agent_id and token.user_id = p_user_id
      and token.revoked_at is null and (token.expires_at is null or token.expires_at > now())
      and 'valuation:write' = any(token.scopes)
  ) then raise exception 'Agent is not authorized for valuation research'; end if;
  if p_report_period !~ '^\d{4}-Q[1-4]$' then raise exception 'report_period must be YYYY-QN'; end if;
  if jsonb_typeof(p_completed_research) <> 'object'
     or jsonb_typeof(p_completed_valuation) <> 'object' then
    raise exception 'Completed research and valuation must be objects';
  end if;
  if nullif(trim(p_idempotency_key), '') is null
     or char_length(trim(p_idempotency_key)) not between 8 and 180 then
    raise exception 'idempotency_key must contain 8 to 180 characters';
  end if;

  select job.* into v_job
  from public.valuation_research_jobs job
  where job.id = p_job_id and job.user_id = p_user_id
  for update;
  if v_job.id is null then raise exception 'Research job not found'; end if;

  select revision.* into v_revision
  from public.valuation_research_revisions revision
  where revision.user_id = p_user_id
    and revision.idempotency_key = trim(p_idempotency_key);
  if v_revision.id is not null then
    if v_revision.job_id <> p_job_id then
      raise exception 'idempotency_key already belongs to another research job';
    end if;
    return jsonb_build_object(
      'job_id', v_job.id, 'job_code', v_job.job_code, 'revision_id', v_revision.id,
      'revision_no', v_revision.revision_no, 'status', v_revision.status,
      'route', 'watchlist', 'view', 'valuation', 'instrument_id', v_job.instrument_id,
      'idempotent_replay', true
    );
  end if;

  if p_report_period <> v_job.request_period then
    raise exception 'report_period must match the claimed research job period';
  end if;

  if v_job.status <> 'researching' or v_job.claimed_by_agent_id <> p_agent_id
     or v_job.claim_token is distinct from p_claim_token
     or v_job.claim_expires_at is null or v_job.claim_expires_at <= now() then
    raise exception 'Research job claim is missing, expired or owned by another agent';
  end if;

  select coalesce(max(revision.revision_no), 0) + 1 into v_revision_no
  from public.valuation_research_revisions revision
  where revision.user_id = p_user_id and revision.symbol = v_job.symbol;

  insert into public.valuation_research_revisions (
    job_id, user_id, instrument_id, symbol, revision_no, report_period, status,
    research_packet, valuation, brief, completed_research, completed_valuation,
    research_format, idempotency_key, submitted_by_agent_id
  ) values (
    v_job.id, p_user_id, v_job.instrument_id, v_job.symbol, v_revision_no,
    p_report_period, 'draft', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
    p_completed_research, p_completed_valuation, 'ian_completed_v1',
    trim(p_idempotency_key), p_agent_id
  ) returning * into v_revision;

  update public.valuation_research_jobs job
  set status = 'completed', completed_at = now(), claimed_at = null,
      claimed_by_agent_id = null, claim_expires_at = null, claim_token = null,
      updated_at = now()
  where job.id = v_job.id;

  insert into public.pcc_notifications (
    user_id, notification_type, title, preview, route, entity_type, entity_id, dedupe_key
  ) values (
    p_user_id, 'valuation_research', v_job.symbol || ' research is ready',
    left(coalesce(p_completed_research->>'summary', p_completed_research->>'headline',
      'Ian completed the valuation research.'), 500),
    'watchlist', 'valuation_research_revision', v_revision.id,
    'valuation-research:' || v_revision.id::text
  ) on conflict (user_id, dedupe_key) do update
  set title = excluded.title, preview = excluded.preview, read_at = null, created_at = now();

  return jsonb_build_object(
    'job_id', v_job.id, 'job_code', v_job.job_code, 'revision_id', v_revision.id,
    'revision_no', v_revision.revision_no, 'status', v_revision.status,
    'route', 'watchlist', 'view', 'valuation', 'instrument_id', v_job.instrument_id,
    'idempotent_replay', false
  );
end;
$function$;

revoke all on function public.api_agent_complete_valuation_research(
  uuid, uuid, uuid, uuid, text, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function public.api_agent_complete_valuation_research(
  uuid, uuid, uuid, uuid, text, jsonb, jsonb, text
) to service_role;

commit;
