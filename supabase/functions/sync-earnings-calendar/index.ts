import { createClient } from "npm:@supabase/supabase-js@2";
import { alphaValue, buildCanonicalRows, dateOnly, shiftDays } from "./calendar-core.mjs";

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

type YahooEvent = {
  symbol: string;
  date: string;
  hour: "bmo" | "amc" | "dmh" | "tbd";
  raw: Record<string, unknown>;
};

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
  const rows = parseCsv(body);
  if (!rows.length) throw new Error("Alpha Vantage returned an empty earnings calendar");
  return rows;
}

const yahooHeaders = {
  Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
  "User-Agent": "Mozilla/5.0 (compatible; PortfolioCommandCenter/1.0; +https://cutiebunny2811.github.io/portfolio-command-center/)",
};

const normalizeYahooHour = (value: unknown): YahooEvent["hour"] => {
  const hour = String(value || "").trim().toLowerCase();
  if (["bmo", "before market open", "before open"].includes(hour)) return "bmo";
  if (["amc", "after market close", "after close"].includes(hour)) return "amc";
  if (["dmh", "during market hours"].includes(hour)) return "dmh";
  return "tbd";
};

const inferYahooHour = (start: unknown, label: unknown): YahooEvent["hour"] => {
  const labelled = normalizeYahooHour(label);
  if (labelled !== "tbd") return labelled;
  const match = String(start || "").match(/T(\d{2}):(\d{2})/i);
  if (!match) return "tbd";
  const hour = Number(match[1]);
  if (!Number.isFinite(hour) || hour === 0) return "tbd";
  if (hour <= 14) return "bmo";
  if (hour >= 16) return "amc";
  return "dmh";
};

function yahooCookieFrom(headers: Headers) {
  const setCookie = headers.get("set-cookie") || "";
  const match = setCookie.match(/(?:^|[,;]\s*)A3=([^;,\s]+)/i);
  return match ? `A3=${match[1]}` : "";
}

async function fetchYahooSession() {
  let url = "https://fc.yahoo.com";
  let cookie = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, {
      headers: { ...yahooHeaders, ...(cookie ? { Cookie: cookie } : {}) },
      redirect: "manual",
    });
    cookie ||= yahooCookieFrom(response.headers);
    const location = response.headers.get("location");
    if (!location || response.status < 300 || response.status >= 400) break;
    url = new URL(location, url).toString();
  }
  const crumbResponse = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { ...yahooHeaders, ...(cookie ? { Cookie: cookie } : {}) },
  });
  const crumb = (await crumbResponse.text()).trim();
  if (!crumbResponse.ok || !crumb || crumb.includes("Too Many Requests") || crumb.includes("<html")) {
    throw new Error(`Yahoo session returned ${crumbResponse.status}`);
  }
  return { cookie, crumb };
}

function yahooRows(payload: any, forcedSymbol = ""): YahooEvent[] {
  const document = payload?.finance?.result?.[0]?.documents?.[0];
  const columns = Array.isArray(document?.columns) ? document.columns : [];
  const rows = Array.isArray(document?.rows) ? document.rows : [];
  if (!columns.length || !rows.length) return [];
  const labels = columns.map((column: any) => {
    const label = String(column?.label || column?.field || column?.id || "").trim();
    if (label === "Event Start Date" && String(column?.type || "").toUpperCase() === "STRING") return "Timing";
    return label;
  });
  return rows.map((values: unknown[]) => {
    const raw = Object.fromEntries(labels.map((label: string, index: number) => [label, values?.[index] ?? null]));
    const symbol = String(forcedSymbol || raw.Symbol || raw.Ticker || raw.ticker || "").trim().toUpperCase();
    const start = String(raw["Event Start Date"] || raw.startdatetime || "");
    return {
      symbol,
      date: start.slice(0, 10),
      hour: inferYahooHour(start, raw.Timing || raw.startdatetimetype || raw.timeZoneShortName),
      raw,
    };
  }).filter((event: YahooEvent) => event.symbol && event.date);
}

async function fetchYahooEarnings(symbols: string[], windowFrom: string, windowTo: string) {
  if (!symbols.length) return [] as YahooEvent[];
  const session = await fetchYahooSession();
  const events: YahooEvent[] = [];
  for (let offset = 0; offset < symbols.length; offset += 6) {
    const batch = symbols.slice(offset, offset + 6);
    const results = await Promise.all(batch.map(async (symbol) => {
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const url = new URL("https://query1.finance.yahoo.com/v1/finance/visualization");
          url.searchParams.set("lang", "en-US");
          url.searchParams.set("region", "US");
          url.searchParams.set("crumb", session.crumb);
          const response = await fetch(url, {
            method: "POST",
            headers: {
              ...yahooHeaders,
              "Content-Type": "application/json",
              ...(session.cookie ? { Cookie: session.cookie } : {}),
            },
            body: JSON.stringify({
              size: 8,
              offset: 0,
              query: { operator: "eq", operands: ["ticker", symbol] },
              sortField: "startdatetime",
              sortType: "DESC",
              entityIdType: "earnings",
              includeFields: ["startdatetime", "timeZoneShortName", "epsestimate", "epsactual", "eventtype"],
            }),
          });
          if (!response.ok) throw new Error(`${symbol}: HTTP ${response.status}`);
          const payload = await response.json();
          if (payload?.finance?.error) throw new Error(`${symbol}: ${payload.finance.error?.description || payload.finance.error?.code || "unknown error"}`);
          return yahooRows(payload, symbol).filter((event) => event.date >= windowFrom && event.date <= windowTo);
        } catch (error) {
          lastError = error;
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
        }
      }
      throw lastError instanceof Error ? lastError : new Error(`${symbol}: Yahoo lookup failed`);
    }));
    events.push(...results.flat());
  }
  return events;
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
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !finnhubKey || !alphaKey) {
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

    const alphaCalendar = await fetchAlphaVantage(alphaKey);

    const finnhubSymbols = new Set(
      finnhubCalendar
        .filter((event) => String(event?.date || "") >= windowFrom && String(event?.date || "") <= windowTo)
        .map((event) => String(event?.symbol || "").trim().toUpperCase())
        .filter((symbol) => tracked.has(symbol)),
    );
    const yahooCandidateSymbols = [...new Set(
      alphaCalendar
        .filter((event) => {
          const symbol = alphaValue(event, "symbol", "ticker").toUpperCase();
          const date = alphaValue(event, "reportDate", "earningsDate", "date");
          return tracked.has(symbol) && !finnhubSymbols.has(symbol) && date >= windowFrom && date <= windowTo;
        })
        .map((event) => alphaValue(event, "symbol", "ticker").toUpperCase()),
    )].sort();
    // Yahoo is queried only for the small set of Alpha candidates that
    // Finnhub omitted. Any Yahoo failure aborts the refresh so the previous
    // complete snapshot stays active.
    const yahooCalendar = await fetchYahooEarnings(yahooCandidateSymbols, windowFrom, windowTo);

    const existingByEventKey = new Map<string, Record<string, unknown>>();
    const trackedSymbols = [...tracked];
    for (let offset = 0; offset < trackedSymbols.length; offset += 100) {
      const { data, error } = await service
        .from("earnings_events")
        .select("event_key,fiscal_quarter,fiscal_year,eps_estimate,eps_actual,revenue_estimate,revenue_actual,raw_payload,report_hour,is_active")
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
      yahooCalendar,
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
      fetched_count: finnhubCalendar.length + alphaCalendar.length + yahooCalendar.length,
      matched_count: rows.length,
      last_error: null,
      updated_at: syncedAt,
    };
    const { error: syncError } = await service.from("earnings_sync_state").upsert(syncRow, { onConflict: "source" });
    if (syncError) throw syncError;

    return new Response(JSON.stringify({
      updated: rows.length,
      tracked: tracked.size,
      provider: "finnhub",
      providers: {
        finnhub: finnhubCalendar.length,
        alpha_vantage: alphaCalendar.length,
        yahoo_finance: yahooCalendar.length,
      },
      fallback_candidates: yahooCandidateSymbols.length,
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
