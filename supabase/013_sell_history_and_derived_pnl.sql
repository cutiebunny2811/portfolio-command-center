-- Link confirmed sell executions to the P/L journal and backfill existing sells.
-- Sell history itself stays immutable in public.executions; the dashboard reads only the latest 200.

begin;

alter table public.journal_entries
  add column if not exists execution_id uuid references public.executions(id) on delete restrict;

-- The original schema reserved derived rows with a null P/L for a future campaign rollup.
-- Confirmed sell rows now carry their server-calculated weighted-average realized P/L.
alter table public.journal_entries
  drop constraint if exists journal_entries_check;

create unique index if not exists journal_entries_execution_id_uidx
  on public.journal_entries (execution_id)
  where execution_id is not null;

create or replace function public.sync_sell_execution_to_journal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.side <> 'sell' or new.realized_pnl is null then
    return new;
  end if;

  insert into public.journal_entries (
    user_id, portfolio_id, campaign_id, instrument_id, execution_id,
    source, outcome, occurred_on, manual_pnl, strategy_label, notes
  ) values (
    new.user_id, new.portfolio_id, new.campaign_id, new.instrument_id, new.id,
    'derived',
    case
      when new.realized_pnl > 0 then 'win'::public.trade_outcome
      when new.realized_pnl < 0 then 'loss'::public.trade_outcome
      else 'breakeven'::public.trade_outcome
    end,
    (new.executed_at at time zone 'Asia/Bangkok')::date,
    new.realized_pnl,
    'Automatic sell',
    format('Sold %s at %s; fee %s', new.quantity, new.price, new.fee)
  )
  on conflict (execution_id) where execution_id is not null do nothing;

  return new;
end;
$$;

revoke all on function public.sync_sell_execution_to_journal() from public, anon, authenticated;

drop trigger if exists executions_sync_sell_journal on public.executions;
create trigger executions_sync_sell_journal
after insert on public.executions
for each row execute function public.sync_sell_execution_to_journal();

-- Backfill confirmed sells already recorded before this migration, including partial exits.
insert into public.journal_entries (
  user_id, portfolio_id, campaign_id, instrument_id, execution_id,
  source, outcome, occurred_on, manual_pnl, strategy_label, notes
)
select
  e.user_id, e.portfolio_id, e.campaign_id, e.instrument_id, e.id,
  'derived',
  case
    when e.realized_pnl > 0 then 'win'::public.trade_outcome
    when e.realized_pnl < 0 then 'loss'::public.trade_outcome
    else 'breakeven'::public.trade_outcome
  end,
  (e.executed_at at time zone 'Asia/Bangkok')::date,
  e.realized_pnl,
  'Automatic sell',
  format('Sold %s at %s; fee %s', e.quantity, e.price, e.fee)
from public.executions e
where e.side = 'sell'
  and e.realized_pnl is not null
on conflict (execution_id) where execution_id is not null do nothing;

commit;

-- Verification: trigger_count must be 1 and linked_sells should match confirmed sell executions.
select
  (select count(*) from pg_catalog.pg_trigger t
   join pg_catalog.pg_class c on c.oid = t.tgrelid
   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'executions'
     and t.tgname = 'executions_sync_sell_journal' and not t.tgisinternal) as trigger_count,
  (select count(*) from public.executions where side = 'sell' and realized_pnl is not null) as confirmed_sells,
  (select count(*) from public.journal_entries where execution_id is not null) as linked_sells;
