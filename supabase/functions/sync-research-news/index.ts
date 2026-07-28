import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
const massiveNewsUrl = "https://api.massive.com/v2/reference/news";
const secTickerIndexUrl = "https://www.sec.gov/files/company_tickers.json";
const secCurrentFilingsUrl = "https://www.sec.gov/cgi-bin/browse-edgar";
const secUserAgent = "PortfolioCommandCenter/1.0 contact https://github.com/cutiebunny2811/portfolio-command-center";
const regularLookbackHours = 72;
const maxPages = 5;
const secMaxPages = 5;

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

type SecFiling = {
  accession: string;
  cik: string;
  company: string;
  canonicalUrl: string;
  filingDate: string | null;
  publishedAt: string;
  form: string;
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

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function xmlTag(entry: string, tag: string): string {
  const match = entry.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return decodeXml(match?.[1]?.trim() || "");
}

function secHeaders(): HeadersInit {
  return {
    Accept: "application/atom+xml, application/json;q=0.9, */*;q=0.1",
    "User-Agent": secUserAgent,
  };
}

async function fetchSecCikSymbols(trackedSymbols: Set<string>): Promise<Map<string, string[]>> {
  const result = await fetch(secTickerIndexUrl, { headers: secHeaders() });
  if (!result.ok) throw new Error(`SEC ticker index request failed: HTTP ${result.status}`);
  const payload = await result.json() as Record<string, { cik_str?: number; ticker?: string }>;
  const symbolsByCik = new Map<string, string[]>();
  for (const row of Object.values(payload || {})) {
    const symbol = normalizedSymbol(row?.ticker);
    const cik = String(row?.cik_str || "").padStart(10, "0");
    if (!symbol || !trackedSymbols.has(symbol) || !/^\d{10}$/.test(cik)) continue;
    symbolsByCik.set(cik, [...new Set([...(symbolsByCik.get(cik) || []), symbol])]);
  }
  return symbolsByCik;
}

function parseSecAtom(xml: string): SecFiling[] {
  const filings: SecFiling[] = [];
  for (const match of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const entry = match[1];
    const title = xmlTag(entry, "title");
    const summary = xmlTag(entry, "summary");
    const publishedAt = xmlTag(entry, "updated") || xmlTag(entry, "published");
    const id = xmlTag(entry, "id");
    const href = decodeXml(entry.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i)?.[1] || "");
    const accession = id.match(/accession-number=([0-9-]+)/i)?.[1]
      || href.match(/([0-9]{10}-[0-9]{2}-[0-9]{6})/)?.[1]
      || "";
    const cik = title.match(/\((\d{10})\)(?:\s+\([^)]+\))?\s*$/)?.[1]
      || href.match(/\/data\/(\d+)\//)?.[1]?.padStart(10, "0")
      || "";
    const form = title.match(/^(8-K(?:\/A)?)/i)?.[1]?.toUpperCase() || "8-K";
    const company = title
      .replace(/^8-K(?:\/A)?\s*-\s*/i, "")
      .replace(/\s+\(\d{10}\)(?:\s+\([^)]+\))?\s*$/, "")
      .trim();
    const filingDate = summary.match(/Filed:\s*<\/b>\s*([0-9-]+)/i)?.[1]
      || summary.match(/Filed:\s*([0-9-]+)/i)?.[1]
      || null;
    if (!accession || !cik || !company || !href || !publishedAt) continue;
    filings.push({ accession, cik, company, canonicalUrl: href, filingDate, publishedAt, form });
  }
  return filings;
}

async function fetchSec8K(symbolsByCik: Map<string, string[]>, since: string): Promise<SecFiling[]> {
  if (!symbolsByCik.size) return [];
  const filings: SecFiling[] = [];
  const cutoff = new Date(since).getTime();
  for (let page = 0; page < secMaxPages; page += 1) {
    const url = new URL(secCurrentFilingsUrl);
    url.searchParams.set("action", "getcurrent");
    url.searchParams.set("type", "8-K");
    url.searchParams.set("company", "");
    url.searchParams.set("dateb", "");
    url.searchParams.set("owner", "include");
    url.searchParams.set("start", String(page * 100));
    url.searchParams.set("count", "100");
    url.searchParams.set("output", "atom");
    const result = await fetch(url, { headers: secHeaders() });
    if (!result.ok) throw new Error(`SEC 8-K feed request failed: HTTP ${result.status}`);
    const pageFilings = parseSecAtom(await result.text());
    filings.push(...pageFilings.filter((filing) => symbolsByCik.has(filing.cik)));
    const oldest = pageFilings.reduce((value, filing) => Math.min(value, new Date(filing.publishedAt).getTime()), Number.POSITIVE_INFINITY);
    if (!pageFilings.length || oldest <= cutoff) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return filings.filter((filing) => new Date(filing.publishedAt).getTime() >= cutoff);
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
      const symbolsByCik = await fetchSecCikSymbols(trackedSymbols);
      const secFilings = await fetchSec8K(symbolsByCik, since);
      secChecked = secFilings.length;
      secRows = secFilings.map((filing) => {
        const tickers = symbolsByCik.get(filing.cik) || [];
        return {
          source: "sec-8k",
          source_article_id: filing.accession,
          canonical_url: filing.canonicalUrl,
          title: `${filing.form} · ${filing.company}`,
          description: `Official SEC current report${filing.filingDate ? ` filed ${filing.filingDate}` : ""}. Open the filing to review the reported items and exhibits.`,
          publisher_name: "SEC EDGAR",
          publisher_homepage_url: "https://www.sec.gov/edgar/search/",
          publisher_logo_url: null,
          published_at: filing.publishedAt,
          tickers,
          keywords: ["SEC", filing.form, "Current report"],
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
