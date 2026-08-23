export const GDELT_API_URL = "https://api.gdeltproject.org/api/v2/doc/doc";
export const GDELT_MIN_REQUEST_GAP_MS = 6_000;
export const GDELT_FETCH_TIMEOUT_MS = 15_000;
export const GDELT_RETENTION_DAYS = 7;

export const DISCOVERY_BUCKETS = Object.freeze([
  {
    lane: "market_rates",
    label: "Market + rates",
    query: '("Federal Reserve" OR FOMC OR Treasury OR "bond yields" OR inflation OR CPI OR PCE) sourcelang:english',
  },
  {
    lane: "market_tape",
    label: "US market tape",
    query: '("S&P 500" OR Nasdaq OR "Wall Street" OR "stock market" OR "US stocks") sourcelang:english',
  },
  {
    lane: "earnings_ai",
    label: "Earnings + AI",
    query: '(earnings OR Nvidia OR semiconductor OR "artificial intelligence" OR "data center") sourcelang:english',
  },
  {
    lane: "global_risk",
    label: "Global risk",
    query: '(oil OR OPEC OR Hormuz OR Iran OR sanctions OR gold OR tariffs) sourcelang:english',
  },
]);

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "mc_cid",
  "mc_eid",
  "igshid",
]);

const TITLE_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "in", "is", "it",
  "its", "of", "on", "or", "that", "the", "their", "this", "to", "was", "were", "will", "with",
]);

const TRUSTED_DOMAINS = new Set([
  "reuters.com",
  "apnews.com",
  "bloomberg.com",
  "cnbc.com",
  "ft.com",
  "wsj.com",
  "bbc.com",
  "finance.yahoo.com",
  "marketwatch.com",
]);

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stableHash64(value) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const char of String(value)) {
    hash ^= BigInt(char.codePointAt(0));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, "0");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function canonicalizeUrl(value) {
  try {
    const url = new URL(cleanText(value));
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMS.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return cleanText(value);
  }
}

export function buildGdeltUrl(bucket, options = {}) {
  const url = new URL(GDELT_API_URL);
  url.searchParams.set("query", bucket.query);
  url.searchParams.set("mode", "artlist");
  url.searchParams.set("format", "json");
  url.searchParams.set("sort", "datedesc");
  url.searchParams.set("timespan", String(options.timespan || "2h"));
  url.searchParams.set("maxrecords", String(Math.min(Math.max(Number(options.maxRecords || 25), 1), 250)));
  return url.toString();
}

export function parseGdeltDate(value) {
  const text = cleanText(value);
  const match = text.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function normalizeTitle(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/\s+[|\-–—]\s+[^|\-–—]{2,45}$/u, "")
    .replace(/[^a-z0-9$%]+/g, " ")
    .split(" ")
    .filter((token) => token.length > 1 && !TITLE_STOP_WORDS.has(token))
    .join(" ");
}

function titleTokens(value) {
  return new Set(normalizeTitle(value).split(" ").filter(Boolean));
}

export function titleSimilarity(left, right) {
  const a = titleTokens(left);
  const b = titleTokens(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / new Set([...a, ...b]).size;
}

export function normalizeGdeltArticle(raw, bucket) {
  const canonicalUrl = canonicalizeUrl(raw?.url);
  const title = cleanText(raw?.title);
  const publishedAt = parseGdeltDate(raw?.seendate);
  if (!canonicalUrl || !title || !publishedAt) return null;
  let domain = cleanText(raw?.domain).toLowerCase();
  if (!domain) {
    try {
      domain = new URL(canonicalUrl).hostname.replace(/^www\./, "");
    } catch {
      domain = "unknown publisher";
    }
  }
  return {
    source: "gdelt",
    source_article_id: `gdelt:${stableHash64(canonicalUrl)}`,
    canonical_url: canonicalUrl,
    title,
    description: null,
    publisher_name: domain,
    publisher_homepage_url: domain === "unknown publisher" ? null : `https://${domain}`,
    publisher_logo_url: null,
    published_at: publishedAt,
    tickers: [],
    keywords: ["GDELT_DISCOVERY", String(bucket.lane || "").toUpperCase()],
    raw_payload: { ...raw, discovery_lane: bucket.lane },
    lane: bucket.lane,
    domain,
    normalized_title: normalizeTitle(title),
    updated_at: new Date().toISOString(),
  };
}

function clusterScore(cluster) {
  const trustedCount = cluster.domains.filter((domain) => TRUSTED_DOMAINS.has(domain)).length;
  return Math.min(
    100,
    24 + Math.min(cluster.article_count, 5) * 7 + Math.min(cluster.source_count, 4) * 11 + Math.min(trustedCount, 3) * 5,
  );
}

export function summarizeLinkedCluster(baseCluster, articles) {
  const ordered = [...articles]
    .filter((article) => article?.published_at)
    .sort((left, right) => String(left.published_at).localeCompare(String(right.published_at)));
  const latest = ordered.at(-1);
  const domains = unique(ordered.map((article) => cleanText(article.domain || article.publisher_name).toLowerCase()));
  const summary = {
    ...baseCluster,
    headline: cleanText(latest?.title || baseCluster.headline),
    normalized_title: normalizeTitle(baseCluster.normalized_title || baseCluster.headline),
    first_seen_at: ordered[0]?.published_at || baseCluster.first_seen_at,
    last_seen_at: latest?.published_at || baseCluster.last_seen_at,
    article_count: ordered.length || Number(baseCluster.article_count || 1),
    source_count: domains.length || Number(baseCluster.source_count || 1),
    domains: domains.length ? domains : unique(baseCluster.domains || []),
    tickers: unique(ordered.flatMap((article) => article.tickers || []).map((ticker) => cleanText(ticker).toUpperCase())),
  };
  summary.verification_status = summary.source_count >= 2 ? "corroborated" : "candidate";
  summary.importance_score = clusterScore(summary);
  return summary;
}

function newCluster(article) {
  const normalizedTitle = normalizeTitle(article.normalized_title || article.title);
  const domain = cleanText(article.domain || article.publisher_name).toLowerCase();
  return {
    cluster_key: `${article.lane}-${stableHash64(normalizedTitle)}`,
    lane: article.lane,
    headline: cleanText(article.title),
    normalized_title: normalizedTitle,
    first_seen_at: article.published_at,
    last_seen_at: article.published_at,
    article_count: 0,
    source_count: 0,
    domains: domain ? [domain] : [],
    tickers: unique((article.tickers || []).map((ticker) => cleanText(ticker).toUpperCase())),
    importance_score: 0,
    verification_status: "candidate",
    article_keys: [],
  };
}

function addArticle(cluster, article) {
  const articleKey = cleanText(article.source_article_id || article.canonical_url);
  const domain = cleanText(article.domain || article.publisher_name).toLowerCase();
  if (articleKey && !cluster.article_keys.includes(articleKey)) cluster.article_keys.push(articleKey);
  cluster.article_count = Math.max(Number(cluster.article_count || 0), cluster.article_keys.length);
  cluster.domains = unique([...(cluster.domains || []), domain]);
  cluster.source_count = cluster.domains.length;
  cluster.tickers = unique([...(cluster.tickers || []), ...((article.tickers || []).map((ticker) => cleanText(ticker).toUpperCase()))]);
  if (!cluster.first_seen_at || article.published_at < cluster.first_seen_at) cluster.first_seen_at = article.published_at;
  if (!cluster.last_seen_at || article.published_at > cluster.last_seen_at) {
    cluster.last_seen_at = article.published_at;
    cluster.headline = cleanText(article.title);
  }
  cluster.verification_status = cluster.source_count >= 2 ? "corroborated" : "candidate";
  cluster.importance_score = clusterScore(cluster);
}

export function clusterDiscoveryArticles(articles, existingClusters = [], options = {}) {
  const threshold = Number(options.similarityThreshold || 0.5);
  const clusters = existingClusters.map((cluster) => ({
    ...cluster,
    domains: unique(cluster.domains || []),
    tickers: unique(cluster.tickers || []),
    article_keys: unique(cluster.article_keys || []),
  }));
  const assignments = [];
  const ordered = [...articles]
    .filter((article) => article?.lane && article?.title && article?.published_at)
    .sort((left, right) => String(left.published_at).localeCompare(String(right.published_at)));

  for (const article of ordered) {
    let best = null;
    let bestSimilarity = 0;
    for (const cluster of clusters) {
      if (cluster.lane !== article.lane) continue;
      const similarity = titleSimilarity(article.title, cluster.normalized_title || cluster.headline);
      if (similarity > bestSimilarity) {
        best = cluster;
        bestSimilarity = similarity;
      }
    }
    if (!best || bestSimilarity < threshold) {
      best = newCluster(article);
      clusters.push(best);
      bestSimilarity = 1;
    }
    addArticle(best, article);
    assignments.push({
      cluster_key: best.cluster_key,
      source_article_id: article.source_article_id,
      similarity: Number(bestSimilarity.toFixed(4)),
    });
  }

  return { clusters, assignments };
}

function marketMode(now) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(now);
  return weekday === "Sat" || weekday === "Sun" ? "weekend_outlook" : "daily_discovery";
}

export function buildEvidencePacket(clusters, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const perLane = Math.min(Math.max(Number(options.perLane || 2), 1), 4);
  const cutoff = new Date(now.getTime() - GDELT_RETENTION_DAYS * 24 * 60 * 60_000).toISOString();
  const lanes = Object.fromEntries(DISCOVERY_BUCKETS.map((bucket) => [bucket.lane, []]));

  for (const bucket of DISCOVERY_BUCKETS) {
    lanes[bucket.lane] = clusters
      .filter((cluster) => cluster.lane === bucket.lane && String(cluster.last_seen_at || "") >= cutoff)
      .sort((left, right) => Number(right.importance_score || 0) - Number(left.importance_score || 0)
        || String(right.last_seen_at || "").localeCompare(String(left.last_seen_at || "")))
      .slice(0, perLane)
      .map((cluster) => ({
        cluster_key: cluster.cluster_key,
        headline: cluster.headline,
        first_seen_at: cluster.first_seen_at,
        last_seen_at: cluster.last_seen_at,
        article_count: Number(cluster.article_count || 0),
        source_count: Number(cluster.source_count || 0),
        domains: unique(cluster.domains || []),
        tickers: unique(cluster.tickers || []),
        importance_score: Number(cluster.importance_score || 0),
        verification_status: cluster.verification_status === "corroborated" ? "corroborated" : "candidate",
      }));
  }

  const selected = Object.values(lanes).flat();
  const sourceLedger = unique(selected.flatMap((cluster) => cluster.domains)).sort();
  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    mode: marketMode(now),
    lookback_days: GDELT_RETENTION_DAYS,
    cluster_count: selected.length,
    source_count: sourceLedger.length,
    lanes,
    source_ledger: sourceLedger,
    caveats: [
      "GDELT rows are discovery leads, not verified facts. Open an original publisher or official source before publication.",
      "Corroborated means multiple publisher domains reported a similar event; it does not guarantee independent sourcing.",
    ],
  };
}
