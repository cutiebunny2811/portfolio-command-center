import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import fxLedger from "../fx-ledger.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260821050000_portfolio_fx_ledger.sql", import.meta.url), "utf8");
const edge = readFileSync(new URL("../supabase/functions/refresh-fx-rate/index.ts", import.meta.url), "utf8");

test("weighted FX ledger adds deposits and realizes withdrawals without changing the remaining average", () => {
  const summary = fxLedger.calculate({
    profile: {
      portfolio_id: "p1",
      opening_usd_balance: 1000,
      opening_thb_basis: 34000,
      opening_rate: 34,
      effective_at: "2026-08-01T00:00:00Z",
    },
    liveRate: 33,
    entries: [
      { id: "d1", portfolio_id: "p1", direction: "deposit", usd_amount: 500, thb_amount: 16000, occurred_at: "2026-08-02T00:00:00Z" },
      { id: "w1", portfolio_id: "p1", direction: "withdrawal", usd_amount: 300, thb_amount: 10500, occurred_at: "2026-08-03T00:00:00Z" },
    ],
  });

  assert.equal(summary.usdBalance, 1200);
  assert.ok(Math.abs(summary.averageRate - 33.333333333333336) < 1e-10);
  assert.ok(Math.abs(summary.realizedPnl - 500) < 1e-10);
  assert.ok(Math.abs(summary.unrealizedPnl + 400) < 1e-10);
  assert.equal(summary.timeline[1].average_after, summary.timeline[0].average_after);
});

test("entries before the opening snapshot are excluded", () => {
  const summary = fxLedger.calculate({
    profile: { portfolio_id: "p1", opening_usd_balance: 250, opening_thb_basis: 8000, opening_rate: 32, effective_at: "2026-08-10T00:00:00Z" },
    entries: [{ portfolio_id: "p1", direction: "deposit", usd_amount: 100, thb_amount: 3000, occurred_at: "2026-08-09T00:00:00Z" }],
    liveRate: 33,
  });
  assert.equal(summary.usdBalance, 250);
  assert.equal(summary.timeline.length, 0);
});

test("cash confirmation captures prepared THB conversion atomically", () => {
  assert.match(migration, /create table if not exists public\.portfolio_fx_profiles/);
  assert.match(migration, /create table if not exists public\.portfolio_fx_entries/);
  assert.match(migration, /create trigger cash_movements_capture_fx[\s\S]*after insert on public\.cash_movements/i);
  assert.match(migration, /user_id = auth\.uid\(\)/);
  assert.match(migration, /when 'long term' then 33\.8080/);
  assert.match(migration, /when 'swing trade' then 31\.3139/);
  assert.match(migration, /when 'options' then 31\.6564/);
  assert.match(app, /api_prepare_cash_fx/);
  assert.match(app, /Net amount \(THB\)/);
  assert.match(app, /Calculated from THB ÷ USD/);
});

test("history adds a responsive FX tab without another portfolio page", () => {
  assert.match(app, /data-history-view="fx"/);
  assert.match(app, /fxHistoryDialogMarkup/);
  assert.match(css, /\.fx-summary\s*\{/);
  assert.match(css, /\.fx-history-table/);
  assert.match(html, /fx-ledger\.js/);
});

test("live USD THB rate is cached through an authenticated edge function", () => {
  assert.match(edge, /client\.auth\.getUser\(\)/);
  assert.match(edge, /https:\/\/open\.er-api\.com\/v6\/latest\/USD/);
  assert.match(edge, /fx_market_rates/);
  assert.match(edge, /rates\?\.THB/);
});
