-- ISM Manufacturing Prices is a low-impact (yellow) calendar item.

begin;

update public.macro_events
set
  importance = 1,
  updated_at = now()
where source = 'ism'
  and event_name = 'ISM Manufacturing Prices'
  and importance is distinct from 1;

commit;
