import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
const cacheWindowMs = 6 * 60 * 60_000;

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: jsonHeaders });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authorization = request.headers.get("Authorization");
    if (!authorization) return json({ error: "Authentication required" }, 401);

    const body = await request.json().catch(() => ({}));
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const client = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await client.auth.getUser();
    if (authError || !authData.user) return json({ error: "Invalid session" }, 401);

    const { data: cached, error: cacheError } = await admin
      .from("fx_market_rates")
      .select("*")
      .eq("pair", "USDTHB")
      .maybeSingle();
    if (cacheError) throw cacheError;

    const force = body?.force === true;
    const cacheAge = Date.now() - new Date(cached?.fetched_at || 0).getTime();
    if (!force && cached?.rate && cacheAge < cacheWindowMs) {
      return json({ rate: cached, cached: true });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    let response: Response;
    try {
      response = await fetch("https://open.er-api.com/v6/latest/USD", {
        signal: controller.signal,
        headers: { Accept: "application/json", "User-Agent": "PCC-FX-Tracker/1.0" },
      });
    } finally {
      clearTimeout(timer);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.result !== "success") {
      throw new Error(`FX source returned HTTP ${response.status}`);
    }

    const rate = Number(payload?.rates?.THB);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("FX source returned no USD/THB rate");
    const sourceUpdatedAt = Number.isFinite(Number(payload?.time_last_update_unix))
      ? new Date(Number(payload.time_last_update_unix) * 1000).toISOString()
      : null;
    const fetchedAt = new Date().toISOString();
    const row = {
      pair: "USDTHB",
      base_currency: "USD",
      quote_currency: "THB",
      rate,
      source: "open.er-api.com",
      source_updated_at: sourceUpdatedAt,
      fetched_at: fetchedAt,
      updated_at: fetchedAt,
    };
    const { data: saved, error: saveError } = await admin
      .from("fx_market_rates")
      .upsert(row, { onConflict: "pair" })
      .select("*")
      .single();
    if (saveError) throw saveError;
    return json({ rate: saved, cached: false });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
