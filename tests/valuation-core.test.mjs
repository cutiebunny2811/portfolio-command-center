import assert from "node:assert/strict";
import test from "node:test";
import { buildValuation } from "../supabase/functions/refresh-company-valuation/valuation-core.mjs";

function baseFacts(overrides = {}) {
  return {
    symbol: "TEST",
    company_name: "Test Company",
    revenue_ttm: 100_000_000,
    revenue_fy: 90_000_000,
    revenue_growth: 0.2,
    net_income_ttm: -12_000_000,
    operating_income_ttm: -8_000_000,
    gross_profit_ttm: 45_000_000,
    free_cash_flow_ttm: -10_000_000,
    cash: 30_000_000,
    debt: 5_000_000,
    shares_outstanding: 20_000_000,
    period_basis: "TTM",
    sec_form: "10-Q",
    sec_filed_at: "2026-08-10",
    ...overrides,
  };
}

test("loss-making growth companies use EV/Sales instead of P/E", () => {
  const result = buildValuation({ fundamentals: baseFacts(), market: { price: 8 } });
  assert.equal(result.model, "EV / SALES");
  assert.equal(result.stage, "LOSS-MAKING GROWTH");
  assert.deepEqual(result.scenarios.map((item) => item.key), ["bear", "base", "bull"]);
  assert.ok(result.scenarios.every((item) => Number.isFinite(item.fair_value)));
  assert.ok(result.scenarios[0].fair_value < result.scenarios[1].fair_value);
  assert.ok(result.scenarios[1].fair_value < result.scenarios[2].fair_value);
  assert.match(result.warnings.join(" "), /P\/E disabled/);
});

test("positive earnings and free cash flow route to DCF", () => {
  const result = buildValuation({
    fundamentals: baseFacts({
      net_income_ttm: 18_000_000,
      operating_income_ttm: 22_000_000,
      free_cash_flow_ttm: 15_000_000,
    }),
    market: { price: 12 },
  });
  assert.equal(result.model, "FCF DCF");
  assert.equal(result.stage, "CASH-GENERATIVE");
  assert.equal(result.scenarios.length, 3);
});

test("financial companies use book value and ROE", () => {
  const result = buildValuation({
    fundamentals: baseFacts({
      sic: 6022,
      sic_description: "State commercial banks",
      net_income_ttm: 24_000_000,
      stockholders_equity: 160_000_000,
      free_cash_flow_ttm: -2_000_000,
    }),
    market: { price: 10 },
  });
  assert.equal(result.model, "P-B / ROE");
  assert.equal(result.stage, "FINANCIAL");
});

test("canonical fair values do not change with the current market quote", () => {
  const lowQuote = buildValuation({ fundamentals: baseFacts(), market: { price: 4 } });
  const highQuote = buildValuation({ fundamentals: baseFacts(), market: { price: 40 } });
  assert.deepEqual(lowQuote.scenarios, highQuote.scenarios);
  assert.notEqual(lowQuote.market.upside_to_base_percent, highQuote.market.upside_to_base_percent);
});

test("a debt-heavy bear case floors equity value without dropping the range", () => {
  const result = buildValuation({
    fundamentals: baseFacts({ debt: 900_000_000, cash: 1_000_000 }),
    market: { price: 1 },
  });
  assert.equal(result.scenarios.length, 3);
  assert.equal(result.scenarios[0].fair_value, 0.01);
});
