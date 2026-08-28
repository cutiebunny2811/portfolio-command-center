import { createClient } from "npm:@supabase/supabase-js@2";
import {
  X_MONTHLY_POST_TARGET,
  X_POST_READ_USD,
  assessXContent,
  bangkokClock,
  dueXWindow,
  groupXSubscriptions,
  normalizeXHandle,
  reutersSearchQuery,
  xBudgetAllowance,
  xSourcePlan,
} from "./x-core.mjs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
const massiveNewsUrl = "https://api.massive.com/v2/reference/news";
const massive8KUrl = "https://api.massive.com/stocks/filings/8-K/vX/text";
const xApiBaseUrl = "https://api.x.com/2";
const regularLookbackHours = 72;
const maxPages = 5;

const xMacroSignals: Array<[string, RegExp]> = [
  ["FED", /\b(fed|fomc|federal reserve|powell|warsh)\b|เฟด|ธนาคารกลาง/i],
  ["RATES", /\b(rate cut|rate hike|interest rates?|basis points?|bps|treasury|bond yields?|yield curve)\b|ดอกเบี้ย|พันธบัตร/i],
  ["INFLATION", /\b(cpi|ppi|pce|inflation|deflation)\b|เงินเฟ้อ/i],
  ["ECONOMY", /\b(gdp|payrolls?|nonfarm|nfp|unemployment|jobless|recession|economic growth)\b|เศรษฐกิจ|ว่างงาน/i],
  ["POLICY", /\b(tariffs?|sanctions?|white house|congress|treasury department|executive order|regulation)\b|ภาษี|คว่ำบาตร|รัฐบาล/i],
  ["GEOPOLITICS", /\b(iran|israel|russia|ukraine|china|taiwan|war|ceasefire|attack|missile|military)\b|สงคราม|อิหร่าน|อิสราเอล|รัสเซีย|ยูเครน|จีน|ไต้หวัน/i],
  ["COMMODITIES", /\b(oil|crude|opec|gold|silver|natural gas)\b|น้ำมัน|ทองคำ|ก๊าซ/i],
  ["FX_CRYPTO", /\b(dollar|dxy|yen|euro|bitcoin|btc|ethereum|crypto)\b|ดอลลาร์|เยน|บิตคอยน์|คริปโต/i],
];
const xMarketActionPattern = /\b(breaking|urgent|raises?|cuts?|hikes?|holds?|halts?|suspends?|approves?|rejects?|announces?|warns?|misses?|beats?|acquires?|merger|offering|bankrupt(?:cy)?|default|layoffs?|investigation|probe|guidance|forecast)\b|ด่วน|ประกาศ|ขึ้นดอกเบี้ย|ลดดอกเบี้ย|ระงับ|อนุมัติ|ปฏิเสธ|ควบรวม|เพิ่มทุน|ล้มละลาย/i;
const xMarketContextPattern = /\b(stocks?|shares?|market|index|futures?|earnings?|revenue|profit|guidance|sec|doj|ftc|fda|contract|order|acquisition|merger|offering|ipo|bankrupt(?:cy)?|credit|debt)\b|หุ้น|ตลาด|กำไร|รายได้|งบ|บริษัท|เพิ่มทุน|หนี้/i;

type InstrumentScope = {
  userId: string;
  instrumentId: string;
  symbol: string;
  displayName: string;
  isWatchlist: boolean;
  isPortfolio: boolean;
};

type MassiveNews = Record<string, unknown> & {
  id?: string;
  article_url?: string;
  title?: string;
  description?: string;
  published_utc?: string;
  tickers?: string[];
  keywords?: string[];
  publisher?: {
    name?: string;
    homepage_url?: string;
    logo_url?: string;
  };
};

type Massive8K = Record<string, unknown> & {
  accession_number?: string;
  cik?: string;
  filing_date?: string;
  filing_url?: string;
  form_type?: string;
  items_text?: string;
  ticker?: string;
};

type XSubscription = {
  user_id: string;
  source: "x";
  source_key: string;
  display_name?: string | null;
  external_user_id?: string | null;
  last_resource_id?: string | null;
};

type XSourceState = {
  source_key: string;
  display_name?: string | null;
  external_user_id?: string | null;
  last_resource_id?: string | null;
  last_window_key?: string | null;
};

type XUser = {
  id: string;
  name?: string;
  username?: string;
  profile_image_url?: string;
};

type XPost = {
  id: string;
  text?: string;
  created_at?: string;
  lang?: string;
  entities?: {
    cashtags?: Array<{ tag?: string }>;
    urls?: Array<{ expanded_url?: string }>;
  };
  public_metrics?: Record<string, number>;
};

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: jsonHeaders });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function normalizedSymbol(value: unknown): string {
  return String(value || "").trim().toUpperCase();
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

async function fetchMassiveNews(apiKey: string, since: string): Promise<MassiveNews[]> {
  const rows: MassiveNews[] = [];
  let nextUrl: string | null = massiveNewsUrl;
  let page = 0;

  while (nextUrl && page < maxPages) {
    const url = new URL(nextUrl);
    if (url.hostname !== "api.massive.com") throw new Error("Massive returned an unexpected pagination host");
    if (page === 0) {
      url.searchParams.set("published_utc.gte", since);
      url.searchParams.set("order", "desc");
      url.searchParams.set("sort", "published_utc");
      url.searchParams.set("limit", "1000");
    }
    url.searchParams.set("apiKey", apiKey);
    const result = await fetch(url, { headers: { Accept: "application/json" } });
    const payload = await result.json().catch(() => null) as { results?: unknown[]; next_url?: string } | null;
    if (!result.ok) {
      const detail = payload ? JSON.stringify(payload).slice(0, 500) : `HTTP ${result.status}`;
      throw new Error(`Massive News request failed: ${detail}`);
    }
    if (Array.isArray(payload?.results)) {
      rows.push(...payload.results.filter((item): item is MassiveNews => Boolean(item) && typeof item === "object"));
    }
    nextUrl = payload?.next_url || null;
    page += 1;
  }
  return rows;
}

async function fetchMassive8K(apiKey: string, trackedSymbols: Set<string>, since: string): Promise<Massive8K[]> {
  const filings: Massive8K[] = [];
  let nextUrl: string | null = massive8KUrl;
  let page = 0;
  const sinceDate = since.slice(0, 10);

  while (nextUrl && page < maxPages) {
    const url = new URL(nextUrl);
    if (url.hostname !== "api.massive.com") throw new Error("Massive returned an unexpected 8-K pagination host");
    if (page === 0) {
      url.searchParams.set("filing_date.gte", sinceDate);
      url.searchParams.set("form_type", "8-K");
      url.searchParams.set("sort", "filing_date.desc");
      url.searchParams.set("limit", "100");
    }
    url.searchParams.set("apiKey", apiKey);
    const result = await fetch(url, { headers: { Accept: "application/json" } });
    const payload = await result.json().catch(() => null) as { results?: unknown[]; next_url?: string } | null;
    if (!result.ok) {
      const detail = payload ? JSON.stringify(payload).slice(0, 500) : `HTTP ${result.status}`;
      throw new Error(`Massive SEC 8-K request failed: ${detail}`);
    }
    for (const item of payload?.results || []) {
      if (!item || typeof item !== "object") continue;
      const filing = item as Massive8K;
      if (trackedSymbols.has(normalizedSymbol(filing.ticker))) filings.push(filing);
    }
    nextUrl = payload?.next_url || null;
    page += 1;
  }
  return filings;
}

function xBearerHeaders(token: string): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function fetchXUser(token: string, handle: string): Promise<XUser> {
  const normalizedHandle = handle.replace(/^@/, "").trim();
  const url = new URL(`${xApiBaseUrl}/users/by/username/${encodeURIComponent(normalizedHandle)}`);
  url.searchParams.set("user.fields", "id,name,username,profile_image_url");
  const result = await fetch(url, { headers: xBearerHeaders(token) });
  const payload = await result.json().catch(() => null) as { data?: XUser; detail?: string; title?: string } | null;
  if (!result.ok || !payload?.data?.id) {
    throw new Error(`X user lookup failed for @${normalizedHandle}: ${payload?.detail || payload?.title || `HTTP ${result.status}`}`);
  }
  return payload.data;
}

async function fetchXPosts(token: string, state: XSourceState, maxResults: number): Promise<XPost[]> {
  if (!state.external_user_id) throw new Error(`X user ID missing for @${state.source_key}`);
  const url = new URL(`${xApiBaseUrl}/users/${encodeURIComponent(state.external_user_id)}/tweets`);
  url.searchParams.set("exclude", "retweets,replies");
  url.searchParams.set("max_results", String(maxResults));
  url.searchParams.set("tweet.fields", "id,text,created_at,lang,entities,public_metrics");
  if (state.last_resource_id) url.searchParams.set("since_id", state.last_resource_id);
  const result = await fetch(url, { headers: xBearerHeaders(token) });
  const payload = await result.json().catch(() => null) as { data?: XPost[]; detail?: string; title?: string } | null;
  if (!result.ok) {
    throw new Error(`X timeline request failed for @${state.source_key}: ${payload?.detail || payload?.title || `HTTP ${result.status}`}`);
  }
  return Array.isArray(payload?.data) ? payload.data : [];
}

async function fetchReutersPosts(token: string, state: XSourceState, maxResults: number): Promise<XPost[]> {
  const url = new URL(`${xApiBaseUrl}/tweets/search/recent`);
  url.searchParams.set("query", reutersSearchQuery(state.source_key));
  url.searchParams.set("max_results", String(Math.max(maxResults, 10)));
  url.searchParams.set("tweet.fields", "id,text,created_at,lang,entities,public_metrics");
  if (state.last_resource_id) url.searchParams.set("since_id", state.last_resource_id);
  const result = await fetch(url, { headers: xBearerHeaders(token) });
  const payload = await result.json().catch(() => null) as { data?: XPost[]; detail?: string; title?: string } | null;
  if (!result.ok) {
    throw new Error(`X Reuters search failed: ${payload?.detail || payload?.title || `HTTP ${result.status}`}`);
  }
  return Array.isArray(payload?.data) ? payload.data.slice(0, maxResults) : [];
}

function highestResourceId(values: string[]): string | null {
  if (!values.length) return null;
  return values.reduce((highest, current) => {
    try {
      return BigInt(current) > BigInt(highest) ? current : highest;
    } catch {
      return current > highest ? current : highest;
    }
  });
}

function companyAlias(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(incorporated|inc|corporation|corp|company|co|limited|ltd|plc|holdings?|group|common stock|class [a-z])\b/g, " ")
    .replace(/[^a-z0-9ก-๙]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractXTickers(post: XPost, trackedAliases: Map<string, Set<string>>): string[] {
  const trackedSymbols = new Set(trackedAliases.keys());
  const matches = new Set((post.entities?.cashtags || [])
    .map((cashtag) => normalizedSymbol(cashtag.tag))
    .filter((ticker) => ticker && trackedSymbols.has(ticker)));
  const rawText = String(post.text || "");
  for (const token of rawText.match(/\$?[A-Z][A-Z0-9.-]{1,5}\b/g) || []) {
    const symbol = normalizedSymbol(token.replace(/^\$/, ""));
    if (trackedSymbols.has(symbol)) matches.add(symbol);
  }
  const normalizedText = ` ${companyAlias(rawText)} `;
  for (const [symbol, aliases] of trackedAliases) {
    if ([...aliases].some((alias) => alias.length >= 4 && normalizedText.includes(` ${alias} `))) {
      matches.add(symbol);
    }
  }
  return [...matches];
}

function extractExplicitXTickers(post: XPost): string[] {
  const matches = new Set((post.entities?.cashtags || [])
    .map((cashtag) => normalizedSymbol(cashtag.tag))
    .filter(Boolean));
  const rawText = String(post.text || "");
  for (const token of rawText.match(/\$[A-Z][A-Z0-9.-]{1,5}\b/g) || []) {
    const symbol = normalizedSymbol(token.slice(1));
    if (symbol) matches.add(symbol);
  }
  // Thai market accounts commonly write a symbol as “Company (ARM)” instead of $ARM.
  for (const match of rawText.matchAll(/\(([A-Z][A-Z0-9.-]{1,5})\)/g)) {
    const symbol = normalizedSymbol(match[1]);
    if (symbol && !/^(Q[1-4]|FY\d{2,4})$/.test(symbol)) matches.add(symbol);
  }
  return [...matches];
}

function classifyXPost(
  post: XPost,
  trackedAliases: Map<string, Set<string>>,
  sourceKey: string,
): { keep: boolean; tickers: string[]; keywords: string[]; alertLevel: string | null } {
  const text = String(post.text || "").replace(/\s+/g, " ").trim();
  const trackedTickers = extractXTickers(post, trackedAliases);
  const explicitTickers = extractExplicitXTickers(post);
  const tickers = [...new Set([...trackedTickers, ...explicitTickers])];
  const macroTags = xMacroSignals.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag);
  const isMarketEvent = xMarketActionPattern.test(text) && xMarketContextPattern.test(text);
  const keywords = new Set(["X", "ORIGINAL_POST"]);
  if (trackedTickers.length) keywords.add("WATCHLIST_SIGNAL");
  if (explicitTickers.length) keywords.add("TICKER_EVENT");
  if (macroTags.length) {
    keywords.add("MARKET_MACRO");
    macroTags.forEach((tag) => keywords.add(tag));
  }
  if (isMarketEvent) keywords.add("MARKET_EVENT");
  const assessment = assessXContent(sourceKey, { text, tickers });
  const keep = assessment.keep;
  if (assessment.desk) keywords.add(assessment.desk);
  if (assessment.alertLevel) keywords.add(`ALERT_${assessment.alertLevel}`);
  if (keep) keywords.add("X_SIGNAL");
  return { keep, tickers, keywords: [...keywords], alertLevel: assessment.alertLevel };
}

async function storeArticlesAndMatches(
  admin: ReturnType<typeof createClient<any>>,
  source: string,
  articleRows: Record<string, unknown>[],
  scopeBySymbol: Map<string, InstrumentScope[]>,
): Promise<number> {
  if (articleRows.length) {
    const { error } = await admin
      .from("research_articles")
      .upsert(articleRows, { onConflict: "source,source_article_id" });
    if (error) throw error;
  }
  const sourceIds = articleRows.map((row) => String(row.source_article_id));
  const { data: storedArticles, error: articleError } = sourceIds.length
    ? await admin
      .from("research_articles")
      .select("id,source_article_id,tickers")
      .eq("source", source)
      .in("source_article_id", sourceIds)
    : { data: [], error: null };
  if (articleError) throw articleError;

  const matches: Record<string, unknown>[] = [];
  for (const article of (storedArticles || []) as Array<{
    id: string;
    source_article_id: string;
    tickers: string[] | null;
  }>) {
    const matchedScopes = new Map<string, InstrumentScope>();
    for (const ticker of article.tickers || []) {
      for (const scope of scopeBySymbol.get(normalizedSymbol(ticker)) || []) {
        matchedScopes.set(`${scope.userId}:${scope.instrumentId}`, scope);
      }
    }
    for (const scope of matchedScopes.values()) {
      matches.push({
        user_id: scope.userId,
        article_id: article.id,
        instrument_id: scope.instrumentId,
        is_watchlist: scope.isWatchlist,
        is_portfolio: scope.isPortfolio,
      });
    }
  }
  if (matches.length) {
    const { error } = await admin
      .from("research_article_matches")
      .upsert(matches, { onConflict: "user_id,article_id,instrument_id" });
    if (error) throw error;
  }
  return matches.length;
}

async function storeSourceArticleMatches(
  admin: ReturnType<typeof createClient<any>>,
  subscription: XSubscription,
  articleRows: Record<string, unknown>[],
): Promise<number> {
  const sourceIds = articleRows.map((row) => String(row.source_article_id));
  if (!sourceIds.length) return 0;
  const { data: storedArticles, error: articleError } = await admin
    .from("research_articles")
    .select("id,source_article_id")
    .eq("source", subscription.source)
    .in("source_article_id", sourceIds);
  if (articleError) throw articleError;

  const rows = ((storedArticles || []) as Array<{ id: string; source_article_id: string }>).map((article) => ({
    user_id: subscription.user_id,
    article_id: article.id,
    source: subscription.source,
    source_key: subscription.source_key,
  }));
  if (rows.length) {
    const { error } = await admin
      .from("research_source_article_matches")
      .upsert(rows, { onConflict: "user_id,article_id,source,source_key" });
    if (error) throw error;
  }
  return rows.length;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return response({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
    const massiveApiKey = Deno.env.get("MASSIVE_API_KEY")?.trim();
    const xBearerToken = Deno.env.get("X_BEARER_TOKEN")?.trim();
    const xDefaultHandles = (Deno.env.get("X_SOURCE_HANDLES") || "")
      .split(",")
      .map(normalizeXHandle)
      .filter(Boolean);
    const xManagedHandles = [...new Set([...xDefaultHandles, "reuters", "stocksavvyshay"])]
      .filter((handle) => Boolean(xSourcePlan(handle)));
    const syncSecret = Deno.env.get("RESEARCH_SYNC_SECRET")?.trim();
    if (!serviceRoleKey) return response({ error: "SUPABASE_SERVICE_ROLE_KEY is not configured" }, 500);
    if (!massiveApiKey) return response({ error: "MASSIVE_API_KEY is not configured" }, 503);

    const suppliedSecret = request.headers.get("x-sync-secret")?.trim();
    const scheduled = Boolean(syncSecret && suppliedSecret && suppliedSecret === syncSecret);
    const requestedUserId = scheduled ? null : await authenticatedUserId(request);
    if (!scheduled && !requestedUserId) return response({ error: "Authentication required" }, 401);

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    let watchlistQuery = admin
      .from("watchlist_items")
      .select("user_id,instrument_id,instruments!inner(id,symbol,display_name,asset_type)");
    if (requestedUserId) watchlistQuery = watchlistQuery.eq("user_id", requestedUserId);

    let positionQuery = admin
      .from("position_balances")
      .select("instrument_id,quantity,portfolios!inner(user_id),instruments!inner(id,symbol,display_name,asset_type)")
      .gt("quantity", 0);
    if (requestedUserId) positionQuery = positionQuery.eq("portfolios.user_id", requestedUserId);

    const [
      { data: watchlistData, error: watchlistError },
      { data: positionData, error: positionError },
    ] = await Promise.all([watchlistQuery, positionQuery]);
    if (watchlistError) throw watchlistError;
    if (positionError) throw positionError;

    const scopes = new Map<string, InstrumentScope>();
    for (const row of watchlistData || []) {
      const instrument = row.instruments as unknown as { symbol?: string; display_name?: string; asset_type?: string } | null;
      if (!instrument || !["stock", "etf"].includes(String(instrument.asset_type))) continue;
      const symbol = normalizedSymbol(instrument.symbol);
      scopes.set(`${row.user_id}:${row.instrument_id}`, {
        userId: row.user_id,
        instrumentId: row.instrument_id,
        symbol,
        displayName: String(instrument.display_name || symbol),
        isWatchlist: true,
        isPortfolio: false,
      });
    }
    for (const row of positionData || []) {
      const portfolio = row.portfolios as unknown as { user_id?: string } | null;
      const instrument = row.instruments as unknown as { symbol?: string; display_name?: string; asset_type?: string } | null;
      const userId = String(portfolio?.user_id || "");
      if (!userId || !instrument || !["stock", "etf"].includes(String(instrument.asset_type))) continue;
      const key = `${userId}:${row.instrument_id}`;
      const existing = scopes.get(key);
      scopes.set(key, {
        userId,
        instrumentId: row.instrument_id,
        symbol: normalizedSymbol(instrument.symbol),
        displayName: String(instrument.display_name || instrument.symbol || ""),
        isWatchlist: existing?.isWatchlist || false,
        isPortfolio: true,
      });
    }

    if (!scopes.size) return response({ ok: true, tracked: 0, matched_articles: 0, message: "No tracked stocks or ETFs" });

    const since = hoursAgo(regularLookbackHours);
    const scopeBySymbol = new Map<string, InstrumentScope[]>();
    const trackedAliases = new Map<string, Set<string>>();
    for (const scope of scopes.values()) {
      if (!scope.symbol) continue;
      scopeBySymbol.set(scope.symbol, [...(scopeBySymbol.get(scope.symbol) || []), scope]);
      const aliases = trackedAliases.get(scope.symbol) || new Set<string>();
      const displayAlias = companyAlias(scope.displayName);
      if (displayAlias) aliases.add(displayAlias);
      trackedAliases.set(scope.symbol, aliases);
    }
    const news = await fetchMassiveNews(massiveApiKey, since);

    const matchingNews = news.filter((article) =>
      (article.tickers || []).some((ticker) => scopeBySymbol.has(normalizedSymbol(ticker)))
    );
    const articleRows: Record<string, unknown>[] = [];
    for (const article of matchingNews) {
      const canonicalUrl = String(article.article_url || "").trim();
      const title = String(article.title || "").trim();
      const publishedAt = String(article.published_utc || "").trim();
      if (!canonicalUrl || !title || !publishedAt) continue;
      articleRows.push({
        source: "massive",
        source_article_id: String(article.id || await sha256(`${canonicalUrl}|${publishedAt}`)),
        canonical_url: canonicalUrl,
        title,
        description: String(article.description || "").trim() || null,
        publisher_name: String(article.publisher?.name || "").trim() || null,
        publisher_homepage_url: String(article.publisher?.homepage_url || "").trim() || null,
        publisher_logo_url: String(article.publisher?.logo_url || "").trim() || null,
        published_at: publishedAt,
        tickers: [...new Set((article.tickers || []).map(normalizedSymbol).filter(Boolean))],
        keywords: [...new Set((article.keywords || []).map((item) => String(item).trim()).filter(Boolean))],
        raw_payload: article,
        updated_at: new Date().toISOString(),
      });
    }

    const massiveMatches = await storeArticlesAndMatches(admin, "massive", articleRows, scopeBySymbol);

    let secRows: Record<string, unknown>[] = [];
    let secChecked = 0;
    let secMatches = 0;
    let secError: string | null = null;
    try {
      const trackedSymbols = new Set(scopeBySymbol.keys());
      const secFilings = await fetchMassive8K(massiveApiKey, trackedSymbols, since);
      secChecked = secFilings.length;
      secRows = secFilings.map((filing) => {
        const ticker = normalizedSymbol(filing.ticker);
        const filingDate = String(filing.filing_date || "").trim();
        const publishedAt = filingDate ? `${filingDate}T00:00:00.000Z` : new Date().toISOString();
        const itemsText = String(filing.items_text || "").replace(/\s+/g, " ").trim();
        const form = String(filing.form_type || "8-K").trim().toUpperCase();
        return {
          source: "sec-8k",
          source_article_id: String(filing.accession_number || `${ticker}-${filingDate}`),
          canonical_url: String(filing.filing_url || "https://www.sec.gov/edgar/search/"),
          title: `${ticker} filed ${form}`,
          description: itemsText.slice(0, 900) || `Official SEC current report${filingDate ? ` filed ${filingDate}` : ""}. Open the filing to review the reported items and exhibits.`,
          publisher_name: "SEC EDGAR",
          publisher_homepage_url: "https://www.sec.gov/edgar/search/",
          publisher_logo_url: null,
          published_at: publishedAt,
          tickers: [ticker],
          keywords: ["SEC", form, "Current report"],
          raw_payload: filing,
          updated_at: new Date().toISOString(),
        };
      });
      secMatches = await storeArticlesAndMatches(admin, "sec-8k", secRows, scopeBySymbol);
    } catch (error) {
      secError = error instanceof Error ? error.message : String(error);
      console.warn("SEC 8-K sync skipped:", secError);
    }

    const runAt = new Date();
    const now = runAt.toISOString();
    const xClock = bangkokClock(runAt);
    const userIds = [...new Set([...scopes.values()].map((scope) => scope.userId))];
    let xPostsChecked = 0;
    let xPostsFiltered = 0;
    let xArticles = 0;
    let xMatches = 0;
    let xError: string | null = null;
    const xSourceErrors: Record<string, string> = {};
    const xSourceRuns: Record<string, Record<string, unknown>> = {};
    try {
      if (requestedUserId && xManagedHandles.length) {
        const defaults = xManagedHandles.map((handle) => ({
          user_id: requestedUserId,
          source: "x",
          source_key: handle,
          display_name: xSourcePlan(handle)?.displayName || `@${handle}`,
          is_active: true,
          updated_at: now,
        }));
        const { error } = await admin
          .from("research_source_subscriptions")
          .upsert(defaults, { onConflict: "user_id,source,source_key", ignoreDuplicates: true });
        if (error) throw error;
      }

      let subscriptionQuery = admin
        .from("research_source_subscriptions")
        .select("user_id,source,source_key,display_name,external_user_id,last_resource_id")
        .eq("source", "x")
        .eq("is_active", true);
      if (requestedUserId) subscriptionQuery = subscriptionQuery.eq("user_id", requestedUserId);
      const { data: subscriptionData, error: subscriptionError } = await subscriptionQuery;
      if (subscriptionError) throw subscriptionError;
      const subscriptions = (subscriptionData || []) as XSubscription[];

      if (subscriptions.length && !xBearerToken) throw new Error("X_BEARER_TOKEN is not configured");

      const subscriptionGroups = groupXSubscriptions(subscriptions) as Map<string, XSubscription[]>;
      const sourceKeys = [...subscriptionGroups.keys()];
      if (sourceKeys.length) {
        const { error } = await admin
          .from("research_x_source_state")
          .upsert(sourceKeys.map((sourceKey) => ({
            source_key: sourceKey,
            display_name: xSourcePlan(sourceKey)?.displayName || `@${sourceKey}`,
            updated_at: now,
          })), { onConflict: "source_key", ignoreDuplicates: true });
        if (error) throw error;
      }

      const [{ data: stateData, error: stateError }, { data: usageData, error: usageError }] = await Promise.all([
        sourceKeys.length
          ? admin.from("research_x_source_state").select("*").in("source_key", sourceKeys)
          : Promise.resolve({ data: [], error: null }),
        admin.from("research_x_usage_monthly")
          .select("usage_month,source_key,posts_read,requests_made,estimated_cost_usd")
          .eq("usage_month", xClock.monthKey),
      ]);
      if (stateError) throw stateError;
      if (usageError) throw usageError;
      const stateBySource = new Map((stateData || []).map((state) => [String(state.source_key), state as XSourceState]));
      const usageRows = [...(usageData || [])] as Record<string, unknown>[];

      for (const [sourceKey, sourceSubscriptions] of subscriptionGroups) {
        const plan = xSourcePlan(sourceKey);
        if (!plan) continue;
        const windowKey = dueXWindow(sourceKey, runAt, stateBySource.get(sourceKey)?.last_window_key);
        const allowance = xBudgetAllowance(sourceKey, usageRows);
        if (!windowKey || allowance <= 0 || (plan.mode === "search" && allowance < 10)) {
          xSourceRuns[sourceKey] = {
            status: allowance <= 0 ? "budget_exhausted" : "not_due",
            allowance,
            window_key: windowKey,
          };
          continue;
        }

        try {
          const originalState = stateBySource.get(sourceKey) || { source_key: sourceKey };
          let state: XSourceState = {
            ...originalState,
            display_name: originalState.display_name || sourceSubscriptions[0]?.display_name || plan.displayName,
            external_user_id: originalState.external_user_id
              || sourceSubscriptions.find((subscription) => subscription.external_user_id)?.external_user_id
              || null,
            last_resource_id: originalState.last_resource_id
              || sourceSubscriptions.find((subscription) => subscription.last_resource_id)?.last_resource_id
              || null,
          };
          if (plan.mode === "timeline" && !state.external_user_id) {
            const xUser = await fetchXUser(xBearerToken!, sourceKey);
            state = { ...state, external_user_id: xUser.id, display_name: xUser.name || plan.displayName };
          }

          const posts = plan.mode === "search"
            ? await fetchReutersPosts(xBearerToken!, state, allowance)
            : await fetchXPosts(xBearerToken!, state, allowance);
          xPostsChecked += posts.length;
          const { data: recordedUsage, error: recordError } = await admin.rpc("collector_record_x_usage", {
            p_usage_month: xClock.monthKey,
            p_source_key: sourceKey,
            p_posts_read: posts.length,
          });
          if (recordError) throw recordError;
          const usageRecord = recordedUsage as Record<string, unknown>;
          const usageIndex = usageRows.findIndex((row) => normalizeXHandle(row.source_key) === sourceKey);
          if (usageIndex >= 0) usageRows[usageIndex] = usageRecord;
          else usageRows.push(usageRecord);

          const xRows = posts.flatMap((post) => {
            const text = String(post.text || "").replace(/\s+/g, " ").trim();
            const classification = classifyXPost(post, trackedAliases, sourceKey);
            if (!classification.keep) return [];
            const keywords = new Set([...classification.keywords, `@${sourceKey}`]);
            if (plan.briefCandidate) {
              keywords.add("BRIEF_CANDIDATE");
              keywords.add("REUTERS");
            }
            return [{
              source: "x",
              source_article_id: post.id,
              canonical_url: `https://x.com/${sourceKey}/status/${post.id}`,
              title: text || `New post from @${sourceKey}`,
              description: null,
              publisher_name: `X / @${sourceKey}`,
              publisher_homepage_url: `https://x.com/${sourceKey}`,
              publisher_logo_url: null,
              published_at: post.created_at || now,
              tickers: classification.tickers,
              keywords: [...keywords],
              raw_payload: post,
              updated_at: now,
            }];
          });
          xPostsFiltered += posts.length - xRows.length;
          if (xRows.length) {
            const { error } = await admin
              .from("research_articles")
              .upsert(xRows, { onConflict: "source,source_article_id" });
            if (error) throw error;
          }
          for (const subscription of sourceSubscriptions) {
            xMatches += await storeSourceArticleMatches(admin, subscription, xRows);
          }
          xMatches += await storeArticlesAndMatches(admin, "x", xRows, scopeBySymbol);
          xArticles += xRows.length;

          const latestPostId = highestResourceId(posts.map((post) => post.id)) || state.last_resource_id || null;
          const stateUpdate = {
            display_name: state.display_name || plan.displayName,
            external_user_id: state.external_user_id || null,
            last_resource_id: latestPostId,
            last_window_key: windowKey,
            last_checked_at: now,
            last_success_at: now,
            last_error: null,
            updated_at: now,
          };
          const { error: sharedStateError } = await admin
            .from("research_x_source_state")
            .update(stateUpdate)
            .eq("source_key", sourceKey);
          if (sharedStateError) throw sharedStateError;
          const { error: subscriptionStateError } = await admin
            .from("research_source_subscriptions")
            .update({
              display_name: stateUpdate.display_name,
              external_user_id: stateUpdate.external_user_id,
              last_resource_id: latestPostId,
              updated_at: now,
            })
            .eq("source", "x")
            .eq("source_key", sourceKey);
          if (subscriptionStateError) throw subscriptionStateError;
          stateBySource.set(sourceKey, { source_key: sourceKey, ...stateUpdate });
          xSourceRuns[sourceKey] = {
            status: "ok",
            posts_read: posts.length,
            articles_kept: xRows.length,
            window_key: windowKey,
            month_posts: Number(usageRecord.posts_read || 0),
          };
        } catch (error) {
          const detail = errorMessage(error);
          xSourceErrors[sourceKey] = detail;
          xSourceRuns[sourceKey] = { status: "error", error: detail, window_key: windowKey };
          await admin.from("research_x_source_state").update({
            last_checked_at: now,
            last_error: detail,
            updated_at: now,
          }).eq("source_key", sourceKey);
        }
      }
      xError = Object.keys(xSourceErrors).length ? JSON.stringify(xSourceErrors) : null;
    } catch (error) {
      xError = errorMessage(error);
      console.warn("X source sync skipped:", xError);
    }

    const latestPublished = (rows: Record<string, unknown>[]) => rows.reduce<string | null>((latest, row) => {
      const value = String(row.published_at || "");
      return value && (!latest || value > latest) ? value : latest;
    }, null);
    const syncRows = userIds.flatMap((userId) => [
      {
        user_id: userId,
        source: "massive-news",
        last_checked_at: now,
        last_success_at: now,
        last_published_at: latestPublished(articleRows),
        last_error: null,
        updated_at: now,
      },
      {
        user_id: userId,
        source: "sec-8k",
        last_checked_at: now,
        last_success_at: secError ? null : now,
        last_published_at: latestPublished(secRows),
        last_error: secError,
        updated_at: now,
      },
      {
        user_id: userId,
        source: "x-selected",
        last_checked_at: now,
        last_success_at: xError ? null : now,
        last_published_at: null,
        last_error: xError,
        updated_at: now,
      },
    ]);
    const { error: syncError } = await admin
      .from("research_sync_state")
      .upsert(syncRows, { onConflict: "user_id,source" });
    if (syncError) throw syncError;

    return response({
      ok: true,
      users: userIds.length,
      tracked: scopes.size,
      news_checked: news.length,
      sec_8k_checked: secChecked,
      x_posts_checked: xPostsChecked,
      x_posts_filtered: xPostsFiltered,
      matched_articles: articleRows.length + secRows.length + xArticles,
      news_articles: articleRows.length,
      sec_8k_filings: secRows.length,
      x_articles: xArticles,
      x_source_runs: xSourceRuns,
      x_budget: {
        month: xClock.monthKey,
        target_posts: X_MONTHLY_POST_TARGET,
        target_cost_usd: X_MONTHLY_POST_TARGET * X_POST_READ_USD,
      },
      matches: massiveMatches + secMatches + xMatches,
      sec_error: secError,
      x_error: xError,
      since,
      truncated: Boolean(news.length && news.length >= maxPages * 1000),
    });
  } catch (error) {
    console.error(error);
    return response({ error: errorMessage(error) }, 500);
  }
});
