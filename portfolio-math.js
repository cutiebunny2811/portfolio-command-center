(function attachPortfolioMath(root, factory) {
  const api = factory();
  root.PCCPortfolioMath = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createPortfolioMath() {
  "use strict";

  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

  function isOption(instrument) {
    return String(instrument?.asset_type || "").toLowerCase() === "option";
  }

  function positionCostBasis(position) {
    return number(position?.cost_basis);
  }

  function positionMarketValue(position, instrument, priceRecord) {
    const quantity = number(position?.quantity);
    const rawMarketPrice = Number(priceRecord?.price);
    const hasMarketPrice = Boolean(priceRecord) && Number.isFinite(rawMarketPrice) && rawMarketPrice >= 0;
    const marketPrice = hasMarketPrice ? rawMarketPrice : 0;
    const multiplier = number(instrument?.multiplier) || 1;
    if (quantity > 0 && hasMarketPrice) return quantity * marketPrice * multiplier;
    return number(position?.cost_basis);
  }

  function positionAllocationValue(position, instrument, priceRecord) {
    if (isOption(instrument)) return number(position?.maximum_loss || position?.cost_basis);
    return positionMarketValue(position, instrument, priceRecord);
  }

  function portfolioValuation({ portfolio, positions = [], instrumentsById = new Map(), pricesById = new Map(), cash = 0 }) {
    const activePositions = positions.filter((position) => number(position?.quantity) > 0);
    const cashBalance = number(cash);
    let costBasis = 0;
    let marketValue = 0;
    let allocationDeployed = 0;

    activePositions.forEach((position) => {
      const instrument = instrumentsById.get(position.instrument_id);
      const priceRecord = pricesById.get(position.instrument_id);
      costBasis += positionCostBasis(position);
      marketValue += positionMarketValue(position, instrument, priceRecord);
      allocationDeployed += positionAllocationValue(position, instrument, priceRecord);
    });

    const bookCapital = Math.max(cashBalance + costBasis, 0);
    const currentEquity = cashBalance + marketValue;
    const allocationCapital = Math.max(cashBalance + allocationDeployed, 0);
    const utilization = allocationCapital > 0 ? allocationDeployed / allocationCapital * 100 : 0;
    const cashPercent = bookCapital > 0 ? Math.max(cashBalance, 0) / bookCapital * 100 : 0;
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
      cashPercent,
      returnAmount,
      returnPercent,
      maximumLossBasis: activePositions.some((position) => isOption(instrumentsById.get(position.instrument_id)))
    };
  }

  return {
    isOption,
    positionCostBasis,
    positionMarketValue,
    positionAllocationValue,
    portfolioValuation
  };
});
