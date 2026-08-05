export const dateOnly = (date) => date.toISOString().slice(0, 10);

export const shiftDays = (date, days) => {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
};

export const normalizeHour = (value) => {
  const hour = String(value || "").trim().toLowerCase();
  return ["bmo", "amc", "dmh"].includes(hour) ? hour : "tbd";
};

export const finiteOrNull = (value) => {
  if (value == null || value === "" || String(value).toLowerCase() === "none") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizedKey = (value) => value.replace(/[^a-z0-9]/gi, "").toLowerCase();

export const alphaValue = (event, ...keys) => {
  const normalized = new Map(Object.entries(event || {}).map(([key, value]) => [normalizedKey(key), value]));
  for (const key of keys) {
    const value = normalized.get(normalizedKey(key));
    if (value != null) return String(value).trim();
  }
  return "";
};

const prefer = (current, incoming) => current ?? incoming ?? null;

function mergeFinnhubEvents(current, incoming) {
  if (!current) return { ...incoming };
  const currentHour = normalizeHour(current.hour);
  const incomingHour = normalizeHour(incoming.hour);
  return {
    ...current,
    hour: currentHour !== "tbd" ? currentHour : incomingHour,
    quarter: prefer(current.quarter, incoming.quarter),
    year: prefer(current.year, incoming.year),
    epsEstimate: prefer(current.epsEstimate, incoming.epsEstimate),
    epsActual: prefer(current.epsActual, incoming.epsActual),
    revenueEstimate: prefer(current.revenueEstimate, incoming.revenueEstimate),
    revenueActual: prefer(current.revenueActual, incoming.revenueActual),
  };
}

export function buildCanonicalRows({
  finnhubCalendar,
  alphaCalendar = [],
  tracked,
  windowFrom,
  windowTo,
  existingByEventKey = new Map(),
  syncedAt = new Date().toISOString(),
}) {
  const trackedSymbols = tracked instanceof Set ? tracked : new Set(tracked || []);
  const alphaByExactEvent = new Map();
  for (const event of alphaCalendar || []) {
    const symbol = alphaValue(event, "symbol", "ticker").toUpperCase();
    const date = alphaValue(event, "reportDate", "earningsDate", "date");
    if (trackedSymbols.has(symbol) && date >= windowFrom && date <= windowTo) {
      alphaByExactEvent.set(`${symbol}:${date}`, event);
    }
  }

  const finnhubByExactEvent = new Map();
  for (const event of finnhubCalendar || []) {
    const symbol = String(event?.symbol || "").trim().toUpperCase();
    const earningsDate = String(event?.date || "");
    if (!trackedSymbols.has(symbol)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(earningsDate)) continue;
    if (earningsDate < windowFrom || earningsDate > windowTo) continue;
    const key = `${symbol}:${earningsDate}`;
    finnhubByExactEvent.set(key, mergeFinnhubEvents(finnhubByExactEvent.get(key), event));
  }

  return [...finnhubByExactEvent.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([eventKey, event]) => {
      const symbol = String(event.symbol || "").trim().toUpperCase();
      const earningsDate = String(event.date || "");
      const alpha = alphaByExactEvent.get(eventKey);
      const existing = existingByEventKey.get(eventKey) || {};
      return {
        source: "finnhub",
        event_key: eventKey,
        symbol,
        earnings_date: earningsDate,
        // Date and session always come from the same Finnhub record. No other
        // provider may move an event into a different day or session bucket.
        report_hour: normalizeHour(event.hour),
        fiscal_quarter: event.quarter ?? existing.fiscal_quarter ?? null,
        fiscal_year: event.year ?? existing.fiscal_year ?? null,
        eps_estimate: finiteOrNull(event.epsEstimate)
          ?? finiteOrNull(alpha ? alphaValue(alpha, "estimate", "epsEstimate", "estimatedEPS") : null)
          ?? finiteOrNull(existing.eps_estimate),
        eps_actual: finiteOrNull(event.epsActual) ?? finiteOrNull(existing.eps_actual),
        revenue_estimate: finiteOrNull(event.revenueEstimate) ?? finiteOrNull(existing.revenue_estimate),
        revenue_actual: finiteOrNull(event.revenueActual) ?? finiteOrNull(existing.revenue_actual),
        is_active: true,
        raw_payload: {
          schedule_authority: "finnhub",
          metrics_enrichment: alpha ? "alpha_vantage_exact_date" : null,
          finnhub: event,
          alpha_vantage: alpha || null,
        },
        fetched_at: syncedAt,
        updated_at: syncedAt,
      };
    });
}
