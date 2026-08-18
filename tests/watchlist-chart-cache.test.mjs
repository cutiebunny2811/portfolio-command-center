import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appUrl = new URL("../app.js", import.meta.url);
const indexUrl = new URL("../index.html", import.meta.url);
const functionUrl = new URL("../supabase/functions/refresh-stock-prices/index.ts", import.meta.url);
const migrationUrl = new URL("../supabase/migrations/20260819020000_market_chart_cache.sql", import.meta.url);

test("watchlist chart uses one fixed daily range with EMA200 and technical levels", async () => {
  const [app, index] = await Promise.all([readFile(appUrl, "utf8"), readFile(indexUrl, "utf8")]);

  assert.match(app, /watchlistChartConfig = \{ apiTimespan: "D", range: "15M", count: 320 \}/);
  assert.match(app, /function exponentialMovingAverage\(bars, period\)/);
  assert.match(app, /EMA200/);
  assert.match(app, /function chartTechnicalLevels\(bars\)/);
  assert.match(app, /ATR projection/);
  assert.match(app, /Calculated from recent daily swing pivots and ATR/);
  assert.doesNotMatch(app, /data-action="watchlist-timeframe"/);
  assert.doesNotMatch(app, /data-action="watchlist-range"/);
  assert.match(index, /app\.js\?v=20260819-chart-cache/);
});

test("chart endpoint serves shared cache before Webull and keeps stale bars on refresh failure", async () => {
  const source = await readFile(functionUrl, "utf8");

  assert.match(source, /const chartBarCount = 320/);
  assert.match(source, /const chartCacheWindowMs = 20 \* 60 \* 60_000/);
  assert.match(source, /from\("market_chart_cache"\)/);
  assert.match(source, /if \(cachedBars\.length && \(!refreshRequested \|\| !stale\)\)/);
  assert.match(source, /api_claim_market_chart_refresh/);
  assert.match(source, /if \(cachedBars\.length\) \{[\s\S]*refresh_error: detail/);
  assert.doesNotMatch(source, /body\?\.count/);
});

test("chart cache is shared read-only data with a service-role refresh lease", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(migration, /create table if not exists public\.market_chart_cache/);
  assert.match(migration, /for select\s+to authenticated\s+using \(true\)/);
  assert.match(migration, /api_claim_market_chart_refresh/);
  assert.match(migration, /grant execute on function public\.api_claim_market_chart_refresh[\s\S]*to service_role/);
  assert.doesNotMatch(migration, /grant (insert|update|delete).*authenticated/i);
});
