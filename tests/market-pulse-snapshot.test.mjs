import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { regularMarketSnapshot, regularSnapshotIsStale } from "../supabase/functions/refresh-stock-prices/market-pulse-core.mjs";

test("market pulse uses the regular Webull ratio and never nested extended quotes", () => {
  const row = {
    symbol: "BRUN",
    price: "12.04",
    pre_close: "13.75",
    change: "-1.71",
    change_ratio: "-0.1244",
    last_trade_time: 1791576000000,
    after_hours: { price: "16.11", last_trade_time: 1791579600000 },
  };
  const result = regularMarketSnapshot(row, new Date("2026-10-09T20:05:00Z"));
  assert.equal(result.price, 12.04);
  assert.equal(result.previousClose, 13.75);
  assert.equal(result.changeValue, -1.71);
  assert.equal(result.changePercent, -12.44);
});

test("market pulse flags a previous-session quote after New York has opened", () => {
  assert.equal(regularSnapshotIsStale("2026-10-08T20:00:00Z", new Date("2026-10-09T15:00:00Z")), true);
  assert.equal(regularSnapshotIsStale("2026-10-09T14:59:00Z", new Date("2026-10-09T15:00:00Z")), false);
  assert.equal(regularSnapshotIsStale("2026-10-08T20:00:00Z", new Date("2026-10-09T13:00:00Z")), false);
});

test("collector prefers the documented v3 endpoint and keeps v2 as fallback", async () => {
  const source = await readFile(new URL("../supabase/functions/refresh-stock-prices/index.ts", import.meta.url), "utf8");
  assert.match(source, /const snapshotPath = "\/market-data\/stocks\/snapshots\/list"/);
  assert.match(source, /const legacySnapshotPath = "\/openapi\/market-data\/stock\/snapshot"/);
  assert.match(source, /signedGet\(snapshotPath,[\s\S]*"v3"\)/);
  assert.match(source, /signedGet\(legacySnapshotPath,[\s\S]*"v2"\)/);
  assert.match(source, /return snapshots\.flatMap\(\(item\) =>/);
  assert.match(source, /missingSymbols\.length/);
  assert.match(source, /\.in\("symbol", missingSymbols\)/);
  assert.match(source, /fetchMarketPulseBatchOnce\(instruments/);
  assert.match(source, /fetchMarketPulseBatch\(instruments\.slice\(0, middle\)\)/);
  assert.match(source, /fetchMarketPulseBatch\(instruments\.slice\(middle\)\)/);
});
