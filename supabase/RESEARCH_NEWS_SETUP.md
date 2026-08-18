# News + SEC 8-K

News is a source-first inbox for articles and official SEC 8-K filings that mention a stock or ETF in
the signed-in user's tracked universe:

- `All` includes Watchlist names plus stocks/ETFs currently held in a portfolio.
- `Unread` excludes articles already opened or marked read.
- `Portfolio` keeps only news matched to a current position.
- `Saved` keeps the user's bookmarks.

There is intentionally no AI score and no quarterly financial-statement
calculation in V1.

The article layer is source-agnostic. The collector uses Massive News and Massive's SEC EDGAR
8-K text endpoint; every filing keeps its original SEC.gov filing URL. Additional source adapters can be added later without changing
the read/save/hide workflow or duplicating per-user article content.

## Install

1. Run `supabase/021_research_news.sql` once in the Supabase SQL Editor.
2. Run `supabase/022_research_ticker_search.sql` to make search exact and ticker-only.
3. Reuse the existing `MASSIVE_API_KEY` Edge Function secret for both news and SEC 8-K data.
4. Add a long random `RESEARCH_SYNC_SECRET` for scheduled collector calls.
5. Deploy the collector:

```bash
supabase functions deploy sync-research-news --project-ref zzynqlqnzdhkffvqvpzt --no-verify-jwt
```

The function still authenticates manual dashboard calls. `--no-verify-jwt`
only allows the scheduler to reach it; scheduled calls must supply the matching
`x-sync-secret` header.

Run the collector every 15–30 minutes. Each run checks a bounded 72-hour
Massive News window, upserts articles by source ID, and records only matches for
tracked symbols. The dashboard requests 25 rows per page and never downloads the
entire archive.

## Shared X budget

Run `041_shared_x_budget.sql` before deploying the current collector. X sources
are fetched once per handle and the canonical article is then linked to every
subscribed member, so adding friends does not multiply X reads. The same stored
Reuters rows serve the News page and Hermes briefing context.

The internal target is 900 Post reads per Bangkok month (about $4.50 at $0.005
per Post), with plans of 420 for the Reuters market desk and up to 480 for the
`@stocksavvyshay` stock desk. Reuters runs after 19:00 and 23:00 Bangkok.
Shay runs after 20:00, 00:00 and 03:00 Bangkok to cover the observed US-session
posting pattern. `@naklongpoong` is disabled because its posts frequently repeat
the same upstream stock stories. Repeated collector
invocations in the same window do not call X again. Keep the X Developer Console
spending limit at $5 as the external hard stop.

Every kept X row is tagged `ALERT_HIGH` or `ALERT_MEDIUM`. Hermes News monitors
must request `alerts`. A collector-confirmed HIGH is mandatory output; an X lead
without a primary source is labelled as awaiting confirmation instead of being
silently rejected. `acknowledge_news` closes the automated monitor state without
changing the member's read/unread state, and `[SILENT]` is valid only when no
qualifying row remains.

Hermes calls `refresh_brief_sources` immediately before the 20:00 brief and
00:00 continuation. The action invokes this same collector with the server-side
sync secret, so it does not require Steel, a browser session, or a second X
integration. The midnight call receives a short grace window for the preceding
23:00 Reuters batch.
