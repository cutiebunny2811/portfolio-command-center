function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function strategyConfig(strategy) {
  const configs = {
    long_call: { optionType: "call", income: false, label: "Long Call" },
    long_put: { optionType: "put", income: false, label: "Long Put" },
    covered_call: { optionType: "call", income: true, label: "Covered Call" },
    cash_secured_put: { optionType: "put", income: true, label: "Cash-Secured Put" },
  };
  const config = configs[String(strategy || "").trim().toLowerCase()];
  if (!config) throw new Error("strategy must be long_call, long_put, covered_call, or cash_secured_put");
  return config;
}

function portfolioContext(snapshot, symbol) {
  const instruments = Array.isArray(snapshot?.instruments) ? snapshot.instruments : [];
  const instrumentById = new Map(instruments.map((instrument) => [String(instrument.id), instrument]));
  const positions = Array.isArray(snapshot?.positions) ? snapshot.positions : [];
  const stockPosition = positions.find((position) => {
    const instrument = instrumentById.get(String(position.instrument_id));
    return ["stock", "etf"].includes(String(instrument?.asset_type || "").toLowerCase())
      && String(instrument?.symbol || "").toUpperCase() === symbol;
  });
  return {
    cashAvailable: finite(snapshot?.cash?.cash_balance),
    sharesHeld: finite(stockPosition?.quantity),
    shareCost: finite(stockPosition?.average_cost),
  };
}

export function selectOptionContract(payload, strike) {
  const contracts = Array.isArray(payload?.contracts) ? payload.contracts : [];
  if (!contracts.length) throw new Error("The live option chain returned no contracts");
  const requestedStrike = Number(strike);
  if (Number.isFinite(requestedStrike)) {
    const exact = contracts.find((contract) => Math.abs(finite(contract.strike) - requestedStrike) < 0.0001);
    if (!exact) throw new Error(`Strike ${requestedStrike} is outside the returned near-money tape`);
    return exact;
  }
  const spot = finite(payload?.underlying?.price);
  return [...contracts].sort((left, right) =>
    Math.abs(finite(left.strike) - spot) - Math.abs(finite(right.strike) - spot)
    || finite(left.strike) - finite(right.strike))[0];
}

export function analyzeOptionDesk(payload, snapshot, options = {}) {
  const strategyKey = String(options.strategy || "").trim().toLowerCase();
  const strategy = strategyConfig(strategyKey);
  const symbol = String(payload?.symbol || "").trim().toUpperCase();
  if (!symbol) throw new Error("Option chain symbol is missing");
  if (String(payload?.option_type || "").toLowerCase() !== strategy.optionType) {
    throw new Error(`The returned chain is not a ${strategy.optionType} chain`);
  }
  const selected = selectOptionContract(payload, options.strike);
  const multiplier = Math.max(1, finite(selected.multiplier, 100));
  const bid = finite(selected.bid, NaN);
  const ask = finite(selected.ask, NaN);
  const premium = strategy.income ? bid : ask;
  const quoteReady = Number.isFinite(premium) && premium > 0;
  const premiumTotal = quoteReady ? premium * multiplier : null;
  const strike = finite(selected.strike);
  const { cashAvailable, sharesHeld, shareCost } = portfolioContext(snapshot, symbol);
  const spot = finite(payload?.underlying?.price);
  const basis = shareCost > 0 ? shareCost : spot;
  const cashRequired = strike * multiplier;
  const coveredCall = strategyKey === "covered_call";
  const cashSecuredPut = strategyKey === "cash_secured_put";
  const eligible = quoteReady && (coveredCall
    ? sharesHeld >= multiplier
    : cashSecuredPut ? cashAvailable >= cashRequired : cashAvailable >= premiumTotal);
  const maxLoss = !quoteReady ? null
    : coveredCall ? Math.max(0, basis * multiplier - premiumTotal)
      : cashSecuredPut ? Math.max(0, cashRequired - premiumTotal)
        : premiumTotal;
  const maxProfit = !quoteReady ? null
    : coveredCall ? Math.max(0, (strike - basis) * multiplier + premiumTotal)
      : cashSecuredPut ? premiumTotal
        : strategy.optionType === "put" ? Math.max(0, strike * multiplier - premiumTotal) : null;
  const breakEven = !quoteReady ? null
    : coveredCall ? basis - premium
      : strategy.optionType === "call" ? strike + premium : strike - premium;
  const mid = Number(selected.mid);
  const spreadPercent = Number.isFinite(mid) && mid > 0 && Number.isFinite(bid) && Number.isFinite(ask)
    ? ((ask - bid) / mid) * 100
    : null;
  const liquidity = spreadPercent == null ? "NO_QUOTE" : spreadPercent <= 7 ? "CLEAN" : spreadPercent <= 12 ? "WATCH" : "WIDE";

  return {
    source: payload.source || "webull_opra",
    quote_mode: payload.quote_mode || "REAL-TIME OPRA",
    fetched_at: payload.fetched_at || null,
    market_data_only: true,
    order_sent: false,
    strategy: { key: strategyKey, label: strategy.label, option_type: strategy.optionType, side: strategy.income ? "sell" : "buy" },
    underlying: payload.underlying,
    selected_contract: selected,
    quote: {
      reference: strategy.income ? "bid" : "ask",
      premium_per_share: quoteReady ? premium : null,
      premium_per_contract: premiumTotal,
      spread_percent: spreadPercent,
      liquidity,
    },
    payoff_at_expiry: {
      maximum_loss: maxLoss,
      maximum_profit: maxProfit,
      maximum_profit_open: maxProfit == null && quoteReady,
      break_even_underlying: breakEven,
    },
    collateral: coveredCall
      ? { type: "shares", required: multiplier, available: sharesHeld }
      : cashSecuredPut
        ? { type: "cash", required: cashRequired, available: cashAvailable }
        : { type: "cash", required: premiumTotal, available: cashAvailable },
    eligibility: {
      ready: eligible,
      shortfall: coveredCall
        ? Math.max(0, multiplier - sharesHeld)
        : Math.max(0, finite((cashSecuredPut ? cashRequired : premiumTotal)) - cashAvailable),
    },
    portfolio: {
      id: snapshot?.portfolio?.id || null,
      name: snapshot?.portfolio?.name || null,
      cash_available: cashAvailable,
      underlying_shares: sharesHeld,
      underlying_average_cost: shareCost || null,
    },
    interpretation_guardrails: [
      "Use the quote timestamp and bid/ask width before discussing Greeks or payoff.",
      "This is a read-only market estimate, not a broker fill, recommendation, or order.",
    ],
  };
}
