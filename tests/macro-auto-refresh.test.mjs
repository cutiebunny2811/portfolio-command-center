import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("Macro refreshes stale and newly released data without a manual click", () => {
  assert.match(app, /function macroNeedsSync\(\)/);
  assert.match(app, /Date\.now\(\) - lastSync >= 5 \* 60_000/);
  assert.match(app, /state\.route === "macro" && macroNeedsSync\(\)/);
  assert.match(app, /if \(state\.route === "macro"\) await loadMacroPage\(\)/);
  assert.match(app, /state\.route === "macro" && macroNeedsSync\(\)\) void syncMacroCalendar\(\)/);
  assert.match(app, /}, 2 \* 60_000\);/);
});
