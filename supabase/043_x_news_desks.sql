-- Portfolio Command Center: focused Reuters market desk + Shay stock desk.
-- Collection remains shared; read/saved/hidden state remains per member.

begin;

insert into public.research_source_subscriptions (
  user_id, source, source_key, display_name, is_active, updated_at
)
select
  member.user_id,
  'x',
  source.source_key,
  source.display_name,
  true,
  now()
from public.pcc_members member
cross join (
  values
    ('reuters', '@Reuters'),
    ('stocksavvyshay', '@StockSavvyShay')
) as source(source_key, display_name)
where member.onboarding_completed_at is not null
on conflict (user_id, source, source_key) do update
set is_active = true,
    display_name = excluded.display_name,
    updated_at = now();

update public.research_source_subscriptions
set is_active = false,
    updated_at = now()
where source = 'x'
  and source_key = 'naklongpoong';

insert into public.research_x_source_state (
  source_key, display_name, last_window_key, updated_at
)
values
  ('reuters', '@Reuters', null, now()),
  ('stocksavvyshay', '@StockSavvyShay', null, now())
on conflict (source_key) do update
set display_name = excluded.display_name,
    last_window_key = null,
    updated_at = now();

-- Old Reuters rows were admitted under a broad query. Keep them auditable but
-- remove them from the feed until a fresh collector pass assigns HIGH/MEDIUM.
update public.research_articles article
set keywords = array_remove(article.keywords, 'X_SIGNAL'),
    updated_at = now()
where article.source = 'x'
  and 'REUTERS' = any(article.keywords)
  and not ('ALERT_HIGH' = any(article.keywords))
  and not ('ALERT_MEDIUM' = any(article.keywords));

-- The Thai relay is no longer a paid source because it commonly repeats Shay.
update public.research_articles article
set keywords = array_remove(article.keywords, 'X_SIGNAL'),
    updated_at = now()
where article.source = 'x'
  and lower(coalesce(article.publisher_name, '')) = 'x / @naklongpoong';

commit;
