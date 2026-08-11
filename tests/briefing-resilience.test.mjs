import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const promptsUrl = new URL("../hermes-mcp/BRIEFING_PROMPTS.md", import.meta.url);
const apiUrl = new URL("../supabase/functions/portfolio-agent-api/index.ts", import.meta.url);

test("daily brief policy degrades gracefully when live sites block access", async () => {
  const prompts = await readFile(promptsUrl, "utf8");
  const compact = prompts.replace(/\s+/g, " ");

  assert.match(compact, /CAPTCHA, 403 or Access Denied/);
  assert.match(compact, /A blocked website must never be the sole reason/);
  assert.match(compact, /cached_market_news/);
  assert.match(compact, /must never become a Top Story merely to fill a slot/);
  assert.match(compact, /Do not use FRED risk, source failures or the macro calendar as substitute headlines/);
  assert.match(compact, /20:20 Asia\/Bangkok recovery/);
  assert.match(compact, /the 20:20 recovery job owns missing-edition repair/);
  assert.doesNotMatch(compact, /If that evidence is unavailable, do not publish/);
});

test("shared briefing context includes deterministic FRED risk facts", async () => {
  const api = await readFile(apiUrl, "utf8");

  assert.match(api, /\.from\("macro_risk_snapshots"\)/);
  assert.match(api, /action === "macro_risk_monitor"/);
  assert.match(api, /source_resilience:/);
  assert.match(api, /macro_risk: \{/);
  assert.match(api, /cached_market_news: marketNews/);
  assert.match(api, /sharedMarketNews\(service, lookbackHours\)/);
  assert.match(api, /publisher_count: Object\.keys\(publisherCounts\)\.length/);
  assert.match(api, /\.slice\(0, 24\)/);
  assert.match(api, /keywords\.includes\("BRIEF_CANDIDATE"\)/);
  assert.match(api, /action === "refresh_brief_sources"/);
  assert.match(api, /functions\/v1\/sync-research-news/);
  assert.doesNotMatch(api, /\.neq\("source", "x"\)/);
});
