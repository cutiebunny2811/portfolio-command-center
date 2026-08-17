import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const apiSource = await readFile(
  new URL("../supabase/functions/portfolio-agent-api/index.ts", import.meta.url),
  "utf8",
);
const migrationSource = await readFile(
  new URL(
    "../supabase/migrations/20260818010000_news_alert_processed_state.sql",
    import.meta.url,
  ),
  "utf8",
);
const backfillSource = await readFile(
  new URL(
    "../supabase/migrations/20260818011000_backfill_news_alert_processed_state.sql",
    import.meta.url,
  ),
  "utf8",
);

test("News alert dedup is independent from the member read state", () => {
  assert.match(migrationSource, /alert_processed_at timestamptz/i);
  assert.match(apiSource, /!entry\.is_alert_processed/);
  assert.match(apiSource, /update\(\{ alert_processed_at: now, updated_at: now \}\)/);
  assert.doesNotMatch(
    apiSource,
    /async function acknowledgeNews[\s\S]*?update\(\{ is_read: true/,
  );
  assert.match(apiSource, /user_read_state_changed: false/);
  assert.match(backfillSource, /where is_read = true/i);
  assert.match(backfillSource, /alert_processed_at is null/i);
});
