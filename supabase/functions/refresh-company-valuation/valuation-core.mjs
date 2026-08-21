const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
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

function scenarioRow(packet, fairValue, model, assumption) {
  return {
    key: packet.key,
    label: packet.key === "bear" ? "Bear" : packet.key === "bull" ? "Bull" : "Base",
    fair_value: rounded(fairValue),
    method: model,
    assumption,
    inputs: {
      revenue_year_1: rounded(packet.revenue_year_1, 0),
      revenue_growth: rounded(packet.revenue_growth, 4),
      fcf_margin_year_1: rounded(packet.fcf_margin_year_1, 4),
      fcf_margin_year_5: rounded(packet.fcf_margin_year_5, 4),
      wacc: rounded(packet.wacc, 4),
      terminal_growth: rounded(packet.terminal_growth, 4),
      diluted_shares: rounded(packet.diluted_shares, 0),
    },
  };
}

function normalizedScenario(raw, common, key) {
  const defaultGrowth = key === "bear" ? 0.04 : key === "bull" ? 0.16 : 0.1;
  const defaultWacc = key === "bear" ? 0.12 : key === "bull" ? 0.085 : 0.1;
  const defaultTerminal = key === "bear" ? 0.015 : key === "bull" ? 0.03 : 0.025;
  const revenueYearOne = clamp(finite(raw?.revenue_year_1) ?? finite(common.revenue_year_1) ?? 0, 0, common.revenue_cap);
  const dilutedShares = clamp(finite(raw?.diluted_shares) ?? finite(common.diluted_shares) ?? 0, common.basic_shares, common.share_cap);
  const wacc = clamp(finite(raw?.wacc) ?? defaultWacc, 0.07, 0.2);
  return {
    key,
    revenue_year_1: revenueYearOne,
    revenue_growth: clamp(finite(raw?.revenue_growth) ?? defaultGrowth, -0.25, 0.6),
    fcf_margin_year_1: clamp(finite(raw?.fcf_margin_year_1) ?? finite(common.fcf_margin_year_1) ?? 0, -0.75, 0.55),
    fcf_margin_year_5: clamp(finite(raw?.fcf_margin_year_5) ?? finite(common.fcf_margin_year_5) ?? 0.1, -0.25, 0.55),
    wacc,
    terminal_growth: Math.min(clamp(finite(raw?.terminal_growth) ?? defaultTerminal, 0, 0.04), wacc - 0.025),
    diluted_shares: dilutedShares,
  };
}

function forwardDcf(packet, adjustedCash, adjustedDebt) {
  let presentValue = 0;
  let revenue = packet.revenue_year_1;
  let finalFcf = 0;
  for (let year = 1; year <= 5; year += 1) {
    if (year > 1) revenue *= 1 + packet.revenue_growth;
    const progress = (year - 1) / 4;
    const margin = packet.fcf_margin_year_1 + (packet.fcf_margin_year_5 - packet.fcf_margin_year_1) * progress;
    finalFcf = revenue * margin;
    presentValue += finalFcf / ((1 + packet.wacc) ** year);
  }
  const terminal = finalFcf > 0
    ? finalFcf * (1 + packet.terminal_growth) / (packet.wacc - packet.terminal_growth)
    : 0;
  return presentValue + terminal / ((1 + packet.wacc) ** 5) + adjustedCash - adjustedDebt;
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
  const netIncome = finite(fundamentals.net_income_ttm) ?? finite(fundamentals.net_income_fy) ?? 0;
  const fcf = finite(fundamentals.free_cash_flow_ttm) ?? finite(fundamentals.free_cash_flow_fy) ?? 0;
  const grossProfit = finite(fundamentals.gross_profit_ttm) ?? finite(fundamentals.gross_profit_fy);
  const reportedCash = Math.max(finite(fundamentals.cash) ?? 0, 0);
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

  const balanceScale = Math.max(revenue, reportedCash, reportedDebt, 1_000_000);
  const adjustedCash = clamp(finite(forward.adjusted_cash) ?? reportedCash, 0, balanceScale * 5);
  const adjustedDebt = clamp(finite(forward.adjusted_debt) ?? reportedDebt, 0, balanceScale * 5);
  const common = {
    revenue_year_1: clamp(finite(forward.revenue_year_1) ?? 0, 0, Math.max(revenue * 20, 5_000_000)),
    fcf_margin_year_1: finite(forward.fcf_margin_year_1),
    fcf_margin_year_5: finite(forward.fcf_margin_year_5),
    diluted_shares: clamp(finite(forward.diluted_shares) ?? basicShares, basicShares, basicShares * 10),
    basic_shares: basicShares,
    share_cap: basicShares * 10,
    revenue_cap: Math.max(revenue * 20, 5_000_000),
  };
  const rawScenarios = new Map((Array.isArray(forward.scenarios) ? forward.scenarios : []).map((row) => [String(row?.key || "").toLowerCase(), row]));
  const keys = ["bear", "base", "bull"];
  let scenarios;
  let model;

  if (forward.model_family === "excess_return") {
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
    model = forward.model_family === "normalized_dcf" ? "NORMALIZED FORWARD DCF" : "REVENUE-TO-FCF DCF";
    scenarios = keys.map((key) => {
      const packet = normalizedScenario(rawScenarios.get(key), common, key);
      if (!(packet.revenue_year_1 > 0)) throw new Error(`${key} case does not provide usable forward revenue.`);
      if (!(packet.diluted_shares >= basicShares)) throw new Error(`${key} case diluted shares are below reported basic shares.`);
      const fairValue = perShare(forwardDcf(packet, adjustedCash, adjustedDebt), packet.diluted_shares);
      return scenarioRow(
        packet,
        fairValue,
        model,
        `${rounded(packet.revenue_growth * 100, 1)}% growth · ${rounded(packet.fcf_margin_year_5 * 100, 1)}% year-5 FCF margin`,
      );
    });
  }

  if (scenarios.some((row) => !Number.isFinite(row.fair_value))) {
    throw new Error("Forward assumptions are not sufficient to calculate all three valuation cases.");
  }
  if (!(scenarios[0].fair_value <= scenarios[1].fair_value && scenarios[1].fair_value <= scenarios[2].fair_value)) {
    throw new Error("Forward cases are internally inconsistent: Bear, Base and Bull are not ordered.");
  }

  const grossMargin = grossProfit != null && revenue > 0 ? grossProfit / revenue : null;
  const warnings = Array.isArray(forward.risks) ? forward.risks.filter(Boolean).slice(0, 5) : [];
  if (common.diluted_shares > basicShares * 1.05) {
    warnings.unshift(`Known dilution increases the modeled share count by ${rounded((common.diluted_shares / basicShares - 1) * 100, 1)}%.`);
  }
  if (sharesGrowth != null && sharesGrowth > 0.1) warnings.push(`Reported share count increased ${(sharesGrowth * 100).toFixed(1)}% year over year.`);
  if (forward.evidence_quality === "LOW") warnings.unshift("Forward evidence is incomplete; treat the range as provisional.");

  const baseValue = scenarios[1].fair_value;
  const baseInputs = scenarios[1].inputs || {};
  return {
    model_version: "forward-intrinsic-v1",
    model,
    stage: String(forward.company_stage || (fcf > 0 && netIncome > 0 ? "CASH-GENERATIVE" : "FORWARD TRANSITION")).toUpperCase(),
    confidence: ["HIGH", "MEDIUM", "LOW"].includes(String(forward.evidence_quality || "").toUpperCase())
      ? String(forward.evidence_quality).toUpperCase()
      : "LOW",
    why: String(forward.rationale || "Forward assumptions are built from the latest available company filings and recalculated by PCC."),
    scenarios,
    assumptions: {
      horizon_years: 5,
      adjusted_cash: adjustedCash,
      adjusted_debt: adjustedDebt,
      diluted_shares: common.diluted_shares,
      base_revenue_year_1: finite(baseInputs.revenue_year_1),
      base_revenue_growth: finite(baseInputs.revenue_growth),
      base_fcf_margin_year_1: finite(baseInputs.fcf_margin_year_1),
      base_fcf_margin_year_5: finite(baseInputs.fcf_margin_year_5),
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
      debt: reportedDebt,
      shares_outstanding: basicShares,
      shares_growth: rounded(sharesGrowth, 4),
      forward_revenue: finite(baseInputs.revenue_year_1),
      forward_fcf_margin: finite(baseInputs.fcf_margin_year_5),
      diluted_shares: common.diluted_shares,
      adjusted_cash: adjustedCash,
      adjusted_debt: adjustedDebt,
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
