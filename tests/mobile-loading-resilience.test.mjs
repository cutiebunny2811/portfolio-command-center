import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appUrl = new URL("../app.js", import.meta.url);
const indexUrl = new URL("../index.html", import.meta.url);
const migrationUrl = new URL("../supabase/migrations/20260812040000_smart_money_query_performance.sql", import.meta.url);

test("Smart Money is lazy and cannot take down the mobile dashboard startup", async () => {
  const app = await readFile(appUrl, "utf8");
  const index = await readFile(indexUrl, "utf8");

  assert.match(app, /async function initialSmartMoneyQuery\(\)/);
  assert.match(app, /if \(state\.route !== "smart-money"\) return state\.smartMoneyEvents/);
  assert.match(app, /state\.smartMoneyError = friendlyError\(error\)/);
  assert.match(app, /data-action="smart-money-retry"/);
  assert.doesNotMatch(app, /\n\s*optionalSmartMoneyQuery\(\),\n/);
  assert.match(index, /app\.js\?v=20260822-priority-load/);
});

test("Smart Money RPC has indexes for normalized symbols and global filing lookup", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(migration, /instruments_symbol_normalized_idx/);
  assert.match(migration, /upper\(btrim\(symbol\)\)/);
  assert.match(migration, /smart_money_events_instrument_filed_global_idx/);
  assert.match(migration, /with watched as materialized/);
});
