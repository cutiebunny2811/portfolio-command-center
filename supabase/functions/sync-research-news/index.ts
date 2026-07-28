import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
const massiveNewsUrl = "https://api.massive.com/v2/reference/news";
const massive8KUrl = "https://api.massive.com/stocks/filings/8-K/vX/text";
const regularLookbackHours = 72;
const maxPages = 5;

type InstrumentScope = {
  userId: string;
  instrumentId: string;
  symbol: string;
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

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: jsonHeaders });
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

async function storeArticlesAndMatches(
  admin: ReturnType<typeof createClient>,
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
  for (const article of storedArticles || []) {
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

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return response({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
    const massiveApiKey = Deno.env.get("MASSIVE_API_KEY")?.trim();
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
      .select("user_id,instrument_id,instruments!inner(id,symbol,asset_type)");
    if (requestedUserId) watchlistQuery = watchlistQuery.eq("user_id", requestedUserId);

    let positionQuery = admin
      .from("position_balances")
      .select("instrument_id,quantity,portfolios!inner(user_id),instruments!inner(id,symbol,asset_type)")
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
      const instrument = row.instruments as unknown as { symbol?: string; asset_type?: string } | null;
      if (!instrument || !["stock", "etf"].includes(String(instrument.asset_type))) continue;
      const symbol = normalizedSymbol(instrument.symbol);
      scopes.set(`${row.user_id}:${row.instrument_id}`, {
        userId: row.user_id,
        instrumentId: row.instrument_id,
        symbol,
        isWatchlist: true,
        isPortfolio: false,
      });
    }
    for (const row of positionData || []) {
      const portfolio = row.portfolios as unknown as { user_id?: string } | null;
      const instrument = row.instruments as unknown as { symbol?: string; asset_type?: string } | null;
      const userId = String(portfolio?.user_id || "");
      if (!userId || !instrument || !["stock", "etf"].includes(String(instrument.asset_type))) continue;
      const key = `${userId}:${row.instrument_id}`;
      const existing = scopes.get(key);
      scopes.set(key, {
        userId,
        instrumentId: row.instrument_id,
        symbol: normalizedSymbol(instrument.symbol),
        isWatchlist: existing?.isWatchlist || false,
        isPortfolio: true,
      });
    }

    if (!scopes.size) return response({ ok: true, tracked: 0, matched_articles: 0, message: "No tracked stocks or ETFs" });

    const since = hoursAgo(regularLookbackHours);
    const scopeBySymbol = new Map<string, InstrumentScope[]>();
    for (const scope of scopes.values()) {
      if (!scope.symbol) continue;
      scopeBySymbol.set(scope.symbol, [...(scopeBySymbol.get(scope.symbol) || []), scope]);
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

    const now = new Date().toISOString();
    const userIds = [...new Set([...scopes.values()].map((scope) => scope.userId))];
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
      matched_articles: articleRows.length + secRows.length,
      news_articles: articleRows.length,
      sec_8k_filings: secRows.length,
      matches: massiveMatches + secMatches,
      sec_error: secError,
      since,
      truncated: Boolean(news.length && news.length >= maxPages * 1000),
    });
  } catch (error) {
    console.error(error);
    return response({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
