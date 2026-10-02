import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appUrl = new URL("../app.js", import.meta.url);
const migrationUrl = new URL("../supabase/migrations/20261003010000_latest_instrument_prices_index.sql", import.meta.url);

test("latest-price lookup has an index matching its member and recency order", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(migration, /on public\.instrument_prices \(user_id, instrument_id, fetched_at desc, id desc\)/i);
});

test("a failed manual price refresh clears the updating status", async () => {
  const app = await readFile(appUrl, "utf8");
  const refresh = app.slice(
    app.indexOf("async function refreshStockPrices"),
    app.indexOf("async function refreshMarketPulse"),
  );

  assert.match(refresh, /catch \(error\) \{[\s\S]*if \(notify\) setSync\(false, "Price sync failed"\)/);
});
