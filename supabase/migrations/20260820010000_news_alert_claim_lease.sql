begin;

alter table public.research_article_state
  add column if not exists alert_claim_token uuid,
  add column if not exists alert_claimed_at timestamptz;

comment on column public.research_article_state.alert_claim_token is
  'Short-lived owner token preventing concurrent News monitors from delivering the same article.';
comment on column public.research_article_state.alert_claimed_at is
  'Start of the current News alert delivery lease. Stale leases are released by the next monitor read.';

create index if not exists research_article_state_alert_claim_idx
  on public.research_article_state (user_id, alert_claimed_at, article_id)
  where alert_processed_at is null;

update public.research_article_state
set alert_claim_token = null,
    alert_claimed_at = null
where alert_processed_at is not null
   or alert_claimed_at < now() - interval '30 minutes';

commit;
