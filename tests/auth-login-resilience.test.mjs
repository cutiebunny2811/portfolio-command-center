import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appUrl = new URL("../app.js", import.meta.url);
const indexUrl = new URL("../index.html", import.meta.url);

test("login recovers when the Supabase Auth request stalls", async () => {
  const app = await readFile(appUrl, "utf8");
  const index = await readFile(indexUrl, "utf8");

  assert.match(app, /Promise\.race\(\[/);
  assert.match(app, /AUTH_REQUEST_TIMEOUT/);
  assert.match(app, /20_000/);
  assert.match(app, /window\.clearTimeout\(timeoutId\)/);
  assert.match(app, /button\.disabled = false; button\.textContent = "Enter dashboard"/);
  assert.match(app, /PGRST002\|Could not query the database for the schema cache/);
  assert.match(app, /PCC data service is restarting\. Wait a moment and try again\./);
  assert.doesNotMatch(app, /api_create_journal_entry\|schema cache/);
  assert.match(index, /app\.js\?v=20261107-auth-recovery/);
});
