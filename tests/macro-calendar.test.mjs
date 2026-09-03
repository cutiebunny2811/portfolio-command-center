import test from "node:test";
import assert from "node:assert/strict";
import {
  applyBlsPpiOverrides,
  buildAdpRows,
  buildBlsPpiOverrides,
  buildFomcRows,
  buildFredRows,
  buildIsmRows,
  buildMichiganRows,
  buildMacroRiskSnapshot,
  expectedPeriodDate,
  formatFredValue,
  parseFomcMeetings,
  parseAdpSnapshot,
  parseIsmSnapshot,
  parseMichiganSnapshot,
  zonedIso,
} from "../supabase/functions/sync-macro-calendar/macro-core.mjs";

function dailySeries(start, count, valueAt) {
  const startDate = new Date(`${start}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => ({
    date: new Date(startDate.getTime() + index * 86_400_000).toISOString().slice(0, 10),
    value: String(valueAt(index)),
  }));
}

function seriesEnding(end, count, valueAt, stepDays = 1) {
  const endDate = new Date(`${end}T00:00:00Z`);
  const startDate = new Date(endDate.getTime() - (count - 1) * stepDays * 86_400_000);
  return Array.from({ length: count }, (_, index) => ({
    date: new Date(startDate.getTime() + index * stepDays * 86_400_000).toISOString().slice(0, 10),
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
      "CPIAUCSL:pch": [{ date: "2026-07-01", value: "0.1" }, { date: "2026-06-01", value: "-0.4" }],
      "CPIAUCSL:pc1": [{ date: "2026-07-01", value: "3.4" }, { date: "2026-06-01", value: "3.5" }],
      "CPILFESL:pch": [{ date: "2026-07-01", value: "0.2" }, { date: "2026-06-01", value: "0.0" }],
      "CPILFESL:pc1": [{ date: "2026-07-01", value: "2.5" }, { date: "2026-06-01", value: "2.6" }],
      A191RL1Q225SBEA: [{ date: "2026-07-01", value: "2.4" }, { date: "2026-04-01", value: "2.1" }],
    },
    now: "2026-08-12T13:00:00.000Z",
    fetchedAt: "2026-08-12T13:00:00.000Z",
    windowFrom: "2026-08-10",
    windowTo: "2026-10-31",
  });
  const cpiRows = rows.filter((row) => row.series_id === "CPIAUCSL" || row.series_id === "CPILFESL");
  const headline = cpiRows.find((row) => row.event_name === "CPI Inflation (MoM)");
  assert.equal(headline.actual, "0.1%");
  assert.equal(headline.previous, "-0.4%");
  assert.equal(headline.reference_period, "Jul 2026");
  assert.deepEqual(cpiRows.map((row) => [row.event_name, row.actual, row.previous]), [
    ["CPI Inflation (MoM)", "0.1%", "-0.4%"],
    ["CPI Inflation (YoY)", "3.4%", "3.5%"],
    ["Core CPI (MoM)", "0.2%", "0%"],
    ["Core CPI (YoY)", "2.5%", "2.6%"],
  ]);
  assert.deepEqual(rows.filter((row) => row.series_id === "A191RL1Q225SBEA").map((row) => row.scheduled_at.slice(0, 10)), ["2026-10-29"]);
  assert.equal(rows.some((row) => Object.hasOwn(row, "forecast")), false);
});

test("uses the official BLS PPI release before the FRED fallback catches up", () => {
  const fetchedAt = "2026-08-13T12:31:00.000Z";
  const rows = buildFredRows({
    releaseDatesById: { 10: [], 54: [], 50: [], 46: [{ date: "2026-08-13" }], 53: [], 9: [], 192: [], 180: [] },
    observationsBySeries: {
      "PPIFIS:pch": [{ date: "2026-06-01", value: "-0.3" }],
      "PPIFES:pch": [{ date: "2026-06-01", value: "0.2" }],
    },
    now: fetchedAt,
    fetchedAt,
    windowFrom: "2026-08-13",
    windowTo: "2026-08-13",
  });
  const overrides = buildBlsPpiOverrides([
    {
      seriesID: "WPSFD4",
      data: [
        { year: "2026", period: "M07", value: "156.563" },
        { year: "2026", period: "M06", value: "156.607" },
        { year: "2026", period: "M05", value: "156.783" },
      ],
    },
    {
      seriesID: "WPSFD49104",
      data: [
        { year: "2026", period: "M07", value: "154.450" },
        { year: "2026", period: "M06", value: "154.076" },
        { year: "2026", period: "M05", value: "153.420" },
      ],
    },
  ], fetchedAt);
  const updated = applyBlsPpiOverrides(rows, overrides, fetchedAt);

  assert.deepEqual(updated.map((row) => [row.event_name, row.actual, row.source_name]), [
    ["Producer Price Index (MoM)", "0%", "BLS Public Data API"],
    ["Core PPI (MoM)", "0.2%", "BLS Public Data API"],
  ]);
  assert.equal(updated[0].raw_payload.fallback_source, "fred");
  assert.equal(updated[1].raw_payload.bls_series_id, "WPSFD49104");
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

test("generates red manufacturing PMI plus orange ISM prices and services releases", () => {
  const rows = buildIsmRows({ fetchedAt: "2026-08-01T00:00:00Z", windowFrom: "2026-08-01", windowTo: "2026-08-31" });
  assert.deepEqual(rows.map((row) => [row.event_name, row.scheduled_at, row.importance]), [
    ["ISM Manufacturing PMI", "2026-08-03T14:00:00.000Z", 3],
    ["ISM Manufacturing Prices", "2026-08-03T14:00:00.000Z", 2],
    ["ISM Services PMI", "2026-08-05T14:00:00.000Z", 2],
  ]);
});

test("parses official ISM tables and applies actual and previous values", () => {
  const html = `
    <h1>August 2026 ISM Manufacturing PMI Report</h1>
    <table><tbody>
      <tr><th>Manufacturing PMI<sup>®</sup></th><td>54.6</td><td>55.6</td><td>-1.0</td></tr>
      <tr><th>Prices</th><td>71.1</td><td>71.1</td><td>0</td></tr>
    </tbody></table>`;
  const snapshot = parseIsmSnapshot(html, "manufacturing", "https://ism.example/august/");
  const rows = buildIsmRows({
    fetchedAt: "2026-09-01T14:05:00Z",
    windowFrom: "2026-09-01",
    windowTo: "2026-09-01",
    snapshots: [snapshot],
  });
  assert.deepEqual(rows.map((row) => [row.event_name, row.actual, row.previous]), [
    ["ISM Manufacturing PMI", "54.6", "55.6"],
    ["ISM Manufacturing Prices", "71.1", "71.1"],
  ]);
  assert.ok(rows.every((row) => row.source_url === "https://ism.example/august/"));
});

test("parses the attributed table cells used by the official ISM services report", () => {
  const html = `
    <h1>August 2026 ISM Services PMI Report</h1>
    <table><tbody>
      <tr>
        <th>&nbsp;</th>
        <th colspan="6">Services PMI<sup>&reg;</sup></th>
        <th colspan="3">Manufacturing PMI<sup>&reg;</sup></th>
      </tr>
      <tr>
        <th scope="row">Services PMI<sup>&reg;</sup></th>
        <td class="text-center">55.4</td>
        <td class="text-center">54.1</td>
        <td class="text-center">+1.3</td>
      </tr>
    </tbody></table>`;
  const snapshot = parseIsmSnapshot(html, "services", "https://ism.example/services/august/");
  assert.deepEqual(snapshot, {
    referenceDate: "2026-08-01",
    values: { services: { actual: "55.4", previous: "54.1" } },
    sourceUrl: "https://ism.example/services/august/",
  });
});

test("parses the official ADP snapshot and carries it into the next release", () => {
  const snapshot = parseAdpSnapshot({
    reportMonth: "July",
    reportYear: "2026",
    reportOverview: { cards: [{ metricValue: "44,000" }] },
  });
  assert.deepEqual(snapshot, { referenceDate: "2026-07-01", actual: "44K" });
  const [row] = buildAdpRows({
    releases: ["2026-09-02"],
    fetchedAt: "2026-09-01T00:00:00Z",
    windowFrom: "2026-09-01",
    windowTo: "2026-09-03",
    snapshot,
  });
  assert.equal(row.actual, null);
  assert.equal(row.previous, "44K");
});

test("adds official orange ADP monthly releases at 08:15 Eastern", () => {
  const rows = buildAdpRows({
    fetchedAt: "2026-09-01T00:00:00Z",
    windowFrom: "2026-09-01",
    windowTo: "2026-12-31",
  });

  assert.deepEqual(rows.map((row) => [
    row.event_name,
    row.scheduled_at,
    row.reference_period,
    row.importance,
  ]), [
    ["ADP Non-Farm Employment Change", "2026-09-02T12:15:00.000Z", "2026-08-01", 2],
    ["ADP Non-Farm Employment Change", "2026-09-30T12:15:00.000Z", "2026-09-01", 2],
    ["ADP Non-Farm Employment Change", "2026-11-04T13:15:00.000Z", "2026-10-01", 2],
    ["ADP Non-Farm Employment Change", "2026-12-02T13:15:00.000Z", "2026-11-01", 2],
  ]);
});

test("adds both orange retail releases and preserves their importance", () => {
  const rows = buildFredRows({
    releaseDatesById: { 9: [{ date: "2026-08-14" }] },
    observationsBySeries: {
      "RSAFS:pch": [
        { date: "2026-07-01", value: "0.1" },
        { date: "2026-06-01", value: "0.2" },
      ],
      "RSFSXMV:pch": [
        { date: "2026-07-01", value: "0.2" },
        { date: "2026-06-01", value: "-0.2" },
      ],
    },
    now: "2026-08-14T13:00:00.000Z",
    fetchedAt: "2026-08-14T13:00:00.000Z",
    windowFrom: "2026-08-14",
    windowTo: "2026-08-14",
  });
  const retail = rows.filter((row) => row.category.startsWith("Retail Sales"));

  assert.deepEqual(retail.map((row) => [row.event_name, row.actual, row.importance]), [
    ["Retail Sales (MoM)", "0.1%", 2],
    ["Core Retail Sales (MoM)", "0.2%", 2],
  ]);
});

test("parses Michigan preliminary data and builds recurring orange releases", () => {
  const html = `
    <h1>Preliminary Results for August 2026</h1>
    <table>
      <tr><th></th><th>Aug 2026</th><th>Jul 2026</th></tr>
      <tr><td>Index of Consumer Sentiment</td><td>54.7</td><td>55.2</td><td>61.7</td></tr>
    </table>
    <p>Year-ahead inflation expectations ticked down from 4.2% in July to 4.0% this month.</p>
  `;
  const snapshot = parseMichiganSnapshot(html);
  assert.deepEqual(snapshot, {
    releaseType: "preliminary",
    referenceDate: "2026-08-01",
    sentimentActual: 54.7,
    sentimentPrevious: 55.2,
    inflationActual: 4,
    inflationPrevious: 4.2,
  });

  const rows = buildMichiganRows({
    releases: ["2026-08-14", "2026-09-11"],
    snapshot,
    now: "2026-08-14T14:05:00.000Z",
    fetchedAt: "2026-08-14T14:05:00.000Z",
    windowFrom: "2026-08-14",
    windowTo: "2026-09-11",
  });
  assert.deepEqual(rows.map((row) => [row.event_name, row.scheduled_at, row.actual, row.importance]), [
    ["Prelim UoM Consumer Sentiment", "2026-08-14T14:00:00.000Z", "54.7", 2],
    ["Prelim UoM Inflation Expectations", "2026-08-14T14:00:00.000Z", "4%", 2],
    ["Prelim UoM Consumer Sentiment", "2026-09-11T14:00:00.000Z", null, 2],
    ["Prelim UoM Inflation Expectations", "2026-09-11T14:00:00.000Z", null, 2],
  ]);
});

test("centers persistent market conditions near neutral instead of permanent greed", () => {
  const targetDate = "2026-08-08";
  const observationsBySeries = {
    SAHMREALTIME: [{ date: "2026-08-01", value: "0.10" }],
    ICSA: seriesEnding(targetDate, 52, () => 200000, 7),
    T10Y3M: [{ date: targetDate, value: "0.50" }],
    BAMLH0A0HYM2: seriesEnding(targetDate, 1751, (index) => 3 + Math.sin(index * 2 * Math.PI / 100) * .3),
    STLFSI4: seriesEnding(targetDate, 301, (index) => -.5 + Math.sin(index * 2 * Math.PI / 20) * .2, 7),
    VIXCLS: seriesEnding(targetDate, 1751, (index) => 15 + Math.sin(index * 2 * Math.PI / 50) * 2),
    INDPRO: [{ date: "2025-08-01", value: "100" }, { date: "2026-08-01", value: "105" }],
    SP500: seriesEnding(targetDate, 1751, (index) => 5000 + Math.sin(index * 2 * Math.PI / 125) * 200),
  };
  const snapshot = buildMacroRiskSnapshot({ observationsBySeries, targetDate, fetchedAt: `${targetDate}T22:00:00Z` });
  assert.equal(snapshot.risk_label, "LOW");
  assert.ok(snapshot.risk_score >= 0 && snapshot.risk_score < 25);
  assert.ok(snapshot.fear_greed_score >= 45 && snapshot.fear_greed_score <= 55);
  assert.equal(snapshot.fear_greed_label, "NEUTRAL");
  assert.equal(snapshot.risk_components.length, 7);
  assert.equal(snapshot.fear_greed_components.length, 5);
  assert.equal(snapshot.risk_components.find((item) => item.key === "claims").display, "200K");
  assert.ok(snapshot.fear_greed_components.every((item) => item.weight === 1));
  assert.ok(snapshot.fear_greed_components.every((item) => /five[- ]year/.test(item.detail)));
  assert.equal(new Set(snapshot.fear_greed_components.map((item) => item.dimension)).size, 4);
});

test("moves the composites toward severe risk and extreme fear when inputs deteriorate", () => {
  const targetDate = "2026-08-08";
  const claims = seriesEnding(targetDate, 52, (index) => index === 51 ? 320000 : 200000, 7);
  const observationsBySeries = {
    SAHMREALTIME: [{ date: "2026-08-01", value: "0.70" }],
    ICSA: claims,
    T10Y3M: [{ date: targetDate, value: "-1.00" }],
    BAMLH0A0HYM2: seriesEnding(targetDate, 1751, (index) => index === 1750 ? 8 : 3 + Math.sin(index * 2 * Math.PI / 100) * .3),
    STLFSI4: seriesEnding(targetDate, 301, (index) => index === 300 ? 2 : -.5 + Math.sin(index * 2 * Math.PI / 20) * .2, 7),
    VIXCLS: seriesEnding(targetDate, 1751, (index) => index === 1750 ? 40 : 15 + Math.sin(index * 2 * Math.PI / 50) * 2),
    INDPRO: [{ date: "2025-08-01", value: "100" }, { date: "2026-08-01", value: "94" }],
    SP500: seriesEnding(targetDate, 1751, (index) => index < 1650
      ? 5000 + Math.sin(index * 2 * Math.PI / 125) * 200
      : 5000 - (index - 1650) * 10),
  };
  const snapshot = buildMacroRiskSnapshot({ observationsBySeries, targetDate, fetchedAt: `${targetDate}T22:00:00Z` });
  assert.equal(snapshot.risk_label, "SEVERE");
  assert.ok(snapshot.risk_score >= 80);
  assert.equal(snapshot.fear_greed_label, "EXTREME FEAR");
  assert.ok(snapshot.fear_greed_score < 25);
});
