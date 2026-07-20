-- Separate, user-owned watchlist for Webull market charts.
-- Watchlist edits do not touch portfolio cash, positions, or allocation math.

begin;

create table if not exists public.watchlist_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  instrument_id uuid not null references public.instruments(id) on delete cascade,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, instrument_id)
);

alter table public.watchlist_items enable row level security;

drop policy if exists watchlist_items_select_own on public.watchlist_items;
create policy watchlist_items_select_own
on public.watchlist_items for select
to authenticated
using (user_id = auth.uid());

drop policy if exists watchlist_items_insert_own on public.watchlist_items;
create policy watchlist_items_insert_own
on public.watchlist_items for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists watchlist_items_update_own on public.watchlist_items;
create policy watchlist_items_update_own
on public.watchlist_items for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists watchlist_items_delete_own on public.watchlist_items;
create policy watchlist_items_delete_own
on public.watchlist_items for delete
to authenticated
using (user_id = auth.uid());

grant select on public.watchlist_items to authenticated;

create or replace function public.api_add_watchlist_item(
  p_instrument_id uuid,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if not exists (
    select 1
    from public.instruments
    where id = p_instrument_id
      and asset_type in ('stock', 'etf')
  ) then
    raise exception 'Only stocks and ETFs can be added to the watchlist';
  end if;

  insert into public.watchlist_items (user_id, instrument_id, notes)
  values (v_user_id, p_instrument_id, nullif(trim(p_notes), ''))
  on conflict (user_id, instrument_id)
  do update set notes = excluded.notes, updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.api_remove_watchlist_item(
  p_instrument_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  delete from public.watchlist_items
  where user_id = v_user_id
    and instrument_id = p_instrument_id;
end;
$$;

revoke all on function public.api_add_watchlist_item(uuid, text) from public, anon;
revoke all on function public.api_remove_watchlist_item(uuid) from public, anon;
grant execute on function public.api_add_watchlist_item(uuid, text) to authenticated;
grant execute on function public.api_remove_watchlist_item(uuid) to authenticated;

commit;

-- Verification: expect rls_enabled = true and at least four policies.
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  count(p.policyname) as policy_count
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
left join pg_catalog.pg_policies p
  on p.schemaname = n.nspname
 and p.tablename = c.relname
where n.nspname = 'public'
  and c.relname = 'watchlist_items'
group by c.relname, c.relrowsecurity;
