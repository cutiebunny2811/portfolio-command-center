import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const edge = readFileSync(new URL("../supabase/functions/refresh-stock-prices/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20261028010000_active_latest_instrument_prices.sql", import.meta.url), "utf8");

test("portfolio restores account-scoped prices before background work", () => {
  assert.match(app, /pcc:latest-prices:v1:\$\{userId\}/);
  assert.match(app, /state\.prices = restorePriceCache\(user\.id\)/);
  assert.match(app, /void loadPriorityData\(\);\s*void refreshStockPrices\(\);/);
  assert.match(app, /Price update delayed\. Saved prices remain visible/);
});

test("price refresh returns fresh rows without a second history scan", () => {
  assert.match(edge, /price_updates: priceUpdates/);
  assert.match(edge, /source: "webull"/);
  assert.match(app, /mergePriceRows\(priceUpdates\)/);
});

test("latest-price RPC only probes active instruments", () => {
  assert.match(migration, /with active_instruments as/);
  assert.match(migration, /cross join lateral/);
  assert.match(migration, /where price\.user_id = auth\.uid\(\)/);
  assert.match(migration, /limit 1/);
  assert.doesNotMatch(migration, /distinct on/);
});
