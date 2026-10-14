import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

test("portfolio history loads canonical cash movements beside executions", () => {
  assert.match(app, /db\.from\("cash_movements"\)\.select\("id,portfolio_id,movement_type,amount,occurred_at,notes,metadata"\)/);
  assert.match(app, /cashMovements/);
});

test("history dialog separates trades, cash activity and FX", () => {
  assert.match(app, /data-history-view="trades"/);
  assert.match(app, /data-history-view="cash"/);
  assert.match(app, /data-history-view="fx"/);
  assert.match(app, /Deposit/);
  assert.match(app, /Withdrawal/);
  assert.match(app, /Initial funding/);
  assert.match(app, /Dividend/);
  assert.match(app, /Interest/);
  assert.match(app, /Tax/);
});

test("cash activity has a compact responsive ledger", () => {
  assert.match(css, /\.history-tabs\s*\{/);
  assert.match(css, /\.cash-history-table\s*\{/);
  assert.match(app, /cash-history-card/);
});

test("confirmed trades can be deleted with an audited ledger rebuild", () => {
  const migration = readFileSync(
    new URL("../supabase/migrations/20261015010000_delete_execution_with_rebuild.sql", import.meta.url),
    "utf8",
  );

  assert.match(app, /data-action="trade-history-delete"/);
  assert.match(app, /api_delete_execution/);
  assert.match(app, /Delete transaction/);
  assert.match(migration, /delete from public\.journal_entries/i);
  assert.match(migration, /delete from public\.executions/i);
  assert.match(migration, /public\.api_rebuild_position/i);
  assert.match(migration, /public\.api_cash_balance/i);
  assert.match(migration, /'delete_execution'/i);
});
