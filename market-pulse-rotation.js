(function attachMarketPulseRotation(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.marketPulseRotation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createMarketPulseRotation() {
  "use strict";

  const sectors = [
    { symbol: "XLK", name: "Technology", group: "growth" },
    { symbol: "XLC", name: "Communication Services", group: "growth" },
    { symbol: "XLY", name: "Consumer Discretionary", group: "growth" },
    { symbol: "XLP", name: "Consumer Staples", group: "defensive" },
    { symbol: "XLE", name: "Energy", group: "cyclical" },
    { symbol: "XLF", name: "Financials", group: "cyclical" },
    { symbol: "XLV", name: "Health Care", group: "defensive" },
    { symbol: "XLI", name: "Industrials", group: "cyclical" },
    { symbol: "XLB", name: "Materials", group: "cyclical" },
    { symbol: "XLRE", name: "Real Estate", group: "defensive" },
    { symbol: "XLU", name: "Utilities", group: "defensive" }
  ];
  const windows = [
    { key: "return_1w", label: "1W", weight: .20 },
    { key: "return_1m", label: "1M", weight: .35 },
    { key: "return_3m", label: "3M", weight: .30 },
    { key: "return_6m", label: "6M", weight: .15 }
  ];

  function finite(value) {
    if (value == null || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function weightedAverage(entries) {
    const valid = entries.filter((entry) => finite(entry.value) != null && entry.weight > 0);
    const weight = valid.reduce((sum, entry) => sum + entry.weight, 0);
    if (!weight) return null;
    return valid.reduce((sum, entry) => sum + finite(entry.value) * entry.weight, 0) / weight;
  }

  function percentileMap(rows, key) {
    const ordered = rows
      .map((row) => ({ symbol: row.symbol, value: finite(row.relative[key]) }))
      .filter((row) => row.value != null)
      .sort((a, b) => a.value - b.value);
    const result = new Map();
    if (ordered.length === 1) {
      result.set(ordered[0].symbol, 50);
      return result;
    }
    ordered.forEach((row) => {
      const tied = ordered.map((item, index) => item.value === row.value ? index : -1).filter((index) => index >= 0);
      const averageIndex = tied.reduce((sum, index) => sum + index, 0) / tied.length;
      result.set(row.symbol, averageIndex / (ordered.length - 1) * 100);
    });
    return result;
  }

  function buildSectorRotation(sourceRows) {
    const bySymbol = new Map((sourceRows || []).map((row) => [String(row.symbol || "").toUpperCase(), row]));
    const spy = bySymbol.get("SPY");
    if (!spy) return { rows: [], baseline: null, windows, sectors };

    const rotationRows = sectors.map((sector) => {
      const source = bySymbol.get(sector.symbol);
      const absolute = {};
      const baseline = {};
      const relative = {};
      windows.forEach((window) => {
        absolute[window.key] = finite(source?.[window.key]);
        baseline[window.key] = finite(spy?.[window.key]);
        relative[window.key] = absolute[window.key] != null && baseline[window.key] != null
          ? absolute[window.key] - baseline[window.key]
          : null;
      });
      return { ...sector, source: source || null, absolute, baseline, relative, percentiles: {} };
    });

    windows.forEach((window) => {
      const ranks = percentileMap(rotationRows, window.key);
      rotationRows.forEach((row) => { row.percentiles[window.key] = ranks.get(row.symbol) ?? null; });
    });

    rotationRows.forEach((row) => {
      row.score = weightedAverage(windows.map((window) => ({ value: row.percentiles[window.key], weight: window.weight })));
      row.shortScore = weightedAverage([
        { value: row.percentiles.return_1w, weight: .4 },
        { value: row.percentiles.return_1m, weight: .6 }
      ]);
      row.longScore = weightedAverage([
        { value: row.percentiles.return_3m, weight: .65 },
        { value: row.percentiles.return_6m, weight: .35 }
      ]);
      row.momentum = row.shortScore != null && row.longScore != null ? row.shortScore - row.longScore : 0;
      if (row.score != null && row.score >= 60 && row.momentum >= -5) row.zone = "Leading";
      else if (row.score != null && row.score >= 50 && row.momentum < -5) row.zone = "Weakening";
      else if (row.momentum > 5) row.zone = "Improving";
      else row.zone = "Lagging";
      row.trend = row.momentum > 5 ? "Strengthening" : row.momentum < -5 ? "Fading" : "Stable";
    });

    rotationRows.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
    rotationRows.forEach((row, index) => { row.rank = index + 1; });
    return { rows: rotationRows, baseline: spy, windows, sectors };
  }

  function summarizeSectorRotation(model) {
    const rows = model?.rows || [];
    const groupScore = (group) => {
      const scores = rows.filter((row) => row.group === group && row.score != null).map((row) => row.score);
      return scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 0;
    };
    const growth = groupScore("growth");
    const cyclical = groupScore("cyclical");
    const defensive = groupScore("defensive");
    let label = "SELECTIVE ROTATION";
    if (cyclical >= growth + 8 && cyclical >= defensive + 4) label = "VALUE / CYCLICAL ROTATION";
    else if (defensive >= growth + 8 && defensive >= cyclical + 4) label = "DEFENSIVE ROTATION";
    else if (growth >= cyclical + 8 && growth >= defensive + 8) label = "GROWTH LEADERSHIP";

    const leaders = rows.slice(0, 3).map((row) => row.symbol);
    const fading = rows.filter((row) => row.trend === "Fading").slice(0, 3).map((row) => row.symbol);
    const improving = rows.filter((row) => row.trend === "Strengthening").slice(0, 3).map((row) => row.symbol);
    const leadText = leaders.length ? `${leaders.join(", ")} lead on multi-window SPY-relative strength.` : "Rotation data is waiting for a complete sector set.";
    const momentumText = fading.length
      ? `${fading.join(", ")} are losing short-window momentum.`
      : improving.length ? `${improving.join(", ")} are gaining short-window momentum.` : "Momentum is broadly stable across the sector set.";
    return { label, leadText, momentumText, leaders, fading, improving, groupScores: { growth, cyclical, defensive } };
  }

  return { sectors, windows, buildSectorRotation, summarizeSectorRotation };
});
