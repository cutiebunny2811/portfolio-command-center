import assert from "node:assert/strict";
import test from "node:test";
import { buildCanonicalRows } from "../supabase/functions/sync-earnings-calendar/calendar-core.mjs";

const build = ({ finnhubCalendar, alphaCalendar = [] }) => buildCanonicalRows({
  finnhubCalendar,
  alphaCalendar,
  tracked: new Set(["AMD", "ANET", "CAT", "TBD"]),
  windowFrom: "2026-08-01",
  windowTo: "2026-08-31",
  existingByEventKey: new Map(),
  syncedAt: "2026-08-06T00:00:00.000Z",
});

test("Finnhub alone owns the calendar date and session", () => {
  const rows = build({
    finnhubCalendar: [
      { symbol: "CAT", date: "2026-08-04", hour: "bmo" },
      { symbol: "AMD", date: "2026-08-04", hour: "amc" },
      { symbol: "ANET", date: "2026-08-04", hour: "amc" },
    ],
    alphaCalendar: [
      { symbol: "CAT", reportDate: "2026-08-03", estimate: "9.99" },
      { symbol: "AMD", reportDate: "2026-08-03", estimate: "8.88" },
      { symbol: "ANET", reportDate: "2026-08-05", estimate: "7.77" },
    ],
  });
  assert.deepEqual(rows.map(({ symbol, earnings_date, report_hour }) => [symbol, earnings_date, report_hour]), [
    ["AMD", "2026-08-04", "amc"],
    ["ANET", "2026-08-04", "amc"],
    ["CAT", "2026-08-04", "bmo"],
  ]);
  assert.ok(rows.every((row) => row.eps_estimate == null), "wrong-date Alpha rows must not enrich metrics");
});

test("Alpha may enrich estimates only for the exact Finnhub date", () => {
  const [row] = build({
    finnhubCalendar: [{ symbol: "AMD", date: "2026-08-04", hour: "amc" }],
    alphaCalendar: [{ symbol: "AMD", reportDate: "2026-08-04", estimate: "0.91" }],
  });
  assert.equal(row.earnings_date, "2026-08-04");
  assert.equal(row.report_hour, "amc");
  assert.equal(row.eps_estimate, 0.91);
});

test("unknown Finnhub session remains TBD instead of being guessed", () => {
  const [row] = build({
    finnhubCalendar: [{ symbol: "TBD", date: "2026-08-12", hour: "" }],
    alphaCalendar: [{ symbol: "TBD", reportDate: "2026-08-12", reportTime: "after close" }],
  });
  assert.equal(row.report_hour, "tbd");
});

test("duplicate Finnhub rows collapse deterministically without shifting the date", () => {
  const input = [
    { symbol: "AMD", date: "2026-08-04", hour: null, epsEstimate: 0.9 },
    { symbol: "AMD", date: "2026-08-04", hour: "amc", revenueEstimate: 8_000_000_000 },
  ];
  const first = build({ finnhubCalendar: input });
  const second = build({ finnhubCalendar: [...input].reverse() });
  assert.equal(first.length, 1);
  assert.equal(first[0].earnings_date, "2026-08-04");
  assert.equal(first[0].report_hour, "amc");
  assert.deepEqual(first, second);
});

test("events outside the requested month and untracked symbols never reach the board", () => {
  const rows = build({
    finnhubCalendar: [
      { symbol: "AMD", date: "2026-07-31", hour: "amc" },
      { symbol: "AMD", date: "2026-08-04", hour: "amc" },
      { symbol: "NVDA", date: "2026-08-05", hour: "amc" },
      { symbol: "CAT", date: "2026-09-01", hour: "bmo" },
    ],
  });
  assert.deepEqual(rows.map((row) => row.event_key), ["AMD:2026-08-04"]);
});
