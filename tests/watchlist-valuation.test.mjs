import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const edge = readFileSync(new URL("../supabase/functions/refresh-company-valuation/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260822030000_watchlist_valuations.sql", import.meta.url), "utf8");

test("Valuation is the fourth Watchlist view with a sourced forward three-case read", () => {
  assert.match(app, /data-view="valuation"><span>04<\/span>Valuation/);
  assert.match(app, /03 \/ FORWARD VALUE RANGE/);
  assert.match(app, /02 \/ FORWARD INTRINSIC VALUE/);
  assert.match(app, /valuation-case--\$\{item\.key\}/);
  assert.match(app, /Explain the range/);
  assert.doesNotMatch(app, /Asking Gemini|explanation_model/);
  assert.match(app, /const requestId = \+\+valuationRequestId/);
  assert.match(app, /requestId !== valuationRequestId/);
  assert.match(app, /await edgeFunctionError\(error\)/);
});

test("official SEC filings ground forward assumptions and PCC calculates the range", () => {
  assert.match(edge, /data\.sec\.gov\/api\/xbrl\/companyfacts/);
  assert.match(edge, /data\.sec\.gov\/submissions/);
  assert.match(edge, /coverPageSharesFromHtml/);
  assert.match(edge, /generateForwardPacket/);
  assert.match(edge, /Do not use or infer the current market price/);
  assert.match(edge, /buildValuation/);
  assert.match(edge, /body\?\.action === "explain"/);
  assert.match(edge, /Do not recalculate, recommend a trade, add outside facts, or use Markdown/);
});

test("the Edge Function only values stocks on the authenticated member watchlist", () => {
  assert.match(edge, /client\.auth\.getUser\(\)/);
  assert.match(edge, /from\("watchlist_items"\)[\s\S]*eq\("user_id", authData\.user\.id\)/);
  assert.match(edge, /asset_type\)\.toLowerCase\(\) !== "stock"/);
});

test("the shared snapshot is read-only to members and explanations cannot overwrite valuation", () => {
  assert.match(migration, /company_valuation_snapshots_authenticated_read[\s\S]*for select to authenticated/);
  assert.match(migration, /grant select on public\.company_valuation_snapshots to authenticated/);
  assert.doesNotMatch(migration, /grant (insert|update|delete)/i);
  assert.match(edge, /update\(\{[\s\S]*explanation: explanation\.text/);
  assert.doesNotMatch(edge, /update\(\{\s*valuation: explanation/i);
});

test("mobile Valuation recomposes into one-column scenarios", () => {
  assert.match(css, /\.valuation-workbench \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /\.valuation-cases \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /\.valuation-source \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /\.valuation-ai__points \{ grid-template-columns: 1fr; \}/);
});
