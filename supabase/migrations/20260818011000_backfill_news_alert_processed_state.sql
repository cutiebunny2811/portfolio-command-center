begin;

update public.research_article_state
set alert_processed_at = coalesce(read_at, updated_at, now())
where is_read = true
  and alert_processed_at is null;

commit;
