import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

type AgentIdentity = {
  token_id: string;
  user_id: string;
  agent_name: string;
  scopes: string[];
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: jsonHeaders });
}

function cleanSymbol(value: unknown) {
  const symbol = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9.^-]{1,20}$/.test(symbol)) throw new Error("Invalid ticker symbol");
  return symbol;
}

function positiveNumber(value: unknown, label: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be greater than zero`);
  return number;
}

function optionalNumber(value: unknown) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("Invalid numeric value");
  return number;
}

function integer(value: unknown, fallback: number, min: number, max: number) {
  const number = Math.trunc(Number(value ?? fallback));
  return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback;
}

function requireScope(identity: AgentIdentity, scope: string) {
  if (!identity.scopes.includes(scope)) throw new Error(`Agent token is missing scope: ${scope}`);
}

function bearerToken(request: Request) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

async function must<T>(promise: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data;
}

async function ownedPortfolios(service: ReturnType<typeof createClient>, userId: string) {
  return await must(service
    .from("portfolios")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("sort_order"));
}

async function resolvePortfolio(
  service: ReturnType<typeof createClient>,
  userId: string,
  body: Record<string, unknown>,
) {
  let query = service.from("portfolios").select("*").eq("user_id", userId).eq("is_active", true);
  if (body.portfolio_id) query = query.eq("id", String(body.portfolio_id));
  else if (body.portfolio) {
    const selector = String(body.portfolio).trim();
    query = query.or(`name.ilike.${selector},kind.eq.${selector.toLowerCase().replaceAll(" ", "_")}`);
  } else {
    throw new Error("portfolio_id or portfolio is required");
  }
  const portfolio = await must(query.maybeSingle());
  if (!portfolio) throw new Error("Portfolio not found");
  return portfolio;
}

async function resolveInstrument(
  service: ReturnType<typeof createClient>,
  userId: string,
  body: Record<string, unknown>,
) {
  let query = service.from("instruments").select("*").eq("user_id", userId);
  if (body.instrument_id) query = query.eq("id", String(body.instrument_id));
  else if (body.symbol) query = query.eq("symbol", cleanSymbol(body.symbol));
  else throw new Error("instrument_id or symbol is required");
  const rows = await must(query.order("created_at", { ascending: false }).limit(10));
  if (!rows?.length) throw new Error("Instrument not found");
  if (body.asset_type) {
    const exact = rows.find((row: Record<string, unknown>) => row.asset_type === body.asset_type);
    if (exact) return exact;
  }
  const nonOption = rows.find((row: Record<string, unknown>) => row.asset_type !== "option");
  return nonOption || rows[0];
}

async function portfolioSnapshot(
  service: ReturnType<typeof createClient>,
  userId: string,
  portfolio: Record<string, unknown>,
) {
  const portfolioId = String(portfolio.id);
  const [cashRows, positions, targets, capacities, executions] = await Promise.all([
    must(service.from("portfolio_cash_balances").select("*").eq("portfolio_id", portfolioId)),
    must(service.from("position_balances").select("*").eq("portfolio_id", portfolioId)),
    must(service.from("allocation_targets").select("*").eq("portfolio_id", portfolioId).eq("is_active", true)),
    must(service.from("position_capacity").select("*").eq("portfolio_id", portfolioId)),
    must(service
      .from("executions")
      .select("id,portfolio_id,instrument_id,side,quantity,price,multiplier,fee,gross_amount,cash_effect,realized_pnl,executed_at")
      .eq("portfolio_id", portfolioId)
      .order("executed_at", { ascending: false })
      .limit(200)),
  ]);
  const instrumentIds = unique([
    ...positions.map((row: Record<string, unknown>) => String(row.instrument_id)),
    ...targets.map((row: Record<string, unknown>) => String(row.instrument_id)),
  ].filter(Boolean));
  const instruments = instrumentIds.length
    ? await must(service.from("instruments").select("*").eq("user_id", userId).in("id", instrumentIds))
    : [];
  const priceRows = instrumentIds.length
    ? await must(service
      .from("instrument_prices")
      .select("*")
      .eq("user_id", userId)
      .in("instrument_id", instrumentIds)
      .order("fetched_at", { ascending: false })
      .limit(Math.min(instrumentIds.length * 5, 2000)))
    : [];
  const seenPrices = new Set<string>();
  const latestPrices = priceRows.filter((row: Record<string, unknown>) => {
    const id = String(row.instrument_id);
    if (seenPrices.has(id)) return false;
    seenPrices.add(id);
    return true;
  });
  return {
    portfolio,
    cash: cashRows[0] || { portfolio_id: portfolioId, cash_balance: 0 },
    positions,
    targets,
    capacities,
    instruments,
    latest_prices: latestPrices,
    recent_executions: executions,
  };
}

async function overview(service: ReturnType<typeof createClient>, userId: string) {
  const portfolios = await ownedPortfolios(service, userId);
  const ids = portfolios.map((row: Record<string, unknown>) => String(row.id));
  const [cash, positions, journal, watchlist, smartMoney] = await Promise.all([
    ids.length ? must(service.from("portfolio_cash_balances").select("*").in("portfolio_id", ids)) : [],
    ids.length ? must(service.from("position_balances").select("*").in("portfolio_id", ids)) : [],
    must(service
      .from("journal_entries")
      .select("portfolio_id,manual_pnl,outcome,occurred_on")
      .eq("user_id", userId)
      .eq("is_void", false)
      .order("occurred_on", { ascending: false })
      .limit(2000)),
    must(service.from("watchlist_items").select("id").eq("user_id", userId)),
    must(service
      .from("smart_money_events")
      .select("id,side,filed_at")
      .eq("user_id", userId)
      .gte("filed_at", new Date(Date.now() - 24 * 60 * 60_000).toISOString())
      .limit(2000)),
  ]);
  const summaries = portfolios.map((portfolio: Record<string, unknown>) => {
    const portfolioId = String(portfolio.id);
    const portfolioPositions = positions.filter((row: Record<string, unknown>) => row.portfolio_id === portfolioId);
    const deployed = portfolioPositions.reduce((sum: number, row: Record<string, unknown>) =>
      sum + Number(portfolio.allocation_basis === "maximum_loss" ? row.maximum_loss : row.cost_basis || 0), 0);
    const cashBalance = Number(cash.find((row: Record<string, unknown>) => row.portfolio_id === portfolioId)?.cash_balance || 0);
    const pnl = journal
      .filter((row: Record<string, unknown>) => row.portfolio_id === portfolioId)
      .reduce((sum: number, row: Record<string, unknown>) => sum + Number(row.manual_pnl || 0), 0);
    return {
      id: portfolio.id,
      name: portfolio.name,
      kind: portfolio.kind,
      fixed_budget: Number(portfolio.fixed_budget || 0),
      cash_balance: cashBalance,
      deployed,
      total_capital: cashBalance + deployed,
      realized_pnl: pnl,
      open_positions: portfolioPositions.filter((row: Record<string, unknown>) => Number(row.quantity) > 0).length,
    };
  });
  return {
    portfolios: summaries,
    totals: {
      fixed_budget: summaries.reduce((sum: number, row: Record<string, unknown>) => sum + Number(row.fixed_budget), 0),
      cash_balance: summaries.reduce((sum: number, row: Record<string, unknown>) => sum + Number(row.cash_balance), 0),
      deployed: summaries.reduce((sum: number, row: Record<string, unknown>) => sum + Number(row.deployed), 0),
      realized_pnl: summaries.reduce((sum: number, row: Record<string, unknown>) => sum + Number(row.realized_pnl), 0),
      watchlist_count: watchlist.length,
      smart_money_24h: smartMoney.length,
    },
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return response({ error: "Method not allowed" }, 405);

  try {
    const token = bearerToken(request);
    if (!token) return response({ error: "Agent token required" }, 401);
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const service = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const authRows = await must(service.rpc("api_authenticate_agent_token", { p_token: token }));
    const identity = authRows?.[0] as AgentIdentity | undefined;
    if (!identity) return response({ error: "Invalid, expired, or revoked agent token" }, 401);
    requireScope(identity, "read");

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action || "").trim();
    if (!action) return response({ error: "action is required" }, 400);

    if (action === "overview") {
      return response({ action, data: await overview(service, identity.user_id) });
    }

    if (action === "portfolios") {
      return response({ action, data: await ownedPortfolios(service, identity.user_id) });
    }

    if (action === "portfolio_snapshot") {
      const portfolio = await resolvePortfolio(service, identity.user_id, body);
      return response({ action, data: await portfolioSnapshot(service, identity.user_id, portfolio) });
    }

    if (action === "journal") {
      const page = integer(body.page, 1, 1, 100_000);
      const pageSize = integer(body.page_size, 50, 1, 200);
      let query = service
        .from("journal_entries")
        .select("*", { count: "exact" })
        .eq("user_id", identity.user_id)
        .eq("is_void", false);
      if (body.portfolio_id) query = query.eq("portfolio_id", String(body.portfolio_id));
      if (body.from) query = query.gte("occurred_on", String(body.from));
      if (body.to) query = query.lte("occurred_on", String(body.to));
      if (body.search) {
        const search = String(body.search).replaceAll(",", " ");
        query = query.or(`strategy_label.ilike.%${search}%,notes.ilike.%${search}%`);
      }
      const { data, error, count } = await query
        .order("occurred_on", { ascending: false })
        .range((page - 1) * pageSize, page * pageSize - 1);
      if (error) throw error;
      return response({ action, data: { rows: data || [], count: count || 0, page, page_size: pageSize } });
    }

    if (action === "sell_history") {
      const portfolios = await ownedPortfolios(service, identity.user_id);
      const ids = portfolios.map((row: Record<string, unknown>) => String(row.id));
      if (!ids.length) return response({ action, data: [] });
      let query = service
        .from("executions")
        .select("id,portfolio_id,instrument_id,quantity,price,multiplier,fee,gross_amount,cash_effect,realized_pnl,executed_at")
        .in("portfolio_id", ids)
        .eq("side", "sell");
      if (body.portfolio_id) query = query.eq("portfolio_id", String(body.portfolio_id));
      const rows = await must(query.order("executed_at", { ascending: false }).limit(integer(body.limit, 200, 1, 200)));
      return response({ action, data: rows });
    }

    if (action === "watchlist") {
      const items = await must(service
        .from("watchlist_items")
        .select("*")
        .eq("user_id", identity.user_id)
        .order("created_at", { ascending: false }));
      const ids = items.map((row: Record<string, unknown>) => String(row.instrument_id));
      const instruments = ids.length
        ? await must(service.from("instruments").select("*").eq("user_id", identity.user_id).in("id", ids))
        : [];
      const market = await must(service
        .from("market_pulse_latest")
        .select("*")
        .eq("user_id", identity.user_id)
        .eq("is_watchlist", true)
        .order("symbol"));
      return response({ action, data: { items, instruments, market } });
    }

    if (action === "market_pulse") {
      let query = service.from("market_pulse_latest").select("*").eq("user_id", identity.user_id);
      if (body.section === "watchlist") query = query.eq("is_watchlist", true);
      if (body.section === "sectors") query = query.eq("is_sector", true);
      if (body.section === "benchmarks") query = query.eq("is_benchmark", true);
      const rows = await must(query.order("symbol"));
      return response({ action, data: rows });
    }

    if (action === "smart_money") {
      const days = integer(body.days, 30, 1, 365);
      const limit = integer(body.limit, 100, 1, 500);
      let query = service
        .from("smart_money_events")
        .select("*")
        .eq("user_id", identity.user_id)
        .gte("filed_at", new Date(Date.now() - days * 24 * 60 * 60_000).toISOString());
      if (["buy", "sell", "other"].includes(String(body.side))) query = query.eq("side", String(body.side));
      if (body.symbol) {
        const instrument = await resolveInstrument(service, identity.user_id, { symbol: body.symbol });
        query = query.eq("instrument_id", instrument.id);
      }
      const rows = await must(query.order("filed_at", { ascending: false }).limit(limit));
      return response({ action, data: rows });
    }

    if (action === "chart") {
      const instrument = await resolveInstrument(service, identity.user_id, body);
      if (!["stock", "etf"].includes(String(instrument.asset_type))) throw new Error("Charts support stocks and ETFs only");
      const chartResponse = await fetch(`${supabaseUrl}/functions/v1/refresh-stock-prices`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "chart",
          instrument_id: instrument.id,
          timespan: body.timespan || "D",
          count: integer(body.count, 190, 20, 600),
        }),
      });
      const payload = await chartResponse.json().catch(() => ({ error: "Chart service returned invalid JSON" }));
      return response(payload, chartResponse.status);
    }

    if (action === "create_trade_draft") {
      requireScope(identity, "drafts:write");
      const portfolio = await resolvePortfolio(service, identity.user_id, body);
      const instrument = await resolveInstrument(service, identity.user_id, body);
      const side = String(body.side || "").toLowerCase();
      if (!["buy", "sell"].includes(side)) throw new Error("side must be buy or sell");
      const draft = await must(service.rpc("api_agent_create_trade_draft", {
        p_user_id: identity.user_id,
        p_agent_id: identity.token_id,
        p_portfolio_id: portfolio.id,
        p_instrument_id: instrument.id,
        p_side: side,
        p_quantity: positiveNumber(body.quantity, "quantity"),
        p_price: positiveNumber(body.price, "price"),
        p_idempotency_key: String(body.idempotency_key || `hermes-trade-${crypto.randomUUID()}`),
        p_fee: optionalNumber(body.fee) || 0,
        p_executed_at: body.executed_at ? String(body.executed_at) : new Date().toISOString(),
        p_tranche_number: optionalNumber(body.tranche_number),
        p_underlying_price: optionalNumber(body.underlying_price),
        p_campaign_id: body.campaign_id ? String(body.campaign_id) : null,
      }));
      return response({
        action,
        data: draft,
        requires_human_confirmation: true,
        message: "Draft created. Confirm it from Account > Agent drafts in Portfolio Command Center.",
      });
    }

    if (action === "create_cash_draft") {
      requireScope(identity, "drafts:write");
      const portfolio = await resolvePortfolio(service, identity.user_id, body);
      const movement = String(body.movement_type || "").toLowerCase();
      if (!["deposit", "withdrawal", "initial_funding", "dividend", "interest", "tax"].includes(movement)) {
        throw new Error("Unsupported cash movement type");
      }
      const draft = await must(service.rpc("api_agent_create_cash_draft", {
        p_user_id: identity.user_id,
        p_agent_id: identity.token_id,
        p_portfolio_id: portfolio.id,
        p_movement_type: movement,
        p_amount: positiveNumber(body.amount, "amount"),
        p_idempotency_key: String(body.idempotency_key || `hermes-cash-${crypto.randomUUID()}`),
        p_occurred_at: body.occurred_at ? String(body.occurred_at) : new Date().toISOString(),
        p_notes: body.notes ? String(body.notes).slice(0, 2000) : null,
      }));
      return response({
        action,
        data: draft,
        requires_human_confirmation: true,
        message: "Draft created. Confirm it from Account > Agent drafts in Portfolio Command Center.",
      });
    }

    if (action === "add_watchlist") {
      requireScope(identity, "watchlist:write");
      const symbol = cleanSymbol(body.symbol);
      const assetType = String(body.asset_type || "stock").toLowerCase();
      if (!["stock", "etf"].includes(assetType)) throw new Error("asset_type must be stock or etf");
      let instrument = await must(service
        .from("instruments")
        .select("*")
        .eq("user_id", identity.user_id)
        .eq("symbol", symbol)
        .eq("asset_type", assetType)
        .maybeSingle());
      if (!instrument) {
        instrument = await must(service
          .from("instruments")
          .insert({
            user_id: identity.user_id,
            instrument_key: `${assetType}:${symbol}`,
            asset_type: assetType,
            symbol,
            display_name: String(body.display_name || symbol).trim().slice(0, 160),
            exchange: null,
            currency: "USD",
            multiplier: 1,
          })
          .select("*")
          .single());
      }
      const item = await must(service
        .from("watchlist_items")
        .upsert({
          user_id: identity.user_id,
          instrument_id: instrument.id,
          notes: body.notes ? String(body.notes).slice(0, 500) : null,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id,instrument_id" })
        .select("*")
        .single());
      return response({ action, data: { item, instrument } });
    }

    if (action === "remove_watchlist") {
      requireScope(identity, "watchlist:write");
      const instrument = await resolveInstrument(service, identity.user_id, body);
      await must(service
        .from("watchlist_items")
        .delete()
        .eq("user_id", identity.user_id)
        .eq("instrument_id", instrument.id)
        .select("id"));
      return response({ action, data: { removed: true, instrument_id: instrument.id, symbol: instrument.symbol } });
    }

    return response({ error: `Unsupported action: ${action}` }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /missing scope/i.test(message) ? 403 : /not found/i.test(message) ? 404 : 400;
    return response({ error: message }, status);
  }
});

