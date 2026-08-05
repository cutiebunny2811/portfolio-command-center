import { createClient } from "npm:@supabase/supabase-js@2";
import { buildCanonicalRows, dateOnly, shiftDays } from "./calendar-core.mjs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

type FinnhubEvent = {
  date?: string;
  epsActual?: number | null;
  epsEstimate?: number | null;
  hour?: string | null;
  quarter?: number | null;
  revenueActual?: number | null;
  revenueEstimate?: number | null;
  symbol?: string | null;
  year?: number | null;
};

type AlphaEvent = Record<string, string>;

const monthWindow = (date: Date) => {
  const from = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const to = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  return { from: dateOnly(from), to: dateOnly(to) };
};

function parseCsv(input: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === '"') {
      if (quoted && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(field.trim());
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field.trim());
      field = "";
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else {
      field += character;
    }
  }
  if (field || row.length) {
    row.push(field.trim());
    if (row.some(Boolean)) rows.push(row);
  }
  if (rows.length < 2) return [];
  const headers = rows[0].map((header) => header.replace(/^\uFEFF/, "").trim());
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
}

async function fetchFinnhubRange(key: string, rangeFrom: string, rangeTo: string) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const url = new URL("https://finnhub.io/api/v1/calendar/earnings");
      url.searchParams.set("from", rangeFrom);
      url.searchParams.set("to", rangeTo);
      url.searchParams.set("international", "false");
      url.searchParams.set("token", key);
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`Finnhub returned ${response.status} for ${rangeFrom}..${rangeTo}`);
      const payload = await response.json();
      if (!Array.isArray(payload?.earningsCalendar)) throw new Error(`Finnhub returned an invalid calendar for ${rangeFrom}..${rangeTo}`);
      return payload.earningsCalendar as FinnhubEvent[];
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Finnhub failed for ${rangeFrom}..${rangeTo}`);
}

async function fetchFinnhub(key: string, windowFrom: string, windowTo: string) {
  if (!key) throw new Error("FINNHUB_API_KEY is missing");
  const jobs: Promise<FinnhubEvent[]>[] = [];
  const end = new Date(`${windowTo}T00:00:00Z`);
  for (let cursor = new Date(`${windowFrom}T00:00:00Z`); cursor <= end; cursor = shiftDays(cursor, 7)) {
    const rangeFrom = dateOnly(cursor);
    const rangeTo = dateOnly(new Date(Math.min(shiftDays(cursor, 6).getTime(), end.getTime())));
    jobs.push(fetchFinnhubRange(key, rangeFrom, rangeTo));
  }
  // The month is an all-or-nothing snapshot. A failed week must preserve the
  // previous database state instead of publishing an incomplete calendar.
  return (await Promise.all(jobs)).flat();
}

async function fetchAlphaVantage(key: string) {
  if (!key) return [] as AlphaEvent[];
  const url = new URL("https://www.alphavantage.co/query");
  url.searchParams.set("function", "EARNINGS_CALENDAR");
  url.searchParams.set("horizon", "3month");
  url.searchParams.set("apikey", key);
  const response = await fetch(url, {
    headers: {
      Accept: "text/csv, text/plain;q=0.9, */*;q=0.8",
      "User-Agent": "Mozilla/5.0 (compatible; PortfolioCommandCenter/1.0; +https://cutiebunny2811.github.io/portfolio-command-center/)",
    },
  });
  if (!response.ok) throw new Error(`Alpha Vantage returned ${response.status}`);
  const body = await response.text();
  if (body.trimStart().startsWith("{")) {
    const payload = JSON.parse(body);
    throw new Error(payload?.Information || payload?.Note || payload?.ErrorMessage || "Alpha Vantage returned JSON instead of CSV");
  }
  return parseCsv(body);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: jsonHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const finnhubKey = Deno.env.get("FINNHUB_API_KEY") || "";
  const alphaKey = Deno.env.get("ALPHA_VANTAGE_API_KEY") || "";
  const syncSecret = Deno.env.get("EARNINGS_SYNC_SECRET") || Deno.env.get("SYNC_SECRET") || "";
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !finnhubKey) {
    return new Response(JSON.stringify({ error: "Earnings collector secrets are incomplete" }), { status: 500, headers: jsonHeaders });
  }

  const authorization = request.headers.get("Authorization") || "";
  const suppliedSyncSecret = request.headers.get("x-sync-secret") || "";
  const service = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  if (!syncSecret || suppliedSyncSecret !== syncSecret) {
    const auth = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    });
    const { data: { user }, error: authError } = await auth.auth.getUser();
    if (authError || !user) return new Response(JSON.stringify({ error: "Authentication required" }), { status: 401, headers: jsonHeaders });
  }

  const now = new Date();
  const syncedAt = now.toISOString();
  const { from: windowFrom, to: windowTo } = monthWindow(now);

  try {
    const { data: watchRows, error: watchError } = await service
      .from("watchlist_items")
      .select("instrument:instruments(symbol,asset_type)");
    if (watchError) throw watchError;

    const tracked = new Set<string>();
    for (const row of watchRows || []) {
      const instrument = Array.isArray(row.instrument) ? row.instrument[0] : row.instrument;
      const type = String(instrument?.asset_type || "").toLowerCase();
      const symbol = String(instrument?.symbol || "").trim().toUpperCase();
      if (symbol && ["stock", "etf"].includes(type)) tracked.add(symbol);
    }
    if (!tracked.size) {
      return new Response(JSON.stringify({ updated: 0, tracked: 0, message: "No stock or ETF symbols in watchlists" }), { headers: jsonHeaders });
    }

    const finnhubCalendar = await fetchFinnhub(finnhubKey, windowFrom, windowTo);
    if (!finnhubCalendar.length) throw new Error("Finnhub returned an empty calendar; existing data was preserved");

    let alphaCalendar: AlphaEvent[] = [];
    let alphaWarning = "";
    try {
      alphaCalendar = await fetchAlphaVantage(alphaKey);
    } catch (error) {
      // Alpha is enrichment only. Its outage must never move or remove events.
      alphaWarning = `Alpha Vantage enrichment skipped: ${error instanceof Error ? error.message : String(error)}`;
    }

    const existingByEventKey = new Map<string, Record<string, unknown>>();
    const trackedSymbols = [...tracked];
    for (let offset = 0; offset < trackedSymbols.length; offset += 100) {
      const { data, error } = await service
        .from("earnings_events")
        .select("event_key,fiscal_quarter,fiscal_year,eps_estimate,eps_actual,revenue_estimate,revenue_actual")
        .eq("source", "finnhub")
        .in("symbol", trackedSymbols.slice(offset, offset + 100))
        .gte("earnings_date", windowFrom)
        .lte("earnings_date", windowTo);
      if (error) throw error;
      for (const row of data || []) existingByEventKey.set(String(row.event_key || ""), row);
    }

    const rows = buildCanonicalRows({
      finnhubCalendar,
      alphaCalendar,
      tracked,
      windowFrom,
      windowTo,
      existingByEventKey,
      syncedAt,
    });
    if (!rows.length) throw new Error("Finnhub returned no matching watchlist events; existing data was preserved");

    // Write the new snapshot first. Only after every current row is safe do we
    // retire older rows, preventing a provider or write failure from blanking it.
    for (let offset = 0; offset < rows.length; offset += 500) {
      const { error } = await service.from("earnings_events").upsert(rows.slice(offset, offset + 500), { onConflict: "source,event_key" });
      if (error) throw error;
    }

    for (let offset = 0; offset < trackedSymbols.length; offset += 100) {
      const { error } = await service
        .from("earnings_events")
        .update({ is_active: false, updated_at: syncedAt })
        .eq("source", "finnhub")
        .eq("is_active", true)
        .in("symbol", trackedSymbols.slice(offset, offset + 100))
        .gte("earnings_date", windowFrom)
        .lte("earnings_date", windowTo)
        .lt("fetched_at", syncedAt);
      if (error) throw error;
    }

    await service.from("earnings_events").delete().lt("earnings_date", dateOnly(shiftDays(now, -45)));
    await service.from("earnings_events").delete().gt("earnings_date", dateOnly(shiftDays(now, 120)));

    const syncRow = {
      source: "finnhub",
      last_checked_at: syncedAt,
      last_success_at: syncedAt,
      window_from: windowFrom,
      window_to: windowTo,
      fetched_count: finnhubCalendar.length,
      matched_count: rows.length,
      last_error: alphaWarning || null,
      updated_at: syncedAt,
    };
    const { error: syncError } = await service.from("earnings_sync_state").upsert(syncRow, { onConflict: "source" });
    if (syncError) throw syncError;

    return new Response(JSON.stringify({
      updated: rows.length,
      tracked: tracked.size,
      provider: "finnhub",
      alpha_enriched: alphaCalendar.length > 0,
      warning: alphaWarning || null,
      window_from: windowFrom,
      window_to: windowTo,
    }), { headers: jsonHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await service.from("earnings_sync_state").upsert({
      source: "finnhub",
      last_checked_at: new Date().toISOString(),
      last_error: message,
      updated_at: new Date().toISOString(),
    }, { onConflict: "source" });
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: jsonHeaders });
  }
});
