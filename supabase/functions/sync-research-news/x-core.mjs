export const X_POST_READ_USD = 0.005;
export const X_MONTHLY_POST_TARGET = 900;
export const X_MONTHLY_POST_HARD_LIMIT = 1000;

const SOURCE_PLANS = Object.freeze({
  reuters: Object.freeze({
    sourceKey: "reuters",
    displayName: "@Reuters",
    monthlyLimit: 600,
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
    monthlyLimit: 150,
    maxResults: 5,
    mode: "timeline",
    briefCandidate: false,
    windows: Object.freeze([Object.freeze({ key: "news", hour: 12 })]),
  }),
  naklongpoong: Object.freeze({
    sourceKey: "naklongpoong",
    displayName: "@naklongpoong",
    monthlyLimit: 150,
    maxResults: 5,
    mode: "timeline",
    briefCandidate: false,
    windows: Object.freeze([Object.freeze({ key: "news", hour: 12 })]),
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
    "(stocks OR shares OR market OR futures OR Fed OR FOMC OR inflation OR CPI OR PPI OR PCE OR payrolls OR unemployment OR Treasury OR yields OR oil OR crude OR OPEC OR Iran OR earnings OR semiconductor OR AI)",
    "has:links -is:retweet -is:reply lang:en",
  ].join(" ");
}
