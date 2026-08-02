# Earnings calendar setup

1. Run `032_earnings_calendar.sql` in the Supabase SQL editor.
2. Add the Edge Function secrets `FINNHUB_API_KEY` and `ALPHA_VANTAGE_API_KEY` in Supabase. Never put them in `config.js` or GitHub. Yahoo Finance needs no secret.
3. Deploy `supabase/functions/sync-earnings-calendar` with JWT verification enabled.
4. Invoke the function once from the Earnings page to seed the calendar.
5. Schedule the function twice daily (for example 00:15 and 12:15 UTC) with the existing `SYNC_SECRET` header.

The collector uses Alpha Vantage for the broad monthly date, Finnhub for estimates and market-session timing, then makes ticker-scoped Yahoo Finance lookups (the same request shape used by `yfinance`) only for tracked names whose exact-date event is missing or still has unknown timing. Yahoo is a best-effort fallback: it never overwrites a known Finnhub BMO/AMC value, never changes the canonical date, and a Yahoo failure does not stop or erase the calendar sync.

Only stock and ETF symbols found in a PCC watchlist are stored. The browser reads those rows through `api_get_earnings_calendar()`, which joins against the signed-in user's own watchlist.
