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
    net_income_ttm: 12_000_000,
    gross_profit_ttm: 45_000_000,
    free_cash_flow_ttm: 10_000_000,
    cash: 30_000_000,
    debt: 5_000_000,
    shares_outstanding: 20_000_000,
    stockholders_equity: 80_000_000,
    period_basis: "TTM",
    sec_form: "10-Q",
    sec_filed_at: "2026-08-10",
    ...overrides,
  };
}

function source() {
  return [{ title: "10-Q filed 2026-08-10", form: "10-Q", date: "2026-08-10", url: "https://www.sec.gov/example" }];
}

function forwardPacket(overrides = {}) {
  return {
    model_family: "normalized_dcf",
    company_stage: "CASH-GENERATIVE",
    evidence_quality: "HIGH",
    basis: "LATEST 10-Q",
    rationale: "Forward revenue and normalized cash conversion are supported by the latest filing.",
    as_of: "2026-08-10",
    balance_adjustments: [],
    diluted_shares: 21_000_000,
    revenue_year_1: 115_000_000,
    fcf_margin_year_1: 0.11,
    fcf_margin_year_5: 0.14,
    scenarios: [
      { key: "bear", revenue_year_1: 105_000_000, revenue_growth: 0.04, fcf_margin_year_1: 0.08, fcf_margin_year_5: 0.1, wacc: 0.12, terminal_growth: 0.015, diluted_shares: 22_000_000 },
      { key: "base", revenue_year_1: 115_000_000, revenue_growth: 0.1, fcf_margin_year_1: 0.11, fcf_margin_year_5: 0.14, wacc: 0.1, terminal_growth: 0.025, diluted_shares: 21_000_000 },
      { key: "bull", revenue_year_1: 125_000_000, revenue_growth: 0.16, fcf_margin_year_1: 0.13, fcf_margin_year_5: 0.18, wacc: 0.085, terminal_growth: 0.03, diluted_shares: 20_500_000 },
    ],
    sources: source(),
    risks: ["Margin normalization may take longer than the five-year model."],
    ...overrides,
  };
}

test("cash generators use a sourced normalized forward DCF", () => {
  const result = buildValuation({ fundamentals: baseFacts(), forward: forwardPacket(), market: { price: 12 } });
  assert.equal(result.model_version, "forward-intrinsic-v3");
  assert.equal(result.model, "NORMALIZED FORWARD DCF");
  assert.equal(result.confidence, "HIGH");
  assert.deepEqual(result.scenarios.map((item) => item.key), ["bear", "base", "bull"]);
  assert.ok(result.scenarios[0].fair_value < result.scenarios[1].fair_value);
  assert.ok(result.scenarios[1].fair_value < result.scenarios[2].fair_value);
  assert.equal(result.forward.sources.length, 1);
});

test("loss-making companies can use a revenue-to-FCF transition model", () => {
  const result = buildValuation({
    fundamentals: baseFacts({ net_income_ttm: -15_000_000, free_cash_flow_ttm: -20_000_000 }),
    forward: forwardPacket({
      model_family: "transition_dcf",
      company_stage: "LOSS-MAKING SCALE-UP",
      fcf_margin_year_1: -0.12,
      scenarios: [
        { key: "bear", revenue_year_1: 105_000_000, revenue_growth: 0.03, fcf_margin_year_1: -0.18, fcf_margin_year_5: 0.03, wacc: 0.16, terminal_growth: 0.01, diluted_shares: 24_000_000 },
        { key: "base", revenue_year_1: 120_000_000, revenue_growth: 0.14, fcf_margin_year_1: -0.12, fcf_margin_year_5: 0.1, wacc: 0.13, terminal_growth: 0.02, diluted_shares: 23_000_000 },
        { key: "bull", revenue_year_1: 135_000_000, revenue_growth: 0.24, fcf_margin_year_1: -0.08, fcf_margin_year_5: 0.18, wacc: 0.1, terminal_growth: 0.03, diluted_shares: 22_000_000 },
      ],
    }),
    market: { price: 8 },
  });
  assert.equal(result.model, "LONG-HORIZON TRANSITION DCF");
  assert.equal(result.stage, "LOSS-MAKING SCALE-UP");
  assert.ok(result.scenarios[2].fair_value > result.scenarios[1].fair_value);
});

test("financial companies use a forward excess-return model", () => {
  const result = buildValuation({
    fundamentals: baseFacts({ sic: 6022, stockholders_equity: 160_000_000 }),
    forward: forwardPacket({
      model_family: "excess_return",
      company_stage: "FINANCIAL",
      scenarios: [
        { key: "bear", roe: 0.08, cost_of_equity: 0.12, payout_ratio: 0.4, terminal_growth: 0.015 },
        { key: "base", roe: 0.13, cost_of_equity: 0.1, payout_ratio: 0.35, terminal_growth: 0.025 },
        { key: "bull", roe: 0.18, cost_of_equity: 0.085, payout_ratio: 0.3, terminal_growth: 0.03 },
      ],
    }),
    market: { price: 10 },
  });
  assert.equal(result.model, "FORWARD EXCESS RETURN");
  assert.ok(result.scenarios[0].fair_value < result.scenarios[1].fair_value);
  assert.ok(result.scenarios[1].fair_value < result.scenarios[2].fair_value);
});

test("forward intrinsic values never change with the current quote", () => {
  const lowQuote = buildValuation({ fundamentals: baseFacts(), forward: forwardPacket(), market: { price: 4 } });
  const highQuote = buildValuation({ fundamentals: baseFacts(), forward: forwardPacket(), market: { price: 40 } });
  assert.deepEqual(lowQuote.scenarios, highQuote.scenarios);
  assert.notEqual(lowQuote.market.upside_to_base_percent, highQuote.market.upside_to_base_percent);
});

test("extracted forward revenue cannot silently fall below the reported SEC base", () => {
  const lowRevenueScenarios = forwardPacket().scenarios.map((scenario) => ({
    ...scenario,
    revenue_year_1: 10_000_000,
  }));
  const result = buildValuation({
    fundamentals: baseFacts({ revenue_ttm: 100_000_000 }),
    forward: forwardPacket({ revenue_year_1: 10_000_000, scenarios: lowRevenueScenarios }),
    market: { price: 12 },
  });

  assert.equal(result.scenarios[0].inputs.revenue_year_1, 80_000_000);
  assert.equal(result.scenarios[1].inputs.revenue_year_1, 95_000_000);
  assert.equal(result.scenarios[2].inputs.revenue_year_1, 105_000_000);
  assert.match(result.warnings.join(" "), /anchored to the latest reported SEC revenue/);
});

test("the model rejects unsourced assumptions", () => {
  assert.throws(
    () => buildValuation({ fundamentals: baseFacts(), forward: forwardPacket({ sources: [] }), market: { price: 10 } }),
    /verifiable filing source/,
  );
});

test("known dilution is modeled and surfaced as a warning", () => {
  const result = buildValuation({
    fundamentals: baseFacts(),
    forward: forwardPacket({ diluted_shares: 30_000_000 }),
    market: { price: 10 },
  });
  assert.equal(result.metrics.diluted_shares, 30_000_000);
  assert.match(result.warnings.join(" "), /Known dilution/);
});

test("transition companies retain a visible upside case when year five FCF is still negative", () => {
  const result = buildValuation({
    fundamentals: baseFacts({
      revenue_ttm: 171_400_000,
      net_income_ttm: -220_000_000,
      free_cash_flow_ttm: -180_000_000,
      cash: 410_700_000,
      debt: 620_600_000,
      shares_outstanding: 364_200_000,
    }),
    forward: forwardPacket({
      model_family: "transition_dcf",
      company_stage: "LOSS-MAKING GROWTH",
      diluted_shares: 364_200_000,
      scenarios: [
        { key: "bear", revenue_year_1: 171_400_000, revenue_growth: 0.05, fcf_margin_year_1: -0.4, fcf_margin_year_5: -0.1, wacc: 0.16, terminal_growth: 0.01, diluted_shares: 400_000_000 },
        { key: "base", revenue_year_1: 171_400_000, revenue_growth: 0.1, fcf_margin_year_1: -0.35, fcf_margin_year_5: -0.05, wacc: 0.12, terminal_growth: 0.02, diluted_shares: 380_000_000 },
        { key: "bull", revenue_year_1: 180_000_000, revenue_growth: 0.15, fcf_margin_year_1: -0.3, fcf_margin_year_5: 0, wacc: 0.1, terminal_growth: 0.025, diluted_shares: 364_200_000 },
      ],
    }),
    market: { price: 3.8 },
  });

  assert.equal(result.assumptions.horizon_years, 10);
  assert.ok(result.scenarios.some((row) => row.fair_value > 0));
  assert.ok(result.scenarios[2].fair_value >= result.scenarios[1].fair_value);
  assert.match(result.warnings.join(" "), /long-run FCF margin floor/);
});

test("SEC liquid assets and sourced balance adjustments override generated cash totals", () => {
  const result = buildValuation({
    fundamentals: baseFacts({ cash: 650_000_000, short_term_investments: 740_000_000, debt: 300_000 }),
    forward: forwardPacket({
      adjusted_cash: 1_400_000,
      adjusted_debt: 1_300,
      balance_adjustments: [
        { kind: "cash_outflow", amount: 325_000_000, description: "Closed acquisitions" },
        { kind: "unsupported", amount: 900_000_000 },
      ],
    }),
    market: { price: 8.7 },
  });

  assert.equal(result.metrics.liquid_assets, 1_390_000_000);
  assert.equal(result.metrics.adjusted_cash, 1_065_000_000);
  assert.equal(result.metrics.adjusted_debt, 300_000);
  assert.equal(result.metrics.balance_adjustments.length, 1);
});

test("inconsistent generated scenarios are normalized or enveloped instead of failing the page", () => {
  const result = buildValuation({
    fundamentals: baseFacts(),
    forward: forwardPacket({
      scenarios: [
        { key: "bear", revenue_year_1: 130_000_000, revenue_growth: 0.2, fcf_margin_year_1: 0.2, fcf_margin_year_5: 0.25, wacc: 0.08, terminal_growth: 0.03, diluted_shares: 20_000_000 },
        { key: "base", revenue_year_1: 115_000_000, revenue_growth: 0.1, fcf_margin_year_1: 0.11, fcf_margin_year_5: 0.14, wacc: 0.1, terminal_growth: 0.025, diluted_shares: 21_000_000 },
        { key: "bull", revenue_year_1: 100_000_000, revenue_growth: 0.02, fcf_margin_year_1: 0.05, fcf_margin_year_5: 0.08, wacc: 0.15, terminal_growth: 0.01, diluted_shares: 24_000_000 },
      ],
    }),
    market: { price: 145 },
  });

  assert.deepEqual(result.scenarios.map((row) => row.key), ["bear", "base", "bull"]);
  assert.ok(result.scenarios[0].fair_value <= result.scenarios[1].fair_value);
  assert.ok(result.scenarios[1].fair_value <= result.scenarios[2].fair_value);
});
