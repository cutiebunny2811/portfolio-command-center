import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildMassiveOptionTicker,
  latestOptionEodQuote,
  shouldRecordOptionEod,
} from "../supabase/functions/refresh-stock-prices/option-eod.mjs";

const edgeFunction = readFileSync(new URL("../supabase/functions/refresh-stock-prices/index.ts", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("PCC option fields produce a Massive OCC ticker", () => {
  assert.equal(buildMassiveOptionTicker({
    symbol: "EOSE",
    underlying_symbol: "EOSE",
    option_type: "call",
    strike: 4.5,
    expiry: "2026-09-04",
  }), "O:EOSE260904C00004500");
  assert.equal(buildMassiveOptionTicker({
    symbol: "ONDS",
    option_type: "put",
    strike: 8.5,
    expiry: "2026-08-07",
  }), "O:ONDS260807P00008500");
});

test("EOD parser chooses the newest valid daily close", () => {
  assert.deepEqual(latestOptionEodQuote({ results: [
    { c: 0.31, t: Date.parse("2026-08-12T04:00:00Z") },
    { c: 0.42, t: Date.parse("2026-08-13T04:00:00Z") },
  ] }), { price: 0.42, marketTime: "2026-08-13T04:00:00.000Z" });
});

test("an older EOD close cannot overwrite a newer manual observation", () => {
  const quote = { price: 0.42, marketTime: "2026-08-13T04:00:00.000Z" };
  assert.equal(shouldRecordOptionEod({ source: "manual", market_time: "2026-08-14T01:00:00Z" }, quote), false);
  assert.equal(shouldRecordOptionEod({ source: "manual", market_time: "2026-08-12T01:00:00Z" }, quote), true);
});

test("Massive option pricing is server-gated to one configured owner", () => {
  assert.match(edgeFunction, /OPTIONS_EOD_OWNER_USER_ID/);
  assert.match(edgeFunction, /authenticatedUserId === optionOwnerUserId/);
  assert.match(edgeFunction, /item\.asset_type === "option" && openPositionIds\.has\(item\.id\)/);
  assert.match(edgeFunction, /optionEodRequestLimit = 4/);
  assert.match(edgeFunction, /p_source: "massive_eod"/);
});

test("portfolio UI distinguishes owner EOD pricing from the manual fallback", () => {
  assert.match(app, /options EOD · manual fallback/);
  assert.match(app, /options use manual prices/);
  assert.match(app, /Massive EOD/);
});
