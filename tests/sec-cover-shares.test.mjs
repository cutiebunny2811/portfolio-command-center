import assert from "node:assert/strict";
import test from "node:test";
import { coverPageSharesFromHtml, latestPrimaryFilingUrl } from "../supabase/functions/refresh-company-valuation/sec-cover-shares.mjs";

const shareFact = (context, value) => `<ix:nonFraction contextRef="${context}" name="dei:EntityCommonStockSharesOutstanding" unitRef="shares">${value}</ix:nonFraction>`;

test("multi-class cover-page shares are combined when Company Facts omits dimensional facts", () => {
  const html = `${shareFact("class-a", "175,390,967")}${shareFact("class-b", "5,043,789")}`;
  assert.equal(coverPageSharesFromHtml(html), 180_434_756);
});

test("a consolidated cover fact is not added to its component classes twice", () => {
  const html = `${shareFact("all", "180,434,756")}${shareFact("class-a", "175,390,967")}${shareFact("class-b", "5,043,789")}`;
  assert.equal(coverPageSharesFromHtml(html), 180_434_756);
});

test("latest filing URL uses the first eligible current SEC filing", () => {
  const submission = { filings: { recent: {
    form: ["8-K", "10-Q"],
    accessionNumber: ["0000000000-26-000002", "0001193125-26-326090"],
    primaryDocument: ["event.htm", "tem-20260630.htm"],
  } } };
  assert.equal(
    latestPrimaryFilingUrl(submission, "0001717115"),
    "https://www.sec.gov/Archives/edgar/data/1717115/000119312526326090/tem-20260630.htm",
  );
});
