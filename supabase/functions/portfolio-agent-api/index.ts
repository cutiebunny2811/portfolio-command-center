import { createClient } from "npm:@supabase/supabase-js@2";
import { analyzeWatchlistSetup } from "./watchlist-setup-scanner.mjs";
import { analyzeOptionDesk } from "./option-desk-analysis.mjs";
import { buildValuation } from "../refresh-company-valuation/valuation-core.mjs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

type AgentIdentity = {
  token_id: string;
  user_id: string;
  agent_name: string;
  scopes: string[];
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: jsonHeaders });
}

function cleanSymbol(value: unknown) {
  const symbol = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9.^-]{1,20}$/.test(symbol)) throw new Error("Invalid ticker symbol");
  return symbol;
}

function positiveNumber(value: unknown, label: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be greater than zero`);
  return number;
}

function optionalNumber(value: unknown) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("Invalid numeric value");
  return number;
}

function integer(value: unknown, fallback: number, min: number, max: number) {
  const number = Math.trunc(Number(value ?? fallback));
  return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback;
}

const macroEventFields = "id,external_id,series_id,event_group,signal_family,event_name,category,reference_period,scheduled_at,actual,forecast,previous,revised,importance,currency,unit,source_name,source_url,fetched_at";
const macroCategories = new Set(["policy", "inflation", "labor", "growth", "activity", "consumption"]);

function newYorkDateKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(value);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDays(dateKey: string, days: number) {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function macroDate(value: unknown, fallback: string, label: string) {
  if (value == null || value === "") return fallback;
  const date = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T12:00:00Z`).getTime())) {
    throw new Error(`${label} must be a YYYY-MM-DD date`);
  }
  return date;
}

function macroCategory(value: unknown) {
  if (value == null || value === "") return null;
  const category = String(value).trim().toLowerCase();
  if (!macroCategories.has(category)) throw new Error("Unsupported macro category");
  return category;
}

function dateKey(value: unknown, label: string) {
  const date = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T12:00:00Z`).getTime())) {
    throw new Error(`${label} must be a YYYY-MM-DD date`);
  }
  return date;
}

function requiredText(value: unknown, label: string, maxLength = 1200) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required`);
  if (text.length > maxLength) throw new Error(`${label} must be ${maxLength} characters or fewer`);
  return text;
}

function jsonObject(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireArraySection(content: Record<string, unknown>, key: string, minLength: number, maxLength: number) {
  const section = content[key];
  if (!Array.isArray(section)) throw new Error(`content.${key} must be an array`);
  if (section.length < minLength) throw new Error(`content.${key} must contain at least ${minLength} items`);
  if (section.length > maxLength) throw new Error(`content.${key} may contain at most ${maxLength} items`);
  return section;
}

function validateBriefTone(value: unknown, label: string) {
  if (!["positive", "neutral", "caution", "negative"].includes(String(value || ""))) {
    throw new Error(`${label} must be positive, neutral, caution or negative`);
  }
}

function validateStringItems(value: unknown, label: string, minLength: number, maxLength: number) {
  if (!Array.isArray(value) || value.length < minLength || value.length > maxLength) {
    throw new Error(`${label} must contain ${minLength}-${maxLength} text items`);
  }
  value.forEach((item, index) => requiredText(item, `${label}[${index}]`, 1200));
  return value.map(String);
}

function validateValuationResearchPacket(value: unknown) {
  const packet = jsonObject(value, "research_packet");
  const fundamentals = jsonObject(packet.fundamentals, "research_packet.fundamentals");
  const forward = jsonObject(packet.forward, "research_packet.forward");
  const brief = jsonObject(packet.brief, "research_packet.brief");
  positiveNumber(fundamentals.shares_outstanding, "research_packet.fundamentals.shares_outstanding");
  if (!(Number(fundamentals.revenue_ttm || fundamentals.revenue_fy) > 0)) {
    throw new Error("research_packet.fundamentals requires positive revenue_ttm or revenue_fy");
  }
  const modelFamily = requiredText(forward.model_family, "research_packet.forward.model_family", 40);
  if (!['normalized_dcf', 'transition_dcf', 'excess_return'].includes(modelFamily)) {
    throw new Error("research_packet.forward.model_family is unsupported");
  }
  requiredText(forward.company_stage, "research_packet.forward.company_stage", 80);
  const evidence = requiredText(forward.evidence_quality, "research_packet.forward.evidence_quality", 12).toUpperCase();
  if (!['HIGH', 'MEDIUM', 'LOW'].includes(evidence)) {
    throw new Error("research_packet.forward.evidence_quality must be HIGH, MEDIUM or LOW");
  }
  requiredText(forward.rationale, "research_packet.forward.rationale", 1600);
  requiredText(forward.as_of, "research_packet.forward.as_of", 40);
  let explicitFcffScenarioCount = 0;
  const scenarios = requireArraySection(forward, "scenarios", 3, 3).map((value, index) => {
    const scenario = jsonObject(value, `research_packet.forward.scenarios[${index}]`);
    const key = requiredText(scenario.key, `research_packet.forward.scenarios[${index}].key`, 8).toLowerCase();
    if (!['bear', 'base', 'bull'].includes(key)) throw new Error(`Unsupported valuation case: ${key}`);
    const hasExplicitFcffPath = Array.isArray(scenario.fcff_path);
    if (hasExplicitFcffPath) {
      explicitFcffScenarioCount += 1;
      if (modelFamily === "excess_return") {
        throw new Error(`research_packet.forward.scenarios[${index}].fcff_path is not supported for excess_return`);
      }
      const horizon = optionalNumber(scenario.horizon_years);
      const minHorizon = modelFamily === "normalized_dcf" ? 5 : 7;
      const maxHorizon = modelFamily === "normalized_dcf" ? 5 : 10;
      if (!Number.isInteger(horizon) || horizon! < minHorizon || horizon! > maxHorizon || scenario.fcff_path.length !== horizon) {
        throw new Error(`research_packet.forward.scenarios[${index}].fcff_path must contain one finite value for each supported model-horizon year`);
      }
      scenario.fcff_path.forEach((value: unknown, pathIndex: number) => {
        if (optionalNumber(value) == null) throw new Error(`research_packet.forward.scenarios[${index}].fcff_path[${pathIndex}] must be a finite number`);
      });
      ["wacc", "terminal_growth", "diluted_shares"].forEach((field) => {
        if (optionalNumber(scenario[field]) == null) throw new Error(`research_packet.forward.scenarios[${index}].${field} is required`);
      });
    } else if (modelFamily === "excess_return") {
      ["roe", "cost_of_equity", "payout_ratio", "terminal_growth"].forEach((field) => {
        if (optionalNumber(scenario[field]) == null) {
          throw new Error(`research_packet.forward.scenarios[${index}].${field} is required`);
        }
      });
    } else {
      [
        "revenue_year_1", "revenue_growth", "fcf_margin_year_1", "fcf_margin_year_5",
        "fcf_margin_terminal", "horizon_years", "wacc", "terminal_growth", "diluted_shares",
      ].forEach((field) => {
        if (optionalNumber(scenario[field]) == null) {
          throw new Error(`research_packet.forward.scenarios[${index}].${field} is required`);
        }
      });
    }
    return key;
  });
  if (explicitFcffScenarioCount > 0 && explicitFcffScenarioCount < 3) {
    throw new Error("research_packet.forward.scenarios must use either explicit FCFF paths for all cases or legacy revenue-margin inputs for all cases");
  }
  if (new Set(scenarios).size !== 3) throw new Error("research_packet.forward.scenarios requires one Bear, Base and Bull case");
  const sources = requireArraySection(forward, "sources", 1, 12);
  sources.forEach((value, index) => {
    const source = jsonObject(value, `research_packet.forward.sources[${index}]`);
    requiredText(source.title, `research_packet.forward.sources[${index}].title`, 500);
    const url = requiredText(source.url, `research_packet.forward.sources[${index}].url`, 2000);
    if (!/^https:\/\//i.test(url)) throw new Error(`research_packet.forward.sources[${index}].url must use HTTPS`);
  });
  requiredText(brief.headline, "research_packet.brief.headline", 180);
  requiredText(brief.summary, "research_packet.brief.summary", 1600);
  requiredText(brief.base_case, "research_packet.brief.base_case", 1600);
  validateStringItems(brief.conditions, "research_packet.brief.conditions", 1, 6);
  validateStringItems(brief.risks, "research_packet.brief.risks", 1, 6);
  requiredText(brief.watch_metric, "research_packet.brief.watch_metric", 1200);
  return { packet, fundamentals, forward, brief };
}

function completedValuationNumber(value: unknown, label: string, required = false) {
  if (value == null || value === "") {
    if (required) throw new Error(`${label} is required`);
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
  return value;
}

function validateCompletedValuationResearch(researchValue: unknown, valuationValue: unknown) {
  const research = jsonObject(researchValue, "completed_research");
  if (typeof research.schema_version !== "number" || research.schema_version !== 1) {
    throw new Error("completed_research.schema_version must be the number 1");
  }
  const sources = requireArraySection(research, "sources", 1, 20).map((value, index) => {
    const source = jsonObject(value, `completed_research.sources[${index}]`);
    const url = requiredText(source.url, `completed_research.sources[${index}].url`, 2000);
    if (!/^https:\/\//i.test(url)) throw new Error(`completed_research.sources[${index}].url must use HTTPS`);
    return {
      title: requiredText(source.title, `completed_research.sources[${index}].title`, 500),
      url,
      ...(source.publisher ? { publisher: requiredText(source.publisher, `completed_research.sources[${index}].publisher`, 160) } : {}),
      ...(source.date ? { date: requiredText(source.date, `completed_research.sources[${index}].date`, 40) } : {}),
      ...(source.form ? { form: requiredText(source.form, `completed_research.sources[${index}].form`, 40) } : {}),
    };
  });
  const watchItems = research.watch_items == null
    ? []
    : validateStringItems(research.watch_items, "completed_research.watch_items", 0, 16)
      .map((item) => requiredText(item, "completed_research.watch_items[]", 800));
  const brief = jsonObject(research.brief, "completed_research.brief");
  const completedBrief = {
    headline: requiredText(brief.headline, "completed_research.brief.headline", 240),
    summary: requiredText(brief.summary, "completed_research.brief.summary", 2400),
    base_case: requiredText(brief.base_case, "completed_research.brief.base_case", 2400),
    conditions: validateStringItems(brief.conditions, "completed_research.brief.conditions", 1, 6)
      .map((item) => requiredText(item, "completed_research.brief.conditions[]", 800)),
    risks: validateStringItems(brief.risks, "completed_research.brief.risks", 1, 6)
      .map((item) => requiredText(item, "completed_research.brief.risks[]", 800)),
    watch_metric: requiredText(brief.watch_metric, "completed_research.brief.watch_metric", 1200),
  };
  const completedResearch = {
    schema_version: 1,
    headline: requiredText(research.headline, "completed_research.headline", 240),
    summary: requiredText(research.summary, "completed_research.summary", 2400),
    report: requiredText(research.report, "completed_research.report", 40_000),
    methodology: requiredText(research.methodology, "completed_research.methodology", 6000),
    as_of: requiredText(research.as_of, "completed_research.as_of", 40),
    brief: completedBrief,
    sources,
    ...(watchItems.length ? { watch_items: watchItems } : {}),
  };

  const valuation = jsonObject(valuationValue, "completed_valuation");
  const currency = requiredText(valuation.currency, "completed_valuation.currency", 3).toUpperCase();
  if (currency !== "USD") throw new Error("completed_valuation.currency must be USD");
  const bearValue = completedValuationNumber(valuation.bear_value, "completed_valuation.bear_value");
  const baseValue = completedValuationNumber(valuation.base_value, "completed_valuation.base_value", true)!;
  const bullValue = completedValuationNumber(valuation.bull_value, "completed_valuation.bull_value");
  if (bearValue != null && bearValue > baseValue) throw new Error("completed_valuation.bear_value cannot exceed base_value");
  if (bullValue != null && bullValue < baseValue) throw new Error("completed_valuation.bull_value cannot be below base_value");
  const marketPrice = completedValuationNumber(valuation.market_price, "completed_valuation.market_price");
  const completedValuation = {
    currency: "USD",
    as_of: requiredText(valuation.as_of, "completed_valuation.as_of", 40),
    method: requiredText(valuation.method, "completed_valuation.method", 240),
    ...(marketPrice != null ? { market_price: marketPrice } : {}),
    ...(bearValue != null ? { bear_value: bearValue } : {}),
    base_value: baseValue,
    ...(bullValue != null ? { bull_value: bullValue } : {}),
    calculation_summary: requiredText(valuation.calculation_summary, "completed_valuation.calculation_summary", 6000),
    key_assumptions: validateStringItems(valuation.key_assumptions, "completed_valuation.key_assumptions", 1, 20)
      .map((item) => requiredText(item, "completed_valuation.key_assumptions[]", 1200)),
    risks: validateStringItems(valuation.risks, "completed_valuation.risks", 1, 20)
      .map((item) => requiredText(item, "completed_valuation.risks[]", 1200)),
  };
  return { completedResearch, completedValuation };
}

function validateBriefNotes(content: Record<string, unknown>, key: string, minLength: number, maxLength: number) {
  const items = requireArraySection(content, key, minLength, maxLength);
  items.forEach((value, index) => {
    const item = jsonObject(value, `content.${key}[${index}]`);
    requiredText(item.title, `content.${key}[${index}].title`, 120);
    requiredText(item.detail, `content.${key}[${index}].detail`, 1000);
    validateBriefTone(item.tone, `content.${key}[${index}].tone`);
  });
}

function validateBriefSources(content: Record<string, unknown>, minLength: number, maxLength: number) {
  const sources = requireArraySection(content, "sources", minLength, maxLength);
  const ids = new Set<string>();
  sources.forEach((value, index) => {
    const source = jsonObject(value, `content.sources[${index}]`);
    const id = requiredText(source.id, `content.sources[${index}].id`, 160);
    requiredText(source.title, `content.sources[${index}].title`, 500);
    requiredText(source.url, `content.sources[${index}].url`, 2000);
    requiredText(source.publisher, `content.sources[${index}].publisher`, 160);
    if (ids.has(id)) throw new Error(`content.sources contains duplicate id: ${id}`);
    ids.add(id);
  });
  return ids;
}

function validateBriefContent(value: unknown) {
  const content = jsonObject(value, "content");
  const mood = jsonObject(content.market_mood, "content.market_mood");
  requiredText(mood.label, "content.market_mood.label", 80);
  requiredText(mood.summary, "content.market_mood.summary", 800);
  validateBriefTone(mood.tone, "content.market_mood.tone");
  const sourceIds = validateBriefSources(content, 1, 20);
  requireArraySection(content, "market_snapshot", 3, 10).forEach((value, index) => {
    const item = jsonObject(value, `content.market_snapshot[${index}]`);
    requiredText(item.label, `content.market_snapshot[${index}].label`, 120);
    if (!["string", "number"].includes(typeof item.value) || String(item.value).trim() === "") {
      throw new Error(`content.market_snapshot[${index}].value is required`);
    }
    requiredText(item.change, `content.market_snapshot[${index}].change`, 500);
    validateBriefTone(item.tone, `content.market_snapshot[${index}].tone`);
  });
  requireArraySection(content, "top_stories", 3, 5).forEach((value, index) => {
    const story = jsonObject(value, `content.top_stories[${index}]`);
    requiredText(story.title, `content.top_stories[${index}].title`, 240);
    validateStringItems(story.facts, `content.top_stories[${index}].facts`, 1, 3);
    validateStringItems(story.interpretation, `content.top_stories[${index}].interpretation`, 1, 2);
    const storySources = validateStringItems(story.source_ids, `content.top_stories[${index}].source_ids`, 1, 8);
    storySources.forEach((id) => {
      if (!sourceIds.has(id)) throw new Error(`content.top_stories[${index}] references unknown source id: ${id}`);
    });
  });
  validateBriefNotes(content, "investment_implications", 3, 5);
  validateBriefNotes(content, "watch_next", 2, 6);
  validateBriefNotes(content, "bottom_line", 2, 3);
  return content;
}

function validateContinuationContent(value: unknown) {
  const content = jsonObject(value, "content");
  validateBriefNotes(content, "changes", 1, 6);
  validateBriefNotes(content, "portfolio_impact", 1, 6);
  validateBriefNotes(content, "watch_next", 1, 6);
  validateBriefSources(content, 1, 20);
  return content;
}

function validateMarketCheckContent(value: unknown) {
  const content = jsonObject(value, "content");
  dateKey(content.session_date, "content.session_date");
  requiredText(content.session_label, "content.session_label", 160);
  requiredText(content.data_note, "content.data_note", 500);
  requiredText(content.read_through, "content.read_through", 1800);

  const tone = jsonObject(content.market_tone, "content.market_tone");
  requiredText(tone.label, "content.market_tone.label", 120);
  requiredText(tone.summary, "content.market_tone.summary", 800);
  validateBriefTone(tone.tone, "content.market_tone.tone");

  requireArraySection(content, "market_snapshot", 2, 8).forEach((value, index) => {
    const item = jsonObject(value, `content.market_snapshot[${index}]`);
    requiredText(item.label, `content.market_snapshot[${index}].label`, 120);
    if (!["string", "number"].includes(typeof item.value) || String(item.value).trim() === "") {
      throw new Error(`content.market_snapshot[${index}].value is required`);
    }
    requiredText(item.change, `content.market_snapshot[${index}].change`, 500);
    validateBriefTone(item.tone, `content.market_snapshot[${index}].tone`);
  });

  for (const key of ["rotation_leaders", "rotation_laggards"] as const) {
    requireArraySection(content, key, 1, 8).forEach((value, index) => {
      const item = jsonObject(value, `content.${key}[${index}]`);
      requiredText(item.symbol, `content.${key}[${index}].symbol`, 24);
      requiredText(item.label, `content.${key}[${index}].label`, 120);
      requiredText(item.change, `content.${key}[${index}].change`, 80);
    });
  }

  validateBriefNotes(content, "watch_next", 1, 4);
  validateBriefSources(content, 1, 12);
  return content;
}

function validateSmartMoneyBriefContent(value: unknown) {
  const content = jsonObject(value, "content");
  requiredText(content.headline, "content.headline", 180);
  requiredText(content.coverage_summary, "content.coverage_summary", 800);
  const sourceIds = validateBriefSources(content, 1, 30);
  const eventKeys = new Set<string>();
  for (const [key, min, max] of [
    ["open_market_buys", 0, 8],
    ["sales_worth_context", 0, 8],
    ["noise_removed", 1, 8],
    ["watch_next", 1, 8],
  ] as const) {
    requireArraySection(content, key, min, max).forEach((value, index) => {
      const item = jsonObject(value, `content.${key}[${index}]`);
      requiredText(item.title, `content.${key}[${index}].title`, 180);
      requiredText(item.detail, `content.${key}[${index}].detail`, 2400);
      validateBriefTone(item.tone, `content.${key}[${index}].tone`);
      const itemSources = validateStringItems(item.source_ids, `content.${key}[${index}].source_ids`, 0, 10);
      itemSources.forEach((id) => {
        if (!sourceIds.has(id)) throw new Error(`content.${key}[${index}] references unknown source id: ${id}`);
      });
      validateStringItems(item.event_keys, `content.${key}[${index}].event_keys`, 0, 100)
        .forEach((eventKey) => eventKeys.add(eventKey));
    });
  }
  if (!eventKeys.size) throw new Error("content must reference at least one new Smart Money event key");
  return { content, eventKeys: [...eventKeys] };
}

function requireScope(identity: AgentIdentity, scope: string) {
  if (!identity.scopes.includes(scope)) throw new Error(`Agent token is missing scope: ${scope}`);
}

function bearerToken(request: Request) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

async function must(promise: PromiseLike<{ data: any; error: { message: string } | null }>): Promise<any> {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function watchlistSetupScan(
  service: any,
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
  body: Record<string, unknown>,
) {
  const batchSize = integer(body.batch_size, 20, 5, 20);
  const offset = integer(body.offset, 0, 0, 10_000);
  const maxCandidates = integer(body.max_candidates, 5, 1, 10);
  const setupFilter = ["both", "reclaim_ema200", "near_support"].includes(String(body.setup || "both"))
    ? String(body.setup || "both")
    : "both";
  const refreshStale = body.refresh_stale !== false;
  const watchlist = await must(service
    .from("watchlist_items")
    .select("instrument_id")
    .eq("user_id", userId));
  const instrumentIds = unique((watchlist as Record<string, unknown>[])
    .map((item) => String(item.instrument_id || ""))
    .filter(Boolean));
  if (!instrumentIds.length) {
    return {
      universe_total: 0,
      processed: 0,
      offset,
      next_offset: null,
      complete: true,
      reclaim_ema200: [],
      near_support: [],
      failures: [],
    };
  }

  const [instrumentRows, marketRows] = await Promise.all([
    must(service
      .from("instruments")
      .select("id,symbol,display_name,asset_type")
      .eq("user_id", userId)
      .in("id", instrumentIds)
      .in("asset_type", ["stock", "etf"])),
    must(service
      .from("market_pulse_latest")
      .select("instrument_id,symbol,price,market_time,fetched_at,volume")
      .eq("user_id", userId)
      .eq("is_watchlist", true)),
  ]);
  const instruments = (instrumentRows as Record<string, unknown>[])
    .sort((left, right) => String(left.symbol).localeCompare(String(right.symbol)));
  const marketByInstrument = new Map((marketRows as Record<string, unknown>[])
    .map((row) => [String(row.instrument_id || ""), row]));
  const batch = instruments.slice(offset, offset + batchSize);

  const scans = await mapWithConcurrency(batch, 4, async (instrument) => {
    const symbol = String(instrument.symbol || "").trim().toUpperCase();
    try {
      const chartResponse = await fetch(`${supabaseUrl}/functions/v1/refresh-stock-prices`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${serviceRoleKey}`,
          "apikey": serviceRoleKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "chart",
          user_id: userId,
          instrument_id: instrument.id,
          timespan: "D",
          count: 320,
          refresh: refreshStale,
        }),
      });
      const chart = await chartResponse.json().catch(() => ({ error: "Chart service returned invalid JSON" }));
      if (!chartResponse.ok || chart?.error) throw new Error(String(chart?.error || `HTTP ${chartResponse.status}`));
      return {
        ok: true,
        symbol,
        analysis: analyzeWatchlistSetup({
          symbol,
          bars: chart.bars,
          market: marketByInstrument.get(String(instrument.id)) || null,
          fetchedAt: chart.fetched_at || null,
          stale: chart.stale === true,
        }),
        refresh_error: chart.refresh_error || null,
      };
    } catch (error) {
      return {
        ok: false,
        symbol,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const setupRows = scans.flatMap((scan: any) => scan.ok && Array.isArray(scan.analysis?.setups) ? scan.analysis.setups : []);
  const rank = (left: Record<string, unknown>, right: Record<string, unknown>) =>
    Number(right.score || 0) - Number(left.score || 0) || String(left.symbol).localeCompare(String(right.symbol));
  const reclaim = setupFilter === "near_support"
    ? []
    : setupRows.filter((row: Record<string, unknown>) => row.setup === "RECLAIM_EMA200").sort(rank).slice(0, maxCandidates);
  const support = setupFilter === "reclaim_ema200"
    ? []
    : setupRows.filter((row: Record<string, unknown>) => row.setup === "NEAR_SUPPORT").sort(rank).slice(0, maxCandidates);
  const nextOffset = offset + batch.length < instruments.length ? offset + batch.length : null;
  const readySymbols = unique([...reclaim, ...support]
    .filter((row: Record<string, unknown>) => row.status === "READY_FOR_4H")
    .map((row: Record<string, unknown>) => String(row.symbol)));

  return {
    universe_total: instruments.length,
    processed: batch.length,
    offset,
    next_offset: nextOffset,
    complete: nextOffset == null,
    daily_scan_only: true,
    refresh_stale: refreshStale,
    reclaim_ema200: reclaim,
    near_support: support,
    follow_up_symbols: readySymbols,
    failures: scans.filter((scan: any) => !scan.ok).map((scan: any) => ({ symbol: scan.symbol, error: scan.error })),
    data_quality: {
      successful: scans.filter((scan: any) => scan.ok).length,
      stale_fallbacks: scans.filter((scan: any) => scan.ok && scan.analysis?.metrics?.stale).length,
      insufficient_history: scans.filter((scan: any) => scan.ok && scan.analysis?.eligible === false).length,
    },
    guidance: nextOffset == null
      ? "Daily universe scan complete. Open 4H and then 1H only for READY_FOR_4H symbols."
      : `Call scan_watchlist_setups again with offset=${nextOffset}; aggregate candidates before opening 4H/1H.`,
  };
}

async function collectPages(
  fetchPage: (from: number, to: number) => PromiseLike<{
    data: unknown;
    error: { message: string } | null;
  }>,
) {
  const rows: Record<string, unknown>[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const page = (await must(fetchPage(from, from + pageSize - 1))) as Record<string, unknown>[] | null;
    const pageRows = page || [];
    rows.push(...pageRows);
    if (pageRows.length < pageSize) return rows;
  }
}

async function ownedPortfolios(service: any, userId: string) {
  return await must(service
    .from("portfolios")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("sort_order"));
}

async function resolvePortfolio(
  service: any,
  userId: string,
  body: Record<string, unknown>,
) {
  let query = service.from("portfolios").select("*").eq("user_id", userId).eq("is_active", true);
  if (body.portfolio_id) query = query.eq("id", String(body.portfolio_id));
  else if (body.portfolio) {
    const selector = String(body.portfolio).trim();
    query = query.or(`name.ilike.${selector},kind.eq.${selector.toLowerCase().replaceAll(" ", "_")}`);
  } else {
    throw new Error("portfolio_id or portfolio is required");
  }
  const portfolio = await must(query.maybeSingle());
  if (!portfolio) throw new Error("Portfolio not found");
  return portfolio;
}

async function resolveInstrument(
  service: any,
  userId: string,
  body: Record<string, unknown>,
) {
  let query = service.from("instruments").select("*").eq("user_id", userId);
  if (body.instrument_id) query = query.eq("id", String(body.instrument_id));
  else if (body.symbol) query = query.eq("symbol", cleanSymbol(body.symbol));
  else throw new Error("instrument_id or symbol is required");
  const rows = await must(query.order("created_at", { ascending: false }).limit(10));
  if (!rows?.length) throw new Error("Instrument not found");
  if (body.asset_type) {
    const exact = rows.find((row: Record<string, unknown>) => row.asset_type === body.asset_type);
    if (exact) return exact;
  }
  const nonOption = rows.find((row: Record<string, unknown>) => row.asset_type !== "option");
  return nonOption || rows[0];
}

async function portfolioSnapshot(
  service: any,
  userId: string,
  portfolio: Record<string, unknown>,
) {
  const portfolioId = String(portfolio.id);
  const [cashRows, positions, targets, capacities, executions] = await Promise.all([
    must(service.from("portfolio_cash_balances").select("*").eq("portfolio_id", portfolioId)),
    must(service.from("position_balances").select("*").eq("portfolio_id", portfolioId)),
    must(service.from("allocation_targets").select("*").eq("portfolio_id", portfolioId).eq("is_active", true)),
    must(service.from("position_capacity").select("*").eq("portfolio_id", portfolioId)),
    must(service
      .from("executions")
      .select("id,portfolio_id,instrument_id,side,quantity,price,multiplier,fee,gross_amount,cash_effect,realized_pnl,executed_at")
      .eq("portfolio_id", portfolioId)
      .order("executed_at", { ascending: false })
      .limit(200)),
  ]);
  const instrumentIds = unique([
    ...positions.map((row: Record<string, unknown>) => String(row.instrument_id)),
    ...targets.map((row: Record<string, unknown>) => String(row.instrument_id)),
  ].filter(Boolean));
  const instruments = instrumentIds.length
    ? await must(service.from("instruments").select("*").eq("user_id", userId).in("id", instrumentIds))
    : [];
  const priceRows = instrumentIds.length
    ? await must(service
      .from("instrument_prices")
      .select("*")
      .eq("user_id", userId)
      .in("instrument_id", instrumentIds)
      .order("fetched_at", { ascending: false })
      .limit(Math.min(instrumentIds.length * 5, 2000)))
    : [];
  const seenPrices = new Set<string>();
  const latestPrices = priceRows.filter((row: Record<string, unknown>) => {
    const id = String(row.instrument_id);
    if (seenPrices.has(id)) return false;
    seenPrices.add(id);
    return true;
  });
  return {
    portfolio,
    cash: cashRows[0] || { portfolio_id: portfolioId, cash_balance: 0 },
    positions,
    targets,
    capacities,
    instruments,
    latest_prices: latestPrices,
    recent_executions: executions,
  };
}

async function liveOptionChain(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
  body: Record<string, unknown>,
) {
  const symbol = cleanSymbol(body.symbol);
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) throw new Error("Enter a valid US underlying symbol");
  const optionType = String(body.option_type || "call").trim().toLowerCase();
  if (!["call", "put"].includes(optionType)) throw new Error("option_type must be call or put");
  const expiry = body.expiry ? String(body.expiry).trim() : null;
  if (expiry && !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw new Error("expiry must be YYYY-MM-DD");
  const optionResponse = await fetch(`${supabaseUrl}/functions/v1/refresh-stock-prices`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${serviceRoleKey}`,
      "apikey": serviceRoleKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "option_chain",
      user_id: userId,
      symbol,
      option_type: optionType,
      expiry,
    }),
  });
  const payload = await optionResponse.json().catch(() => ({ error: "Option service returned invalid JSON" }));
  if (!optionResponse.ok || payload?.error) {
    throw new Error(String(payload?.error || `Option service failed with HTTP ${optionResponse.status}`));
  }
  return payload as Record<string, unknown>;
}

async function resolveRuleACampaign(
  service: any,
  userId: string,
  body: Record<string, unknown>,
) {
  const portfolio = await resolvePortfolio(service, userId, body);
  const instrument = await resolveInstrument(service, userId, body);
  const side = String(body.side || "").toLowerCase();
  if (!["buy", "sell"].includes(side)) throw new Error("side must be buy or sell");
  const result = await must(service.rpc("api_agent_resolve_rule_a_campaign", {
    p_user_id: userId,
    p_portfolio_id: portfolio.id,
    p_instrument_id: instrument.id,
    p_side: side,
    p_executed_at: body.executed_at ? String(body.executed_at) : new Date().toISOString(),
  }));
  return { portfolio, instrument, ...(result as Record<string, unknown>) };
}

async function confirmedExecutionSync(
  service: any,
  userId: string,
  body: Record<string, unknown>,
) {
  const limit = integer(body.limit, 200, 1, 200);
  let portfolios = await ownedPortfolios(service, userId);
  if (body.portfolio_id || body.portfolio) {
    const portfolio = await resolvePortfolio(service, userId, body);
    portfolios = [portfolio];
  }
  const portfolioIds = portfolios
    .filter((portfolio: Record<string, unknown>) => ["swing_trade", "options"].includes(String(portfolio.kind)))
    .map((portfolio: Record<string, unknown>) => String(portfolio.id));
  if (!portfolioIds.length) return [];

  let query = service
    .from("executions")
    .select("id,portfolio_id,instrument_id,campaign_id,side,quantity,price,multiplier,fee,tranche_number,executed_at,idempotency_key,metadata")
    .eq("user_id", userId)
    .in("portfolio_id", portfolioIds)
    .like("idempotency_key", "webull:%");
  if (body.since) query = query.gte("executed_at", String(body.since));
  const rows = await must(query.order("executed_at", { ascending: true }).limit(limit));
  const instrumentIds = unique(rows.map((row: Record<string, unknown>) => String(row.instrument_id)).filter(Boolean));
  const instruments = instrumentIds.length
    ? await must(service.from("instruments")
      .select("id,instrument_key,asset_type,symbol,underlying_symbol,option_type,strike,expiry,multiplier,webull_instrument_id")
      .eq("user_id", userId)
      .in("id", instrumentIds))
    : [];
  const instrumentById = new Map(instruments.map((instrument: Record<string, unknown>) => [String(instrument.id), instrument]));
  const portfolioById = new Map(portfolios.map((portfolio: Record<string, unknown>) => [String(portfolio.id), portfolio]));

  return rows.map((execution: Record<string, unknown>) => ({
    execution_id: execution.id,
    portfolio: portfolioById.get(String(execution.portfolio_id)) || null,
    instrument: instrumentById.get(String(execution.instrument_id)) || null,
    campaign_id: execution.campaign_id,
    side: execution.side,
    quantity: execution.quantity,
    price: execution.price,
    multiplier: execution.multiplier,
    fee: execution.fee,
    tranche_number: execution.tranche_number,
    executed_at: execution.executed_at,
    idempotency_key: execution.idempotency_key,
    metadata: execution.metadata,
  }));
}

function researchAlertLevel(
  article: Record<string, unknown>,
  scope: { is_portfolio: boolean; is_watchlist: boolean },
): "HIGH" | "MEDIUM" | "LOW" {
  const keywords = Array.isArray(article.keywords) ? article.keywords.map(String) : [];
  if (keywords.includes("ALERT_HIGH")) return "HIGH";
  if (keywords.includes("ALERT_MEDIUM")) return "MEDIUM";
  if (article.source === "sec-8k") return scope.is_portfolio ? "HIGH" : "MEDIUM";

  const text = `${article.title || ""} ${article.description || ""}`;
  const publisher = String(article.publisher_name || "");
  const opinionPublisher = /\b(the motley fool|investorplace|zacks|marketbeat|barchart)\b/i.test(publisher);
  if (opinionPublisher) return "LOW";
  const materialEvent = /\b(earnings?|guidance|acquir(?:e|es|ed|ing)|merger|buyout|offering|bankrupt(?:cy)?|fda|investigation|contract|partnership|layoffs?|forecast|raises?|cuts?|beats?|misses?)\b/i.test(text);
  if (materialEvent && scope.is_portfolio) return "HIGH";
  if (materialEvent || scope.is_portfolio || keywords.includes("MARKET_MACRO")) return "MEDIUM";
  return "LOW";
}

async function researchNews(
  service: any,
  userId: string,
  body: Record<string, unknown>,
) {
  const filter = String(body.filter || "all").trim().toLowerCase();
  if (!["all", "unread", "alerts", "portfolio", "macro", "saved"].includes(filter)) {
    throw new Error("Unsupported Research filter");
  }
  const page = integer(body.page, 1, 1, 100_000);
  const pageSize = integer(body.page_size, 25, 1, 50);
  const searchTicker = body.search ? cleanSymbol(body.search) : null;
  const articleFields = "id,source,source_article_id,canonical_url,title,description,publisher_name,publisher_homepage_url,publisher_logo_url,published_at,tickers,keywords";
  const [instrumentLinks, sourceLinks, states] = await Promise.all([
    collectPages((from, to) => service
      .from("research_article_matches")
      .select(`article_id,is_portfolio,is_watchlist,article:research_articles!inner(${articleFields})`)
      .eq("user_id", userId)
      .range(from, to)),
    collectPages((from, to) => service
      .from("research_source_article_matches")
      .select(`article_id,article:research_articles!inner(${articleFields})`)
      .eq("user_id", userId)
      .range(from, to)),
    collectPages((from, to) => service
      .from("research_article_state")
      .select("article_id,is_read,is_saved,is_hidden,alert_processed_at")
      .eq("user_id", userId)
      .range(from, to)),
  ]);

  const scopeByArticle = new Map<string, { is_portfolio: boolean; is_watchlist: boolean }>();
  const articleById = new Map<string, Record<string, unknown>>();
  for (const link of instrumentLinks) {
    const articleId = String(link.article_id);
    const scope = scopeByArticle.get(articleId) || { is_portfolio: false, is_watchlist: false };
    scope.is_portfolio ||= Boolean(link.is_portfolio);
    scope.is_watchlist ||= Boolean(link.is_watchlist);
    scopeByArticle.set(articleId, scope);
    articleById.set(articleId, link.article as Record<string, unknown>);
  }
  for (const link of sourceLinks) {
    const articleId = String(link.article_id);
    if (!scopeByArticle.has(articleId)) {
      scopeByArticle.set(articleId, { is_portfolio: false, is_watchlist: false });
    }
    articleById.set(articleId, link.article as Record<string, unknown>);
  }

  const articleIds = [...scopeByArticle.keys()];
  if (!articleIds.length) {
    return { entries: [], total_count: 0, page, page_size: pageSize, filter, search_ticker: searchTicker };
  }
  const stateByArticle = new Map(states.map((state) => [String(state.article_id), state]));
  const entries: Record<string, unknown>[] = [...articleById.values()]
    .map((article): Record<string, unknown> => {
      const scope = scopeByArticle.get(String(article.id))!;
      const state = stateByArticle.get(String(article.id));
      const alertLevel = researchAlertLevel(article, scope);
      return {
        ...article,
        ...scope,
        alert_level: alertLevel,
        must_notify: alertLevel === "HIGH",
        alert_delivery_rule: alertLevel === "HIGH" ? "NOTIFY" : alertLevel === "MEDIUM" ? "EDITORIAL_REVIEW" : "IGNORE",
        source_verification: article.source === "x" ? "X_SOURCE_LEAD" : "PUBLISHED_SOURCE",
        is_read: Boolean(state?.is_read),
        is_saved: Boolean(state?.is_saved),
        is_hidden: Boolean(state?.is_hidden),
        is_alert_processed: Boolean(state?.alert_processed_at),
      };
    })
    .filter((entry) => entry.source !== "x" || (
      (entry.keywords as string[]).includes("X_SIGNAL")
      && (
        (entry.keywords as string[]).includes("ALERT_HIGH")
        || (entry.keywords as string[]).includes("ALERT_MEDIUM")
        || (!(entry.keywords as string[]).includes("REUTERS") && (entry.keywords as string[]).includes("TICKER_EVENT"))
      )
    ))
    .filter((entry) => !searchTicker || (entry.tickers as string[]).includes(searchTicker))
    .filter((entry) => !entry.is_hidden)
    .filter((entry) => filter !== "unread" || !entry.is_read)
    .filter((entry) => filter !== "alerts" || (
      !entry.is_alert_processed && ["HIGH", "MEDIUM"].includes(String(entry.alert_level))
    ))
    .filter((entry) => filter !== "portfolio" || entry.is_portfolio)
    .filter((entry) => filter !== "saved" || entry.is_saved)
    .filter((entry) => filter !== "macro"
      || ((entry.keywords as string[]).includes("MARKET_MACRO") && !(entry.keywords as string[]).includes("TICKER_EVENT")))
    .sort((left, right) => String(right.published_at).localeCompare(String(left.published_at))
      || String(right.id).localeCompare(String(left.id)));
  const offset = (page - 1) * pageSize;
  let pageEntries = entries.slice(offset, offset + pageSize);
  let claimToken: string | null = null;
  let claimExpiresAt: string | null = null;

  if (filter === "alerts" && pageEntries.length) {
    const now = new Date();
    const claimedAt = now.toISOString();
    const staleBefore = new Date(now.getTime() - 30 * 60_000).toISOString();
    const candidateIds = pageEntries.map((entry) => String(entry.id));

    await must(service.from("research_article_state")
      .update({ alert_claim_token: null, alert_claimed_at: null, updated_at: claimedAt })
      .eq("user_id", userId)
      .is("alert_processed_at", null)
      .lt("alert_claimed_at", staleBefore));
    await must(service.from("research_article_state").upsert(candidateIds.map((articleId) => ({
      user_id: userId,
      article_id: articleId,
      updated_at: claimedAt,
    })), { onConflict: "user_id,article_id", ignoreDuplicates: true }));

    claimToken = crypto.randomUUID();
    const claimedRows = await must(service.from("research_article_state")
      .update({ alert_claim_token: claimToken, alert_claimed_at: claimedAt, updated_at: claimedAt })
      .eq("user_id", userId)
      .in("article_id", candidateIds)
      .is("alert_processed_at", null)
      .is("alert_claimed_at", null)
      .select("article_id"));
    const claimedIds = new Set((claimedRows as Record<string, unknown>[]).map((row) => String(row.article_id)));
    pageEntries = pageEntries.filter((entry) => claimedIds.has(String(entry.id)));
    if (!pageEntries.length) claimToken = null;
    else claimExpiresAt = new Date(now.getTime() + 30 * 60_000).toISOString();
  }

  return {
    entries: pageEntries,
    total_count: filter === "alerts" ? pageEntries.length : entries.length,
    page,
    page_size: pageSize,
    filter,
    search_ticker: searchTicker,
    claim_token: claimToken,
    claim_expires_at: claimExpiresAt,
  };
}

async function acknowledgeNews(
  service: any,
  userId: string,
  body: Record<string, unknown>,
) {
  const requestedIds = Array.isArray(body.article_ids)
    ? unique(body.article_ids.map(String).filter((id) => /^[0-9a-f-]{36}$/i.test(id))).slice(0, 50)
    : [];
  if (!requestedIds.length) throw new Error("article_ids must contain at least one article UUID");
  const claimToken = String(body.claim_token || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(claimToken)) throw new Error("claim_token must be the UUID returned by get_news(filter=alerts)");

  const [instrumentLinks, sourceLinks] = await Promise.all([
    must(service.from("research_article_matches")
      .select("article_id")
      .eq("user_id", userId)
      .in("article_id", requestedIds)),
    must(service.from("research_source_article_matches")
      .select("article_id")
      .eq("user_id", userId)
      .in("article_id", requestedIds)),
  ]);
  const allowedIds = unique([...instrumentLinks, ...sourceLinks].map((row: Record<string, unknown>) => String(row.article_id)));
  if (!allowedIds.length) throw new Error("No linked news articles were found");

  const now = new Date().toISOString();
  await must(service.from("research_article_state").upsert(allowedIds.map((articleId) => ({
    user_id: userId,
    article_id: articleId,
    updated_at: now,
  })), { onConflict: "user_id,article_id", ignoreDuplicates: true }));
  const acknowledgedRows = await must(service.from("research_article_state")
    .update({
      alert_processed_at: now,
      alert_claim_token: null,
      alert_claimed_at: null,
      updated_at: now,
    })
    .eq("user_id", userId)
    .eq("alert_claim_token", claimToken)
    .in("article_id", allowedIds)
    .select("article_id"));
  const acknowledgedIds = (acknowledgedRows as Record<string, unknown>[])
    .map((row) => String(row.article_id));
  return {
    acknowledged: acknowledgedIds.length,
    article_ids: acknowledgedIds,
    requested: requestedIds.length,
    user_read_state_changed: false,
  };
}

async function requeueNewsAlerts(
  service: any,
  userId: string,
  body: Record<string, unknown>,
) {
  const requestedIds = Array.isArray(body.article_ids)
    ? unique(body.article_ids.map(String).filter((id) => /^[0-9a-f-]{36}$/i.test(id))).slice(0, 12)
    : [];
  if (!requestedIds.length) throw new Error("article_ids must contain at least one article UUID");

  const [instrumentLinks, sourceLinks] = await Promise.all([
    must(service.from("research_article_matches")
      .select("article_id")
      .eq("user_id", userId)
      .in("article_id", requestedIds)),
    must(service.from("research_source_article_matches")
      .select("article_id")
      .eq("user_id", userId)
      .in("article_id", requestedIds)),
  ]);
  const allowedIds = unique([...instrumentLinks, ...sourceLinks].map((row: Record<string, unknown>) => String(row.article_id)));
  if (!allowedIds.length) throw new Error("No linked news articles were found");

  await must(service.from("research_article_state")
    .update({
      alert_processed_at: null,
      alert_claim_token: null,
      alert_claimed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .in("article_id", allowedIds));
  return {
    requeued: allowedIds.length,
    article_ids: allowedIds,
    user_read_state_changed: false,
  };
}

async function sharedMarketNews(service: any, lookbackHours: number) {
  const cutoff = new Date(Date.now() - lookbackHours * 60 * 60_000).toISOString();
  const articleFields = "id,source,source_article_id,canonical_url,title,description,publisher_name,published_at,tickers,keywords";
  const rows = await must(service
    .from("research_articles")
    .select(articleFields)
    .gte("published_at", cutoff)
    .order("published_at", { ascending: false })
    .limit(120));

  const seen = new Set<string>();
  const entries = (rows as Record<string, unknown>[]).flatMap((article) => {
    const keywords = Array.isArray(article.keywords) ? article.keywords.map(String) : [];
    if (article.source === "x" && !keywords.includes("BRIEF_CANDIDATE")) return [];
    const title = String(article.title || "").replace(/\s+/g, " ").trim();
    const publisher = String(article.publisher_name || "").replace(/\s+/g, " ").trim();
    const url = String(article.canonical_url || "").trim();
    if (!title || !publisher || !url) return [];
    const key = `${publisher.toLowerCase()}|${title.toLowerCase()}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      ...article,
      title,
      description: String(article.description || "").replace(/\s+/g, " ").trim().slice(0, 700) || null,
      publisher_name: publisher,
      canonical_url: url,
    }];
  }).slice(0, 24);

  const publisherCounts = entries.reduce<Record<string, number>>((counts, article) => {
    const publisher = String(article.publisher_name);
    counts[publisher] = (counts[publisher] || 0) + 1;
    return counts;
  }, {});

  return {
    article_count: entries.length,
    publisher_count: Object.keys(publisherCounts).length,
    publisher_counts: publisherCounts,
    entries,
    lookback_hours: lookbackHours,
    cutoff,
    guidance: "Privacy-safe external reporting cached before briefing time. Use it as source evidence and synthesize market-wide drivers; it is not a personalized News feed.",
  };
}

async function refreshBriefSources(supabaseUrl: string) {
  const syncSecret = Deno.env.get("RESEARCH_SYNC_SECRET")?.trim();
  if (!syncSecret) {
    return { ok: false, status: "not_configured", message: "Shared source refresh is unavailable; use the cached fact pack." };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const refreshResponse = await fetch(`${supabaseUrl}/functions/v1/sync-research-news`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sync-secret": syncSecret,
      },
      body: "{}",
      signal: controller.signal,
    });
    const payload = await refreshResponse.json().catch(() => null);
    return {
      ok: refreshResponse.ok,
      status: refreshResponse.ok ? "refreshed" : "collector_error",
      http_status: refreshResponse.status,
      collector: payload,
    };
  } catch (error) {
    return {
      ok: false,
      status: error instanceof DOMException && error.name === "AbortError" ? "timeout" : "unavailable",
      message: "Shared source refresh failed; continue with the cached fact pack.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function earningsCalendar(
  service: any,
  userId: string,
  body: Record<string, unknown>,
) {
  const symbolFilter = body.symbol ? cleanSymbol(body.symbol) : null;
  const watchlist = await must(service
    .from("watchlist_items")
    .select("instrument_id")
    .eq("user_id", userId));
  const instrumentIds = unique((watchlist as Record<string, unknown>[]).map((item) => String(item.instrument_id)).filter(Boolean));
  let instrumentQuery = service
    .from("instruments")
    .select("id,symbol,display_name,asset_type,logo_url")
    .eq("user_id", userId)
    .in("asset_type", ["stock", "etf"]);
  if (instrumentIds.length) instrumentQuery = instrumentQuery.in("id", instrumentIds);
  else {
    return { entries: [], tracked_count: 0, last_synced_at: null, window_from: null, window_to: null };
  }
  if (symbolFilter) instrumentQuery = instrumentQuery.eq("symbol", symbolFilter);
  const instruments = await must(instrumentQuery);
  const instrumentBySymbol = new Map<string, Record<string, unknown>>();
  for (const instrument of instruments as Record<string, unknown>[]) {
    instrumentBySymbol.set(String(instrument.symbol).trim().toUpperCase(), instrument);
  }
  const symbols = [...instrumentBySymbol.keys()];
  const now = new Date();
  const windowFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const windowTo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const [events, syncState] = await Promise.all([
    symbols.length
      ? must(service
        .from("earnings_events")
        .select("id,symbol,earnings_date,report_hour,fiscal_quarter,fiscal_year,eps_estimate,eps_actual,revenue_estimate,revenue_actual,fetched_at")
        .eq("source", "finnhub")
        .eq("is_active", true)
        .in("symbol", symbols)
        .gte("earnings_date", windowFrom)
        .lte("earnings_date", windowTo)
        .order("earnings_date")
        .order("symbol"))
      : [],
    must(service
      .from("earnings_sync_state")
      .select("last_success_at")
      .eq("source", "finnhub")
      .maybeSingle()),
  ]);
  const reportSort: Record<string, number> = { bmo: 1, dmh: 2, amc: 3, tbd: 4 };
  const latestByEvent = new Map<string, Record<string, unknown>>();
  for (const event of events as Record<string, unknown>[]) {
    const key = `${event.symbol}:${event.earnings_date}`;
    const current = latestByEvent.get(key);
    if (!current || String(event.fetched_at) > String(current.fetched_at)) latestByEvent.set(key, event);
  }
  const entries: Record<string, unknown>[] = [...latestByEvent.values()]
    .map((event): Record<string, unknown> => {
      const instrument = instrumentBySymbol.get(String(event.symbol))!;
      return {
        ...event,
        instrument_id: instrument.id,
        display_name: instrument.display_name,
        asset_type: instrument.asset_type,
        logo_url: instrument.logo_url,
        report_sort: reportSort[String(event.report_hour)] || 4,
      };
    })
    .sort((left, right) => String(left.earnings_date).localeCompare(String(right.earnings_date))
      || Number(left.report_sort) - Number(right.report_sort)
      || String(left.symbol).localeCompare(String(right.symbol)));
  return {
    entries,
    tracked_count: instrumentBySymbol.size,
    last_synced_at: (syncState as Record<string, unknown> | null)?.last_success_at || null,
    window_from: windowFrom,
    window_to: windowTo,
  };
}

async function macroCalendar(
  service: any,
  body: Record<string, unknown>,
) {
  const today = newYorkDateKey();
  const from = macroDate(body.from, addDays(today, -2), "from");
  const to = macroDate(body.to, addDays(today, 35), "to");
  if (to < from || to > addDays(from, 366)) {
    throw new Error("Macro calendar window must be between 1 and 367 days");
  }
  const category = macroCategory(body.category);
  const limit = integer(body.limit, 200, 1, 500);
  const now = new Date().toISOString();
  const queryEnd = `${addDays(to, 1)}T00:00:00Z`;
  let entriesQuery = service
    .from("macro_events")
    .select(macroEventFields)
    .eq("is_active", true)
    .gte("scheduled_at", `${from}T00:00:00Z`)
    .lt("scheduled_at", queryEnd);
  if (category) entriesQuery = entriesQuery.eq("category", category);

  const [entries, nextEvent, nextFomc, syncState] = await Promise.all([
    must(entriesQuery.order("scheduled_at").order("event_name").limit(limit)),
    must(service
      .from("macro_events")
      .select(macroEventFields)
      .eq("is_active", true)
      .gte("scheduled_at", now)
      .order("scheduled_at")
      .order("event_name")
      .limit(1)
      .maybeSingle()),
    must(service
      .from("macro_events")
      .select(macroEventFields)
      .eq("is_active", true)
      .eq("event_group", "policy")
      .ilike("event_name", "FOMC Rate Decision%")
      .gte("scheduled_at", now)
      .order("scheduled_at")
      .limit(1)
      .maybeSingle()),
    must(service
      .from("macro_sync_state")
      .select("last_success_at")
      .eq("source", "fred_official")
      .maybeSingle()),
  ]);

  return {
    entries: entries || [],
    next_event: nextEvent || null,
    next_fomc: nextFomc || null,
    last_synced_at: (syncState as Record<string, unknown> | null)?.last_success_at || null,
    window_from: from,
    window_to: to,
  };
}

async function macroAlerts(service: any, body: Record<string, unknown>) {
  const hoursAhead = integer(body.hours_ahead, 24, 1, 168);
  const hoursBack = integer(body.hours_back, 12, 1, 168);
  const category = macroCategory(body.category);
  const now = new Date();
  const nowIso = now.toISOString();
  const aheadIso = new Date(now.getTime() + hoursAhead * 60 * 60_000).toISOString();
  const backIso = new Date(now.getTime() - hoursBack * 60 * 60_000).toISOString();
  let upcomingQuery = service
    .from("macro_events")
    .select(macroEventFields)
    .eq("is_active", true)
    .gte("scheduled_at", nowIso)
    .lte("scheduled_at", aheadIso);
  let releasedQuery = service
    .from("macro_events")
    .select(macroEventFields)
    .eq("is_active", true)
    .not("actual", "is", null)
    .gte("scheduled_at", backIso)
    .lte("scheduled_at", nowIso);
  let pendingQuery = service
    .from("macro_events")
    .select(macroEventFields)
    .eq("is_active", true)
    .in("source", ["fred", "university_michigan"])
    .is("actual", null)
    .gte("scheduled_at", backIso)
    .lte("scheduled_at", nowIso);
  if (category) {
    upcomingQuery = upcomingQuery.eq("category", category);
    releasedQuery = releasedQuery.eq("category", category);
    pendingQuery = pendingQuery.eq("category", category);
  }

  const [upcoming, released, pendingActual, nextFomc, syncState] = await Promise.all([
    must(upcomingQuery.order("scheduled_at").order("event_name").limit(100)),
    must(releasedQuery.order("scheduled_at", { ascending: false }).order("event_name").limit(100)),
    must(pendingQuery.order("scheduled_at", { ascending: false }).order("event_name").limit(100)),
    must(service
      .from("macro_events")
      .select(macroEventFields)
      .eq("is_active", true)
      .eq("event_group", "policy")
      .ilike("event_name", "FOMC Rate Decision%")
      .gte("scheduled_at", nowIso)
      .order("scheduled_at")
      .limit(1)
      .maybeSingle()),
    must(service
      .from("macro_sync_state")
      .select("last_success_at")
      .eq("source", "fred_official")
      .maybeSingle()),
  ]);

  return {
    generated_at: nowIso,
    alert_window: { hours_ahead: hoursAhead, hours_back: hoursBack },
    upcoming: upcoming || [],
    released: released || [],
    pending_actual: pendingActual || [],
    next_fomc: nextFomc || null,
    last_synced_at: (syncState as Record<string, unknown> | null)?.last_success_at || null,
    source_status: pendingActual?.length ? "AWAITING_ACTUAL" : "OK",
    guidance: "Use event id plus actual value to de-duplicate notifications. pending_actual means the scheduled release passed but its official value has not reached PCC yet; report the source delay instead of treating it as no event. Actual and previous are facts; do not infer a consensus or treat the comparison as trade advice.",
  };
}

async function macroRiskMonitor(service: any) {
  const snapshots = await must(service
    .from("macro_risk_snapshots")
    .select("snapshot_date,risk_score,risk_label,fear_greed_score,fear_greed_label,risk_components,fear_greed_components,source_dates,fetched_at")
    .order("snapshot_date", { ascending: false })
    .limit(8));

  return {
    generated_at: new Date().toISOString(),
    latest: snapshots[0] || null,
    recent: snapshots,
    guidance: "FRED-derived shared market context. Cite component source_url values and state the snapshot date; do not present the PCC composite as CNN's index.",
  };
}

async function briefingContext(
  service: any,
  userId: string,
  body: Record<string, unknown>,
) {
  const lookbackHours = integer(body.news_hours, 30, 6, 168);
  const now = new Date();
  const today = newYorkDateKey(now);
  const audience = body.audience === "personal" ? "personal" : "shared_market";

  if (audience === "shared_market") {
    const [market, marketNews, macro, alerts, riskSnapshots] = await Promise.all([
      must(service
        .from("market_pulse_latest")
        .select("*")
        .eq("user_id", userId)
        .or("is_benchmark.eq.true,is_sector.eq.true")
        .order("symbol")),
      sharedMarketNews(service, lookbackHours),
      macroCalendar(service, { from: addDays(today, -1), to: addDays(today, 14), limit: 200 }),
      macroAlerts(service, { hours_ahead: 72, hours_back: 18 }),
      must(service
        .from("macro_risk_snapshots")
        .select("snapshot_date,risk_score,risk_label,fear_greed_score,fear_greed_label,risk_components,fear_greed_components,source_dates,fetched_at")
        .order("snapshot_date", { ascending: false })
        .limit(8)),
    ]);

    return {
      generated_at: now.toISOString(),
      timezone: "Asia/Bangkok",
      audience,
      guidance: {
        canonical_brief: "Write one neutral US-market brief for every PCC reader. Research current external sources; use PCC only for verified market and macro context.",
        privacy: "Do not request, infer or mention any user's portfolios, positions, watchlist or private preferences.",
        sources: "Prefer official releases for primary facts and reputable current reporting for market context. Verify both publication time and event date before citing.",
        source_resilience: "Use cached_market_news when a live page blocks access, then cross-check with another cached publisher, an official source or web search. FRED supports macro facts but must never be used as filler for a market-news story.",
        unavailable_data: "Use null or omit the item. Never invent prices, consensus estimates, quotes or URLs.",
        continuation: "Compare against the published brief and write only material market-wide changes, not a second full brief.",
        midnight_market_check: "When the thesis is unchanged, retain one neutral completed-session Market Check with rotation leaders, laggards, read-through and the next catalyst. This routine check is saved silently and never creates a PCC notification.",
      },
      market_pulse: market,
      cached_market_news: marketNews,
      macro_risk: {
        latest: (riskSnapshots as Record<string, unknown>[])[0] || null,
        recent: riskSnapshots,
      },
      macro,
      macro_alerts: alerts,
    };
  }

  const portfolios = await ownedPortfolios(service, userId);
  const portfolioIds = portfolios.map((portfolio: Record<string, unknown>) => String(portfolio.id));
  const [dashboard, market, news, earnings, macro, alerts, positions, watchlist] = await Promise.all([
    overview(service, userId),
    must(service.from("market_pulse_latest").select("*").eq("user_id", userId).order("symbol")),
    researchNews(service, userId, { filter: "all", page: 1, page_size: 50 }),
    earningsCalendar(service, userId, {}),
    macroCalendar(service, { from: addDays(today, -1), to: addDays(today, 14), limit: 200 }),
    macroAlerts(service, { hours_ahead: 72, hours_back: 18 }),
    portfolioIds.length
      ? must(service.from("position_balances").select("*").in("portfolio_id", portfolioIds).gt("quantity", 0))
      : [],
    must(service.from("watchlist_items").select("*").eq("user_id", userId).order("created_at", { ascending: false })),
  ]);
  const newsCutoff = new Date(now.getTime() - lookbackHours * 60 * 60_000).toISOString();
  const newsEntries = ((news as Record<string, unknown>).entries as Record<string, unknown>[] || [])
    .filter((entry) => String(entry.published_at || "") >= newsCutoff);
  const instrumentIds = unique([
    ...(positions as Record<string, unknown>[]).map((position) => String(position.instrument_id)),
    ...(watchlist as Record<string, unknown>[]).map((item) => String(item.instrument_id)),
  ].filter(Boolean));
  const instruments = instrumentIds.length
    ? await must(service.from("instruments")
      .select("id,symbol,display_name,asset_type,underlying_symbol,logo_url")
      .eq("user_id", userId)
      .in("id", instrumentIds))
    : [];

  return {
    generated_at: now.toISOString(),
    timezone: "Asia/Bangkok",
    audience,
    guidance: {
      canonical_brief: "Use verified cached facts only. Separate facts from interpretation and cite every story with source ids.",
      unavailable_data: "Use null or omit the item. Never invent prices, consensus estimates, quotes or URLs.",
      continuation: "Compare against the published brief and write only material changes, not a second full brief.",
      midnight_market_check: "When the thesis is unchanged, retain one completed-session Market Check instead of discarding the useful rotation read.",
    },
    dashboard,
    market_pulse: market,
    portfolio_positions: positions,
    tracked_instruments: instruments,
    watchlist,
    news: { ...(news as Record<string, unknown>), entries: newsEntries, lookback_hours: lookbackHours },
    earnings,
    macro,
    macro_alerts: alerts,
  };
}

async function dailyMarketBrief(
  service: any,
  userId: string,
  body: Record<string, unknown>,
) {
  let query = service
    .from("market_briefs")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "published");
  if (body.brief_date) query = query.eq("brief_date", dateKey(body.brief_date, "brief_date"));
  const brief = await must(query.order("brief_date", { ascending: false }).order("published_at", { ascending: false }).limit(1).maybeSingle());
  if (!brief) return null;
  const updates = await must(service
    .from("market_brief_updates")
    .select("*")
    .eq("user_id", userId)
    .eq("brief_id", (brief as Record<string, unknown>).id)
    .order("published_at"));
  return { ...(brief as Record<string, unknown>), updates };
}

async function publishMarketBrief(
  service: any,
  identity: AgentIdentity,
  body: Record<string, unknown>,
) {
  const content = validateBriefContent(body.content);
  const sourceContext = body.source_context == null ? {} : jsonObject(body.source_context, "source_context");
  return await must(service.rpc("api_agent_publish_market_brief", {
    p_user_id: identity.user_id,
    p_agent_id: identity.token_id,
    p_brief_date: dateKey(body.brief_date, "brief_date"),
    p_summary: requiredText(body.summary, "summary"),
    p_content: content,
    p_source_context: sourceContext,
    p_idempotency_key: requiredText(body.idempotency_key, "idempotency_key", 160),
  }));
}

async function publishBriefContinuation(
  service: any,
  identity: AgentIdentity,
  body: Record<string, unknown>,
) {
  if (body.material_change !== true) {
    return { published: false, reason: "No material change. The canonical brief remains current." };
  }
  const thesisStatus = String(body.thesis_status || "").trim().toLowerCase();
  if (!["unchanged", "updated"].includes(thesisStatus)) {
    throw new Error("thesis_status must be unchanged or updated");
  }
  const materialScore = optionalNumber(body.material_score);
  if (materialScore != null && (materialScore < 0 || materialScore > 100)) {
    throw new Error("material_score must be between 0 and 100");
  }
  return await must(service.rpc("api_agent_publish_brief_continuation", {
    p_user_id: identity.user_id,
    p_agent_id: identity.token_id,
    p_brief_date: dateKey(body.brief_date, "brief_date"),
    p_thesis_status: thesisStatus,
    p_summary: requiredText(body.summary, "summary"),
    p_content: validateContinuationContent(body.content),
    p_source_context: body.source_context == null ? {} : jsonObject(body.source_context, "source_context"),
    p_material_score: materialScore,
    p_idempotency_key: requiredText(body.idempotency_key, "idempotency_key", 160),
  }));
}

async function publishMidnightMarketCheck(
  service: any,
  identity: AgentIdentity,
  body: Record<string, unknown>,
) {
  return await must(service.rpc("api_agent_publish_midnight_market_check", {
    p_user_id: identity.user_id,
    p_agent_id: identity.token_id,
    p_brief_date: dateKey(body.brief_date, "brief_date"),
    p_summary: requiredText(body.summary, "summary"),
    p_content: validateMarketCheckContent(body.content),
    p_source_context: body.source_context == null ? {} : jsonObject(body.source_context, "source_context"),
    p_idempotency_key: requiredText(body.idempotency_key, "idempotency_key", 160),
  }));
}

function smartMoneyEventKey(row: Record<string, unknown>) {
  return `${String(row.accession_number || "").trim()}:${String(row.transaction_key || "").trim()}`;
}

function smartMoneyFootnoteText(rawPayload: unknown) {
  if (!rawPayload || typeof rawPayload !== "object") return "";
  try {
    return JSON.stringify(rawPayload).replace(/\s+/g, " ").slice(0, 180);
  } catch {
    return "";
  }
}

async function smartMoneyBriefingContext(
  service: any,
  userId: string,
  includeAvailableKeys = false,
) {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
  const [rows, previousBriefs, syncStates] = await Promise.all([
    collectPages((from, to) => service
      .from("smart_money_events")
      .select("*")
      .eq("user_id", userId)
      .gte("filed_at", cutoff)
      .order("filed_at", { ascending: false })
      .order("created_at", { ascending: false })
      .range(from, to)),
    must(service
      .from("smart_money_briefs")
      .select("reported_event_keys,report_date,published_at")
      .eq("user_id", userId)
      .eq("status", "published")
      .order("published_at", { ascending: false })),
    must(service
      .from("smart_money_sync_state")
      .select("source,last_checked_at,last_success_at,last_filed_at,last_error")
      .eq("user_id", userId)),
  ]);
  const reportedKeys = new Set<string>((previousBriefs as Record<string, unknown>[])
    .flatMap((brief) => Array.isArray(brief.reported_event_keys) ? brief.reported_event_keys.map(String) : []));
  const sourceRows = rows as Record<string, unknown>[];
  const newRows = sourceRows.filter((row) => !reportedKeys.has(smartMoneyEventKey(row)));
  const instrumentIds = unique(newRows.map((row) => String(row.instrument_id || "")).filter(Boolean));
  const instruments = instrumentIds.length
    ? await must(service.from("instruments").select("id,symbol,display_name").in("id", instrumentIds))
    : [];
  const instrumentMap = new Map((instruments as Record<string, unknown>[])
    .map((instrument) => [String(instrument.id), instrument]));
  const latestState = [...(syncStates as Record<string, unknown>[])].sort((a, b) =>
    String(b.last_checked_at || "").localeCompare(String(a.last_checked_at || "")))[0] || null;
  const lastSuccessAt = (syncStates as Record<string, unknown>[])
    .map((state) => String(state.last_success_at || ""))
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  const freshnessAgeHours = lastSuccessAt
    ? (Date.now() - new Date(lastSuccessAt).getTime()) / 3_600_000
    : null;
  const freshnessStatus = freshnessAgeHours == null || freshnessAgeHours > 72
    ? "stale"
    : latestState?.last_error && String(latestState.last_checked_at || "") > String(lastSuccessAt)
      ? "partial"
      : "fresh";
  const availableRows = newRows.slice(0, 5000);
  const byValue = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    Number(b.transaction_value || 0) - Number(a.transaction_value || 0);
  const selectedDetailKeys = new Set<string>();
  const detailRows: Record<string, unknown>[] = [];
  const detailLimit = 36;
  const addDetailRows = (candidates: Record<string, unknown>[], limit: number) => {
    for (const row of candidates) {
      if (detailRows.length >= detailLimit || limit <= 0) break;
      const key = smartMoneyEventKey(row);
      if (selectedDetailKeys.has(key)) continue;
      selectedDetailKeys.add(key);
      detailRows.push(row);
      limit -= 1;
    }
  };
  const rowsForCode = (code: string) => availableRows
    .filter((row) => String(row.transaction_code || "").toUpperCase() === code)
    .sort(byValue);
  const diversifyByInstrument = (candidates: Record<string, unknown>[]) => {
    const seen = new Set<string>();
    const diverse: Record<string, unknown>[] = [];
    const repeats: Record<string, unknown>[] = [];
    for (const row of candidates) {
      const instrumentId = String(row.instrument_id || "unknown");
      if (seen.has(instrumentId)) repeats.push(row);
      else {
        seen.add(instrumentId);
        diverse.push(row);
      }
    }
    return [...diverse, ...repeats];
  };

  // Preserve every meaningful lane before filling the remaining response budget.
  // A single value-ranked P/S pool allowed large sales to crowd purchases and
  // mechanical context out of the weekly fact pack.
  addDetailRows(rowsForCode("P"), 20);
  addDetailRows(diversifyByInstrument(rowsForCode("S")), 12);
  addDetailRows(diversifyByInstrument(availableRows.filter((row) =>
    !["P", "S"].includes(String(row.transaction_code || "").toUpperCase()))), 4);
  addDetailRows(availableRows, detailLimit - detailRows.length);
  const compactEvents = detailRows.map((row, index) => {
    const instrument = instrumentMap.get(String(row.instrument_id || ""));
    const footnoteText = smartMoneyFootnoteText(row.raw_payload);
    const eventRef = `SM${String(index + 1).padStart(2, "0")}`;
    return {
      event_key: eventRef,
      ...(includeAvailableKeys ? { actual_event_key: smartMoneyEventKey(row) } : {}),
      symbol: String(instrument?.symbol || ""),
      company: String(instrument?.display_name || ""),
      filer_name: row.filer_name,
      filer_title: row.filer_title,
      relationship: row.relationship,
      transaction_code: row.transaction_code,
      side: row.side,
      transaction_date: row.transaction_date,
      filed_at: row.filed_at,
      shares: row.shares,
      price: row.price,
      transaction_value: row.transaction_value,
      ownership_nature: row.ownership_nature,
      is_derivative: row.is_derivative,
      sec_url: row.sec_url,
      source_id: `sec:${String(row.accession_number || row.id)}`,
      flags: {
        possible_10b5_1: /10b5-?1/i.test(footnoteText) || Boolean((row.raw_payload as Record<string, unknown> | null)?.aff_10b5_one),
        possible_drip: /dividend.{0,40}(reinvest|reinvestment)|automatic.{0,40}reinvest/i.test(footnoteText),
        possible_tax_or_award: /tax|withhold|award|vesting|rsu/i.test(footnoteText),
        possible_conversion_or_rights: /conversion|convert|rights offering|warrant|exercise/i.test(footnoteText),
      },
      filing_notes: footnoteText,
    };
  });
  const sideCount = (side: string) => sourceRows.filter((row) => String(row.side) === side).length;
  const newSideCount = (side: string) => newRows.filter((row) => String(row.side) === side).length;
  const transactionCodeCounts = newRows.reduce((counts, row) => {
    const code = String(row.transaction_code || "UNKNOWN").toUpperCase();
    counts[code] = (counts[code] || 0) + 1;
    return counts;
  }, {} as Record<string, number>);
  const sourceContext = {
    generated_at: new Date().toISOString(),
    window_days: 30,
    window_from: cutoff,
    freshness_status: freshnessStatus,
    freshness_age_hours: freshnessAgeHours == null ? null : Math.round(freshnessAgeHours * 10) / 10,
    last_checked_at: latestState?.last_checked_at || null,
    last_success_at: lastSuccessAt,
    last_error: latestState?.last_error || null,
    latest_filed_at: sourceRows[0]?.filed_at || null,
    total_events_in_window: sourceRows.length,
    previously_reported_in_window: sourceRows.length - newRows.length,
    new_event_count: newRows.length,
    consumed_event_count: availableRows.length,
    detailed_event_count: compactEvents.length,
    returned_event_count: compactEvents.length,
    response_truncated: newRows.length > availableRows.length,
    detail_sampling: "Compact stratified fact pack of up to 36 rows: up to 20 code-P purchases, 12 value-ranked code-S sales diversified across instruments, and 4 diversified other Form 4 rows, then newest remaining rows. Every available key is consumed after publication.",
    transaction_code_counts: transactionCodeCounts,
    counts: {
      all: { total: sourceRows.length, new: newRows.length },
      buy: { total: sideCount("buy"), new: newSideCount("buy") },
      sell: { total: sideCount("sell"), new: newSideCount("sell") },
      other: { total: sideCount("other"), new: newSideCount("other") },
    },
  };
  return {
    source_context: sourceContext,
    events: compactEvents,
    ...(includeAvailableKeys ? { available_event_keys: availableRows.map(smartMoneyEventKey) } : {}),
    previous_report: (previousBriefs as Record<string, unknown>[])[0] || null,
    guidance: {
      cadence: "Publish at most once per week using this rolling 30-day context.",
      deduplication: "Use the short SMxx event_key references exactly as returned. The server resolves them to immutable SEC transaction keys and consumes all available events on publication, including low-signal rows omitted from prose.",
      no_change: "If new_event_count is zero, do not publish and do not notify.",
      stale_source: "If freshness_status is stale, do not publish. Never describe stale coverage as no activity.",
      classification: "Treat only code P/S as purchases/sales. Separate 10b5-1, DRIP, tax, awards, exercises, conversions and rights offerings from conviction signals.",
      accuracy: "Aggregate transaction_value only when currency and filing footnotes support it. Preserve SEC links and state truncated coverage explicitly.",
    },
  };
}

async function publishSmartMoneyBrief(
  service: any,
  identity: AgentIdentity,
  body: Record<string, unknown>,
) {
  const reportDate = dateKey(body.report_date, "report_date");
  const context = await smartMoneyBriefingContext(service, identity.user_id, true);
  const sourceContext = context.source_context as Record<string, unknown>;
  if (sourceContext.freshness_status === "stale") {
    throw new Error("Smart Money source is stale. Wait for a successful collector run before publishing.");
  }
  const rawContent = jsonObject(body.content, "content");
  const rawHeadline = String(rawContent.headline || "").trim();
  const normalizedHeadline = rawHeadline.length > 180
    ? `${rawHeadline.slice(0, 179).trimEnd()}…`
    : rawHeadline;
  const contextEvents = Array.isArray(context.events) ? context.events as Record<string, unknown>[] : [];
  const eventsByKey = new Map(contextEvents.map((event) => [String(event.event_key || ""), event]));
  const eventsBySource = new Map(contextEvents.map((event) => [String(event.source_id || ""), event]));
  const inferredSources = new Map<string, Record<string, unknown>>();
  const normalizedSections: Record<string, unknown> = {};
  for (const sectionKey of ["open_market_buys", "sales_worth_context", "noise_removed", "watch_next"]) {
    const items = Array.isArray(rawContent[sectionKey]) ? rawContent[sectionKey] as unknown[] : [];
    normalizedSections[sectionKey] = items.map((value, index) => {
      const item = jsonObject(value, `content.${sectionKey}[${index}]`);
      const eventRefs = Array.isArray(item.event_keys) ? item.event_keys.map(String) : [];
      const eventKeys = eventRefs.map((eventRef) =>
        String(eventsByKey.get(eventRef)?.actual_event_key || eventRef));
      const sourceIds = unique(eventRefs
        .map((eventRef) => String(eventsByKey.get(eventRef)?.source_id || ""))
        .filter(Boolean));
      for (const sourceId of sourceIds) {
        const event = eventsBySource.get(sourceId);
        const url = String(event?.sec_url || "");
        if (!event || !url) continue;
        const symbol = String(event.symbol || event.company || "Form 4");
        inferredSources.set(sourceId, {
          id: sourceId,
          title: `${symbol} SEC Form 4 filing`,
          publisher: "SEC",
          url,
          published_at: event.filed_at || event.transaction_date || null,
        });
      }
      return { ...item, event_keys: eventKeys, source_ids: sourceIds };
    });
  }
  const suppliedSources = Array.isArray(rawContent.sources)
    ? rawContent.sources.map((source, index) => jsonObject(source, `content.sources[${index}]`))
    : [];
  const sourceMap = new Map<string, Record<string, unknown>>();
  suppliedSources.forEach((source) => sourceMap.set(String(source.id || ""), source));
  inferredSources.forEach((source, id) => {
    if (!sourceMap.has(id)) sourceMap.set(id, source);
  });
  const validated = validateSmartMoneyBriefContent({
    ...rawContent,
    headline: normalizedHeadline,
    ...normalizedSections,
    sources: [...sourceMap.values()].filter((source) => source.id).slice(0, 30),
  });
  const availableKeys = context.available_event_keys as string[];
  const available = new Set(availableKeys);
  const unavailable = validated.eventKeys.filter((key) => !available.has(key));
  if (unavailable.length) {
    throw new Error(`Smart Money brief contains already-reported or unavailable event keys: ${unavailable.slice(0, 3).join(", ")}`);
  }
  return await must(service.rpc("api_agent_publish_smart_money_brief", {
    p_user_id: identity.user_id,
    p_agent_id: identity.token_id,
    p_report_date: reportDate,
    p_summary: requiredText(body.summary, "summary"),
    p_content: validated.content,
    p_source_context: sourceContext,
    p_reported_event_keys: availableKeys,
    p_idempotency_key: requiredText(
      body.idempotency_key || `smart-money-brief:${reportDate}`,
      "idempotency_key",
      160,
    ),
  }));
}

async function overview(service: any, userId: string) {
  const portfolios = await ownedPortfolios(service, userId);
  const ids = portfolios.map((row: Record<string, unknown>) => String(row.id));
  const [cash, positions, journal, watchlist, smartMoney] = await Promise.all([
    ids.length ? must(service.from("portfolio_cash_balances").select("*").in("portfolio_id", ids)) : [],
    ids.length ? must(service.from("position_balances").select("*").in("portfolio_id", ids)) : [],
    must(service
      .from("journal_entries")
      .select("portfolio_id,manual_pnl,outcome,occurred_on")
      .eq("user_id", userId)
      .eq("is_void", false)
      .order("occurred_on", { ascending: false })
      .limit(2000)),
    must(service.from("watchlist_items").select("id").eq("user_id", userId)),
    must(service
      .from("smart_money_events")
      .select("id,side,filed_at")
      .eq("user_id", userId)
      .gte("filed_at", new Date(Date.now() - 24 * 60 * 60_000).toISOString())
      .limit(2000)),
  ]);
  const summaries = portfolios.map((portfolio: Record<string, unknown>) => {
    const portfolioId = String(portfolio.id);
    const portfolioPositions = positions.filter((row: Record<string, unknown>) => row.portfolio_id === portfolioId);
    const deployed = portfolioPositions.reduce((sum: number, row: Record<string, unknown>) =>
      sum + Number(portfolio.allocation_basis === "maximum_loss" ? row.maximum_loss : row.cost_basis || 0), 0);
    const cashBalance = Number(cash.find((row: Record<string, unknown>) => row.portfolio_id === portfolioId)?.cash_balance || 0);
    const pnl = journal
      .filter((row: Record<string, unknown>) => row.portfolio_id === portfolioId)
      .reduce((sum: number, row: Record<string, unknown>) => sum + Number(row.manual_pnl || 0), 0);
    return {
      id: portfolio.id,
      name: portfolio.name,
      kind: portfolio.kind,
      fixed_budget: Number(portfolio.fixed_budget || 0),
      cash_balance: cashBalance,
      deployed,
      total_capital: cashBalance + deployed,
      realized_pnl: pnl,
      open_positions: portfolioPositions.filter((row: Record<string, unknown>) => Number(row.quantity) > 0).length,
    };
  });
  return {
    portfolios: summaries,
    totals: {
      fixed_budget: summaries.reduce((sum: number, row: Record<string, unknown>) => sum + Number(row.fixed_budget), 0),
      cash_balance: summaries.reduce((sum: number, row: Record<string, unknown>) => sum + Number(row.cash_balance), 0),
      deployed: summaries.reduce((sum: number, row: Record<string, unknown>) => sum + Number(row.deployed), 0),
      realized_pnl: summaries.reduce((sum: number, row: Record<string, unknown>) => sum + Number(row.realized_pnl), 0),
      watchlist_count: watchlist.length,
      smart_money_24h: smartMoney.length,
    },
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return response({ error: "Method not allowed" }, 405);

  try {
    const token = bearerToken(request);
    if (!token) return response({ error: "Agent token required" }, 401);
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const service = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const authRows = await must(service.rpc("api_authenticate_agent_token", { p_token: token }));
    const identity = authRows?.[0] as AgentIdentity | undefined;
    if (!identity) return response({ error: "Invalid, expired, or revoked agent token" }, 401);
    requireScope(identity, "read");

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action || "").trim();
    if (!action) return response({ error: "action is required" }, 400);

    if (action === "claim_valuation_research") {
      requireScope(identity, "valuation:write");
      const jobId = body.job_id ? String(body.job_id).trim() : null;
      if (jobId && !/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error("job_id must be a UUID");
      const data = await must(service.rpc("api_agent_claim_valuation_research_job", {
        p_user_id: identity.user_id,
        p_agent_id: identity.token_id,
        p_job_id: jobId,
      }));
      return response({
        action,
        data,
        claimed: Boolean(data),
        message: data ? "Research job claimed for 15 minutes." : "No valuation research job is waiting.",
      });
    }

    if (action === "submit_valuation_research") {
      requireScope(identity, "valuation:write");
      const jobId = requiredText(body.job_id, "job_id", 36);
      const claimToken = requiredText(body.claim_token, "claim_token", 36);
      if (!/^[0-9a-f-]{36}$/i.test(jobId) || !/^[0-9a-f-]{36}$/i.test(claimToken)) {
        throw new Error("job_id and claim_token must be UUIDs returned by claim_valuation_research");
      }
      const reportPeriod = requiredText(body.report_period, "report_period", 7).toUpperCase();
      if (!/^\d{4}-Q[1-4]$/.test(reportPeriod)) throw new Error("report_period must be YYYY-QN");
      const { packet, fundamentals, forward, brief } = validateValuationResearchPacket(body.research_packet);
      const job = await must(service
        .from("valuation_research_jobs")
        .select("id,instrument_id,symbol,status,claim_token")
        .eq("id", jobId)
        .eq("user_id", identity.user_id)
        .maybeSingle());
      if (!job) throw new Error("Research job not found");
      const market = await must(service
        .from("instrument_prices")
        .select("price,market_time,fetched_at,source")
        .eq("user_id", identity.user_id)
        .eq("instrument_id", job.instrument_id)
        .order("fetched_at", { ascending: false })
        .limit(1)
        .maybeSingle());
      const valuation = buildValuation({
        fundamentals,
        forward,
        market: {
          price: market?.price ?? null,
          price_as_of: market?.market_time || market?.fetched_at || null,
          source: market?.source || null,
        },
      });
      const data = await must(service.rpc("api_agent_submit_valuation_research", {
        p_user_id: identity.user_id,
        p_agent_id: identity.token_id,
        p_job_id: jobId,
        p_claim_token: claimToken,
        p_report_period: reportPeriod,
        p_research_packet: packet,
        p_valuation: valuation,
        p_brief: brief,
        p_idempotency_key: String(body.idempotency_key || `valuation-research:${jobId}`).trim(),
      }));
      return response({
        action,
        data: { ...data, valuation },
        stored_as: "draft",
        deprecated: true,
        message: "Legacy research was stored. Upgrade the worker to submit_completed_valuation_research.",
      });
    }

    if (action === "submit_completed_valuation_research") {
      requireScope(identity, "valuation:write");
      const jobId = requiredText(body.job_id, "job_id", 36);
      const claimToken = requiredText(body.claim_token, "claim_token", 36);
      if (!/^[0-9a-f-]{36}$/i.test(jobId) || !/^[0-9a-f-]{36}$/i.test(claimToken)) {
        throw new Error("job_id and claim_token must be UUIDs returned by claim_valuation_research");
      }
      const reportPeriod = requiredText(body.report_period, "report_period", 7).toUpperCase();
      if (!/^\d{4}-Q[1-4]$/.test(reportPeriod)) throw new Error("report_period must be YYYY-QN");
      const idempotencyKey = requiredText(body.idempotency_key, "idempotency_key", 180);
      if (idempotencyKey.length < 8) throw new Error("idempotency_key must contain at least 8 characters");
      const { completedResearch, completedValuation } = validateCompletedValuationResearch(
        body.completed_research,
        body.completed_valuation,
      );
      const data = await must(service.rpc("api_agent_complete_valuation_research", {
        p_user_id: identity.user_id,
        p_agent_id: identity.token_id,
        p_job_id: jobId,
        p_claim_token: claimToken,
        p_report_period: reportPeriod,
        p_completed_research: completedResearch,
        p_completed_valuation: completedValuation,
        p_idempotency_key: idempotencyKey,
      }));
      return response({
        action,
        data,
        stored_as: "draft",
        message: "Ian’s completed research and valuation were saved as a revision.",
      });
    }

    if (action === "fail_valuation_research") {
      requireScope(identity, "valuation:write");
      const jobId = requiredText(body.job_id, "job_id", 36);
      const claimToken = requiredText(body.claim_token, "claim_token", 36);
      const message = requiredText(body.message, "message", 1200);
      if (!/^[0-9a-f-]{36}$/i.test(jobId) || !/^[0-9a-f-]{36}$/i.test(claimToken)) {
        throw new Error("job_id and claim_token must be UUIDs returned by claim_valuation_research");
      }
      const data = await must(service.rpc("api_agent_fail_valuation_research", {
        p_user_id: identity.user_id,
        p_agent_id: identity.token_id,
        p_job_id: jobId,
        p_claim_token: claimToken,
        p_message: message,
      }));
      return response({ action, data, message: "Research job marked failed and can be requested again." });
    }

    if (action === "refresh_brief_sources") {
      return response({ action, data: await refreshBriefSources(supabaseUrl) });
    }

    if (action === "overview") {
      return response({ action, data: await overview(service, identity.user_id) });
    }

    if (action === "portfolios") {
      return response({ action, data: await ownedPortfolios(service, identity.user_id) });
    }

    if (action === "portfolio_snapshot") {
      const portfolio = await resolvePortfolio(service, identity.user_id, body);
      return response({ action, data: await portfolioSnapshot(service, identity.user_id, portfolio) });
    }

    if (action === "resolve_rule_a_campaign") {
      requireScope(identity, "drafts:write");
      return response({ action, data: await resolveRuleACampaign(service, identity.user_id, body) });
    }

    if (action === "confirmed_execution_sync") {
      return response({ action, data: await confirmedExecutionSync(service, identity.user_id, body) });
    }

    if (action === "journal") {
      const page = integer(body.page, 1, 1, 100_000);
      const pageSize = integer(body.page_size, 50, 1, 200);
      let query = service
        .from("journal_entries")
        .select("*", { count: "exact" })
        .eq("user_id", identity.user_id)
        .eq("is_void", false);
      if (body.portfolio_id) query = query.eq("portfolio_id", String(body.portfolio_id));
      if (body.from) query = query.gte("occurred_on", String(body.from));
      if (body.to) query = query.lte("occurred_on", String(body.to));
      if (body.search) {
        const search = String(body.search).replaceAll(",", " ");
        query = query.or(`strategy_label.ilike.%${search}%,notes.ilike.%${search}%`);
      }
      const { data, error, count } = await query
        .order("occurred_on", { ascending: false })
        .range((page - 1) * pageSize, page * pageSize - 1);
      if (error) throw error;
      return response({ action, data: { rows: data || [], count: count || 0, page, page_size: pageSize } });
    }

    if (action === "sell_history") {
      const portfolios = await ownedPortfolios(service, identity.user_id);
      const ids = portfolios.map((row: Record<string, unknown>) => String(row.id));
      if (!ids.length) return response({ action, data: [] });
      let query = service
        .from("executions")
        .select("id,portfolio_id,instrument_id,quantity,price,multiplier,fee,gross_amount,cash_effect,realized_pnl,executed_at")
        .in("portfolio_id", ids)
        .eq("side", "sell");
      if (body.portfolio_id) query = query.eq("portfolio_id", String(body.portfolio_id));
      const rows = await must(query.order("executed_at", { ascending: false }).limit(integer(body.limit, 200, 1, 200)));
      return response({ action, data: rows });
    }

    if (action === "watchlist") {
      const items = await must(service
        .from("watchlist_items")
        .select("*")
        .eq("user_id", identity.user_id)
        .order("created_at", { ascending: false }));
      const ids = items.map((row: Record<string, unknown>) => String(row.instrument_id));
      const instruments = ids.length
        ? await must(service.from("instruments").select("*").eq("user_id", identity.user_id).in("id", ids))
        : [];
      const market = await must(service
        .from("market_pulse_latest")
        .select("*")
        .eq("user_id", identity.user_id)
        .eq("is_watchlist", true)
        .order("symbol"));
      return response({ action, data: { items, instruments, market } });
    }

    if (action === "news") {
      return response({ action, data: await researchNews(service, identity.user_id, body) });
    }

    if (action === "acknowledge_news") {
      return response({ action, data: await acknowledgeNews(service, identity.user_id, body) });
    }

    if (action === "requeue_news_alerts") {
      return response({ action, data: await requeueNewsAlerts(service, identity.user_id, body) });
    }

    if (action === "earnings") {
      return response({ action, data: await earningsCalendar(service, identity.user_id, body) });
    }

    if (action === "macro_calendar") {
      return response({ action, data: await macroCalendar(service, body) });
    }

    if (action === "macro_alerts") {
      return response({ action, data: await macroAlerts(service, body) });
    }

    if (action === "macro_risk_monitor") {
      return response({ action, data: await macroRiskMonitor(service) });
    }

    if (action === "briefing_context") {
      return response({ action, data: await briefingContext(service, identity.user_id, body) });
    }

    if (action === "daily_market_brief") {
      return response({ action, data: await dailyMarketBrief(service, identity.user_id, body) });
    }

    if (action === "publish_market_brief") {
      requireScope(identity, "briefings:write");
      return response({
        action,
        data: await publishMarketBrief(service, identity, body),
        published: true,
      });
    }

    if (action === "publish_brief_continuation") {
      requireScope(identity, "briefings:write");
      const data = await publishBriefContinuation(service, identity, body);
      return response({ action, data, published: (data as Record<string, unknown>)?.published !== false });
    }

    if (action === "publish_midnight_market_check") {
      requireScope(identity, "briefings:write");
      return response({
        action,
        data: await publishMidnightMarketCheck(service, identity, body),
        published: true,
        notified: false,
      });
    }

    if (action === "market_pulse") {
      let query = service.from("market_pulse_latest").select("*").eq("user_id", identity.user_id);
      if (body.section === "watchlist") query = query.eq("is_watchlist", true);
      if (body.section === "sectors") query = query.eq("is_sector", true);
      if (body.section === "benchmarks") query = query.eq("is_benchmark", true);
      const rows = await must(query.order("symbol"));
      return response({ action, data: rows });
    }

    if (action === "option_chain") {
      return response({
        action,
        data: await liveOptionChain(supabaseUrl, serviceRoleKey, identity.user_id, body),
      });
    }

    if (action === "option_analysis") {
      const strategy = String(body.strategy || "").trim().toLowerCase();
      if (!["long_call", "long_put", "covered_call", "cash_secured_put"].includes(strategy)) {
        throw new Error("strategy must be long_call, long_put, covered_call, or cash_secured_put");
      }
      const optionType = ["long_put", "cash_secured_put"].includes(strategy) ? "put" : "call";
      const portfolio = await resolvePortfolio(service, identity.user_id, body);
      const snapshot = await portfolioSnapshot(service, identity.user_id, portfolio);
      const chain = await liveOptionChain(supabaseUrl, serviceRoleKey, identity.user_id, {
        ...body,
        option_type: optionType,
      });
      return response({
        action,
        data: analyzeOptionDesk(chain, snapshot, { strategy, strike: body.strike }),
      });
    }

    if (action === "watchlist_setups") {
      return response({
        action,
        data: await watchlistSetupScan(service, supabaseUrl, serviceRoleKey, identity.user_id, body),
      });
    }

    if (action === "smart_money") {
      const days = integer(body.days, 30, 1, 365);
      const limit = integer(body.limit, 100, 1, 500);
      let query = service
        .from("smart_money_events")
        .select("*")
        .eq("user_id", identity.user_id)
        .gte("filed_at", new Date(Date.now() - days * 24 * 60 * 60_000).toISOString());
      if (["buy", "sell", "other"].includes(String(body.side))) query = query.eq("side", String(body.side));
      if (body.symbol) {
        const instrument = await resolveInstrument(service, identity.user_id, { symbol: body.symbol });
        query = query.eq("instrument_id", instrument.id);
      }
      const rows = await must(query.order("filed_at", { ascending: false }).limit(limit));
      return response({ action, data: rows });
    }

    if (action === "smart_money_briefing_context") {
      return response({ action, data: await smartMoneyBriefingContext(service, identity.user_id) });
    }

    if (action === "publish_smart_money_brief") {
      requireScope(identity, "briefings:write");
      return response({
        action,
        data: await publishSmartMoneyBrief(service, identity, body),
        published: true,
      });
    }

    if (action === "chart") {
      const instrument = await resolveInstrument(service, identity.user_id, body);
      if (!["stock", "etf"].includes(String(instrument.asset_type))) throw new Error("Charts support stocks and ETFs only");
      const chartResponse = await fetch(`${supabaseUrl}/functions/v1/refresh-stock-prices`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${serviceRoleKey}`,
          "apikey": serviceRoleKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "chart",
          user_id: identity.user_id,
          instrument_id: instrument.id,
          timespan: body.timespan || "D",
          count: integer(body.count, 190, 20, 600),
        }),
      });
      const payload = await chartResponse.json().catch(() => ({ error: "Chart service returned invalid JSON" }));
      return response(payload, chartResponse.status);
    }

    if (action === "create_trade_draft") {
      requireScope(identity, "drafts:write");
      const portfolio = await resolvePortfolio(service, identity.user_id, body);
      const instrument = await resolveInstrument(service, identity.user_id, body);
      const side = String(body.side || "").toLowerCase();
      if (!["buy", "sell"].includes(side)) throw new Error("side must be buy or sell");
      const executedAt = body.executed_at ? String(body.executed_at) : new Date().toISOString();
      let campaignId = body.campaign_id ? String(body.campaign_id) : null;
      let trancheNumber = optionalNumber(body.tranche_number);
      if (["swing_trade", "options"].includes(String(portfolio.kind))) {
        const resolved = await resolveRuleACampaign(service, identity.user_id, {
          ...body,
          portfolio_id: portfolio.id,
          instrument_id: instrument.id,
          side,
          executed_at: executedAt,
        }) as Record<string, unknown>;
        const resolvedCampaignId = String(resolved.campaign_id || "");
        if (!resolvedCampaignId) throw new Error("Rule A campaign resolver returned no campaign_id");
        if (campaignId && campaignId !== resolvedCampaignId) {
          throw new Error("campaign_id does not match deterministic Rule A resolution");
        }
        campaignId = resolvedCampaignId;
        trancheNumber = resolved.tranche_number == null ? null : Number(resolved.tranche_number);
      }
      const draft = await must(service.rpc("api_agent_create_trade_draft", {
        p_user_id: identity.user_id,
        p_agent_id: identity.token_id,
        p_portfolio_id: portfolio.id,
        p_instrument_id: instrument.id,
        p_side: side,
        p_quantity: positiveNumber(body.quantity, "quantity"),
        p_price: positiveNumber(body.price, "price"),
        p_idempotency_key: String(body.idempotency_key || `hermes-trade-${crypto.randomUUID()}`),
        p_fee: optionalNumber(body.fee) || 0,
        p_executed_at: executedAt,
        p_tranche_number: trancheNumber,
        p_underlying_price: optionalNumber(body.underlying_price),
        p_campaign_id: campaignId,
      }));
      return response({
        action,
        data: draft,
        requires_human_confirmation: true,
        message: "Draft created. Confirm it from Account > Agent drafts in Portfolio Command Center.",
      });
    }

    if (action === "create_cash_draft") {
      requireScope(identity, "drafts:write");
      const portfolio = await resolvePortfolio(service, identity.user_id, body);
      const movement = String(body.movement_type || "").toLowerCase();
      if (!["deposit", "withdrawal", "initial_funding", "dividend", "interest", "tax"].includes(movement)) {
        throw new Error("Unsupported cash movement type");
      }
      const draft = await must(service.rpc("api_agent_create_cash_draft", {
        p_user_id: identity.user_id,
        p_agent_id: identity.token_id,
        p_portfolio_id: portfolio.id,
        p_movement_type: movement,
        p_amount: positiveNumber(body.amount, "amount"),
        p_idempotency_key: String(body.idempotency_key || `hermes-cash-${crypto.randomUUID()}`),
        p_occurred_at: body.occurred_at ? String(body.occurred_at) : new Date().toISOString(),
        p_notes: body.notes ? String(body.notes).slice(0, 2000) : null,
      }));
      return response({
        action,
        data: draft,
        requires_human_confirmation: true,
        message: "Draft created. Confirm it from Account > Agent drafts in Portfolio Command Center.",
      });
    }

    if (action === "add_watchlist") {
      requireScope(identity, "watchlist:write");
      const symbol = cleanSymbol(body.symbol);
      const assetType = String(body.asset_type || "stock").toLowerCase();
      if (!["stock", "etf"].includes(assetType)) throw new Error("asset_type must be stock or etf");
      let instrument = await must(service
        .from("instruments")
        .select("*")
        .eq("user_id", identity.user_id)
        .eq("symbol", symbol)
        .eq("asset_type", assetType)
        .maybeSingle());
      if (!instrument) {
        instrument = await must(service
          .from("instruments")
          .insert({
            user_id: identity.user_id,
            instrument_key: `${assetType}:${symbol}`,
            asset_type: assetType,
            symbol,
            display_name: String(body.display_name || symbol).trim().slice(0, 160),
            exchange: null,
            currency: "USD",
            multiplier: 1,
          })
          .select("*")
          .single());
      }
      const item = await must(service
        .from("watchlist_items")
        .upsert({
          user_id: identity.user_id,
          instrument_id: instrument.id,
          notes: body.notes ? String(body.notes).slice(0, 500) : null,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id,instrument_id" })
        .select("*")
        .single());
      return response({ action, data: { item, instrument } });
    }

    if (action === "remove_watchlist") {
      requireScope(identity, "watchlist:write");
      const instrument = await resolveInstrument(service, identity.user_id, body);
      await must(service
        .from("watchlist_items")
        .delete()
        .eq("user_id", identity.user_id)
        .eq("instrument_id", instrument.id)
        .select("id"));
      return response({ action, data: { removed: true, instrument_id: instrument.id, symbol: instrument.symbol } });
    }

    return response({ error: `Unsupported action: ${action}` }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /missing scope/i.test(message) ? 403 : /not found/i.test(message) ? 404 : 400;
    return response({ error: message }, status);
  }
});
