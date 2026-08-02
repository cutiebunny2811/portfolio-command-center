import { createClient } from "npm:@supabase/supabase-js@2";

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

const dateOnly = (date: Date) => date.toISOString().slice(0, 10);
const shiftDays = (date: Date, days: number) => {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
};
const monthWindow = (date: Date) => {
  const from = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const to = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  return { from: dateOnly(from), to: dateOnly(to) };
};
const normalizeHour = (value: unknown) => {
  const hour = String(value || "").toLowerCase();
  return ["bmo", "amc", "dmh"].includes(hour) ? hour : "tbd";
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
const finiteOrNull = (value: unknown) => {
  if (value == null || value === "" || String(value).toLowerCase() === "none") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const normalizedKey = (value: string) => value.replace(/[^a-z0-9]/gi, "").toLowerCase();
const alphaValue = (event: AlphaEvent, ...keys: string[]) => {
  const normalized = new Map(Object.entries(event).map(([key, value]) => [normalizedKey(key), value]));
  for (const key of keys) {
    const value = normalized.get(normalizedKey(key));
    if (value != null) return String(value).trim();
  }
  return "";
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

async function fetchFinnhub(key: string, windowFrom: string, windowTo: string) {
  if (!key) return [] as FinnhubEvent[];
  const jobs: Promise<FinnhubEvent[]>[] = [];
  for (let cursor = new Date(`${windowFrom}T00:00:00Z`); cursor <= new Date(`${windowTo}T00:00:00Z`); cursor = shiftDays(cursor, 7)) {
    const rangeFrom = dateOnly(cursor);
    const rangeTo = dateOnly(new Date(Math.min(
      shiftDays(cursor, 6).getTime(),
      new Date(`${windowTo}T00:00:00Z`).getTime(),
    )));
    jobs.push((async () => {
      const url = new URL("https://finnhub.io/api/v1/calendar/earnings");
      url.searchParams.set("from", rangeFrom);
      url.searchParams.set("to", rangeTo);
      url.searchParams.set("international", "false");
      url.searchParams.set("token", key);
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`Finnhub returned ${response.status} for ${rangeFrom}..${rangeTo}`);
      const payload = await response.json();
      return Array.isArray(payload?.earningsCalendar) ? payload.earningsCalendar : [];
    })());
  }
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
    throw new Error(payload?.Information || payload?.Note || payload?.ErrorMessage || "Alpha Vantage returned JSON instead of its calendar CSV");
  }
  const rows = parseCsv(body);
  if (!rows.length) throw new Error("Alpha Vantage returned an empty earnings calendar");
  return rows;
}

const yahooHeaders = {
  Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
  "User-Agent": "Mozilla/5.0 (compatible; PortfolioCommandCenter/1.0; +https://cutiebunny2811.github.io/portfolio-command-center/)",
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
    redirect: "follow",
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
  let successfulRequests = 0;
  const failures: string[] = [];
  for (let offset = 0; offset < symbols.length; offset += 8) {
    const batch = symbols.slice(offset, offset + 8);
    const results = await Promise.allSettled(batch.map(async (symbol) => {
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
          includeFields: [
            "startdatetime", "timeZoneShortName", "epsestimate", "epsactual", "epssurprisepct", "eventtype",
          ],
        }),
      });
      if (!response.ok) throw new Error(`${symbol}: HTTP ${response.status}`);
      const payload = await response.json();
      if (payload?.finance?.error) throw new Error(`${symbol}: ${payload.finance.error?.description || payload.finance.error?.code || "unknown error"}`);
      return yahooRows(payload, symbol).filter((event) => event.date >= windowFrom && event.date <= windowTo);
    }));
    for (const result of results) {
      if (result.status === "fulfilled") {
        successfulRequests += 1;
        events.push(...result.value);
      } else {
        failures.push(String(result.reason?.message || result.reason));
      }
    }
  }
  if (!successfulRequests && failures.length) throw new Error(`Yahoo ticker lookup failed: ${failures[0]}`);
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
  const syncSecret = Deno.env.get("SYNC_SECRET") || "";
  if (!supabaseUrl || !anonKey || !serviceRoleKey || (!finnhubKey && !alphaKey)) {
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

    const [finnhubResult, alphaResult] = await Promise.allSettled([
      fetchFinnhub(finnhubKey, windowFrom, windowTo),
      fetchAlphaVantage(alphaKey),
    ]);
    const finnhubCalendar = finnhubResult.status === "fulfilled" ? finnhubResult.value : [];
    const alphaCalendar = alphaResult.status === "fulfilled" ? alphaResult.value : [];
    if (!finnhubCalendar.length && !alphaCalendar.length) {
      const reasons = [finnhubResult, alphaResult]
        .filter((result) => result.status === "rejected")
        .map((result) => result.status === "rejected" ? String(result.reason?.message || result.reason) : "")
        .filter(Boolean);
      throw new Error(reasons.join(" | ") || "Calendar providers returned no rows; existing data was preserved");
    }

    const finnhubBySymbol = new Map<string, FinnhubEvent[]>();
    for (const event of finnhubCalendar) {
      const symbol = String(event.symbol || "").trim().toUpperCase();
      const date = String(event.date || "");
      if (!tracked.has(symbol) || date < windowFrom || date > windowTo) continue;
      const list = finnhubBySymbol.get(symbol) || [];
      list.push(event);
      finnhubBySymbol.set(symbol, list);
    }

    const alphaBySymbol = new Map<string, AlphaEvent>();
    for (const event of alphaCalendar) {
      const symbol = alphaValue(event, "symbol", "ticker").toUpperCase();
      const date = alphaValue(event, "reportDate", "earningsDate", "date");
      if (!tracked.has(symbol) || date < windowFrom || date > windowTo) continue;
      if (!alphaBySymbol.has(symbol) || date < alphaValue(alphaBySymbol.get(symbol) || {}, "reportDate", "earningsDate", "date")) {
        alphaBySymbol.set(symbol, event);
      }
    }

    const yahooSymbols = [...tracked].filter((symbol) => {
      const alphaEvent = alphaBySymbol.get(symbol);
      const alphaDate = alphaEvent ? alphaValue(alphaEvent, "reportDate", "earningsDate", "date") : "";
      const finnhubEvents = finnhubBySymbol.get(symbol) || [];
      const finnhubEvent = alphaDate
        ? finnhubEvents.find((event) => String(event.date || "") === alphaDate)
        : finnhubEvents.sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
      return !finnhubEvent || normalizeHour(finnhubEvent.hour) === "tbd";
    });

    let yahooCalendar: YahooEvent[] = [];
    let yahooWarning = "";
    try {
      yahooCalendar = await fetchYahooEarnings(yahooSymbols, windowFrom, windowTo);
    } catch (error) {
      yahooWarning = `Yahoo Finance: ${error instanceof Error ? error.message : String(error)}`;
    }

    const yahooBySymbol = new Map<string, YahooEvent[]>();
    for (const event of yahooCalendar) {
      if (!tracked.has(event.symbol) || event.date < windowFrom || event.date > windowTo) continue;
      const list = yahooBySymbol.get(event.symbol) || [];
      list.push(event);
      yahooBySymbol.set(event.symbol, list);
    }

    const canonical = new Map<string, Record<string, unknown>>();
    for (const symbol of tracked) {
      const alphaEvent = alphaBySymbol.get(symbol);
      const finnhubEvents = finnhubBySymbol.get(symbol) || [];
      const yahooEvents = yahooBySymbol.get(symbol) || [];
      const alphaDate = alphaEvent ? alphaValue(alphaEvent, "reportDate", "earningsDate", "date") : "";
      const exactFinnhub = finnhubEvents.find((event) => String(event.date || "") === alphaDate);
      const finnhubEvent = exactFinnhub || (!alphaEvent ? finnhubEvents.sort((a, b) => String(a.date).localeCompare(String(b.date)))[0] : undefined);
      const yahooFallback = !alphaEvent && !finnhubEvent
        ? yahooEvents.sort((a, b) => a.date.localeCompare(b.date))[0]
        : undefined;
      if (!alphaEvent && !finnhubEvent && !yahooFallback) continue;

      const earningsDate = alphaDate || String(finnhubEvent?.date || yahooFallback?.date || "");
      const yahooEvent = yahooEvents.find((event) => event.date === earningsDate);
      const epsEstimate = alphaEvent
        ? finiteOrNull(alphaValue(alphaEvent, "estimate", "epsEstimate", "estimatedEPS"))
        : finiteOrNull(finnhubEvent?.epsEstimate);
      const payloadSources = [
        alphaEvent ? "alpha_vantage" : "",
        finnhubEvent ? "finnhub" : "",
        yahooEvent ? "yahoo_finance" : "",
      ].filter(Boolean);
      const finnhubHour = normalizeHour(finnhubEvent?.hour);
      canonical.set(symbol, {
        source: "finnhub",
        event_key: `${symbol}:${earningsDate}`,
        symbol,
        earnings_date: earningsDate,
        report_hour: finnhubHour !== "tbd" ? finnhubHour : yahooEvent?.hour || "tbd",
        fiscal_quarter: finnhubEvent?.quarter ?? null,
        fiscal_year: finnhubEvent?.year ?? null,
        eps_estimate: epsEstimate ?? finiteOrNull(finnhubEvent?.epsEstimate),
        eps_actual: finiteOrNull(finnhubEvent?.epsActual),
        revenue_estimate: finiteOrNull(finnhubEvent?.revenueEstimate),
        revenue_actual: finiteOrNull(finnhubEvent?.revenueActual),
        is_active: true,
        raw_payload: {
          providers: payloadSources,
          alpha_vantage: alphaEvent || null,
          finnhub: finnhubEvent || null,
          yahoo_finance: yahooEvent?.raw || null,
        },
        fetched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    const rows = [...canonical.values()];

    const symbols = [...tracked];
    for (let offset = 0; offset < symbols.length; offset += 100) {
      const { error } = await service
        .from("earnings_events")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("source", "finnhub")
        .in("symbol", symbols.slice(offset, offset + 100))
        .gte("earnings_date", windowFrom)
        .lte("earnings_date", windowTo);
      if (error) throw error;
    }

    for (let offset = 0; offset < rows.length; offset += 500) {
      const { error } = await service.from("earnings_events").upsert(rows.slice(offset, offset + 500), { onConflict: "source,event_key" });
      if (error) throw error;
    }

    await service.from("earnings_events").delete().lt("earnings_date", dateOnly(shiftDays(now, -45)));
    await service.from("earnings_events").delete().gt("earnings_date", dateOnly(shiftDays(now, 120)));

    const warnings = [
      finnhubResult.status === "rejected" ? `Finnhub: ${String(finnhubResult.reason?.message || finnhubResult.reason)}` : "",
      alphaResult.status === "rejected" ? `Alpha Vantage: ${String(alphaResult.reason?.message || alphaResult.reason)}` : "",
      yahooWarning,
    ].filter(Boolean);
    const syncRow = {
      source: "finnhub",
      last_checked_at: new Date().toISOString(),
      last_success_at: new Date().toISOString(),
      window_from: windowFrom,
      window_to: windowTo,
      fetched_count: finnhubCalendar.length + alphaCalendar.length + yahooCalendar.length,
      matched_count: rows.length,
      last_error: warnings.length ? warnings.join(" | ") : null,
      updated_at: new Date().toISOString(),
    };
    const { error: syncError } = await service.from("earnings_sync_state").upsert(syncRow, { onConflict: "source" });
    if (syncError) throw syncError;

    return new Response(JSON.stringify({
      updated: rows.length,
      tracked: tracked.size,
      providers: { finnhub: finnhubCalendar.length, alpha_vantage: alphaCalendar.length, yahoo_finance: yahooCalendar.length },
      warnings,
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
