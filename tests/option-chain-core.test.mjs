import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseExpiry,
  expirationChoices,
  isStandardOptionContract,
  mergeOptionChain,
  nearestContracts,
  normalizeOptionContract,
  normalizeOptionSnapshot,
} from "../supabase/functions/refresh-stock-prices/option-chain-core.mjs";

test("normalizes Webull option contracts without inventing missing fields", () => {
  assert.deepEqual(normalizeOptionContract({
    instrument_id: "470059643",
    symbol: "AAPL260522C00300000",
    underlying_symbol: "AAPL",
    expiration_date: "2026-05-22",
    option_type: "CALL",
    strike_price: "300.0",
    contract_multiplier: "100",
  }), {
    instrument_id: "470059643",
    symbol: "AAPL260522C00300000",
    underlying_symbol: "AAPL",
    expiry: "2026-05-22",
    option_type: "call",
    strike: 300,
    multiplier: 100,
    style: null,
    status: null,
  });
  assert.equal(normalizeOptionContract({ symbol: "broken" }), null);
});

test("normalizes OPRA quotes and preserves zero greeks", () => {
  const quote = normalizeOptionSnapshot({
    symbol: "AAPL260522P00300000",
    bid: "9.05",
    ask: "9.30",
    price: "9.05",
    delta: "-0.3189",
    gamma: "0.0071",
    theta: "-0.0718",
    vega: "0.4656",
    imp_vol: "0.3848",
    volume: "338",
    open_interest: "19169",
    quote_time: 1786996799000,
  });
  assert.equal(quote.bid, 9.05);
  assert.equal(quote.ask, 9.3);
  assert.equal(quote.implied_volatility, 0.3848);
  assert.equal(quote.open_interest, 19169);
  assert.match(quote.quote_time, /^2026-/);
});

test("builds expiration choices and limits a chain to the nearest 20 contracts", () => {
  const contracts = Array.from({ length: 30 }, (_, index) => ({
    symbol: `NVDA-${index}`,
    expiry: index % 2 ? "2026-09-18" : "2026-08-28",
    option_type: "call",
    strike: 100 + index * 5,
  }));
  const expiries = expirationChoices(contracts, "2026-08-20");
  assert.deepEqual(expiries.map((item) => item.value), ["2026-08-28", "2026-09-18"]);
  assert.equal(chooseExpiry(expiries, "2026-09-18"), "2026-09-18");
  const selected = nearestContracts(contracts, { expiry: "2026-09-18", optionType: "call", spot: 168, limit: 20 });
  assert.equal(selected.length, 15);
  assert.deepEqual([...selected].sort((a, b) => a.strike - b.strike), selected);
});

test("rejects adjusted option roots that the OPRA snapshot endpoint cannot quote", () => {
  assert.equal(isStandardOptionContract({ symbol: "NVDA260828C00215000", underlying_symbol: "NVDA" }, "NVDA"), true);
  assert.equal(isStandardOptionContract({ symbol: "2NVDA260828C00215000", underlying_symbol: "NVDA" }, "NVDA"), false);
  assert.equal(isStandardOptionContract({ symbol: "BRKB260828P00400000", underlying_symbol: "BRK.B" }, "BRK.B"), true);
});

test("merges contract metadata with OPRA snapshots and computes a valid midpoint", () => {
  const rows = mergeOptionChain([
    { symbol: "NVDA260918C00180000", strike: 180 },
  ], [
    { symbol: "NVDA260918C00180000", bid: 4.2, ask: 4.6, last: 4.4 },
  ]);
  assert.equal(rows[0].mid, 4.4);
});
