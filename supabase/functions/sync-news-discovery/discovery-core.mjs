export const GDELT_API_URL = "https://api.gdeltproject.org/api/v2/doc/doc";
export const GDELT_RATE_LIMIT_RETRY_MS = 10_000;
export const GDELT_FETCH_TIMEOUT_MS = 20_000;
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
    query: '("S&P 500" OR Nasdaq OR "Dow Jones" OR "Wall Street" OR "stock futures" OR "US stocks") sourcelang:english',
  },
  {
    lane: "earnings_ai",
    label: "Earnings + AI",
    query: '(Nvidia OR "earnings season" OR "S&P 500 earnings" OR semiconductor OR "artificial intelligence" OR "data center" OR "AI spending") sourcelang:english',
  },
  {
    lane: "global_risk",
    label: "Global risk",
    query: '(oil OR OPEC OR Hormuz OR Iran OR sanctions OR gold OR tariffs) sourcelang:english',
  },
]);

export function selectDiscoveryBucket(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const halfHourSlot = Math.floor(date.getTime() / (30 * 60_000));
  const index = ((halfHourSlot % DISCOVERY_BUCKETS.length) + DISCOVERY_BUCKETS.length)
    % DISCOVERY_BUCKETS.length;
  return DISCOVERY_BUCKETS[index];
}

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

const BLOCKED_DISCOVERY_DOMAINS = new Set([
  "accesswire.com",
  "americanbankingnews.com",
  "businesswire.com",
  "dailypolitical.com",
  "defenseworld.net",
  "etfdailynews.com",
  "globenewswire.com",
  "pr-inside.com",
  "prnewswire.com",
  "themarketsdaily.com",
  "tickerreport.com",
]);

const LOW_SIGNAL_HEADLINE = /\b(class action|securities fraud|investors? have opportunity|lead plaintiff|law firm|rating (?:increased|lowered|downgraded|upgraded)|receives? average (?:rating|recommendation)|consensus price target|analysts set|head[- ]to[- ]head|versus its competitors|financial survey)\b/i;

const LANE_HEADLINE_PATTERNS = Object.freeze({
  market_rates: /\b(federal reserve|fed\b|fomc|treasury yields?|bond yields?|bond market|interest rates?|rate cuts?|rate hikes?|inflation|cpi\b|pce\b|payrolls?|jobs report|unemployment|jackson hole)\b/i,
  market_tape: /\b(s&p\s*500|nasdaq|dow jones|wall street|u\.?s\.? stocks?|stock futures|equity futures|russell\s*2000)\b/i,
  earnings_ai: /\b(earnings(?: season)?|nvidia|semiconductors?|chipmakers?|ai infrastructure|ai spending|ai capex|data\s*cent(?:er|re)s?|cloud capex)\b/i,
  global_risk: /\b(brent|wti\b|crude oil|oil prices?|opec\+?|hormuz|iran|houthis?|red sea|middle east|geopolitic(?:al)?|sanctions?|tariffs?|trade war|bullion|gold (?:prices?|futures|rises?|falls?|gains?|slips?|hits?|near))\b/i,
});

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanHeadline(value) {
  return cleanText(value)
    .replace(/\s+([,.;:!?%])/g, "$1")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")");
}

function normalizedDomain(value) {
  return cleanText(value).toLowerCase().replace(/^www\./, "");
}

function domainMatches(domain, candidates) {
  const normalized = normalizedDomain(domain);
  return [...candidates].some((candidate) => normalized === candidate || normalized.endsWith(`.${candidate}`));
}

export function isRelevantDiscoveryArticle(article) {
  const lane = cleanText(article?.lane);
  const title = cleanHeadline(article?.title);
  const domain = normalizedDomain(article?.domain || article?.publisher_name);
  if (!lane || !title || !LANE_HEADLINE_PATTERNS[lane]) return false;
  if (domainMatches(domain, BLOCKED_DISCOVERY_DOMAINS)) return false;
  if (LOW_SIGNAL_HEADLINE.test(title)) return false;
  return LANE_HEADLINE_PATTERNS[lane].test(title);
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
  const title = cleanHeadline(raw?.title);
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
  const trustedCount = cluster.domains.filter((domain) => domainMatches(domain, TRUSTED_DOMAINS)).length;
  const corroborationBonus = cluster.verification_status === "corroborated" ? 12 : 0;
  return Math.min(
    100,
    20
      + Math.min(cluster.article_count, 3) * 4
      + Math.min(cluster.source_count, 3) * 6
      + Math.min(trustedCount, 2) * 18
      + corroborationBonus,
  );
}

export function summarizeLinkedCluster(baseCluster, articles) {
  const ordered = [...articles]
    .filter((article) => article?.published_at)
    .sort((left, right) => String(left.published_at).localeCompare(String(right.published_at)));
  const latest = ordered.at(-1);
  const domains = unique(ordered.map((article) => cleanText(article.domain || article.publisher_name).toLowerCase()));
  const headlineKeys = unique(ordered.map((article) => normalizeTitle(article.title)));
  const summary = {
    ...baseCluster,
    headline: cleanHeadline(latest?.title || baseCluster.headline),
    normalized_title: normalizeTitle(baseCluster.normalized_title || baseCluster.headline),
    first_seen_at: ordered[0]?.published_at || baseCluster.first_seen_at,
    last_seen_at: latest?.published_at || baseCluster.last_seen_at,
    article_count: ordered.length || Number(baseCluster.article_count || 1),
    source_count: domains.length || Number(baseCluster.source_count || 1),
    domains: domains.length ? domains : unique(baseCluster.domains || []),
    tickers: unique(ordered.flatMap((article) => article.tickers || []).map((ticker) => cleanText(ticker).toUpperCase())),
    headline_keys: headlineKeys.length ? headlineKeys : unique(baseCluster.headline_keys || []),
  };
  summary.verification_status = summary.source_count >= 2 && summary.headline_keys.length >= 2
    ? "corroborated"
    : "candidate";
  summary.importance_score = clusterScore(summary);
  return summary;
}

function newCluster(article) {
  const normalizedTitle = normalizeTitle(article.normalized_title || article.title);
  const domain = cleanText(article.domain || article.publisher_name).toLowerCase();
  return {
    cluster_key: `${article.lane}-${stableHash64(normalizedTitle)}`,
    lane: article.lane,
    headline: cleanHeadline(article.title),
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
    headline_keys: normalizedTitle ? [normalizedTitle] : [],
  };
}

function addArticle(cluster, article) {
  const articleKey = cleanText(article.source_article_id || article.canonical_url);
  const domain = cleanText(article.domain || article.publisher_name).toLowerCase();
  const headlineKey = normalizeTitle(article.title);
  if (articleKey && !cluster.article_keys.includes(articleKey)) cluster.article_keys.push(articleKey);
  if (headlineKey && !cluster.headline_keys.includes(headlineKey)) cluster.headline_keys.push(headlineKey);
  cluster.article_count = Math.max(Number(cluster.article_count || 0), cluster.article_keys.length);
  cluster.domains = unique([...(cluster.domains || []), domain]);
  cluster.source_count = cluster.domains.length;
  cluster.tickers = unique([...(cluster.tickers || []), ...((article.tickers || []).map((ticker) => cleanText(ticker).toUpperCase()))]);
  if (!cluster.first_seen_at || article.published_at < cluster.first_seen_at) cluster.first_seen_at = article.published_at;
  if (!cluster.last_seen_at || article.published_at > cluster.last_seen_at) {
    cluster.last_seen_at = article.published_at;
    cluster.headline = cleanHeadline(article.title);
  }
  cluster.verification_status = cluster.source_count >= 2 && cluster.headline_keys.length >= 2
    ? "corroborated"
    : "candidate";
  cluster.importance_score = clusterScore(cluster);
}

export function clusterDiscoveryArticles(articles, existingClusters = [], options = {}) {
  const threshold = Number(options.similarityThreshold || 0.5);
  const clusters = existingClusters.map((cluster) => ({
    ...cluster,
    domains: unique(cluster.domains || []),
    tickers: unique(cluster.tickers || []),
    article_keys: unique(cluster.article_keys || []),
    headline_keys: unique(cluster.headline_keys || [normalizeTitle(cluster.normalized_title || cluster.headline)]),
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
      .filter((cluster) => {
        if (cluster.lane !== bucket.lane || String(cluster.last_seen_at || "") < cutoff) return false;
        const eligibleDomain = (cluster.domains || []).find((domain) => !domainMatches(domain, BLOCKED_DISCOVERY_DOMAINS));
        return isRelevantDiscoveryArticle({
          lane: cluster.lane,
          title: cluster.headline,
          publisher_name: eligibleDomain || cluster.domains?.[0],
        });
      })
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
      "Corroborated means multiple publisher domains reported a similar event with distinct headline wording; it does not guarantee independent sourcing.",
    ],
  };
}
