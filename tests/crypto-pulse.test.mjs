import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const edge = readFileSync(new URL("../supabase/functions/refresh-crypto-pulse/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260821010000_crypto_pulse.sql", import.meta.url), "utf8");

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
