begin;

do $$
declare
  existing_job record;
begin
  for existing_job in
    select jobid
    from cron.job
    where jobname = 'refresh-portfolio-prices-every-15-minutes'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
end
$$;

select cron.schedule(
  'refresh-portfolio-prices-every-15-minutes',
  '*/15 * * * *',
  $job$
    select net.http_post(
      url := 'https://zzynqlqnzdhkffvqvpzt.supabase.co/functions/v1/refresh-stock-prices',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-sync-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'price_sync_secret'
          limit 1
        )
      ),
      body := jsonb_build_object(
        'action', 'portfolio_prices',
        'user_id', member.user_id,
        'force', false
      ),
      timeout_milliseconds := 120000
    )
    from public.pcc_members member
    where member.onboarding_completed_at is not null
      and (
        exists (
          select 1
          from public.position_balances position
          where position.user_id = member.user_id
            and position.quantity > 0
        )
        or exists (
          select 1
          from public.allocation_targets target
          join public.portfolios portfolio
            on portfolio.id = target.portfolio_id
          where portfolio.user_id = member.user_id
            and target.is_active = true
        )
      );
  $job$
);

commit;
