import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
const cacheWindowMs = 2 * 60_000;
const defaultAssets = [
  { symbol: "BTCUSDT", display_symbol: "BTC", display_name: "Bitcoin", sort_order: 10 },
  { symbol: "ETHUSDT", display_symbol: "ETH", display_name: "Ethereum", sort_order: 20 },
  { symbol: "SOLUSDT", display_symbol: "SOL", display_name: "Solana", sort_order: 30 },
];

type Asset = typeof defaultAssets[number];
type Snapshot = Record<string, unknown> & { symbol: string; fetched_at?: string };

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchJson(url: string, timeoutMs = 8_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "PCC-Crypto-Pulse/1.0" },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSpot(symbol: string) {
  return await fetchJson(`https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`);
}

async function fetchDerivatives(symbol: string) {
  const [premium, interest] = await Promise.all([
    fetchJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`),
    fetchJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`),
  ]);
  return { premium, interest };
}

async function readSnapshot(asset: Asset, previous: Snapshot | null): Promise<Snapshot> {
  const now = new Date().toISOString();
  const errors: string[] = [];
  let spot: Record<string, unknown> | null = null;
  let derivatives: { premium: Record<string, unknown>; interest: Record<string, unknown> } | null = null;

  try { spot = await fetchSpot(asset.symbol); } catch (error) { errors.push(`spot: ${error instanceof Error ? error.message : String(error)}`); }
  try { derivatives = await fetchDerivatives(asset.symbol); } catch (error) { errors.push(`derivatives: ${error instanceof Error ? error.message : String(error)}`); }

  if (!spot && !previous) throw new Error(`${asset.display_symbol}: Binance spot data unavailable`);

  return {
    symbol: asset.symbol,
    display_symbol: asset.display_symbol,
    display_name: asset.display_name,
    price: spot ? finite(spot.lastPrice) : previous?.price ?? null,
    price_change: spot ? finite(spot.priceChange) : previous?.price_change ?? null,
    price_change_percent_24h: spot ? finite(spot.priceChangePercent) : previous?.price_change_percent_24h ?? null,
    high_24h: spot ? finite(spot.highPrice) : previous?.high_24h ?? null,
    low_24h: spot ? finite(spot.lowPrice) : previous?.low_24h ?? null,
    quote_volume_24h: spot ? finite(spot.quoteVolume) : previous?.quote_volume_24h ?? null,
    mark_price: derivatives ? finite(derivatives.premium.markPrice) : previous?.mark_price ?? null,
    index_price: derivatives ? finite(derivatives.premium.indexPrice) : previous?.index_price ?? null,
    funding_rate: derivatives ? finite(derivatives.premium.lastFundingRate) : previous?.funding_rate ?? null,
    next_funding_time: derivatives && finite(derivatives.premium.nextFundingTime)
      ? new Date(Number(derivatives.premium.nextFundingTime)).toISOString()
      : previous?.next_funding_time ?? null,
    open_interest: derivatives ? finite(derivatives.interest.openInterest) : previous?.open_interest ?? null,
    source: "binance_public",
    spot_fetched_at: spot ? now : previous?.spot_fetched_at ?? null,
    derivatives_fetched_at: derivatives ? now : previous?.derivatives_fetched_at ?? null,
    fetched_at: spot || derivatives ? now : previous?.fetched_at ?? now,
    last_error: errors.length ? errors.join("; ") : null,
    updated_at: now,
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: jsonHeaders });

  try {
    const body = await request.json().catch(() => ({}));
    const authorization = request.headers.get("Authorization");
    if (!authorization) return new Response(JSON.stringify({ error: "Authentication required" }), { status: 401, headers: jsonHeaders });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401, headers: jsonHeaders });

    let { data: watchlist, error: watchlistError } = await admin
      .from("crypto_watchlist_items")
      .select("symbol,display_symbol,display_name,sort_order")
      .eq("user_id", authData.user.id)
      .order("sort_order");
    if (watchlistError) throw watchlistError;

    if (!watchlist?.length) {
      const { error: seedError } = await admin.from("crypto_watchlist_items").upsert(
        defaultAssets.map((asset) => ({ user_id: authData.user.id, ...asset })),
        { onConflict: "user_id,symbol" },
      );
      if (seedError) throw seedError;
      watchlist = defaultAssets;
    }

    const assets = watchlist as Asset[];
    const symbols = assets.map((asset) => asset.symbol);
    const { data: cachedRows, error: cacheError } = await admin
      .from("crypto_market_snapshots")
      .select("*")
      .in("symbol", symbols);
    if (cacheError) throw cacheError;
    const cached = new Map((cachedRows || []).map((row) => [row.symbol, row as Snapshot]));
    const latestTime = Math.max(...(cachedRows || []).map((row) => new Date(row.fetched_at).getTime()).filter(Number.isFinite), 0);
    const force = body?.force === true;

    if (!force && latestTime && Date.now() - latestTime < cacheWindowMs && cachedRows?.length === assets.length) {
      const rows = assets.map((asset) => cached.get(asset.symbol)).filter(Boolean);
      return new Response(JSON.stringify({ rows, cached: true, updated: 0, failures: [] }), { headers: jsonHeaders });
    }

    const results = await Promise.allSettled(assets.map((asset) => readSnapshot(asset, cached.get(asset.symbol) || null)));
    const refreshed = results.filter((result): result is PromiseFulfilledResult<Snapshot> => result.status === "fulfilled").map((result) => result.value);
    const failures = results.flatMap((result, index) => result.status === "rejected"
      ? [{ symbol: assets[index].display_symbol, message: result.reason instanceof Error ? result.reason.message : String(result.reason) }]
      : []);

    if (refreshed.length) {
      const { error: upsertError } = await admin.from("crypto_market_snapshots").upsert(refreshed, { onConflict: "symbol" });
      if (upsertError) throw upsertError;
    }

    const rows = assets.map((asset) => refreshed.find((row) => row.symbol === asset.symbol) || cached.get(asset.symbol)).filter(Boolean);
    return new Response(JSON.stringify({ rows, cached: false, updated: refreshed.length, failures }), { headers: jsonHeaders });
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), { status: 500, headers: jsonHeaders });
  }
});
