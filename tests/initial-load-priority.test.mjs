import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../app.js", import.meta.url), "utf8");

function functionBody(name, nextName) {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`async function ${nextName}`, start + 1);
  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return source.slice(start, end);
}

test("initial ledger load only waits for the six datasets needed by the first portfolio render", () => {
  const body = functionBody("loadData", "showApp");
  assert.match(body, /portfolio_cash_balances/);
  assert.match(body, /position_balances/);
  assert.match(body, /position_capacity/);
  assert.doesNotMatch(body, /fetchLatestInstrumentPrices/);
  assert.doesNotMatch(body, /fetchJournalView/);
  assert.doesNotMatch(body, /executions/);
  assert.doesNotMatch(body, /cash_movements/);
  assert.doesNotMatch(body, /optionalWatchlistQuery/);
  assert.doesNotMatch(body, /fetchResearchFeed/);
  assert.doesNotMatch(body, /fetchEarningsFeed/);
  assert.doesNotMatch(body, /fetchMacroFeed/);
  assert.doesNotMatch(body, /fetchBriefFeed/);
});

test("market desks and history hydrate after the first browser paint", () => {
  const body = functionBody("showApp", "fetchMemberOnboarding");
  assert.match(body, /await loadData\(\)/);
  assert.match(body, /afterFirstPaint/);
  assert.match(body, /loadPriorityData\(\)\.then\(\(\) => refreshStockPrices\(\)\)/);
  assert.match(body, /void loadHistoryData\(\)/);
  assert.match(body, /void loadNotificationFeed\(\)/);
  assert.match(body, /void loadRouteData\(state\.route\)/);
  assert.ok(body.indexOf("await loadData()") < body.indexOf("afterFirstPaint"));
});

test("prices and overview P/L enrich the core ledger without blocking it", () => {
  const body = functionBody("loadPriorityData", "loadHistoryData");
  assert.match(body, /fetchLatestInstrumentPrices/);
  assert.match(body, /fetchJournalView\(\{ page: 1, pageSize: 6 \}\)/);
  assert.match(body, /if \(\["overview", "portfolio"\]\.includes\(state\.route\)\) render\(\)/);
});

test("watchlist and history have independent lazy loaders", () => {
  assert.match(source, /async function loadWatchlistPage/);
  assert.match(source, /async function loadHistoryData/);
  assert.match(source, /else if \(route === "watchlist"\) await loadWatchlistPage\(\)/);
  assert.match(source, /action === "execution-history"[\s\S]*await loadHistoryData\(\)[\s\S]*openExecutionHistoryDialog\(\)/);
});
