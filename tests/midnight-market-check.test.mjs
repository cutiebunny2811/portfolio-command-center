import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("../supabase/migrations/20260819010000_midnight_market_checks.sql", import.meta.url);
const apiUrl = new URL("../supabase/functions/portfolio-agent-api/index.ts", import.meta.url);
const promptUrl = new URL("../hermes-mcp/BRIEFING_PROMPTS.md", import.meta.url);
const appUrl = new URL("../app.js", import.meta.url);
const stylesUrl = new URL("../styles.css", import.meta.url);

test("routine midnight checks share the brief feed without creating notifications", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(migration, /update_kind in \('continuation', 'market_check'\)/);
  assert.match(migration, /api_agent_publish_midnight_market_check/);
  assert.match(migration, /'market_check', 'unchanged'/);
  assert.match(migration, /'notified_members', 0/);
  assert.doesNotMatch(migration, /insert into public\.pcc_notifications/);
  assert.match(migration, /on conflict \(user_id, idempotency_key\) do update/);
});

test("agent API validates and publishes a completed-session market check", async () => {
  const api = await readFile(apiUrl, "utf8");

  assert.match(api, /function validateMarketCheckContent/);
  assert.match(api, /content\.session_date/);
  assert.match(api, /"rotation_leaders", "rotation_laggards"/);
  assert.match(api, /api_agent_publish_midnight_market_check/);
  assert.match(api, /action === "publish_midnight_market_check"/);
  assert.match(api, /notified: false/);
  assert.match(api, /routine check is saved silently and never creates a PCC notification/);
});

test("Hermes retains unchanged midnight reads and reserves Continuations for material changes", async () => {
  const prompt = (await readFile(promptUrl, "utf8")).replace(/\s+/g, " ");

  assert.match(prompt, /call publish_midnight_market_check exactly once/);
  assert.match(prompt, /latest completed US session/);
  assert.match(prompt, /price-based relative rotation/);
  assert.match(prompt, /do not publish a routine Market Check/);
  assert.match(prompt, /daily-market-brief:YYYY-MM-DD:market-check:0000/);
});

test("Daily Brief renders Market Checks as a responsive editorial tape", async () => {
  const [app, styles] = await Promise.all([readFile(appUrl, "utf8"), readFile(stylesUrl, "utf8")]);

  assert.match(app, /function briefMarketCheckMarkup/);
  assert.match(app, /MIDNIGHT MARKET CHECK/);
  assert.match(app, /NO MATERIAL CHANGE/);
  assert.match(app, /ROTATION LEADERS/);
  assert.match(app, /ROTATION LAGGARDS/);
  assert.match(app, /update\?\.update_kind === "market_check"/);
  assert.match(app, /briefUpdateCountLabel/);
  assert.match(styles, /\.brief-market-check__rotation \{ display: grid; grid-template-columns: repeat\(2/);
  assert.match(styles, /\.brief-market-check__rotation \{ grid-template-columns: 1fr; \}/);
  assert.match(styles, /\.brief-market-check__read \{ grid-template-columns: 1fr; \}/);
});
