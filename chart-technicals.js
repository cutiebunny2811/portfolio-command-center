(function attachChartTechnicals(root) {
  "use strict";

  const levelConfigs = {
    "1H": { sample: 180, radius: 2, recent: 55, maxAtr: 4, minPercent: .02, maxPercent: .06 },
    "4H": { sample: 170, radius: 2, recent: 45, maxAtr: 5, minPercent: .03, maxPercent: .10 },
    "1D": { sample: 120, radius: 2, recent: 32, maxAtr: 5, minPercent: .035, maxPercent: .15 }
  };

  function value(input) {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  const newYorkFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });

  function newYorkClock(input) {
    const date = new Date(input || "");
    if (!Number.isFinite(date.getTime())) return null;
    const parts = Object.fromEntries(newYorkFormatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]));
    return {
      dateKey: `${parts.year}-${parts.month}-${parts.day}`,
      minutes: Number(parts.hour) * 60 + Number(parts.minute)
    };
  }

  function reconcileDailyBarsWithQuote(bars, quote) {
    if (!Array.isArray(bars) || !bars.length) return Array.isArray(bars) ? bars : [];
    const price = value(quote?.price);
    const quoteClock = newYorkClock(quote?.marketTime);
    const last = bars[bars.length - 1];
    const barTime = new Date(last?.time || "");
    if (price <= 0 || !quoteClock || !Number.isFinite(barTime.getTime())) return bars;
    const barMatchesQuote = barTime.toISOString().slice(0, 10) === quoteClock.dateKey
      || newYorkClock(barTime)?.dateKey === quoteClock.dateKey;
    if (!barMatchesQuote) return bars;
    const open = value(last?.open) || price;
    return [...bars.slice(0, -1), {
      ...last,
      open,
      high: Math.max(value(last?.high) || price, open, price),
      low: Math.min(value(last?.low) || price, open, price),
      close: price
    }];
  }

  function calculateNearbyLevels(bars, timeframe = "1D") {
    const config = levelConfigs[timeframe] || levelConfigs["1D"];
    if (!Array.isArray(bars) || bars.length < 20) {
      return { supports: [], resistances: [], atr: 0, sampleSize: 0, maxDistance: 0 };
    }

    const sample = bars.slice(-config.sample);
    const current = value(sample[sample.length - 1]?.close);
    const trueRanges = sample.slice(1).map((bar, index) => Math.max(
      value(bar.high) - value(bar.low),
      Math.abs(value(bar.high) - value(sample[index].close)),
      Math.abs(value(bar.low) - value(sample[index].close))
    ));
    const atrValues = trueRanges.slice(-14);
    const atr = atrValues.reduce((sum, item) => sum + item, 0) / Math.max(atrValues.length, 1);
    const clusterWidth = Math.max(current * .0035, atr * .35);
    const pivots = [];

    for (let index = config.radius; index < sample.length - config.radius; index += 1) {
      const neighbors = sample.slice(index - config.radius, index + config.radius + 1);
      const high = value(sample[index].high);
      const low = value(sample[index].low);
      if (high >= Math.max(...neighbors.map((bar) => value(bar.high)))) pivots.push({ price: high, index, kind: "high" });
      if (low <= Math.min(...neighbors.map((bar) => value(bar.low)))) pivots.push({ price: low, index, kind: "low" });
    }

    const clusters = [];
    pivots.forEach((pivot) => {
      const match = clusters.find((cluster) => cluster.kind === pivot.kind && Math.abs(cluster.price - pivot.price) <= clusterWidth);
      if (match) {
        match.price = (match.price * match.touches + pivot.price) / (match.touches + 1);
        match.touches += 1;
        match.lastIndex = Math.max(match.lastIndex, pivot.index);
      } else {
        clusters.push({ price: pivot.price, touches: 1, lastIndex: pivot.index, kind: pivot.kind });
      }
    });

    const maxDistance = Math.min(
      current * config.maxPercent,
      Math.max(atr * config.maxAtr, current * config.minPercent)
    );
    const minDistance = Math.max(atr * .12, current * .001);
    const useful = clusters.filter((cluster) => {
      const distance = Math.abs(cluster.price - current);
      const recent = cluster.lastIndex >= sample.length - config.recent;
      return distance >= minDistance && distance <= maxDistance && (cluster.touches >= 2 || recent);
    }).map((cluster) => ({
      ...cluster,
      confirmed: cluster.touches >= 2,
      distance: Math.abs(cluster.price - current)
    }));
    const byActionability = (a, b) => a.distance - b.distance || b.touches - a.touches || b.lastIndex - a.lastIndex;
    const distinctClosest = (items) => items.sort(byActionability).reduce((selected, candidate) => {
      if (selected.length >= 2) return selected;
      const overlaps = selected.some((level) => Math.abs(level.price - candidate.price) <= clusterWidth);
      if (!overlaps) selected.push(candidate);
      return selected;
    }, []);

    return {
      supports: distinctClosest(useful.filter((cluster) => cluster.price < current)),
      resistances: distinctClosest(useful.filter((cluster) => cluster.price > current)),
      atr,
      sampleSize: sample.length,
      maxDistance
    };
  }

  root.PccChartTechnicals = Object.freeze({ calculateNearbyLevels, reconcileDailyBarsWithQuote, levelConfigs });
})(globalThis);
