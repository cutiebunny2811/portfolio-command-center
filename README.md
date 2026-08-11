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

### News + SEC 8-K

Run [`supabase/021_research_news.sql`](supabase/021_research_news.sql) and
[`supabase/022_research_ticker_search.sql`](supabase/022_research_ticker_search.sql),
then deploy `sync-research-news`. News is deliberately source-first:

- `All` covers news matched to tracked stocks and ETFs.
- `Unread` is the reading queue.
- `Portfolio` keeps only names currently held.
- `Saved` is the user's bookmark shelf.

V1 does not calculate fundamentals, rank high-signal stories, or call an AI
model. Articles are deduplicated by provider ID, user state is stored
separately, and the dashboard requests only 25 stories at a time. Full setup is
documented in
[`supabase/RESEARCH_NEWS_SETUP.md`](supabase/RESEARCH_NEWS_SETUP.md).

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
- Eleven Select Sector SPDR ETFs form a deterministic Sector Rotation board. Each ETF is measured against SPY across 1-week, 1-month, 3-month, and 6-month windows, then ranked into Leading, Improving, Weakening, or Lagging zones.
- The full 20-name sector, theme, and asset-proxy tape keeps its absolute-return view with 1-day, 1-week, 1-month, 3-month, and YTD windows.
- Snapshot data refreshes every 15 minutes; sector return bars refresh hourly.
- `market_pulse_latest` retains one latest row per user and symbol, so the database does not accumulate a new row every refresh.

Adding or removing a Watchlist name triggers a targeted Market Pulse refresh. The Edge Function batches Webull snapshots in groups of at most 100 symbols, allowing a 200+ name Watchlist without serial browser requests.

## Deploy

This is a static app. Publish the repository root with GitHub Pages from the `main` branch.

For a local visual preview with sample-only data, run `node dev-server.mjs` and open `http://127.0.0.1:4173/?preview=1`. The preview path is available only on localhost.

## Hermes / MCP access

Hermes connects to data, not dashboard files:

```text
Hermes -> local stdio MCP -> portfolio-agent-api -> Supabase
```

Canonical brief jobs call `refresh_brief_sources` before reading their shared
fact pack. That action reuses the budgeted News collector, so Reuters X posts
are fetched once and shared by News and Briefs; a failed refresh falls back to
the existing cache instead of cancelling the edition.

Run [`supabase/017_hermes_agent_api.sql`](supabase/017_hermes_agent_api.sql),
then deploy both Edge Functions:

```bash
supabase functions deploy portfolio-agent-api --project-ref zzynqlqnzdhkffvqvpzt
supabase functions deploy refresh-stock-prices --project-ref zzynqlqnzdhkffvqvpzt
```

Open `Account > New token` in the dashboard. The plaintext token is shown once;
store it as `PCC_AGENT_TOKEN` in Hermes' local secrets. The adapter and example
configuration are in [`hermes-mcp`](hermes-mcp).

The MCP tools can read every dashboard area, manage the separate Watchlist, and
create expiring trade/cash drafts. They cannot confirm drafts, run SQL, edit
balances directly, delete history, or place broker orders. Confirm pending
Hermes drafts from `Account > Agent drafts`.

### Daily Market Brief

Run [`supabase/036_daily_market_briefs.sql`](supabase/036_daily_market_briefs.sql)
and deploy `portfolio-agent-api`. Hermes receives a narrow
`briefings:write` scope for the canonical 20:00 Asia/Bangkok Brief and material
00:00 Continuations. Supabase stores the full publication and notification
state; Telegram carries a concise preview and a link to `?route=briefs`.
The shared fact pack includes a compact cache of current external reporting so
a blocked article page is not a single point of failure. Hermes still researches
multiple current domains and must synthesize market-wide drivers; Market Pulse,
FRED risk and official Macro facts verify numbers but never substitute for news
headlines. A silent 20:20 recovery job retries that evidence workflow only when
the 20:00 canonical edition is still missing.

Reuters X reporting is collected once into the shared Research corpus under a
fixed monthly Post budget. News and Hermes read the same canonical rows; members
retain separate read, saved and hidden state without multiplying X API usage.
