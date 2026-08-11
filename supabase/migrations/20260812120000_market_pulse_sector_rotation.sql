-- Six-month context completes the deterministic sector-rotation score.
alter table public.market_pulse_latest
  add column if not exists return_6m numeric;
