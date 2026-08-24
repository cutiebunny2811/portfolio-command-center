import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateOptionalityValuationFramework } from "../supabase/functions/portfolio-agent-api/valuation-framework.mjs";

const agentApi = readFileSync(new URL("../supabase/functions/portfolio-agent-api/index.ts", import.meta.url), "utf8");
const mcp = readFileSync(new URL("../hermes-mcp/server.mjs", import.meta.url), "utf8");
const prompt = readFileSync(new URL("../hermes-mcp/BRIEFING_PROMPTS.md", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

function framework(overrides = {}) {
  return {
    framework_version: 1,
    type: "core_optionality",
    core_business: {
      label: "Launch + Space Systems",
      method: "EV/Sales plus transition FCF",
      summary: "Values the operating businesses already supported by reported revenue and backlog.",
      bear_value: 3,
      base_value: 5,
      bull_value: 8,
    },
    optionality: [{
      name: "Neutron",
      status: "pre-commercial",
      summary: "Probability-weighted launch and commercial cadence option.",
      success_value_per_share: 10,
      probability_bear: 0.1,
      probability_base: 0.3,
      probability_bull: 0.6,
      bear_value: 1,
      base_value: 3,
      bull_value: 6,
      included_in_base: true,
    }],
    funding_dilution: {
      summary: "Uses core and maximum diluted share counts and deducts expected funding pressure per share.",
      basic_shares: 100,
      core_diluted_shares: 120,
      maximum_diluted_shares: 150,
      funding_required: 300,
      bear_adjustment: -2,
      base_adjustment: -1,
      bull_adjustment: 0,
    },
    milestones: [{
      name: "Neutron qualification",
      status: "pending",
      required_for: "Base and Bull optionality",
      impact: "Raises probability only after qualification evidence is published.",
      evidence: "Company filings and launch updates",
    }],
    combined: { bear_value: 2, base_value: 7, bull_value: 14 },
    ...overrides,
  };
}

test("optionality framework accepts a fully reconciled valuation bridge", () => {
  const result = validateOptionalityValuationFramework(framework(), {
    bearValue: 2,
    baseValue: 7,
    bullValue: 14,
  });
  assert.equal(result.type, "core_optionality");
  assert.equal(result.optionality.length, 1);
  assert.equal(result.combined.base_value, 7);
});

test("optionality framework rejects a renamed standalone DCF with missing architecture", () => {
  assert.throws(
    () => validateOptionalityValuationFramework({ framework_version: 1, type: "core_optionality" }, { baseValue: 5 }),
    /core_business/,
  );
});

test("optionality framework rejects unreconciled combined values", () => {
  assert.throws(
    () => validateOptionalityValuationFramework(framework({ combined: { bear_value: 2, base_value: 9, bull_value: 14 } }), {
      bearValue: 2,
      baseValue: 9,
      bullValue: 14,
    }),
    /combined\.base_value must equal core \+ optionality \+ funding\/dilution adjustment/,
  );
});

test("optionality framework rejects invalid dilution ordering", () => {
  const value = framework();
  value.funding_dilution.core_diluted_shares = 90;
  assert.throws(
    () => validateOptionalityValuationFramework(value, { bearValue: 2, baseValue: 7, bullValue: 14 }),
    /basic_shares cannot exceed core_diluted_shares/,
  );
});

test("MCP, API and worker enforce the same optionality contract", () => {
  assert.match(mcp, /valuationFrameworkSchema/);
  assert.match(mcp, /pre_profit_optionality/);
  assert.match(agentApi, /validateOptionalityValuationFramework/);
  assert.match(agentApi, /completed_valuation\.valuation_framework is required/);
  assert.match(prompt, /Core business value/);
  assert.match(prompt, /Probability-weighted optionality/);
  assert.match(prompt, /Funding and dilution bridge/);
  assert.match(prompt, /Milestone ledger/);
  assert.match(prompt, /Do not submit a renamed standalone DCF/);
});

test("completed valuation UI renders the four-part framework and recomposes on mobile", () => {
  assert.match(app, /valuationFrameworkMarkup/);
  assert.match(app, /CORE BUSINESS/);
  assert.match(app, /PROBABILITY-WEIGHTED OPTIONALITY/);
  assert.match(app, /FUNDING \/ DILUTION/);
  assert.match(app, /MILESTONE LEDGER/);
  assert.match(css, /\.valuation-framework/);
  assert.match(css, /\.valuation-framework__grid/);
  assert.match(css, /\.valuation-framework__grid \{ grid-template-columns: 1fr; \}/);
});
