import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/052_cash_balance_cent_normalization.sql", import.meta.url), "utf8");

test("sub-cent cash residue is canonicalized to zero", () => {
  assert.match(app, /const cashAmount = \(value\) => Math\.abs\(num\(value\)\) < 0\.005 \? 0 : num\(value\)/);
  assert.match(app, /\.format\(Math\.abs\(num\(value\)\) < \(0\.5 \* 10 \*\* -digits\) \? 0 : num\(value\)\)/);
  assert.match(migration, /when abs\(raw_balance\) < 0\.005 then 0::numeric/i);
  assert.match(migration, /create or replace function public\.api_cash_balance/i);
  assert.match(migration, /create or replace view public\.portfolio_cash_balances/i);
});

test("cash dialog exposes the canonical PCC balance", () => {
  assert.match(app, /Available in PCC: \$\{money\(cashBalance\)\}/);
});

test("a full withdrawal entered to cents snaps to the precise ledger balance", () => {
  assert.match(app, /Math\.round\(usdAmount \* 100\) === Math\.round\(cashBalance \* 100\)/);
  assert.match(app, /const recordedUsdAmount = isRoundedFullWithdrawal \? cashBalance : usdAmount/);
  assert.match(app, /p_amount: recordedUsdAmount/);
  assert.match(app, /p_usd_amount: recordedUsdAmount/);
});

test("a real cash shortfall reports the missing activity", () => {
  assert.match(app, /Record the missing \$\{money\(shortfall\)\} cash activity/);
});
