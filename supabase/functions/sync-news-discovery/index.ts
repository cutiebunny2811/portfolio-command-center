import { createClient } from "npm:@supabase/supabase-js@2";
import {
  DISCOVERY_BUCKETS,
  GDELT_FETCH_TIMEOUT_MS,
  GDELT_MIN_REQUEST_GAP_MS,
  GDELT_RETENTION_DAYS,
  buildEvidencePacket,
  buildGdeltUrl,
  clusterDiscoveryArticles,
  normalizeGdeltArticle,
  summarizeLinkedCluster,
} from "./discovery-core.mjs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

type DiscoveryArticle = Record<string, unknown> & {
  source_article_id: string;
  canonical_url: string;
  title: string;
  publisher_name: string;
  published_at: string;
  tickers: string[];
  lane: string;
  domain: string;
  normalized_title: string;
};

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: jsonHeaders });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function authenticatedUserId(request: Request): Promise<string | null> {
  const authorization = request.headers.get("Authorization");
  if (!authorization) return null;
  const client = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
  const { data, error } = await client.auth.getUser();
  return error ? null : data.user?.id || null;
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchBucket(bucket: Record<string, string>): Promise<Record<string, unknown>[]> {
  const result = await fetch(buildGdeltUrl(bucket, { timespan: "2h", maxRecords: 25 }), {
    headers: {
      Accept: "application/json",
      "User-Agent": "PortfolioCommandCenter/1.0 news-discovery",
    },
    signal: AbortSignal.timeout(GDELT_FETCH_TIMEOUT_MS),
  });
  const rawText = await result.text();
  if (!result.ok) {
    throw new Error(`GDELT ${bucket.lane} request failed: HTTP ${result.status} ${rawText.slice(0, 240)}`);
  }
  let payload: { articles?: unknown[] };
  try {
    payload = JSON.parse(rawText);
  } catch {
    throw new Error(`GDELT ${bucket.lane} returned non-JSON data: ${rawText.slice(0, 240)}`);
  }
  return Array.isArray(payload.articles)
    ? payload.articles.filter((article): article is Record<string, unknown> => Boolean(article) && typeof article === "object")
    : [];
}

function databaseArticle(article: DiscoveryArticle): Record<string, unknown> {
  const {
    lane: _lane,
    domain: _domain,
    normalized_title: _normalizedTitle,
    ...row
  } = article;
  return row;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return response({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
    const syncSecret = Deno.env.get("RESEARCH_SYNC_SECRET")?.trim();
    if (!serviceRoleKey) return response({ error: "SUPABASE_SERVICE_ROLE_KEY is not configured" }, 500);

    const suppliedSecret = request.headers.get("x-sync-secret")?.trim();
    const scheduled = Boolean(syncSecret && suppliedSecret && suppliedSecret === syncSecret);
    const requestedUserId = scheduled ? null : await authenticatedUserId(request);
    if (!scheduled && !requestedUserId) return response({ error: "Authentication required" }, 401);

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const bucketRuns: Record<string, Record<string, unknown>> = {};
    const candidateMap = new Map<string, DiscoveryArticle>();

    // GDELT explicitly requests no more than one DOC API call every five
    // seconds. Keep buckets sequential and leave a full six-second gap.
    for (let index = 0; index < DISCOVERY_BUCKETS.length; index += 1) {
      if (index > 0) await delay(GDELT_MIN_REQUEST_GAP_MS);
      const bucket = DISCOVERY_BUCKETS[index];
      try {
        const rows = await fetchBucket(bucket);
        let accepted = 0;
        for (const raw of rows) {
          const normalized = normalizeGdeltArticle(raw, bucket) as DiscoveryArticle | null;
          if (!normalized) continue;
          const existing = candidateMap.get(normalized.source_article_id);
          if (existing) {
            existing.keywords = [...new Set([
              ...((existing.keywords as string[]) || []),
              ...((normalized.keywords as string[]) || []),
            ])];
            continue;
          }
          candidateMap.set(normalized.source_article_id, normalized);
          accepted += 1;
        }
        bucketRuns[bucket.lane] = { status: "ok", fetched: rows.length, accepted };
      } catch (error) {
        bucketRuns[bucket.lane] = { status: "error", error: errorMessage(error) };
      }
    }

    const candidates = [...candidateMap.values()];
    if (candidates.length) {
      const { error } = await admin
        .from("research_articles")
        .upsert(candidates.map(databaseArticle), { onConflict: "source,source_article_id" });
      if (error) throw error;
    }

    const cutoff = new Date(Date.now() - GDELT_RETENTION_DAYS * 24 * 60 * 60_000).toISOString();
    const { data: existingRows, error: existingError } = await admin
      .from("news_discovery_clusters")
      .select("cluster_key,lane,headline,normalized_title,first_seen_at,last_seen_at,article_count,source_count,domains,tickers,importance_score,verification_status")
      .gte("last_seen_at", cutoff);
    if (existingError) throw existingError;

    const clustered = clusterDiscoveryArticles(candidates, existingRows || []);
    const touchedKeys = [...new Set(clustered.assignments.map((assignment: Record<string, unknown>) => String(assignment.cluster_key)))];
    const touchedClusters = clustered.clusters.filter((cluster: Record<string, unknown>) => touchedKeys.includes(String(cluster.cluster_key)));
    if (touchedClusters.length) {
      const now = new Date().toISOString();
      const { error } = await admin
        .from("news_discovery_clusters")
        .upsert(touchedClusters.map((cluster: Record<string, unknown>) => ({
          cluster_key: cluster.cluster_key,
          lane: cluster.lane,
          headline: cluster.headline,
          normalized_title: cluster.normalized_title,
          first_seen_at: cluster.first_seen_at,
          last_seen_at: cluster.last_seen_at,
          article_count: Math.max(Number(cluster.article_count || 1), 1),
          source_count: Math.max(Number(cluster.source_count || 1), 1),
          domains: cluster.domains,
          tickers: cluster.tickers,
          importance_score: cluster.importance_score,
          verification_status: cluster.verification_status,
          raw_context: { collector: "gdelt-doc-2", provisional: true },
          updated_at: now,
        })), { onConflict: "cluster_key" });
      if (error) throw error;
    }

    if (touchedKeys.length) {
      const [{ data: storedArticles, error: articleError }, { data: storedClusters, error: clusterError }] = await Promise.all([
        admin.from("research_articles")
          .select("id,source_article_id")
          .eq("source", "gdelt")
          .in("source_article_id", candidates.map((article) => article.source_article_id)),
        admin.from("news_discovery_clusters")
          .select("id,cluster_key,lane,headline,normalized_title,first_seen_at,last_seen_at,article_count,source_count,domains,tickers,importance_score,verification_status")
          .in("cluster_key", touchedKeys),
      ]);
      if (articleError) throw articleError;
      if (clusterError) throw clusterError;
      const articleIdBySource = new Map((storedArticles || []).map((article) => [String(article.source_article_id), String(article.id)]));
      const clusterByKey = new Map((storedClusters || []).map((cluster) => [String(cluster.cluster_key), cluster]));
      const links = clustered.assignments.flatMap((assignment: Record<string, unknown>) => {
        const articleId = articleIdBySource.get(String(assignment.source_article_id));
        const cluster = clusterByKey.get(String(assignment.cluster_key));
        if (!articleId || !cluster) return [];
        return [{ cluster_id: cluster.id, article_id: articleId, similarity: assignment.similarity }];
      });
      if (links.length) {
        const { error } = await admin
          .from("news_discovery_cluster_articles")
          .upsert(links, { onConflict: "cluster_id,article_id" });
        if (error) throw error;
      }

      const clusterIds = [...clusterByKey.values()].map((cluster) => String(cluster.id));
      const { data: linkedRows, error: linkedError } = await admin
        .from("news_discovery_cluster_articles")
        .select("cluster_id,article:research_articles!inner(source_article_id,title,publisher_name,published_at,tickers)")
        .in("cluster_id", clusterIds);
      if (linkedError) throw linkedError;

      for (const cluster of clusterByKey.values()) {
        const articles = (linkedRows || [])
          .filter((row) => String(row.cluster_id) === String(cluster.id))
          .map((row) => {
            const article = row.article as unknown as Record<string, unknown>;
            return { ...article, domain: article.publisher_name };
          });
        const summary = summarizeLinkedCluster(cluster, articles);
        const { error } = await admin.from("news_discovery_clusters").update({
          headline: summary.headline,
          normalized_title: summary.normalized_title,
          first_seen_at: summary.first_seen_at,
          last_seen_at: summary.last_seen_at,
          article_count: summary.article_count,
          source_count: summary.source_count,
          domains: summary.domains,
          tickers: summary.tickers,
          importance_score: summary.importance_score,
          verification_status: summary.verification_status,
          updated_at: new Date().toISOString(),
        }).eq("id", cluster.id);
        if (error) throw error;
      }
    }

    const { data: activeClusters, error: activeError } = await admin
      .from("news_discovery_clusters")
      .select("cluster_key,lane,headline,normalized_title,first_seen_at,last_seen_at,article_count,source_count,domains,tickers,importance_score,verification_status")
      .gte("last_seen_at", cutoff);
    if (activeError) throw activeError;
    const packet = buildEvidencePacket(activeClusters || []);
    const { error: packetError } = await admin.from("news_evidence_packets").insert({
      generated_at: packet.generated_at,
      mode: packet.mode,
      window_start: cutoff,
      window_end: packet.generated_at,
      cluster_count: packet.cluster_count,
      source_count: packet.source_count,
      payload: packet,
    });
    if (packetError) throw packetError;

    const { data: cleanup, error: cleanupError } = await admin.rpc("collector_cleanup_news_discovery");
    if (cleanupError) throw cleanupError;
    const successfulBuckets = Object.values(bucketRuns).filter((run) => run.status === "ok").length;
    const statusCode = successfulBuckets === 0 && !(activeClusters || []).length ? 503 : 200;
    return response({
      ok: successfulBuckets > 0,
      status: successfulBuckets === DISCOVERY_BUCKETS.length ? "ok" : successfulBuckets > 0 ? "partial" : "cached_only",
      provider: "gdelt-doc-2",
      api_cost_usd: 0,
      buckets: bucketRuns,
      candidates: candidates.length,
      touched_clusters: touchedKeys.length,
      evidence: {
        mode: packet.mode,
        clusters: packet.cluster_count,
        sources: packet.source_count,
        generated_at: packet.generated_at,
      },
      cleanup,
    }, statusCode);
  } catch (error) {
    console.error(error);
    return response({ error: errorMessage(error) }, 500);
  }
});
