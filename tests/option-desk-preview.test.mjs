import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("option desk is reached from a portfolio without adding primary navigation", () => {
  assert.match(app, /data-action="option-desk-open">Option Desk/);
  assert.match(app, /else if \(state\.route === "option-desk"\) renderOptionDesk\(\)/);
  assert.doesNotMatch(index, /data-route="option-desk"/);
});

test("option desk sample workflow is visibly disconnected from the ledger", () => {
  assert.match(app, /SAMPLE MARKET DATA/);
  assert.match(app, /OPRA NOT CONNECTED/);
  assert.match(app, /NOT SAVED · NO ORDER SENT/);
  assert.match(app, /optionDeskDraftOpen/);
  assert.doesNotMatch(app, /option-draft-preview[\s\S]{0,600}api_/);
});

test("income strategies replace spreads and enforce portfolio collateral", () => {
  assert.match(app, /covered_call:\s*\{ label: "Covered Call"/);
  assert.match(app, /cash_secured_put:\s*\{ label: "Cash-Secured Put"/);
  assert.doesNotMatch(app, /Call Spread|Put Spread|call_spread|put_spread/);
  assert.match(app, /sharesHeld >= 100/);
  assert.match(app, /cashAvailable >= cashRequired/);
  assert.match(app, /data-action="option-draft-preview" \$\{selection\.eligible \? "" : "disabled"\}/);
});

test("option desk exposes contract evidence and a mobile reflow", () => {
  for (const label of ["BID", "ASK", "DELTA", "IV", "VOL / OI", "MAXIMUM LOSS", "BREAK-EVEN AT EXPIRY"]) {
    assert.match(app, new RegExp(label.replace("/", "\\/")));
  }
  assert.match(css, /\.option-workbench\s*\{[^}]*grid-template-columns:/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.option-workbench\s*\{\s*display:\s*block;/);
});
