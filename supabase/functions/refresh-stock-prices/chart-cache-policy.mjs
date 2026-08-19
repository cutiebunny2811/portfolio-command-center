const regularSessionOpenMinutes = 9 * 60 + 30;
const dailySettlementMinutes = 16 * 60 + 10;
const intradayDailyBarWindowMs = 45 * 60_000;

const newYorkFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function newYorkClock(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(
    newYorkFormatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (!Number.isFinite(minutes)) return null;
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    minutes,
  };
}

function isWeekday(clock) {
  return clock && !["Sat", "Sun"].includes(clock.weekday);
}

export function chartCacheIsStale({ timespan, fetchedAt, cacheWindowMs, now = Date.now() }) {
  const fetchedTime = new Date(fetchedAt || "").getTime();
  const nowTime = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(fetchedTime) || !Number.isFinite(nowTime)) return true;

  const age = Math.max(nowTime - fetchedTime, 0);
  if (age >= cacheWindowMs) return true;
  if (timespan !== "D") return false;

  const fetchedClock = newYorkClock(fetchedTime);
  const nowClock = newYorkClock(nowTime);
  if (!fetchedClock || !nowClock) return true;

  const regularSessionActive = isWeekday(nowClock)
    && nowClock.minutes >= regularSessionOpenMinutes
    && nowClock.minutes < dailySettlementMinutes;
  if (regularSessionActive && age >= intradayDailyBarWindowMs) return true;

  const fetchedDuringRegularSession = isWeekday(fetchedClock)
    && fetchedClock.minutes >= regularSessionOpenMinutes
    && fetchedClock.minutes < dailySettlementMinutes;
  if (!fetchedDuringRegularSession) return false;

  const laterNewYorkDate = nowClock.dateKey > fetchedClock.dateKey;
  const sameDateAfterSettlement = nowClock.dateKey === fetchedClock.dateKey
    && nowClock.minutes >= dailySettlementMinutes;
  return laterNewYorkDate || sameDateAfterSettlement;
}
