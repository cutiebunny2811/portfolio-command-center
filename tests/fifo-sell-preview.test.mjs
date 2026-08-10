import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../supabase/migrations/20260811090000_fifo_sell_preview.sql", import.meta.url), "utf8");
const dustMigration = readFileSync(new URL("../supabase/migrations/20260811100000_close_fractional_sell_dust.sql", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

function fifoExit(lots, quantity, price, sellFee = 0, multiplier = 1) {
  let remaining = quantity;
  let cost = 0;
  let buyFees = 0;
  for (const lot of lots) {
    const take = Math.min(remaining, lot.quantity);
    cost += take * lot.price * multiplier;
    buyFees += take * (lot.fee || 0) / lot.quantity;
    remaining -= take;
    if (remaining <= 1e-8) break;
  }
  if (remaining > 1e-8) throw new Error("FIFO lots do not cover this sell");
  return quantity * price * multiplier - sellFee - cost - buyFees;
}

function snapSellQuantity(requested, available) {
  return available > 0 && available - requested >= 0 && available - requested <= 0.000001
    ? available
    : requested;
}

test("AXTI Dime preview exposes the FIFO loss hidden by the displayed average", () => {
  const pnl = fifoExit([
    { quantity: 6.0878048, price: 82 },
    { quantity: 6.1440001, price: 65 },
  ], 10, 74);

  assert.ok(Math.abs(pnl - (-13.4926816)) < 1e-9);
});

test("preview RPC follows the same chronological lot and fee rules as confirmation", () => {
  assert.match(migration, /create or replace function public\.api_preview_sell/i);
  assert.match(migration, /order by lot\.opened_at, lot\.buy_execution_id/i);
  assert.match(migration, /v_realized := v_gross - p_fee - v_cost - v_buy_fees/i);
  assert.match(migration, /p_executed_at < v_last_execution/i);
  assert.match(migration, /security definer[\s\S]*set search_path = ''/i);
  assert.match(migration, /grant execute on function public\.api_preview_sell[\s\S]*to authenticated/i);
});

test("sub-micro-share sell residuals snap to the full available position", () => {
  assert.equal(snapSellQuantity(2.2318048, 2.2318049), 2.2318049);
  assert.equal(snapSellQuantity(2.2318, 2.2318049), 2.2318);
  assert.match(dustMigration, /v_existing_qty - v_qty between 0 and 0\.000001/i);
  assert.match(dustMigration, /normalize_sell_dust/i);
  assert.match(dustMigration, /public\.api_rebuild_position/i);
  assert.match(app, /SELL ALL SNAP/);
});

test("web and Hermes confirmation surfaces include the Dime exit preview", () => {
  assert.match(app, /usesDimeExitPreview = sidePreset === "sell" && brokerProfile\(portfolio\) === "dime"/);
  assert.match(app, /api_preview_agent_draft_sell/);
  assert.match(app, /DIME \/ FIFO EXIT PREVIEW/);
  assert.match(app, /Supabase recalculates the final result when you confirm/);
});
