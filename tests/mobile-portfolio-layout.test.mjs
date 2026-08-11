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
