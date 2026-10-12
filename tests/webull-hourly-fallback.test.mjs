import test from "node:test";
import assert from "node:assert/strict";
import { hourlyBarsFromMinutes, mergeHourlyHistory } from "../supabase/functions/refresh-stock-prices/chart-cache-policy.mjs";

function minutes(start, count) {
  return Array.from({ length: count }, (_, index) => ({
    time: new Date(start + index * 60_000).toISOString(),
    open: 100 + index, high: 101 + index, low: 99 + index, close: 100.5 + index, volume: 10,
  }));
}

test("derives only complete New York regular-session 1h bars from 1m", () => {
  const open = Date.parse("2026-10-12T13:30:00Z"); // 09:30 EDT
  const complete = minutes(open, 60);
  assert.deepEqual(hourlyBarsFromMinutes(complete, open + 60 * 60_000), [{
    time: "2026-10-12T13:30:00.000Z", open: 100, high: 160, low: 99,
    close: 159.5, volume: 600,
  }]);
  assert.deepEqual(hourlyBarsFromMinutes(complete.slice(0, 59), open + 60 * 60_000), []);
  assert.deepEqual(hourlyBarsFromMinutes(complete, open + 59 * 60_000), []);
  assert.deepEqual(hourlyBarsFromMinutes(complete.filter((_, index) => index !== 30), open + 60 * 60_000), []);
});

test("last regular-session bar ends at 16:00 instead of requiring 60 minutes", () => {
  const start = Date.parse("2026-10-12T19:30:00Z"); // 15:30 EDT
  const result = hourlyBarsFromMinutes(minutes(start, 30), Date.parse("2026-10-12T20:00:00Z"));
  assert.equal(result.length, 1);
  assert.equal(result[0].time, "2026-10-12T19:30:00.000Z");
  assert.equal(result[0].volume, 300);
});

test("hourly fallback accumulates completed history across refreshes", () => {
  const previous = minutes(Date.parse("2026-10-09T13:30:00Z"), 60);
  const current = minutes(Date.parse("2026-10-12T13:30:00Z"), 60);
  const friday = hourlyBarsFromMinutes(previous, Date.parse("2026-10-09T14:30:00Z"));
  const monday = hourlyBarsFromMinutes(current, Date.parse("2026-10-12T14:30:00Z"));
  const merged = mergeHourlyHistory(friday, monday);
  assert.deepEqual(merged.map((bar) => bar.time), [friday[0].time, monday[0].time]);
  assert.deepEqual(mergeHourlyHistory(merged, [{ ...monday[0], close: 200 }]).at(-1).close, 200);
});
