import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { analyzeWatchlistSetup } from "../supabase/functions/portfolio-agent-api/watchlist-setup-scanner.mjs";

const apiUrl = new URL("../supabase/functions/portfolio-agent-api/index.ts", import.meta.url);

function bar(close, index, volume = 1000) {
  return {
    time: new Date(Date.UTC(2025, 0, 1 + index)).toISOString(),
    open: close - 0.2,
    high: close + 0.8,
    low: close - 0.8,
    close,
    volume,
  };
}

test("daily scanner identifies a recent EMA200 reclaim without returning raw bars", () => {
  const closes = Array.from({ length: 230 }, (_, index) => index < 229 ? (index > 216 ? 98.5 : 100) : 102);
  const bars = closes.map((close, index) => bar(close, index, index === 229 ? 1600 : 1000));
  const result = analyzeWatchlistSetup({ symbol: "TEST", bars, fetchedAt: "2026-08-20T00:00:00Z" });
  const reclaim = result.setups.find((setup) => setup.setup === "RECLAIM_EMA200");

  assert.ok(reclaim);
  assert.ok(reclaim.distance_from_ema200_pct >= 0.3 && reclaim.distance_from_ema200_pct <= 5);
  assert.ok(["WATCH", "READY_FOR_4H"].includes(reclaim.status));
  assert.equal("bars" in reclaim, false);
  assert.equal(reclaim.next_step.includes("4H"), true);
});

test("daily scanner identifies a held nearby support and provides decision and failure zones", () => {
  const bars = Array.from({ length: 230 }, (_, index) => {
    const base = 95 + index * 0.025;
    return bar(base + Math.sin(index / 4) * 0.8, index, 1000 + index);
  });
  const result = analyzeWatchlistSetup({ symbol: "HOLD", bars, market: { price: 101, market_time: "2026-08-20T00:00:00Z" } });
  const support = result.setups.find((setup) => setup.setup === "NEAR_SUPPORT");

  assert.ok(support);
  assert.ok(support.distance_from_support_pct <= 2.5);
  assert.equal(support.decision_zone.length, 2);
  assert.equal(support.failure_zone.length, 2);
});

test("agent scanner is bounded, batched and returns a continuation offset", async () => {
  const source = await readFile(apiUrl, "utf8");

  assert.match(source, /async function watchlistSetupScan/);
  assert.match(source, /integer\(body\.batch_size, 20, 5, 20\)/);
  assert.match(source, /mapWithConcurrency\(batch, 4/);
  assert.match(source, /next_offset: nextOffset/);
  assert.match(source, /daily_scan_only: true/);
  assert.match(source, /action === "watchlist_setups"/);
});
