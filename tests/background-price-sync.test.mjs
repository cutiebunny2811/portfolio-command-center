import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const edge = readFileSync(new URL("../supabase/functions/refresh-stock-prices/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20261027010000_background_portfolio_price_sync.sql", import.meta.url), "utf8");
const scopeFix = readFileSync(new URL("../supabase/migrations/20261027020000_fix_background_portfolio_price_target_scope.sql", import.meta.url), "utf8");

test("portfolio refresh uses the lightweight portfolio-only action", () => {
  assert.match(app, /body:\s*\{ action: "portfolio_prices", force \}/);
  assert.match(edge, /const portfolioOnly = action === "portfolio_prices"/);
  assert.match(edge, /portfolioOnly\s*\? Promise\.resolve\(\{ data: \[\], error: null \}\)/);
  assert.match(edge, /price_updates: priceUpdates/);
});

test("scheduled refresh is authenticated and scoped to one member", () => {
  assert.match(edge, /Deno\.env\.get\("PRICE_SYNC_SECRET"\)/);
  assert.match(edge, /request\.headers\.get\("x-sync-secret"\)/);
  assert.match(edge, /\.select\("instrument_id,portfolios!inner\(user_id\)"\)/);
  assert.match(edge, /\.eq\("portfolios\.user_id", authenticatedUserId\)/);
  assert.match(edge, /\.eq\("user_id", authenticatedUserId\)/);
  assert.match(edge, /user_id: authenticatedUserId/);
});

test("Supabase refreshes active portfolios every fifteen minutes", () => {
  assert.match(migration, /refresh-portfolio-prices-every-15-minutes/);
  assert.match(migration, /'\*\/15 \* \* \* \*'/);
  assert.match(migration, /where name = 'price_sync_secret'/);
  assert.match(migration, /from public\.pcc_members member/);
  assert.match(migration, /position\.quantity > 0/);
  assert.match(migration, /join public\.portfolios portfolio/);
  assert.match(scopeFix, /where portfolio\.user_id = member\.user_id/);
});
