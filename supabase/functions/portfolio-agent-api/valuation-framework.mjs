const MAX_PER_SHARE_VALUE = 1_000_000_000;
const MAX_RAW_AMOUNT = 1_000_000_000_000_000;
const VALUE_TOLERANCE = 0.011;

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function text(value, label, maxLength = 1600) {
  const result = String(value || "").trim();
  if (!result) throw new Error(`${label} is required`);
  if (result.length > maxLength) throw new Error(`${label} must be ${maxLength} characters or fewer`);
  return result;
}

function number(value, label, { min = 0, max = MAX_RAW_AMOUNT } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a finite number from ${min} to ${max}`);
  }
  return value;
}

function ordered(bear, base, bull, label) {
  if (bear > base || base > bull) throw new Error(`${label} must be ordered Bear <= Base <= Bull`);
}

function close(actual, expected, label) {
  if (Math.abs(actual - expected) > VALUE_TOLERANCE) throw new Error(`${label}`);
}

function scenarioValues(value, label, options) {
  const row = object(value, label);
  const limits = options || { min: 0, max: MAX_PER_SHARE_VALUE };
  const bearValue = number(row.bear_value, `${label}.bear_value`, limits);
  const baseValue = number(row.base_value, `${label}.base_value`, limits);
  const bullValue = number(row.bull_value, `${label}.bull_value`, limits);
  ordered(bearValue, baseValue, bullValue, label);
  return { bear_value: bearValue, base_value: baseValue, bull_value: bullValue };
}

export function validateOptionalityValuationFramework(value, topLevel = {}) {
  const framework = object(value, "completed_valuation.valuation_framework");
  if (framework.framework_version !== 1) {
    throw new Error("completed_valuation.valuation_framework.framework_version must be 1");
  }
  if (framework.type !== "core_optionality") {
    throw new Error("completed_valuation.valuation_framework.type must be core_optionality");
  }

  const core = object(framework.core_business, "completed_valuation.valuation_framework.core_business");
  const coreValues = scenarioValues(core, "completed_valuation.valuation_framework.core_business");
  const coreBusiness = {
    label: text(core.label, "completed_valuation.valuation_framework.core_business.label", 160),
    method: text(core.method, "completed_valuation.valuation_framework.core_business.method", 500),
    summary: text(core.summary, "completed_valuation.valuation_framework.core_business.summary", 2400),
    ...coreValues,
  };

  if (!Array.isArray(framework.optionality) || framework.optionality.length < 1 || framework.optionality.length > 12) {
    throw new Error("completed_valuation.valuation_framework.optionality must contain 1-12 components");
  }
  const optionality = framework.optionality.map((value, index) => {
    const label = `completed_valuation.valuation_framework.optionality[${index}]`;
    const component = object(value, label);
    const successValue = number(component.success_value_per_share, `${label}.success_value_per_share`, { min: 0, max: MAX_PER_SHARE_VALUE });
    const probabilityBear = number(component.probability_bear, `${label}.probability_bear`, { min: 0, max: 1 });
    const probabilityBase = number(component.probability_base, `${label}.probability_base`, { min: 0, max: 1 });
    const probabilityBull = number(component.probability_bull, `${label}.probability_bull`, { min: 0, max: 1 });
    ordered(probabilityBear, probabilityBase, probabilityBull, `${label} probabilities`);
    const values = scenarioValues(component, label);
    close(values.bear_value, successValue * probabilityBear, `${label}.bear_value must equal success_value_per_share x probability_bear`);
    close(values.base_value, successValue * probabilityBase, `${label}.base_value must equal success_value_per_share x probability_base`);
    close(values.bull_value, successValue * probabilityBull, `${label}.bull_value must equal success_value_per_share x probability_bull`);
    if (component.included_in_base === false && values.base_value !== 0) {
      throw new Error(`${label}.base_value must be zero when included_in_base is false`);
    }
    return {
      name: text(component.name, `${label}.name`, 160),
      status: text(component.status, `${label}.status`, 120),
      summary: text(component.summary, `${label}.summary`, 2400),
      success_value_per_share: successValue,
      probability_bear: probabilityBear,
      probability_base: probabilityBase,
      probability_bull: probabilityBull,
      ...values,
      included_in_base: component.included_in_base !== false,
    };
  });

  const funding = object(framework.funding_dilution, "completed_valuation.valuation_framework.funding_dilution");
  const basicShares = number(funding.basic_shares, "completed_valuation.valuation_framework.funding_dilution.basic_shares", { min: Number.EPSILON });
  const coreDilutedShares = number(funding.core_diluted_shares, "completed_valuation.valuation_framework.funding_dilution.core_diluted_shares", { min: Number.EPSILON });
  const maximumDilutedShares = number(funding.maximum_diluted_shares, "completed_valuation.valuation_framework.funding_dilution.maximum_diluted_shares", { min: Number.EPSILON });
  if (basicShares > coreDilutedShares) throw new Error("completed_valuation.valuation_framework.funding_dilution.basic_shares cannot exceed core_diluted_shares");
  if (coreDilutedShares > maximumDilutedShares) throw new Error("completed_valuation.valuation_framework.funding_dilution.core_diluted_shares cannot exceed maximum_diluted_shares");
  const bearAdjustment = number(funding.bear_adjustment, "completed_valuation.valuation_framework.funding_dilution.bear_adjustment", { min: -MAX_PER_SHARE_VALUE, max: 0 });
  const baseAdjustment = number(funding.base_adjustment, "completed_valuation.valuation_framework.funding_dilution.base_adjustment", { min: -MAX_PER_SHARE_VALUE, max: 0 });
  const bullAdjustment = number(funding.bull_adjustment, "completed_valuation.valuation_framework.funding_dilution.bull_adjustment", { min: -MAX_PER_SHARE_VALUE, max: 0 });
  const fundingDilution = {
    summary: text(funding.summary, "completed_valuation.valuation_framework.funding_dilution.summary", 2400),
    basic_shares: basicShares,
    core_diluted_shares: coreDilutedShares,
    maximum_diluted_shares: maximumDilutedShares,
    funding_required: number(funding.funding_required, "completed_valuation.valuation_framework.funding_dilution.funding_required"),
    bear_adjustment: bearAdjustment,
    base_adjustment: baseAdjustment,
    bull_adjustment: bullAdjustment,
  };

  if (!Array.isArray(framework.milestones) || framework.milestones.length < 1 || framework.milestones.length > 20) {
    throw new Error("completed_valuation.valuation_framework.milestones must contain 1-20 items");
  }
  const milestones = framework.milestones.map((value, index) => {
    const label = `completed_valuation.valuation_framework.milestones[${index}]`;
    const milestone = object(value, label);
    return {
      name: text(milestone.name, `${label}.name`, 200),
      status: text(milestone.status, `${label}.status`, 120),
      required_for: text(milestone.required_for, `${label}.required_for`, 300),
      impact: text(milestone.impact, `${label}.impact`, 1200),
      evidence: text(milestone.evidence, `${label}.evidence`, 1200),
    };
  });

  const combined = scenarioValues(framework.combined, "completed_valuation.valuation_framework.combined");
  const optionBear = optionality.reduce((sum, item) => sum + item.bear_value, 0);
  const optionBase = optionality.reduce((sum, item) => sum + item.base_value, 0);
  const optionBull = optionality.reduce((sum, item) => sum + item.bull_value, 0);
  close(combined.bear_value, coreBusiness.bear_value + optionBear + fundingDilution.bear_adjustment, "completed_valuation.valuation_framework.combined.bear_value must equal core + optionality + funding/dilution adjustment");
  close(combined.base_value, coreBusiness.base_value + optionBase + fundingDilution.base_adjustment, "completed_valuation.valuation_framework.combined.base_value must equal core + optionality + funding/dilution adjustment");
  close(combined.bull_value, coreBusiness.bull_value + optionBull + fundingDilution.bull_adjustment, "completed_valuation.valuation_framework.combined.bull_value must equal core + optionality + funding/dilution adjustment");

  if (topLevel.bearValue != null) close(Number(topLevel.bearValue), combined.bear_value, "completed_valuation.bear_value must equal valuation_framework.combined.bear_value");
  if (topLevel.baseValue != null) close(Number(topLevel.baseValue), combined.base_value, "completed_valuation.base_value must equal valuation_framework.combined.base_value");
  if (topLevel.bullValue != null) close(Number(topLevel.bullValue), combined.bull_value, "completed_valuation.bull_value must equal valuation_framework.combined.bull_value");

  return {
    framework_version: 1,
    type: "core_optionality",
    core_business: coreBusiness,
    optionality,
    funding_dilution: fundingDilution,
    milestones,
    combined,
  };
}
