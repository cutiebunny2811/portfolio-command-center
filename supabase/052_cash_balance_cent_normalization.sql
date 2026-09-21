-- Normalize sub-cent residue left by fractional executions and six-decimal cash drafts.
-- Broker cash is reported to cents, so values that round to $0.00 are canonical zero.

begin;

create or replace function public.api_cash_balance(
  p_user_id uuid,
  p_portfolio_id uuid
)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  with balance as (
    select
      coalesce((
        select sum(cm.signed_amount)
        from public.cash_movements cm
        where cm.user_id = p_user_id and cm.portfolio_id = p_portfolio_id
      ), 0)
      +
      coalesce((
        select sum(e.cash_effect)
        from public.executions e
        where e.user_id = p_user_id and e.portfolio_id = p_portfolio_id
      ), 0) as raw_balance
  )
  select case
    when abs(raw_balance) < 0.005 then 0::numeric
    else raw_balance
  end
  from balance;
$$;

create or replace view public.portfolio_cash_balances
with (security_invoker = true) as
select
  p.id as portfolio_id,
  p.user_id,
  p.fixed_budget,
  case
    when abs(coalesce(cm.cash_total, 0) + coalesce(ex.execution_total, 0)) < 0.005 then 0::numeric
    else coalesce(cm.cash_total, 0) + coalesce(ex.execution_total, 0)
  end as cash_balance
from public.portfolios p
left join (
  select portfolio_id, sum(signed_amount) as cash_total
  from public.cash_movements
  group by portfolio_id
) cm on cm.portfolio_id = p.id
left join (
  select portfolio_id, sum(cash_effect) as execution_total
  from public.executions
  group by portfolio_id
) ex on ex.portfolio_id = p.id;

commit;
