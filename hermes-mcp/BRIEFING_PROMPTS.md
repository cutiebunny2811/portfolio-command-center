# PCC Daily Market Brief jobs

These jobs create one canonical brief in PCC. Telegram is a delivery surface,
not a second independent analysis.

## 20:00 Asia/Bangkok

```text
Create today's canonical Portfolio Command Center DAILY MARKET BRIEF.

1. Call get_briefing_context with news_hours=30.
2. Use only facts and URLs returned by PCC tools. Never invent unavailable
   market values, consensus forecasts, quotes, source ids or citations.
3. Separate confirmed facts from interpretation. Prefer three to five stories
   that materially affect US market direction or the user's positions and
   watchlist. Ignore filler.
4. Build content that exactly matches publish_daily_market_brief:
   market_mood, market_snapshot, top_stories, investment_implications,
   watch_next, bottom_line and sources. Each top story must reference its
   source ids. Keep the summary under 500 characters.
5. Publish with brief_date equal to today's Asia/Bangkok date and
   idempotency_key daily-market-brief:YYYY-MM-DD.
6. After publication, return a concise Telegram preview: market mood, the two
   most important points, the next catalyst, and this link:
   https://cutiebunny2811.github.io/portfolio-command-center/?route=briefs

Do not draft trades, edit a portfolio or publish a Continuation in this job.
```

## 00:00 Asia/Bangkok

```text
Check whether the preceding 20:00 Asia/Bangkok DAILY MARKET BRIEF needs a
CONTINUATION.

1. The canonical brief_date is yesterday's Asia/Bangkok date. Call
   get_daily_market_brief for that date, then call get_briefing_context with
   news_hours=8.
2. Compare the current facts with the published brief. A material change means
   a major index, yield or volatility move; a newly released high-impact macro
   value; important breaking news; a changed market thesis; or a concrete
   owned-position/watchlist impact.
3. If there is no material change, do not call publish_brief_continuation.
   Return one short Telegram line saying the canonical thesis is unchanged.
4. If there is a material change, publish only the delta. Set material_change
   true, thesis_status to unchanged or updated, and provide changes,
   portfolio_impact, watch_next and sources. Never rewrite the full brief.
5. Use idempotency_key
   daily-market-brief:YYYY-MM-DD:continuation:0000 and return a concise Telegram
   preview plus:
   https://cutiebunny2811.github.io/portfolio-command-center/?route=briefs

Never invent missing data or create trade drafts from a market brief.
```
