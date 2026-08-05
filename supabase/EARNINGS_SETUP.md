# Earnings calendar setup

1. Run `032_earnings_calendar.sql` in the Supabase SQL editor.
2. Add the Edge Function secrets `FINNHUB_API_KEY`, `ALPHA_VANTAGE_API_KEY` and `EARNINGS_SYNC_SECRET` in Supabase. Never put them in `config.js` or GitHub. `ALPHA_VANTAGE_API_KEY` is optional and is used only to fill an EPS estimate when its ticker and date exactly match Finnhub.
3. Deploy `supabase/functions/sync-earnings-calendar` with JWT verification enabled.
4. Invoke the function once from the Earnings page to seed the calendar.
5. Store the same sync secret in Supabase Vault under `earnings_sync_secret`, then run `034_earnings_auto_sync.sql`. It schedules four refreshes per day at 00:15, 06:15, 12:15 and 18:15 UTC (07:15, 13:15, 19:15 and 01:15 Bangkok time).

The collector intentionally has one schedule authority: Finnhub owns both the earnings date and the BMO/AMC/TBD session. Alpha Vantage never moves an event or changes its session; it may only enrich EPS when the symbol and date are an exact match. Yahoo is not part of the sync. If any Finnhub week fails, the whole monthly refresh aborts and the previous complete snapshot remains active instead of publishing a partial calendar.

Only stock and ETF symbols found in a PCC watchlist are stored. The browser reads those rows through `api_get_earnings_calendar()`, which joins against the signed-in user's own watchlist.
