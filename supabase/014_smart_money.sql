-- Portfolio Command Center: Smart Money / SEC Form 4 storage.
-- Run once in Supabase SQL Editor before deploying the Massive collector.

begin;

create table if not exists public.smart_money_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  instrument_id uuid not null references public.instruments(id) on delete cascade,
  source text not null default 'massive' check (source in ('massive', 'sec')),
  accession_number text not null,
  transaction_key text not null,
  form_type text not null default '4',
  filer_cik text,
  filer_name text not null,
  filer_title text,
  relationship text,
  transaction_code text,
  side text not null default 'other' check (side in ('buy', 'sell', 'other')),
  security_title text,
  transaction_date date,
  filed_at timestamptz not null,
  shares numeric,
  price numeric,
  transaction_value numeric,
  post_transaction_shares numeric,
  ownership_nature text,
  is_derivative boolean not null default false,
  sec_url text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, accession_number, transaction_key)
);

create index if not exists smart_money_events_user_filed_idx
  on public.smart_money_events (user_id, filed_at desc);
create index if not exists smart_money_events_instrument_filed_idx
  on public.smart_money_events (user_id, instrument_id, filed_at desc);
create index if not exists smart_money_events_side_filed_idx
  on public.smart_money_events (user_id, side, filed_at desc);

create table if not exists public.smart_money_sync_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null default 'massive',
  last_cursor text,
  last_filed_at timestamptz,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (user_id, source)
);

alter table public.smart_money_events enable row level security;
alter table public.smart_money_sync_state enable row level security;

drop policy if exists smart_money_events_select_own on public.smart_money_events;
create policy smart_money_events_select_own
  on public.smart_money_events for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists smart_money_sync_state_select_own on public.smart_money_sync_state;
create policy smart_money_sync_state_select_own
  on public.smart_money_sync_state for select
  to authenticated
  using (user_id = auth.uid());

-- Authenticated clients can only read their feed. Inserts and updates are reserved
-- for the scheduled server-side collector, which uses the service role.
revoke insert, update, delete on public.smart_money_events from authenticated, anon;
revoke insert, update, delete on public.smart_money_sync_state from authenticated, anon;
grant select on public.smart_money_events to authenticated;
grant select on public.smart_money_sync_state to authenticated;

commit;
