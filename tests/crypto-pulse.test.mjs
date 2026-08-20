import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const edge = readFileSync(new URL("../supabase/functions/refresh-crypto-pulse/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260821010000_crypto_pulse.sql", import.meta.url), "utf8");
const chartMigration = readFileSync(new URL("../supabase/migrations/20260821030000_crypto_chart_cache.sql", import.meta.url), "utf8");

test("Crypto Pulse is a third Watchlist view, not a new primary route", () => {
  assert.match(app, /data-view="crypto"><span>03<\/span>Crypto Pulse/);
  assert.match(app, /function renderCryptoPulse\(\)/);
  assert.match(app, /BTC leads the read/);
  assert.doesNotMatch(app, /initialRoute = \[[^\]]*crypto/);
});

test("free Binance public data is used without exchange credentials", () => {
  assert.match(edge, /data-api\.binance\.vision\/api\/v3\/ticker\/24hr/);
  assert.match(edge, /fapi\.binance\.com\/fapi\/v1\/premiumIndex/);
  assert.match(edge, /fapi\.binance\.com\/fapi\/v1\/openInterest/);
  assert.doesNotMatch(edge, /BINANCE_(API|SECRET|KEY)/);
  assert.doesNotMatch(edge, /apiKey|secretKey/);
});

test("member crypto lists are isolated while market snapshots are shared", () => {
  assert.match(migration, /crypto_watchlist_items_select_own[\s\S]*user_id = auth\.uid\(\)/);
  assert.match(migration, /crypto_market_snapshots_authenticated_read[\s\S]*using \(true\)/);
  assert.match(migration, /'BTCUSDT', 'BTC', 'Bitcoin'/);
  assert.match(migration, /'ETHUSDT', 'ETH', 'Ethereum'/);
  assert.match(migration, /'SOLUSDT', 'SOL', 'Solana'/);
});

test("responsive Crypto Pulse recomposes instead of preserving the desktop table", () => {
  assert.match(css, /\.crypto-asset-head \{ display: none; \}/);
  assert.match(css, /\.crypto-asset-row \{ grid-template-columns: 28px minmax\(0, 1fr\) auto 24px/);
  assert.match(css, /\.crypto-btc \{ grid-template-columns: 1fr; \}/);
});

test("Crypto Pulse chart uses Binance public klines through a shared authenticated cache", () => {
  assert.match(edge, /data-api\.binance\.vision\/api\/v3\/klines/);
  assert.match(edge, /body\?\.action === "chart"/);
  assert.match(edge, /api_claim_crypto_chart_refresh/);
  assert.match(chartMigration, /create table if not exists public\.crypto_chart_cache/);
  assert.match(chartMigration, /crypto_chart_cache_authenticated_read[\s\S]*using \(true\)/);
  assert.match(chartMigration, /interval in \('15m', '1h', '4h', '1d'\)/);
});

test("Crypto chart is selectable, technical, and responsive without adding another primary route", () => {
  assert.match(app, /data-action="crypto-chart-symbol"/);
  assert.match(app, /data-action="crypto-chart-timeframe"/);
  assert.match(app, /function drawCryptoChart\(\)/);
  assert.match(app, /EMA20[\s\S]*EMA50[\s\S]*EMA200/);
  assert.match(css, /#crypto-chart[\s\S]*height:/);
  assert.match(css, /\.crypto-chart-command \{ grid-template-columns: 1fr; \}/);
});
