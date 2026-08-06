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
  assert.equal(value.maximumLossBasis, true);
});
