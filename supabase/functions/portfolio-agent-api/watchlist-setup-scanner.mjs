const dailyLevelConfig = { sample: 120, radius: 2, recent: 32, maxAtr: 5, minPercent: 0.035, maxPercent: 0.15 };

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function normalizedBars(input) {
  if (!Array.isArray(input)) return [];
  return input.flatMap((bar) => {
    const open = number(bar?.open);
    const high = number(bar?.high);
    const low = number(bar?.low);
    const close = number(bar?.close);
    const volume = number(bar?.volume) || 0;
    if (![open, high, low, close].every(Number.isFinite) || high < low || close <= 0) return [];
    return [{ time: String(bar?.time || ""), open, high, low, close, volume }];
  });
}

function emaSeries(values, period) {
  if (!values.length) return [];
  const multiplier = 2 / (period + 1);
  const output = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    output.push(values[index] * multiplier + output[index - 1] * (1 - multiplier));
  }
  return output;
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : 0;
}

function atr14(bars) {
  const ranges = bars.slice(1).map((bar, index) => Math.max(
    bar.high - bar.low,
    Math.abs(bar.high - bars[index].close),
    Math.abs(bar.low - bars[index].close),
  ));
  return average(ranges.slice(-14));
}

function nearbyLevels(bars) {
  const config = dailyLevelConfig;
  const sample = bars.slice(-config.sample);
  const current = sample.at(-1)?.close || 0;
  const atr = atr14(sample);
  const clusterWidth = Math.max(current * 0.0035, atr * 0.35);
  const pivots = [];

  for (let index = config.radius; index < sample.length - config.radius; index += 1) {
    const neighbors = sample.slice(index - config.radius, index + config.radius + 1);
    if (sample[index].high >= Math.max(...neighbors.map((bar) => bar.high))) {
      pivots.push({ price: sample[index].high, index, kind: "high" });
    }
    if (sample[index].low <= Math.min(...neighbors.map((bar) => bar.low))) {
      pivots.push({ price: sample[index].low, index, kind: "low" });
    }
  }

  const clusters = [];
  for (const pivot of pivots) {
    const match = clusters.find((cluster) => cluster.kind === pivot.kind && Math.abs(cluster.price - pivot.price) <= clusterWidth);
    if (match) {
      match.price = (match.price * match.touches + pivot.price) / (match.touches + 1);
      match.touches += 1;
      match.lastIndex = Math.max(match.lastIndex, pivot.index);
    } else {
      clusters.push({ ...pivot, touches: 1, lastIndex: pivot.index });
    }
  }

  const maxDistance = Math.min(current * config.maxPercent, Math.max(atr * config.maxAtr, current * config.minPercent));
  const minDistance = Math.max(atr * 0.12, current * 0.001);
  const useful = clusters.flatMap((cluster) => {
    const distance = Math.abs(cluster.price - current);
    const recent = cluster.lastIndex >= sample.length - config.recent;
    if (distance < minDistance || distance > maxDistance || (cluster.touches < 2 && !recent)) return [];
    return [{ ...cluster, confirmed: cluster.touches >= 2, distance }];
  });
  const sort = (left, right) => left.distance - right.distance || right.touches - left.touches || right.lastIndex - left.lastIndex;
  return {
    atr,
    supports: useful.filter((level) => level.price < current).sort(sort),
    resistances: useful.filter((level) => level.price > current).sort(sort),
  };
}

function recentHigherLow(bars) {
  const sample = bars.slice(-30);
  const lows = [];
  for (let index = 2; index < sample.length - 2; index += 1) {
    const neighborhood = sample.slice(index - 2, index + 3);
    if (sample[index].low <= Math.min(...neighborhood.map((bar) => bar.low))) lows.push(sample[index].low);
  }
  return lows.length >= 2 && lows.at(-1) >= lows.at(-2) * 0.995;
}

function candidateSupport(current, levels, ema20, ema50, ema200) {
  const candidates = [
    ...levels.supports.map((level) => ({ type: "pivot", price: level.price, touches: level.touches, confirmed: level.confirmed })),
    { type: "EMA20", price: ema20, touches: null, confirmed: true },
    { type: "EMA50", price: ema50, touches: null, confirmed: true },
    { type: "EMA200", price: ema200, touches: null, confirmed: true },
  ].filter((item) => Number.isFinite(item.price) && item.price <= current && (current - item.price) / current <= 0.025);
  return candidates.sort((left, right) => Math.abs(current - left.price) - Math.abs(current - right.price))[0] || null;
}

export function analyzeWatchlistSetup({ symbol, bars: inputBars, market = null, fetchedAt = null, stale = false }) {
  const bars = normalizedBars(inputBars);
  if (bars.length < 210) return { symbol, eligible: false, reason: "INSUFFICIENT_DAILY_BARS", bar_count: bars.length };

  const closes = bars.map((bar) => bar.close);
  const ema20Series = emaSeries(closes, 20);
  const ema50Series = emaSeries(closes, 50);
  const ema200Series = emaSeries(closes, 200);
  const lastIndex = bars.length - 1;
  const current = closes[lastIndex];
  const ema20 = ema20Series[lastIndex];
  const ema50 = ema50Series[lastIndex];
  const ema200 = ema200Series[lastIndex];
  const levels = nearbyLevels(bars);
  const higherLow = recentHigherLow(bars);
  const averageVolume20 = average(bars.slice(-21, -1).map((bar) => bar.volume));
  const volumeRatio = averageVolume20 > 0 ? bars[lastIndex].volume / averageVolume20 : null;
  const ema20Rising = ema20 > ema20Series[Math.max(0, lastIndex - 5)];
  const ema50Rising = ema50 > ema50Series[Math.max(0, lastIndex - 5)];

  let reclaimAge = null;
  for (let index = Math.max(201, lastIndex - 9); index <= lastIndex; index += 1) {
    const priorBelow = closes[index - 1] <= ema200Series[index - 1] * 1.003;
    const closeAbove = closes[index] >= ema200Series[index] * 1.003;
    if (priorBelow && closeAbove) reclaimAge = lastIndex - index;
  }
  const distanceAboveEma200 = (current - ema200) / ema200 * 100;
  const reclaimBase = reclaimAge != null && distanceAboveEma200 >= 0.3 && distanceAboveEma200 <= 5;
  const reclaimConfirmations = [ema20Rising, higherLow, volumeRatio != null && volumeRatio >= 1.2].filter(Boolean).length;

  const support = candidateSupport(current, levels, ema20, ema50, ema200);
  const supportDistance = support ? (current - support.price) / current * 100 : null;
  const supportHeld = support ? bars.slice(-3).every((bar) => bar.close >= support.price * 0.99) : false;
  const failurePrice = support ? Math.max(0, support.price - levels.atr * 0.35) : null;
  const failureDistance = failurePrice ? (current - failurePrice) / current * 100 : null;
  const resistance = levels.resistances[0]?.price || Math.max(...bars.slice(-20).map((bar) => bar.high));
  const reward = resistance > current ? resistance - current : 0;
  const risk = failurePrice && failurePrice < current ? current - failurePrice : 0;
  const rewardRisk = risk > 0 ? reward / risk : null;
  const nearSupportBase = Boolean(support && supportDistance <= 2.5 && supportHeld && failureDistance <= 4);

  const common = {
    symbol,
    daily_close: round(current),
    market_price: round(number(market?.price)),
    market_time: market?.market_time || null,
    bar_time: bars[lastIndex].time || null,
    fetched_at: fetchedAt,
    stale: Boolean(stale),
    bar_count: bars.length,
    ema20: round(ema20),
    ema50: round(ema50),
    ema200: round(ema200),
    ema20_rising: ema20Rising,
    ema50_rising: ema50Rising,
    higher_low: higherLow,
    volume_ratio_20d: round(volumeRatio, 2),
  };

  const setups = [];
  if (reclaimBase) {
    setups.push({
      ...common,
      setup: "RECLAIM_EMA200",
      status: reclaimConfirmations >= 2 ? "READY_FOR_4H" : "WATCH",
      score: Math.min(100, 55 + reclaimConfirmations * 15),
      reclaim_age_bars: reclaimAge,
      distance_from_ema200_pct: round(distanceAboveEma200, 2),
      confirmations: reclaimConfirmations,
      decision_zone: [round(ema200 * 0.997), round(ema200 * 1.01)],
      failure_zone: [round(ema200 - levels.atr * 0.35), round(ema200 * 0.997)],
      next_step: "Confirm the reclaim on 4H, then use 1H only for a retest or pivot trigger.",
    });
  }
  if (nearSupportBase) {
    const ready = rewardRisk != null && rewardRisk >= 1.8 && higherLow;
    setups.push({
      ...common,
      setup: "NEAR_SUPPORT",
      status: ready ? "READY_FOR_4H" : "WATCH",
      score: Math.min(100, 50 + (support.confirmed ? 10 : 0) + (higherLow ? 15 : 0) + (rewardRisk >= 1.8 ? 20 : 0)),
      support_type: support.type,
      support: round(support.price),
      support_touches: support.touches,
      distance_from_support_pct: round(supportDistance, 2),
      resistance: round(resistance),
      estimated_reward_risk: round(rewardRisk, 2),
      decision_zone: [round(support.price), round(support.price * 1.015)],
      failure_zone: [round(failurePrice), round(support.price * 0.995)],
      next_step: "Require a 4H hold or reclaim; use 1H only after a higher low or pivot break.",
    });
  }

  return { symbol, eligible: true, setups, metrics: common };
}
