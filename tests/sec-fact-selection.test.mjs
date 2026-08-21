import assert from "node:assert/strict";
import test from "node:test";
import { preferDurationFact } from "../supabase/functions/refresh-company-valuation/sec-fact-selection.mjs";

test("current quarter wins over a same-duration comparative row tagged to the same fiscal year", () => {
  const comparative = { start: "2025-01-01", end: "2025-06-30", filed: "2026-08-05" };
  const current = { start: "2026-01-01", end: "2026-06-30", filed: "2026-08-05" };

  assert.equal(preferDurationFact(current, comparative), true);
  assert.equal(preferDurationFact(comparative, current), false);
});

test("a leap-year comparative period cannot replace the newer fiscal period", () => {
  const comparative = { start: "2024-01-01", end: "2024-12-31", filed: "2026-02-26" };
  const current = { start: "2025-01-01", end: "2025-12-31", filed: "2026-02-26" };

  assert.equal(preferDurationFact(current, comparative), true);
  assert.equal(preferDurationFact(comparative, current), false);
});

test("a cumulative fiscal period wins over a standalone quarter ending on the same day", () => {
  const quarter = { start: "2026-04-01", end: "2026-06-30", filed: "2026-08-05" };
  const yearToDate = { start: "2026-01-01", end: "2026-06-30", filed: "2026-08-05" };

  assert.equal(preferDurationFact(yearToDate, quarter), true);
});
