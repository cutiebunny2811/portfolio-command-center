-- Portfolio Command Center: shared, budgeted X collection for News and Briefs.
-- Public source posts are fetched once per handle, then linked to each member.
-- Per-member read/saved/hidden state remains private.

begin;

create table if not exists public.research_x_source_state (
  source_key text primary key,
  display_name text,
  external_user_id text,
  last_resource_id text,
  last_window_key text,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint research_x_source_key_format
    check (source_key = lower(source_key) and source_key ~ '^[a-z0-9_]{1,50}$')
);

create table if not exists public.research_x_usage_monthly (
  usage_month date not null,
  source_key text not null,
  posts_read integer not null default 0 check (posts_read >= 0),
  requests_made integer not null default 0 check (requests_made >= 0),
  estimated_cost_usd numeric(10, 4)
    generated always as (posts_read * 0.005) stored,
  updated_at timestamptz not null default now(),
  primary key (usage_month, source_key),
  constraint research_x_usage_month_start
    check (usage_month = date_trunc('month', usage_month)::date)
);

alter table public.research_x_source_state enable row level security;
alter table public.research_x_usage_monthly enable row level security;
revoke all on public.research_x_source_state from public, anon, authenticated;
revoke all on public.research_x_usage_monthly from public, anon, authenticated;

insert into public.research_source_subscriptions (
  user_id, source, source_key, display_name, is_active, updated_at
)
select
  member.user_id, 'x', 'reuters', '@Reuters', true, now()
from public.pcc_members member
where member.onboarding_completed_at is not null
on conflict (user_id, source, source_key) do nothing;

insert into public.research_x_source_state (
  source_key, display_name, external_user_id, last_resource_id, updated_at
)
select distinct on (subscription.source_key)
  lower(subscription.source_key),
  subscription.display_name,
  subscription.external_user_id,
  subscription.last_resource_id,
  now()
from public.research_source_subscriptions subscription
where subscription.source = 'x'
  and subscription.is_active = true
order by subscription.source_key, subscription.updated_at desc
on conflict (source_key) do update
set
  display_name = coalesce(public.research_x_source_state.display_name, excluded.display_name),
  external_user_id = coalesce(public.research_x_source_state.external_user_id, excluded.external_user_id),
  last_resource_id = coalesce(public.research_x_source_state.last_resource_id, excluded.last_resource_id),
  updated_at = now();

insert into public.research_x_source_state (source_key, display_name)
values ('reuters', '@Reuters')
on conflict (source_key) do nothing;

create or replace function public.collector_record_x_usage(
  p_usage_month date,
  p_source_key text,
  p_posts_read integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', coalesce(p_usage_month, current_date))::date;
  v_source text := lower(btrim(coalesce(p_source_key, '')));
  v_posts integer := greatest(coalesce(p_posts_read, 0), 0);
  v_row public.research_x_usage_monthly;
begin
  if v_source !~ '^[a-z0-9_]{1,50}$' then
    raise exception 'Invalid X source key';
  end if;

  insert into public.research_x_usage_monthly (
    usage_month, source_key, posts_read, requests_made, updated_at
  ) values (
    v_month, v_source, v_posts, 1, now()
  )
  on conflict (usage_month, source_key) do update
  set
    posts_read = public.research_x_usage_monthly.posts_read + excluded.posts_read,
    requests_made = public.research_x_usage_monthly.requests_made + 1,
    updated_at = now()
  returning * into v_row;

  return to_jsonb(v_row);
end;
$$;

revoke all on function public.collector_record_x_usage(date, text, integer)
  from public, anon, authenticated;
grant execute on function public.collector_record_x_usage(date, text, integer)
  to service_role;

commit;

