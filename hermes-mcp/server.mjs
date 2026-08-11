import readline from "node:readline";

const apiUrl = process.env.PCC_AGENT_API_URL
  || "https://zzynqlqnzdhkffvqvpzt.supabase.co/functions/v1/portfolio-agent-api";
const agentToken = process.env.PCC_AGENT_TOKEN || "";
const timeoutMs = Math.max(Number(process.env.PCC_REQUEST_TIMEOUT_MS || 30_000), 1_000);

const selectorProperties = {
  portfolio_id: { type: "string", description: "Exact portfolio UUID. Use this when known." },
  portfolio: { type: "string", description: "Portfolio name or kind, for example Long Term or swing_trade." },
};
const instrumentSelectorProperties = {
  instrument_id: { type: "string", description: "Exact instrument UUID. Use this when known." },
  symbol: { type: "string", description: "Ticker symbol, for example NVDA." },
};

const sourceItemSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Stable source id referenced by story source_ids." },
    title: { type: "string" },
    url: { type: "string" },
    publisher: { type: "string" },
    published_at: { type: ["string", "null"] },
  },
  required: ["id", "title", "url", "publisher"],
  additionalProperties: false,
};

const briefToneSchema = { type: "string", enum: ["positive", "neutral", "caution", "negative"] };
const briefSnapshotItemSchema = {
  type: "object",
  properties: {
    label: { type: "string", description: "Market or indicator label." },
    value: { type: ["string", "number"], description: "Latest verified value." },
    change: { type: "string", description: "Verified change or concise context; never invent unavailable data." },
    tone: briefToneSchema,
  },
  required: ["label", "value", "change", "tone"],
  additionalProperties: false,
};
const briefStorySchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "A synthesized market-wide driver, not a copied article headline or a user's tracked ticker." },
    facts: { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } },
    interpretation: { type: "array", minItems: 1, maxItems: 2, items: { type: "string" } },
    source_ids: { type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: { type: "string" } },
  },
  required: ["title", "facts", "interpretation", "source_ids"],
  additionalProperties: false,
};
const briefNoteSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short decision label such as Positive, Risk, Watch, CPI trigger or Thesis invalidation." },
    detail: { type: "string", description: "One concise, decision-useful sentence for a general market reader that does not repeat an earlier section." },
    tone: briefToneSchema,
  },
  required: ["title", "detail", "tone"],
  additionalProperties: false,
};

const dailyBriefContentSchema = {
  type: "object",
  properties: {
    market_mood: {
      type: "object",
      properties: {
        label: { type: "string" },
        tone: { type: "string", enum: ["positive", "neutral", "caution", "negative"] },
        summary: { type: "string" },
      },
      required: ["label", "tone", "summary"],
      additionalProperties: false,
    },
    market_snapshot: { type: "array", minItems: 3, maxItems: 10, items: briefSnapshotItemSchema },
    top_stories: { type: "array", minItems: 3, maxItems: 5, items: briefStorySchema },
    investment_implications: { type: "array", minItems: 3, maxItems: 5, items: briefNoteSchema },
    watch_next: { type: "array", minItems: 2, maxItems: 6, items: briefNoteSchema },
    bottom_line: { type: "array", minItems: 2, maxItems: 3, items: briefNoteSchema },
    sources: { type: "array", minItems: 1, maxItems: 20, items: sourceItemSchema },
  },
  required: ["market_mood", "market_snapshot", "top_stories", "investment_implications", "watch_next", "bottom_line", "sources"],
  additionalProperties: false,
};

const continuationContentSchema = {
  type: "object",
  properties: {
    changes: { type: "array", minItems: 1, maxItems: 6, items: briefNoteSchema },
    portfolio_impact: { type: "array", minItems: 1, maxItems: 6, items: briefNoteSchema },
    watch_next: { type: "array", minItems: 1, maxItems: 6, items: briefNoteSchema },
    sources: { type: "array", minItems: 1, maxItems: 20, items: sourceItemSchema },
  },
  required: ["changes", "portfolio_impact", "watch_next", "sources"],
  additionalProperties: false,
};

const tools = [
  {
    name: "get_overview",
    description: "Read the combined dashboard overview across all isolated portfolios, including capital, cash, deployed cost/max loss, realized P/L, Watchlist count, and recent Smart Money count.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_portfolios",
    description: "List the user's active Long Term, Swing Trade, Speculative, and Options portfolios and their fixed settings.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_portfolio_snapshot",
    description: "Read one portfolio exactly as the Portfolio page needs it: cash, positions, allocation targets, capacity, latest prices, and recent executions.",
    inputSchema: {
      type: "object",
      properties: selectorProperties,
      anyOf: [{ required: ["portfolio_id"] }, { required: ["portfolio"] }],
      additionalProperties: false,
    },
  },
  {
    name: "get_trade_journal",
    description: "Read a server-paged Trading P/L journal. This never changes cash or positions.",
    inputSchema: {
      type: "object",
      properties: {
        portfolio_id: { type: "string" },
        from: { type: "string", description: "Start date in YYYY-MM-DD format." },
        to: { type: "string", description: "End date in YYYY-MM-DD format." },
        search: { type: "string", description: "Search strategy labels or notes." },
        page: { type: "integer", minimum: 1, default: 1 },
        page_size: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_sell_history",
    description: "Read up to the latest 200 partial and full sells with server-calculated realized P/L.",
    inputSchema: {
      type: "object",
      properties: {
        portfolio_id: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_watchlist",
    description: "Read the research Watchlist, instrument metadata, logos, and latest Webull market snapshots.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_news",
    description: "Read the user's cached PCC Research News feed. Supports the same filters and ticker search as the News page and never triggers an external sync.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", enum: ["all", "unread", "portfolio", "macro", "saved"], default: "all" },
        page: { type: "integer", minimum: 1, default: 1 },
        page_size: { type: "integer", minimum: 1, maximum: 50, default: 25 },
        search: { type: "string", description: "Exact ticker symbol, for example NVDA." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_earnings_calendar",
    description: "Read the cached current-month earnings calendar for stock and ETF symbols in the user's PCC Watchlist. This never triggers an external sync.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Optional exact Watchlist ticker, for example NVDA." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_macro_calendar",
    description: "Read PCC's cached high-impact US macro calendar: FOMC, inflation, labor, growth and activity only. It never triggers an external sync. Defaults to two days back through 35 days ahead; use this for a full calendar or a grounded macro summary.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Optional YYYY-MM-DD start date; defaults to two New York calendar days ago." },
        to: { type: "string", description: "Optional YYYY-MM-DD end date; defaults to 35 New York calendar days ahead." },
        category: { type: "string", enum: ["policy", "inflation", "labor", "growth", "activity", "consumption"] },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_macro_alerts",
    description: "Read an alert-ready cached macro feed: high-impact events due soon, releases with an Actual in the recent window, next FOMC, and source freshness. This does not send notifications itself. When monitoring, de-duplicate by event id plus Actual and never invent consensus or trading advice.",
    inputSchema: {
      type: "object",
      properties: {
        hours_ahead: { type: "integer", minimum: 1, maximum: 168, default: 24 },
        hours_back: { type: "integer", minimum: 1, maximum: 168, default: 12 },
        category: { type: "string", enum: ["policy", "inflation", "labor", "growth", "activity", "consumption"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "refresh_brief_sources",
    description: "Refresh the shared public reporting cache before a canonical Daily Market Brief or Continuation. This reuses the same budgeted collector as PCC News, never reads or changes a private portfolio, and safely returns cached-fallback guidance if a source is unavailable.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_briefing_context",
    description: "Read a grounded PCC fact pack for a market brief. shared_market is the canonical, privacy-safe mode: benchmarks, sectors, cached external market reporting, FRED risk/sentiment and high-impact Macro. Cached reporting is a fallback evidence pool when live pages block access; synthesize broad market drivers rather than copying headlines. personal adds the owner's dashboard, positions, watchlist, News and Earnings for a separate private analysis. Call refresh_brief_sources separately when a fresh canonical edition is being prepared.",
    inputSchema: {
      type: "object",
      properties: {
        news_hours: { type: "integer", minimum: 6, maximum: 168, default: 30 },
        audience: { type: "string", enum: ["shared_market", "personal"], default: "shared_market" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_macro_risk_monitor",
    description: "Read the compact shared FRED risk monitor and PCC Fear & Greed snapshot, including component values, source URLs and recent daily history. Use this alongside get_briefing_context so risk facts cannot be lost in a large briefing payload.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_daily_market_brief",
    description: "Read the latest canonical Daily Market Brief and its Continuations. Pass brief_date when comparing a midnight update with the preceding 20:00 Bangkok edition.",
    inputSchema: {
      type: "object",
      properties: {
        brief_date: { type: "string", description: "Optional canonical brief date in YYYY-MM-DD." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "publish_daily_market_brief",
    description: "Publish the one canonical Daily Market Brief for a Bangkok calendar date to Supabase and create its PCC notification. Use verified facts only, cite source ids, and call at most once per edition; a retry with the same idempotency key is safe.",
    inputSchema: {
      type: "object",
      properties: {
        brief_date: { type: "string", description: "Bangkok calendar date in YYYY-MM-DD." },
        summary: { type: "string", maxLength: 1200, description: "Short notification preview and archive summary." },
        content: dailyBriefContentSchema,
        source_context: { type: "object", description: "Optional generation metadata such as context generated_at and source freshness." },
        idempotency_key: { type: "string", minLength: 8, maxLength: 160, description: "Use daily-market-brief:YYYY-MM-DD." },
      },
      required: ["brief_date", "summary", "content", "idempotency_key"],
      additionalProperties: false,
    },
  },
  {
    name: "publish_brief_continuation",
    description: "Append a material midnight change to an existing Daily Market Brief. Never rewrite the full brief. Do not call when the thesis and market facts have not changed meaningfully.",
    inputSchema: {
      type: "object",
      properties: {
        brief_date: { type: "string", description: "Date of the preceding 20:00 Bangkok canonical brief in YYYY-MM-DD." },
        material_change: { type: "boolean", const: true },
        thesis_status: { type: "string", enum: ["unchanged", "updated"] },
        material_score: { type: "number", minimum: 0, maximum: 100 },
        summary: { type: "string", maxLength: 1200 },
        content: continuationContentSchema,
        source_context: { type: "object" },
        idempotency_key: { type: "string", minLength: 8, maxLength: 160, description: "Use daily-market-brief:YYYY-MM-DD:continuation:HHmm." },
      },
      required: ["brief_date", "material_change", "thesis_status", "summary", "content", "idempotency_key"],
      additionalProperties: false,
    },
  },
  {
    name: "get_market_pulse",
    description: "Read cached Webull Market Pulse rows for watched names, benchmarks, or sector/theme ETFs.",
    inputSchema: {
      type: "object",
      properties: {
        section: { type: "string", enum: ["all", "watchlist", "benchmarks", "sectors"], default: "all" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_smart_money",
    description: "Read SEC Form 4 ownership events for Watchlist names. Codes and raw filing facts remain visible; do not interpret every event as an open-market trade.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        side: { type: "string", enum: ["buy", "sell", "other"] },
        days: { type: "integer", minimum: 1, maximum: 365, default: 30 },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_chart_bars",
    description: "Read Webull OHLCV bars for a watched or owned stock/ETF. Supports 1-hour, 4-hour, and daily candles; options are intentionally excluded.",
    inputSchema: {
      type: "object",
      properties: {
        ...instrumentSelectorProperties,
        timespan: { type: "string", enum: ["M60", "M240", "D"], default: "D" },
        count: { type: "integer", minimum: 20, maximum: 600, default: 190 },
      },
      anyOf: [{ required: ["instrument_id"] }, { required: ["symbol"] }],
      additionalProperties: false,
    },
  },
  {
    name: "resolve_rule_a_campaign",
    description: "Deterministically resolve the one allowed open campaign for a Webull Swing Trade or Options fill. A buy starts tranche 1 when none is open, otherwise returns the existing campaign's next tranche. A sell requires that one open campaign. It never guesses across multiple campaigns.",
    inputSchema: {
      type: "object",
      properties: {
        ...selectorProperties,
        ...instrumentSelectorProperties,
        side: { type: "string", enum: ["buy", "sell"] },
        executed_at: { type: "string", description: "Broker fill ISO-8601 timestamp." },
      },
      required: ["side"],
      allOf: [
        { anyOf: [{ required: ["portfolio_id"] }, { required: ["portfolio"] }] },
        { anyOf: [{ required: ["instrument_id"] }, { required: ["symbol"] }] },
      ],
      additionalProperties: false,
    },
  },
  {
    name: "get_confirmed_execution_sync",
    description: "Read confirmed PCC executions for deterministic Tsuki Google Sheet synchronization. Pending, expired, and rejected drafts are excluded.",
    inputSchema: {
      type: "object",
      properties: {
        ...selectorProperties,
        since: { type: "string", description: "Optional ISO-8601 lower bound for executed_at." },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "preview_average_cost",
    description: "Pure calculator for a proposed stock/ETF buy. It does not read or write the database. Fees are added to weighted-average cost.",
    inputSchema: {
      type: "object",
      properties: {
        current_quantity: { type: "number", minimum: 0 },
        current_cost_basis: { type: "number", minimum: 0 },
        buy_quantity: { type: "number", exclusiveMinimum: 0 },
        price: { type: "number", exclusiveMinimum: 0 },
        fee: { type: "number", minimum: 0, default: 0 },
      },
      required: ["current_quantity", "current_cost_basis", "buy_quantity", "price"],
      additionalProperties: false,
    },
  },
  {
    name: "create_trade_draft",
    description: "Create a BUY or SELL draft after a broker fill. This tool cannot confirm, post, or place an order. A human must confirm the draft in Portfolio Command Center before it changes cash or holdings.",
    inputSchema: {
      type: "object",
      properties: {
        ...selectorProperties,
        ...instrumentSelectorProperties,
        side: { type: "string", enum: ["buy", "sell"] },
        quantity: { type: "number", exclusiveMinimum: 0 },
        price: { type: "number", exclusiveMinimum: 0 },
        fee: { type: "number", minimum: 0, default: 0 },
        executed_at: { type: "string", description: "ISO-8601 timestamp. Defaults to now." },
        tranche_number: { type: "integer", minimum: 1, maximum: 20 },
        underlying_price: { type: "number", minimum: 0, description: "Optional underlying price for options exposure." },
        campaign_id: { type: "string", description: "Rule-A PCC campaign UUID resolved before creating the draft." },
        idempotency_key: { type: "string", description: "Stable unique key that prevents duplicate drafts." },
      },
      required: ["side", "quantity", "price"],
      allOf: [
        { anyOf: [{ required: ["portfolio_id"] }, { required: ["portfolio"] }] },
        { anyOf: [{ required: ["instrument_id"] }, { required: ["symbol"] }] }
      ],
      additionalProperties: false,
    },
  },
  {
    name: "create_cash_movement_draft",
    description: "Create a deposit, withdrawal, initial funding, dividend, interest, or tax draft. This tool cannot confirm it; a human must confirm in the dashboard.",
    inputSchema: {
      type: "object",
      properties: {
        ...selectorProperties,
        movement_type: { type: "string", enum: ["deposit", "withdrawal", "initial_funding", "dividend", "interest", "tax"] },
        amount: { type: "number", exclusiveMinimum: 0 },
        occurred_at: { type: "string", description: "ISO-8601 timestamp. Defaults to now." },
        notes: { type: "string", maxLength: 2000 },
        idempotency_key: { type: "string", description: "Stable unique key that prevents duplicate drafts." },
      },
      required: ["movement_type", "amount"],
      anyOf: [{ required: ["portfolio_id"] }, { required: ["portfolio"] }],
      additionalProperties: false,
    },
  },
  {
    name: "add_watchlist_ticker",
    description: "Add or update a stock/ETF in the separate research Watchlist. This does not create a portfolio position or allocation target.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        display_name: { type: "string", maxLength: 160 },
        asset_type: { type: "string", enum: ["stock", "etf"], default: "stock" },
        notes: { type: "string", maxLength: 500 },
      },
      required: ["symbol"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_watchlist_ticker",
    description: "Remove a stock/ETF from the research Watchlist only. Portfolio positions and history are untouched.",
    inputSchema: {
      type: "object",
      properties: instrumentSelectorProperties,
      anyOf: [{ required: ["instrument_id"] }, { required: ["symbol"] }],
      additionalProperties: false,
    },
  },
];

const actionByTool = {
  get_overview: "overview",
  list_portfolios: "portfolios",
  get_portfolio_snapshot: "portfolio_snapshot",
  get_trade_journal: "journal",
  get_sell_history: "sell_history",
  get_watchlist: "watchlist",
  get_news: "news",
  get_earnings_calendar: "earnings",
  get_macro_calendar: "macro_calendar",
  get_macro_alerts: "macro_alerts",
  refresh_brief_sources: "refresh_brief_sources",
  get_briefing_context: "briefing_context",
  get_macro_risk_monitor: "macro_risk_monitor",
  get_daily_market_brief: "daily_market_brief",
  publish_daily_market_brief: "publish_market_brief",
  publish_brief_continuation: "publish_brief_continuation",
  get_market_pulse: "market_pulse",
  get_smart_money: "smart_money",
  get_chart_bars: "chart",
  resolve_rule_a_campaign: "resolve_rule_a_campaign",
  get_confirmed_execution_sync: "confirmed_execution_sync",
  create_trade_draft: "create_trade_draft",
  create_cash_movement_draft: "create_cash_draft",
  add_watchlist_ticker: "add_watchlist",
  remove_watchlist_ticker: "remove_watchlist",
};

async function callApi(action, args) {
  if (!agentToken) throw new Error("PCC_AGENT_TOKEN is not configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const apiResponse = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${agentToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action, ...args }),
      signal: controller.signal,
    });
    const payload = await apiResponse.json().catch(() => ({ error: "Agent API returned invalid JSON" }));
    if (!apiResponse.ok) throw new Error(payload?.error || `Agent API failed with HTTP ${apiResponse.status}`);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function averageCost(args) {
  const currentQuantity = Number(args.current_quantity);
  const currentCost = Number(args.current_cost_basis);
  const buyQuantity = Number(args.buy_quantity);
  const price = Number(args.price);
  const fee = Number(args.fee || 0);
  if (![currentQuantity, currentCost, buyQuantity, price, fee].every(Number.isFinite)) {
    throw new Error("All calculator inputs must be finite numbers");
  }
  if (currentQuantity < 0 || currentCost < 0 || buyQuantity <= 0 || price <= 0 || fee < 0) {
    throw new Error("Calculator inputs must be non-negative; buy quantity and price must be greater than zero");
  }
  const addedCost = buyQuantity * price + fee;
  const quantityAfter = currentQuantity + buyQuantity;
  const costAfter = currentCost + addedCost;
  return {
    added_cost: addedCost,
    quantity_after: quantityAfter,
    cost_basis_after: costAfter,
    weighted_average_after: quantityAfter ? costAfter / quantityAfter : 0,
  };
}

function resultContent(value) {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

async function executeTool(name, args = {}) {
  if (name === "preview_average_cost") return averageCost(args);
  const action = actionByTool[name];
  if (!action) throw new Error(`Unknown tool: ${name}`);
  return await callApi(action, args);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === "notifications/initialized") return;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "portfolio-command-center", version: "1.0.0" },
      },
    });
    return;
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }
  if (method === "tools/call") {
    try {
      const value = await executeTool(params?.name, params?.arguments || {});
      send({ jsonrpc: "2.0", id, result: { content: resultContent(value), isError: false } });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });
    }
    return;
  }
  if (method === "resources/list" || method === "prompts/list") {
    send({ jsonrpc: "2.0", id, result: method === "resources/list" ? { resources: [] } : { prompts: [] } });
    return;
  }
  if (id != null) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    await handle(JSON.parse(line));
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: text } });
  }
});
