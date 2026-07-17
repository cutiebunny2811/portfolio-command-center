-- Soft-remove an asset from one portfolio without deleting trade or journal history.

create or replace function public.api_remove_asset_from_portfolio(
  p_portfolio_id uuid,
  p_instrument_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_quantity numeric := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if not exists (
    select 1
    from public.portfolios
    where id = p_portfolio_id
      and user_id = v_user_id
  ) then
    raise exception 'Portfolio not found or access denied';
  end if;

  select coalesce(quantity, 0)
    into v_quantity
  from public.position_balances
  where portfolio_id = p_portfolio_id
    and instrument_id = p_instrument_id;

  if coalesce(v_quantity, 0) > 0 then
    raise exception 'Sell the remaining position before removing this asset';
  end if;

  update public.allocation_targets
  set is_active = false
  where portfolio_id = p_portfolio_id
    and instrument_id = p_instrument_id
    and is_active = true;
end;
$$;

revoke all on function public.api_remove_asset_from_portfolio(uuid, uuid) from public, anon;
grant execute on function public.api_remove_asset_from_portfolio(uuid, uuid) to authenticated;
