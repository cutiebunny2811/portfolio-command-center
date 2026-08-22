-- Keep valuation research recovery aligned with Ian's normal 5-10 minute run time.

begin;

create or replace function public.api_agent_claim_valuation_research_job(
  p_user_id uuid,
  p_agent_id uuid,
  p_job_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.valuation_research_jobs;
  v_claim uuid := gen_random_uuid();
  v_context jsonb;
begin
  if not exists (
    select 1 from public.agent_api_tokens token
    where token.id = p_agent_id and token.user_id = p_user_id
      and token.revoked_at is null and (token.expires_at is null or token.expires_at > now())
      and 'valuation:write' = any(token.scopes)
  ) then raise exception 'Agent is not authorized for valuation research'; end if;

  select job.* into v_job
  from public.valuation_research_jobs job
  where job.user_id = p_user_id
    and (p_job_id is null or job.id = p_job_id)
    and (
      job.status = 'queued'
      or (job.status = 'researching' and job.claim_expires_at < now())
    )
  order by job.requested_at
  for update skip locked
  limit 1;
  if v_job.id is null then return null; end if;

  update public.valuation_research_jobs job
  set status = 'researching', claimed_at = now(), claim_expires_at = now() + interval '15 minutes',
      claimed_by_agent_id = p_agent_id, claim_token = v_claim, failure_message = null, updated_at = now()
  where job.id = v_job.id
  returning * into v_job;

  select jsonb_build_object(
    'job', to_jsonb(v_job),
    'instrument', to_jsonb(instrument),
    'market', (
      select to_jsonb(price_row)
      from public.instrument_prices price_row
      where price_row.user_id = p_user_id and price_row.instrument_id = v_job.instrument_id
      order by price_row.fetched_at desc limit 1
    ),
    'prior_revision', (
      select to_jsonb(revision)
      from public.valuation_research_revisions revision
      where revision.user_id = p_user_id and revision.instrument_id = v_job.instrument_id
      order by revision.revision_no desc limit 1
    ),
    'sec_snapshot', (
      select to_jsonb(snapshot)
      from public.company_valuation_snapshots snapshot
      where snapshot.symbol = v_job.symbol
    )
  ) into v_context
  from public.instruments instrument
  where instrument.id = v_job.instrument_id and instrument.user_id = p_user_id;

  return v_context;
end;
$$;

revoke all on function public.api_agent_claim_valuation_research_job(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.api_agent_claim_valuation_research_job(uuid, uuid, uuid)
  to service_role;

commit;
