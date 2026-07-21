# Smart Money setup

The Smart Money page reads SEC Form 4 transactions for stocks and ETFs in each
user's watchlist. Massive is only called by a Supabase Edge Function; its key is
never shipped to the browser or committed to GitHub.

## 1. Create the tables

Run `014_smart_money.sql` once in the Supabase SQL Editor.

## 2. Add Edge Function secrets

Add these in **Supabase > Edge Functions > Secrets**:

- `MASSIVE_API_KEY`: the API key from Massive.
- `SMART_MONEY_SYNC_SECRET`: a new long random value used only by the scheduler.

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are supplied
automatically by Supabase Edge Functions.

## 3. Deploy the collector

Deploy `supabase/functions/sync-smart-money` with gateway JWT verification
disabled (`--no-verify-jwt`). The function still authenticates every request
itself: dashboard calls require a valid user bearer token, while scheduler calls
require the private `x-sync-secret` header. This lets Supabase Cron call the
function without exposing a user session.

Recommended schedule: every 30 minutes on U.S. business days. Form 4 filings are
not market-price data, so checking every minute only wastes quota.

## 4. Expected behavior

- The first successful run looks back 14 days to stay within the free API rate limit.
- Later runs overlap the last four days so late/amended filings are caught.
- One Massive filing batch is fetched and then matched against all watchlists.
- Repeated runs are safe because transactions are deduplicated by user,
  accession number, and a stable transaction fingerprint.
- The page displays only the newest 50 matching rows at once, while Supabase
  retains the complete audit history.
