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

const normalizeAlphaHour = (value) => {
  const hour = String(value || "").trim().toLowerCase();
  if (["pre-market", "premarket", "before market open", "before open", "bmo"].includes(hour)) return "bmo";
  if (["post-market", "postmarket", "after market close", "after close", "amc"].includes(hour)) return "amc";
  if (["during market hours", "dmh"].includes(hour)) return "dmh";
  return "tbd";
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
  yahooCalendar = [],
  tracked,
  windowFrom,
  windowTo,
  existingByEventKey = new Map(),
  syncedAt = new Date().toISOString(),
}) {
  const asOfDate = String(syncedAt).slice(0, 10);
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

  const finnhubSymbols = new Set(
    [...finnhubByExactEvent.values()].map((event) => String(event.symbol || "").trim().toUpperCase()),
  );
  const yahooByExactEvent = new Map();
  for (const event of yahooCalendar || []) {
    const symbol = String(event?.symbol || "").trim().toUpperCase();
    const date = String(event?.date || "");
    if (!trackedSymbols.has(symbol) || finnhubSymbols.has(symbol)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < windowFrom || date > windowTo) continue;
    yahooByExactEvent.set(`${symbol}:${date}`, event);
  }

  // A fallback row exists only when Alpha and Yahoo independently agree on
  // the exact symbol and date. It is never allowed to replace or move a
  // Finnhub row for the same symbol.
  const fallbackBySymbol = new Map();
  for (const [eventKey, alpha] of alphaByExactEvent.entries()) {
    const [symbol, earningsDate] = eventKey.split(":");
    if (finnhubSymbols.has(symbol)) continue;
    const yahoo = yahooByExactEvent.get(eventKey);
    if (!yahoo) continue;
    const candidate = { eventKey, symbol, earningsDate, alpha, yahoo };
    const current = fallbackBySymbol.get(symbol);
    if (!current || candidate.earningsDate < current.earningsDate) fallbackBySymbol.set(symbol, candidate);
  }

  // Provider windows stop returning dates after they have passed. Preserve a
  // previously collected missing-ticker row only when its own Alpha payload
  // proves the same symbol/date and supplies a real market session. This
  // restores past events without letting legacy rows move a Finnhub symbol or
  // introduce a future estimate that can still change.
  for (const [eventKey, existing] of existingByEventKey.entries()) {
    const separator = eventKey.lastIndexOf(":");
    const symbol = eventKey.slice(0, separator).toUpperCase();
    const earningsDate = eventKey.slice(separator + 1);
    if (!trackedSymbols.has(symbol) || finnhubSymbols.has(symbol) || fallbackBySymbol.has(symbol)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(earningsDate) || earningsDate < windowFrom || earningsDate > windowTo) continue;
    if (earningsDate >= asOfDate) continue;
    const payload = existing?.raw_payload && typeof existing.raw_payload === "object" ? existing.raw_payload : {};
    const alpha = payload.alpha_vantage;
    const alphaSymbol = alphaValue(alpha, "symbol", "ticker").toUpperCase();
    const alphaDate = alphaValue(alpha, "reportDate", "earningsDate", "date");
    if (alphaSymbol !== symbol || alphaDate !== earningsDate) continue;
    const confirmedHour = normalizeHour(payload?.confirmed_schedule?.hour);
    const alphaHour = normalizeAlphaHour(alphaValue(alpha, "timeOfTheDay", "reportTime", "hour"));
    const hour = confirmedHour !== "tbd" ? confirmedHour : alphaHour;
    if (hour === "tbd") continue;
    fallbackBySymbol.set(symbol, {
      eventKey,
      symbol,
      earningsDate,
      alpha,
      yahoo: null,
      preservedHour: hour,
      preservedPayload: payload,
    });
  }

  const finnhubRows = [...finnhubByExactEvent.entries()]
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

  const fallbackRows = [...fallbackBySymbol.values()].map(({ eventKey, symbol, earningsDate, alpha, yahoo, preservedHour, preservedPayload }) => {
    const existing = existingByEventKey.get(eventKey) || {};
    const isPreservedPast = Boolean(preservedHour);
    return {
      // Keep the existing source value for the RPC and unique constraint. The
      // schedule authority is explicit inside raw_payload.
      source: "finnhub",
      event_key: eventKey,
      symbol,
      earnings_date: earningsDate,
      report_hour: isPreservedPast ? preservedHour : normalizeHour(yahoo.hour),
      fiscal_quarter: existing.fiscal_quarter ?? null,
      fiscal_year: existing.fiscal_year ?? null,
      eps_estimate: finiteOrNull(alphaValue(alpha, "estimate", "epsEstimate", "estimatedEPS"))
        ?? finiteOrNull(existing.eps_estimate),
      eps_actual: finiteOrNull(existing.eps_actual),
      revenue_estimate: finiteOrNull(existing.revenue_estimate),
      revenue_actual: finiteOrNull(existing.revenue_actual),
      is_active: true,
      raw_payload: {
        schedule_authority: isPreservedPast ? "preserved_past_alpha_exact" : "alpha_yahoo_exact_match",
        metrics_enrichment: "alpha_vantage",
        finnhub: null,
        alpha_vantage: alpha,
        yahoo_finance: yahoo ? (yahoo.raw || yahoo) : (preservedPayload?.yahoo_finance || null),
        confirmed_schedule: preservedPayload?.confirmed_schedule || null,
      },
      fetched_at: syncedAt,
      updated_at: syncedAt,
    };
  });

  return [...finnhubRows, ...fallbackRows]
    .sort((left, right) => left.event_key.localeCompare(right.event_key));
}
