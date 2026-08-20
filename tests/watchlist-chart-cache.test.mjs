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
const cachePolicyUrl = new URL("../supabase/functions/refresh-stock-prices/chart-cache-policy.mjs", import.meta.url);

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
  assert.match(index, /chart-technicals\.js\?v=20260820-chart-session/);
  assert.match(index, /app\.js\?v=20260821-portfolio-fx/);
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

test("chart endpoint serves a shared cache per timeframe and lets refresh bypass it", async () => {
  const source = await readFile(functionUrl, "utf8");

  assert.match(source, /D: \{ count: 320, cacheWindowMs: 20 \* 60 \* 60_000 \}/);
  assert.match(source, /M240: \{ count: 260, cacheWindowMs: 4 \* 60 \* 60_000 \}/);
  assert.match(source, /M60: \{ count: 260, cacheWindowMs: 45 \* 60_000 \}/);
  assert.match(source, /function chartTimespan\(value: unknown\)/);
  assert.match(source, /from\("market_chart_cache"\)/);
  assert.match(source, /\.eq\("timespan", timespan\)/);
  assert.match(source, /chartCacheIsStale\(\{/);
  assert.match(source, /if \(cachedBars\.length && !refreshRequested\)/);
  assert.match(source, /api_claim_market_chart_refresh/);
  assert.match(source, /if \(cachedBars\.length\) \{[\s\S]*refresh_error: detail/);
  assert.match(source, /onConflict: "instrument_id,timespan"/);
});

test("daily chart cache settles a candle fetched just before the New York close", async () => {
  const { chartCacheIsStale } = await import(cachePolicyUrl);
  const cacheWindowMs = 20 * 60 * 60_000;

  assert.equal(chartCacheIsStale({
    timespan: "D",
    fetchedAt: "2026-08-19T19:52:00Z", // 15:52 ET
    now: new Date("2026-08-19T20:15:00Z"), // 16:15 ET
    cacheWindowMs,
  }), true);
  assert.equal(chartCacheIsStale({
    timespan: "D",
    fetchedAt: "2026-08-19T20:20:00Z", // settled after the close
    now: new Date("2026-08-19T23:00:00Z"),
    cacheWindowMs,
  }), false);
  assert.equal(chartCacheIsStale({
    timespan: "D",
    fetchedAt: "2026-08-19T14:00:00Z", // 10:00 ET
    now: new Date("2026-08-19T14:46:00Z"),
    cacheWindowMs,
  }), true);
  assert.equal(chartCacheIsStale({
    timespan: "M60",
    fetchedAt: "2026-08-19T19:52:00Z",
    now: new Date("2026-08-19T20:15:00Z"),
    cacheWindowMs: 45 * 60_000,
  }), false);
});

test("daily chart reconciles a lagging historical close with a newer regular snapshot", async () => {
  const { reconcileDailyBarsWithPrice } = await import(cachePolicyUrl);
  const daily = [
    { time: "2026-08-18T13:30:00Z", open: 1000, high: 1020, low: 980, close: 1011.75, volume: 10 },
    { time: "2026-08-19T13:30:00Z", open: 990, high: 995, low: 930, close: 940.76, volume: 20 },
  ];
  const result = reconcileDailyBarsWithPrice(daily, {
    price: 937.105,
    market_time: "2026-08-19T20:00:00Z",
    fetched_at: "2026-08-19T20:40:00Z",
  }, "2026-08-19T20:33:00Z");

  assert.equal(result.reconciled, true);
  assert.equal(result.bars.at(-1).close, 937.105);
  assert.equal(result.bars.at(-1).high, 995);
  assert.equal(result.bars.at(-1).low, 930);
  assert.equal(result.bars.at(-2).close, 1011.75);

  assert.equal(reconcileDailyBarsWithPrice(daily, {
    price: 937.105,
    market_time: "2026-08-18T20:00:00Z",
    fetched_at: "2026-08-19T20:40:00Z",
  }, "2026-08-19T20:33:00Z").reconciled, false);
});

test("daily chart appends a missing session only when Webull supplies real OHLCV", async () => {
  const { reconcileDailyBarsWithPrice } = await import(cachePolicyUrl);
  const daily = [
    { time: "2026-08-18T12:00:00Z", open: 960, high: 975, low: 930, close: 940.76, volume: 20 },
  ];
  const quoteOnly = reconcileDailyBarsWithPrice(daily, {
    price: 937.105,
    market_time: "2026-08-19T20:00:00Z",
  });
  assert.equal(quoteOnly.reconciled, false);
  assert.equal(quoteOnly.missingSession, true);
  assert.equal(quoteOnly.bars.length, 1);

  const completed = reconcileDailyBarsWithPrice(daily, {
    price: 937.105,
    market_time: "2026-08-19T20:00:00Z",
    day_bar: { open: 959.36, high: 960, low: 915.18, close: 937.105, volume: 26_467_843 },
  });
  assert.equal(completed.reconciled, true);
  assert.equal(completed.missingSession, false);
  assert.equal(completed.bars.length, 2);
  assert.deepEqual(completed.bars.at(-1), {
    time: "2026-08-19T12:00:00.000Z",
    open: 959.36,
    high: 960,
    low: 915.18,
    close: 937.105,
    volume: 26_467_843,
  });
});

test("client reconciles a stale daily cache with the regular Webull snapshot", async () => {
  const code = await readFile(technicalsUrl, "utf8");
  const context = { Intl, Date, Number, Math, Object };
  context.globalThis = context;
  vm.runInNewContext(code, context);
  const bars = [{ time: "2026-08-19T04:00:00.000Z", open: 995, high: 997, low: 930, close: 940.76 }];
  const reconciled = context.PccChartTechnicals.reconcileDailyBarsWithQuote(bars, {
    price: 937.105,
    marketTime: "2026-08-19T20:00:00.000Z"
  });
  assert.equal(reconciled.at(-1).close, 937.105);
  assert.equal(reconciled.at(-1).high, 997);
  assert.equal(reconciled.at(-1).low, 930);
  assert.equal(bars[0].close, 940.76);
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
