import { createClient } from "npm:@supabase/supabase-js@2";

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

async function researchNews(
  service: any,
  userId: string,
  body: Record<string, unknown>,
) {
  const filter = String(body.filter || "all").trim().toLowerCase();
  if (!["all", "unread", "portfolio", "macro", "saved"].includes(filter)) {
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
      .select("article_id,is_read,is_saved,is_hidden")
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
      return {
        ...article,
        ...scope,
        is_read: Boolean(state?.is_read),
        is_saved: Boolean(state?.is_saved),
        is_hidden: Boolean(state?.is_hidden),
      };
    })
    .filter((entry) => entry.source !== "x" || (entry.keywords as string[]).includes("X_SIGNAL"))
    .filter((entry) => !searchTicker || (entry.tickers as string[]).includes(searchTicker))
    .filter((entry) => !entry.is_hidden)
    .filter((entry) => filter !== "unread" || !entry.is_read)
    .filter((entry) => filter !== "portfolio" || entry.is_portfolio)
    .filter((entry) => filter !== "saved" || entry.is_saved)
    .filter((entry) => filter !== "macro"
      || ((entry.keywords as string[]).includes("MARKET_MACRO") && !(entry.keywords as string[]).includes("TICKER_EVENT")))
    .sort((left, right) => String(right.published_at).localeCompare(String(left.published_at))
      || String(right.id).localeCompare(String(left.id)));
  const offset = (page - 1) * pageSize;
  return {
    entries: entries.slice(offset, offset + pageSize),
    total_count: entries.length,
    page,
    page_size: pageSize,
    filter,
    search_ticker: searchTicker,
  };
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
  if (category) {
    upcomingQuery = upcomingQuery.eq("category", category);
    releasedQuery = releasedQuery.eq("category", category);
  }

  const [upcoming, released, nextFomc, syncState] = await Promise.all([
    must(upcomingQuery.order("scheduled_at").order("event_name").limit(100)),
    must(releasedQuery.order("scheduled_at", { ascending: false }).order("event_name").limit(100)),
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
    next_fomc: nextFomc || null,
    last_synced_at: (syncState as Record<string, unknown> | null)?.last_success_at || null,
    guidance: "Use event id plus actual value to de-duplicate notifications. Actual and previous are facts; do not infer a consensus or treat the comparison as trade advice.",
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
    const [market, macro, alerts, riskSnapshots] = await Promise.all([
      must(service
        .from("market_pulse_latest")
        .select("*")
        .eq("user_id", userId)
        .or("is_benchmark.eq.true,is_sector.eq.true")
        .order("symbol")),
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
        source_resilience: "Live web research is enrichment, not a single point of failure. If sites block access, publish a clearly limited edition from fresh PCC market pulse, FRED macro risk and official calendar facts; omit unsupported claims instead of omitting the whole brief.",
        unavailable_data: "Use null or omit the item. Never invent prices, consensus estimates, quotes or URLs.",
        continuation: "Compare against the published brief and write only material market-wide changes, not a second full brief.",
      },
      market_pulse: market,
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

    if (action === "market_pulse") {
      let query = service.from("market_pulse_latest").select("*").eq("user_id", identity.user_id);
      if (body.section === "watchlist") query = query.eq("is_watchlist", true);
      if (body.section === "sectors") query = query.eq("is_sector", true);
      if (body.section === "benchmarks") query = query.eq("is_benchmark", true);
      const rows = await must(query.order("symbol"));
      return response({ action, data: rows });
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

    if (action === "chart") {
      const instrument = await resolveInstrument(service, identity.user_id, body);
      if (!["stock", "etf"].includes(String(instrument.asset_type))) throw new Error("Charts support stocks and ETFs only");
      const chartResponse = await fetch(`${supabaseUrl}/functions/v1/refresh-stock-prices`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "chart",
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
