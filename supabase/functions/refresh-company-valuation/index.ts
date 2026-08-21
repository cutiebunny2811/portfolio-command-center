import { createClient } from "npm:@supabase/supabase-js@2";
import { buildValuation } from "./valuation-core.mjs";
import { preferDurationFact } from "./sec-fact-selection.mjs";
import { coverPageSharesFromHtml, latestPrimaryFilingUrl } from "./sec-cover-shares.mjs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
const cacheWindowMs = 12 * 60 * 60_000;
const secUserAgent = "PortfolioCommandCenter/1.0 cutiebunny2811@gmail.com";

type FactEntry = {
  start?: string;
  end?: string;
  val?: number;
  accn?: string;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
  frame?: string;
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: jsonHeaders });
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function daysBetween(start?: string, end?: string) {
  if (!start || !end) return 0;
  return Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86_400_000);
}

async function fetchJson(url: string, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
        "User-Agent": secUserAgent,
      },
    });
    const payload = await result.json().catch(() => null);
    if (!result.ok) throw new Error(`SEC HTTP ${result.status}`);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Encoding": "gzip, deflate",
        "User-Agent": secUserAgent,
      },
    });
    if (!result.ok) throw new Error(`SEC filing HTTP ${result.status}`);
    return await result.text();
  } finally {
    clearTimeout(timer);
  }
}

function factEntries(companyFacts: any, tags: string[], unit: string): FactEntry[] {
  const namespaces = [companyFacts?.facts?.["us-gaap"], companyFacts?.facts?.dei].filter(Boolean);
  const candidates = tags.flatMap((tag) => namespaces.flatMap((namespace: any) => {
    const units = namespace?.[tag]?.units || {};
    const rows = units[unit] || (unit === "USD" ? units.USD : units.shares) || [];
    return Array.isArray(rows) ? rows : [];
  }));
  return candidates.filter((row) => finite(row?.val) != null);
}

function latestInstant(companyFacts: any, tags: string[], unit = "USD") {
  const rows = factEntries(companyFacts, tags, unit)
    .filter((row) => ["10-K", "10-Q", "8-K", "20-F", "40-F", "6-K"].includes(String(row.form || "")))
    .sort((left, right) => String(right.end || "").localeCompare(String(left.end || ""))
      || String(right.filed || "").localeCompare(String(left.filed || "")));
  return rows[0] || null;
}

function instantGrowth(companyFacts: any, tags: string[], unit = "shares") {
  const unique = new Map<string, FactEntry>();
  factEntries(companyFacts, tags, unit)
    .filter((row) => ["10-K", "10-Q"].includes(String(row.form || "")) && row.end)
    .forEach((row) => {
      const existing = unique.get(row.end!);
      if (!existing || String(row.filed || "") > String(existing.filed || "")) unique.set(row.end!, row);
    });
  const rows = [...unique.values()].sort((left, right) => String(right.end).localeCompare(String(left.end)));
  if (rows.length < 2) return null;
  const latest = rows[0];
  const latestTime = new Date(latest.end!).getTime();
  const prior = rows.find((row) => {
    const gap = (latestTime - new Date(row.end!).getTime()) / 86_400_000;
    return gap >= 300 && gap <= 460;
  });
  const latestValue = finite(latest.val);
  const priorValue = finite(prior?.val);
  return latestValue != null && priorValue != null && priorValue > 0 ? latestValue / priorValue - 1 : null;
}

function periodRows(companyFacts: any, tags: string[]) {
  const grouped = new Map<string, FactEntry>();
  factEntries(companyFacts, tags, "USD")
    .filter((row) => ["10-K", "10-Q", "20-F", "40-F"].includes(String(row.form || ""))
      && row.start && row.end && row.fy && row.fp)
    .forEach((row) => {
      const key = `${row.fy}|${row.fp}|${row.end}`;
      const existing = grouped.get(key);
      if (preferDurationFact(row, existing)) {
        grouped.set(key, row);
      }
    });
  return [...grouped.values()];
}

function durationMetric(companyFacts: any, tags: string[]) {
  const rows = periodRows(companyFacts, tags);
  const byYear = new Map<number, Record<string, FactEntry>>();
  rows.forEach((row) => {
    const fy = Number(row.fy);
    const periods = byYear.get(fy) || {};
    const fp = String(row.fp || "").toUpperCase();
    const existing = periods[fp];
    if (preferDurationFact(row, existing)) periods[fp] = row;
    byYear.set(fy, periods);
  });

  const annual = [...byYear.entries()].flatMap(([fy, periods]) => {
    const row = periods.FY;
    const value = finite(row?.val);
    return row && value != null ? [{ fy, value, end: row.end!, filed: row.filed || "", form: row.form || "10-K" }] : [];
  }).sort((left, right) => right.fy - left.fy || right.end.localeCompare(left.end));

  const quarters: Array<{ fy: number; quarter: number; value: number; end: string; filed: string; form: string }> = [];
  byYear.forEach((periods, fy) => {
    const q1 = finite(periods.Q1?.val);
    const q2 = finite(periods.Q2?.val);
    const q3 = finite(periods.Q3?.val);
    const fyValue = finite(periods.FY?.val);
    if (q1 != null) quarters.push({ fy, quarter: 1, value: q1, end: periods.Q1.end!, filed: periods.Q1.filed || "", form: periods.Q1.form || "10-Q" });
    if (q2 != null) quarters.push({ fy, quarter: 2, value: q1 != null && daysBetween(periods.Q2.start, periods.Q2.end) > 130 ? q2 - q1 : q2, end: periods.Q2.end!, filed: periods.Q2.filed || "", form: periods.Q2.form || "10-Q" });
    if (q3 != null) quarters.push({ fy, quarter: 3, value: q2 != null && daysBetween(periods.Q3.start, periods.Q3.end) > 220 ? q3 - q2 : q3, end: periods.Q3.end!, filed: periods.Q3.filed || "", form: periods.Q3.form || "10-Q" });
    if (fyValue != null && q3 != null) quarters.push({ fy, quarter: 4, value: fyValue - q3, end: periods.FY.end!, filed: periods.FY.filed || "", form: periods.FY.form || "10-K" });
  });
  quarters.sort((left, right) => right.end.localeCompare(left.end) || right.quarter - left.quarter);
  const latestFour = quarters.slice(0, 4);
  const ttm = latestFour.length === 4 ? latestFour.reduce((sum, row) => sum + row.value, 0) : null;
  const latestAnnual = annual[0] || null;
  const previousAnnual = annual.find((row) => latestAnnual && row.fy === latestAnnual.fy - 1) || annual[1] || null;
  const growth = latestAnnual && previousAnnual && previousAnnual.value !== 0 ? latestAnnual.value / previousAnnual.value - 1 : null;
  const latestPeriod = latestFour[0] || latestAnnual;
  return {
    ttm,
    fy: latestAnnual?.value ?? null,
    growth,
    filedAt: latestPeriod?.filed || latestAnnual?.filed || null,
    form: latestPeriod?.form || latestAnnual?.form || null,
    periodBasis: ttm != null ? "TTM" : "LATEST_FY",
  };
}

function debtValue(companyFacts: any) {
  const total = finite(latestInstant(companyFacts, ["LongTermDebt", "LongTermDebtAndFinanceLeaseObligationsCurrent", "LongTermDebtAndFinanceLeaseObligations"], "USD")?.val);
  const current = finite(latestInstant(companyFacts, ["LongTermDebtCurrent"], "USD")?.val) ?? 0;
  const noncurrent = finite(latestInstant(companyFacts, ["LongTermDebtNoncurrent"], "USD")?.val) ?? 0;
  const shortTerm = finite(latestInstant(companyFacts, ["ShortTermBorrowings"], "USD")?.val) ?? 0;
  return Math.max(total ?? 0, current + noncurrent) + shortTerm;
}

function extractFundamentals(companyFacts: any, submission: any, symbol: string) {
  const revenue = durationMetric(companyFacts, ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"]);
  const netIncome = durationMetric(companyFacts, ["NetIncomeLoss", "ProfitLoss"]);
  const operatingIncome = durationMetric(companyFacts, ["OperatingIncomeLoss"]);
  const grossProfit = durationMetric(companyFacts, ["GrossProfit"]);
  const operatingCash = durationMetric(companyFacts, ["NetCashProvidedByUsedInOperatingActivities"]);
  const capex = durationMetric(companyFacts, ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsForAdditionsToPropertyPlantAndEquipment"]);
  const cashRow = latestInstant(companyFacts, ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"], "USD");
  const equityRow = latestInstant(companyFacts, ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"], "USD");
  const sharesRow = latestInstant(companyFacts, ["EntityCommonStockSharesOutstanding", "CommonStockSharesOutstanding"], "shares");
  const filedAt = [revenue.filedAt, netIncome.filedAt, operatingCash.filedAt, cashRow?.filed, sharesRow?.filed].filter(Boolean).sort().at(-1) || null;
  const fcfTtm = operatingCash.ttm != null ? operatingCash.ttm - Math.max(capex.ttm ?? 0, 0) : null;
  const fcfFy = operatingCash.fy != null ? operatingCash.fy - Math.max(capex.fy ?? 0, 0) : null;
  return {
    symbol,
    company_name: companyFacts?.entityName || submission?.name || symbol,
    sic: finite(submission?.sic),
    sic_description: submission?.sicDescription || null,
    revenue_ttm: revenue.ttm,
    revenue_fy: revenue.fy,
    revenue_growth: revenue.growth,
    net_income_ttm: netIncome.ttm,
    net_income_fy: netIncome.fy,
    operating_income_ttm: operatingIncome.ttm,
    operating_income_fy: operatingIncome.fy,
    gross_profit_ttm: grossProfit.ttm,
    gross_profit_fy: grossProfit.fy,
    free_cash_flow_ttm: fcfTtm,
    free_cash_flow_fy: fcfFy,
    cash: finite(cashRow?.val),
    debt: debtValue(companyFacts),
    stockholders_equity: finite(equityRow?.val),
    shares_outstanding: finite(sharesRow?.val),
    shares_growth: instantGrowth(companyFacts, ["EntityCommonStockSharesOutstanding", "CommonStockSharesOutstanding"]),
    period_basis: revenue.periodBasis,
    sec_filed_at: filedAt,
    sec_form: revenue.form || netIncome.form || null,
  };
}

async function resolveCik(symbol: string) {
  const tickers = await fetchJson("https://www.sec.gov/files/company_tickers.json");
  const match = Object.values(tickers || {}).find((entry: any) => String(entry?.ticker || "").toUpperCase() === symbol);
  if (!match) throw new Error(`${symbol} is not present in the SEC ticker map.`);
  return String((match as any).cik_str).padStart(10, "0");
}

function patchMarket(valuation: any, priceRow: any) {
  const price = finite(priceRow?.price);
  const base = finite(valuation?.scenarios?.find((item: any) => item.key === "base")?.fair_value);
  return {
    ...valuation,
    market: {
      price,
      price_as_of: priceRow?.market_time || priceRow?.fetched_at || null,
      upside_to_base_percent: price != null && price > 0 && base != null ? Math.round((base / price - 1) * 10_000) / 100 : null,
    },
  };
}

async function generateExplanation(valuation: any) {
  const apiKey = Deno.env.get("GEMINI_API_KEY")?.trim();
  if (!apiKey) throw new Error("Gemini is not configured for PCC yet.");
  const model = Deno.env.get("GEMINI_MODEL")?.trim() || "gemini-2.5-flash-lite";
  const prompt = `You explain a deterministic stock valuation in concise Thai. Do not recalculate, recommend, or invent facts. Use at most 4 short bullet points. Explain the selected model, Bear/Base/Bull range, the largest risk flag, and what reported metric would change the range.\n\nCanonical PCC valuation:\n${JSON.stringify(valuation)}`;
  const result = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 320 },
    }),
  });
  const payload = await result.json().catch(() => null);
  if (!result.ok) throw new Error(payload?.error?.message || `Gemini HTTP ${result.status}`);
  const text = payload?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text || "").join("\n").trim();
  if (!text) throw new Error("Gemini returned an empty explanation.");
  return { text, model };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return response({ error: "Method not allowed" }, 405);
  try {
    const authorization = request.headers.get("Authorization");
    if (!authorization) return response({ error: "Authentication required" }, 401);
    const body = await request.json().catch(() => ({}));
    const instrumentId = String(body?.instrument_id || "").trim();
    if (!instrumentId) return response({ error: "instrument_id is required" }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const client = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: authData, error: authError } = await client.auth.getUser();
    if (authError || !authData.user) return response({ error: "Invalid session" }, 401);

    const { data: watchItem, error: watchError } = await admin.from("watchlist_items")
      .select("instrument_id")
      .eq("user_id", authData.user.id)
      .eq("instrument_id", instrumentId)
      .maybeSingle();
    if (watchError) throw watchError;
    if (!watchItem) return response({ error: "Add this stock to Watchlist before valuing it." }, 403);

    const { data: instrument, error: instrumentError } = await admin.from("instruments")
      .select("id,symbol,display_name,asset_type")
      .eq("id", instrumentId)
      .eq("user_id", authData.user.id)
      .maybeSingle();
    if (instrumentError) throw instrumentError;
    if (!instrument || String(instrument.asset_type).toLowerCase() !== "stock") {
      return response({ error: "SEC company valuation currently supports US stocks, not ETFs or options." }, 422);
    }
    const symbol = String(instrument.symbol || "").toUpperCase();
    const { data: priceRow, error: priceError } = await admin.from("instrument_prices")
      .select("price,market_time,fetched_at,source")
      .eq("user_id", authData.user.id)
      .eq("instrument_id", instrumentId)
      .order("fetched_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (priceError) throw priceError;

    const { data: cached, error: cacheError } = await admin.from("company_valuation_snapshots")
      .select("*")
      .eq("symbol", symbol)
      .maybeSingle();
    if (cacheError) throw cacheError;
    let row = cached;
    const cacheAge = Date.now() - new Date(cached?.fetched_at || 0).getTime();
    const needsRefresh = body?.force === true || !cached || cacheAge > cacheWindowMs;

    if (needsRefresh) {
      const cik = await resolveCik(symbol);
      const [companyFacts, submission] = await Promise.all([
        fetchJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`),
        fetchJson(`https://data.sec.gov/submissions/CIK${cik}.json`),
      ]);
      const fundamentals = extractFundamentals(companyFacts, submission, symbol);
      if (!(fundamentals.shares_outstanding > 0)) {
        const filingUrl = latestPrimaryFilingUrl(submission, cik);
        if (filingUrl) {
          fundamentals.shares_outstanding = coverPageSharesFromHtml(await fetchText(filingUrl));
        }
      }
      const valuation = buildValuation({
        fundamentals,
        market: { symbol, price: finite(priceRow?.price), price_as_of: priceRow?.market_time || priceRow?.fetched_at || null },
      });
      const now = new Date().toISOString();
      const nextRow = {
        symbol,
        cik,
        company_name: fundamentals.company_name || instrument.display_name || symbol,
        sic: fundamentals.sic,
        sic_description: fundamentals.sic_description,
        valuation,
        sec_filed_at: fundamentals.sec_filed_at,
        source: "sec_companyfacts",
        explanation: null,
        explanation_model: null,
        explanation_generated_at: null,
        fetched_at: now,
        updated_at: now,
      };
      const { data: saved, error: saveError } = await admin.from("company_valuation_snapshots")
        .upsert(nextRow, { onConflict: "symbol" })
        .select("*")
        .single();
      if (saveError) throw saveError;
      row = saved;
    }

    const valuation = patchMarket(row.valuation, priceRow);
    if (body?.action === "explain") {
      if (row.explanation && body?.force !== true) {
        return response({ valuation, explanation: row.explanation, explanation_model: row.explanation_model, cached: true });
      }
      const explanation = await generateExplanation(valuation);
      const generatedAt = new Date().toISOString();
      const { error: explanationError } = await admin.from("company_valuation_snapshots").update({
        explanation: explanation.text,
        explanation_model: explanation.model,
        explanation_generated_at: generatedAt,
        updated_at: generatedAt,
      }).eq("symbol", symbol);
      if (explanationError) throw explanationError;
      return response({ valuation, explanation: explanation.text, explanation_model: explanation.model, cached: false });
    }

    return response({
      valuation,
      explanation: row.explanation || null,
      explanation_model: row.explanation_model || null,
      fetched_at: row.fetched_at,
      source: row.source,
      cached: !needsRefresh,
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    const status = /not present in the SEC|supports US stocks|not sufficient|did not provide/i.test(message) ? 422 : 500;
    return response({ error: message }, status);
  }
});
