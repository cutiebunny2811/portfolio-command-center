-- Form 4 filings do not need price-feed frequency. Move every existing Smart
-- Money collector job to a quiet six-runs-per-weekday cadence so the shared
-- Massive key remains available to research news and owner-only option EOD.
do $$
declare
  smart_money_job record;
begin
  for smart_money_job in
    select jobid
    from cron.job
    where command ilike '%sync-smart-money%'
  loop
    perform cron.alter_job(
      smart_money_job.jobid,
      schedule => '17 1,5,9,13,17,21 * * 1-5',
      active => true
    );
  end loop;
end
$$;
