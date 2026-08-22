# PCC Daily Market Brief jobs

These jobs create one canonical brief in PCC. Telegram is a delivery surface,
not a second independent analysis.

## Weekly Smart Money Brief

```text
สร้าง PCC SMART MONEY BRIEF ประจำสัปดาห์จากโปรไฟล์ Webull นี้ โดยให้ฉบับใน PCC
และข้อความ Telegram ใช้ข้อเท็จจริง รายละเอียด และลำดับหัวข้อชุดเดียวกัน

1. เรียก get_smart_money_briefing_context เพียง 1 ครั้ง เครื่องมือนี้ใช้ rolling
   window 30 วันและตัด event_key ที่เคยเผยแพร่แล้วออกให้ ห้ามเรียก
   get_smart_money แยกอีกครั้ง
2. ถ้า freshness_status เป็น stale, response_truncated เป็น true หรือ
   new_event_count เป็น 0 ห้าม publish และตอบ [SILENT] เท่านั้น ข้อมูลล่าช้า
   ไม่ได้แปลว่า insiders ไม่มีธุรกรรม
3. เขียนไทยให้อ่านง่ายและมีรายละเอียดเท่ารายงาน Telegram เดิม เก็บ ticker,
   transaction code และคำ SEC เป็น English เมื่อชัดกว่า รายงานนี้เป็นข้อมูล
   Form 4 กลางสำหรับสมาชิกทุกคน ไม่อิงพอร์ตส่วนตัวและไม่ใช่คำแนะนำซื้อขาย
4. แยกประเภทธุรกรรมก่อนตีความ:
   - P is an open-market/private purchase; S is a sale.
   - 10b5-1 planned sales, DRIP, RSU vesting, sell-to-cover tax, awards, gifts,
     exercises, conversions, warrants and rights offerings are noise/context,
     not fresh conviction buys or discretionary bearish calls.
   - Never combine foreign and USD values unless the SEC filing explicitly
     supports the translation. Preserve SEC filing URLs.
5. รายงานเฉพาะ event_key ใหม่ใน context เท่านั้น รหัสจะเป็น short reference
   เช่น SM01, SM02 ให้คัดลอกตรงตัว ห้ามสร้าง hash เอง รวมรายการที่เกี่ยวข้องตาม
   ticker/filer ได้ แต่ต้องแนบ event_key ที่รองรับทุกอัน ห้ามเติมจากความจำและ
   ห้ามรายงานเหตุการณ์เดิมซ้ำ เซิร์ฟเวอร์จะแปลง short reference กลับเป็น SEC
   transaction key จริงก่อนบันทึก
6. ห้ามย่อเหลือเพียงหุ้นซื้อหนึ่งตัวและหุ้นขายหนึ่งตัว ให้ครอบคลุมกิจกรรมที่มี
   นัยสำคัญใน detail sample:
   - open_market_buys: include every decision-relevant code-P ticker up to 8
     items. Group related rows by ticker/filer. State insider name or role,
     transaction date, shares/value, direct/indirect/spouse ownership and why
     the size or pattern matters. Label DRIP or unclear small buys honestly.
   - sales_worth_context: include up to 8 useful ticker groups, prioritizing
     discretionary-looking sales and large activity. Always state when 10b5-1,
     tax, derivative or filing context weakens the signal.
   - noise_removed: group the major excluded categories and name representative
     tickers so readers can see what was filtered out.
   - watch_next: give concrete filing/context checks, not generic reminders.
7. โครงรายงานต้องมีเพียงสี่ส่วนนี้และเรียงตามนี้ ห้ามเพิ่ม Stella take หรือ
   Bottom line:
   - 🟢 ซื้อจริงที่น่าสนใจ -> open_market_buys
   - 🔴 ขายจริงที่ต้องรู้ -> sales_worth_context
   - ⚪ ตัดเสียงรบกวน -> noise_removed
   - 🚩 Worth watching -> watch_next
8. Match the publish_smart_money_brief schema:
   - headline: one neutral conclusion about the new weekly activity; maximum
     180 characters including spaces.
   - coverage_summary: เวลา ตรวจ ณ, ช่วงข้อมูล 30 วัน, แหล่ง PCC SEC Form 4,
     collector freshness, จำนวนใหม่ และข้อจำกัด coverage/limit ถ้ามี
   - sources is optional; the server derives missing SEC source records from
     event_keys. If supplied, include only SEC filings actually referenced.
9. แต่ละ item ต้องอ่านเหมือนย่อหน้าใน Telegram: title ระบุ ticker กับใจความ;
   detail เรียงวันที่ ชื่อ/ตำแหน่ง insider มูลค่าหรือจำนวนหุ้น ลักษณะ ownership,
   10b5-1/DRIP/tax/derivative context และความหมายของสัญญาณ ต้องแบ่ง detail
   เป็น 3-5 บรรทัดสั้นด้วย newline แบบ Telegram ห้ามอัดเป็นย่อหน้าเดียวและ
   ห้ามเขียนสั้นจนข้อมูลสำคัญหาย แต่ title ต้องไม่เกิน 180
   ตัวอักษรและ detail ของแต่ละ item ต้องไม่เกิน 1,200 ตัวอักษรรวมช่องว่าง
10. Keep the notification summary below 500 characters. Publish with today's
   Asia/Bangkok report_date and idempotency_key
   smart-money-brief:YYYY-MM-DD. The server enforces one edition per week,
   source freshness and event-level deduplication.
11. หลัง publish ให้ส่ง Telegram ฉบับเต็มด้วย format นี้ โดยใช้รายละเอียดเดียว
    กับ content ที่เพิ่ง publish ห้ามเขียนฉบับวิเคราะห์ใหม่ ห้ามตอบเพียงว่า
    publish สำเร็จ และห้ามย่อเป็นรายการประเด็นหลักนอกโครงสี่ส่วนนี้:

   📌 PCC Smart Money — ย้อนหลัง 30 วัน
   ตรวจ ณ: ...
   ช่วงข้อมูล: ...
   แหล่งข้อมูล: PCC SEC Form 4 Smart Money
   หมายเหตุ coverage: ...

   🟢 ซื้อจริงที่น่าสนใจ
   ...
   🔴 ขายจริงที่ต้องรู้
   ...
   ⚪ ตัดเสียงรบกวน
   ...
   🚩 Worth watching
   ...

   อ่านฉบับ PCC:
   https://cutiebunny2811.github.io/portfolio-command-center/?route=smart-money-briefs

Never create a trade draft from this job.
```

## 20:00 Asia/Bangkok

```text
Create today's canonical Portfolio Command Center DAILY MARKET BRIEF.

1. Call refresh_brief_sources once, then call get_briefing_context with
   news_hours=30 and audience=shared_market, then call get_macro_risk_monitor
   for the compact FRED risk/sentiment facts. If refresh_brief_sources reports
   unavailable, continue with cached_market_news instead of cancelling the
   edition.
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
   Reuters X entries tagged BRIEF_CANDIDATE are current reporting leads with a
   stable timestamp and source URL. They may establish a headline-level fact,
   but cross-check material numbers and detailed claims with an official
   release, market prices or another reputable publisher before writing them.
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
Run the 00:00 MARKET CHECK against the preceding 20:00 Asia/Bangkok DAILY
MARKET BRIEF. Every useful completed-session read must be retained in PCC, but
only a material change may create a Continuation notification.

1. The canonical brief_date is yesterday's Asia/Bangkok date. Call
   get_daily_market_brief for that date, then call refresh_brief_sources once,
   then call get_briefing_context with news_hours=8 and
   audience=shared_market, then call get_macro_risk_monitor. If the refresh is
   unavailable, continue with cached_market_news.
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
4. If there is no material change, call publish_midnight_market_check exactly
   once. Use the latest completed US session, never an unfinished intraday
   snapshot. The content must include:
   - session_date and an explicit completed-session session_label;
   - a neutral market_tone with label, tone and summary;
   - 2-8 verified market_snapshot rows;
   - 1-8 rotation_leaders and 1-8 rotation_laggards from PCC Market Pulse,
     each with symbol, neutral label and signed completed-session change;
   - data_note stating that Rotation Board is price-based relative rotation,
     not verified ETF fund flow;
   - one non-repetitive market-wide read_through explaining why the canonical
     thesis remains current;
   - 1-4 watch_next items and 1-12 sources.
   Use idempotency_key
   daily-market-brief:YYYY-MM-DD:market-check:0000. This publication is stored
   silently in PCC and must not be described as a Continuation.
5. If there is a material change, do not publish a routine Market Check.
   Call publish_brief_continuation exactly once and publish only the delta.
   Set material_change
   true, thesis_status to unchanged or updated. Every changes,
   portfolio_impact and watch_next item must contain title, detail and tone.
   Treat portfolio_impact as the broad MARKET IMPACT field for schema
   compatibility: explain asset-class, sector, rate or volatility effects,
   never personal holdings. Explain what changed, why it matters to the
   existing thesis, and what would confirm or reverse it. Do not repeat the
   canonical brief.
6. For a material change use idempotency_key
   daily-market-brief:YYYY-MM-DD:continuation:0000 and return a concise Telegram
   preview. For an unchanged thesis, return the complete useful Market Check
   preview with Market tone, Rotation leaders, Rotation laggards, Read-through
   and the next Catalyst. Both previews end with:
   https://cutiebunny2811.github.io/portfolio-command-center/?route=briefs

Never invent missing data or create trade drafts from a market brief.
```

## 20:20 Asia/Bangkok recovery

```text
Recover today's canonical Portfolio Command Center DAILY MARKET BRIEF only if
the 20:00 job did not publish it.

1. Resolve today's Asia/Bangkok date and call get_daily_market_brief for that
   date. If it exists, return exactly [SILENT].
2. If it does not exist, call refresh_brief_sources once, then call
   get_briefing_context with news_hours=30 and audience=shared_market, then
   call get_macro_risk_monitor. If the refresh is unavailable, continue with
   cached_market_news. Do not request personal context.
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

## News alert monitor

```text
Read PCC News once with filter=alerts and page_size=12. Do not call browser,
web search, Market Pulse or another PCC News read in the same run. First finish
deduplication for the complete batch. Keep the delivered and rejected article
IDs separate while composing the alert.

Every entry with must_notify=true or alert_delivery_rule=NOTIFY MUST appear in
the returned Telegram alert. The Hermes editorial pass may merge duplicate HIGH
rows, but it must never demote, reject or silently suppress a HIGH selected by
the PCC collector. A HIGH X_SOURCE_LEAD without an attached primary source is
still delivered and explicitly labelled "กำลังตรวจซ้ำจาก primary source".

MEDIUM entries remain editorial candidates. Reuters is the market desk: prefer
US indices, Fed/rates, inflation/labor, Treasury yields, oil and
market-transmitting geopolitics. @StockSavvyShay is the stock desk: prefer
earnings, guidance, contracts, partnerships, capex, deployments, material
product data and company filings. Never promote a MEDIUM item merely because it
mentions a watched ticker.

Deduplicate the same event and ticker. Keep each Telegram item concise and
include publisher, ticker(s), what changed and why it matters. X posts are
source leads; say "ตรวจซ้ำ" when no primary filing or article is attached.

The alerts response atomically leases its entries and returns a claim_token.
Concurrent jobs receive none of those IDs. Only after the final alert text
contains every non-duplicate HIGH, call acknowledge_news exactly once with that
exact claim_token and every article ID from the single get_news call, then
return that already-composed text without another classification
pass. This closes the IDs for this automated monitor only; it must not change
the member's read/unread state in PCC. Rejected MEDIUM, stale and merged entries
are closed too so they cannot consume tokens again. If acknowledgement fails,
return the alert text with a short dedup warning instead of [SILENT]. If no item
remains after filtering, acknowledge the inspected IDs and return [SILENT]. If
get_news returns no entries, do not acknowledge and return [SILENT].
If either PCC News MCP tool is unavailable or times out, fail closed with
exactly `[SILENT]`; never send a tool-error explanation as a Telegram alert.
```

## Ian valuation research worker

Run this worker in Ian's Research room at a short interval while Hermes is
online. The Supabase queue is durable, so an offline worker resumes from the
oldest waiting request after it returns.

```text
Process at most one Portfolio Command Center valuation-research job.

1. Call claim_valuation_research_job once. If data is null, return exactly
   [SILENT]. Never poll again inside the same run.
2. Post a concise status line in this Research room using the returned job_code
   and symbol. Then research the requested report_period from primary evidence:
   latest SEC 10-Q/10-K, material 8-K filings, earnings materials and a current
   share/dilution reconciliation. NotebookLM may organize supplied primary
   documents, but it must not replace source URLs or invent missing facts.
3. Write the full human-readable research report in this room before the tool
   submission. Keep reported facts, management guidance and Ian assumptions
   explicitly separate. Reconcile cash, short-term investments, debt, announced
   post-period cash uses and fully diluted shares. Use raw USD amounts, not
   millions. Do not use the current share price to choose assumptions.
4. Select one model family:
   - normalized_dcf for established positive cash generators;
   - transition_dcf for loss-making or temporarily negative-FCF businesses;
   - excess_return only for financial companies with positive book equity.
   Set company_stage to a short classification label of at most 40 characters,
   such as cash-generative, transition, loss-making growth or financial. Put
   the full explanation in rationale, never in company_stage.
   Build exactly Bear, Base and Bull assumptions in economic order. Each case
   must contain every model field required by the tool. Give each material
   post-period balance change its own sourced balance_adjustment.
5. Write brief in concise plain Thai: headline, summary, base_case, 1-6
   conditions, 1-6 risks and watch_metric. Keep tickers and standard finance
   terms in English when clearer. Do not include Markdown markers in these
   fields and do not make a buy/sell recommendation.
6. Call submit_valuation_research_draft exactly once with the exact job_id,
   claim_token and report_period from the claim. Use idempotency_key
   valuation-research:<job_id>. Never submit fair-value numbers; PCC calculates
   them server-side from the structured packet.
7. If the required filing, share count or revenue basis genuinely cannot be
   verified, call fail_valuation_research_job with a short user-facing reason.
   Do not fail merely because the company is difficult to value.
8. After successful submission, return a concise completion line with job_code,
   revision number and this link:
   https://cutiebunny2811.github.io/portfolio-command-center/?route=watchlist

Never create trades, change a portfolio, or submit a second job in this run.
```
