import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

test("portfolio history loads canonical cash movements beside executions", () => {
  assert.match(app, /db\.from\("cash_movements"\)\.select\("id,portfolio_id,movement_type,amount,occurred_at,notes,metadata"\)/);
  assert.match(app, /cashMovements/);
});

test("history dialog separates trades from cash activity", () => {
  assert.match(app, /data-history-view="trades"/);
  assert.match(app, /data-history-view="cash"/);
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
