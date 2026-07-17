-- One-time cleanup for the simplified allocation model.
-- Cash is now the unallocated remainder of each portfolio, not an asset target.

begin;

update public.allocation_targets as target
set is_active = false
from public.instruments as instrument
where target.instrument_id = instrument.id
  and upper(trim(instrument.symbol)) = 'CASH'
  and target.is_active = true;

commit;
