import assert from "node:assert/strict";
import test from "node:test";
import portfolioMath from "../portfolio-math.js";

test("mixed portfolios allocate stocks by market value and options by maximum loss", () => {
  const instruments = new Map([
    ["stock", { asset_type: "stock", multiplier: 1 }],
    ["option", { asset_type: "option", multiplier: 100 }],
  ]);
  const prices = new Map([["stock", { price: 120 }], ["option", { price: 3 }]]);
  const value = portfolioMath.portfolioValuation({
    portfolio: { portfolio_mode: "mixed" },
    cash: 200,
    instrumentsById: instruments,
    pricesById: prices,
    positions: [
      { instrument_id: "stock", quantity: 5, cost_basis: 500 },
      { instrument_id: "option", quantity: 1, cost_basis: 250, maximum_loss: 260 },
    ],
  });

  assert.equal(value.costBasis, 750);
  assert.equal(value.marketValue, 900);
  assert.equal(value.allocationDeployed, 860);
  assert.equal(value.allocationCapital, 1060);
  assert.equal(value.cashPercent, 200 / 950 * 100);
  assert.equal(value.maximumLossBasis, true);
});

test("cash percent uses actual remaining cash against displayed total capital", () => {
  const value = portfolioMath.portfolioValuation({
    portfolio: { portfolio_mode: "mixed" },
    cash: 61.92,
    positions: [{ instrument_id: "stock", quantity: 1, cost_basis: 2836.46 }],
    instrumentsById: new Map([["stock", { asset_type: "stock", multiplier: 1 }]]),
    pricesById: new Map(),
  });

  assert.equal(value.bookCapital, 2898.38);
  assert.ok(Math.abs(value.cashPercent - (61.92 / 2898.38 * 100)) < 1e-12);
});

test("a zero option close is a real market price instead of a cost-basis fallback", () => {
  const value = portfolioMath.portfolioValuation({
    portfolio: { portfolio_mode: "mixed" },
    cash: 20,
    positions: [{ instrument_id: "option", quantity: 2, cost_basis: 71.27, maximum_loss: 71.27 }],
    instrumentsById: new Map([["option", { asset_type: "option", multiplier: 100 }]]),
    pricesById: new Map([["option", { price: 0, source: "massive_eod" }]]),
  });

  assert.equal(value.marketValue, 0);
  assert.equal(value.currentEquity, 20);
  assert.equal(value.returnAmount, -71.27);
});
