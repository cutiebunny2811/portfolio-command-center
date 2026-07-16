# Portfolio Command Center

Private portfolio allocation and trading P/L dashboard backed by Supabase.

## Data model

- Four isolated portfolios: Long Term, Swing Trade, Speculative, Options.
- USD base currency and weighted-average cost.
- Options allocation uses maximum loss; notional value is shown separately.
- Supabase is the only financial source of truth. Browser storage is used only by Supabase Auth for the signed-in session.
- Financial writes use reviewed RPC functions. Trade and cash changes use a Draft → Confirm flow.

## Supabase migrations

The existing project already uses schema/API migrations 001–004. Before using the combined journal, run [`supabase/005_journal_api.sql`](supabase/005_journal_api.sql), then check it with [`supabase/006_verify_journal_api.sql`](supabase/006_verify_journal_api.sql) in the Supabase SQL Editor.

## Deploy

This is a static app. Publish the repository root with GitHub Pages from the `main` branch.

For a local visual preview with sample-only data, run `node dev-server.mjs` and open `http://127.0.0.1:4173/?preview=1`. The preview path is available only on localhost.
