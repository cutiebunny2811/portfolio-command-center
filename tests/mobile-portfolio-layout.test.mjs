import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

test("mobile holdings use an expandable ledger without replacing the desktop table", () => {
  assert.match(app, /class="mobile-holdings"/);
  assert.match(app, /data-action="holding-toggle"/);
  assert.match(app, /data-action="holding-buy"/);
  assert.match(app, /data-action="holding-sell"/);
  assert.match(app, /class="table-shell holdings-shell"><table class="holdings-table"/);
});

test("mobile breakpoint swaps the wide table for the holding ledger", () => {
  assert.match(css, /\.mobile-holdings\s*\{\s*display:\s*none;/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.holdings-shell\s*\{\s*display:\s*none;/);
  assert.match(css, /\.mobile-holding__toggle\s*\{[\s\S]*?grid-template-columns:/);
});

test("portfolio summary includes aggregate unrealized P/L and reflows as a two-by-two grid", () => {
  assert.match(app, /<small>Unrealized P\/L<\/small>/);
  assert.match(app, /money\(stats\.returnAmount\)/);
  assert.match(app, /percent\(stats\.returnPercent, 2\)/);
  assert.match(css, /\.kpi-strip\s*\{[^}]*grid-template-columns:\s*repeat\(4,/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.kpi-strip\s*\{\s*grid-template-columns:\s*repeat\(2,/);
});

test("desktop allocation summary keeps its label and ratio aligned on one line", () => {
  assert.match(css, /\.plan-summary\s*\{[^}]*grid-template-columns:\s*minmax\(250px,/);
  assert.match(css, /\.plan-summary > div:first-child\s*\{[^}]*grid-template-columns:\s*auto 1fr;/);
  assert.match(css, /\.plan-summary > div:first-child \.section-index,[\s\S]*?white-space:\s*nowrap;/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.plan-summary\s*\{\s*grid-template-columns:\s*1fr;/);
});
