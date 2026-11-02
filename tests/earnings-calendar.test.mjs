import assert from "node:assert/strict";
import test from "node:test";
import { buildCanonicalRows } from "../supabase/functions/sync-earnings-calendar/calendar-core.mjs";

const build = ({ finnhubCalendar, alphaCalendar = [], yahooCalendar = [] }) => buildCanonicalRows({
  finnhubCalendar,
  alphaCalendar,
  yahooCalendar,
  tracked: new Set(["AMD", "ANET", "CAT", "TBD", "PLTR", "POWL", "CLPT", "VOYG"]),
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

test("Alpha and Yahoo may fill a symbol Finnhub omitted only when the exact date agrees", () => {
  const rows = build({
    finnhubCalendar: [{ symbol: "AMD", date: "2026-08-04", hour: "amc" }],
    alphaCalendar: [
      { symbol: "PLTR", reportDate: "2026-08-03", estimate: "0.35" },
      { symbol: "POWL", reportDate: "2026-08-03", estimate: "3.01" },
      { symbol: "CLPT", reportDate: "2026-08-03", estimate: "-0.12" },
      { symbol: "VOYG", reportDate: "2026-08-03", estimate: "-0.08" },
    ],
    yahooCalendar: [
      { symbol: "PLTR", date: "2026-08-03", hour: "amc", raw: { source: "yahoo" } },
      { symbol: "POWL", date: "2026-08-03", hour: "amc", raw: { source: "yahoo" } },
      { symbol: "CLPT", date: "2026-08-03", hour: "amc", raw: { source: "yahoo" } },
      { symbol: "VOYG", date: "2026-08-03", hour: "amc", raw: { source: "yahoo" } },
    ],
  });
  assert.deepEqual(
    rows.map(({ symbol, earnings_date, report_hour }) => [symbol, earnings_date, report_hour]),
    [
      ["AMD", "2026-08-04", "amc"],
      ["CLPT", "2026-08-03", "amc"],
      ["PLTR", "2026-08-03", "amc"],
      ["POWL", "2026-08-03", "amc"],
      ["VOYG", "2026-08-03", "amc"],
    ],
  );
  assert.ok(rows.filter((row) => row.symbol !== "AMD").every((row) => row.raw_payload.schedule_authority === "alpha_yahoo_exact_match"));
});

test("a Yahoo disagreement cannot create or move a fallback event", () => {
  const rows = build({
    finnhubCalendar: [],
    alphaCalendar: [{ symbol: "PLTR", reportDate: "2026-08-03" }],
    yahooCalendar: [{ symbol: "PLTR", date: "2026-08-04", hour: "amc", raw: {} }],
  });
  assert.deepEqual(rows, []);
});

test("an elapsed Alpha event survives when Finnhub omitted it and Yahoo has no current-month schedule", () => {
  const rows = buildCanonicalRows({
    finnhubCalendar: [],
    alphaCalendar: [{ symbol: "NOK", reportDate: "2026-10-22", estimate: "0.08" }],
    yahooCalendar: [],
    tracked: new Set(["NOK"]),
    windowFrom: "2026-10-01",
    windowTo: "2026-10-31",
    existingByEventKey: new Map(),
    syncedAt: "2026-10-23T00:00:00.000Z",
  });

  assert.deepEqual(rows.map(({ event_key, report_hour }) => [event_key, report_hour]), [["NOK:2026-10-22", "tbd"]]);
  assert.equal(rows[0].eps_estimate, 0.08);
  assert.equal(rows[0].raw_payload.schedule_authority, "alpha_elapsed_no_yahoo_schedule");
});

test("an unconfirmed future Alpha event still requires Yahoo agreement", () => {
  const rows = buildCanonicalRows({
    finnhubCalendar: [],
    alphaCalendar: [{ symbol: "NOK", reportDate: "2026-10-24" }],
    yahooCalendar: [],
    tracked: new Set(["NOK"]),
    windowFrom: "2026-10-01",
    windowTo: "2026-10-31",
    existingByEventKey: new Map(),
    syncedAt: "2026-10-23T00:00:00.000Z",
  });

  assert.deepEqual(rows, []);
});

test("Yahoo and Alpha can never override a Finnhub symbol even when both agree elsewhere", () => {
  const rows = build({
    finnhubCalendar: [{ symbol: "CAT", date: "2026-08-04", hour: "bmo" }],
    alphaCalendar: [{ symbol: "CAT", reportDate: "2026-08-03" }],
    yahooCalendar: [{ symbol: "CAT", date: "2026-08-03", hour: "amc", raw: {} }],
  });
  assert.deepEqual(rows.map(({ event_key, report_hour }) => [event_key, report_hour]), [["CAT:2026-08-04", "bmo"]]);
});

test("reported Alpha and Yahoo event replaces a stale future Finnhub schedule", () => {
  const rows = buildCanonicalRows({
    finnhubCalendar: [{ symbol: "LITE", date: "2026-11-05", hour: "amc", epsEstimate: 4.21 }],
    alphaCalendar: [{ symbol: "LITE", reportDate: "2026-11-02", estimate: "4.14" }],
    yahooCalendar: [{
      symbol: "LITE",
      date: "2026-11-02",
      hour: "bmo",
      raw: { epsactual: 4.57, epsestimate: 4.14 },
    }],
    tracked: new Set(["LITE"]),
    windowFrom: "2026-11-01",
    windowTo: "2026-11-30",
    existingByEventKey: new Map(),
    syncedAt: "2026-11-02T13:00:00.000Z",
  });

  assert.deepEqual(rows.map(({ event_key, report_hour }) => [event_key, report_hour]), [["LITE:2026-11-02", "bmo"]]);
  assert.equal(rows[0].eps_actual, 4.57);
  assert.equal(rows[0].raw_payload.schedule_authority, "alpha_yahoo_reported_override");
  assert.equal(rows[0].raw_payload.finnhub.date, "2026-11-05");
});

test("an elapsed estimate cannot replace Finnhub until Yahoo has reported actual EPS", () => {
  const rows = buildCanonicalRows({
    finnhubCalendar: [{ symbol: "LITE", date: "2026-11-05", hour: "amc" }],
    alphaCalendar: [{ symbol: "LITE", reportDate: "2026-11-02", estimate: "4.14" }],
    yahooCalendar: [{ symbol: "LITE", date: "2026-11-02", hour: "bmo", raw: { epsestimate: 4.14 } }],
    tracked: new Set(["LITE"]),
    windowFrom: "2026-11-01",
    windowTo: "2026-11-30",
    existingByEventKey: new Map(),
    syncedAt: "2026-11-02T13:00:00.000Z",
  });

  assert.deepEqual(rows.map(({ event_key, report_hour }) => [event_key, report_hour]), [["LITE:2026-11-05", "amc"]]);
});

test("a verified company report overrides providers that still carry the old date", () => {
  const rows = buildCanonicalRows({
    finnhubCalendar: [{ symbol: "LITE", date: "2026-11-05", hour: "amc", epsEstimate: 4.21 }],
    alphaCalendar: [{ symbol: "LITE", reportDate: "2026-11-05", estimate: "4.14" }],
    yahooCalendar: [],
    verifiedOverrides: [{
      symbol: "LITE",
      earnings_date: "2026-11-02",
      report_hour: "bmo",
      fiscal_quarter: 1,
      fiscal_year: 2027,
      eps_estimate: 4.14,
      eps_actual: 4.57,
      revenue_estimate: 1_250_000_000,
      revenue_actual: 1_262_600_000,
      source_url: "https://investor.lumentum.com/",
      source_note: "Q1 FY2027 results released early with the Marvell transaction announcement",
      is_active: true,
    }],
    tracked: new Set(["LITE"]),
    windowFrom: "2026-11-01",
    windowTo: "2026-11-30",
    existingByEventKey: new Map(),
    syncedAt: "2026-11-02T14:00:00.000Z",
  });

  assert.deepEqual(rows.map(({ event_key, report_hour }) => [event_key, report_hour]), [["LITE:2026-11-02", "bmo"]]);
  assert.equal(rows[0].eps_actual, 4.57);
  assert.equal(rows[0].revenue_actual, 1_262_600_000);
  assert.equal(rows[0].raw_payload.schedule_authority, "company_reported_override");
  assert.equal(rows[0].raw_payload.finnhub[0].date, "2026-11-05");
});

test("a verified missing-ticker event is preserved after its report date passes", () => {
  const rows = buildCanonicalRows({
    finnhubCalendar: [],
    alphaCalendar: [],
    yahooCalendar: [],
    tracked: new Set(["PLTR"]),
    windowFrom: "2026-08-01",
    windowTo: "2026-08-31",
    existingByEventKey: new Map([
      ["PLTR:2026-08-03", {
        raw_payload: {
          alpha_vantage: { symbol: "PLTR", reportDate: "2026-08-03", timeOfTheDay: "post-market" },
        },
      }],
    ]),
    syncedAt: "2026-08-06T00:00:00.000Z",
  });

  assert.deepEqual(rows.map(({ event_key, report_hour }) => [event_key, report_hour]), [["PLTR:2026-08-03", "amc"]]);
  assert.equal(rows[0].raw_payload.schedule_authority, "preserved_past_alpha_exact");
});

test("a legacy row whose payload points to another date is never preserved", () => {
  const rows = buildCanonicalRows({
    finnhubCalendar: [],
    alphaCalendar: [],
    yahooCalendar: [],
    tracked: new Set(["PLTR"]),
    windowFrom: "2026-08-01",
    windowTo: "2026-08-31",
    existingByEventKey: new Map([
      ["PLTR:2026-08-05", {
        raw_payload: {
          alpha_vantage: { symbol: "PLTR", reportDate: "2026-08-03", timeOfTheDay: "post-market" },
        },
      }],
    ]),
    syncedAt: "2026-08-06T00:00:00.000Z",
  });

  assert.deepEqual(rows, []);
});

test("Finnhub still wins over a preserved historical fallback", () => {
  const rows = buildCanonicalRows({
    finnhubCalendar: [{ symbol: "PLTR", date: "2026-08-04", hour: "amc" }],
    alphaCalendar: [],
    yahooCalendar: [],
    tracked: new Set(["PLTR"]),
    windowFrom: "2026-08-01",
    windowTo: "2026-08-31",
    existingByEventKey: new Map([
      ["PLTR:2026-08-03", {
        raw_payload: {
          alpha_vantage: { symbol: "PLTR", reportDate: "2026-08-03", timeOfTheDay: "post-market" },
        },
      }],
    ]),
    syncedAt: "2026-08-06T00:00:00.000Z",
  });

  assert.deepEqual(rows.map(({ event_key, report_hour }) => [event_key, report_hour]), [["PLTR:2026-08-04", "amc"]]);
});
