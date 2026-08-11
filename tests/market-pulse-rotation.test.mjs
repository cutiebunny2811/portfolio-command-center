import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const rotation = require("../market-pulse-rotation.js");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const edgeFunction = readFileSync(new URL("../supabase/functions/refresh-stock-prices/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260812120000_market_pulse_sector_rotation.sql", import.meta.url), "utf8");

const raw = {
  SPY: [1, 3, 6, 10],
  XLK: [0, 2, 8, 18], XLC: [-1, 0, 2, 8], XLY: [0, 2.9, 5, 9],
  XLP: [1, 3, 5, 7], XLE: [5, 8, 12, 14], XLF: [2, 3.3, 9, 12],
  XLV: [3, 4.2, 13, 8], XLI: [2, 4, 10, 13], XLB: [3, 5.4, 7, 6],
  XLRE: [0, 1, 3, 4], XLU: [-2, -1, 1, 3]
};
const rows = Object.entries(raw).map(([symbol, values]) => ({
  symbol, return_1w: values[0], return_1m: values[1], return_3m: values[2], return_6m: values[3]
}));

test("sector rotation subtracts SPY before ranking", () => {
  const model = rotation.buildSectorRotation(rows);
  const energy = model.rows.find((row) => row.symbol === "XLE");
  const technology = model.rows.find((row) => row.symbol === "XLK");

  assert.equal(energy.relative.return_1m, 5);
  assert.equal(technology.relative.return_1m, -1);
  assert.ok(energy.score > technology.score);
  assert.equal(model.rows.length, 11);
});

test("rotation score is bounded, ranked, and exposes its inputs", () => {
  const model = rotation.buildSectorRotation(rows);

  assert.deepEqual(model.windows.map((window) => window.weight), [.2, .35, .3, .15]);
  assert.ok(model.rows.every((row) => row.score >= 0 && row.score <= 100));
  assert.deepEqual(model.rows.map((row) => row.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.ok(model.rows.every((row) => ["Leading", "Improving", "Weakening", "Lagging"].includes(row.zone)));
});

test("regime summary is deterministic and sector-wide", () => {
  const summary = rotation.summarizeSectorRotation(rotation.buildSectorRotation(rows));

  assert.match(summary.label, /ROTATION|LEADERSHIP/);
  assert.equal(summary.leaders.length, 3);
  assert.match(summary.leadText, /SPY-relative strength/);
});

test("dashboard exposes rotation and theme views without a new primary route", () => {
  assert.match(app, /data-action="market-pulse-mode" data-mode="rotation"/);
  assert.match(app, /data-action="market-pulse-mode" data-mode="themes"/);
  assert.match(app, /data-action="rotation-toggle"/);
  assert.match(css, /\.rotation-row__toggle/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.rotation-detail__scorecard/);
});

test("six-month return reuses the existing daily-bar request", () => {
  assert.match(edgeFunction, /return_6m:\s*returnFromClose\(currentPrice, closeAt\(126\)\)/);
  assert.match(edgeFunction, /fetchHistoricalBars\(instrument, 280, "D"\)/);
  assert.match(migration, /add column if not exists return_6m numeric/);
});
