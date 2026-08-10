import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFomcRows,
  buildFredRows,
  buildIsmRows,
  buildMacroRiskSnapshot,
  expectedPeriodDate,
  formatFredValue,
  parseFomcMeetings,
  zonedIso,
} from "../supabase/functions/sync-macro-calendar/macro-core.mjs";

function dailySeries(start, count, valueAt) {
  const startDate = new Date(`${start}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => ({
    date: new Date(startDate.getTime() + index * 86_400_000).toISOString().slice(0, 10),
    value: String(valueAt(index)),
  }));
}

test("converts official Eastern release times across daylight saving", () => {
  assert.equal(zonedIso("2026-08-12", "08:30"), "2026-08-12T12:30:00.000Z");
  assert.equal(zonedIso("2026-12-10", "08:30"), "2026-12-10T13:30:00.000Z");
});

test("formats market-facing FRED values without inventing forecasts", () => {
  assert.equal(formatFredValue("0.2551", "percent"), "0.3%");
  assert.equal(formatFredValue("-0.01", "percent"), "0%");
  assert.equal(formatFredValue("-23", "thousands_change"), "-23K");
  assert.equal(formatFredValue("7437", "millions_from_thousands"), "7.44M");
  assert.equal(formatFredValue("199000", "persons_to_thousands"), "199K");
  assert.equal(expectedPeriodDate({ lagMonths: 1 }, "2026-08-12"), "2026-07-01");
  assert.equal(expectedPeriodDate({ quarterly: true }, "2026-10-29"), "2026-07-01");
});

test("maps observations to release periods and keeps only advance GDP months", () => {
  const rows = buildFredRows({
    releaseDatesById: {
      10: [{ date: "2026-08-12" }, { date: "2026-07-14" }],
      54: [], 50: [], 46: [],
      53: [{ date: "2026-10-29" }, { date: "2026-09-30" }, { date: "2026-07-30" }],
      9: [], 192: [], 180: [],
    },
    observationsBySeries: {
      CPIAUCSL: [{ date: "2026-07-01", value: "0.2" }, { date: "2026-06-01", value: "0.3" }],
      CPILFESL: [{ date: "2026-07-01", value: "0.3" }, { date: "2026-06-01", value: "0.2" }],
      A191RL1Q225SBEA: [{ date: "2026-07-01", value: "2.4" }, { date: "2026-04-01", value: "2.1" }],
    },
    now: "2026-08-12T13:00:00.000Z",
    fetchedAt: "2026-08-12T13:00:00.000Z",
    windowFrom: "2026-08-10",
    windowTo: "2026-10-31",
  });
  const headline = rows.find((row) => row.series_id === "CPIAUCSL");
  assert.equal(headline.actual, "0.2%");
  assert.equal(headline.previous, "0.3%");
  assert.equal(headline.reference_period, "Jul 2026");
  assert.deepEqual(rows.filter((row) => row.series_id === "A191RL1Q225SBEA").map((row) => row.scheduled_at.slice(0, 10)), ["2026-10-29"]);
  assert.equal(rows.some((row) => Object.hasOwn(row, "forecast")), false);
});

test("parses FOMC meetings and builds decision, press conference, and minutes", () => {
  const html = `
    <h4><a>2026 FOMC Meetings</a></h4>
    <div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>September</strong></div><div class="fomc-meeting__date">15-16*</div></div>
    <div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>October</strong></div><div class="fomc-meeting__date">27-28</div></div>
    <h4><a>2027 FOMC Meetings</a></h4>
  `;
  const meetings = parseFomcMeetings(html);
  assert.deepEqual(meetings, [
    { decisionDate: "2026-09-16", hasProjections: true },
    { decisionDate: "2026-10-28", hasProjections: false },
  ]);
  const rows = buildFomcRows({
    meetings,
    lowerObservations: [{ date: "2026-08-12", value: "4.75" }],
    upperObservations: [{ date: "2026-08-12", value: "5.00" }],
    now: "2026-08-12T00:00:00.000Z",
    fetchedAt: "2026-08-12T00:00:00.000Z",
    windowFrom: "2026-08-01",
    windowTo: "2026-11-30",
  });
  assert.equal(rows.find((row) => row.external_id === "fomc-decision:2026-09-16").event_name, "FOMC Rate Decision + SEP");
  assert.equal(rows.find((row) => row.external_id === "fomc-decision:2026-09-16").previous, "4.75–5.00%");
  assert.ok(rows.some((row) => row.external_id === "fomc-minutes:2026-09-16"));
});

test("generates the two high-impact ISM releases only", () => {
  const rows = buildIsmRows({ fetchedAt: "2026-08-01T00:00:00Z", windowFrom: "2026-08-01", windowTo: "2026-08-31" });
  assert.deepEqual(rows.map((row) => [row.event_name, row.scheduled_at]), [
    ["ISM Manufacturing PMI", "2026-08-03T14:00:00.000Z"],
    ["ISM Services PMI", "2026-08-05T14:00:00.000Z"],
  ]);
});

test("builds transparent low-risk and greed composites from FRED observations", () => {
  const targetDate = "2026-08-08";
  const observationsBySeries = {
    SAHMREALTIME: [{ date: "2026-08-01", value: "0.10" }],
    ICSA: dailySeries("2025-08-10", 52, () => 200000),
    T10Y3M: [{ date: targetDate, value: "0.50" }],
    BAMLH0A0HYM2: [{ date: targetDate, value: "3.00" }],
    STLFSI4: [{ date: targetDate, value: "-0.50" }],
    VIXCLS: [{ date: targetDate, value: "15" }],
    INDPRO: [{ date: "2025-08-01", value: "100" }, { date: "2026-08-01", value: "105" }],
    SP500: dailySeries("2025-11-30", 252, (index) => 5000 + index * 4),
  };
  const snapshot = buildMacroRiskSnapshot({ observationsBySeries, targetDate, fetchedAt: `${targetDate}T22:00:00Z` });
  assert.equal(snapshot.risk_label, "LOW");
  assert.ok(snapshot.risk_score >= 0 && snapshot.risk_score < 25);
  assert.ok(snapshot.fear_greed_score > 75);
  assert.equal(snapshot.fear_greed_label, "EXTREME GREED");
  assert.equal(snapshot.risk_components.length, 7);
  assert.equal(snapshot.fear_greed_components.length, 5);
  assert.equal(snapshot.risk_components.find((item) => item.key === "claims").display, "200K");
});

test("moves the composites toward severe risk and extreme fear when inputs deteriorate", () => {
  const targetDate = "2026-08-08";
  const claims = dailySeries("2025-08-10", 52, () => 200000);
  claims.push({ date: targetDate, value: "320000" });
  const observationsBySeries = {
    SAHMREALTIME: [{ date: "2026-08-01", value: "0.70" }],
    ICSA: claims,
    T10Y3M: [{ date: targetDate, value: "-1.00" }],
    BAMLH0A0HYM2: [{ date: targetDate, value: "8.00" }],
    STLFSI4: [{ date: targetDate, value: "2.00" }],
    VIXCLS: [{ date: targetDate, value: "40" }],
    INDPRO: [{ date: "2025-08-01", value: "100" }, { date: "2026-08-01", value: "94" }],
    SP500: dailySeries("2025-11-30", 252, (index) => 7000 - index * 8),
  };
  const snapshot = buildMacroRiskSnapshot({ observationsBySeries, targetDate, fetchedAt: `${targetDate}T22:00:00Z` });
  assert.equal(snapshot.risk_label, "SEVERE");
  assert.ok(snapshot.risk_score >= 80);
  assert.equal(snapshot.fear_greed_label, "EXTREME FEAR");
  assert.ok(snapshot.fear_greed_score < 25);
});
