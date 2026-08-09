# PCC Daily Market Brief jobs

These jobs create one canonical brief in PCC. Telegram is a delivery surface,
not a second independent analysis.

## 20:00 Asia/Bangkok

```text
Create today's canonical Portfolio Command Center DAILY MARKET BRIEF.

1. Call get_briefing_context with news_hours=30 and audience=shared_market.
2. Write the brief in concise Thai, keeping tickers, release names and standard
   market terms in English when clearer. This is a SHARED, NEUTRAL brief for
   every PCC reader. Never mention or optimize for the owner's portfolio,
   positions, watchlist, preferences or private context.
3. Research the current external news cycle with the web search tools before
   writing. PCC market and Macro data are verified context, not the boundary
   of the research. Prefer official agencies and company releases for primary
   facts, plus reputable current reporting such as Reuters, AP or major market
   publications for context. Verify the publication time and the event date;
   do not mistake an old article for a new development. Never invent market
   values, consensus forecasts, quotes, source ids or citations.
4. Synthesize the market, do not copy the PCC News feed or a search-results
   list into the brief. The three
   to five top_stories are MARKET DRIVERS: each story may combine several
   related articles, macro events, price moves or earnings facts into one
   coherent theme. Use a copied headline only when that single event is itself
   the market driver. Rank stories by likely impact on broad US equities,
   rates, inflation, oil, FX, credit or an economically important industry.
   A single-company story belongs only when it is independently market-moving;
   never include a ticker merely because the owner holds or tracks it. Ignore
   filler and duplicate angles.
   Research at least these lanes before ranking: broad US market/rates,
   macro/policy, energy/geopolitics, and market-wide earnings or industry
   themes. The final sources must include at least two current external
   reporting sources outside PCC and official economic calendars. If that
   evidence is unavailable, do not publish a thin brief; report the research
   gap instead.
5. Keep each section non-overlapping and exactly match the tool schema:
   - market_mood: the one-sentence regime and the tension that could change it.
   - market_snapshot: 3-10 verified numbers, each with label, value, change,
     tone.
   - top_stories: 3-5 objects with title, 1-3 facts, 1-2 interpretation points,
     and source_ids. Facts say what is confirmed; interpretation explains the
     market transmission path such as Oil -> Inflation -> Yield -> Growth.
   - investment_implications: 3-5 objects with title, detail, tone. Use short
     labels such as Positive, Risk or Watch and explain the broad read-through
     for asset classes, sectors, yields or market style. Do not prescribe a
     personal trade and do not repeat story facts.
   - watch_next: 2-6 objects with title, detail, tone. Put date/time and event in
     title; detail states which market assumption or thesis the event tests.
   - bottom_line: 2-3 objects with title, detail, tone. Cover only the current
     setup, the main trigger and the clearest invalidation/risk. Do not repeat
     snapshot numbers, headlines or generic disclaimers.
   - sources: only sources actually referenced by top_stories.
   Keep the notification summary under 500 characters.
6. On weekends or market holidays, state that the market is closed and anchor
   the snapshot to the latest completed session while still covering material
   developments since that close.
7. Before publishing, reject your own draft if any object is blank, if two
   sections make the same point, or if a top story is merely one News item
   pasted without broader market meaning. Also reject it if a personal ticker
   appears without clear evidence that it is a top market-wide driver, or if
   sources contain only PCC feeds and official release calendars.
8. Publish with brief_date equal to today's Asia/Bangkok date and
   idempotency_key daily-market-brief:YYYY-MM-DD.
9. After publication, return a concise Telegram preview: market mood, the two
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
   news_hours=8 and audience=shared_market. Research current external sources
   with the web search tools and verify event dates before comparing.
2. This is a SHARED, NEUTRAL update for every PCC reader. Never request or use
   the owner's portfolio, positions, watchlist or preferences. PCC News is
   supplemental context, not the research boundary.
3. Compare the current facts with the published brief. A material change means
   a major index, yield or volatility move; a newly released high-impact macro
   value; important breaking news; a changed market thesis; or a concrete
   market-wide sector or asset-class impact. A tracked ticker alone is not a
   material change.
   Search broad US market/rates, macro/policy, energy/geopolitics and major
   industry developments before deciding that the thesis is unchanged.
4. If there is no material change, do not call publish_brief_continuation.
   Return one short Telegram line saying the canonical thesis is unchanged.
5. If there is a material change, publish only the delta. Set material_change
   true, thesis_status to unchanged or updated. Every changes,
   portfolio_impact and watch_next item must contain title, detail and tone.
   Treat portfolio_impact as the broad MARKET IMPACT field for schema
   compatibility: explain asset-class, sector, rate or volatility effects,
   never personal holdings. Explain what changed, why it matters to the
   existing thesis, and what would confirm or reverse it. Do not repeat the
   canonical brief.
6. Use idempotency_key
   daily-market-brief:YYYY-MM-DD:continuation:0000 and return a concise Telegram
   preview plus:
   https://cutiebunny2811.github.io/portfolio-command-center/?route=briefs

Never invent missing data or create trade drafts from a market brief.
```
