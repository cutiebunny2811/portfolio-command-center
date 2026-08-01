(function attachPortfolioMath(root, factory) {
  const api = factory();
  root.PCCPortfolioMath = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createPortfolioMath() {
  "use strict";

  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

  function usesMaximumLossBasis(portfolio) {
    return portfolio?.allocation_basis === "maximum_loss"
      || portfolio?.portfolio_mode === "options"
      || portfolio?.kind === "options";
  }

  function positionCostBasis(position, portfolio) {
    return usesMaximumLossBasis(portfolio)
      ? number(position?.maximum_loss)
      : number(position?.cost_basis);
  }

  function positionMarketValue(position, instrument, priceRecord) {
    const quantity = number(position?.quantity);
    const marketPrice = number(priceRecord?.price);
    const multiplier = number(instrument?.multiplier) || 1;
    if (quantity > 0 && marketPrice > 0) return quantity * marketPrice * multiplier;
    return number(position?.cost_basis);
  }

  function positionAllocationValue(position, instrument, priceRecord, portfolio) {
    if (usesMaximumLossBasis(portfolio)) return number(position?.maximum_loss);
    return positionMarketValue(position, instrument, priceRecord);
  }

  function portfolioValuation({ portfolio, positions = [], instrumentsById = new Map(), pricesById = new Map(), cash = 0 }) {
    const activePositions = positions.filter((position) => number(position?.quantity) > 0);
    const cashBalance = number(cash);
    const maximumLossBasis = usesMaximumLossBasis(portfolio);
    let costBasis = 0;
    let marketValue = 0;
    let allocationDeployed = 0;

    activePositions.forEach((position) => {
      const instrument = instrumentsById.get(position.instrument_id);
      const priceRecord = pricesById.get(position.instrument_id);
      costBasis += positionCostBasis(position, portfolio);
      marketValue += positionMarketValue(position, instrument, priceRecord);
      allocationDeployed += positionAllocationValue(position, instrument, priceRecord, portfolio);
    });

    const bookCapital = Math.max(cashBalance + costBasis, 0);
    const currentEquity = cashBalance + marketValue;
    const allocationCapital = maximumLossBasis ? bookCapital : Math.max(currentEquity, 0);
    const utilization = allocationCapital > 0 ? allocationDeployed / allocationCapital * 100 : 0;
    const returnAmount = currentEquity - bookCapital;
    const returnPercent = bookCapital > 0 ? returnAmount / bookCapital * 100 : 0;

    return {
      activePositions,
      cash: cashBalance,
      costBasis,
      bookCapital,
      marketValue,
      currentEquity,
      allocationDeployed,
      allocationCapital,
      utilization,
      returnAmount,
      returnPercent,
      maximumLossBasis
    };
  }

  return {
    usesMaximumLossBasis,
    positionCostBasis,
    positionMarketValue,
    positionAllocationValue,
    portfolioValuation
  };
});
