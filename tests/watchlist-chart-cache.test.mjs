import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const appUrl = new URL("../app.js", import.meta.url);
const indexUrl = new URL("../index.html", import.meta.url);
const functionUrl = new URL("../supabase/functions/refresh-stock-prices/index.ts", import.meta.url);
const agentApiUrl = new URL("../supabase/functions/portfolio-agent-api/index.ts", import.meta.url);
const migrationUrl = new URL("../supabase/migrations/20260819020000_market_chart_cache.sql", import.meta.url);
const timeframeMigrationUrl = new URL("../supabase/migrations/20260819060000_market_chart_timeframes.sql", import.meta.url);
const technicalsUrl = new URL("../chart-technicals.js", import.meta.url);

test("watchlist chart exposes cached 1H, 4H and 1D views with EMA200", async () => {
  const [app, index] = await Promise.all([readFile(appUrl, "utf8"), readFile(indexUrl, "utf8")]);

  assert.match(app, /"1H": \{ apiTimespan: "M60", range: "6W", count: 260 \}/);
  assert.match(app, /"4H": \{ apiTimespan: "M240", range: "6M", count: 260 \}/);
  assert.match(app, /"1D": \{ apiTimespan: "D", range: "15M", count: 320 \}/);
  assert.match(app, /function exponentialMovingAverage\(bars, period\)/);
  assert.match(app, /EMA200/);
  assert.match(app, /function chartTechnicalLevels\(bars, timeframe/);
  assert.match(app, /data-action="watchlist-timeframe"/);
  assert.doesNotMatch(app, /ATR projection/);
  assert.match(app, /No nearby level/);
  assert.doesNotMatch(app, /data-action="watchlist-range"/);
  assert.match(index, /chart-technicals\.js\?v=20260820-opra-strikes/);
  assert.match(index, /app\.js\?v=20260820-opra-strikes/);
});

test("nearby levels reject remote historical pivots and never invent ATR levels", async () => {
  const source = await readFile(technicalsUrl, "utf8");
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(source, context);
  const bars = Array.from({ length: 120 }, (_, index) => {
    const close = index < 80
      ? 60 + Math.sin(index * Math.PI / 2) * 3
      : 100 + Math.sin((index - 80) * Math.PI / 3) * 5;
    return { close, high: close + .6, low: close - .6, open: close - .2, volume: 1000 };
  });
  const levels = context.PccChartTechnicals.calculateNearbyLevels(bars, "1D");

  assert.ok(levels.supports.length > 0);
  assert.ok(levels.resistances.length > 0);
  assert.ok(levels.supports.every((level) => level.price > 85));
  assert.ok(levels.resistances.every((level) => level.price < 115));
  assert.ok([...levels.supports, ...levels.resistances].every((level) => level.touches >= 1));
  assert.ok(levels.supports.length < 2 || Math.abs(levels.supports[0].price - levels.supports[1].price) > .5);
  assert.ok(levels.resistances.length < 2 || Math.abs(levels.resistances[0].price - levels.resistances[1].price) > .5);
});

test("chart endpoint serves a shared cache per timeframe before Webull", async () => {
  const source = await readFile(functionUrl, "utf8");

  assert.match(source, /D: \{ count: 320, cacheWindowMs: 20 \* 60 \* 60_000 \}/);
  assert.match(source, /M240: \{ count: 260, cacheWindowMs: 4 \* 60 \* 60_000 \}/);
  assert.match(source, /M60: \{ count: 260, cacheWindowMs: 45 \* 60_000 \}/);
  assert.match(source, /function chartTimespan\(value: unknown\)/);
  assert.match(source, /from\("market_chart_cache"\)/);
  assert.match(source, /\.eq\("timespan", timespan\)/);
  assert.match(source, /if \(cachedBars\.length && \(!refreshRequested \|\| !stale\)\)/);
  assert.match(source, /api_claim_market_chart_refresh/);
  assert.match(source, /if \(cachedBars\.length\) \{[\s\S]*refresh_error: detail/);
  assert.match(source, /onConflict: "instrument_id,timespan"/);
});

test("agent chart calls exchange the agent token for a scoped internal chart request", async () => {
  const [source, agentApi] = await Promise.all([
    readFile(functionUrl, "utf8"),
    readFile(agentApiUrl, "utf8"),
  ]);

  assert.match(agentApi, /"Authorization": `Bearer \$\{serviceRoleKey\}`/);
  assert.match(agentApi, /"apikey": serviceRoleKey/);
  assert.match(agentApi, /user_id: identity\.user_id/);
  assert.match(source, /\["chart", "option_chain"\]\.includes\(String\(body\?\.action/);
  assert.match(source, /bearer === supabaseServiceRoleKey/);
  assert.match(source, /Invalid internal user/);
  assert.match(source, /const chartClient = internalUserId \? admin : supabase/);
  assert.match(source, /\.eq\("user_id", authenticatedUserId\)/);
});

test("chart cache is shared read-only data with a per-timeframe service lease", async () => {
  const [migration, timeframeMigration] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(timeframeMigrationUrl, "utf8")
  ]);

  assert.match(migration, /create table if not exists public\.market_chart_cache/);
  assert.match(migration, /for select\s+to authenticated\s+using \(true\)/);
  assert.doesNotMatch(migration, /grant (insert|update|delete).*authenticated/i);
  assert.match(timeframeMigration, /primary key \(instrument_id, timespan\)/);
  assert.match(timeframeMigration, /p_timespan text/);
  assert.match(timeframeMigration, /on conflict \(instrument_id, timespan\)/);
  assert.match(timeframeMigration, /grant execute on function public\.api_claim_market_chart_refresh[\s\S]*to service_role/);
});
