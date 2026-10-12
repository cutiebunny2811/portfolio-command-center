-- Keep PCC's event color aligned with the reference economic calendar.

begin;

update public.macro_events
set
  importance = 2,
  updated_at = now()
where source = 'ism'
  and event_name = 'ISM Manufacturing PMI'
  and importance is distinct from 2;

commit;
