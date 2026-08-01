-- Dynamic portfolio management without weakening the existing per-user RLS model.
-- Existing portfolio.kind remains for compatibility with Rule A and older APIs;
-- portfolio_mode is the user-facing accounting behavior for new/custom portfolios.

begin;

alter table public.portfolios
  add column if not exists portfolio_mode text,
  add column if not exists archived_at timestamptz;

update public.portfolios
set portfolio_mode = case when kind::text = 'options' then 'options' else 'standard' end
where portfolio_mode is null;

alter table public.portfolios
  alter column portfolio_mode set default 'standard',
  alter column portfolio_mode set not null;

alter table public.portfolios
  drop constraint if exists portfolios_portfolio_mode_check;

alter table public.portfolios
  add constraint portfolios_portfolio_mode_check
  check (portfolio_mode in ('standard', 'options'));

-- The bootstrap schema may have enforced one row per legacy kind. Dynamic
-- portfolios need several standard portfolios, so remove only that exact
-- two-column uniqueness rule while preserving all other constraints.
do $$
declare
  v_constraint record;
  v_index record;
begin
  for v_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.portfolios'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) ~* '^UNIQUE \(user_id, kind\)$'
  loop
    execute format('alter table public.portfolios drop constraint %I', v_constraint.conname);
  end loop;

  -- Some early/manual installs may have created the same rule as a standalone
  -- unique index rather than a named constraint. Remove only the exact
  -- (user_id, kind) index so unrelated indexes remain untouched.
  for v_index in
    select c.relname as index_name
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    where i.indrelid = 'public.portfolios'::regclass
      and i.indisunique
      and i.indnkeyatts = 2
      and (
        select array_agg(a.attname order by key_col.ordinality)
        from unnest(i.indkey::smallint[]) with ordinality as key_col(attnum, ordinality)
        join pg_attribute a
          on a.attrelid = i.indrelid
         and a.attnum = key_col.attnum
        where key_col.ordinality <= i.indnkeyatts
      ) = array['user_id', 'kind']::name[]
      and not exists (
        select 1 from pg_constraint con where con.conindid = i.indexrelid
      )
  loop
    execute format('drop index public.%I', v_index.index_name);
  end loop;
end;
$$;

create unique index if not exists portfolios_active_name_per_user_idx
  on public.portfolios (user_id, lower(btrim(name)))
  where is_active = true;

create or replace function public.api_create_portfolio(
  p_name text,
  p_portfolio_mode text default 'standard',
  p_fixed_budget numeric default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_name text := nullif(btrim(p_name), '');
  v_mode text := lower(btrim(coalesce(p_portfolio_mode, 'standard')));
  v_kind public.portfolio_kind;
  v_basis public.portfolios.allocation_basis%type;
  v_portfolio public.portfolios%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if v_name is null then raise exception 'Portfolio name is required'; end if;
  if char_length(v_name) > 80 then raise exception 'Portfolio name is too long'; end if;
  if v_mode not in ('standard', 'options') then raise exception 'Portfolio mode must be standard or options'; end if;
  if coalesce(p_fixed_budget, 0) < 0 then raise exception 'Starting budget cannot be negative'; end if;

  v_kind := case
    when v_mode = 'options' then 'options'::public.portfolio_kind
    else 'long_term'::public.portfolio_kind
  end;
  if v_mode = 'options' then
    v_basis := 'maximum_loss';
  else
    v_basis := 'cost_basis';
  end if;

  insert into public.portfolios (
    user_id, kind, name, base_currency, fixed_budget,
    allocation_basis, cost_method, sort_order, is_active,
    portfolio_mode, archived_at
  ) values (
    v_user, v_kind, v_name, 'USD', coalesce(p_fixed_budget, 0),
    v_basis,
    'weighted_average',
    coalesce((select max(sort_order) + 1 from public.portfolios where user_id = v_user), 1),
    true, v_mode, null
  ) returning * into v_portfolio;

  insert into public.audit_log (
    user_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_data, after_data
  ) values (
    v_user, 'user', v_user::text, 'create_portfolio', 'portfolio', v_portfolio.id::text,
    concat('portfolio:create:', v_portfolio.id::text), null, to_jsonb(v_portfolio)
  );

  return to_jsonb(v_portfolio);
end;
$$;

create or replace function public.api_rename_portfolio(
  p_portfolio_id uuid,
  p_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_name text := nullif(btrim(p_name), '');
  v_before public.portfolios%rowtype;
  v_after public.portfolios%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if v_name is null then raise exception 'Portfolio name is required'; end if;
  if char_length(v_name) > 80 then raise exception 'Portfolio name is too long'; end if;

  select * into v_before
  from public.portfolios
  where id = p_portfolio_id and user_id = v_user and is_active = true
  for update;
  if not found then raise exception 'Active portfolio not found'; end if;

  update public.portfolios
  set name = v_name
  where id = p_portfolio_id
  returning * into v_after;

  insert into public.audit_log (
    user_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_data, after_data
  ) values (
    v_user, 'user', v_user::text, 'rename_portfolio', 'portfolio', p_portfolio_id::text,
    concat('portfolio:rename:', p_portfolio_id::text, ':', extract(epoch from now())::text),
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return to_jsonb(v_after);
end;
$$;

create or replace function public.api_archive_portfolio(
  p_portfolio_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_before public.portfolios%rowtype;
  v_after public.portfolios%rowtype;
  v_cash numeric := 0;
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  select * into v_before
  from public.portfolios
  where id = p_portfolio_id and user_id = v_user and is_active = true
  for update;
  if not found then raise exception 'Active portfolio not found'; end if;

  if (select count(*) from public.portfolios where user_id = v_user and is_active = true) <= 1 then
    raise exception 'Keep at least one active portfolio';
  end if;
  if exists (
    select 1 from public.position_balances
    where portfolio_id = p_portfolio_id and user_id = v_user and abs(coalesce(quantity, 0)) > 0.00000001
  ) then
    raise exception 'Sell or correct every open position before archiving this portfolio';
  end if;
  if exists (
    select 1 from public.operation_drafts
    where portfolio_id = p_portfolio_id and user_id = v_user and status = 'pending'
  ) then
    raise exception 'Cancel or confirm pending drafts before archiving this portfolio';
  end if;

  v_cash := public.api_cash_balance(v_user, p_portfolio_id);
  if abs(coalesce(v_cash, 0)) > 0.005 then
    raise exception 'Withdraw the remaining cash before archiving this portfolio';
  end if;

  update public.portfolios
  set is_active = false, archived_at = now()
  where id = p_portfolio_id
  returning * into v_after;

  update public.allocation_targets
  set is_active = false
  where portfolio_id = p_portfolio_id and is_active = true;

  insert into public.audit_log (
    user_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_data, after_data
  ) values (
    v_user, 'user', v_user::text, 'archive_portfolio', 'portfolio', p_portfolio_id::text,
    concat('portfolio:archive:', p_portfolio_id::text), to_jsonb(v_before), to_jsonb(v_after)
  );

  return to_jsonb(v_after);
end;
$$;

revoke all on function public.api_create_portfolio(text, text, numeric) from public, anon;
revoke all on function public.api_rename_portfolio(uuid, text) from public, anon;
revoke all on function public.api_archive_portfolio(uuid) from public, anon;
grant execute on function public.api_create_portfolio(text, text, numeric) to authenticated;
grant execute on function public.api_rename_portfolio(uuid, text) to authenticated;
grant execute on function public.api_archive_portfolio(uuid) to authenticated;

commit;
