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

## Deploy

This is a static app. Publish the repository root with GitHub Pages from the `main` branch.

For a local visual preview with sample-only data, run `node dev-server.mjs` and open `http://127.0.0.1:4173/?preview=1`. The preview path is available only on localhost.
