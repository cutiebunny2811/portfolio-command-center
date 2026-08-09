# PCC Daily Market Brief jobs

These jobs create one canonical brief in PCC. Telegram is a delivery surface,
not a second independent analysis.

## 20:00 Asia/Bangkok

```text
Create today's canonical Portfolio Command Center DAILY MARKET BRIEF.

1. Call get_briefing_context with news_hours=30.
2. Write the brief in concise Thai, keeping tickers, release names and standard
   market terms in English when clearer. Use only facts and URLs returned by
   PCC tools. Never invent unavailable market values, consensus forecasts,
   quotes, source ids or citations.
3. Synthesize the market, do not copy the News feed into the brief. The three
   to five top_stories are MARKET DRIVERS: each story may combine several
   related articles, macro events, price moves or earnings facts into one
   coherent theme. Use a copied headline only when that single event is itself
   the market driver. Ignore filler and duplicate angles.
4. Keep each section non-overlapping and exactly match the tool schema:
   - market_mood: the one-sentence regime and the tension that could change it.
   - market_snapshot: 3-10 verified numbers, each with label, value, change,
     tone.
   - top_stories: 3-5 objects with title, 1-3 facts, 1-2 interpretation points,
     and source_ids. Facts say what is confirmed; interpretation explains the
     market transmission path such as Oil -> Inflation -> Yield -> Growth.
   - investment_implications: 3-5 objects with title, detail, tone. Use short
     labels such as Positive, Risk or Watch and explain what changes for market
     exposure or the user's portfolio. Do not repeat story facts.
   - watch_next: 2-6 objects with title, detail, tone. Put date/time and event in
     title; detail states which market assumption or thesis the event tests.
   - bottom_line: 2-3 objects with title, detail, tone. Cover only the current
     setup, the main trigger and the clearest invalidation/risk. Do not repeat
     snapshot numbers, headlines or generic disclaimers.
   - sources: only sources actually referenced by top_stories.
   Keep the notification summary under 500 characters.
5. Before publishing, reject your own draft if any object is blank, if two
   sections make the same point, or if a top story is merely one News item
   pasted without broader market meaning.
6. Publish with brief_date equal to today's Asia/Bangkok date and
   idempotency_key daily-market-brief:YYYY-MM-DD.
7. After publication, return a concise Telegram preview: market mood, the two
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
   true, thesis_status to unchanged or updated. Every changes,
   portfolio_impact and watch_next item must contain title, detail and tone.
   Explain what changed, why it matters to the existing thesis, and what would
   confirm or reverse it. Do not repeat the canonical brief.
5. Use idempotency_key
   daily-market-brief:YYYY-MM-DD:continuation:0000 and return a concise Telegram
   preview plus:
   https://cutiebunny2811.github.io/portfolio-command-center/?route=briefs

Never invent missing data or create trade drafts from a market brief.
```
