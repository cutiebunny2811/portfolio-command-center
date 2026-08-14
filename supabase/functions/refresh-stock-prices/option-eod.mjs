export function buildMassiveOptionTicker(instrument) {
  const root = String(instrument?.underlying_symbol || instrument?.symbol || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
  const expiry = String(instrument?.expiry || "").trim();
  const optionType = String(instrument?.option_type || "").trim().toLowerCase();
  const strike = Number(instrument?.strike);

  if (!root) throw new Error("Option underlying symbol is missing");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw new Error("Option expiry must use YYYY-MM-DD");
  if (!Number.isFinite(strike) || strike < 0) throw new Error("Option strike is invalid");
  if (!["call", "put"].includes(optionType)) throw new Error("Option type must be call or put");

  const [year, month, day] = expiry.split("-");
  const strikeCode = Math.round(strike * 1000);
  if (strikeCode > 99_999_999) throw new Error("Option strike is outside OCC ticker limits");
  return `O:${root}${year.slice(-2)}${month}${day}${optionType === "call" ? "C" : "P"}${String(strikeCode).padStart(8, "0")}`;
}

export function latestOptionEodQuote(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const candidates = results.map((row) => ({
    price: Number(row?.c),
    time: Number(row?.t),
  })).filter((row) => Number.isFinite(row.price) && row.price >= 0 && Number.isFinite(row.time) && row.time > 0);
  candidates.sort((a, b) => b.time - a.time);
  if (!candidates.length) return null;
  return {
    price: candidates[0].price,
    marketTime: new Date(candidates[0].time).toISOString(),
  };
}

export function shouldRecordOptionEod(latestPrice, quote) {
  if (!latestPrice) return true;
  const latestTime = new Date(latestPrice.market_time || latestPrice.fetched_at || 0).getTime();
  const quoteTime = new Date(quote?.marketTime || 0).getTime();
  if (!Number.isFinite(quoteTime)) return false;
  return !Number.isFinite(latestTime) || quoteTime > latestTime;
}
