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

test("exposes read-only News and Earnings tools", async () => {
  const tools = await listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  assert.deepEqual(byName.get("get_news").inputSchema.properties.filter.enum, [
    "all", "unread", "portfolio", "macro", "saved",
  ]);
  assert.equal(byName.get("get_news").inputSchema.properties.page_size.maximum, 50);
  assert.equal(byName.get("get_earnings_calendar").inputSchema.properties.symbol.type, "string");
});

test("routes News and Earnings calls to their read-only API actions", async () => {
  const news = await callTool("get_news", { filter: "saved", search: "NVDA" });
  const earnings = await callTool("get_earnings_calendar", { symbol: "AXTI" });

  assert.equal(news.response.result.isError, false);
  assert.deepEqual(news.request, { action: "news", filter: "saved", search: "NVDA" });
  assert.equal(earnings.response.result.isError, false);
  assert.deepEqual(earnings.request, { action: "earnings", symbol: "AXTI" });
});

test("exposes and routes read-only Macro calendar tools", async () => {
  const tools = await listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const calendar = await callTool("get_macro_calendar", { from: "2026-08-07", to: "2026-08-14", category: "inflation" });
  const alerts = await callTool("get_macro_alerts", { hours_ahead: 24, hours_back: 6 });

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
});

test("exposes canonical Daily Market Brief read and publish tools", async () => {
  const tools = await listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  assert.equal(byName.get("get_briefing_context").inputSchema.properties.news_hours.maximum, 168);
  assert.equal(byName.get("get_daily_market_brief").inputSchema.properties.brief_date.type, "string");
  assert.equal(byName.get("publish_daily_market_brief").inputSchema.properties.content.properties.top_stories.maxItems, 8);
  assert.deepEqual(byName.get("publish_brief_continuation").inputSchema.properties.thesis_status.enum, ["unchanged", "updated"]);
});

test("routes Daily Market Brief calls to scoped API actions", async () => {
  const context = await callTool("get_briefing_context", { news_hours: 24 });
  const brief = await callTool("get_daily_market_brief", { brief_date: "2026-08-09" });
  const publish = await callTool("publish_daily_market_brief", {
    brief_date: "2026-08-09",
    summary: "Constructive tape with CPI risk ahead.",
    content: {
      market_mood: { label: "Constructive", tone: "caution", summary: "CPI remains the next decision point." },
      market_snapshot: [], top_stories: [], investment_implications: [], watch_next: [], bottom_line: [], sources: [],
    },
    idempotency_key: "daily-market-brief:2026-08-09",
  });

  assert.deepEqual(context.request, { action: "briefing_context", news_hours: 24 });
  assert.deepEqual(brief.request, { action: "daily_market_brief", brief_date: "2026-08-09" });
  assert.equal(publish.request.action, "publish_market_brief");
  assert.equal(publish.request.idempotency_key, "daily-market-brief:2026-08-09");
});
