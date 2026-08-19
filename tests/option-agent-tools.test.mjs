import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  analyzeOptionDesk,
  selectOptionContract,
} from "../supabase/functions/portfolio-agent-api/option-desk-analysis.mjs";

const callChain = {
  source: "webull_opra",
  quote_mode: "REAL-TIME OPRA",
  fetched_at: "2026-08-20T02:00:00.000Z",
  symbol: "EOSE",
  option_type: "call",
  underlying: { price: 3.45, market_time: "2026-08-20T01:59:59.000Z" },
  contracts: [
    { symbol: "EOSE260828C00002000", strike: 2, bid: 1.47, ask: 1.87, mid: 1.67, multiplier: 100 },
    { symbol: "EOSE260828C00002500", strike: 2.5, bid: 1.01, ask: 1.37, mid: 1.19, multiplier: 100, delta: 0.96 },
    { symbol: "EOSE260828C00003500", strike: 3.5, bid: 0.29, ask: 0.33, mid: 0.31, multiplier: 100 },
  ],
};

const portfolioSnapshot = {
  portfolio: { id: "portfolio-1", name: "Long Term" },
  cash: { cash_balance: 500 },
  instruments: [{ id: "instrument-1", symbol: "EOSE", asset_type: "stock" }],
  positions: [{ instrument_id: "instrument-1", quantity: 120, average_cost: 2 }],
};

test("Option Desk agent analysis preserves fractional strikes and uses the executable side", () => {
  assert.equal(selectOptionContract(callChain, 2.5).symbol, "EOSE260828C00002500");
  const analysis = analyzeOptionDesk(callChain, portfolioSnapshot, { strategy: "long_call", strike: 2.5 });

  assert.equal(analysis.selected_contract.strike, 2.5);
  assert.equal(analysis.quote.reference, "ask");
  assert.equal(analysis.quote.premium_per_contract, 137);
  assert.equal(analysis.quote.liquidity, "WIDE");
  assert.equal(analysis.payoff_at_expiry.maximum_loss, 137);
  assert.equal(analysis.payoff_at_expiry.break_even_underlying, 3.87);
  assert.equal(analysis.payoff_at_expiry.maximum_profit_open, true);
  assert.equal(analysis.eligibility.ready, true);
  assert.equal(analysis.order_sent, false);
});

test("Covered Call analysis checks 100 real portfolio shares and credits the live bid", () => {
  const analysis = analyzeOptionDesk(callChain, portfolioSnapshot, { strategy: "covered_call", strike: 2.5 });

  assert.equal(analysis.quote.reference, "bid");
  assert.equal(analysis.quote.premium_per_contract, 101);
  assert.deepEqual(analysis.collateral, { type: "shares", required: 100, available: 120 });
  assert.equal(analysis.eligibility.ready, true);
  assert.equal(analysis.payoff_at_expiry.maximum_loss, 99);
  assert.equal(analysis.payoff_at_expiry.maximum_profit, 151);
});

test("agent and market-data edges keep live OPRA behind the authenticated subscription owner", () => {
  const agent = readFileSync(new URL("../supabase/functions/portfolio-agent-api/index.ts", import.meta.url), "utf8");
  const market = readFileSync(new URL("../supabase/functions/refresh-stock-prices/index.ts", import.meta.url), "utf8");

  assert.match(agent, /action === "option_chain"/);
  assert.match(agent, /action === "option_analysis"/);
  assert.match(agent, /user_id: userId/);
  assert.match(market, /\["chart", "option_chain"\]\.includes/);
  assert.match(market, /OPTIONS_OPRA_OWNER_USER_ID/);
});
