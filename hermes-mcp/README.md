# Hermes MCP adapter

This local stdio MCP server gives Hermes scoped access to Portfolio Command
Center without editing dashboard files or receiving Supabase SQL access.

## Safety boundary

- Read tools cover Overview, Portfolios, Trading P/L, Watchlist, Research News,
  Earnings, the high-impact Macro calendar and alert feed, Market Pulse, Smart
  Money, and Webull chart bars.
- `scan_watchlist_setups` performs the Daily Reclaim EMA200 / Near Support pass
  server-side in bounded batches of 20 and returns compact metrics only. Follow
  `next_offset` until complete, then request 4H/1H bars only for the resulting
  `READY_FOR_4H` shortlist.
- `get_macro_calendar` reads the same cached high-impact US event tape shown in
  PCC. `get_macro_alerts` is the compact monitor input: upcoming releases,
  recent Actual values, the next FOMC decision, and source freshness. Neither
  tool triggers a data sync or sends a notification by itself.
- `get_option_chain` reads the subscription owner's live Webull OPRA tape used
  by Option Desk. `analyze_option_contract` selects one returned contract and
  calculates payoff, spread quality, break-even and portfolio collateral using
  PCC's deterministic rules. Both are read-only, owner-gated, and cannot create
  a plan, draft, fill or broker order. Other PCC members do not inherit the
  owner's OPRA entitlement.
- `get_briefing_context` defaults to a privacy-safe `shared_market` fact pack:
  benchmarks, sectors, and high-impact Macro only. The canonical 20:00 brief
  combines that pack with current external research and never uses an owner's
  positions or Watchlist. `personal` is reserved for separate private analysis.
  Hermes reads the canonical edition before publishing exactly one midnight
  result: a silent completed-session Market Check when the thesis is unchanged,
  or a notified material Continuation when it changes. All publication tools
  require the `briefings:write` scope.
- `get_smart_money_briefing_context` is a fixed rolling 30-day, weekly fact
  pack. Supabase removes Form 4 event keys used by prior editions before Hermes
  sees them. `publish_smart_money_brief` refuses stale sources, empty reports,
  duplicate events and more than one edition inside six days; it uses the same
  narrow `briefings:write` scope.
- Valuation research uses a durable pull queue. `claim_valuation_research_job`
  leases one member-requested job for 45 minutes. Ian researches it in the
  Research room, then `submit_valuation_research_draft` sends reported facts,
  sourced forward assumptions and a concise Thai brief. Ian never submits a
  fair value: the Agent API validates the packet and PCC calculates Bear, Base
  and Bull before Supabase stores a numbered Draft revision and notification.
  `fail_valuation_research_job` is reserved for genuinely unverifiable inputs.
  Completed revisions remain readable while Hermes is offline.
- Trade and cash tools create expiring drafts only.
- Draft confirmation is intentionally absent from MCP. Confirm from
  `Account > Agent drafts` in the dashboard.
- Watchlist writes never change cash, positions, allocation, or broker orders.
- `acknowledge_news` changes only the alert monitor's processed state. It does
  not mark an article read for the member. Alert jobs classify the complete
  batch first, then close every inspected ID once so rejected or merged items
  cannot consume tokens again.
- `requeue_news_alerts` is a narrow recovery tool for article IDs that were
  acknowledged before delivery. It never changes the member's read state and
  is not part of a normal monitor run.
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

After adding or updating tools, restart the `portfolio-command-center` MCP
server in Hermes so each profile, including Ian, receives the new `tools/list`.
