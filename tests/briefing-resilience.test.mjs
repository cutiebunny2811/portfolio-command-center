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
  assert.match(compact, /LIMITED SOURCES edition/);
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
});
