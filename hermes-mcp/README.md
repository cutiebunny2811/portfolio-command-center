# Hermes MCP adapter

This local stdio MCP server gives Hermes scoped access to Portfolio Command
Center without editing dashboard files or receiving Supabase SQL access.

## Safety boundary

- Read tools cover Overview, Portfolios, Trading P/L, Watchlist, Research News,
  Earnings, the high-impact Macro calendar and alert feed, Market Pulse, Smart
  Money, and Webull chart bars.
- `get_macro_calendar` reads the same cached high-impact US event tape shown in
  PCC. `get_macro_alerts` is the compact monitor input: upcoming releases,
  recent Actual values, the next FOMC decision, and source freshness. Neither
  tool triggers a data sync or sends a notification by itself.
- `get_briefing_context` defaults to a privacy-safe `shared_market` fact pack:
  benchmarks, sectors, and high-impact Macro only. The canonical 20:00 brief
  combines that pack with current external research and never uses an owner's
  positions or Watchlist. `personal` is reserved for separate private analysis.
  Hermes reads the canonical edition before publishing a material midnight
  delta. Both publish tools require the `briefings:write` scope.
- Trade and cash tools create expiring drafts only.
- Draft confirmation is intentionally absent from MCP. Confirm from
  `Account > Agent drafts` in the dashboard.
- Watchlist writes never change cash, positions, allocation, or broker orders.
- `acknowledge_news` changes only the member's News read state. Alert jobs call
  it after Telegram delivery succeeds so an item cannot be announced twice.
- The agent token is separate from the browser session and can be revoked.

## Hermes configuration

Run `node server.mjs` with these environment variables:

```text
PCC_AGENT_API_URL=https://zzynqlqnzdhkffvqvpzt.supabase.co/functions/v1/portfolio-agent-api
PCC_AGENT_TOKEN=pcc_...
PCC_REQUEST_TIMEOUT_MS=30000
```

Example MCP configuration:

```json
{
  "mcpServers": {
    "portfolio-command-center": {
      "command": "node",
      "args": [
        "C:\\Users\\Asus\\Documents\\Codex\\2026-07-16\\gridgeist\\portfolio-command-center-release\\hermes-mcp\\server.mjs"
      ],
      "env": {
        "PCC_AGENT_API_URL": "https://zzynqlqnzdhkffvqvpzt.supabase.co/functions/v1/portfolio-agent-api",
        "PCC_AGENT_TOKEN": "pcc_replace_me"
      }
    }
  }
}
```

Keep the real token in Hermes' local `.env` or secret configuration. Never add
it to GitHub Pages, `config.js`, a committed `.env`, or a chat message.

The production job instructions are in
[`BRIEFING_PROMPTS.md`](BRIEFING_PROMPTS.md). PCC stores the full publication;
Telegram should carry only the preview and deep link.
