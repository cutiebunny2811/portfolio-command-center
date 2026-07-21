import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
const snapshotPath = "/openapi/market-data/stock/snapshot";
const barsPath = "/openapi/market-data/stock/bars";
const refreshWindowMs = 15 * 60_000;

type Instrument = {
  id: string;
  symbol: string;
  asset_type: "stock" | "etf";
};

type PriceResult = {
  instrument: Instrument;
  price: number;
  marketTime: string;
};

type ChartBar = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type ChartTimespan = "D" | "M60" | "M240";

function chartTimespan(value: unknown): ChartTimespan {
  const normalized = String(value || "D").trim().toUpperCase();
  if (normalized === "D" || normalized === "M60" || normalized === "M240") return normalized;
  throw new Error("Unsupported chart timespan");
}

function utcDay(value: string): string {
  return value.slice(0, 10);
}

// Webull's D endpoint can remain at the previous completed daily candle while
// the market is open. Build a provisional current-day candle from hourly bars
// so the daily chart is live without replacing its historical data source.
function mergeLiveDailyBar(dailyBars: ChartBar[], hourlyBars: ChartBar[], snapshot: PriceResult | null): ChartBar[] {
  if (!dailyBars.length || !hourlyBars.length) return dailyBars;
  const latestHourly = hourlyBars[hourlyBars.length - 1];
  const day = utcDay(latestHourly.time);
  const session = hourlyBars.filter((bar) => utcDay(bar.time) === day);
  if (!session.length) return dailyBars;

  const snapshotPrice = snapshot && utcDay(snapshot.marketTime) === day ? snapshot.price : null;
  const close = snapshotPrice ?? latestHourly.close;
  const liveBar: ChartBar = {
    time: dailyBars.find((bar) => utcDay(bar.time) === day)?.time || latestHourly.time,
    open: session[0].open,
    high: Math.max(...session.map((bar) => bar.high), close),
    low: Math.min(...session.map((bar) => bar.low), close),
    close,
    volume: session.reduce((sum, bar) => sum + bar.volume, 0),
  };
  return [...dailyBars.filter((bar) => utcDay(bar.time) !== day), liveBar]
    .sort((a, b) => a.time.localeCompare(b.time));
}

function timestampUtc(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function bytesToBase64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

async function makeSignature(
  path: string,
  query: Record<string, string>,
  appKey: string,
  appSecret: string,
  host: string,
  timestamp: string,
  nonce: string,
): Promise<string> {
  const values: Record<string, string> = {
    ...query,
    host,
    "x-app-key": appKey,
    "x-signature-algorithm": "HMAC-SHA1",
    "x-signature-nonce": nonce,
    "x-signature-version": "1.0",
    "x-timestamp": timestamp,
  };
  const sorted = Object.keys(values).sort().map((key) => `${key}=${values[key]}`).join("&");
  const encoded = encodeURIComponent(`${path}&${sorted}`);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`${appSecret}&`),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded));
  return bytesToBase64(new Uint8Array(signature));
}

function marketValue(snapshot: Record<string, unknown>): { price: number; marketTime: string } | null {
  const nested = ["pre_market", "after_hours", "overnight"]
    .map((key) => snapshot[key])
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value));
  const candidates = [snapshot, ...nested].map((value) => {
    const rawPrice = value.price ?? value.latest_price ?? value.last_price ?? value.close;
    const price = Number(rawPrice);
    const rawTime = value.last_trade_time ?? value.timestamp ?? value.time;
    const numericTime = Number(rawTime);
    const parsedTime = Number.isFinite(numericTime)
      ? new Date(numericTime < 10_000_000_000 ? numericTime * 1000 : numericTime)
      : new Date(String(rawTime || ""));
    return { price, time: parsedTime.getTime() };
  }).filter((value) => Number.isFinite(value.price) && value.price > 0);
  if (!candidates.length) return null;
  candidates.sort((a, b) => (Number.isFinite(b.time) ? b.time : 0) - (Number.isFinite(a.time) ? a.time : 0));
  const chosen = candidates[0];
  return {
    price: chosen.price,
    marketTime: new Date(Number.isFinite(chosen.time) ? chosen.time : Date.now()).toISOString(),
  };
}

function payloadRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
  if (!payload || typeof payload !== "object") return [];
  const object = payload as Record<string, unknown>;
  if (Array.isArray(object.data)) return payloadRows(object.data);
  if (object.data && typeof object.data === "object") return [object.data as Record<string, unknown>];
  return [object];
}

function historicalBarRows(payload: unknown): Record<string, unknown>[] {
  const visited = new Set<object>();
  function walk(value: unknown): Record<string, unknown>[] {
    if (!value || typeof value !== "object") return [];
    if (visited.has(value as object)) return [];
    visited.add(value as object);
    if (Array.isArray(value)) {
      const objects = value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
      if (objects.some((item) => item.open != null && item.high != null && item.low != null && item.close != null)) return objects;
      for (const item of value) {
        const found = walk(item);
        if (found.length) return found;
      }
      return [];
    }
    const object = value as Record<string, unknown>;
    if (object.open != null && object.high != null && object.low != null && object.close != null) return [object];
    const preferred = ["bars", "data", "items", "list", "results", "records"];
    for (const key of preferred) {
      if (!(key in object)) continue;
      const found = walk(object[key]);
      if (found.length) return found;
    }
    for (const nested of Object.values(object)) {
      const found = walk(nested);
      if (found.length) return found;
    }
    return [];
  }
  return walk(payload);
}

async function signedGet(
  path: string,
  query: Record<string, string>,
  appKey: string,
  appSecret: string,
  host: string,
  accessToken?: string,
): Promise<{ response: Response; payload: unknown }> {
  const timestamp = timestampUtc();
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const signature = await makeSignature(path, query, appKey, appSecret, host, timestamp, nonce);
  const headers: Record<string, string> = {
    "x-app-key": appKey,
    "x-timestamp": timestamp,
    "x-signature": signature,
    "x-signature-algorithm": "HMAC-SHA1",
    "x-signature-version": "1.0",
    "x-signature-nonce": nonce,
    "x-version": "v2",
  };
  if (accessToken) headers["x-access-token"] = accessToken;
  const url = new URL(`https://${host}${path}`);
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { headers });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

async function fetchLatestRegularClose(
  instrument: Instrument,
  appKey: string,
  appSecret: string,
  host: string,
  accessToken?: string,
): Promise<PriceResult> {
  const query = {
    symbol: instrument.symbol.trim().toUpperCase(),
    category: instrument.asset_type === "etf" ? "US_ETF" : "US_STOCK",
    timespan: "D",
    count: "5",
    real_time_required: "false",
  };
  const { response, payload } = await signedGet(barsPath, query, appKey, appSecret, host, accessToken);
  if (!response.ok) {
    const detail = payload && typeof payload === "object" ? JSON.stringify(payload).slice(0, 300) : `HTTP ${response.status}`;
    throw new Error(`${instrument.symbol}: historical close fallback failed: ${detail}`);
  }
  const bars = payloadRows(payload).map((bar) => {
    const price = Number(bar.close);
    const rawTime = bar.time ?? bar.timestamp;
    const numericTime = Number(rawTime);
    const time = Number.isFinite(numericTime)
      ? new Date(numericTime < 10_000_000_000 ? numericTime * 1000 : numericTime).getTime()
      : new Date(String(rawTime || "")).getTime();
    return { price, time };
  }).filter((bar) => Number.isFinite(bar.price) && bar.price > 0);
  bars.sort((a, b) => (Number.isFinite(b.time) ? b.time : 0) - (Number.isFinite(a.time) ? a.time : 0));
  if (!bars.length) throw new Error(`${instrument.symbol}: historical close fallback returned no usable bars`);
  return {
    instrument,
    price: bars[0].price,
    marketTime: new Date(Number.isFinite(bars[0].time) ? bars[0].time : Date.now()).toISOString(),
  };
}

async function fetchHistoricalBars(instrument: Instrument, count: number, timespan: ChartTimespan = "D"): Promise<ChartBar[]> {
  const appKey = Deno.env.get("WEBULL_APP_KEY")?.trim();
  const appSecret = Deno.env.get("WEBULL_APP_SECRET")?.trim();
  const region = Deno.env.get("WEBULL_REGION")?.trim().toLowerCase() || "th";
  const host = Deno.env.get("WEBULL_API_HOST")?.trim() || (region === "th" ? "api.webull.co.th" : "api.webull.com");
  const accessToken = Deno.env.get("WEBULL_ACCESS_TOKEN")?.trim();
  if (!appKey || !appSecret) throw new Error("Webull secrets are not configured");

  const query = {
    symbol: instrument.symbol.trim().toUpperCase(),
    category: instrument.asset_type === "etf" ? "US_ETF" : "US_STOCK",
    timespan,
    count: String(Math.min(Math.max(Math.trunc(count), 10), 800)),
    real_time_required: "false",
  };
  const { response, payload } = await signedGet(barsPath, query, appKey, appSecret, host, accessToken);
  if (!response.ok) {
    const detail = payload && typeof payload === "object" ? JSON.stringify(payload).slice(0, 300) : `HTTP ${response.status}`;
    throw new Error(`${instrument.symbol}: Webull bars failed: ${detail}`);
  }

  const bars = historicalBarRows(payload).map((bar): ChartBar | null => {
    const open = Number(bar.open);
    const high = Number(bar.high);
    const low = Number(bar.low);
    const close = Number(bar.close);
    const volume = Number(bar.volume ?? bar.vol ?? 0);
    const rawTime = bar.time ?? bar.timestamp ?? bar.date;
    const numericTime = Number(rawTime);
    const parsed = Number.isFinite(numericTime)
      ? new Date(numericTime < 10_000_000_000 ? numericTime * 1000 : numericTime)
      : new Date(String(rawTime || ""));
    if (![open, high, low, close].every((value) => Number.isFinite(value) && value > 0) || !Number.isFinite(parsed.getTime())) return null;
    return {
      time: parsed.toISOString(),
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) && volume > 0 ? volume : 0,
    };
  }).filter((bar): bar is ChartBar => Boolean(bar));
  bars.sort((a, b) => a.time.localeCompare(b.time));
  if (!bars.length) {
    const preview = JSON.stringify(payload).slice(0, 1200);
    throw new Error(`${instrument.symbol}: Webull returned no usable ${timespan} bars: ${preview}`);
  }
  return bars;
}

async function fetchSnapshot(instrument: Instrument): Promise<PriceResult> {
  const appKey = Deno.env.get("WEBULL_APP_KEY")?.trim();
  const appSecret = Deno.env.get("WEBULL_APP_SECRET")?.trim();
  const region = Deno.env.get("WEBULL_REGION")?.trim().toLowerCase() || "th";
  const host = Deno.env.get("WEBULL_API_HOST")?.trim() || (region === "th" ? "api.webull.co.th" : "api.webull.com");
  const accessToken = Deno.env.get("WEBULL_ACCESS_TOKEN")?.trim();
  if (!appKey || !appSecret) throw new Error("Webull secrets are not configured");

  const query = {
    symbols: instrument.symbol.trim().toUpperCase(),
    category: instrument.asset_type === "etf" ? "US_ETF" : "US_STOCK",
    // Regular-session data is available on the standard market-data entitlement.
    // Requesting either extended or overnight quotes can make the entire snapshot
    // fail outside regular hours when the Webull account has no matching add-on.
    extend_hour_required: "false",
    overnight_required: "false",
  };
  const { response, payload } = await signedGet(snapshotPath, query, appKey, appSecret, host, accessToken);
  if (!response.ok) {
    const detail = payload && typeof payload === "object"
      ? JSON.stringify(payload).slice(0, 300)
      : `HTTP ${response.status}`;
    if (/night trading permissions/i.test(detail)) {
      return fetchLatestRegularClose(instrument, appKey, appSecret, host, accessToken);
    }
    throw new Error(`${instrument.symbol}: ${detail}`);
  }
  const rows = payloadRows(payload);
  const row = rows.find((item) => String(item.symbol || "").toUpperCase() === instrument.symbol.toUpperCase()) || rows[0];
  const value = row ? marketValue(row) : null;
  if (!value) throw new Error(`${instrument.symbol}: snapshot did not contain a usable price`);
  return { instrument, ...value };
}

async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: "fulfilled", value: await work(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: jsonHeaders });

  try {
    const authorization = request.headers.get("Authorization");
    if (!authorization) return new Response(JSON.stringify({ error: "Authentication required" }), { status: 401, headers: jsonHeaders });
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401, headers: jsonHeaders });

    const body = await request.json().catch(() => ({}));
    if (body?.action === "chart") {
      const instrumentId = String(body?.instrument_id || "");
      if (!instrumentId) return new Response(JSON.stringify({ error: "instrument_id is required" }), { status: 400, headers: jsonHeaders });
      const { data: instrument, error: instrumentError } = await supabase
        .from("instruments")
        .select("id,symbol,asset_type")
        .eq("id", instrumentId)
        .in("asset_type", ["stock", "etf"])
        .maybeSingle();
      if (instrumentError) throw instrumentError;
      if (!instrument) return new Response(JSON.stringify({ error: "Stock or ETF not found" }), { status: 404, headers: jsonHeaders });
      const timespan = chartTimespan(body?.timespan);
      const chartInstrument = instrument as Instrument;
      const bars = await fetchHistoricalBars(chartInstrument, Number(body?.count || 190), timespan);
      let snapshot: PriceResult | null = null;
      let liveBars = bars;
      if (timespan === "D") {
        const [hourlyResult, snapshotResult] = await Promise.allSettled([
          fetchHistoricalBars(chartInstrument, 16, "M60"),
          fetchSnapshot(chartInstrument),
        ]);
        if (snapshotResult.status === "fulfilled") snapshot = snapshotResult.value;
        if (hourlyResult.status === "fulfilled") liveBars = mergeLiveDailyBar(bars, hourlyResult.value, snapshot);
      }
      return new Response(JSON.stringify({
        symbol: instrument.symbol,
        source: "webull",
        timespan,
        fetched_at: new Date().toISOString(),
        live_price: snapshot?.price ?? null,
        live_market_time: snapshot?.marketTime ?? null,
        bars: liveBars,
      }), { headers: jsonHeaders });
    }

    const force = body?.force === true;
    const [{ data: targets, error: targetError }, { data: positions, error: positionError }, watchlistResult] = await Promise.all([
      supabase.from("allocation_targets").select("instrument_id").eq("is_active", true),
      supabase.from("position_balances").select("instrument_id").gt("quantity", 0),
      supabase.from("watchlist_items").select("instrument_id"),
    ]);
    if (targetError) throw targetError;
    if (positionError) throw positionError;
    // Keep the existing portfolio price refresh working before migration 011 is installed.
    const watchlist = watchlistResult.error ? [] : (watchlistResult.data || []);
    const activeIds = [...new Set([...(targets || []), ...(positions || []), ...watchlist].map((item) => item.instrument_id).filter(Boolean))];
    if (!activeIds.length) return new Response(JSON.stringify({ updated: 0, skipped: true, reason: "No active stocks" }), { headers: jsonHeaders });

    const { data: instruments, error: instrumentError } = await supabase
      .from("instruments")
      .select("id,symbol,asset_type")
      .in("id", activeIds)
      .in("asset_type", ["stock", "etf"])
      .order("symbol")
      .limit(300);
    if (instrumentError) throw instrumentError;
    if (!instruments?.length) return new Response(JSON.stringify({ updated: 0, skipped: true, reason: "Options are excluded" }), { headers: jsonHeaders });

    let pending = instruments as Instrument[];
    if (!force) {
      const cutoff = new Date(Date.now() - refreshWindowMs).toISOString();
      const { data: fresh, error: freshError } = await supabase
        .from("instrument_prices")
        .select("instrument_id")
        .in("instrument_id", pending.map((item) => item.id))
        .eq("source", "webull")
        .gte("fetched_at", cutoff);
      if (freshError) throw freshError;
      const freshIds = new Set((fresh || []).map((item) => item.instrument_id));
      pending = pending.filter((item) => !freshIds.has(item.id));
    }
    if (!pending.length) return new Response(JSON.stringify({ updated: 0, skipped: true, checked: instruments.length }), { headers: jsonHeaders });

    const snapshots = await mapLimit(pending, 6, fetchSnapshot);
    const successes = snapshots.filter((result): result is PromiseFulfilledResult<PriceResult> => result.status === "fulfilled");
    const failures = snapshots.flatMap((result, index) => result.status === "rejected"
      ? [{ symbol: pending[index].symbol, message: result.reason instanceof Error ? result.reason.message : String(result.reason) }]
      : []);
    const writes = await Promise.all(successes.map(({ value }) => supabase.rpc("api_record_instrument_price", {
      p_instrument_id: value.instrument.id,
      p_price: value.price,
      p_market_time: value.marketTime,
      p_source: "webull",
    })));
    writes.forEach((result, index) => {
      if (result.error) failures.push({ symbol: successes[index].value.instrument.symbol, message: result.error.message });
    });
    const updated = writes.filter((result) => !result.error).length;
    return new Response(JSON.stringify({ updated, checked: pending.length, failures }), {
      status: updated || !pending.length ? 200 : 502,
      headers: jsonHeaders,
    });
  } catch (error) {
    console.error("refresh-stock-prices failed", error instanceof Error ? error.message : error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Price refresh failed" }), { status: 500, headers: jsonHeaders });
  }
});
