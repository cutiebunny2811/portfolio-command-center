import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const agentApi = readFileSync(new URL("../supabase/functions/portfolio-agent-api/index.ts", import.meta.url), "utf8");
const priceRefresh = readFileSync(new URL("../supabase/functions/refresh-stock-prices/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260822050000_valuation_research_workflow.sql", import.meta.url), "utf8");
const completedMigration = readFileSync(new URL("../supabase/migrations/20260823010000_ian_completed_valuation_revisions.sql", import.meta.url), "utf8");
const leaseMigration = readFileSync(new URL("../supabase/migrations/20260823040000_valuation_research_15_minute_lease.sql", import.meta.url), "utf8");
const worker = readFileSync(new URL("../scripts/pcc_valuation_research_worker.py", import.meta.url), "utf8");

test("Valuation is the fourth Watchlist view and reads durable research revisions", () => {
  assert.match(app, /data-view="valuation"><span>04<\/span>Valuation/);
  assert.match(app, /api_get_valuation_research/);
  assert.match(app, /api_request_valuation_research/);
  assert.match(app, /HERMES RESEARCH BRIEF/);
  assert.match(app, /ยังไม่มี research revision สำหรับหุ้นตัวนี้/);
  assert.doesNotMatch(app, /Explain the range|explainCompanyValuation/);
});

test("PCC creates jobs, polls active work and keeps the previous revision readable", () => {
  assert.match(app, /job\?\.status === "queued"/);
  assert.match(app, /job\?\.status !== "researching"/);
  assert.match(app, /Date\.parse\(job\.claim_expires_at \|\| ""\)/);
  assert.match(app, /expiry > Date\.now\(\)/);
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
  assert.match(migration, /claim_expires_at = now\(\) \+ interval '15 minutes'/);
  assert.match(leaseMigration, /create or replace function public\.api_agent_claim_valuation_research_job/);
  assert.match(leaseMigration, /claim_expires_at = now\(\) \+ interval '15 minutes'/);
  assert.match(migration, /revision_no/);
  assert.match(migration, /valuation_research_revisions_select_own/);
  assert.match(migration, /notification_type[\s\S]*valuation_research/);
});

test("Ian submits the completed report and valuation without PCC calculation", () => {
  assert.match(agentApi, /validateCompletedValuationResearch/);
  assert.match(agentApi, /action === "submit_completed_valuation_research"/);
  assert.match(agentApi, /api_agent_complete_valuation_research/);
  assert.match(agentApi, /Ian.s completed research and valuation were saved as a revision\./);
  const completedAction = agentApi.match(/if \(action === "submit_completed_valuation_research"\)([\s\S]*?)if \(action === "fail_valuation_research"\)/)?.[1] || "";
  assert.ok(completedAction);
  assert.doesNotMatch(completedAction, /buildValuation/);
  assert.match(agentApi, /typeof value !== "number"/);
  assert.match(agentApi, /typeof research\.schema_version !== "number"/);
  assert.match(agentApi, /completed_research\.brief\.base_case/);
  assert.match(agentApi, /brief: completedBrief/);
});

test("completed Ian revisions are additive, idempotent and recover expired leases", () => {
  assert.match(completedMigration, /completed_research jsonb/);
  assert.match(completedMigration, /completed_valuation jsonb/);
  assert.match(completedMigration, /research_format text not null default 'legacy_pcc_dcf'/);
  assert.match(completedMigration, /'legacy_pcc_dcf', 'ian_completed_v1'/);
  assert.match(completedMigration, /jsonb_typeof\(completed_research\) = 'object'/);
  assert.match(completedMigration, /jsonb_typeof\(completed_valuation\) = 'object'/);
  assert.match(completedMigration, /create or replace function public\.api_agent_complete_valuation_research/);
  assert.match(completedMigration, /p_report_period <> v_job\.request_period/);
  const completion = completedMigration.match(/create or replace function public\.api_agent_complete_valuation_research[\s\S]*?\$function\$;/)?.[0] || "";
  assert.ok(completion.indexOf("idempotency_key") < completion.indexOf("claim_expires_at"));
  assert.match(completedMigration, /status = 'queued'[\s\S]*claim_token = null[\s\S]*claim_expires_at = null/);
  assert.match(completedMigration, /requeued[^\n]*true/i);
});

test("Valuation exposes one Research action and renders new revisions with a legacy fallback", () => {
  assert.equal((app.match(/data-action="valuation-refresh"/g) || []).length, 1);
  assert.match(app, />Research<\/button>/);
  assert.match(app, /revision\?\.research_format === "ian_completed_v1"/);
  assert.match(app, /IAN RESEARCH ARCHIVE/);
  assert.match(app, /renderLegacyValuationRevision/);
  assert.match(app, /Previous Ian lease expired — press Research to return it to the queue\./);
  assert.match(app, /result\?\.requeued/);
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

test("completed Ian research uses a structured Thai brief and keeps the full report collapsible", () => {
  assert.match(app, /completedResearchBriefMarkup/);
  assert.match(app, /05 \/ HERMES RESEARCH BRIEF/);
  assert.match(app, /valuation-research__base/);
  assert.match(app, /สิ่งที่ต้องเกิด/);
  assert.match(app, /ความเสี่ยงหลัก/);
  assert.match(app, /<details class="valuation-completed-report"/);
  assert.match(app, /เปิดรายงานฉบับเต็ม/);
  assert.match(app, /research\.brief/);
});

test("completed valuation keeps the decision surface concise and folds the audit method", () => {
  assert.match(app, /function valuationMethodLabel\(/);
  assert.match(app, /Core \+ Optionality/);
  assert.match(app, /<details class="valuation-method-report"/);
  assert.match(app, /เปิดวิธีคำนวณฉบับเต็ม/);
  assert.match(app, /valuation-method-report__body/);
  assert.match(css, /\.valuation-method-report summary/);
  assert.match(css, /\.valuation-method-report__body \.valuation-method-grid p/);
});

test("the no-agent watchdog launches one hidden bounded Ian worker before Hermes' 120 second cron limit", () => {
  assert.match(worker, /ACTIVE_LOCK/);
  assert.match(worker, /worker_is_active/);
  assert.match(worker, /subprocess\.Popen/);
  assert.match(worker, /OpenProcess/);
  assert.match(worker, /GetExitCodeProcess/);
  assert.match(worker, /CREATE_NO_WINDOW/);
  assert.match(worker, /--run-claimed-job/);
  assert.match(worker, /timeout=720/);
  assert.match(worker, /fail_unfinished_job/);
});

test("research queues even when the best-effort Webull quote refresh fails", () => {
  assert.match(app, /async function refreshValuationMarketPrice\(instrumentId\)/);
  assert.match(app, /action: "valuation_quote", instrument_id: instrumentId/);
  assert.match(app, /try \{[\s\S]*await refreshValuationMarketPrice\(instrumentId\);[\s\S]*\} catch \(priceError\) \{[\s\S]*console\.warn\("Valuation quote refresh skipped", priceError\);[\s\S]*\}[\s\S]*api_request_valuation_research/);
  assert.match(priceRefresh, /body\?\.action === "valuation_quote"/);
  assert.match(priceRefresh, /from\("watchlist_items"\)[\s\S]*eq\("instrument_id", instrumentId\)/);
  assert.match(priceRefresh, /const snapshot = await fetchSnapshot\(instrument as Instrument\)/);
  assert.match(priceRefresh, /p_source: "webull"/);
  assert.match(priceRefresh, /price: snapshot\.price/);
});
