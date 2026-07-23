# Portfolio Command Center

Private portfolio allocation and trading P/L dashboard backed by Supabase.

## Data model

- Four isolated portfolios: Long Term, Swing Trade, Speculative, Options.
- USD base currency and weighted-average cost.
- Options allocation uses maximum loss; notional value is shown separately.
- Supabase is the only financial source of truth. Browser storage is used only by Supabase Auth for the signed-in session.
- Financial writes use reviewed RPC functions. Trade and cash changes use a Draft → Confirm flow.

## Supabase migrations

The existing project already uses schema/API migrations 001–004. Run the journal migrations in order:

1. [`supabase/005_journal_api.sql`](supabase/005_journal_api.sql)
2. [`supabase/006_verify_journal_api.sql`](supabase/006_verify_journal_api.sql)
3. [`supabase/007_journal_scaling.sql`](supabase/007_journal_scaling.sql)
4. [`supabase/008_verify_journal_scaling.sql`](supabase/008_verify_journal_scaling.sql)

Migration 007 keeps large journals responsive by returning only one ledger page at a time while calculating filtered KPIs, monthly totals, and daily equity data inside Postgres.

Watchlist research features also require the later migrations in this repository. For Market Pulse, run:

```text
supabase/011_watchlist.sql
supabase/015_market_pulse.sql
```

## Webull stock prices

`supabase/functions/refresh-stock-prices` refreshes active stock and ETF prices through the Webull Snapshot API. Options are intentionally excluded. The dashboard calls it when the app opens, when the user requests a refresh, and every 15 minutes while the app remains open. The Edge Function ignores prices that are already less than 15 minutes old unless a manual refresh is requested.

Keep Webull credentials in Supabase Edge Function Secrets only. Do not copy the local `.env` file into this repository or into the browser application.

Required secrets:

```text
WEBULL_APP_KEY
WEBULL_APP_SECRET
WEBULL_REGION=th
WEBULL_API_HOST=api.webull.co.th
```

`WEBULL_ACCESS_TOKEN` is optional and should be added only if the Webull application requires 2FA token authentication for market-data calls.

Deploy with the Supabase CLI after linking the project:

```bash
supabase functions deploy refresh-stock-prices --project-ref zzynqlqnzdhkffvqvpzt
```

The function uses the signed-in dashboard user's JWT and existing RLS policies. It reads only active stock/ETF instruments and writes each result through `api_record_instrument_price`; it cannot place or modify broker orders.

### Watchlist Market Pulse

The `Market Pulse` subview is intentionally watchlist-first:

- Gainers, decliners, most-active rankings, and breadth use only the signed-in user's Watchlist.
- Five benchmark ETFs provide broad context without being counted as watched names.
- Eleven Select Sector SPDR ETFs provide 1-day, 1-week, 1-month, 3-month, and YTD sector context.
- Snapshot data refreshes every 15 minutes; sector return bars refresh hourly.
- `market_pulse_latest` retains one latest row per user and symbol, so the database does not accumulate a new row every refresh.

Adding or removing a Watchlist name triggers a targeted Market Pulse refresh. The Edge Function batches Webull snapshots in groups of at most 100 symbols, allowing a 200+ name Watchlist without serial browser requests.

## Deploy

This is a static app. Publish the repository root with GitHub Pages from the `main` branch.

For a local visual preview with sample-only data, run `node dev-server.mjs` and open `http://127.0.0.1:4173/?preview=1`. The preview path is available only on localhost.
