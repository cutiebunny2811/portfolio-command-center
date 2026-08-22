import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const agentApi = readFileSync(new URL("../supabase/functions/portfolio-agent-api/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260822050000_valuation_research_workflow.sql", import.meta.url), "utf8");

test("Valuation is the fourth Watchlist view and reads durable research revisions", () => {
  assert.match(app, /data-view="valuation"><span>04<\/span>Valuation/);
  assert.match(app, /api_get_valuation_research/);
  assert.match(app, /api_request_valuation_research/);
  assert.match(app, /HERMES RESEARCH BRIEF/);
  assert.match(app, /ยังไม่มี research revision สำหรับหุ้นตัวนี้/);
  assert.doesNotMatch(app, /Explain the range|explainCompanyValuation/);
});

test("PCC creates jobs, polls active work and keeps the previous revision readable", () => {
  assert.match(app, /\["queued", "researching"\]/);
  assert.match(app, /scheduleValuationResearchPoll/);
  assert.match(app, /15_000/);
  assert.match(app, /revision\?\.valuation/);
  assert.match(app, /Research in progress/);
  assert.match(app, /is ready to read/);
});

test("the workflow stores per-member jobs and numbered revisions", () => {
  assert.match(migration, /create table if not exists public\.valuation_research_jobs/);
  assert.match(migration, /create table if not exists public\.valuation_research_revisions/);
  assert.match(migration, /where status in \('queued', 'researching'\)/);
  assert.match(migration, /claim_expires_at = now\(\) \+ interval '45 minutes'/);
  assert.match(migration, /revision_no/);
  assert.match(migration, /valuation_research_revisions_select_own/);
  assert.match(migration, /notification_type[\s\S]*valuation_research/);
});

test("Ian submits assumptions while PCC alone calculates Bear, Base and Bull", () => {
  assert.match(agentApi, /validateValuationResearchPacket/);
  assert.match(agentApi, /buildValuation\(\{/);
  assert.match(agentApi, /api_agent_submit_valuation_research/);
  assert.match(agentApi, /stored_as: "draft"/);
  assert.doesNotMatch(agentApi, /p_fair_value|body\.fair_value/);
  assert.match(agentApi, /one Bear, Base and Bull case/);
});

test("new and existing Hermes tokens receive the narrow valuation write scope", () => {
  assert.match(app, /"briefings:write", "valuation:write"/);
  assert.match(migration, /'valuation:write' = any\(token\.scopes\)/);
  assert.match(migration, /array_append\(scopes, 'valuation:write'\)/);
});

test("mobile Valuation recomposes research, scenarios and source ledger into one column", () => {
  assert.match(css, /\.valuation-workbench \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /\.valuation-cases \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /\.valuation-research \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /\.valuation-research__points \{ grid-column: 1; grid-template-columns: 1fr; \}/);
  assert.match(css, /\.valuation-source \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /\.valuation-rail \.watchlist-list \{ height: auto; max-height: 280px; \}/);
});

test("valuation UI exposes the model horizon, balance basis and saved Thai brief", () => {
  assert.match(app, /FCF margin · Y1 → Y\$\{valuationHorizon\}/);
  assert.match(app, /Modeled liquid assets \/ debt/);
  assert.match(app, /Ian สรุปหลักฐานและสมมติฐาน/);
  assert.match(app, /SAVED TO SUPABASE/);
});

test("saved valuation revisions render with an existing timestamp formatter", () => {
  assert.match(app, /smartMoneyDate\(revision\.submitted_at, true\)/);
  assert.doesNotMatch(app, /dateLabel\(revision\.submitted_at\)/);
});
