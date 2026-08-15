-- Keep weekly Smart Money editions on their own reader route.

begin;

alter table public.pcc_notifications
  drop constraint if exists pcc_notifications_route;

alter table public.pcc_notifications
  add constraint pcc_notifications_route
  check (route in ('briefs', 'smart-money', 'smart-money-briefs'));

create or replace function public.normalize_smart_money_brief_notification_route()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.notification_type = 'smart_money_brief' then
    new.route := 'smart-money-briefs';
  end if;
  return new;
end;
$$;

drop trigger if exists normalize_smart_money_brief_notification_route
  on public.pcc_notifications;

create trigger normalize_smart_money_brief_notification_route
before insert or update of notification_type, route
on public.pcc_notifications
for each row execute function public.normalize_smart_money_brief_notification_route();

update public.pcc_notifications
set route = 'smart-money-briefs'
where notification_type = 'smart_money_brief'
  and route <> 'smart-money-briefs';

revoke all on function public.normalize_smart_money_brief_notification_route()
  from public, anon, authenticated;

commit;
