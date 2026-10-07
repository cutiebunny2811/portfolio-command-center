import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../supabase/migrations/20260901010000_allow_options_in_mixed_portfolios.sql",
  import.meta.url,
);
const agentMigrationUrl = new URL(
  "../supabase/migrations/20261008010000_allow_mixed_assets_in_agent_drafts.sql",
  import.meta.url,
);
const campaignMigrationUrl = new URL(
  "../supabase/migrations/20261008020000_allow_mixed_assets_in_agent_campaigns.sql",
  import.meta.url,
);

test("mixed portfolios accept option trades and option opening positions", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  const compact = migration.replace(/\s+/g, " ");

  assert.match(compact, /api_create_trade_draft/);
  assert.match(compact, /api_set_opening_position/);
  assert.match(compact, /pg_get_functiondef/);
  assert.match(compact, /Instrument type does not match portfolio/);
  assert.match(compact, /regexp_replace/);
  assert.match(compact, /legacy guard removed/i);
  assert.doesNotMatch(compact, /portfolio_mode\s*=\s*'options'/i);
});

test("agent drafts accept stocks, ETFs and options in every portfolio", async () => {
  const migration = await readFile(agentMigrationUrl, "utf8");
  const compact = migration.replace(/\s+/g, " ");

  assert.match(compact, /api_agent_create_trade_draft/);
  assert.match(compact, /api_create_trade_draft/);
  assert.match(compact, /api_set_opening_position/);
  assert.match(compact, /regexp_replace/);
  assert.match(compact, /Legacy portfolio asset guard remains/);
  assert.match(compact, /api_agent_create_trade_draft was not found/);
});

test("agent campaign resolution cannot restore the legacy asset guard", async () => {
  const migration = await readFile(campaignMigrationUrl, "utf8");
  const compact = migration.replace(/\s+/g, " ");

  assert.match(compact, /api_agent_resolve_rule_a_campaign/);
  assert.match(compact, /proname like 'api\\_%'/);
  assert.match(compact, /pg_get_functiondef/);
  assert.match(compact, /Instrument type does not match portfolio/);
  assert.match(compact, /Legacy portfolio asset guard remains/);
});
