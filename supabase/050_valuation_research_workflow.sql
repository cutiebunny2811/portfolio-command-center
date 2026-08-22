-- Portfolio Command Center: durable Hermes valuation research queue and revisions.
-- Members request research from the Watchlist. A scoped agent claims one job,
-- submits sourced assumptions, and PCC stores the deterministic calculation.

begin;

create table if not exists public.valuation_research_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  instrument_id uuid not null references public.instruments(id) on delete cascade,
  symbol text not null,
  request_period text not null,
  job_code text not null,
  status text not null default 'queued',
  requested_at timestamptz not null default now(),
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  completed_at timestamptz,
  claimed_by_agent_id uuid references public.agent_api_tokens(id) on delete set null,
  claim_token uuid,
  failure_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint valuation_research_jobs_symbol_check check (symbol = upper(btrim(symbol))),
  constraint valuation_research_jobs_period_check check (request_period ~ '^\d{4}-Q[1-4]$'),
  constraint valuation_research_jobs_code_length check (char_length(job_code) between 8 and 80),
  constraint valuation_research_jobs_status_check check (status in ('queued', 'researching', 'completed', 'failed', 'cancelled')),
  constraint valuation_research_jobs_failure_length check (failure_message is null or char_length(failure_message) <= 1200),
  unique (user_id, job_code)
);

create unique index if not exists valuation_research_jobs_one_active_idx
  on public.valuation_research_jobs (user_id, instrument_id)
  where status in ('queued', 'researching');
create index if not exists valuation_research_jobs_queue_idx
  on public.valuation_research_jobs (status, requested_at)
  where status in ('queued', 'researching');
create index if not exists valuation_research_jobs_member_idx
  on public.valuation_research_jobs (user_id, instrument_id, requested_at desc);

create table if not exists public.valuation_research_revisions (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.valuation_research_jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  instrument_id uuid not null references public.instruments(id) on delete cascade,
  symbol text not null,
  revision_no integer not null,
  report_period text not null,
  status text not null default 'draft',
  research_packet jsonb not null,
  valuation jsonb not null,
  brief jsonb not null,
  idempotency_key text not null,
  submitted_by_agent_id uuid references public.agent_api_tokens(id) on delete set null,
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint valuation_research_revisions_symbol_check check (symbol = upper(btrim(symbol))),
  constraint valuation_research_revisions_period_check check (report_period ~ '^\d{4}-Q[1-4]$'),
  constraint valuation_research_revisions_status_check check (status in ('draft', 'published', 'superseded')),
  constraint valuation_research_revisions_revision_check check (revision_no > 0),
  constraint valuation_research_revisions_packet_object check (jsonb_typeof(research_packet) = 'object'),
  constraint valuation_research_revisions_valuation_object check (jsonb_typeof(valuation) = 'object'),
  constraint valuation_research_revisions_brief_object check (jsonb_typeof(brief) = 'object'),
  constraint valuation_research_revisions_idempotency_length check (char_length(idempotency_key) between 8 and 180),
  unique (job_id),
  unique (user_id, symbol, revision_no),
  unique (user_id, idempotency_key)
);

create index if not exists valuation_research_revisions_member_idx
  on public.valuation_research_revisions (user_id, instrument_id, submitted_at desc);

alter table public.valuation_research_jobs enable row level security;
alter table public.valuation_research_revisions enable row level security;

drop policy if exists valuation_research_jobs_select_own on public.valuation_research_jobs;
create policy valuation_research_jobs_select_own on public.valuation_research_jobs
  for select to authenticated using (user_id = auth.uid());
drop policy if exists valuation_research_revisions_select_own on public.valuation_research_revisions;
create policy valuation_research_revisions_select_own on public.valuation_research_revisions
  for select to authenticated using (user_id = auth.uid());

revoke all on public.valuation_research_jobs from public, anon, authenticated;
revoke all on public.valuation_research_revisions from public, anon, authenticated;
grant select on public.valuation_research_jobs to authenticated;
grant select on public.valuation_research_revisions to authenticated;

create or replace function public.pcc_latest_completed_quarter(p_date date default current_date)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_year integer := extract(year from p_date)::integer;
  v_quarter integer := extract(quarter from p_date)::integer - 1;
begin
  if v_quarter = 0 then
    v_quarter := 4;
    v_year := v_year - 1;
  end if;
  return v_year::text || '-Q' || v_quarter::text;
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
  limit 1;
  if v_active.id is not null then
    return jsonb_build_object('created', false, 'job', to_jsonb(v_active));
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

  return jsonb_build_object('created', true, 'job', to_jsonb(v_job));
end;
$$;

create or replace function public.api_get_valuation_research(p_instrument_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'job', (
      select to_jsonb(job)
      from public.valuation_research_jobs job
      where job.user_id = auth.uid() and job.instrument_id = p_instrument_id
      order by job.requested_at desc limit 1
    ),
    'revision', (
      select to_jsonb(revision)
      from public.valuation_research_revisions revision
      where revision.user_id = auth.uid() and revision.instrument_id = p_instrument_id
        and revision.status in ('draft', 'published')
      order by revision.revision_no desc limit 1
    )
  )
  where exists (
    select 1 from public.watchlist_items item
    where item.user_id = auth.uid() and item.instrument_id = p_instrument_id
  );
$$;

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
  set status = 'researching', claimed_at = now(), claim_expires_at = now() + interval '45 minutes',
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

create or replace function public.api_agent_submit_valuation_research(
  p_user_id uuid,
  p_agent_id uuid,
  p_job_id uuid,
  p_claim_token uuid,
  p_report_period text,
  p_research_packet jsonb,
  p_valuation jsonb,
  p_brief jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
  if jsonb_typeof(p_research_packet) <> 'object' or jsonb_typeof(p_valuation) <> 'object'
     or jsonb_typeof(p_brief) <> 'object' then raise exception 'Research packet, valuation and brief must be objects'; end if;
  if nullif(trim(p_idempotency_key), '') is null then raise exception 'idempotency_key is required'; end if;

  select job.* into v_job
  from public.valuation_research_jobs job
  where job.id = p_job_id and job.user_id = p_user_id
  for update;
  if v_job.id is null then raise exception 'Research job not found'; end if;
  if v_job.status <> 'researching' or v_job.claimed_by_agent_id <> p_agent_id
     or v_job.claim_token is distinct from p_claim_token or v_job.claim_expires_at < now() then
    raise exception 'Research job claim is missing, expired or owned by another agent';
  end if;

  select coalesce(max(revision.revision_no), 0) + 1 into v_revision_no
  from public.valuation_research_revisions revision
  where revision.user_id = p_user_id and revision.symbol = v_job.symbol;

  insert into public.valuation_research_revisions (
    job_id, user_id, instrument_id, symbol, revision_no, report_period, status,
    research_packet, valuation, brief, idempotency_key, submitted_by_agent_id
  ) values (
    v_job.id, p_user_id, v_job.instrument_id, v_job.symbol, v_revision_no,
    p_report_period, 'draft', p_research_packet, p_valuation, p_brief,
    trim(p_idempotency_key), p_agent_id
  )
  on conflict (user_id, idempotency_key) do update
  set research_packet = excluded.research_packet,
      valuation = excluded.valuation,
      brief = excluded.brief,
      submitted_at = now()
  returning * into v_revision;

  update public.valuation_research_jobs job
  set status = 'completed', completed_at = now(), claim_expires_at = null,
      claim_token = null, updated_at = now()
  where job.id = v_job.id;

  insert into public.pcc_notifications (
    user_id, notification_type, title, preview, route, entity_type, entity_id, dedupe_key
  ) values (
    p_user_id, 'valuation_research', v_job.symbol || ' research is ready',
    left(coalesce(p_brief->>'summary', p_brief->>'headline', 'Forward valuation research is ready to read.'), 500),
    'watchlist', 'valuation_research_revision', v_revision.id,
    'valuation-research:' || v_revision.id::text
  ) on conflict (user_id, dedupe_key) do update
  set title = excluded.title, preview = excluded.preview, read_at = null, created_at = now();

  return jsonb_build_object(
    'job_id', v_job.id, 'job_code', v_job.job_code, 'revision_id', v_revision.id,
    'revision_no', v_revision.revision_no, 'status', v_revision.status,
    'route', 'watchlist', 'view', 'valuation', 'instrument_id', v_job.instrument_id
  );
end;
$$;

create or replace function public.api_agent_fail_valuation_research(
  p_user_id uuid,
  p_agent_id uuid,
  p_job_id uuid,
  p_claim_token uuid,
  p_message text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.valuation_research_jobs;
begin
  if not exists (
    select 1 from public.agent_api_tokens token
    where token.id = p_agent_id and token.user_id = p_user_id
      and token.revoked_at is null and (token.expires_at is null or token.expires_at > now())
      and 'valuation:write' = any(token.scopes)
  ) then raise exception 'Agent is not authorized for valuation research'; end if;
  update public.valuation_research_jobs job
  set status = 'failed', failure_message = left(nullif(trim(p_message), ''), 1200),
      claim_expires_at = null, claim_token = null, updated_at = now()
  where job.id = p_job_id and job.user_id = p_user_id
    and job.status = 'researching' and job.claimed_by_agent_id = p_agent_id
    and job.claim_token = p_claim_token
  returning * into v_job;
  if v_job.id is null then raise exception 'Research job claim was not found'; end if;
  return jsonb_build_object('job_id', v_job.id, 'job_code', v_job.job_code, 'status', v_job.status);
end;
$$;

alter table public.pcc_notifications drop constraint if exists pcc_notifications_type;
alter table public.pcc_notifications drop constraint if exists pcc_notifications_route;
alter table public.pcc_notifications drop constraint if exists pcc_notifications_entity_type;
alter table public.pcc_notifications add constraint pcc_notifications_type
  check (notification_type in ('daily_brief', 'brief_continuation', 'smart_money_brief', 'valuation_research'));
alter table public.pcc_notifications add constraint pcc_notifications_route
  check (route in ('briefs', 'smart-money', 'smart-money-briefs', 'watchlist'));
alter table public.pcc_notifications add constraint pcc_notifications_entity_type
  check (entity_type in ('market_brief', 'market_brief_update', 'smart_money_brief', 'valuation_research_revision'));

create or replace function public.api_create_agent_token(
  p_name text default 'Hermes',
  p_scopes text[] default array['read', 'drafts:write', 'watchlist:write', 'briefings:write', 'valuation:write']::text[],
  p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_allowed constant text[] := array['read', 'drafts:write', 'watchlist:write', 'briefings:write', 'valuation:write'];
  v_scopes text[];
  v_token text;
  v_id uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if nullif(trim(p_name), '') is null then raise exception 'Token name is required'; end if;
  if char_length(trim(p_name)) > 80 then raise exception 'Token name is too long'; end if;
  if p_expires_at is not null and p_expires_at <= now() then raise exception 'Expiry must be in the future'; end if;
  select array_agg(distinct scope order by scope) into v_scopes
  from unnest(coalesce(p_scopes, array[]::text[])) as scope where scope = any(v_allowed);
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
  values (v_user, 'user', v_user::text, 'create_agent_token', 'agent_api_token', v_id::text,
    jsonb_build_object('name', trim(p_name), 'scopes', to_jsonb(v_scopes), 'expires_at', p_expires_at));
  return jsonb_build_object('token_id', v_id, 'token', v_token, 'name', trim(p_name),
    'scopes', to_jsonb(v_scopes), 'expires_at', p_expires_at);
end;
$$;

update public.agent_api_tokens
set scopes = array_append(scopes, 'valuation:write')
where revoked_at is null
  and (lower(name) like 'hermes%' or lower(name) like 'ian%')
  and not ('valuation:write' = any(scopes));

revoke all on function public.pcc_latest_completed_quarter(date) from public, anon, authenticated;
revoke all on function public.api_request_valuation_research(uuid) from public, anon;
revoke all on function public.api_get_valuation_research(uuid) from public, anon;
revoke all on function public.api_agent_claim_valuation_research_job(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.api_agent_submit_valuation_research(uuid, uuid, uuid, uuid, text, jsonb, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.api_agent_fail_valuation_research(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.api_create_agent_token(text, text[], timestamptz) from public, anon;
grant execute on function public.api_request_valuation_research(uuid) to authenticated;
grant execute on function public.api_get_valuation_research(uuid) to authenticated;
grant execute on function public.api_agent_claim_valuation_research_job(uuid, uuid, uuid) to service_role;
grant execute on function public.api_agent_submit_valuation_research(uuid, uuid, uuid, uuid, text, jsonb, jsonb, jsonb, text) to service_role;
grant execute on function public.api_agent_fail_valuation_research(uuid, uuid, uuid, uuid, text) to service_role;
grant execute on function public.api_create_agent_token(text, text[], timestamptz) to authenticated;

commit;
