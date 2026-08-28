import test from "node:test";
import assert from "node:assert/strict";
import {
  X_MONTHLY_POST_HARD_LIMIT,
  X_MONTHLY_POST_TARGET,
  X_POST_READ_USD,
  assessXContent,
  dueXWindow,
  groupXSubscriptions,
  reutersSearchQuery,
  xBudgetAllowance,
  xSourcePlan,
} from "../supabase/functions/sync-research-news/x-core.mjs";
import { readFile } from "node:fs/promises";

const workflowSource = await readFile(
  new URL("../.github/workflows/sync-research-news.yml", import.meta.url),
  "utf8",
);

test("allocates the five-dollar X budget across the market and stock desks", () => {
  assert.equal(X_POST_READ_USD, 0.005);
  assert.equal(X_MONTHLY_POST_TARGET, 900);
  assert.equal(X_MONTHLY_POST_HARD_LIMIT, 1000);
  assert.equal(xSourcePlan("Reuters").monthlyLimit, 460);
  assert.equal(xSourcePlan("@stocksavvyshay").monthlyLimit, 440);
  assert.equal(xSourcePlan("stocksavvyshay").maxResults, 5);
  assert.equal(xSourcePlan("naklongpoong"), null);
  assert.equal(X_MONTHLY_POST_TARGET * X_POST_READ_USD, 4.5);
  assert.equal(X_MONTHLY_POST_HARD_LIMIT * X_POST_READ_USD, 5);
});

test("deduplicates shared subscriptions before an X API read", () => {
  const groups = groupXSubscriptions([
    { user_id: "one", source_key: "Reuters" },
    { user_id: "two", source_key: "@reuters" },
    { user_id: "one", source_key: "stocksavvyshay" },
    { user_id: "one", source_key: "naklongpoong" },
  ]);
  assert.equal(groups.size, 2);
  assert.equal(groups.get("reuters").length, 2);
});

test("opens only the planned Bangkok collection windows", () => {
  assert.match(workflowSource, /cron: "17 10,12,14,16,18,20 \* \* 1-5"/);
  assert.equal(dueXWindow("reuters", new Date("2026-08-12T11:30:00Z"), null), null);
  assert.equal(dueXWindow("reuters", new Date("2026-08-12T12:30:00Z"), null), "2026-08-12:brief");
  assert.equal(dueXWindow("reuters", new Date("2026-08-12T16:30:00Z"), "2026-08-12:brief"), "2026-08-12:continuation");
  assert.equal(dueXWindow("reuters", new Date("2026-08-12T16:30:00Z"), "2026-08-12:continuation"), null);
  assert.equal(dueXWindow("reuters", new Date("2026-08-12T17:05:00Z"), "2026-08-12:brief"), "2026-08-12:continuation");
  assert.equal(dueXWindow("reuters", new Date("2026-08-12T17:05:00Z"), "2026-08-12:continuation"), null);
  assert.equal(dueXWindow("stocksavvyshay", new Date("2026-08-12T10:30:00Z"), null), "2026-08-12:premarket");
  assert.equal(dueXWindow("stocksavvyshay", new Date("2026-08-12T12:30:00Z"), "2026-08-12:premarket"), null);
  assert.equal(dueXWindow("stocksavvyshay", new Date("2026-08-12T14:30:00Z"), "2026-08-12:premarket"), "2026-08-12:open");
  assert.equal(dueXWindow("stocksavvyshay", new Date("2026-08-12T16:30:00Z"), "2026-08-12:open"), null);
  assert.equal(dueXWindow("stocksavvyshay", new Date("2026-08-12T18:30:00Z"), "2026-08-12:open"), "2026-08-13:late");
  assert.equal(dueXWindow("stocksavvyshay", new Date("2026-08-12T20:30:00Z"), "2026-08-13:late"), "2026-08-13:postmarket");
});

test("stops each source and the shared collector at its monthly target", () => {
  assert.equal(xBudgetAllowance("reuters", []), 10);
  assert.equal(xBudgetAllowance("reuters", [{ source_key: "reuters", posts_read: 455 }]), 5);
  assert.equal(xBudgetAllowance("reuters", [{ source_key: "reuters", posts_read: 460 }]), 0);
  assert.equal(xBudgetAllowance("reuters", [
    { source_key: "reuters", posts_read: 410 },
    { source_key: "stocksavvyshay", posts_read: 485 },
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

test("Reuters keeps market-moving reports and rejects unrelated reporting", () => {
  const market = assessXContent("reuters", {
    text: "Wall Street futures rise 0.4% as CPI cools and Treasury yields fall",
  });
  const filler = assessXContent("reuters", {
    text: "A regional court opens a new investigation into a local election",
  });
  assert.deepEqual(market, { keep: true, alertLevel: "HIGH", desk: "MARKET_DESK" });
  assert.equal(filler.keep, false);
});

test("StockSavvyShay keeps ticker-backed company intelligence", () => {
  const contract = assessXContent("stocksavvyshay", {
    text: "$IREN delivered a 50MW facility to $MSFT under a $9.7B contract",
    tickers: ["IREN", "MSFT"],
  });
  const product = assessXContent("stocksavvyshay", {
    text: "$GOOGL introduced a lower-priced AI model with a 44% benchmark score",
    tickers: ["GOOGL"],
  });
  const chatter = assessXContent("stocksavvyshay", {
    text: "Another exciting day for technology",
    tickers: [],
  });
  assert.equal(contract.alertLevel, "HIGH");
  assert.equal(product.alertLevel, "MEDIUM");
  assert.equal(chatter.keep, false);
});
