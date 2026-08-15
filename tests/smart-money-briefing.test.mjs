import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const appUrl = new URL("../app.js", import.meta.url);
const apiUrl = new URL("../supabase/functions/portfolio-agent-api/index.ts", import.meta.url);
const migrationUrl = new URL("../supabase/migrations/20260816030000_smart_money_weekly_briefs.sql", import.meta.url);
const readerRouteMigrationUrl = new URL("../supabase/migrations/20260816050000_smart_money_brief_reader_route.sql", import.meta.url);
const promptUrl = new URL("../hermes-mcp/BRIEFING_PROMPTS.md", import.meta.url);
const stylesUrl = new URL("../styles.css", import.meta.url);

test("weekly Smart Money publications are shared, deduplicated and freshness guarded", async () => {
  const [app, api, migration, readerRouteMigration, prompt, styles] = await Promise.all([
    readFile(appUrl, "utf8"),
    readFile(apiUrl, "utf8"),
    readFile(migrationUrl, "utf8"),
    readFile(readerRouteMigrationUrl, "utf8"),
    readFile(promptUrl, "utf8"),
    readFile(stylesUrl, "utf8"),
  ]);

  assert.match(migration, /create table if not exists public\.smart_money_briefs/);
  assert.match(migration, /prior_key = any\(p_reported_event_keys\)/);
  assert.match(migration, /limited to one edition per week/);
  assert.match(migration, /between 1 and 5000/);
  assert.match(migration, /Smart Money source is stale; publication refused/);
  assert.match(migration, /'smart_money_brief', 'Smart Money Brief'/);
  assert.match(readerRouteMigration, /new\.route := 'smart-money-briefs'/);
  assert.match(api, /async function smartMoneyBriefingContext/);
  assert.match(api, /previously_reported_in_window/);
  assert.match(api, /If new_event_count is zero, do not publish and do not notify/);
  assert.match(api, /already-reported or unavailable event keys/);
  assert.match(api, /newRows\.slice\(0, 5000\)/);
  assert.match(api, /const detailLimit = 36/);
  assert.match(api, /addDetailRows\(rowsForCode\("P"\), 20\)/);
  assert.match(api, /addDetailRows\(diversifyByInstrument\(rowsForCode\("S"\)\), 12\)/);
  assert.match(api, /Compact stratified fact pack of up to 36 rows/);
  assert.match(api, /content\.\$\{key\}\[\$\{index\}\]\.detail`, 2400/);
  assert.match(api, /includeAvailableKeys \? \{ available_event_keys/);
  assert.match(api, /const inferredSources = new Map/);
  assert.match(api, /sources: \[\.\.\.sourceMap\.values\(\)\]/);
  assert.match(api, /const eventRef = `SM\$\{String\(index \+ 1\)\.padStart\(2, "0"\)\}`/);
  assert.match(api, /actual_event_key: smartMoneyEventKey\(row\)/);
  assert.match(api, /const normalizedHeadline = rawHeadline\.length > 180/);
  assert.match(api, /const sourceIds = unique\(eventRefs/);
  assert.match(api, /body\.idempotency_key \|\| `smart-money-brief:\$\{reportDate\}`/);
  assert.match(prompt, /เช่น SM01, SM02/);
  assert.match(prompt, /ห้ามย่อเหลือเพียงหุ้นซื้อหนึ่งตัวและหุ้นขายหนึ่งตัว/);
  assert.match(prompt, /include every decision-relevant code-P ticker up to 8/);
  assert.match(prompt, /ห้ามเพิ่ม Stella take หรือ/);
  assert.match(prompt, /maximum\s+180 characters including spaces/);
  assert.match(prompt, /detail ของแต่ละ item ต้องไม่เกิน 1,200/);
  assert.match(prompt, /เป็น 3-5 บรรทัดสั้นด้วย newline แบบ Telegram/);
  assert.match(prompt, /ห้ามตอบเพียงว่า\s*publish สำเร็จ/);
  assert.match(app, /notice\.notification_type === "smart_money_brief" \? "SMART"/);
  assert.match(app, /id="smart-money-brief"/);
  assert.match(app, /The filings,<br>without the noise\./);
  assert.match(app, /class="smart-report__masthead-deck"/);
  assert.match(app, /30 DAYS · NO RERUNS/);
  assert.match(app, /🟢 ซื้อจริงที่น่าสนใจ/);
  assert.match(app, /🔴 ขายจริงที่ต้องรู้/);
  assert.match(app, /⚪ ตัดเสียงรบกวน/);
  assert.match(app, /🚩 Worth watching/);
  assert.doesNotMatch(app, /🧭 Stella take/);
  assert.match(styles, /\.smart-report__masthead-deck .*line-height: 1\.65/);
  assert.match(styles, /\.smart-report__item p .*font-size: 16px/);
});
