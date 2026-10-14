-- Remove a mistakenly recorded execution without leaving cash, position lots,
-- realized P/L or derived journal data out of sync.

begin;

create or replace function public.api_delete_execution(
  p_execution_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_target public.executions%rowtype;
  v_before jsonb;
  v_position jsonb;
  v_cash_before numeric;
  v_cash_after numeric;
begin
  if v_user is null then
    raise exception 'Authentication required';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Deletion reason is required';
  end if;

  select *
    into v_target
  from public.executions
  where id = p_execution_id
    and user_id = v_user
  for update;

  if not found then
    raise exception 'Execution not found';
  end if;

  perform 1
  from public.portfolios
  where id = v_target.portfolio_id
    and user_id = v_user
  for update;

  v_before := to_jsonb(v_target);
  v_cash_before := public.api_cash_balance(v_user, v_target.portfolio_id);

  delete from public.journal_entries
  where user_id = v_user
    and execution_id = p_execution_id
    and source = 'derived';

  delete from public.executions
  where id = p_execution_id
    and user_id = v_user;

  v_position := public.api_rebuild_position(
    v_user,
    v_target.portfolio_id,
    v_target.instrument_id
  );
  v_cash_after := public.api_cash_balance(v_user, v_target.portfolio_id);

  insert into public.audit_log (
    user_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_data, after_data
  ) values (
    v_user,
    'user',
    v_user::text,
    'delete_execution',
    'execution',
    p_execution_id::text,
    concat('execution:delete:', p_execution_id::text, ':', extract(epoch from now())::text),
    v_before,
    jsonb_build_object(
      'reason', btrim(p_reason),
      'cash_before', v_cash_before,
      'cash_after', v_cash_after,
      'broker_rebuilt_position', v_position
    )
  );

  return jsonb_build_object(
    'deleted_execution_id', p_execution_id,
    'cash_before', v_cash_before,
    'cash_after', v_cash_after
  ) || v_position;
end;
$$;

revoke all on function public.api_delete_execution(uuid, text)
  from public, anon;
grant execute on function public.api_delete_execution(uuid, text)
  to authenticated;

commit;
