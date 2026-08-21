import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appUrl = new URL("../app.js", import.meta.url);
const indexUrl = new URL("../index.html", import.meta.url);
const migrationUrl = new URL("../supabase/migrations/20260812040000_smart_money_query_performance.sql", import.meta.url);
const fastFeedMigrationUrl = new URL("../supabase/migrations/20260822010000_smart_money_fast_member_feed.sql", import.meta.url);

test("Smart Money is lazy and cannot take down the mobile dashboard startup", async () => {
  const app = await readFile(appUrl, "utf8");
  const index = await readFile(indexUrl, "utf8");

  assert.match(app, /async function initialSmartMoneyQuery\(\)/);
  assert.match(app, /if \(state\.route !== "smart-money"\) return state\.smartMoneyEvents/);
  assert.match(app, /state\.smartMoneyError = friendlyError\(error\)/);
  assert.match(app, /data-action="smart-money-retry"/);
  assert.match(app, /async function loadSmartMoneyPage/);
  assert.match(index, /app\.js\?v=20260822-watchlist-valuation3/);
  assert.match(app, /state\.watchlistLoaded \? Promise\.resolve\(state\.watchlist\) : optionalWatchlistQuery\(\)/);
});

test("Smart Money RPC has indexes for normalized symbols and global filing lookup", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(migration, /instruments_symbol_normalized_idx/);
  assert.match(migration, /upper\(btrim\(symbol\)\)/);
  assert.match(migration, /smart_money_events_instrument_filed_global_idx/);
  assert.match(migration, /with watched as materialized/);
});

test("Smart Money uses the member index before a bounded shared fallback", async () => {
  const migration = await readFile(fastFeedMigrationUrl, "utf8");

  assert.match(migration, /smart_money_events_user_filed_created_idx/);
  assert.match(migration, /where event\.user_id = v_user/);
  assert.match(migration, /if jsonb_array_length\(v_entries\) > 0 then/);
  assert.match(migration, /limit greatest\(v_limit \* 8, 1000\)/);
});
