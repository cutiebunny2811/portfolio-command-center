begin;

alter table public.research_article_state
  add column if not exists alert_processed_at timestamptz;

comment on column public.research_article_state.alert_processed_at is
  'When an automated News alert monitor finished evaluating this article. Independent from the member read state.';

create index if not exists research_article_state_alert_processed_idx
  on public.research_article_state (user_id, alert_processed_at, article_id);

commit;
