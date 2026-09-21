import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

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
