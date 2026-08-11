import test from "node:test";
import assert from "node:assert/strict";
import {
  X_MONTHLY_POST_HARD_LIMIT,
  X_MONTHLY_POST_TARGET,
  X_POST_READ_USD,
  dueXWindow,
  groupXSubscriptions,
  reutersSearchQuery,
  xBudgetAllowance,
  xSourcePlan,
} from "../supabase/functions/sync-research-news/x-core.mjs";

test("allocates the five-dollar X budget across Reuters and existing News sources", () => {
  assert.equal(X_POST_READ_USD, 0.005);
  assert.equal(X_MONTHLY_POST_TARGET, 900);
  assert.equal(X_MONTHLY_POST_HARD_LIMIT, 1000);
  assert.equal(xSourcePlan("Reuters").monthlyLimit, 600);
  assert.equal(xSourcePlan("@stocksavvyshay").monthlyLimit, 150);
  assert.equal(xSourcePlan("naklongpoong").monthlyLimit, 150);
  assert.equal(X_MONTHLY_POST_TARGET * X_POST_READ_USD, 4.5);
  assert.equal(X_MONTHLY_POST_HARD_LIMIT * X_POST_READ_USD, 5);
});

test("deduplicates shared subscriptions before an X API read", () => {
  const groups = groupXSubscriptions([
    { user_id: "one", source_key: "Reuters" },
    { user_id: "two", source_key: "@reuters" },
    { user_id: "one", source_key: "stocksavvyshay" },
  ]);
  assert.equal(groups.size, 2);
  assert.equal(groups.get("reuters").length, 2);
});

test("opens only the planned Bangkok collection windows", () => {
  assert.equal(dueXWindow("reuters", new Date("2026-08-12T11:30:00Z"), null), null);
  assert.equal(dueXWindow("reuters", new Date("2026-08-12T12:30:00Z"), null), "2026-08-12:brief");
  assert.equal(dueXWindow("reuters", new Date("2026-08-12T16:30:00Z"), "2026-08-12:brief"), "2026-08-12:continuation");
  assert.equal(dueXWindow("reuters", new Date("2026-08-12T16:30:00Z"), "2026-08-12:continuation"), null);
  assert.equal(dueXWindow("reuters", new Date("2026-08-12T17:05:00Z"), "2026-08-12:brief"), "2026-08-12:continuation");
  assert.equal(dueXWindow("reuters", new Date("2026-08-12T17:05:00Z"), "2026-08-12:continuation"), null);
  assert.equal(dueXWindow("stocksavvyshay", new Date("2026-08-12T05:30:00Z"), null), "2026-08-12:news");
});

test("stops each source and the shared collector at its monthly target", () => {
  assert.equal(xBudgetAllowance("reuters", []), 10);
  assert.equal(xBudgetAllowance("reuters", [{ source_key: "reuters", posts_read: 595 }]), 5);
  assert.equal(xBudgetAllowance("reuters", [{ source_key: "reuters", posts_read: 600 }]), 0);
  assert.equal(xBudgetAllowance("reuters", [
    { source_key: "reuters", posts_read: 590 },
    { source_key: "stocksavvyshay", posts_read: 150 },
    { source_key: "naklongpoong", posts_read: 155 },
  ]), 5);
});

test("Reuters search filters high-signal linked originals before billing", () => {
  const query = reutersSearchQuery();
  assert.match(query, /^from:reuters /);
  assert.match(query, /has:links/);
  assert.match(query, /-is:retweet/);
  assert.match(query, /-is:reply/);
  assert.match(query, /Fed/);
  assert.match(query, /oil/);
  assert.match(query, /earnings/);
});
