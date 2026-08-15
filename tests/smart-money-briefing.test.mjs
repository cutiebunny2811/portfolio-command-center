import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const appUrl = new URL("../app.js", import.meta.url);
const apiUrl = new URL("../supabase/functions/portfolio-agent-api/index.ts", import.meta.url);
const migrationUrl = new URL("../supabase/migrations/20260816030000_smart_money_weekly_briefs.sql", import.meta.url);

test("weekly Smart Money publications are shared, deduplicated and freshness guarded", async () => {
  const [app, api, migration] = await Promise.all([
    readFile(appUrl, "utf8"),
    readFile(apiUrl, "utf8"),
    readFile(migrationUrl, "utf8"),
  ]);

  assert.match(migration, /create table if not exists public\.smart_money_briefs/);
  assert.match(migration, /prior_key = any\(p_reported_event_keys\)/);
  assert.match(migration, /limited to one edition per week/);
  assert.match(migration, /Smart Money source is stale; publication refused/);
  assert.match(migration, /'smart_money_brief', 'Smart Money Brief'/);
  assert.match(api, /async function smartMoneyBriefingContext/);
  assert.match(api, /previously_reported_in_window/);
  assert.match(api, /If new_event_count is zero, do not publish and do not notify/);
  assert.match(api, /already-reported or unavailable event keys/);
  assert.match(app, /notice\.notification_type === "smart_money_brief" \? "SMART"/);
  assert.match(app, /id="smart-money-brief"/);
  assert.match(app, /30-DAY WINDOW · NO RERUNS/);
});
