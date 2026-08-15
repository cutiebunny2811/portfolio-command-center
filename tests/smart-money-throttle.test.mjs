import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const collector = readFileSync(new URL("../supabase/functions/sync-smart-money/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260816010000_throttle_smart_money_cron.sql", import.meta.url), "utf8");

test("Smart Money stays inside the shared Massive request budget", () => {
  assert.match(collector, /const massiveRequestGapMs = 15_000/);
  assert.match(collector, /const massiveRateLimitRetries = 1/);
  assert.match(collector, /const maxBackfillSymbolsPerRun = 1/);
  assert.match(collector, /result\.status !== 429/);
  assert.match(collector, /Smart Money backfill deferred/);
  assert.match(collector, /completedBackfillSymbols/);
});

test("Smart Money cron runs every four hours on weekdays", () => {
  assert.match(migration, /command ilike '%sync-smart-money%'/);
  assert.match(migration, /17 1,5,9,13,17,21 \* \* 1-5/);
  assert.match(migration, /cron\.alter_job/);
});
