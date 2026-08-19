export const X_POST_READ_USD = 0.005;
export const X_MONTHLY_POST_TARGET = 900;
export const X_MONTHLY_POST_HARD_LIMIT = 1000;

const SOURCE_PLANS = Object.freeze({
  reuters: Object.freeze({
    sourceKey: "reuters",
    displayName: "@Reuters",
    monthlyLimit: 460,
    maxResults: 10,
    mode: "search",
    briefCandidate: true,
    windows: Object.freeze([
      Object.freeze({ key: "brief", hour: 19 }),
      Object.freeze({ key: "continuation", hour: 23 }),
    ]),
  }),
  stocksavvyshay: Object.freeze({
    sourceKey: "stocksavvyshay",
    displayName: "@stocksavvyshay",
    monthlyLimit: 440,
    maxResults: 5,
    mode: "timeline",
    briefCandidate: false,
    windows: Object.freeze([
      Object.freeze({ key: "premarket", hour: 17 }),
      Object.freeze({ key: "open", hour: 21 }),
      Object.freeze({ key: "late", hour: 1 }),
      Object.freeze({ key: "postmarket", hour: 3 }),
    ]),
  }),
});

export function normalizeXHandle(value) {
  return String(value || "").replace(/^@/, "").trim().toLowerCase();
}

export function xSourcePlan(value) {
  return SOURCE_PLANS[normalizeXHandle(value)] || null;
}

export function bangkokClock(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  const dateKey = `${get("year")}-${get("month")}-${get("day")}`;
  return {
    dateKey,
    monthKey: `${get("year")}-${get("month")}-01`,
    hour: Number(get("hour")),
  };
}

function shiftDateKey(dateKey, days) {
  const value = new Date(`${dateKey}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * @param {string} sourceKey
 * @param {Date} [value]
 * @param {string | null | undefined} [lastWindowKey]
 */
export function dueXWindow(sourceKey, value = new Date(), lastWindowKey = null) {
  const plan = xSourcePlan(sourceKey);
  if (!plan) return null;
  const clock = bangkokClock(value);
  if (plan.sourceKey === "reuters" && clock.hour < 3) {
    const latest = plan.windows[plan.windows.length - 1];
    const windowKey = `${shiftDateKey(clock.dateKey, -1)}:${latest.key}`;
    return windowKey === lastWindowKey ? null : windowKey;
  }
  if (plan.sourceKey === "stocksavvyshay") {
    const window = clock.hour >= 21
      ? plan.windows.find((candidate) => candidate.key === "open")
      : clock.hour >= 17
      ? plan.windows.find((candidate) => candidate.key === "premarket")
      : clock.hour >= 3 && clock.hour < 7
      ? plan.windows.find((candidate) => candidate.key === "postmarket")
      : clock.hour < 3
      ? plan.windows.find((candidate) => candidate.key === "late")
      : null;
    if (!window) return null;
    const windowKey = `${clock.dateKey}:${window.key}`;
    return windowKey === lastWindowKey ? null : windowKey;
  }
  const eligible = plan.windows.filter((window) => clock.hour >= window.hour);
  if (!eligible.length) return null;
  const latest = eligible[eligible.length - 1];
  const windowKey = `${clock.dateKey}:${latest.key}`;
  return windowKey === lastWindowKey ? null : windowKey;
}

export function xBudgetAllowance(sourceKey, usageRows = []) {
  const plan = xSourcePlan(sourceKey);
  if (!plan) return 0;
  const sourceUsed = usageRows
    .filter((row) => normalizeXHandle(row.source_key) === plan.sourceKey)
    .reduce((sum, row) => sum + Number(row.posts_read || 0), 0);
  const globalUsed = usageRows.reduce((sum, row) => sum + Number(row.posts_read || 0), 0);
  return Math.max(0, Math.min(
    plan.maxResults,
    plan.monthlyLimit - sourceUsed,
    X_MONTHLY_POST_TARGET - globalUsed,
    X_MONTHLY_POST_HARD_LIMIT - globalUsed,
  ));
}

export function groupXSubscriptions(subscriptions = []) {
  const groups = new Map();
  for (const subscription of subscriptions) {
    const sourceKey = normalizeXHandle(subscription.source_key);
    if (!xSourcePlan(sourceKey)) continue;
    if (!groups.has(sourceKey)) groups.set(sourceKey, []);
    groups.get(sourceKey).push({ ...subscription, source_key: sourceKey });
  }
  return groups;
}

export function reutersSearchQuery(handle = "reuters") {
  return [
    `from:${normalizeXHandle(handle)}`,
    "((\"Wall Street\" OR \"S&P 500\" OR Nasdaq OR Dow OR futures) OR (Fed OR FOMC OR CPI OR PPI OR PCE OR inflation OR payrolls OR unemployment OR Treasury OR yields) OR ((oil OR crude OR OPEC OR Hormuz) (prices OR supply OR sanctions OR rises OR falls)) OR ((earnings OR guidance) (\"S&P 500\" OR Nasdaq OR chips OR semiconductor OR AI)))",
    "has:links -is:retweet -is:reply lang:en",
  ].join(" ");
}

const reutersMarketPattern = /\b(wall street|s&p(?: 500)?|nasdaq|dow|stocks?|shares?|market|futures?|fed|fomc|powell|interest rates?|rate (?:cut|hike)|cpi|ppi|pce|inflation|payrolls?|nonfarm|unemployment|jobless|treasury|bond yields?|yield curve|oil|crude|opec|hormuz|tariffs?|sanctions?|earnings|guidance|semiconductor|chips?)\b/i;
const reutersImpactPattern = /\b(rises?|rall(?:y|ies)|gains?|jumps?|falls?|drops?|slides?|slumps?|selloff|record high|cuts?|hikes?|holds?|beats?|misses?|warns?|forecast|surprise|impasse|deal|attack|blockade|disrupt(?:s|ion)?|supply|demand|percent|bps)\b|[%$]/i;
const reutersHighPattern = /\b(fed|fomc|rate decision|cpi|ppi|pce|payrolls?|nonfarm|unemployment|jobless claims|treasury yields?|oil|crude|opec|hormuz|tariffs?|sanctions?|war|attack|blockade)\b/i;
const stockHighPattern = /\b(earnings?|guidance|revenue|margin|free cash flow|fcf|contract|customer|partnership|consortium|acquir(?:e|es|ed|ing)|merger|buyout|offering|bankrupt(?:cy)?|sec filing|fda|doj|ftc|investigation|layoffs?|forecast|estimate|deployment|facility|capacity|capex|investor day|tariff refund|stake|ownership)\b/i;
const stockMediumPattern = /\b(product|launch(?:es|ed)?|introduc(?:e|es|ed)|technology|benchmark|performance|demand|market share|pricing|valuation|data cent(?:er|re)|ai infrastructure|chip|memory|flash|hbm|hbf|gpu|hyperscaler|order|target|outlook|growth)\b/i;
const numericEvidencePattern = /(?:\b\d+(?:\.\d+)?\s*(?:%|b|m|k|mw|gw|tb|gb)\b|[$~]\s*\d)/i;

export function assessXContent(sourceKey, { text = "", tickers = [] } = {}) {
  const source = normalizeXHandle(sourceKey);
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  const hasTicker = Array.isArray(tickers) && tickers.length > 0;
  const hasNumbers = numericEvidencePattern.test(compact);

  if (source === "reuters") {
    const marketRelevant = reutersMarketPattern.test(compact);
    const hasImpact = reutersImpactPattern.test(compact);
    const keep = marketRelevant && (hasImpact || reutersHighPattern.test(compact));
    return {
      keep,
      alertLevel: keep && reutersHighPattern.test(compact) && hasImpact ? "HIGH" : keep ? "MEDIUM" : null,
      desk: "MARKET_DESK",
    };
  }

  if (source === "stocksavvyshay") {
    const highSignal = stockHighPattern.test(compact);
    const mediumSignal = stockMediumPattern.test(compact);
    const keep = hasTicker && (highSignal || mediumSignal || hasNumbers);
    return {
      keep,
      alertLevel: keep && highSignal ? "HIGH" : keep ? "MEDIUM" : null,
      desk: "STOCK_DESK",
    };
  }

  return { keep: false, alertLevel: null, desk: null };
}
