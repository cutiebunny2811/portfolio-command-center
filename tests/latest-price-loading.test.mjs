import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appUrl = new URL("../app.js", import.meta.url);
const indexUrl = new URL("../index.html", import.meta.url);
const migrationUrl = new URL("../supabase/migrations/20260815020000_latest_instrument_prices.sql", import.meta.url);

test("portfolio loads one latest price per instrument without a global history cap", async () => {
  const [app, migration] = await Promise.all([
    readFile(appUrl, "utf8"),
    readFile(migrationUrl, "utf8"),
  ]);

  assert.match(app, /async function fetchLatestInstrumentPrices\(\)/);
  assert.equal((app.match(/fetchLatestInstrumentPrices\(\)/g) || []).length, 3);
  assert.doesNotMatch(app, /from\("instrument_prices"\).*limit\(2000\)/);
  assert.match(migration, /returns setof public\.instrument_prices/);
  assert.match(migration, /select distinct on \(price\.instrument_id\)/);
  assert.match(migration, /where price\.user_id = auth\.uid\(\)/);
  assert.match(migration, /order by price\.instrument_id, price\.fetched_at desc, price\.id desc/);
});

test("latest price fix has a fresh client cache key", async () => {
  const index = await readFile(indexUrl, "utf8");
  assert.match(index, /app\.js\?v=20260902-macro-live-v1/);
});
