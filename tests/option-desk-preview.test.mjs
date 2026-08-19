import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const edge = readFileSync(new URL("../supabase/functions/refresh-stock-prices/index.ts", import.meta.url), "utf8");

test("option desk is reached from a portfolio without adding primary navigation", () => {
  assert.match(app, /data-action="option-desk-open">Option Desk/);
  assert.match(app, /else if \(state\.route === "option-desk"\) renderOptionDesk\(\)/);
  assert.doesNotMatch(index, /data-route="option-desk"/);
});

test("option desk requests the owner-only live OPRA chain", () => {
  assert.match(app, /action: "option_chain"/);
  assert.match(app, /LIVE OPRA DATA/);
  assert.match(edge, /quote_mode: "REAL-TIME OPRA"/);
  assert.match(edge, /OPTIONS_OPRA_OWNER_USER_ID/);
  assert.match(edge, /code: "OPRA_OWNER_ONLY"/);
  assert.match(edge, /nearestContracts\(contracts/);
  assert.doesNotMatch(app, /SAMPLE MARKET DATA|OPRA NOT CONNECTED|DELAYED SAMPLE/);
  assert.match(app, /PREVIEW FIXTURE/);
  assert.match(app, /optionDeskDraftOpen/);
});

test("income strategies replace spreads and enforce portfolio collateral", () => {
  assert.match(app, /covered_call:\s*\{ label: "Covered Call"/);
  assert.match(app, /cash_secured_put:\s*\{ label: "Cash-Secured Put"/);
  assert.doesNotMatch(app, /Call Spread|Put Spread|call_spread|put_spread/);
  assert.match(app, /sharesHeld >= multiplier/);
  assert.match(app, /cashAvailable >= cashRequired/);
  assert.match(app, /current ledger does not create short-option positions/);
});

test("live long options can be planned and handed to completed-fill recording", () => {
  assert.match(app, /api_upsert_instrument/);
  assert.match(app, /api_set_allocation_target/);
  assert.match(app, /data-action="option-plan-contract"/);
  assert.match(app, /data-action="option-record-fill"/);
  assert.match(app, /underlyingPrice: num\(selection\.data\.underlying\?\.price\)/);
  assert.match(app, /PCC never places an order/);
});

test("option desk exposes live contract evidence and a mobile reflow", () => {
  for (const label of ["BID", "ASK", "DELTA", "IV", "VOL / OI", "MAXIMUM LOSS", "BREAK-EVEN AT EXPIRY"]) {
    assert.match(app, new RegExp(label.replace("/", "\\/")));
  }
  assert.match(css, /\.option-workbench\s*\{[^}]*grid-template-columns:/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.option-workbench\s*\{\s*display:\s*block;/);
  assert.match(css, /\.option-symbol-command/);
  assert.match(css, /\.option-expiry-field/);
});
