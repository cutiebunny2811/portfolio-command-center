import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

function listTools() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server.mjs"], {
      cwd: new URL("..", import.meta.url),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const line = stdout.split("\n").find(Boolean);
      if (!line) return;
      child.kill();
      try {
        resolve(JSON.parse(line).result.tools);
      } catch (error) {
        reject(error);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!stdout && code !== null && code !== 0) reject(new Error(stderr || `server exited ${code}`));
    });
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  });
}

function callTool(name, args) {
  return new Promise((resolve, reject) => {
    const requests = [];
    const api = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        requests.push(JSON.parse(body));
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
    });
    api.listen(0, "127.0.0.1", () => {
      const address = api.address();
      const child = spawn(process.execPath, ["server.mjs"], {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          PCC_AGENT_API_URL: `http://127.0.0.1:${address.port}`,
          PCC_AGENT_TOKEN: "test-token",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const line = stdout.split("\n").find(Boolean);
        if (!line) return;
        child.kill();
        api.close();
        try {
          resolve({ response: JSON.parse(line), request: requests[0] });
        } catch (error) {
          reject(error);
        }
      });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (!stdout && code !== null && code !== 0) reject(new Error(stderr || `server exited ${code}`));
      });
      child.stdin.end(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      })}\n`);
    });
  });
}

test("exposes Rule-A campaign resolution and confirmed execution export", async () => {
  const tools = await listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  assert.ok(byName.has("resolve_rule_a_campaign"));
  assert.ok(byName.has("get_confirmed_execution_sync"));
  assert.equal(byName.get("create_trade_draft").inputSchema.properties.campaign_id.type, "string");
});

test("exposes and routes the bounded watchlist setup scanner", async () => {
  const tools = await listTools();
  const scanner = tools.find((tool) => tool.name === "scan_watchlist_setups");
  assert.ok(scanner);
  assert.equal(scanner.inputSchema.properties.batch_size.maximum, 20);
  assert.deepEqual(scanner.inputSchema.properties.setup.enum, ["both", "reclaim_ema200", "near_support"]);

  const { response, request } = await callTool("scan_watchlist_setups", {
    offset: 20,
    batch_size: 20,
    setup: "both",
  });
  assert.equal(response.result.isError, false);
  assert.deepEqual(request, {
    action: "watchlist_setups",
    offset: 20,
    batch_size: 20,
    setup: "both",
  });
});

test("exposes read-only News and Earnings tools", async () => {
  const tools = await listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  assert.deepEqual(byName.get("get_news").inputSchema.properties.filter.enum, [
    "all", "unread", "alerts", "portfolio", "macro", "saved",
  ]);
  assert.equal(byName.get("get_news").inputSchema.properties.page_size.maximum, 50);
  assert.equal(byName.get("get_earnings_calendar").inputSchema.properties.symbol.type, "string");
  assert.equal(byName.get("acknowledge_news").inputSchema.properties.article_ids.maxItems, 50);
  assert.ok(byName.get("acknowledge_news").inputSchema.required.includes("claim_token"));
  assert.equal(byName.get("requeue_news_alerts").inputSchema.properties.article_ids.maxItems, 12);
});

test("routes narrow News alert recovery without changing user read state", async () => {
  const articleId = "22222222-2222-4222-8222-222222222222";
  const result = await callTool("requeue_news_alerts", { article_ids: [articleId] });
  assert.equal(result.response.result.isError, false);
  assert.deepEqual(result.request, { action: "requeue_news_alerts", article_ids: [articleId] });
});

test("routes News monitor acknowledgement without changing user read state", async () => {
  const articleId = "11111111-1111-4111-8111-111111111111";
  const claimToken = "22222222-2222-4222-8222-222222222222";
  const result = await callTool("acknowledge_news", { article_ids: [articleId], claim_token: claimToken });
  assert.equal(result.response.result.isError, false);
  assert.deepEqual(result.request, { action: "acknowledge_news", article_ids: [articleId], claim_token: claimToken });
});

test("routes News and Earnings calls to their read-only API actions", async () => {
  const news = await callTool("get_news", { filter: "saved", search: "NVDA" });
  const earnings = await callTool("get_earnings_calendar", { symbol: "AXTI" });

  assert.equal(news.response.result.isError, false);
  assert.deepEqual(news.request, { action: "news", filter: "saved", search: "NVDA" });
  assert.equal(earnings.response.result.isError, false);
  assert.deepEqual(earnings.request, { action: "earnings", symbol: "AXTI" });
});

test("exposes Ian-completed valuation research and routes the finished archive", async () => {
  const tools = await listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const claim = byName.get("claim_valuation_research_job");
  const submit = byName.get("submit_completed_valuation_research");
  const fail = byName.get("fail_valuation_research_job");

  assert.ok(claim);
  assert.ok(submit);
  assert.ok(fail);
  const valuation = submit.inputSchema.properties.completed_valuation;
  assert.ok(valuation.required.includes("base_value"));
  assert.equal(valuation.properties.bear_value.type, "number");
  assert.equal(valuation.properties.bull_value.type, "number");
  assert.match(submit.description, /Ian-calculated valuation/i);
  assert.match(submit.description, /does not calculate or override/i);
  assert.doesNotMatch(submit.description, /PCC calculates fair values/i);

  const claimed = await callTool("claim_valuation_research_job", {});
  assert.equal(claimed.response.result.isError, false);
  assert.deepEqual(claimed.request, { action: "claim_valuation_research" });

  const completed = await callTool("submit_completed_valuation_research", {
    job_id: "11111111-1111-4111-8111-111111111111",
    claim_token: "22222222-2222-4222-8222-222222222222",
    report_period: "2026-Q2",
    completed_research: {
      schema_version: 1,
      headline: "NVDA completed research",
      summary: "Primary-source conclusion.",
      report: "Full sourced report.",
      methodology: "Normalized forward DCF.",
      as_of: "2026-08-22",
      sources: [{ title: "NVIDIA 10-Q", url: "https://www.sec.gov/example" }],
    },
    completed_valuation: {
      currency: "USD",
      as_of: "2026-08-22",
      method: "Normalized forward DCF",
      base_value: 135.69,
      calculation_summary: "Ian discounted the sourced cash-flow cases.",
      key_assumptions: ["Base growth 15%"],
      risks: ["AI capex normalization"],
    },
    idempotency_key: "valuation-research:11111111-1111-4111-8111-111111111111",
  });
  assert.equal(completed.response.result.isError, false);
  assert.equal(completed.request.action, "submit_completed_valuation_research");
  assert.equal(completed.request.completed_valuation.base_value, 135.69);

  const failed = await callTool("fail_valuation_research_job", {
    job_id: "11111111-1111-4111-8111-111111111111",
    claim_token: "22222222-2222-4222-8222-222222222222",
    message: "Latest filing could not be verified.",
  });
  assert.equal(failed.response.result.isError, false);
  assert.deepEqual(failed.request, {
    action: "fail_valuation_research",
    job_id: "11111111-1111-4111-8111-111111111111",
    claim_token: "22222222-2222-4222-8222-222222222222",
    message: "Latest filing could not be verified.",
  });
});

test("exposes and routes owner-only read-only Option Desk tools", async () => {
  const tools = await listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const chainTool = byName.get("get_option_chain");
  const analysisTool = byName.get("analyze_option_contract");

  assert.deepEqual(chainTool.inputSchema.properties.option_type.enum, ["call", "put"]);
  assert.deepEqual(analysisTool.inputSchema.properties.strategy.enum, [
    "long_call", "long_put", "covered_call", "cash_secured_put",
  ]);
  assert.match(analysisTool.description, /Read-only market analysis only/);

  const chain = await callTool("get_option_chain", { symbol: "EOSE", option_type: "call", expiry: "2026-08-28" });
  const analysis = await callTool("analyze_option_contract", {
    portfolio: "Long Term",
    symbol: "EOSE",
    strategy: "long_call",
    expiry: "2026-08-28",
    strike: 2.5,
  });
  assert.equal(chain.response.result.isError, false);
  assert.deepEqual(chain.request, { action: "option_chain", symbol: "EOSE", option_type: "call", expiry: "2026-08-28" });
  assert.equal(analysis.response.result.isError, false);
  assert.deepEqual(analysis.request, {
    action: "option_analysis",
    portfolio: "Long Term",
    symbol: "EOSE",
    strategy: "long_call",
    expiry: "2026-08-28",
    strike: 2.5,
  });
});

test("exposes and routes read-only Macro calendar tools", async () => {
  const tools = await listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const calendar = await callTool("get_macro_calendar", { from: "2026-08-07", to: "2026-08-14", category: "inflation" });
  const alerts = await callTool("get_macro_alerts", { hours_ahead: 24, hours_back: 6 });
  const risk = await callTool("get_macro_risk_monitor", {});

  assert.equal(byName.get("get_macro_calendar").inputSchema.properties.limit.maximum, 500);
  assert.deepEqual(byName.get("get_macro_alerts").inputSchema.properties.category.enum, [
    "policy", "inflation", "labor", "growth", "activity", "consumption",
  ]);
  assert.equal(calendar.response.result.isError, false);
  assert.deepEqual(calendar.request, {
    action: "macro_calendar", from: "2026-08-07", to: "2026-08-14", category: "inflation",
  });
  assert.equal(alerts.response.result.isError, false);
  assert.deepEqual(alerts.request, { action: "macro_alerts", hours_ahead: 24, hours_back: 6 });
  assert.equal(byName.get("get_macro_risk_monitor").inputSchema.additionalProperties, false);
  assert.equal(risk.response.result.isError, false);
  assert.deepEqual(risk.request, { action: "macro_risk_monitor" });
});

test("exposes canonical Daily Market Brief read and publish tools", async () => {
  const tools = await listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  assert.equal(byName.get("get_briefing_context").inputSchema.properties.news_hours.maximum, 168);
  assert.equal(byName.get("refresh_brief_sources").inputSchema.additionalProperties, false);
  assert.deepEqual(byName.get("get_briefing_context").inputSchema.properties.audience.enum, ["shared_market", "personal"]);
  assert.equal(byName.get("get_briefing_context").inputSchema.properties.audience.default, "shared_market");
  assert.equal(byName.get("get_daily_market_brief").inputSchema.properties.brief_date.type, "string");
  const briefContent = byName.get("publish_daily_market_brief").inputSchema.properties.content;
  assert.equal(briefContent.properties.top_stories.minItems, 3);
  assert.equal(briefContent.properties.top_stories.maxItems, 5);
  assert.deepEqual(briefContent.properties.top_stories.items.required, ["title", "facts", "interpretation", "source_ids"]);
  assert.deepEqual(briefContent.properties.investment_implications.items.required, ["title", "detail", "tone"]);
  assert.equal(briefContent.properties.bottom_line.items.additionalProperties, false);
  const marketCheckContent = byName.get("publish_midnight_market_check").inputSchema.properties.content;
  assert.equal(marketCheckContent.properties.rotation_leaders.minItems, 1);
  assert.equal(marketCheckContent.properties.rotation_laggards.maxItems, 8);
  assert.match(marketCheckContent.properties.data_note.description, /price-based relative rotation/);
  assert.deepEqual(byName.get("publish_brief_continuation").inputSchema.properties.thesis_status.enum, ["unchanged", "updated"]);
});

test("routes Daily Market Brief calls to scoped API actions", async () => {
  const refresh = await callTool("refresh_brief_sources", {});
  const context = await callTool("get_briefing_context", { news_hours: 24, audience: "shared_market" });
  const brief = await callTool("get_daily_market_brief", { brief_date: "2026-08-09" });
  const publish = await callTool("publish_daily_market_brief", {
    brief_date: "2026-08-09",
    summary: "Constructive tape with CPI risk ahead.",
    content: {
      market_mood: { label: "Constructive", tone: "caution", summary: "CPI remains the next decision point." },
      market_snapshot: [
        { label: "S&P 500", value: "7,700", change: "+0.6%", tone: "positive" },
        { label: "US 10Y", value: "4.64%", change: "Lower", tone: "positive" },
        { label: "VIX", value: "15.4", change: "Contained", tone: "neutral" },
      ],
      top_stories: Array.from({ length: 3 }, (_, index) => ({
        title: `Market driver ${index + 1}`,
        facts: ["Verified market fact."],
        interpretation: ["This changes the market through a defined transmission path."],
        source_ids: ["src-1"],
      })),
      investment_implications: Array.from({ length: 3 }, (_, index) => ({ title: `Implication ${index + 1}`, detail: "Decision-useful portfolio read-through.", tone: "neutral" })),
      watch_next: [
        { title: "CPI", detail: "Tests the yield and growth thesis.", tone: "caution" },
        { title: "PPI", detail: "Confirms or challenges the inflation path.", tone: "neutral" },
      ],
      bottom_line: [
        { title: "Setup", detail: "The constructive setup remains intact.", tone: "positive" },
        { title: "Invalidation", detail: "A hot CPI print is the clearest risk.", tone: "caution" },
      ],
      sources: [{ id: "src-1", title: "Source", url: "https://example.com/source", publisher: "Example" }],
    },
    idempotency_key: "daily-market-brief:2026-08-09",
  });
  const marketCheck = await callTool("publish_midnight_market_check", {
    brief_date: "2026-08-09",
    summary: "Cautious rotation without a material thesis change.",
    content: {
      session_date: "2026-08-09",
      session_label: "Latest completed US session · 2026-08-09",
      market_tone: { label: "Cautious rotation", tone: "caution", summary: "Tech lagged while defensive sectors held up." },
      market_snapshot: [
        { label: "SPY", value: "-0.5%", change: "Completed session", tone: "negative" },
        { label: "VIX", value: "15.4", change: "Contained", tone: "neutral" },
      ],
      rotation_leaders: [{ symbol: "XLV", label: "Health Care", change: "+1.7%" }],
      rotation_laggards: [{ symbol: "SMH", label: "Semiconductors", change: "-4.4%" }],
      data_note: "Price-based relative rotation; not verified ETF fund flow.",
      read_through: "The completed session still looks like rotation rather than broad financial stress.",
      watch_next: [{ title: "FOMC Minutes", detail: "Tests the rates pressure on growth.", tone: "caution" }],
      sources: [{ id: "src-1", title: "Source", url: "https://example.com/source", publisher: "Example" }],
    },
    idempotency_key: "daily-market-brief:2026-08-09:market-check:0000",
  });

  assert.equal(refresh.response.result.isError, false);
  assert.deepEqual(refresh.request, { action: "refresh_brief_sources" });
  assert.deepEqual(context.request, { action: "briefing_context", news_hours: 24, audience: "shared_market" });
  assert.deepEqual(brief.request, { action: "daily_market_brief", brief_date: "2026-08-09" });
  assert.equal(publish.request.action, "publish_market_brief");
  assert.equal(publish.request.idempotency_key, "daily-market-brief:2026-08-09");
  assert.equal(marketCheck.request.action, "publish_midnight_market_check");
  assert.equal(marketCheck.request.idempotency_key, "daily-market-brief:2026-08-09:market-check:0000");
});

test("exposes deterministic weekly Smart Money Brief tools", async () => {
  const tools = await listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const context = byName.get("get_smart_money_briefing_context");
  const publish = byName.get("publish_smart_money_brief");

  assert.equal(context.inputSchema.additionalProperties, false);
  assert.deepEqual(publish.inputSchema.required, ["report_date", "summary", "content"]);
  assert.equal(publish.inputSchema.properties.content.properties.open_market_buys.minItems, 0);
  assert.equal(publish.inputSchema.properties.content.properties.noise_removed.minItems, 1);
  assert.equal(publish.inputSchema.properties.content.properties.sources.maxItems, 30);
  assert.equal(publish.inputSchema.properties.content.required.includes("sources"), false);
  assert.equal(publish.inputSchema.properties.content.properties.bottom_line, undefined);
});

test("routes weekly Smart Money context and publication actions", async () => {
  const context = await callTool("get_smart_money_briefing_context", {});
  const publish = await callTool("publish_smart_money_brief", {
    report_date: "2026-08-16",
    summary: "New open-market activity was limited; mechanical filings were separated from signal.",
    content: {
      headline: "New buying was selective, while planned activity dominated the tape.",
      coverage_summary: "Rolling 30 days; collector fresh; only previously unreported events included.",
      open_market_buys: [{
        title: "TSM purchase cluster",
        detail: "Several code-P rows were filed by company officers.",
        tone: "positive",
        event_keys: ["accession:key-1"],
        source_ids: ["sec:accession"],
      }],
      sales_worth_context: [],
      noise_removed: [{
        title: "Planned and mechanical rows removed",
        detail: "10b5-1, tax and conversion rows were not treated as conviction signals.",
        tone: "neutral",
        event_keys: [],
        source_ids: [],
      }],
      watch_next: [{
        title: "Next filing cycle",
        detail: "Watch for another discretionary purchase from the same cluster.",
        tone: "neutral",
        event_keys: [],
        source_ids: [],
      }],
      sources: [{ id: "sec:accession", title: "SEC Form 4", url: "https://www.sec.gov/example", publisher: "SEC" }],
    },
    idempotency_key: "smart-money-brief:2026-08-16",
  });

  assert.deepEqual(context.request, { action: "smart_money_briefing_context" });
  assert.equal(publish.request.action, "publish_smart_money_brief");
  assert.equal(publish.request.idempotency_key, "smart-money-brief:2026-08-16");
});
