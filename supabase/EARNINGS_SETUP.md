# Earnings calendar setup

1. Run `032_earnings_calendar.sql` in the Supabase SQL editor.
2. Add the Edge Function secrets `FINNHUB_API_KEY`, `ALPHA_VANTAGE_API_KEY` and `EARNINGS_SYNC_SECRET` in Supabase. Never put them in `config.js` or GitHub.
3. Deploy `supabase/functions/sync-earnings-calendar` with JWT verification enabled.
4. Invoke the function once from the Earnings page to seed the calendar.
5. Store the same sync secret in Supabase Vault under `earnings_sync_secret`, then run `034_earnings_auto_sync.sql`. It schedules four refreshes per day at 00:15, 06:15, 12:15 and 18:15 UTC (07:15, 13:15, 19:15 and 01:15 Bangkok time).

The collector uses a strict two-level schedule hierarchy. Finnhub owns the date and BMO/AMC/TBD session whenever it contains a symbol. For a symbol Finnhub omitted for the whole month, Alpha Vantage proposes the date and Yahoo Finance must independently return that exact symbol and date before the row is added. Yahoo may supply that fallback row's session, but neither fallback provider can move or replace a Finnhub event. After a verified fallback event has passed, its exact Alpha date and non-TBD session are preserved so a provider's rolling window cannot erase calendar history. Legacy rows whose payload points to another date are rejected. If a required provider request fails, the whole monthly refresh aborts and the previous complete snapshot remains active instead of publishing a partial calendar.

Only stock and ETF symbols found in a PCC watchlist are stored. The browser reads those rows through `api_get_earnings_calendar()`, which joins against the signed-in user's own watchlist.
