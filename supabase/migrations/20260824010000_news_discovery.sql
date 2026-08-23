-- GDELT discovery radar, event clusters, and pre-brief evidence previews.
-- Raw discovery leads remain isolated from the published Daily Market Brief.

begin;

create table if not exists public.news_discovery_clusters (
  id uuid primary key default gen_random_uuid(),
  cluster_key text not null unique,
  lane text not null check (lane in ('market_rates', 'market_tape', 'earnings_ai', 'global_risk')),
  headline text not null,
  normalized_title text not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  article_count integer not null default 1 check (article_count >= 1),
  source_count integer not null default 1 check (source_count >= 1),
  domains text[] not null default '{}'::text[],
  tickers text[] not null default '{}'::text[],
  importance_score numeric(5,2) not null default 0,
  verification_status text not null default 'candidate'
    check (verification_status in ('candidate', 'corroborated')),
  raw_context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists news_discovery_clusters_recent_idx
  on public.news_discovery_clusters (last_seen_at desc, importance_score desc);
create index if not exists news_discovery_clusters_lane_idx
  on public.news_discovery_clusters (lane, last_seen_at desc);

create table if not exists public.news_discovery_cluster_articles (
  cluster_id uuid not null references public.news_discovery_clusters(id) on delete cascade,
  article_id uuid not null references public.research_articles(id) on delete cascade,
  similarity numeric(5,4) not null default 1 check (similarity >= 0 and similarity <= 1),
  created_at timestamptz not null default now(),
  primary key (cluster_id, article_id)
);

create index if not exists news_discovery_cluster_articles_article_idx
  on public.news_discovery_cluster_articles (article_id);

create table if not exists public.news_evidence_packets (
  id uuid primary key default gen_random_uuid(),
  generated_at timestamptz not null default now(),
  mode text not null check (mode in ('daily_discovery', 'weekend_outlook')),
  window_start timestamptz not null,
  window_end timestamptz not null,
  cluster_count integer not null default 0 check (cluster_count >= 0),
  source_count integer not null default 0 check (source_count >= 0),
  payload jsonb not null,
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now()
);

create index if not exists news_evidence_packets_generated_idx
  on public.news_evidence_packets (generated_at desc);

alter table public.news_discovery_clusters enable row level security;
alter table public.news_discovery_cluster_articles enable row level security;
alter table public.news_evidence_packets enable row level security;

-- Discovery storage is canonical and shared. Only the service role writes or
-- reads these tables directly; members receive the bounded packet below.
revoke all on public.news_discovery_clusters from public, anon, authenticated;
revoke all on public.news_discovery_cluster_articles from public, anon, authenticated;
revoke all on public.news_evidence_packets from public, anon, authenticated;

create or replace function public.api_get_news_evidence_preview()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_packet public.news_evidence_packets;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select packet.* into v_packet
  from public.news_evidence_packets packet
  where packet.expires_at > now()
  order by packet.generated_at desc
  limit 1;

  if v_packet.id is null then
    return jsonb_build_object(
      'status', 'empty',
      'message', 'No discovery evidence packet has been generated yet.'
    );
  end if;

  return jsonb_build_object(
    'status', 'ready',
    'id', v_packet.id,
    'generated_at', v_packet.generated_at,
    'mode', v_packet.mode,
    'window_start', v_packet.window_start,
    'window_end', v_packet.window_end,
    'cluster_count', v_packet.cluster_count,
    'source_count', v_packet.source_count,
    'payload', v_packet.payload
  );
end;
$$;

create or replace function public.collector_cleanup_news_discovery()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_articles integer := 0;
  v_clusters integer := 0;
  v_packets integer := 0;
begin
  delete from public.news_evidence_packets
  where generated_at < now() - interval '7 days'
     or expires_at <= now();
  get diagnostics v_packets = row_count;

  -- Only free GDELT radar rows are short-lived. Massive, SEC and X retention
  -- remains unchanged.
  delete from public.research_articles
  where source = 'gdelt'
    and published_at < now() - interval '7 days';
  get diagnostics v_articles = row_count;

  delete from public.news_discovery_clusters cluster
  where cluster.last_seen_at < now() - interval '7 days'
     or not exists (
       select 1
       from public.news_discovery_cluster_articles link
       where link.cluster_id = cluster.id
     );
  get diagnostics v_clusters = row_count;

  return jsonb_build_object(
    'retention_days', 7,
    'deleted_articles', v_articles,
    'deleted_clusters', v_clusters,
    'deleted_packets', v_packets
  );
end;
$$;

revoke all on function public.api_get_news_evidence_preview() from public, anon;
revoke all on function public.collector_cleanup_news_discovery() from public, anon, authenticated;
grant execute on function public.api_get_news_evidence_preview() to authenticated;
grant execute on function public.collector_cleanup_news_discovery() to service_role;

commit;
