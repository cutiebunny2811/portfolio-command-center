const finite = (value) => {
  if (value == null || value === "" || typeof value === "boolean") return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
};
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function rounded(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function perShare(equityValue, shares) {
  if (!Number.isFinite(equityValue) || !(shares > 0)) return null;
  return rounded(Math.max(equityValue / shares, 0));
}

function selectModelFamily(fundamentals, forward, netIncome, fcf, equity) {
  const sic = finite(fundamentals.sic);
  const isFinancial = sic != null && sic >= 6000 && sic < 6800;
  if (forward.model_family === "excess_return" && isFinancial && equity > 0) return "excess_return";
  if ((netIncome != null && netIncome <= 0) || fcf <= 0 || forward.model_family === "transition_dcf") return "transition_dcf";
  return "normalized_dcf";
}

export function buildFallbackForwardPacket(fundamentals = {}, documents = []) {
  const revenue = finite(fundamentals.revenue_ttm) ?? finite(fundamentals.revenue_fy) ?? 0;
  const netIncome = finite(fundamentals.net_income_ttm) ?? finite(fundamentals.net_income_fy);
  const fcf = finite(fundamentals.free_cash_flow_ttm) ?? finite(fundamentals.free_cash_flow_fy) ?? 0;
  const shares = finite(fundamentals.shares_outstanding) ?? 0;
  const equity = finite(fundamentals.stockholders_equity) ?? 0;
  const sic = finite(fundamentals.sic);
  if (!(revenue > 0) || !(shares > 0)) throw new Error("SEC facts are not sufficient for a deterministic forward range.");

  const isFinancial = sic != null && sic >= 6000 && sic < 6800 && equity > 0;
  const isTransition = !isFinancial && ((netIncome != null && netIncome <= 0) || fcf <= 0);
  const reportedGrowth = finite(fundamentals.revenue_growth);
  const baseGrowth = clamp(reportedGrowth ?? (isTransition ? 0.1 : 0.06), isTransition ? 0.04 : -0.05, isTransition ? 0.25 : 0.18);
  const currentMargin = clamp(fcf / revenue, -0.5, 0.4);
  const sharesGrowth = Math.max(finite(fundamentals.shares_growth) ?? 0, 0);
  const dilution = clamp(sharesGrowth, 0, isTransition ? 0.25 : 0.1);
  const baseShares = shares * (1 + dilution);
  const sourceRows = documents.slice(0, 4).map(({ title, url, date, form }) => ({ title, url, date, form })).filter((row) => row.title && row.url);
  if (!sourceRows.length) throw new Error("SEC filing documents could not be loaded for the deterministic forward range.");

  const scenarioSettings = isTransition
    ? {
      bear: { growth: Math.max(baseGrowth - 0.06, 0.02), year5: Math.min(currentMargin + 0.12, -0.03), terminal: 0, wacc: 0.16, tg: 0.01, shares: baseShares * 1.12 },
      base: { growth: baseGrowth, year5: Math.max(Math.min(currentMargin + 0.22, 0.06), 0), terminal: 0.08, wacc: 0.13, tg: 0.02, shares: baseShares * 1.06 },
      bull: { growth: Math.min(baseGrowth + 0.08, 0.35), year5: Math.max(Math.min(currentMargin + 0.32, 0.14), 0.06), terminal: 0.15, wacc: 0.1, tg: 0.025, shares: baseShares },
    }
    : {
      bear: { growth: Math.max(baseGrowth - 0.05, -0.08), year5: clamp(Math.max(currentMargin * 0.75, 0.04), 0.04, 0.25), terminal: null, wacc: 0.12, tg: 0.015, shares: baseShares * 1.04 },
      base: { growth: baseGrowth, year5: clamp(Math.max(currentMargin, 0.08), 0.08, 0.32), terminal: null, wacc: 0.1, tg: 0.025, shares: baseShares * 1.02 },
      bull: { growth: Math.min(baseGrowth + 0.05, 0.25), year5: clamp(Math.max(currentMargin * 1.15, 0.13), 0.13, 0.4), terminal: null, wacc: 0.085, tg: 0.03, shares: baseShares },
    };
  const horizon = isTransition ? 10 : 5;
  const scenarios = ["bear", "base", "bull"].map((key) => {
    const row = scenarioSettings[key];
    return {
      key,
      revenue_year_1: revenue * (1 + row.growth),
      revenue_growth: row.growth,
      fcf_margin_year_1: currentMargin,
      fcf_margin_year_5: row.year5,
      fcf_margin_terminal: row.terminal ?? row.year5,
      horizon_years: horizon,
      wacc: row.wacc,
      terminal_growth: row.tg,
      diluted_shares: Math.max(row.shares, shares),
    };
  });

  return {
    model_family: isFinancial ? "excess_return" : isTransition ? "transition_dcf" : "normalized_dcf",
    company_stage: isFinancial ? "FINANCIAL" : isTransition ? "LOSS-MAKING TRANSITION" : "CASH-GENERATIVE",
    evidence_quality: "LOW",
    basis: "DETERMINISTIC SEC FACTS",
    rationale: "PCC used a conservative, rules-based forward range because document synthesis was unavailable.",
    as_of: sourceRows.map((row) => row.date).filter(Boolean).sort().at(-1) || fundamentals.sec_filed_at || null,
    balance_adjustments: [],
    diluted_shares: Math.max(baseShares, shares),
    revenue_year_1: scenarios[1].revenue_year_1,
    fcf_margin_year_1: currentMargin,
    fcf_margin_year_5: scenarios[1].fcf_margin_year_5,
    fcf_margin_terminal: scenarios[1].fcf_margin_terminal,
    horizon_years: horizon,
    scenarios,
    financial_scenarios: [
      { key: "bear", roe: 0.07, cost_of_equity: 0.13, payout_ratio: 0.3, terminal_growth: 0.01 },
      { key: "base", roe: 0.11, cost_of_equity: 0.105, payout_ratio: 0.35, terminal_growth: 0.02 },
      { key: "bull", roe: 0.16, cost_of_equity: 0.09, payout_ratio: 0.4, terminal_growth: 0.025 },
    ],
    sources: sourceRows,
    risks: [
      "Forward document synthesis was unavailable; PCC used a conservative SEC-facts fallback.",
      isTransition ? "The range depends on achieving positive free cash flow within the modeled transition horizon." : "The range depends on sustaining reported cash conversion and revenue quality.",
    ],
    generated_model: "deterministic-sec-fallback",
  };
}

function scenarioRow(packet, fairValue, model, assumption) {
  return {
    key: packet.key,
    label: packet.key === "bear" ? "Bear" : packet.key === "bull" ? "Bull" : "Base",
    fair_value: rounded(fairValue),
    method: model,
    assumption,
    inputs: {
      input_mode: packet.fcff_path ? "explicit_fcff_path" : "revenue_margin",
      fcff_path: packet.fcff_path ? [...packet.fcff_path] : undefined,
      revenue_year_1: rounded(packet.revenue_year_1, 0),
      revenue_growth: rounded(packet.revenue_growth, 4),
      fcf_margin_year_1: rounded(packet.fcf_margin_year_1, 4),
      fcf_margin_year_5: rounded(packet.fcf_margin_year_5, 4),
      fcf_margin_terminal: rounded(packet.fcf_margin_terminal, 4),
      horizon_years: packet.horizon_years,
      wacc: rounded(packet.wacc, 4),
      terminal_growth: rounded(packet.terminal_growth, 4),
      diluted_shares: rounded(packet.diluted_shares, 0),
      revenue_anchor_applied: Boolean(packet.revenue_anchor_applied),
      terminal_margin_floor_applied: Boolean(packet.terminal_margin_floor_applied),
    },
  };
}

function normalizedScenario(raw, common, key) {
  const defaultGrowth = key === "bear" ? 0.04 : key === "bull" ? 0.16 : 0.1;
  const defaultWacc = key === "bear" ? 0.12 : key === "bull" ? 0.085 : 0.1;
  const defaultTerminal = key === "bear" ? 0.015 : key === "bull" ? 0.03 : 0.025;
  const requestedRevenue = finite(raw?.revenue_year_1) ?? finite(common.revenue_year_1) ?? 0;
  const floorTable = common.model_family === "normalized_dcf"
    ? { bear: 0.8, base: 0.95, bull: 1.05 }
    : { bear: 0.5, base: 0.8, bull: 1 };
  const reportedFloor = Math.max(finite(common.reported_revenue) ?? 0, 0) * floorTable[key];
  const revenueYearOne = clamp(Math.max(requestedRevenue, reportedFloor), 0, common.revenue_cap);
  const dilutedShares = clamp(finite(raw?.diluted_shares) ?? finite(common.diluted_shares) ?? 0, common.basic_shares, common.share_cap);
  const wacc = clamp(finite(raw?.wacc) ?? defaultWacc, 0.07, 0.2);
  const yearFiveMargin = clamp(finite(raw?.fcf_margin_year_5) ?? finite(common.fcf_margin_year_5) ?? 0.1, -0.25, 0.55);
  const isTransition = common.model_family === "transition_dcf";
  const requestedHorizon = finite(raw?.horizon_years) ?? finite(common.horizon_years);
  const horizonYears = isTransition
    ? Math.round(requestedHorizon != null && requestedHorizon >= 7 ? clamp(requestedHorizon, 7, 10) : 10)
    : 5;
  const fcffPath = Array.isArray(raw?.fcff_path) ? raw.fcff_path.map(finite) : null;
  if (fcffPath && (fcffPath.length !== horizonYears || fcffPath.some((value) => value == null))) {
    throw new Error(`${key} case explicit FCFF path must contain ${horizonYears} finite annual values.`);
  }
  const transitionFloor = key === "bear" ? 0 : key === "bull" ? 0.12 : 0.06;
  const requestedTerminalMargin = finite(raw?.fcf_margin_terminal) ?? finite(common.fcf_margin_terminal) ?? yearFiveMargin;
  const terminalMargin = clamp(isTransition ? Math.max(requestedTerminalMargin, transitionFloor) : yearFiveMargin, -0.1, 0.55);
  return {
    key,
    revenue_year_1: revenueYearOne,
    revenue_growth: clamp(finite(raw?.revenue_growth) ?? defaultGrowth, -0.25, 0.6),
    fcf_margin_year_1: clamp(finite(raw?.fcf_margin_year_1) ?? finite(common.fcf_margin_year_1) ?? 0, -0.75, 0.55),
    fcf_margin_year_5: yearFiveMargin,
    fcf_margin_terminal: terminalMargin,
    horizon_years: horizonYears,
    wacc,
    terminal_growth: Math.min(clamp(finite(raw?.terminal_growth) ?? defaultTerminal, 0, 0.04), wacc - 0.025),
    diluted_shares: dilutedShares,
    fcff_path: fcffPath,
    revenue_anchor_applied: reportedFloor > 0 && requestedRevenue < reportedFloor,
    terminal_margin_floor_applied: isTransition && requestedTerminalMargin < transitionFloor,
  };
}

function economicallyOrderPackets(packets) {
  if (packets.some((packet) => packet.fcff_path)) return packets;
  const [bear, base, bull] = packets.map((packet) => ({ ...packet }));
  bear.revenue_year_1 = Math.min(bear.revenue_year_1, base.revenue_year_1);
  bull.revenue_year_1 = Math.max(bull.revenue_year_1, base.revenue_year_1);
  bear.revenue_growth = Math.min(bear.revenue_growth, base.revenue_growth);
  bull.revenue_growth = Math.max(bull.revenue_growth, base.revenue_growth);
  bear.fcf_margin_year_1 = Math.min(bear.fcf_margin_year_1, base.fcf_margin_year_1);
  bull.fcf_margin_year_1 = Math.max(bull.fcf_margin_year_1, base.fcf_margin_year_1);
  bear.fcf_margin_year_5 = Math.min(bear.fcf_margin_year_5, base.fcf_margin_year_5);
  bull.fcf_margin_year_5 = Math.max(bull.fcf_margin_year_5, base.fcf_margin_year_5);
  bear.fcf_margin_terminal = Math.min(bear.fcf_margin_terminal, base.fcf_margin_terminal);
  bull.fcf_margin_terminal = Math.max(bull.fcf_margin_terminal, base.fcf_margin_terminal);
  bear.wacc = Math.max(bear.wacc, base.wacc);
  bull.wacc = Math.min(bull.wacc, base.wacc);
  bear.terminal_growth = Math.min(bear.terminal_growth, base.terminal_growth, bear.wacc - 0.025);
  bull.terminal_growth = Math.min(Math.max(bull.terminal_growth, base.terminal_growth), bull.wacc - 0.025);
  bear.diluted_shares = Math.max(bear.diluted_shares, base.diluted_shares);
  bull.diluted_shares = Math.min(bull.diluted_shares, base.diluted_shares);
  return [bear, base, bull];
}

function forwardDcf(packet, adjustedCash, adjustedDebt) {
  let presentValue = 0;
  let revenue = packet.revenue_year_1;
  let finalFcf = 0;
  const horizonYears = packet.horizon_years || 5;
  for (let year = 1; year <= horizonYears; year += 1) {
    if (packet.fcff_path) {
      finalFcf = packet.fcff_path[year - 1];
    } else {
      if (year > 1) revenue *= 1 + packet.revenue_growth;
      const margin = year <= 5
        ? packet.fcf_margin_year_1 + (packet.fcf_margin_year_5 - packet.fcf_margin_year_1) * ((year - 1) / 4)
        : packet.fcf_margin_year_5 + (packet.fcf_margin_terminal - packet.fcf_margin_year_5) * ((year - 5) / (horizonYears - 5));
      finalFcf = revenue * margin;
    }
    presentValue += finalFcf / ((1 + packet.wacc) ** year);
  }
  const terminal = finalFcf > 0
    ? finalFcf * (1 + packet.terminal_growth) / (packet.wacc - packet.terminal_growth)
    : 0;
  return presentValue + terminal / ((1 + packet.wacc) ** horizonYears) + adjustedCash - adjustedDebt;
}

function adjustedBalance(fundamentals, forward, balanceScale) {
  const cash = Math.max(finite(fundamentals.cash) ?? 0, 0);
  const shortTermInvestments = Math.max(finite(fundamentals.short_term_investments) ?? 0, 0);
  const reportedDebt = Math.max(finite(fundamentals.debt) ?? 0, 0);
  const liquidAssets = cash + shortTermInvestments;
  const totals = { cash_inflow: 0, cash_outflow: 0, debt_increase: 0, debt_repayment: 0 };
  const adjustments = (Array.isArray(forward.balance_adjustments) ? forward.balance_adjustments : [])
    .flatMap((row) => {
      const kind = String(row?.kind || "").toLowerCase();
      const amount = finite(row?.amount);
      if (!(kind in totals) || !(amount > 0) || amount > balanceScale * 3) return [];
      totals[kind] += amount;
      return [{ kind, amount, description: String(row?.description || "Documented post-period balance adjustment") }];
    });
  return {
    cash,
    shortTermInvestments,
    liquidAssets,
    reportedDebt,
    adjustedCash: Math.max(liquidAssets + totals.cash_inflow - totals.cash_outflow, 0),
    adjustedDebt: Math.max(reportedDebt + totals.debt_increase - totals.debt_repayment, 0),
    adjustments,
  };
}

function forwardExcessReturn(packet, equity, shares) {
  const roe = clamp(finite(packet.roe) ?? 0.1, -0.2, 0.5);
  const costOfEquity = clamp(finite(packet.cost_of_equity) ?? 0.1, 0.07, 0.2);
  const payout = clamp(finite(packet.payout_ratio) ?? 0.35, 0, 0.9);
  const terminalGrowth = Math.min(clamp(finite(packet.terminal_growth) ?? 0.025, 0, 0.04), costOfEquity - 0.025);
  let book = equity;
  let presentValue = 0;
  for (let year = 1; year <= 5; year += 1) {
    const earnings = book * roe;
    const dividend = Math.max(earnings * payout, 0);
    presentValue += dividend / ((1 + costOfEquity) ** year);
    book += earnings - dividend;
  }
  const terminalBookMultiple = Math.max((roe - terminalGrowth) / (costOfEquity - terminalGrowth), 0);
  const terminalValue = book * terminalBookMultiple;
  return perShare(presentValue + terminalValue / ((1 + costOfEquity) ** 5), shares);
}

function financialScenario(raw, key) {
  const defaultRoe = key === "bear" ? 0.08 : key === "bull" ? 0.18 : 0.13;
  const defaultCost = key === "bear" ? 0.12 : key === "bull" ? 0.085 : 0.1;
  const defaultTerminal = key === "bear" ? 0.015 : key === "bull" ? 0.03 : 0.025;
  const costOfEquity = clamp(finite(raw?.cost_of_equity) ?? defaultCost, 0.07, 0.2);
  return {
    key,
    roe: clamp(finite(raw?.roe) ?? defaultRoe, -0.2, 0.5),
    cost_of_equity: costOfEquity,
    payout_ratio: clamp(finite(raw?.payout_ratio) ?? 0.35, 0, 0.9),
    terminal_growth: Math.min(clamp(finite(raw?.terminal_growth) ?? defaultTerminal, 0, 0.04), costOfEquity - 0.025),
  };
}

export function buildValuation(input = {}) {
  const fundamentals = input.fundamentals || {};
  const forward = input.forward || {};
  const market = input.market || {};
  const revenue = finite(fundamentals.revenue_ttm) ?? finite(fundamentals.revenue_fy) ?? 0;
  const netIncome = finite(fundamentals.net_income_ttm) ?? finite(fundamentals.net_income_fy);
  const fcf = finite(fundamentals.free_cash_flow_ttm) ?? finite(fundamentals.free_cash_flow_fy) ?? 0;
  const grossProfit = finite(fundamentals.gross_profit_ttm) ?? finite(fundamentals.gross_profit_fy);
  const reportedCash = Math.max(finite(fundamentals.cash) ?? 0, 0);
  const reportedInvestments = Math.max(finite(fundamentals.short_term_investments) ?? 0, 0);
  const reportedDebt = Math.max(finite(fundamentals.debt) ?? 0, 0);
  const equity = finite(fundamentals.stockholders_equity);
  const basicShares = finite(fundamentals.shares_outstanding);
  const reportedRevenueGrowth = finite(fundamentals.revenue_growth);
  const sharesGrowth = finite(fundamentals.shares_growth);
  const price = finite(market.price);
  const sourceRows = Array.isArray(forward.sources) ? forward.sources.filter((row) => row?.title && row?.url) : [];

  if (!(basicShares > 0)) throw new Error("SEC did not provide a usable common-share count for this company.");
  if (!forward.model_family) throw new Error("Forward assumptions are unavailable for this company.");
  if (!sourceRows.length) throw new Error("Forward assumptions do not include a verifiable filing source.");

  const balanceScale = Math.max(revenue, reportedCash + reportedInvestments, reportedDebt, 1_000_000);
  const balance = adjustedBalance(fundamentals, forward, balanceScale);
  const adjustedCash = balance.adjustedCash;
  const adjustedDebt = balance.adjustedDebt;
  const modelFamily = selectModelFamily(fundamentals, forward, netIncome, fcf, equity);
  const common = {
    revenue_year_1: clamp(finite(forward.revenue_year_1) ?? 0, 0, Math.max(revenue * 20, 5_000_000)),
    fcf_margin_year_1: finite(forward.fcf_margin_year_1),
    fcf_margin_year_5: finite(forward.fcf_margin_year_5),
    fcf_margin_terminal: finite(forward.fcf_margin_terminal),
    horizon_years: finite(forward.horizon_years),
    diluted_shares: clamp(finite(forward.diluted_shares) ?? basicShares, basicShares, basicShares * 10),
    basic_shares: basicShares,
    share_cap: basicShares * 10,
    revenue_cap: Math.max(revenue * 20, 5_000_000),
    reported_revenue: revenue,
    model_family: modelFamily,
  };
  const rawScenarios = new Map((Array.isArray(forward.scenarios) ? forward.scenarios : []).map((row) => [String(row?.key || "").toLowerCase(), row]));
  const keys = ["bear", "base", "bull"];
  let scenarios;
  let model;

  if (modelFamily === "excess_return") {
    if (!(equity > 0)) throw new Error("A forward excess-return model requires positive reported equity.");
    model = "FORWARD EXCESS RETURN";
    scenarios = keys.map((key) => {
      const packet = financialScenario(rawScenarios.get(key), key);
      return {
        key,
        label: key === "bear" ? "Bear" : key === "bull" ? "Bull" : "Base",
        fair_value: forwardExcessReturn(packet, equity, basicShares),
        method: model,
        assumption: `${rounded(packet.roe * 100, 1)}% ROE · ${rounded(packet.cost_of_equity * 100, 1)}% cost of equity`,
        inputs: packet,
      };
    });
  } else {
    model = modelFamily === "normalized_dcf" ? "NORMALIZED FORWARD DCF" : "LONG-HORIZON TRANSITION DCF";
    const packets = economicallyOrderPackets(keys.map((key) => normalizedScenario(rawScenarios.get(key), common, key)));
    scenarios = packets.map((packet) => {
      if (!packet.fcff_path && !(packet.revenue_year_1 > 0)) throw new Error(`${packet.key} case does not provide usable forward revenue.`);
      if (!(packet.diluted_shares >= basicShares)) throw new Error(`${packet.key} case diluted shares are below reported basic shares.`);
      const fairValue = perShare(forwardDcf(packet, adjustedCash, adjustedDebt), packet.diluted_shares);
      return scenarioRow(
        packet,
        fairValue,
        model,
        packet.fcff_path
          ? `Explicit FCFF · Y1 $${rounded(packet.fcff_path[0] / 1_000_000_000, 1)}B → Y${packet.horizon_years} $${rounded(packet.fcff_path.at(-1) / 1_000_000_000, 1)}B`
          : `${rounded(packet.revenue_growth * 100, 1)}% growth · ${rounded(packet.fcf_margin_terminal * 100, 1)}% year-${packet.horizon_years} FCF margin`,
      );
    });
  }

  if (scenarios.some((row) => !Number.isFinite(row.fair_value))) {
    throw new Error("Forward assumptions are not sufficient to calculate all three valuation cases.");
  }
  let scenarioEnvelopeApplied = false;
  if (!(scenarios[0].fair_value <= scenarios[1].fair_value && scenarios[1].fair_value <= scenarios[2].fair_value)) {
    scenarioEnvelopeApplied = true;
    scenarios = [...scenarios].sort((left, right) => left.fair_value - right.fair_value).map((row, index) => ({
      ...row,
      key: keys[index],
      label: index === 0 ? "Bear" : index === 2 ? "Bull" : "Base",
      inputs: { ...row.inputs, source_case: row.key },
    }));
  }

  const grossMargin = grossProfit != null && revenue > 0 ? grossProfit / revenue : null;
  const warnings = Array.isArray(forward.risks) ? forward.risks.filter(Boolean).slice(0, 5) : [];
  if (modelFamily !== forward.model_family) {
    warnings.unshift(`PCC selected ${model.replaceAll(" ", "-")} from reported SEC profitability and industry facts instead of the generated model family.`);
  }
  if (common.diluted_shares > basicShares * 1.05) {
    warnings.unshift(`Known dilution increases the modeled share count by ${rounded((common.diluted_shares / basicShares - 1) * 100, 1)}%.`);
  }
  if (scenarios.some((row) => row.inputs?.revenue_anchor_applied)) {
    warnings.unshift("Year-1 revenue was anchored to the latest reported SEC revenue because the extracted forward input was materially lower.");
  }
  if (scenarios.some((row) => row.inputs?.terminal_margin_floor_applied)) {
    warnings.unshift("A visible long-run FCF margin floor was applied because the extracted transition case never reached sustainable cash generation.");
  }
  if (balance.adjustments.length) warnings.unshift(`${balance.adjustments.length} sourced post-period balance adjustment${balance.adjustments.length === 1 ? " was" : "s were"} applied to SEC liquid assets and debt.`);
  if (scenarioEnvelopeApplied) warnings.unshift("Scenario labels were reordered by calculated value after PCC normalized inconsistent Bear/Base/Bull inputs.");
  if (sharesGrowth != null && sharesGrowth > 0.1) warnings.push(`Reported share count increased ${(sharesGrowth * 100).toFixed(1)}% year over year.`);
  if (forward.evidence_quality === "LOW") warnings.unshift("Forward evidence is incomplete; treat the range as provisional.");

  const baseValue = scenarios[1].fair_value;
  const baseInputs = scenarios[1].inputs || {};
  const generatedStage = String(forward.company_stage || "").toUpperCase();
  const stage = modelFamily === "excess_return"
    ? "FINANCIAL"
    : modelFamily === "transition_dcf"
      ? (/LOSS|TRANSITION/.test(generatedStage) ? generatedStage : "LOSS-MAKING TRANSITION")
      : "CASH-GENERATIVE";
  return {
    model_version: "forward-intrinsic-v5",
    model,
    stage,
    confidence: ["HIGH", "MEDIUM", "LOW"].includes(String(forward.evidence_quality || "").toUpperCase())
      ? String(forward.evidence_quality).toUpperCase()
      : "LOW",
    why: String(forward.rationale || "Forward assumptions are built from the latest available company filings and recalculated by PCC."),
    scenarios,
    assumptions: {
      horizon_years: finite(baseInputs.horizon_years) ?? 5,
      adjusted_cash: adjustedCash,
      adjusted_debt: adjustedDebt,
      diluted_shares: common.diluted_shares,
      base_revenue_year_1: finite(baseInputs.revenue_year_1),
      base_revenue_growth: finite(baseInputs.revenue_growth),
      base_fcf_margin_year_1: finite(baseInputs.fcf_margin_year_1),
      base_fcf_margin_year_5: finite(baseInputs.fcf_margin_year_5),
      base_fcf_margin_terminal: finite(baseInputs.fcf_margin_terminal),
      base_wacc: finite(baseInputs.wacc),
      base_terminal_growth: finite(baseInputs.terminal_growth),
    },
    market: {
      price,
      price_as_of: market.price_as_of || null,
      upside_to_base_percent: price > 0 ? rounded((baseValue / price - 1) * 100, 2) : null,
    },
    metrics: {
      revenue,
      revenue_growth: rounded(reportedRevenueGrowth, 4),
      gross_margin: rounded(grossMargin, 4),
      free_cash_flow: fcf,
      cash: reportedCash,
      short_term_investments: reportedInvestments,
      liquid_assets: balance.liquidAssets,
      debt: reportedDebt,
      shares_outstanding: basicShares,
      shares_growth: rounded(sharesGrowth, 4),
      forward_revenue: finite(baseInputs.revenue_year_1),
      forward_fcf_margin: finite(baseInputs.fcf_margin_year_5),
      diluted_shares: common.diluted_shares,
      adjusted_cash: adjustedCash,
      adjusted_debt: adjustedDebt,
      balance_adjustments: balance.adjustments,
    },
    forward: {
      as_of: forward.as_of || fundamentals.sec_filed_at || null,
      basis: String(forward.basis || "LATEST FILINGS"),
      sources: sourceRows.slice(0, 6),
    },
    warnings: [...new Set(warnings)].slice(0, 6),
    data_quality: {
      source: "SEC FILINGS + FORWARD ASSUMPTIONS",
      period_basis: fundamentals.period_basis || null,
      sec_form: fundamentals.sec_form || null,
      sec_filed_at: fundamentals.sec_filed_at || null,
      source_count: sourceRows.length,
    },
  };
}
