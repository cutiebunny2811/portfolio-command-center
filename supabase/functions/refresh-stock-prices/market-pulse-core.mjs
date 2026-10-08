function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestamp(value, fallbackNow) {
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(String(value || ""));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallbackNow.toISOString();
}

function newYorkClock(value) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: get("weekday"),
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

export function regularMarketSnapshot(row, now = new Date()) {
  if (!row || typeof row !== "object") return null;
  const price = finiteNumber(row.price ?? row.last_price ?? row.close);
  if (!(price > 0)) return null;
  const previousClose = finiteNumber(row.pre_close ?? row.previous_close);
  const reportedChange = finiteNumber(row.change ?? row.change_value);
  const reportedRatio = finiteNumber(row.change_ratio);
  return {
    price,
    previousClose,
    changeValue: reportedChange ?? (previousClose > 0 ? price - previousClose : null),
    changePercent: reportedRatio != null
      ? reportedRatio * 100
      : previousClose > 0 ? (price / previousClose - 1) * 100 : null,
    volume: finiteNumber(row.volume),
    turnover: finiteNumber(row.turnover),
    marketTime: timestamp(row.last_trade_time ?? row.timestamp ?? row.time, now),
  };
}

export function regularSnapshotIsStale(marketTime, now = new Date()) {
  const quoteTime = new Date(String(marketTime || ""));
  if (!Number.isFinite(quoteTime.getTime())) return true;
  const current = newYorkClock(now);
  if (!["Mon", "Tue", "Wed", "Thu", "Fri"].includes(current.weekday)) return false;
  // Before the opening print, the previous completed session is the right tape.
  if (current.minutes < 9 * 60 + 45) return false;
  return newYorkClock(quoteTime).date !== current.date;
}
