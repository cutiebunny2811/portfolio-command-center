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
const claimMigrationSource = await readFile(
  new URL(
    "../supabase/migrations/20260820010000_news_alert_claim_lease.sql",
    import.meta.url,
  ),
  "utf8",
);
const promptSource = await readFile(
  new URL("../hermes-mcp/BRIEFING_PROMPTS.md", import.meta.url),
  "utf8",
);

test("News alert dedup is independent from the member read state", () => {
  assert.match(migrationSource, /alert_processed_at timestamptz/i);
  assert.match(claimMigrationSource, /alert_claim_token uuid/i);
  assert.match(claimMigrationSource, /alert_claimed_at timestamptz/i);
  assert.match(apiSource, /!entry\.is_alert_processed/);
  assert.match(apiSource, /alert_claim_token: claimToken/);
  assert.match(apiSource, /\.is\("alert_claimed_at", null\)/);
  assert.match(apiSource, /claim_token must be the UUID returned by get_news/);
  assert.match(apiSource, /\.eq\("alert_claim_token", claimToken\)/);
  assert.match(apiSource, /alert_processed_at: now,[\s\S]*alert_claim_token: null/);
  assert.doesNotMatch(
    apiSource,
    /async function acknowledgeNews[\s\S]*?update\(\{ is_read: true/,
  );
  assert.match(apiSource, /user_read_state_changed: false/);
  assert.match(apiSource, /async function requeueNewsAlerts/);
  assert.match(apiSource, /alert_processed_at: null,[\s\S]*alert_claim_token: null,[\s\S]*alert_claimed_at: null/);
  assert.match(backfillSource, /where is_read = true/i);
  assert.match(backfillSource, /alert_processed_at is null/i);
});

test("collector-confirmed HIGH news cannot be silently demoted by Hermes", () => {
  assert.match(apiSource, /must_notify: alertLevel === "HIGH"/);
  assert.match(apiSource, /alert_delivery_rule: alertLevel === "HIGH" \? "NOTIFY"/);
  assert.match(apiSource, /source_verification: article\.source === "x" \? "X_SOURCE_LEAD"/);
  assert.match(promptSource, /MUST appear in[\s\S]*returned Telegram alert/i);
  assert.match(promptSource, /must never demote, reject or silently suppress a HIGH/i);
  assert.match(promptSource, /กำลังตรวจซ้ำจาก primary source/);
});
