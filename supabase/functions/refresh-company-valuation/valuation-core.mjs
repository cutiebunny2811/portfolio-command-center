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

function dcfEquityValue({ fcf, growth, wacc, terminalGrowth, cash, debt }) {
  let presentValue = 0;
  let projected = fcf;
  for (let year = 1; year <= 5; year += 1) {
    projected *= 1 + growth;
    presentValue += projected / ((1 + wacc) ** year);
  }
  const terminal = projected * (1 + terminalGrowth) / Math.max(wacc - terminalGrowth, 0.025);
  return presentValue + terminal / ((1 + wacc) ** 5) + cash - debt;
}

function scenario(key, label, fairValue, method, assumption) {
  return { key, label, fair_value: rounded(fairValue), method, assumption };
}

export function buildValuation(input = {}) {
  const fundamentals = input.fundamentals || {};
  const market = input.market || {};
  const revenue = finite(fundamentals.revenue_ttm) ?? finite(fundamentals.revenue_fy) ?? 0;
  const netIncome = finite(fundamentals.net_income_ttm) ?? finite(fundamentals.net_income_fy) ?? 0;
  const operatingIncome = finite(fundamentals.operating_income_ttm) ?? finite(fundamentals.operating_income_fy) ?? 0;
  const fcf = finite(fundamentals.free_cash_flow_ttm) ?? finite(fundamentals.free_cash_flow_fy) ?? 0;
  const grossProfit = finite(fundamentals.gross_profit_ttm) ?? finite(fundamentals.gross_profit_fy);
  const cash = Math.max(finite(fundamentals.cash) ?? 0, 0);
  const debt = Math.max(finite(fundamentals.debt) ?? 0, 0);
  const equity = finite(fundamentals.stockholders_equity);
  const shares = finite(fundamentals.shares_outstanding);
  const reportedRevenueGrowth = finite(fundamentals.revenue_growth) ?? 0;
  const revenueGrowth = clamp(reportedRevenueGrowth, -0.5, 1.5);
  const sharesGrowth = finite(fundamentals.shares_growth);
  const sic = Math.trunc(finite(fundamentals.sic) ?? 0);
  const companyText = `${fundamentals.company_name || ""} ${fundamentals.sic_description || ""}`.toLowerCase();
  const price = finite(market.price);

  if (!(shares > 0)) throw new Error("SEC did not provide a usable common-share count for this company.");

  const grossMargin = grossProfit != null && revenue > 0 ? grossProfit / revenue : null;
  const netMargin = revenue > 0 ? netIncome / revenue : null;
  const cashBurn = fcf < 0 ? Math.abs(fcf) : 0;
  const runwayMonths = cashBurn > 0 ? cash / cashBurn * 12 : null;
  const isReit = /reit|real estate investment trust/.test(companyText);
  const isFinancial = !isReit && sic >= 6000 && sic <= 6799;
  const isPreRevenue = revenue <= 1_000_000;
  const warnings = [];
  if (netIncome <= 0) warnings.push("P/E disabled: earnings are not positive.");
  if (fcf < 0) warnings.push("Free cash flow is negative.");
  if (runwayMonths != null && runwayMonths < 18) warnings.push(`Cash runway is about ${Math.max(Math.round(runwayMonths), 0)} months at the latest reported burn rate.`);
  if (sharesGrowth != null && sharesGrowth > 0.1) warnings.push(`Share count increased ${(sharesGrowth * 100).toFixed(1)}% year over year.`);
  if (reportedRevenueGrowth > 1.5) warnings.unshift(`Reported revenue growth is ${(reportedRevenueGrowth * 100).toFixed(1)}%; the valuation input is capped at 150.0%.`);

  let model;
  let stage;
  let why;
  let scenarios;
  const assumptions = {};

  if ((isFinancial || isReit) && equity != null && equity > 0) {
    const bookValuePerShare = equity / shares;
    const roe = netIncome / equity;
    const baseMultiple = clamp(0.85 + Math.max(roe, -0.1) * 5, 0.55, 2.4);
    model = isReit ? "NAV PROXY / P-B" : "P-B / ROE";
    stage = isReit ? "ASSET-BACKED" : "FINANCIAL";
    why = isReit
      ? "Ordinary P/E and industrial DCF are not the cleanest fit; PCC uses reported book value as a conservative NAV proxy."
      : "Debt is part of the operating model, so PCC values reported equity through book value and ROE.";
    assumptions.book_value_per_share = rounded(bookValuePerShare);
    assumptions.base_price_to_book = rounded(baseMultiple, 2);
    scenarios = [
      scenario("bear", "Bear", bookValuePerShare * Math.max(baseMultiple * 0.7, 0.4), model, `${rounded(Math.max(baseMultiple * 0.7, 0.4), 2)}x book`),
      scenario("base", "Base", bookValuePerShare * baseMultiple, model, `${rounded(baseMultiple, 2)}x book`),
      scenario("bull", "Bull", bookValuePerShare * Math.min(baseMultiple * 1.35, 3.2), model, `${rounded(Math.min(baseMultiple * 1.35, 3.2), 2)}x book`),
    ];
  } else if (isPreRevenue) {
    const netCashPerShare = Math.max(cash - debt, 0) / shares;
    model = "NET CASH / RUNWAY";
    stage = "PRE-REVENUE";
    why = "Revenue is not established, so PCC anchors to net cash and runway instead of inventing an earnings multiple.";
    assumptions.net_cash_per_share = rounded(netCashPerShare);
    scenarios = [
      scenario("bear", "Bear", Math.max(netCashPerShare * 0.55, 0.01), model, "0.55x net cash"),
      scenario("base", "Base", Math.max(netCashPerShare, 0.01), model, "1.00x net cash"),
      scenario("bull", "Bull", Math.max(netCashPerShare * 1.6, 0.01), model, "1.60x net cash + milestone value"),
    ];
  } else if (fcf > 0 && netIncome > 0) {
    const baseGrowth = clamp(revenueGrowth, 0.03, 0.2);
    model = "FCF DCF";
    stage = "CASH-GENERATIVE";
    why = "Positive earnings and free cash flow make a discounted cash-flow range usable.";
    assumptions.base_growth = rounded(baseGrowth, 3);
    assumptions.base_wacc = 0.1;
    assumptions.base_terminal_growth = 0.025;
    scenarios = [
      scenario("bear", "Bear", perShare(dcfEquityValue({ fcf, growth: Math.max(baseGrowth - 0.06, 0), wacc: 0.12, terminalGrowth: 0.015, cash, debt }), shares), model, "12% WACC · 1.5% terminal"),
      scenario("base", "Base", perShare(dcfEquityValue({ fcf, growth: baseGrowth, wacc: 0.1, terminalGrowth: 0.025, cash, debt }), shares), model, "10% WACC · 2.5% terminal"),
      scenario("bull", "Bull", perShare(dcfEquityValue({ fcf, growth: Math.min(baseGrowth + 0.06, 0.28), wacc: 0.085, terminalGrowth: 0.03, cash, debt }), shares), model, "8.5% WACC · 3.0% terminal"),
    ];
  } else if (operatingIncome > 0) {
    model = "EV / OPERATING INCOME";
    stage = netIncome > 0 ? "PROFITABLE" : "EARNINGS TRANSITION";
    why = "Operations are profitable but free cash flow is not yet stable enough for a standard DCF.";
    assumptions.base_multiple = 12;
    scenarios = [
      scenario("bear", "Bear", perShare(operatingIncome * 8 + cash - debt, shares), model, "8x operating income"),
      scenario("base", "Base", perShare(operatingIncome * 12 + cash - debt, shares), model, "12x operating income"),
      scenario("bull", "Bull", perShare(operatingIncome * 16 + cash - debt, shares), model, "16x operating income"),
    ];
  } else {
    const growthContribution = clamp(revenueGrowth * 5, -0.5, 3.5);
    const marginContribution = grossMargin == null ? 0.5 : clamp(grossMargin * 2.25, 0, 1.75);
    const baseMultiple = clamp(0.8 + growthContribution + marginContribution, 0.6, 7.5);
    const bearMultiple = Math.max(baseMultiple * 0.55, 0.4);
    const bullMultiple = Math.min(baseMultiple * 1.45, 10);
    model = "EV / SALES";
    stage = "LOSS-MAKING GROWTH";
    why = "Revenue is established while earnings and cash flow are negative, so P/E and standard DCF are disabled.";
    assumptions.base_ev_sales = rounded(baseMultiple, 2);
    assumptions.revenue_growth = rounded(revenueGrowth, 3);
    assumptions.gross_margin = rounded(grossMargin, 3);
    scenarios = [
      scenario("bear", "Bear", perShare(revenue * bearMultiple + cash - debt, shares), model, `${rounded(bearMultiple, 2)}x sales`),
      scenario("base", "Base", perShare(revenue * baseMultiple + cash - debt, shares), model, `${rounded(baseMultiple, 2)}x sales`),
      scenario("bull", "Bull", perShare(revenue * bullMultiple + cash - debt, shares), model, `${rounded(bullMultiple, 2)}x sales`),
    ];
  }

  const validScenarios = scenarios.filter((item) => Number.isFinite(item.fair_value));
  if (validScenarios.length !== 3) throw new Error("The reported SEC facts are not sufficient to calculate all three valuation cases.");
  const debtFloorCount = validScenarios.filter((item) => item.fair_value === 0).length;
  if (debtFloorCount) warnings.unshift(`Net debt absorbs the modeled enterprise value in ${debtFloorCount} scenario${debtFloorCount === 1 ? "" : "s"}.`);
  if (debtFloorCount === 3) why = "Reported net debt exceeds the modeled enterprise value in every case, so this method cannot support a positive common-equity value.";
  const completeness = [revenue > 0, shares > 0, finite(fundamentals.cash) != null, finite(fundamentals.debt) != null, finite(fundamentals.revenue_growth) != null, grossMargin != null]
    .filter(Boolean).length;
  const confidence = debtFloorCount === 3 || (runwayMonths != null && runwayMonths < 12) || (grossMargin != null && grossMargin < 0)
    ? "LOW"
    : completeness >= 5 ? "MEDIUM" : "LOW";
  const baseValue = validScenarios.find((item) => item.key === "base")?.fair_value ?? null;

  return {
    symbol: String(fundamentals.symbol || market.symbol || "").toUpperCase(),
    company_name: fundamentals.company_name || null,
    model,
    stage,
    confidence,
    why,
    scenarios: validScenarios,
    assumptions,
    warnings: warnings.slice(0, 4),
    market: {
      price: rounded(price),
      price_as_of: market.price_as_of || null,
      upside_to_base_percent: price > 0 && baseValue != null ? rounded((baseValue / price - 1) * 100, 2) : null,
    },
    metrics: {
      revenue,
      revenue_growth: rounded(reportedRevenueGrowth, 4),
      gross_margin: rounded(grossMargin, 4),
      net_income: netIncome,
      free_cash_flow: fcf,
      cash,
      debt,
      shares_outstanding: shares,
      shares_growth: rounded(sharesGrowth, 4),
      runway_months: rounded(runwayMonths, 1),
    },
    data_quality: {
      confidence,
      period_basis: fundamentals.period_basis || "LATEST_FY",
      sec_filed_at: fundamentals.sec_filed_at || null,
      sec_form: fundamentals.sec_form || null,
    },
  };
}
