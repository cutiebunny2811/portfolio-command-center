(function attachFxLedger(root, factory) {
  const api = factory();
  root.PCCFxLedger = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createFxLedger() {
  "use strict";

  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

  function calculate({ profile = null, entries = [], liveRate = 0 } = {}) {
    if (!profile) return null;

    let usdBalance = Math.max(number(profile.opening_usd_balance), 0);
    let thbBasis = Math.max(number(profile.opening_thb_basis), 0);
    let realizedPnl = 0;
    const effectiveAt = new Date(profile.effective_at || 0).getTime();
    const timeline = [];

    entries
      .filter((entry) => entry.portfolio_id === profile.portfolio_id)
      .filter((entry) => new Date(entry.occurred_at).getTime() >= effectiveAt)
      .sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime())
      .forEach((entry) => {
        const usdAmount = Math.max(number(entry.usd_amount), 0);
        const thbAmount = Math.max(number(entry.thb_amount), 0);
        const direction = String(entry.direction || "").toLowerCase();
        const averageBefore = usdBalance > 0 ? thbBasis / usdBalance : 0;
        let entryRealizedPnl = 0;

        if (direction === "withdrawal") {
          const matchedUsd = Math.min(usdAmount, usdBalance);
          const matchedRatio = usdAmount > 0 ? matchedUsd / usdAmount : 0;
          const basisReleased = matchedUsd * averageBefore;
          entryRealizedPnl = thbAmount * matchedRatio - basisReleased;
          usdBalance = Math.max(usdBalance - matchedUsd, 0);
          thbBasis = Math.max(thbBasis - basisReleased, 0);
          realizedPnl += entryRealizedPnl;
        } else {
          usdBalance += usdAmount;
          thbBasis += thbAmount;
        }

        timeline.push({
          ...entry,
          average_before: averageBefore,
          average_after: usdBalance > 0 ? thbBasis / usdBalance : 0,
          realized_pnl: entryRealizedPnl,
          tracked_usd_after: usdBalance,
        });
      });

    const averageRate = usdBalance > 0 ? thbBasis / usdBalance : number(profile.opening_rate);
    const currentRate = number(liveRate);
    const currentThbValue = currentRate > 0 ? usdBalance * currentRate : 0;
    const unrealizedPnl = currentRate > 0 ? currentThbValue - thbBasis : 0;

    return {
      usdBalance,
      thbBasis,
      averageRate,
      currentRate,
      currentThbValue,
      unrealizedPnl,
      unrealizedPercent: thbBasis > 0 ? unrealizedPnl / thbBasis * 100 : 0,
      realizedPnl,
      timeline,
    };
  }

  return { calculate };
});
