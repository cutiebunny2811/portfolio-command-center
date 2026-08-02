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
  const response = await fetch(url, { headers: { Accept: "text/csv, text/plain;q=0.9" } });
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

    const canonical = new Map<string, Record<string, unknown>>();
    for (const symbol of tracked) {
      const alphaEvent = alphaBySymbol.get(symbol);
      const finnhubEvents = finnhubBySymbol.get(symbol) || [];
      const alphaDate = alphaEvent ? alphaValue(alphaEvent, "reportDate", "earningsDate", "date") : "";
      const exactFinnhub = finnhubEvents.find((event) => String(event.date || "") === alphaDate);
      const finnhubEvent = exactFinnhub || (!alphaEvent ? finnhubEvents.sort((a, b) => String(a.date).localeCompare(String(b.date)))[0] : undefined);
      if (!alphaEvent && !finnhubEvent) continue;

      const earningsDate = alphaDate || String(finnhubEvent?.date || "");
      const epsEstimate = alphaEvent
        ? finiteOrNull(alphaValue(alphaEvent, "estimate", "epsEstimate", "estimatedEPS"))
        : finiteOrNull(finnhubEvent?.epsEstimate);
      const payloadSources = [alphaEvent ? "alpha_vantage" : "", finnhubEvent ? "finnhub" : ""].filter(Boolean);
      canonical.set(symbol, {
        source: "finnhub",
        event_key: `${symbol}:${earningsDate}`,
        symbol,
        earnings_date: earningsDate,
        report_hour: normalizeHour(finnhubEvent?.hour),
        fiscal_quarter: finnhubEvent?.quarter ?? null,
        fiscal_year: finnhubEvent?.year ?? null,
        eps_estimate: epsEstimate ?? finiteOrNull(finnhubEvent?.epsEstimate),
        eps_actual: finiteOrNull(finnhubEvent?.epsActual),
        revenue_estimate: finiteOrNull(finnhubEvent?.revenueEstimate),
        revenue_actual: finiteOrNull(finnhubEvent?.revenueActual),
        is_active: true,
        raw_payload: { providers: payloadSources, alpha_vantage: alphaEvent || null, finnhub: finnhubEvent || null },
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
    ].filter(Boolean);
    const syncRow = {
      source: "finnhub",
      last_checked_at: new Date().toISOString(),
      last_success_at: new Date().toISOString(),
      window_from: windowFrom,
      window_to: windowTo,
      fetched_count: finnhubCalendar.length + alphaCalendar.length,
      matched_count: rows.length,
      last_error: warnings.length ? warnings.join(" | ") : null,
      updated_at: new Date().toISOString(),
    };
    const { error: syncError } = await service.from("earnings_sync_state").upsert(syncRow, { onConflict: "source" });
    if (syncError) throw syncError;

    return new Response(JSON.stringify({
      updated: rows.length,
      tracked: tracked.size,
      providers: { finnhub: finnhubCalendar.length, alpha_vantage: alphaCalendar.length },
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
