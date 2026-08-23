import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DISCOVERY_BUCKETS,
  GDELT_FETCH_TIMEOUT_MS,
  GDELT_RATE_LIMIT_RETRY_MS,
  GDELT_RETENTION_DAYS,
  buildEvidencePacket,
  buildGdeltUrl,
  canonicalizeUrl,
  clusterDiscoveryArticles,
  normalizeGdeltArticle,
  selectDiscoveryBucket,
} from "../supabase/functions/sync-news-discovery/discovery-core.mjs";

const workflowUrl = new URL("../.github/workflows/sync-news-discovery.yml", import.meta.url);
const migrationUrl = new URL("../supabase/migrations/20260824010000_news_discovery.sql", import.meta.url);
const collectorUrl = new URL("../supabase/functions/sync-news-discovery/index.ts", import.meta.url);
const agentApiUrl = new URL("../supabase/functions/portfolio-agent-api/index.ts", import.meta.url);

test("defines a bounded, market-wide discovery radar", () => {
  assert.equal(DISCOVERY_BUCKETS.length, 4);
  assert.deepEqual(
    DISCOVERY_BUCKETS.map((bucket) => bucket.lane),
    ["market_rates", "market_tape", "earnings_ai", "global_risk"],
  );
  assert.equal(GDELT_RATE_LIMIT_RETRY_MS, 7_000);
  assert.equal(GDELT_FETCH_TIMEOUT_MS, 15_000);
  assert.equal(GDELT_RETENTION_DAYS, 7);

  for (const bucket of DISCOVERY_BUCKETS) {
    const url = new URL(buildGdeltUrl(bucket, { timespan: "2h", maxRecords: 25 }));
    assert.equal(url.origin, "https://api.gdeltproject.org");
    assert.equal(url.pathname, "/api/v2/doc/doc");
    assert.equal(url.searchParams.get("mode"), "artlist");
    assert.equal(url.searchParams.get("format"), "json");
    assert.equal(url.searchParams.get("sort"), "datedesc");
    assert.equal(url.searchParams.get("timespan"), "2h");
    assert.equal(url.searchParams.get("maxrecords"), "25");
    assert.match(url.searchParams.get("query"), /sourcelang:english/);
  }
});

test("rotates one discovery lane per half hour instead of bursting the shared GDELT endpoint", () => {
  const start = new Date("2026-08-24T00:00:00.000Z");
  const cycle = Array.from({ length: 4 }, (_, index) => (
    selectDiscoveryBucket(new Date(start.getTime() + index * 30 * 60_000)).lane
  ));

  assert.equal(new Set(cycle).size, 4);
  assert.equal(
    selectDiscoveryBucket(new Date(start.getTime() + 4 * 30 * 60_000)).lane,
    cycle[0],
  );
});

test("normalizes GDELT rows into the canonical research article contract", () => {
  const raw = {
    url: "https://example.com/markets/story/?utm_source=gdelt&ref=home#top",
    title: "  Wall Street braces for CPI and a Fed test  ",
    seendate: "20260823T181500Z",
    domain: "example.com",
    language: "English",
    sourcecountry: "United States",
    socialimage: "https://example.com/image.jpg",
  };
  const article = normalizeGdeltArticle(raw, DISCOVERY_BUCKETS[0]);

  assert.equal(canonicalizeUrl(raw.url), "https://example.com/markets/story?ref=home");
  assert.equal(article.source, "gdelt");
  assert.match(article.source_article_id, /^gdelt:[0-9a-f]{16}$/);
  assert.equal(article.source_article_id, normalizeGdeltArticle(raw, DISCOVERY_BUCKETS[0]).source_article_id);
  assert.equal(article.canonical_url, "https://example.com/markets/story?ref=home");
  assert.equal(article.title, "Wall Street braces for CPI and a Fed test");
  assert.equal(article.publisher_name, "example.com");
  assert.equal(article.published_at, "2026-08-23T18:15:00.000Z");
  assert.deepEqual(article.tickers, []);
  assert.ok(article.keywords.includes("GDELT_DISCOVERY"));
  assert.ok(article.keywords.includes("MARKET_RATES"));
});

test("clusters reordered coverage of the same event but keeps unrelated stories apart", () => {
  const articles = [
    {
      source_article_id: "one",
      canonical_url: "https://reuters.com/one",
      title: "Nvidia earnings and PCE set to test Wall Street rally",
      publisher_name: "reuters.com",
      published_at: "2026-08-23T12:00:00.000Z",
      lane: "earnings_ai",
      tickers: ["NVDA"],
    },
    {
      source_article_id: "two",
      canonical_url: "https://apnews.com/two",
      title: "Wall Street rally faces Nvidia earnings and PCE test next week",
      publisher_name: "apnews.com",
      published_at: "2026-08-23T13:00:00.000Z",
      lane: "earnings_ai",
      tickers: ["NVDA"],
    },
    {
      source_article_id: "three",
      canonical_url: "https://example.com/three",
      title: "Iran sanctions raise Hormuz oil supply risk",
      publisher_name: "example.com",
      published_at: "2026-08-23T13:30:00.000Z",
      lane: "global_risk",
      tickers: [],
    },
  ];

  const result = clusterDiscoveryArticles(articles);
  assert.equal(result.clusters.length, 2);
  assert.equal(result.assignments.length, 3);

  const earnings = result.clusters.find((cluster) => cluster.lane === "earnings_ai");
  assert.equal(earnings.article_count, 2);
  assert.equal(earnings.source_count, 2);
  assert.equal(earnings.verification_status, "corroborated");
  assert.deepEqual(earnings.tickers, ["NVDA"]);
});

test("builds a compact source-diverse evidence preview without pretending candidates are verified", () => {
  const clusters = [
    ["rates-a", "market_rates", 91, ["reuters.com", "cnbc.com"]],
    ["rates-b", "market_rates", 78, ["wsj.com"]],
    ["rates-c", "market_rates", 65, ["marketwatch.com"]],
    ["tape-a", "market_tape", 84, ["apnews.com", "finance.yahoo.com"]],
    ["ai-a", "earnings_ai", 80, ["reuters.com", "barrons.com"]],
    ["risk-a", "global_risk", 76, ["bbc.com", "aljazeera.com"]],
  ].map(([cluster_key, lane, importance_score, domains], index) => ({
    cluster_key,
    lane,
    headline: `${lane} headline ${index}`,
    last_seen_at: `2026-08-23T${String(18 - index).padStart(2, "0")}:00:00.000Z`,
    first_seen_at: `2026-08-23T${String(17 - index).padStart(2, "0")}:00:00.000Z`,
    article_count: domains.length,
    source_count: domains.length,
    domains,
    tickers: [],
    importance_score,
    verification_status: domains.length > 1 ? "corroborated" : "candidate",
  }));

  const packet = buildEvidencePacket(clusters, {
    now: new Date("2026-08-23T19:00:00.000Z"),
    perLane: 2,
  });

  assert.equal(packet.mode, "weekend_outlook");
  assert.equal(packet.cluster_count, 5);
  assert.equal(packet.lanes.market_rates.length, 2);
  assert.equal(packet.lanes.market_tape.length, 1);
  assert.equal(packet.lanes.earnings_ai.length, 1);
  assert.equal(packet.lanes.global_risk.length, 1);
  assert.ok(packet.source_ledger.includes("reuters.com"));
  assert.ok(packet.caveats.some((line) => /discovery leads/i.test(line)));
  assert.ok(packet.lanes.market_rates.every((cluster) => cluster.verification_status !== "verified"));
});

test("schedules free discovery every thirty minutes and keeps GDELT out of the live brief feed", async () => {
  const [workflow, migration, collector, agentApi] = await Promise.all([
    readFile(workflowUrl, "utf8"),
    readFile(migrationUrl, "utf8"),
    readFile(collectorUrl, "utf8"),
    readFile(agentApiUrl, "utf8"),
  ]);

  assert.match(workflow, /cron: "\*\/30 \* \* \* \*"/);
  assert.match(workflow, /sync-news-discovery/);
  assert.doesNotMatch(workflow, /GDELT_API_KEY|MASSIVE_API_KEY|X_BEARER_TOKEN/);
  assert.match(collector, /selectDiscoveryBucket\(new Date\(\)\)/);
  assert.match(collector, /GDELT_RATE_LIMIT_RETRY_MS/);
  assert.match(collector, /result\.status === 429/);
  assert.match(collector, /const statusCode = selectedSucceeded \? 200 : 503/);
  assert.match(collector, /collector_cleanup_news_discovery/);
  assert.match(agentApi, /\.neq\("source", "gdelt"\)/);

  assert.match(migration, /create table if not exists public\.news_discovery_clusters/i);
  assert.match(migration, /create table if not exists public\.news_discovery_cluster_articles/i);
  assert.match(migration, /create table if not exists public\.news_evidence_packets/i);
  assert.match(migration, /api_get_news_evidence_preview/i);
  assert.match(migration, /collector_cleanup_news_discovery/i);
  assert.match(migration, /source = 'gdelt'/i);
  assert.match(migration, /interval '7 days'/i);
  assert.match(migration, /to authenticated/i);
  assert.match(migration, /to service_role/i);
});
