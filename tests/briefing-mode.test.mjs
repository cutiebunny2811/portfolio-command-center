import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  buildBriefEditorialPolicy,
  briefModeForDate,
} from "../supabase/functions/portfolio-agent-api/briefing-policy.mjs";

const apiUrl = new URL("../supabase/functions/portfolio-agent-api/index.ts", import.meta.url);
const promptUrl = new URL("../hermes-mcp/BRIEFING_PROMPTS.md", import.meta.url);
const serverUrl = new URL("../hermes-mcp/server.mjs", import.meta.url);

test("selects Daily Market Brief on market weekdays and Weekend Outlook on weekends", () => {
  assert.equal(briefModeForDate("2026-08-21"), "daily_market_brief");
  assert.equal(briefModeForDate("2026-08-22"), "weekend_outlook");
  assert.equal(briefModeForDate("2026-08-23"), "weekend_outlook");
  assert.equal(briefModeForDate("2026-08-24"), "daily_market_brief");
});

test("Weekend Outlook keeps the canonical title and exposes 7d, 48h and next-7d windows", () => {
  const policy = buildBriefEditorialPolicy("2026-08-23");

  assert.equal(policy.mode, "weekend_outlook");
  assert.equal(policy.display_title, "Daily Market Brief");
  assert.deepEqual(policy.windows, {
    retrospective_days: 7,
    fresh_news_hours: 48,
    catalyst_days: 7,
  });
  assert.match(policy.editorial_contract, /weekly synthesis/i);
  assert.match(policy.editorial_contract, /never use market closed or no new data as filler/i);
});

test("briefing context returns mode policy, weekly archive, discovery evidence and forward catalysts", async () => {
  const api = await readFile(apiUrl, "utf8");

  assert.match(api, /buildBriefEditorialPolicy/);
  assert.match(api, /news_evidence_packets/);
  assert.match(api, /recent_market_briefs/);
  assert.match(api, /editorial_policy: policy/);
  assert.match(api, /fresh_news_hours/);
  assert.match(api, /catalyst_window/);
  assert.match(api, /addDays\(today, policy\.windows\.catalyst_days\)/);
});

test("publication persists the server-selected editorial mode in source context", async () => {
  const api = await readFile(apiUrl, "utf8");

  assert.match(api, /const policy = buildBriefEditorialPolicy\(briefDate\)/);
  assert.match(api, /editorial_mode: policy\.mode/);
  assert.match(api, /evidence_windows: policy\.windows/);
});

test("Hermes instructions branch by API mode and keep midnight Continuation material-only", async () => {
  const [prompt, server] = await Promise.all([
    readFile(promptUrl, "utf8"),
    readFile(serverUrl, "utf8"),
  ]);
  const compactPrompt = prompt.replace(/\s+/g, " ");
  const compactServer = server.replace(/\s+/g, " ");

  assert.match(compactPrompt, /editorial_policy\.mode/);
  assert.match(compactPrompt, /weekend_outlook/);
  assert.match(compactPrompt, /previous 7 days/);
  assert.match(compactPrompt, /fresh 48-hour reporting/);
  assert.match(compactPrompt, /next 7 calendar days/);
  assert.match(compactPrompt, /Continuation only when material_change is true/);
  assert.match(compactServer, /Weekend Outlook/);
  assert.match(compactServer, /server-selected editorial policy/);
});
