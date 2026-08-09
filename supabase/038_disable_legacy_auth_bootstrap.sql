-- New members are provisioned by api_complete_member_onboarding in migration
-- 037. The original Auth trigger targeted the removed (user_id, kind) unique
-- constraint and prevents Supabase invitations from creating a user.

begin;

drop trigger if exists on_auth_user_created_bootstrap_portfolios on auth.users;
drop function if exists public.bootstrap_user_portfolios();

commit;
