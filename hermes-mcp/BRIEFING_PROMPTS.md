# PCC Daily Market Brief jobs

These jobs create one canonical brief in PCC. Telegram is a delivery surface,
not a second independent analysis.

## 20:00 Asia/Bangkok

```text
Create today's canonical Portfolio Command Center DAILY MARKET BRIEF.

1. Call get_briefing_context with news_hours=30 and audience=shared_market,
   then call get_macro_risk_monitor for the compact FRED risk/sentiment facts.
2. Write the brief in concise Thai, keeping tickers, release names and standard
   market terms in English when clearer. This is a SHARED, NEUTRAL brief for
   every PCC reader. Never mention or optimize for the owner's portfolio,
   positions, watchlist, preferences or private context.
3. Research the current external news cycle with the web search tools before
   writing. The cached_market_news entries in the shared fact pack are
   privacy-safe external reporting collected before briefing time, not the
   owner's News feed. Use them as a fallback evidence pool when a live article
   page blocks access. Try multiple independent domains across official
   agencies and reputable market publications. If one domain returns CAPTCHA,
   403 or Access Denied, stop retrying that domain, inspect current cached
   reporting, and cross-check the claim with another publisher, an official
   release or search results. Verify publication time and event date; never
   invent market values, consensus forecasts, quotes, source ids or citations.
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
   themes. A full edition needs at least three current driver-grade evidence
   items across at least two publishers or official primary sources. Cached
   articles qualify when their title, description, publisher, URL and
   published_at are present and the claim is cross-checked. FRED, the PCC risk
   score, source availability, and the fact that a release is scheduled may
   support a story but must never become a Top Story merely to fill a slot.
   Never publish stories such as 'FRED coverage is incomplete', 'PCC risk is
   mixed' or 'the next release is CPI' without a current market reaction,
   changed expectation or decision-relevant transmission path. A blocked
   website must never be the sole reason that PCC has no daily brief.
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
   appears without clear evidence that it is a top market-wide driver. Reject
   any edition whose Top Stories are mostly data availability, static FRED
   conditions or calendar reminders. Official series and calendars may verify
   facts, but current reporting must explain what is moving expectations now.
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
   news_hours=8 and audience=shared_market, then call get_macro_risk_monitor.
   Research current external sources with the web search tools and verify event
   dates before comparing.
   If the canonical brief is missing, return exactly [SILENT]; the 20:20
   recovery job owns missing-edition repair, and Telegram does not need a
   second failure notification.
2. This is a SHARED, NEUTRAL update for every PCC reader. Never request or use
   the owner's portfolio, positions, watchlist or preferences. PCC News is
   supplemental context, not the research boundary.
3. Compare the current facts with the published brief. A material change means
   a major index, yield or volatility move; a newly released high-impact macro
   value; important breaking news; a changed market thesis; or a concrete
   market-wide sector or asset-class impact. A tracked ticker alone is not a
   material change.
   Search broad US market/rates, macro/policy, energy/geopolitics and major
   industry developments before deciding that the thesis is unchanged. If a
   domain blocks access, move to another source or rely on fresh structured PCC
   facts. A blocked domain by itself is not a material market change.
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

## 20:20 Asia/Bangkok recovery

```text
Recover today's canonical Portfolio Command Center DAILY MARKET BRIEF only if
the 20:00 job did not publish it.

1. Resolve today's Asia/Bangkok date and call get_daily_market_brief for that
   date. If it exists, return exactly [SILENT].
2. If it does not exist, call get_briefing_context with news_hours=30 and
   audience=shared_market, then call get_macro_risk_monitor. Do not request
   personal context.
3. Retry external research across different domains, then use
   cached_market_news as the fallback evidence pool. A blocked article URL does
   not invalidate a cached item whose publisher, title, description, URL and
   timestamp are complete, but material claims still require an independent
   publisher, official source or consistent market-price reaction.
4. Follow the same schema, evidence floor and non-overlap rules as the 20:00
   job. Synthesize three to five current market drivers. Do not use FRED risk,
   source failures or the macro calendar as substitute headlines. If current
   evidence is thinner than the primary edition, omit unsupported detail and
   state the narrower coverage without turning the limitation into a story.
5. Put RECOVERY EDITION in source_context.coverage_mode, keep
   the Telegram summary under 500 characters, and publish with idempotency_key
   daily-market-brief:YYYY-MM-DD. The database idempotency guard makes a race
   with a late primary job safe.
6. Return a concise recovery preview plus:
   https://cutiebunny2811.github.io/portfolio-command-center/?route=briefs

Never publish a Continuation or use a user's holdings in this recovery job.
```
