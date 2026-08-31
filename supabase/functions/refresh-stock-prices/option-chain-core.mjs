function firstValue(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function numberValue(row, keys) {
  const raw = firstValue(row, keys);
  const value = raw && typeof raw === "object" ? raw.price ?? raw.value : raw;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function textValue(row, keys) {
  const value = firstValue(row, keys);
  return value === null ? "" : String(value).trim();
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

function optionType(value, symbol = "") {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "CALL" || normalized === "C") return "call";
  if (normalized === "PUT" || normalized === "P") return "put";
  const occ = String(symbol).toUpperCase().match(/\d{6}([CP])\d{8}$/);
  return occ?.[1] === "C" ? "call" : occ?.[1] === "P" ? "put" : "";
}

export function normalizeOptionContract(row) {
  const symbol = textValue(row, ["symbol", "option_symbol", "ticker"]);
  const strike = numberValue(row, ["strike_price", "strike", "exercise_price", "option_exercise_price"]);
  const expiry = normalizeDate(firstValue(row, ["expire_date", "expiration_date", "expiry", "option_expire_date", "exp_date"]));
  const type = optionType(firstValue(row, ["option_type", "type", "call_put"]), symbol);
  if (!symbol || !expiry || !type || strike === null || strike <= 0) return null;
  return {
    instrument_id: textValue(row, ["instrument_id", "ticker_id"]) || null,
    symbol,
    underlying_symbol: textValue(row, ["underlying_symbol", "underlying", "base_symbol"]) || null,
    expiry,
    option_type: type,
    strike,
    multiplier: numberValue(row, ["multiplier", "contract_multiplier", "option_contract_multiplier"]) || 100,
    style: textValue(row, ["style", "exercise_style"]) || null,
    status: textValue(row, ["status", "listing_status"]) || null,
  };
}

export function normalizeOptionSnapshot(row) {
  const symbol = textValue(row, ["symbol", "option_symbol", "ticker"]);
  if (!symbol) return null;
  const bid = numberValue(row, ["bid", "bid_price", "best_bid", "best_bid_price", "bid1"]);
  const ask = numberValue(row, ["ask", "ask_price", "best_ask", "best_ask_price", "ask1"]);
  const last = numberValue(row, ["price", "last_price", "close"]);
  const quoteTimeRaw = firstValue(row, ["quote_time", "last_trade_time", "timestamp", "time"]);
  const quoteTimeNumber = Number(quoteTimeRaw);
  const quoteTime = Number.isFinite(quoteTimeNumber)
    ? new Date(quoteTimeNumber < 10_000_000_000 ? quoteTimeNumber * 1000 : quoteTimeNumber).toISOString()
    : normalizeDate(quoteTimeRaw) || null;
  return {
    symbol,
    instrument_id: textValue(row, ["instrument_id", "ticker_id"]) || null,
    bid,
    ask,
    last,
    bid_size: numberValue(row, ["bid_size", "best_bid_size", "bid_volume"]),
    ask_size: numberValue(row, ["ask_size", "best_ask_size", "ask_volume"]),
    volume: numberValue(row, ["volume", "trade_volume"]),
    open_interest: numberValue(row, ["open_interest", "openInterest", "oi"]),
    delta: numberValue(row, ["delta"]),
    gamma: numberValue(row, ["gamma"]),
    theta: numberValue(row, ["theta"]),
    vega: numberValue(row, ["vega"]),
    rho: numberValue(row, ["rho"]),
    implied_volatility: numberValue(row, ["imp_vol", "implied_volatility", "iv"]),
    quote_time: quoteTime,
  };
}

export function expirationChoices(contracts, today = new Date().toISOString().slice(0, 10)) {
  return [...new Set(contracts.filter((item) => item.expiry >= today).map((item) => item.expiry))]
    .sort()
    .map((expiry) => ({
      value: expiry,
      dte: Math.max(0, Math.ceil((Date.parse(`${expiry}T20:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)),
    }));
}

export function chooseExpiry(expiries, requested) {
  if (requested && expiries.some((item) => item.value === requested)) return requested;
  return expiries.find((item) => item.dte >= 7)?.value || expiries[0]?.value || null;
}

export function isStandardOptionContract(contract, underlying) {
  const symbol = String(contract?.symbol || "").trim().toUpperCase();
  const expectedRoot = String(underlying || contract?.underlying_symbol || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const match = symbol.match(/^([A-Z][A-Z0-9]{0,5})\d{6}[CP]\d{8}$/);
  return Boolean(match && expectedRoot && match[1] === expectedRoot);
}

export function nearestContracts(contracts, { expiry, optionType: type, spot, limit = 16 }) {
  const candidates = contracts.filter((item) => item.expiry === expiry && item.option_type === type);
  return candidates
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot) || a.strike - b.strike)
    .slice(0, Math.min(Math.max(limit, 1), 20))
    .sort((a, b) => a.strike - b.strike);
}

export function mergeOptionChain(contracts, snapshots) {
  const quotes = new Map(snapshots.map((item) => [item.symbol, item]));
  return contracts.map((contract) => {
    const quote = quotes.get(contract.symbol) || {};
    const bid = Number.isFinite(quote.bid) ? quote.bid : null;
    const ask = Number.isFinite(quote.ask) ? quote.ask : null;
    const mid = bid !== null && ask !== null && ask >= bid ? (bid + ask) / 2 : quote.last ?? null;
    return { ...contract, ...quote, bid, ask, mid };
  });
}

export function optionPortfolioMark(quote) {
  const quoteNumber = (value) => value === null || value === undefined || value === "" ? Number.NaN : Number(value);
  const bid = quoteNumber(quote?.bid);
  const ask = quoteNumber(quote?.ask);
  const last = quoteNumber(quote?.last);
  const marketTime = String(quote?.quote_time || "").trim();
  if (!marketTime || !Number.isFinite(Date.parse(marketTime))) return null;
  if (Number.isFinite(bid) && bid >= 0 && Number.isFinite(ask) && ask >= bid) {
    return { price: Math.round(((bid + ask) / 2) * 1_000_000) / 1_000_000, marketTime, method: "mid" };
  }
  if (Number.isFinite(last) && last >= 0) return { price: last, marketTime, method: "last" };
  if (Number.isFinite(bid) && bid >= 0) return { price: bid, marketTime, method: "bid" };
  if (Number.isFinite(ask) && ask >= 0) return { price: ask, marketTime, method: "ask" };
  return null;
}
