import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
const massiveForm4Url = "https://api.massive.com/stocks/filings/vX/form-4";
const initialLookbackDays = 14;
const regularLookbackDays = 4;
const maxPages = 10;

type WatchlistRow = {
  user_id: string;
  instrument_id: string;
  instruments: { id: string; symbol: string; asset_type: string } | null;
};

type MassiveForm4 = Record<string, unknown> & {
  accession_number?: string;
  filing_date?: string;
  filing_url?: string;
  form_type?: string;
  issuer_name?: string;
  owner_cik?: string;
  owner_name?: string;
  officer_title?: string;
  transaction_code?: string;
  transaction_date?: string;
  transaction_price_per_share?: number;
  transaction_shares?: number;
  transaction_value?: number;
  shares_owned_following_transaction?: number;
  security_title?: string;
  security_type?: string;
  nature_of_ownership?: string;
  direct_or_indirect?: string;
  tickers?: string[];
  is_director?: boolean;
  is_officer?: boolean;
  is_ten_percent_owner?: boolean;
};

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: jsonHeaders });
}

function dateDaysAgo(days: number): string {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function normalizedSymbol(value: unknown): string {
  return String(value || "").trim().toUpperCase();
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function relationship(row: MassiveForm4): string | null {
  const values = [
    row.is_director ? "Director" : "",
    row.is_officer ? "Officer" : "",
    row.is_ten_percent_owner ? "10% owner" : "",
  ].filter(Boolean);
  return values.length ? values.join(" · ") : null;
}

function transactionSide(code: unknown): "buy" | "sell" | "other" {
  const value = String(code || "").toUpperCase();
  if (value === "P") return "buy";
  if (value === "S") return "sell";
  return "other";
}

async function stableKey(row: MassiveForm4): Promise<string> {
  const value = [
    row.accession_number,
    row.owner_cik,
    row.transaction_code,
    row.transaction_date,
    row.security_title,
    row.transaction_shares,
    row.transaction_price_per_share,
    row.shares_owned_following_transaction,
    row.direct_or_indirect,
  ].map((item) => String(item ?? "")).join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchMassiveRows(apiKey: string, since: string): Promise<MassiveForm4[]> {
  const rows: MassiveForm4[] = [];
  let nextUrl: string | null = massiveForm4Url;
  let page = 0;

  while (nextUrl && page < maxPages) {
    const url = new URL(nextUrl);
    if (url.hostname !== "api.massive.com") throw new Error("Massive returned an unexpected pagination host");
    if (page === 0) {
      url.searchParams.set("filing_date.gte", since);
      // The free plan is request-rate constrained. Pull the largest supported
      // page so a broad watchlist does not require one request per ticker.
      url.searchParams.set("limit", "10000");
    }
    url.searchParams.set("apiKey", apiKey);
    const result = await fetch(url, { headers: { Accept: "application/json" } });
    const payload = await result.json().catch(() => null) as { results?: unknown[]; next_url?: string } | null;
    if (!result.ok) {
      const detail = payload ? JSON.stringify(payload).slice(0, 500) : `HTTP ${result.status}`;
      throw new Error(`Massive Form 4 request failed: ${detail}`);
    }
    if (Array.isArray(payload?.results)) {
      rows.push(...payload.results.filter((item): item is MassiveForm4 => Boolean(item) && typeof item === "object"));
    }
    nextUrl = payload?.next_url || null;
    page += 1;
  }

  if (nextUrl) throw new Error(`Massive pagination exceeded the ${maxPages}-page safety limit`);
  return rows;
}

async function authenticatedUserId(request: Request): Promise<string | null> {
  const authorization = request.headers.get("Authorization");
  if (!authorization) return null;
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser();
  return error ? null : data.user?.id || null;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return response({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
    const massiveApiKey = Deno.env.get("MASSIVE_API_KEY")?.trim();
    const syncSecret = Deno.env.get("SMART_MONEY_SYNC_SECRET")?.trim();
    if (!serviceRoleKey) return response({ error: "SUPABASE_SERVICE_ROLE_KEY is not configured" }, 500);
    if (!massiveApiKey) return response({ error: "MASSIVE_API_KEY is not configured" }, 503);

    const suppliedSecret = request.headers.get("x-sync-secret")?.trim();
    const scheduled = Boolean(syncSecret && suppliedSecret && suppliedSecret === syncSecret);
    const userId = scheduled ? null : await authenticatedUserId(request);
    if (!scheduled && !userId) return response({ error: "Authentication required" }, 401);

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    let watchlistQuery = admin
      .from("watchlist_items")
      .select("user_id,instrument_id,instruments!inner(id,symbol,asset_type)");
    if (userId) watchlistQuery = watchlistQuery.eq("user_id", userId);
    const { data: watchlistData, error: watchlistError } = await watchlistQuery;
    if (watchlistError) throw watchlistError;
    const watchlist = (watchlistData || []) as unknown as WatchlistRow[];
    const eligible = watchlist.filter((row) => row.instruments && ["stock", "etf"].includes(row.instruments.asset_type));
    if (!eligible.length) return response({ ok: true, checked: 0, matched: 0, inserted: 0, message: "Watchlist is empty" });

    const userIds = [...new Set(eligible.map((row) => row.user_id))];
    const { data: syncRows } = await admin
      .from("smart_money_sync_state")
      .select("user_id,last_success_at")
      .in("user_id", userIds)
      .eq("source", "massive");
    const hasPreviousSync = new Set((syncRows || []).filter((row) => row.last_success_at).map((row) => row.user_id));
    const lookback = userIds.every((id) => hasPreviousSync.has(id)) ? regularLookbackDays : initialLookbackDays;
    const since = dateDaysAgo(lookback);
    const filings = await fetchMassiveRows(massiveApiKey, since);

    const instrumentByUserAndSymbol = new Map<string, string>();
    for (const row of eligible) {
      instrumentByUserAndSymbol.set(`${row.user_id}:${normalizedSymbol(row.instruments?.symbol)}`, row.instrument_id);
    }

    const inserts: Record<string, unknown>[] = [];
    for (const filing of filings) {
      const symbols = Array.isArray(filing.tickers) ? filing.tickers.map(normalizedSymbol).filter(Boolean) : [];
      if (!symbols.length || !filing.accession_number || !filing.owner_name || !filing.filing_date) continue;
      for (const targetUserId of userIds) {
        const symbol = symbols.find((value) => instrumentByUserAndSymbol.has(`${targetUserId}:${value}`));
        if (!symbol) continue;
        const instrumentId = instrumentByUserAndSymbol.get(`${targetUserId}:${symbol}`)!;
        const price = finiteNumber(filing.transaction_price_per_share);
        const shares = finiteNumber(filing.transaction_shares);
        const providedValue = finiteNumber(filing.transaction_value);
        inserts.push({
          user_id: targetUserId,
          instrument_id: instrumentId,
          source: "massive",
          accession_number: filing.accession_number,
          transaction_key: await stableKey(filing),
          form_type: filing.form_type || "4",
          filer_cik: filing.owner_cik || null,
          filer_name: filing.owner_name,
          filer_title: filing.officer_title || null,
          relationship: relationship(filing),
          transaction_code: filing.transaction_code || null,
          side: transactionSide(filing.transaction_code),
          security_title: filing.security_title || null,
          transaction_date: filing.transaction_date || null,
          filed_at: `${filing.filing_date}T00:00:00Z`,
          shares,
          price,
          transaction_value: providedValue ?? (shares !== null && price !== null ? shares * price : null),
          post_transaction_shares: finiteNumber(filing.shares_owned_following_transaction),
          ownership_nature: filing.nature_of_ownership || filing.direct_or_indirect || null,
          is_derivative: filing.security_type === "derivative",
          sec_url: filing.filing_url || null,
          raw_payload: filing,
        });
      }
    }

    if (inserts.length) {
      const chunkSize = 500;
      for (let index = 0; index < inserts.length; index += chunkSize) {
        const { error } = await admin
          .from("smart_money_events")
          .upsert(inserts.slice(index, index + chunkSize), {
            onConflict: "user_id,accession_number,transaction_key",
            ignoreDuplicates: true,
          });
        if (error) throw error;
      }
    }

    const now = new Date().toISOString();
    const syncState = userIds.map((id) => ({
      user_id: id,
      source: "massive",
      last_filed_at: filings.reduce<string | null>((latest, row) => {
        if (!row.filing_date) return latest;
        const value = `${row.filing_date}T00:00:00Z`;
        return !latest || value > latest ? value : latest;
      }, null),
      last_checked_at: now,
      last_success_at: now,
      last_error: null,
      updated_at: now,
    }));
    const { error: stateError } = await admin
      .from("smart_money_sync_state")
      .upsert(syncState, { onConflict: "user_id,source" });
    if (stateError) throw stateError;

    return response({
      ok: true,
      users: userIds.length,
      watchlist_items: eligible.length,
      filings_checked: filings.length,
      matched_transactions: inserts.length,
      since,
    });
  } catch (error) {
    console.error(error);
    return response({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
