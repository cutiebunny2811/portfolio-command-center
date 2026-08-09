(() => {
  "use strict";

  const config = window.__APP_CONFIG__;
  const supabaseLib = window.supabase;
  const portfolioMath = window.PCCPortfolioMath;
  if (!config?.supabaseUrl || !config?.supabasePublishableKey || !supabaseLib?.createClient || !portfolioMath?.portfolioValuation) {
    document.body.innerHTML = '<main style="padding:40px;color:#fff;font-family:sans-serif">Dashboard configuration could not be loaded.</main>';
    return;
  }

  // Keep global listeners, timers and the Supabase client single-instance if
  // a future embed or cache recovery path evaluates this static bundle twice.
  if (window.__PCC_APP_STARTED__) return;
  window.__PCC_APP_STARTED__ = true;

  const db = supabaseLib.createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[char]);
  const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const money = (value, digits = 2) => new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits
  }).format(num(value));
  const compactMoney = (value) => new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1
  }).format(num(value));
  const percent = (value, digits = 1) => `${num(value).toFixed(digits)}%`;
  const today = () => new Date().toISOString().slice(0, 10);
  const localDateTime = (value = Date.now()) => {
    const source = new Date(value);
    const d = new Date(source.getTime() - source.getTimezoneOffset() * 60_000);
    return d.toISOString().slice(0, 16);
  };
  const uid = (prefix) => `${prefix}-${crypto.randomUUID()}`;
  const portfolioLabels = {
    long_term: "Long Term",
    swing_trade: "Swing Trade",
    speculative: "Speculative",
    options: "Options"
  };
  const localPreviewParams = new URLSearchParams(location.search);
  const initialRoute = ["overview", "portfolio", "journal", "watchlist", "smart-money", "research", "earnings", "macro", "briefs"].includes(localPreviewParams.get("route"))
    ? localPreviewParams.get("route") : "overview";
  const localPreviewEnabled = (["127.0.0.1", "localhost"].includes(location.hostname) || location.protocol === "file:")
    && localPreviewParams.get("preview") === "1";
  const localStressEnabled = localPreviewEnabled && localPreviewParams.get("stress") === "1";

  const state = {
    user: null,
    portfolios: [], cash: [], positions: [], instruments: [], targets: [], capacities: [], executions: [],
    journal: [], journalPreviewSource: [], journalOverview: null, journalSummary: null,
    journalDaily: [], journalMonthly: [], journalTotal: 0, journalPage: 1, journalPageSize: 50,
    journalFilter: "all", journalOutcome: "all", journalSearch: "", journalDateFrom: "", journalDateTo: "",
    journalBusy: false, prices: [], priceRefreshBusy: false, lastWebullRefresh: null,
    watchlist: [], watchlistReady: true, watchlistBars: [], watchlistLivePrice: null, watchlistChartBusy: false,
    selectedWatchlistInstrumentId: null, watchlistTimeframe: "1D", watchlistRange: "6M", watchlistSearch: "", watchlistRecentIds: [],
    watchlistView: "charts", marketPulse: [], marketPulseReady: true, marketPulseBusy: false, marketPulseWindow: "1D",
    smartMoneyEvents: [], smartMoneyReady: true, smartMoneySearch: "", smartMoneySide: "all", smartMoneyWindow: 30,
    researchEntries: [], researchPreviewSource: [], researchReady: true, researchBusy: false, researchSyncBusy: false,
    researchTotal: 0, researchPage: 1, researchPageSize: 25, researchFilter: "all", researchSearch: "",
    earningsEntries: [], earningsReady: true, earningsBusy: false, earningsSyncBusy: false,
    earningsWeekIndex: 0, earningsTrackedCount: 0, earningsLastSynced: null,
    macroEntries: [], macroNextEvent: null, macroNextFomc: null, macroReady: true,
    macroBusy: false, macroSyncBusy: false, macroLastSynced: null,
    briefs: [], notifications: [], briefReady: true, briefBusy: false,
    selectedBriefId: null, notificationsOpen: false, mobileMoreOpen: false,
    agentTokens: [], agentDrafts: [],
    route: initialRoute, selectedPortfolioId: null,
    holdingsQuery: "", holdingsPage: 1, holdingsPageSize: 25, tradeHistoryPage: 1, tradeHistoryPageSize: 6, tradeHistoryQuery: "",
    loading: false, lastSync: null
  };

  const authShell = $("#auth-shell");
  const appShell = $("#app-shell");
  const viewRoot = $("#view-root");
  const loading = $("#loading");
  const dialog = $("#dialog");
  const dialogForm = $("#dialog-form");
  let dialogSubmit = null;
  let toastTimer = null;
  let researchSearchTimer = null;
  let watchlistChart = null;
  let watchlistBarsRequestId = 0;
  let watchlistChartRenderId = 0;

  function destroyWatchlistChart() {
    if (!watchlistChart) return;
    watchlistChart.remove();
    watchlistChart = null;
  }

  function invalidateWatchlistBarsRequest() {
    watchlistBarsRequestId += 1;
    state.watchlistChartBusy = false;
  }

  function invalidateWatchlistChartRender() {
    watchlistChartRenderId += 1;
    destroyWatchlistChart();
  }

  function toast(message, isError = false) {
    const node = $("#toast");
    node.textContent = message;
    node.classList.toggle("is-error", isError);
    node.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("is-visible"), 3200);
  }

  function refreshIcons() {
    window.lucide?.createIcons?.({ attrs: { "stroke-width": 1.8 } });
  }

  function setLoading(value, text = "Reading portfolio ledger…") {
    state.loading = value;
    loading.hidden = !value;
    const label = $("p", loading);
    if (label) label.textContent = text;
  }

  function setSync(ok, label) {
    const node = $("#sync-status");
    node.classList.toggle("is-error", !ok);
    node.lastChild.textContent = ` ${label}`;
  }

  function friendlyError(error) {
    const message = error?.message || String(error || "Unknown error");
    if (/api_get_journal_view/i.test(message)) {
      return "Scalable Journal API is not installed yet. Run 007_journal_scaling.sql in Supabase first.";
    }
    if (/api_create_journal_entry|schema cache|function .* does not exist/i.test(message)) {
      return "Journal API is not installed yet. Run 005_journal_api.sql in Supabase first.";
    }
    if (/api_remove_asset_from_portfolio/i.test(message)) {
      return "Remove Asset API is not installed yet. Run 010_remove_asset_api.sql in Supabase first.";
    }
    if (/refresh-stock-prices.*not found|Failed to send a request to the Edge Function|FunctionsFetchError|404/i.test(message)) {
      return "Webull price refresh is not deployed yet. Deploy the refresh-stock-prices Supabase Edge Function and add its Webull secrets.";
    }
    if (/watchlist_items|api_add_watchlist_item|api_remove_watchlist_item/i.test(message)) {
      return "Watchlist is not installed yet. Run 011_watchlist.sql in Supabase first.";
    }
    if (/market_pulse_latest/i.test(message)) {
      return "Market Pulse is not installed yet. Run 015_market_pulse.sql in Supabase first.";
    }
    if (/api_create_portfolio|api_rename_portfolio|api_archive_portfolio/i.test(message)) {
      return "Dynamic portfolio management is not installed yet. Run 031_dynamic_portfolios.sql in Supabase first.";
    }
    if (/portfolios_active_name_per_user_idx|duplicate key.*portfolio/i.test(message)) {
      return "An active portfolio with this name already exists.";
    }
    if (/api_get_research_feed|research_articles|research_article_/i.test(message)) {
      return "News is not installed yet. Run 021_research_news.sql in Supabase first.";
    }
    if (/api_get_earnings_calendar|earnings_events|earnings_sync_state/i.test(message)) {
      return "Earnings Calendar is not installed yet. Run 032_earnings_calendar.sql in Supabase first.";
    }
    if (/api_get_macro_calendar|macro_events|macro_sync_state/i.test(message)) {
      return "Macro Calendar is not installed yet. Run 035_us_macro_calendar.sql in Supabase first.";
    }
    if (/api_get_market_brief_feed|market_briefs|market_brief_updates|pcc_notifications/i.test(message)) {
      return "Daily Market Brief is not installed yet. Run 036_daily_market_briefs.sql in Supabase first.";
    }
    return message.replace(/^JSON object requested, multiple \(or no\) rows returned$/, "Expected portfolio data was not found.");
  }

  function currentPortfolio() {
    return state.portfolios.find((p) => p.id === state.selectedPortfolioId) || state.portfolios[0] || null;
  }

  function portfolioMode(portfolio) {
    return portfolio?.portfolio_mode === "mixed" ? "mixed" : "legacy";
  }

  function brokerProfile(portfolio) {
    return String(portfolio?.broker_profile || "webull").toLowerCase() === "dime" ? "dime" : "webull";
  }

  function isOptionInstrument(instrumentId) {
    return String(instrumentMap().get(instrumentId)?.asset_type || "").toLowerCase() === "option";
  }

  function instrumentMap() {
    return new Map(state.instruments.map((item) => [item.id, item]));
  }

  function assetMark(instrument, size = "") {
    const symbol = String(instrument?.symbol || "?").trim().toUpperCase();
    const initials = symbol.replace(/[^A-Z0-9]/g, "").slice(0, 2) || "?";
    const logoUrl = String(instrument?.logo_url || "").trim();
    return `<span class="asset-mark ${size ? `asset-mark--${esc(size)}` : ""}${logoUrl ? "" : " is-fallback"}" aria-hidden="true">
      ${logoUrl ? `<img src="${esc(logoUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ""}
      <span>${esc(initials)}</span>
    </span>`;
  }

  function assetIdentity(instrument) {
    return `<span class="asset-identity">${assetMark(instrument)}<span class="asset-identity__copy"><strong>${esc(instrument?.symbol || "—")}</strong><small>${esc(instrument?.display_name || instrument?.asset_type || "")}</small></span></span>`;
  }

  function latestPriceMap() {
    const map = new Map();
    state.prices.forEach((price) => {
      if (!map.has(price.instrument_id)) map.set(price.instrument_id, price);
    });
    return map;
  }

  function latestWebullPriceTime() {
    const times = state.prices
      .filter((item) => item.source === "webull")
      .map((item) => new Date(item.market_time || item.fetched_at).getTime())
      .filter(Number.isFinite);
    return times.length ? new Date(Math.max(...times)) : null;
  }

  function priceFreshnessLabel() {
    const latest = latestWebullPriceTime();
    if (!latest) return "Webull prices not synced yet";
    const minutes = Math.max(Math.floor((Date.now() - latest.getTime()) / 60_000), 0);
    if (minutes < 1) return "Webull prices updated just now";
    if (minutes === 1) return "Webull prices updated 1 minute ago";
    return `Webull prices updated ${minutes} minutes ago`;
  }

  function portfolioStats(portfolio) {
    const positions = state.positions.filter((item) => item.portfolio_id === portfolio.id && num(item.quantity) > 0);
    const cash = num(state.cash.find((item) => item.portfolio_id === portfolio.id)?.cash_balance);
    const budget = num(portfolio.fixed_budget);
    const prices = latestPriceMap();
    const instruments = instrumentMap();
    const valuation = portfolioMath.portfolioValuation({
      portfolio,
      positions,
      instrumentsById: instruments,
      pricesById: prices,
      cash
    });
    return {
      ...valuation,
      positions,
      budget,
      // Book/accounting aliases stay stable for cash and P/L screens.
      deployed: valuation.costBasis,
      capital: valuation.bookCapital,
      remaining: Math.max(cash, 0)
    };
  }

  function combinedStats() {
    const stats = state.portfolios.map(portfolioStats);
    return {
      budget: stats.reduce((sum, item) => sum + item.budget, 0),
      capital: stats.reduce((sum, item) => sum + item.capital, 0),
      cash: stats.reduce((sum, item) => sum + item.cash, 0),
      deployed: stats.reduce((sum, item) => sum + item.deployed, 0),
      pnl: num(state.journalOverview?.summary?.net_pnl)
    };
  }

  function isCashInstrument(instrument) {
    return String(instrument?.symbol || "").trim().toUpperCase() === "CASH";
  }

  function allocationSummary(portfolio, rows = portfolioRows(portfolio)) {
    const planned = rows.reduce((sum, row) => sum + num(row.targetPercent), 0);
    return {
      planned,
      unallocated: Math.max(100 - planned, 0),
      isComplete: Math.abs(planned - 100) < .01,
      isOver: planned > 100.001
    };
  }

  function allocationTone(progress) {
    if (progress >= 80) return "risk";
    if (progress >= 40) return "warn";
    return "good";
  }

  function formatTradeQuantity(value) {
    return num(value).toLocaleString("en-US", { maximumFractionDigits: 4 });
  }

  function trimRecommendation(row, market) {
    const quantity = num(row.position?.quantity);
    const excess = Math.max(row.deployed - row.quota, 0);
    if (excess <= .005 || quantity <= 0 || row.deployed <= 0) return null;
    const basisPerUnit = row.deployed / quantity;
    if (basisPerUnit <= 0) return null;
    const precision = row.instrument.asset_type === "option" ? 0 : 4;
    const factor = 10 ** precision;
    const trimQuantity = Math.min(quantity, Math.ceil(excess / basisPerUnit * factor) / factor);
    const marketPrice = num(market?.price);
    const multiplier = num(row.instrument.multiplier || 1);
    return {
      excess,
      quantity: trimQuantity,
      estimatedProceeds: marketPrice > 0 ? trimQuantity * marketPrice * multiplier : null,
      unit: row.instrument.asset_type === "option" ? "contract(s)" : "share(s)"
    };
  }

  function instrumentPriceFreshness(market) {
    if (!market) return "Manual price";
    const timestamp = new Date(market.market_time || market.fetched_at).getTime();
    if (!Number.isFinite(timestamp)) return esc(market.source || "Manual price");
    const minutes = Math.max(Math.floor((Date.now() - timestamp) / 60_000), 0);
    if (minutes < 1) return `${esc(market.source || "Market")} · just now`;
    if (minutes === 1) return `${esc(market.source || "Market")} · 1 min ago`;
    return `${esc(market.source || "Market")} · ${minutes} min ago`;
  }

  function buyProjection(portfolio, row, amount, price, fee = 0) {
    const stats = portfolioStats(portfolio);
    const currentQuantity = num(row.position?.quantity);
    const currentCost = num(row.costBasis);
    const currentAllocationValue = num(row.deployed);
    const purchaseAmount = Math.max(num(amount), 0);
    const purchasePrice = Math.max(num(price), 0);
    const purchaseFee = Math.max(num(fee), 0);
    const addedShares = purchasePrice > 0 ? purchaseAmount / purchasePrice : 0;
    const quantityAfter = currentQuantity + addedShares;
    // Match Supabase's confirmed weighted-average formula exactly:
    // fees become part of cost basis while cash falls by gross + fee.
    const costAfter = currentCost + purchaseAmount + purchaseFee;
    const averageAfter = quantityAfter > 0 ? costAfter / quantityAfter : 0;
    const cashAfter = stats.cash - purchaseAmount - purchaseFee;
    const allocationValueAfter = currentAllocationValue + purchaseAmount;
    const allocationCapitalAfter = Math.max(stats.allocationCapital - purchaseFee, 0);
    const quotaAfter = allocationCapitalAfter * row.targetPercent / 100;
    const allocationAfter = allocationCapitalAfter > 0 ? allocationValueAfter / allocationCapitalAfter * 100 : 0;
    const targetProgress = row.targetPercent > 0 ? allocationAfter / row.targetPercent * 100 : 0;
    const overage = Math.max(allocationValueAfter - quotaAfter, 0);
    const roomAfter = Math.max(Math.min(quotaAfter - allocationValueAfter, cashAfter), 0);
    return {
      amount: purchaseAmount,
      price: purchasePrice,
      fee: purchaseFee,
      addedShares,
      quantityAfter,
      costAfter,
      averageAfter,
      cashAfter,
      allocationValueAfter,
      allocationCapitalAfter,
      allocationAfter,
      targetProgress,
      overage,
      roomAfter,
      tone: allocationTone(targetProgress),
      isOver: row.targetPercent > 0 && allocationAfter > row.targetPercent + .001,
      hasCash: cashAfter >= -.005,
      isValid: purchaseAmount > 0 && purchasePrice > 0
    };
  }

  function buyProjectionSummary(projection, row) {
    if (!projection?.isValid) {
      return `<div class="trade-projection__empty">Enter quantity and price to preview the position after this buy.</div>`;
    }
    const warning = !projection.hasCash
      ? `<div class="trade-projection__warning is-cash">Cash short by ${money(Math.abs(projection.cashAfter))}. Reduce the quantity or add money first.</div>`
      : projection.isOver
        ? `<div class="trade-projection__warning">Tactical overweight · ${money(projection.overage)} above the ${percent(row.targetPercent)} target. The buy is allowed; trim guidance will appear after confirmation.</div>`
        : `<div class="trade-projection__status is-${projection.tone}">${money(projection.roomAfter)} remains before the ${percent(row.targetPercent)} target.</div>`;
    return `<div class="trade-projection__grid">
      <div><small>New average</small><strong>${money(projection.averageAfter, 4)}</strong></div>
      <div><small>Shares after</small><strong>${formatTradeQuantity(projection.quantityAfter)}</strong></div>
      <div><small>Allocation after</small><strong>${percent(projection.allocationAfter, 2)}</strong></div>
      <div><small>Cash after</small><strong class="${projection.hasCash ? "gold" : "negative"}">${money(projection.cashAfter)}</strong></div>
    </div>${warning}`;
  }

  function portfolioRows(portfolio) {
    const instruments = instrumentMap();
    const prices = latestPriceMap();
    const positions = new Map(
      state.positions.filter((item) => item.portfolio_id === portfolio.id && num(item.quantity) > 0).map((item) => [item.instrument_id, item])
    );
    const targets = new Map(
      state.targets.filter((item) => item.portfolio_id === portfolio.id && item.is_active).map((item) => [item.instrument_id, item])
    );
    const capacities = new Map(
      state.capacities.filter((item) => item.portfolio_id === portfolio.id).map((item) => [item.instrument_id, item])
    );
    const ids = new Set([...positions.keys(), ...targets.keys()]);
    return [...ids].map((id) => {
      const position = positions.get(id) || null;
      const target = targets.get(id) || null;
      const capacity = capacities.get(id) || null;
      const instrument = instruments.get(id) || { id, symbol: "—", display_name: "Unknown instrument", multiplier: 1 };
      if (isCashInstrument(instrument)) return null;
      const price = prices.get(id);
      const costBasis = portfolioMath.positionCostBasis(position, portfolio);
      const deployed = portfolioMath.positionAllocationValue(position, instrument, price, portfolio);
      const stats = portfolioStats(portfolio);
      const currentPercent = stats.allocationCapital > 0 ? deployed / stats.allocationCapital * 100 : 0;
      const targetPercent = num(target?.target_percent);
      const quota = stats.allocationCapital * targetPercent / 100;
      const remaining = Math.max(Math.min(quota - deployed, stats.cash), 0);
      const overage = Math.max(deployed - quota, 0);
      const targetProgress = targetPercent > 0 ? currentPercent / targetPercent * 100 : deployed > 0 ? 100 : 0;
      let status = "Unplanned", statusClass = "warn";
      if (target) {
        if (targetPercent > 0 && currentPercent > targetPercent + .001) { status = "Over target"; statusClass = "risk"; }
        else if (targetProgress >= 80) { status = "Near target"; statusClass = "risk"; }
        else if (targetProgress >= 40) { status = "Building"; statusClass = "warn"; }
        else if (targetPercent > 0) { status = "Room to add"; statusClass = "good"; }
        else { status = "On target"; statusClass = "good"; }
      }
      return { id, instrument, position, target, capacity, price, costBasis, deployed, currentPercent, targetPercent, quota, remaining, overage, targetProgress, status, statusClass };
    }).filter(Boolean).sort((a, b) => b.deployed - a.deployed || a.instrument.symbol.localeCompare(b.instrument.symbol));
  }

  async function query(label, promise) {
    const { data, error } = await promise;
    if (error) throw new Error(`${label}: ${error.message}`);
    return data || [];
  }

  async function optionalWatchlistQuery() {
    if (localPreviewEnabled) return state.watchlist;
    const { data, error } = await db.from("watchlist_items").select("*").order("created_at");
    if (!error) {
      state.watchlistReady = true;
      return data || [];
    }
    if (/watchlist_items|schema cache|does not exist/i.test(error.message)) {
      state.watchlistReady = false;
      return [];
    }
    throw new Error(`Watchlist: ${error.message}`);
  }

  async function optionalMarketPulseQuery() {
    if (localPreviewEnabled) return state.marketPulse;
    const { data, error } = await db.from("market_pulse_latest").select("*").order("symbol");
    if (!error) {
      state.marketPulseReady = true;
      return data || [];
    }
    if (/market_pulse_latest|schema cache|does not exist/i.test(error.message)) {
      state.marketPulseReady = false;
      return [];
    }
    throw new Error(`Market Pulse: ${error.message}`);
  }

  async function optionalSmartMoneyQuery() {
    if (localPreviewEnabled) return state.smartMoneyEvents;
    const { data, error } = await db.from("smart_money_events").select("*").order("filed_at", { ascending: false }).limit(500);
    if (!error) {
      state.smartMoneyReady = true;
      return data || [];
    }
    if (/smart_money_events|schema cache|does not exist/i.test(error.message)) {
      state.smartMoneyReady = false;
      return [];
    }
    throw new Error(`Smart Money: ${error.message}`);
  }

  function emptyBriefFeed() {
    return { briefs: [], notifications: [] };
  }

  async function fetchBriefFeed() {
    if (localPreviewEnabled) return { briefs: state.briefs, notifications: state.notifications };
    const { data, error } = await db.rpc("api_get_market_brief_feed", { p_limit: 30 });
    if (!error) {
      state.briefReady = true;
      return {
        briefs: Array.isArray(data?.briefs) ? data.briefs : [],
        notifications: Array.isArray(data?.notifications) ? data.notifications : []
      };
    }
    if (/api_get_market_brief_feed|market_briefs|schema cache|does not exist/i.test(error.message)) {
      state.briefReady = false;
      return emptyBriefFeed();
    }
    throw new Error(`Daily Market Brief: ${error.message}`);
  }

  function applyBriefFeed(feed) {
    state.briefs = Array.isArray(feed?.briefs) ? feed.briefs : [];
    state.notifications = Array.isArray(feed?.notifications) ? feed.notifications : [];
    if (!state.briefs.some((brief) => brief.id === state.selectedBriefId)) {
      state.selectedBriefId = state.briefs[0]?.id || null;
    }
  }

  async function loadBriefPage({ renderAfter = true } = {}) {
    state.briefBusy = true;
    if (renderAfter && state.route === "briefs") renderBriefs();
    try {
      applyBriefFeed(await fetchBriefFeed());
    } catch (error) {
      console.error(error);
      toast(friendlyError(error), true);
    } finally {
      state.briefBusy = false;
      renderNotificationCenter();
      if (renderAfter && state.route === "briefs") renderBriefs();
    }
  }

  function emptyResearchFeed() {
    return { entries: [], total_count: 0, page: 1, page_size: state.researchPageSize, filter: state.researchFilter };
  }

  function previewResearchFeed() {
    const term = state.researchSearch.trim().toUpperCase();
    const filtered = state.researchPreviewSource.filter((article) => {
      if (article.is_hidden) return false;
      if (state.researchFilter === "unread" && article.is_read) return false;
      if (state.researchFilter === "portfolio" && !article.is_portfolio) return false;
      if (state.researchFilter === "macro" && (!(article.keywords || []).includes("MARKET_MACRO") || (article.keywords || []).includes("TICKER_EVENT"))) return false;
      if (state.researchFilter === "saved" && !article.is_saved) return false;
      return !term || (article.tickers || []).some((ticker) => String(ticker || "").trim().toUpperCase() === term);
    });
    const start = (state.researchPage - 1) * state.researchPageSize;
    return {
      entries: filtered.slice(start, start + state.researchPageSize),
      total_count: filtered.length,
      page: state.researchPage,
      page_size: state.researchPageSize,
      filter: state.researchFilter
    };
  }

  async function fetchResearchFeed() {
    if (localPreviewEnabled) return previewResearchFeed();
    const { data, error } = await db.rpc("api_get_research_feed", {
      p_filter: state.researchFilter,
      p_page: state.researchPage,
      p_page_size: state.researchPageSize,
      p_search: state.researchSearch || null
    });
    if (error) {
      if (/api_get_research_feed|schema cache|does not exist/i.test(error.message)) {
        state.researchReady = false;
        return emptyResearchFeed();
      }
      throw error;
    }
    state.researchReady = true;
    return { ...emptyResearchFeed(), ...(data || {}), entries: Array.isArray(data?.entries) ? data.entries : [] };
  }

  async function loadResearchPage({ renderAfter = true } = {}) {
    state.researchBusy = true;
    if (renderAfter && state.route === "research") renderResearch();
    try {
      const feed = await fetchResearchFeed();
      state.researchEntries = feed.entries;
      state.researchTotal = num(feed.total_count);
      const pages = Math.max(Math.ceil(state.researchTotal / state.researchPageSize), 1);
      if (state.researchPage > pages) {
        state.researchPage = pages;
        return await loadResearchPage({ renderAfter });
      }
    } catch (error) {
      console.error(error);
      toast(friendlyError(error), true);
    } finally {
      state.researchBusy = false;
      if (renderAfter && state.route === "research") renderResearch();
    }
  }

  async function setResearchState(articleId, action, value = true) {
    if (localPreviewEnabled) {
      const article = state.researchPreviewSource.find((item) => item.id === articleId);
      if (article) article[`is_${action}`] = value;
      await loadResearchPage();
      return;
    }
    await rpc("api_set_research_article_state", {
      p_article_id: articleId,
      p_action: action,
      p_value: value
    });
    await loadResearchPage();
  }

  async function setResearchGroupState(articleIds, action, value = true) {
    const ids = [...new Set(String(articleIds || "").split(",").map((id) => id.trim()).filter(Boolean))];
    if (!ids.length) return;
    if (localPreviewEnabled) {
      for (const article of state.researchPreviewSource) {
        if (ids.includes(String(article.id))) article[`is_${action}`] = value;
      }
      await loadResearchPage();
      return;
    }
    await Promise.all(ids.map((articleId) => rpc("api_set_research_article_state", {
      p_article_id: articleId,
      p_action: action,
      p_value: value
    })));
    await loadResearchPage();
  }

  async function syncResearchNews({ notify = false } = {}) {
    if (localPreviewEnabled || !state.user || state.researchSyncBusy || !state.researchReady) return null;
    state.researchSyncBusy = true;
    if (state.route === "research") renderResearch();
    try {
      const { data, error } = await db.functions.invoke("sync-research-news", { body: {} });
      if (error) {
        let detail = error.message;
        try { detail = (await error.context?.clone?.().json())?.error || detail; } catch (_) { /* Optional response body. */ }
        throw new Error(detail);
      }
      if (data?.error) throw new Error(data.error);
      if (notify) toast(`${data?.matched_articles || 0} matching news, SEC filings and X posts synced`);
      await loadResearchPage({ renderAfter: false });
      return data;
    } catch (error) {
      console.warn(error);
      if (notify) toast(`News: ${friendlyError(error)}`, true);
      return null;
    } finally {
      state.researchSyncBusy = false;
      if (state.route === "research") renderResearch();
    }
  }

  function emptyEarningsFeed() {
    return { entries: [], tracked_count: 0, last_synced_at: null };
  }

  async function fetchEarningsFeed() {
    if (localPreviewEnabled) {
      return {
        entries: state.earningsEntries,
        tracked_count: state.watchlist.length,
        last_synced_at: new Date().toISOString()
      };
    }
    const { data, error } = await db.rpc("api_get_earnings_calendar");
    if (error) {
      if (/api_get_earnings_calendar|earnings_events|schema cache|does not exist/i.test(error.message)) {
        state.earningsReady = false;
        return emptyEarningsFeed();
      }
      throw error;
    }
    state.earningsReady = true;
    return { ...emptyEarningsFeed(), ...(data || {}), entries: Array.isArray(data?.entries) ? data.entries : [] };
  }

  function applyEarningsFeed(feed) {
    state.earningsEntries = Array.isArray(feed?.entries) ? feed.entries : [];
    state.earningsTrackedCount = num(feed?.tracked_count);
    state.earningsLastSynced = feed?.last_synced_at || null;
  }

  async function loadEarningsPage({ renderAfter = true } = {}) {
    state.earningsBusy = true;
    if (renderAfter && state.route === "earnings") renderEarnings();
    try {
      applyEarningsFeed(await fetchEarningsFeed());
    } catch (error) {
      console.error(error);
      toast(friendlyError(error), true);
    } finally {
      state.earningsBusy = false;
      if (renderAfter && state.route === "earnings") renderEarnings();
    }
  }

  async function syncEarningsCalendar({ notify = false } = {}) {
    if (localPreviewEnabled || !state.user || state.earningsSyncBusy || !state.earningsReady) return null;
    state.earningsSyncBusy = true;
    if (state.route === "earnings") renderEarnings();
    try {
      const { data, error } = await db.functions.invoke("sync-earnings-calendar", { body: {} });
      if (error) {
        let detail = error.message;
        try { detail = (await error.context?.clone?.().json())?.error || detail; } catch (_) { /* Optional response body. */ }
        throw new Error(detail);
      }
      if (data?.error) throw new Error(data.error);
      await loadEarningsPage({ renderAfter: false });
      if (notify) toast(`${data?.updated || 0} watchlist earnings events synced`);
      return data;
    } catch (error) {
      console.warn(error);
      if (notify) toast(`Earnings: ${friendlyError(error)}`, true);
      return null;
    } finally {
      state.earningsSyncBusy = false;
      if (state.route === "earnings") renderEarnings();
    }
  }

  function emptyMacroFeed() {
    return { entries: [], next_event: null, next_fomc: null, last_synced_at: null };
  }

  async function fetchMacroFeed() {
    if (localPreviewEnabled) {
      const sorted = [...state.macroEntries].sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)));
      const upcoming = sorted.filter((event) => new Date(event.scheduled_at).getTime() >= Date.now());
      return {
        entries: sorted,
        next_event: upcoming[0] || null,
        next_fomc: upcoming.find((event) => /^FOMC Rate Decision/i.test(event.event_name)) || null,
        last_synced_at: state.macroLastSynced || new Date().toISOString()
      };
    }
    const from = new Date();
    from.setDate(from.getDate() - 2);
    const to = new Date();
    to.setDate(to.getDate() + 120);
    const { data, error } = await db.rpc("api_get_macro_calendar", {
      p_from: localDayKey(from),
      p_to: localDayKey(to)
    });
    if (error) {
      if (/api_get_macro_calendar|macro_events|schema cache|does not exist/i.test(error.message)) {
        state.macroReady = false;
        return emptyMacroFeed();
      }
      throw error;
    }
    state.macroReady = true;
    return { ...emptyMacroFeed(), ...(data || {}), entries: Array.isArray(data?.entries) ? data.entries : [] };
  }

  function applyMacroFeed(feed) {
    state.macroEntries = Array.isArray(feed?.entries) ? feed.entries : [];
    state.macroNextEvent = feed?.next_event || null;
    state.macroNextFomc = feed?.next_fomc || null;
    state.macroLastSynced = feed?.last_synced_at || null;
  }

  async function loadMacroPage({ renderAfter = true } = {}) {
    state.macroBusy = true;
    if (renderAfter && state.route === "macro") renderMacro();
    try {
      applyMacroFeed(await fetchMacroFeed());
    } catch (error) {
      console.error(error);
      toast(friendlyError(error), true);
    } finally {
      state.macroBusy = false;
      if (renderAfter && state.route === "macro") renderMacro();
    }
  }

  async function syncMacroCalendar({ notify = false } = {}) {
    if (localPreviewEnabled || !state.user || state.macroSyncBusy || !state.macroReady) return null;
    state.macroSyncBusy = true;
    if (state.route === "macro") renderMacro();
    try {
      const { data, error } = await db.functions.invoke("sync-macro-calendar", { body: {} });
      if (error) {
        let detail = error.message;
        try { detail = (await error.context?.clone?.().json())?.error || detail; } catch (_) { /* Optional response body. */ }
        throw new Error(detail);
      }
      if (data?.error) throw new Error(data.error);
      await loadMacroPage({ renderAfter: false });
      if (notify) toast(`${data?.updated || 0} high-impact macro events synced`);
      return data;
    } catch (error) {
      console.warn(error);
      if (notify) toast(`Macro: ${friendlyError(error)}`, true);
      return null;
    } finally {
      state.macroSyncBusy = false;
      if (state.route === "macro") renderMacro();
    }
  }

  function emptyJournalView() {
    return {
      entries: [], total_count: 0, daily: [], monthly: [],
      summary: {
        performance_count: 0, net_pnl: 0, win_count: 0, loss_count: 0,
        breakeven_count: 0, gross_win: 0, gross_loss: 0, avg_win: 0, avg_loss: 0
      }
    };
  }

  function normalizeJournalView(value) {
    const empty = emptyJournalView();
    return {
      ...empty,
      ...(value || {}),
      entries: Array.isArray(value?.entries) ? value.entries : [],
      daily: Array.isArray(value?.daily) ? value.daily : [],
      monthly: Array.isArray(value?.monthly) ? value.monthly : [],
      summary: { ...empty.summary, ...(value?.summary || {}) }
    };
  }

  function localJournalView({ page = 1, pageSize = 50, portfolioId = null, dateFrom = null, dateTo = null, outcome = null, search = null } = {}) {
    const instruments = instrumentMap();
    const term = String(search || "").trim().toLowerCase();
    const filtered = state.journalPreviewSource.filter((item) => {
      const symbol = instruments.get(item.instrument_id)?.symbol || "";
      return !item.is_void
        && (!portfolioId || item.portfolio_id === portfolioId)
        && (!dateFrom || item.occurred_on >= dateFrom)
        && (!dateTo || item.occurred_on <= dateTo)
        && (!outcome || item.outcome === outcome)
        && (!term || `${symbol} ${item.strategy_label || ""} ${item.notes || ""}`.toLowerCase().includes(term));
    }).sort((a, b) => b.occurred_on.localeCompare(a.occurred_on) || b.created_at.localeCompare(a.created_at));
    const performance = filtered.filter((item) => item.manual_pnl != null);
    const wins = performance.filter((item) => num(item.manual_pnl) > 0);
    const losses = performance.filter((item) => num(item.manual_pnl) < 0);
    const grossWin = wins.reduce((sum, item) => sum + num(item.manual_pnl), 0);
    const grossLoss = Math.abs(losses.reduce((sum, item) => sum + num(item.manual_pnl), 0));
    const daily = new Map(), monthly = new Map();
    performance.forEach((item) => {
      daily.set(item.occurred_on, num(daily.get(item.occurred_on)) + num(item.manual_pnl));
      const month = `${item.occurred_on.slice(0, 7)}-01`;
      const current = monthly.get(month) || { month, pnl: 0, count: 0 };
      current.pnl += num(item.manual_pnl); current.count += 1; monthly.set(month, current);
    });
    const start = (page - 1) * pageSize;
    return normalizeJournalView({
      entries: filtered.slice(start, start + pageSize).map((item) => ({ ...item, symbol: instruments.get(item.instrument_id)?.symbol || null })),
      total_count: filtered.length,
      summary: {
        performance_count: performance.length,
        net_pnl: performance.reduce((sum, item) => sum + num(item.manual_pnl), 0),
        win_count: wins.length,
        loss_count: losses.length,
        breakeven_count: performance.filter((item) => num(item.manual_pnl) === 0).length,
        gross_win: grossWin,
        gross_loss: grossLoss,
        avg_win: wins.length ? grossWin / wins.length : 0,
        avg_loss: losses.length ? -grossLoss / losses.length : 0
      },
      daily: [...daily].sort(([a], [b]) => a.localeCompare(b)).map(([date, pnl]) => ({ date, pnl })),
      monthly: [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month))
    });
  }

  async function fetchJournalView({ page = 1, pageSize = 50, portfolioId = null, dateFrom = null, dateTo = null, outcome = null, search = null } = {}) {
    if (localPreviewEnabled) return localJournalView({ page, pageSize, portfolioId, dateFrom, dateTo, outcome, search });
    return normalizeJournalView(await rpc("api_get_journal_view", {
      p_page: page,
      p_page_size: pageSize,
      p_portfolio_id: portfolioId,
      p_date_from: dateFrom,
      p_date_to: dateTo,
      p_outcome: outcome,
      p_search: search
    }));
  }

  function applyJournalView(view) {
    state.journal = view.entries;
    state.journalSummary = view.summary;
    state.journalDaily = view.daily;
    state.journalMonthly = view.monthly;
    state.journalTotal = num(view.total_count);
  }

  async function loadJournalPage({ renderAfter = true } = {}) {
    state.journalBusy = true;
    if (renderAfter && state.route === "journal") renderJournalPaged();
    try {
      const view = await fetchJournalView({
        page: state.journalPage,
        pageSize: state.journalPageSize,
        portfolioId: state.journalFilter === "all" ? null : state.journalFilter,
        dateFrom: state.journalDateFrom || null,
        dateTo: state.journalDateTo || null,
        outcome: state.journalOutcome === "all" ? null : state.journalOutcome,
        search: state.journalSearch || null
      });
      applyJournalView(view);
      const pages = Math.max(Math.ceil(state.journalTotal / state.journalPageSize), 1);
      if (state.journalPage > pages) {
        state.journalPage = pages;
        return await loadJournalPage({ renderAfter });
      }
    } catch (error) {
      console.error(error);
      toast(friendlyError(error), true);
    } finally {
      state.journalBusy = false;
      if (renderAfter && state.route === "journal") renderJournalPaged();
    }
  }

  async function refreshStockPrices({ force = false, notify = false } = {}) {
    if (localPreviewEnabled || !state.user || state.priceRefreshBusy) return null;
    const eligible = state.instruments.some((item) => ["stock", "etf"].includes(String(item.asset_type).toLowerCase()));
    if (!eligible) return null;
    state.priceRefreshBusy = true;
    if (notify) setSync(true, "Updating Webull prices...");
    try {
      const { data, error } = await db.functions.invoke("refresh-stock-prices", { body: { force } });
      if (error) {
        let detail = error.message;
        try {
          const payload = await error.context?.clone?.().json();
          detail = payload?.error || payload?.failures?.map((item) => `${item.symbol}: ${item.message}`).join("; ") || detail;
        } catch (_) { /* Response body is optional. */ }
        throw new Error(`Webull price refresh: ${detail}`);
      }
      if (data?.error) throw new Error(`Webull price refresh: ${data.error}`);
      state.lastWebullRefresh = new Date();
      if (num(data?.updated) > 0) {
        [state.prices, state.instruments] = await Promise.all([
          query("Prices", db.from("instrument_prices").select("*").order("fetched_at", { ascending: false }).limit(2000)),
          query("Instruments", db.from("instruments").select("*").order("symbol"))
        ]);
      }
      setSync(true, `Synced ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
      if (notify) {
        const failed = Array.isArray(data?.failures) ? data.failures.length : 0;
        if (failed) toast(`${data.updated || 0} prices updated; ${failed} could not be read`, true);
        else if (data?.skipped) toast("Stock prices are already current");
        else toast(`${data?.updated || 0} stock prices updated from Webull`);
      }
      render();
      return data;
    } catch (error) {
      console.warn(error);
      if (notify) toast(friendlyError(error), true);
      return null;
    } finally {
      state.priceRefreshBusy = false;
    }
  }

  async function refreshMarketPulse({ force = false, notify = false } = {}) {
    if (!state.user || state.marketPulseBusy || !state.marketPulseReady) return null;
    state.marketPulseBusy = true;
    if (state.route === "watchlist" && state.watchlistView === "market") renderWatchlist();
    try {
      if (localPreviewEnabled) {
        state.marketPulse = previewMarketPulseRows();
        return { rows: state.marketPulse, updated: state.marketPulse.length };
      }
      const { data, error } = await db.functions.invoke("refresh-stock-prices", {
        body: { action: "market_pulse", force }
      });
      if (error) {
        let detail = error.message;
        try { detail = (await error.context?.clone?.().json())?.error || detail; } catch (_) { /* Optional response body. */ }
        throw new Error(detail);
      }
      if (data?.error) throw new Error(data.error);
      state.marketPulse = Array.isArray(data?.rows)
        ? data.rows
        : await optionalMarketPulseQuery();
      if (num(data?.updated) > 0) {
        state.instruments = await query("Instruments", db.from("instruments").select("*").order("symbol"));
      }
      if (notify) {
        const failed = Array.isArray(data?.failures) ? data.failures.length : 0;
        toast(failed
          ? `${data.updated || 0} market snapshots updated; ${failed} batch${failed === 1 ? "" : "es"} need attention`
          : `${data.updated || 0} Webull market snapshots updated`, failed > 0);
      }
      return data;
    } catch (error) {
      console.warn(error);
      if (notify) toast(`Market Pulse: ${friendlyError(error)}`, true);
      return null;
    } finally {
      state.marketPulseBusy = false;
      if (state.route === "watchlist" && state.watchlistView === "market") renderWatchlist();
    }
  }

  async function refreshDashboard() {
    await loadData();
    await refreshStockPrices({ force: true, notify: true });
    if (state.watchlistView === "market") await refreshMarketPulse({ force: true, notify: true });
    await refreshVisibleWatchlistChart();
  }

  async function loadData({ quiet = false } = {}) {
    if (!state.user || state.loading) return;
    if (!quiet) setLoading(true);
    setSync(true, "Syncing…");
    try {
      const [portfolios, cash, positions, instruments, targets, capacities, executions, prices, journalOverview, watchlist, marketPulse, smartMoneyEvents, researchFeed, earningsFeed, macroFeed, briefFeed] = await Promise.all([
        query("Portfolios", db.from("portfolios").select("*").eq("is_active", true).order("sort_order")),
        query("Cash balances", db.from("portfolio_cash_balances").select("*")),
        query("Positions", db.from("position_balances").select("*")),
        query("Instruments", db.from("instruments").select("*").order("symbol")),
        query("Allocation targets", db.from("allocation_targets").select("*").eq("is_active", true)),
        query("Position capacity", db.from("position_capacity").select("*")),
        query("Transaction history", db.from("executions").select("id,portfolio_id,instrument_id,side,quantity,price,multiplier,fee,gross_amount,cash_effect,realized_pnl,executed_at").order("executed_at", { ascending: false }).limit(200)),
        query("Prices", db.from("instrument_prices").select("*").order("fetched_at", { ascending: false }).limit(2000)),
        fetchJournalView({ page: 1, pageSize: 6 }),
        optionalWatchlistQuery(),
        optionalMarketPulseQuery(),
        optionalSmartMoneyQuery(),
        fetchResearchFeed(),
        fetchEarningsFeed(),
        fetchMacroFeed(),
        fetchBriefFeed()
      ]);
      Object.assign(state, { portfolios, cash, positions, instruments, targets, capacities, executions, prices, journalOverview, watchlist, marketPulse, smartMoneyEvents });
      state.researchEntries = researchFeed.entries;
      state.researchTotal = num(researchFeed.total_count);
      applyEarningsFeed(earningsFeed);
      applyMacroFeed(macroFeed);
      applyBriefFeed(briefFeed);
      state.watchlistRecentIds = state.watchlistRecentIds.filter((id) => watchlist.some((item) => item.instrument_id === id));
      if (!state.watchlistRecentIds.length) state.watchlistRecentIds = watchlist.slice(-6).reverse().map((item) => item.instrument_id);
      if (!watchlist.some((item) => item.instrument_id === state.selectedWatchlistInstrumentId)) {
        state.selectedWatchlistInstrumentId = watchlist[0]?.instrument_id || null;
        state.watchlistBars = [];
        state.watchlistLivePrice = null;
      }
      if (!state.selectedPortfolioId || !portfolios.some((item) => item.id === state.selectedPortfolioId)) {
        state.selectedPortfolioId = portfolios[0]?.id || null;
      }
      if (state.route === "journal") await loadJournalPage({ renderAfter: false });
      if (state.route === "research") await loadResearchPage({ renderAfter: false });
      if (state.route === "earnings") await loadEarningsPage({ renderAfter: false });
      if (state.route === "macro") await loadMacroPage({ renderAfter: false });
      if (state.route === "briefs") await loadBriefPage({ renderAfter: false });
      state.lastSync = new Date();
      setSync(true, `Synced ${state.lastSync.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
      render();
      renderNotificationCenter();
    } catch (error) {
      console.error(error);
      setSync(false, "Sync failed");
      toast(friendlyError(error), true);
      if (!quiet) renderError(error);
    } finally {
      setLoading(false);
    }
  }

  function showAuth() {
    state.user = null;
    authShell.hidden = false;
    appShell.hidden = true;
    $("#login-password").value = "";
  }

  async function showApp(user) {
    state.user = user;
    authShell.hidden = true;
    appShell.hidden = false;
    await loadData();
    await refreshStockPrices();
  }

  function renderNav() {
    const nav = $("#portfolio-nav");
    const switcher = $("#portfolio-switcher");
    const mobileMorePanel = $("#mobile-more-panel");
    const mobileMoreButton = $("#mobile-more-button");
    const mobileMoreRoutes = new Set(["smart-money", "research", "earnings", "macro"]);
    nav.innerHTML = state.portfolios.map((portfolio) => {
      const stats = portfolioStats(portfolio);
      return `<button type="button" class="${state.route === "portfolio" && portfolio.id === state.selectedPortfolioId ? "is-active" : ""}" data-portfolio-id="${portfolio.id}">
        <i></i><span>${esc(portfolio.name)}</span><small>${Math.round(stats.utilization)}%</small>
      </button>`;
    }).join("");
    switcher.hidden = state.route !== "portfolio";
    switcher.innerHTML = state.route === "portfolio" ? state.portfolios.map((portfolio) => `<button type="button" class="${portfolio.id === state.selectedPortfolioId ? "is-active" : ""}" data-portfolio-id="${portfolio.id}">${esc(portfolio.name)}</button>`).join("") : "";
    $$(".brand-button[data-route], .nav-item[data-route], .mobile-nav [data-route], .mobile-more-panel [data-route]").forEach((button) => button.classList.toggle("is-active", button.dataset.route === state.route));
    mobileMorePanel.hidden = !state.mobileMoreOpen;
    mobileMoreButton.classList.toggle("is-active", mobileMoreRoutes.has(state.route) || state.mobileMoreOpen);
    mobileMoreButton.setAttribute("aria-expanded", String(state.mobileMoreOpen));
    refreshIcons();
  }

  function render() {
    invalidateWatchlistChartRender();
    renderNav();
    if (!state.portfolios.length) {
      viewRoot.innerHTML = `<div class="empty-state"><div><strong>No active portfolios</strong>Create a portfolio to start tracking cash, positions and allocation.</div></div>`;
      return;
    }
    if (state.route === "portfolio") renderPortfolio();
    else if (state.route === "journal") renderJournalPaged();
    else if (state.route === "watchlist") renderWatchlist();
    else if (state.route === "smart-money") renderSmartMoney();
    else if (state.route === "research") renderResearch();
    else if (state.route === "earnings") renderEarnings();
    else if (state.route === "macro") renderMacro();
    else if (state.route === "briefs") renderBriefs();
    else renderOverview();
    viewRoot.focus({ preventScroll: true });
  }

  function pageHead(kicker, title, copy, actions = "") {
    return `<header class="page-head"><div><p class="eyebrow">${esc(kicker)}</p><h1>${esc(title)}</h1><p>${esc(copy)}</p></div><div class="page-actions">${actions}</div></header>`;
  }

  function renderOverview() {
    const total = combinedStats();
    const recent = state.journalOverview?.entries || [];
    const instruments = instrumentMap();

    viewRoot.innerHTML = `
      ${pageHead("All portfolios · One clear view", "Know where every dollar is.", "Each portfolio keeps its own money and 100% allocation plan. This overview combines visibility, never the portfolio math.", '<button class="button button--ghost" type="button" data-action="portfolio-manage">Manage portfolios</button><button class="button button--primary" type="button" data-action="portfolio-create">+ New portfolio</button>')}
      <section class="hero-ledger" aria-label="Combined summary">
        <div class="hero-metric hero-metric--lead"><small>Total capital<br>Across ${state.portfolios.length} ${state.portfolios.length === 1 ? "portfolio" : "portfolios"}</small><strong>${money(total.capital)}</strong></div>
        <div class="hero-metric"><small>Amount invested<br>Cost / max loss</small><strong>${money(total.deployed)}</strong></div>
        <div class="hero-metric"><small>Money remaining<br>Ready to allocate</small><strong>${money(total.cash)}</strong></div>
      </section>

      <section class="section">
        <div class="section-head"><div><span class="section-index">01 / PORTFOLIOS</span><h2>${state.portfolios.length} ${state.portfolios.length === 1 ? "portfolio" : "portfolios"}. Kept separate.</h2></div><p>Open one to record a buy or sell, adjust its targets, and see what remains.</p></div>
        <div class="portfolio-grid">
          ${state.portfolios.map((portfolio, index) => {
            const stats = portfolioStats(portfolio);
            const plan = allocationSummary(portfolio);
            return `<button class="portfolio-card" type="button" data-open-portfolio="${portfolio.id}">
              <div class="portfolio-card__title"><span>0${index + 1}</span><h3>${esc(portfolio.name)}</h3></div>
              <div class="portfolio-card__numbers">
                <div><small>Total capital</small><strong>${money(stats.capital)}</strong></div>
                <div><small>Invested</small><strong>${money(stats.deployed)}</strong></div>
                <div><small>Remaining</small><strong>${money(stats.cash)}</strong></div>
                <div class="portfolio-card__return ${stats.returnAmount > 0 ? "positive" : stats.returnAmount < 0 ? "negative" : ""}"><small>Portfolio return</small><strong>${stats.returnAmount > 0 ? "+" : ""}${percent(stats.returnPercent, 2)}</strong></div>
              </div>
              <div><div class="meter ${plan.isOver ? "is-risk" : plan.isComplete ? "is-complete" : ""}" style="--meter:${clamp(plan.planned, 0, 100)}%"><i></i></div><p class="meta">${percent(plan.planned)} planned · ${percent(plan.unallocated)} stays as cash</p></div>
            </button>`;
          }).join("")}
        </div>
      </section>

      <section class="section journal-brief">
        <div>
          <div class="section-head"><div><span class="section-index">02 / TRADING P/L</span><h2>Latest outcomes.</h2></div><button class="button button--small" type="button" data-route="journal">View all P/L</button></div>
          ${recent.length ? `<div class="ledger-list">${recent.map((entry) => {
            const portfolio = state.portfolios.find((item) => item.id === entry.portfolio_id);
            const instrument = instruments.get(entry.instrument_id);
            return `<div class="ledger-row"><div class="ledger-row__main"><strong>${esc(instrument?.symbol || entry.strategy_label || "Trade")}</strong><small>${esc(portfolio?.name || "Portfolio")} · ${esc(entry.occurred_on)}</small></div><div class="ledger-row__value ${num(entry.manual_pnl) >= 0 ? "positive" : "negative"}">${money(entry.manual_pnl)}</div></div>`;
          }).join("")}</div>` : `<div class="empty-state"><div><strong>No P/L entries yet</strong>Your latest closed-trade results will appear here.</div></div>`}
        </div>
      </section>`;
  }

  function allocationMap(portfolio, rows) {
    const top = [...rows].sort((a, b) => b.targetPercent - a.targetPercent || b.deployed - a.deployed).slice(0, 8);
    if (!top.length) return `<div class="empty-state"><div><strong>No assets planned yet</strong>Add a ticker and choose its share of this portfolio.</div></div>`;
    return `<div class="allocation-map">${top.map((row) => {
      const progress = row.quota > 0 ? row.deployed / row.quota * 100 : 0;
      const tone = allocationTone(progress);
      const tranches = num(row.target?.planned_tranches);
      return `<div class="allocation-row">
        <div class="allocation-row__symbol"><strong>${esc(row.instrument.symbol)}</strong><small>${esc(row.instrument.display_name || row.instrument.asset_type)}</small></div>
        <div class="allocation-progress"><div class="allocation-track is-${tone} ${progress > 100 ? "is-over" : ""}" style="--current:${clamp(progress, 0, 100)}%"><i></i></div><small>${money(row.deployed)} of ${money(row.quota)}${tranches ? ` · ${tranches} tranches at ~${money(row.quota / tranches)}` : ""}</small></div>
        <div class="allocation-row__number">${percent(row.targetPercent)}<small>target</small></div>
        <div class="allocation-row__number ${row.overage > 0 ? "negative" : "gold"}">${money(row.overage > 0 ? row.overage : row.remaining)}<small>${row.overage > 0 ? "over target" : "left to buy"}</small></div>
      </div>`;
    }).join("")}</div>`;
  }

  function holdingsTable(portfolio) {
    let rows = portfolioRows(portfolio);
    const prices = latestPriceMap();
    const queryText = state.holdingsQuery.trim().toLowerCase();
    if (queryText) rows = rows.filter((row) => `${row.instrument.symbol} ${row.instrument.display_name || ""}`.toLowerCase().includes(queryText));
    const pages = Math.max(1, Math.ceil(rows.length / state.holdingsPageSize));
    state.holdingsPage = clamp(state.holdingsPage, 1, pages);
    const start = (state.holdingsPage - 1) * state.holdingsPageSize;
    const slice = rows.slice(start, start + state.holdingsPageSize);
    if (!slice.length) return `<div class="empty-state"><div><strong>${queryText ? "No matching assets" : "No assets yet"}</strong>${queryText ? "Try another symbol or company name." : "Use Add to plan, then record buys and sells as they happen."}</div></div>`;
    return `<div class="table-shell"><table class="holdings-table">
      <thead><tr><th>Asset</th><th>Position / price</th><th>Market value</th><th>Unrealized P/L</th><th>Allocation</th><th>Actions</th></tr></thead>
      <tbody>${slice.map((row) => {
        const market = prices.get(row.id);
        const quantity = num(row.position?.quantity);
        const multiplier = num(row.instrument?.multiplier || 1);
        const costBasis = row.costBasis;
        const hasMarket = quantity > 0 && num(market?.price) > 0;
        const marketValue = hasMarket ? num(market.price) * quantity * multiplier : 0;
        const unrealized = hasMarket ? marketValue - costBasis : 0;
        const unrealizedPercent = hasMarket && costBasis > 0 ? unrealized / costBasis * 100 : 0;
        const pnlClass = unrealized >= 0 ? "positive" : "negative";
        const pnlSign = unrealized > 0 ? "+" : "";
        const allocationProgress = row.targetPercent > 0 ? row.currentPercent / row.targetPercent * 100 : 0;
        const allocationState = allocationTone(allocationProgress);
        const trim = trimRecommendation(row, market);
        const tranches = num(row.target?.planned_tranches);
        const canPlanBuy = ["stock", "etf"].includes(row.instrument.asset_type);
        return `<tr>
        <td>${assetIdentity(row.instrument)}</td>
        <td><span class="cell-main mono">${quantity.toLocaleString("en-US", { maximumFractionDigits: 8 })}</span><span class="cell-sub">AVG ${quantity > 0 ? money(row.position?.average_cost, 4) : "—"}</span><span class="cell-sub ${market?.source === "webull" ? "price-live" : ""}">${market ? `MKT ${money(market.price, 4)} · ${esc(market.source || "manual")}` : "MKT —"}</span></td>
        <td>${hasMarket ? `<strong class="mono">${money(marketValue)}</strong>` : `<span class="cell-main mono">—</span>`}<span class="cell-sub">COST ${money(costBasis)}</span>${row.instrument.asset_type === "option" ? `<span class="cell-sub">MAX LOSS ${money(row.position?.maximum_loss)}</span><span class="cell-sub">NOTIONAL ${money(row.position?.notional_value)}</span>` : ""}</td>
        <td class="pnl-cell">${hasMarket ? `<strong class="mono ${pnlClass}">${pnlSign}${money(unrealized)}</strong><span class="cell-sub ${pnlClass}">${pnlSign}${percent(unrealizedPercent, 2)}</span>` : `<span class="cell-main mono">—</span><span class="cell-sub">${quantity > 0 ? "Waiting for price" : "No position"}</span>`}</td>
        <td class="allocation-cell ${trim ? "is-over" : ""}"><div class="allocation-cell__top"><strong class="mono">${percent(row.currentPercent)}<small>current</small></strong><span class="mono">${percent(row.targetPercent)}<small>target</small></span></div><div class="allocation-track is-${allocationState} ${allocationProgress > 100 ? "is-over" : ""}" style="--current:${clamp(allocationProgress, 0, 100)}%"><i></i></div><div class="allocation-cell__meta"><span class="${trim ? "negative" : "gold"}">${trim ? `${money(trim.excess)} over` : `${money(row.remaining)} left`}</span><span>${tranches ? `${tranches} tranches · ~${money(row.quota / tranches)} each` : esc(row.status)}</span></div>${trim ? `<div class="allocation-cell__advice"><strong>Suggested trim</strong><span>Sell ~${formatTradeQuantity(trim.quantity)} ${trim.unit}${trim.estimatedProceeds != null ? ` · about ${money(trim.estimatedProceeds)} at market` : ""} to return near ${percent(row.targetPercent)}.</span></div>` : ""}</td>
        <td><div class="row-actions">${canPlanBuy ? `<button class="button button--small button--plan-buy" type="button" data-action="buy-simulate" data-instrument-id="${row.id}">Plan buy</button>` : ""}<button class="button button--small" type="button" data-action="target-edit" data-instrument-id="${row.id}">Edit plan</button><button class="button button--small" type="button" data-action="price-record" data-instrument-id="${row.id}">Price</button>${row.target ? `<button class="button button--small button--remove" type="button" data-action="asset-remove" data-instrument-id="${row.id}" ${num(row.position?.quantity) > 0 ? 'disabled title="Sell the remaining position before removing"' : ""}>Remove</button>` : ""}</div></td>
      </tr>`;
      }).join("")}</tbody>
    </table></div><div class="pagination"><span>${rows.length} assets · showing ${start + 1}–${Math.min(start + state.holdingsPageSize, rows.length)}</span><div><button class="button button--small" type="button" data-action="page-prev" ${state.holdingsPage <= 1 ? "disabled" : ""}>← Prev</button> <button class="button button--small" type="button" data-action="page-next" ${state.holdingsPage >= pages ? "disabled" : ""}>Next →</button></div></div>`;
  }

  function historyDialogMarkup(portfolio) {
    const instruments = instrumentMap();
    const query = state.tradeHistoryQuery.trim().toLowerCase();
    const rows = state.executions.filter((item) => {
      const instrument = instruments.get(item.instrument_id);
      return item.portfolio_id === portfolio.id && (!query || `${instrument?.symbol || ""} ${instrument?.display_name || ""}`.toLowerCase().includes(query));
    });
    const pages = Math.max(1, Math.ceil(rows.length / state.tradeHistoryPageSize));
    state.tradeHistoryPage = clamp(state.tradeHistoryPage, 1, pages);
    const start = (state.tradeHistoryPage - 1) * state.tradeHistoryPageSize;
    const visible = rows.slice(start, start + state.tradeHistoryPageSize);
    if (!visible.length) return `<div class="empty-state"><div><strong>No matching transactions</strong>${query ? "Try another ticker." : "Confirmed buys and sells will appear here automatically."}</div></div>`;
    const formatted = visible.map((execution) => {
      const instrument = instruments.get(execution.instrument_id);
      const isSell = execution.side === "sell";
      const realized = num(execution.realized_pnl);
      const sign = realized > 0 ? "+" : "";
      const fallback = String.fromCharCode(8212);
      return {
        execution,
        isSell,
        realized,
        sign,
        symbol: instrument?.symbol || fallback,
        name: instrument?.display_name || instrument?.asset_type || "",
        date: new Date(execution.executed_at).toLocaleDateString(),
        time: new Date(execution.executed_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      };
    });
    const tableRows = formatted.map(({ execution, isSell, realized, sign, symbol, name, date, time }) =>
      `<tr><td><span class="cell-main mono">${date}</span><span class="cell-sub">${time}</span></td><td><span class="status status--${isSell ? "risk" : "good"}">${isSell ? "SELL" : "BUY"}</span></td><td><span class="cell-main">${esc(symbol)}</span><span class="cell-sub">${esc(name)}</span></td><td><strong class="mono">${formatTradeQuantity(execution.quantity)}</strong></td><td><strong class="mono">${money(execution.price, 4)}</strong><span class="cell-sub">FEE ${money(execution.fee, 4)}</span></td><td><strong class="mono ${isSell ? "positive" : "negative"}">${isSell ? "+" : ""}${money(execution.cash_effect)}</strong></td><td>${isSell ? `<strong class="mono ${realized >= 0 ? "positive" : "negative"}">${sign}${money(realized)}</strong>` : `<span class="cell-sub">On exit</span>`}</td><td><button class="button button--small" type="button" data-action="trade-history-edit" data-execution-id="${execution.id}">Edit</button></td></tr>`
    ).join("");
    const mobileCards = formatted.map(({ execution, isSell, realized, sign, symbol, name, date, time }) =>
      `<article class="history-mobile-card"><header><div><span class="status status--${isSell ? "risk" : "good"}">${isSell ? "SELL" : "BUY"}</span><strong>${esc(symbol)}</strong><span class="cell-sub">${esc(name)}</span></div><button class="button button--small" type="button" data-action="trade-history-edit" data-execution-id="${execution.id}">Edit</button></header><dl><div><dt>Date</dt><dd>${date}<small>${time}</small></dd></div><div><dt>Quantity</dt><dd>${formatTradeQuantity(execution.quantity)}</dd></div><div><dt>Price / fee</dt><dd>${money(execution.price, 4)}<small>Fee ${money(execution.fee, 4)}</small></dd></div><div><dt>Cash movement</dt><dd class="${isSell ? "positive" : "negative"}">${isSell ? "+" : ""}${money(execution.cash_effect)}</dd></div><div><dt>Realized P/L</dt><dd>${isSell ? `<span class="${realized >= 0 ? "positive" : "negative"}">${sign}${money(realized)}</span>` : `<span class="cell-sub">On exit</span>`}</dd></div></dl></article>`
    ).join("");
    return `<div class="table-shell history-table-shell"><table class="trade-history-table"><thead><tr><th>Date</th><th>Type</th><th>Asset</th><th>Quantity</th><th>Price</th><th>Cash movement</th><th>Realized P/L</th><th>Action</th></tr></thead><tbody>${tableRows}</tbody></table></div><div class="history-mobile-list">${mobileCards}</div><div class="pagination"><span>${start + 1}-${Math.min(start + state.tradeHistoryPageSize, rows.length)} of ${rows.length} transactions · latest 200 retained</span><div><button class="button button--small" type="button" data-action="trade-history-prev" ${state.tradeHistoryPage <= 1 ? "disabled" : ""}>Prev</button> <span class="pagination__page">Page ${state.tradeHistoryPage} / ${pages}</span> <button class="button button--small" type="button" data-action="trade-history-next" ${state.tradeHistoryPage >= pages ? "disabled" : ""}>Next</button></div></div>`;
  }

  function openExecutionHistoryDialog() {
    const portfolio = currentPortfolio();
    state.tradeHistoryPage = 1;
    state.tradeHistoryQuery = "";
    openDialog({
      kicker: `${portfolio.name} · Audit trail`, title: "Transaction history", cancelLabel: "Done", wide: true, variant: "history",
      body: `<div class="history-commandbar"><label class="field"><span>Search ticker</span><input type="search" autocomplete="off" data-trade-history-search placeholder="RKLB, NVDA..."></label><span class="meta">Loads only the latest 200 transactions</span></div><div id="trade-history-region">${historyDialogMarkup(portfolio)}</div>`,
      onSubmit: null
    });
    const search = $("[data-trade-history-search]", $("#dialog-body"));
    search?.addEventListener("input", () => {
      state.tradeHistoryQuery = search.value;
      state.tradeHistoryPage = 1;
      const region = $("#trade-history-region", $("#dialog-body"));
      if (region) region.innerHTML = historyDialogMarkup(portfolio);
    });
  }

  function openExecutionEditDialog(executionId) {
    const execution = state.executions.find((item) => item.id === executionId);
    const instrument = instrumentMap().get(execution?.instrument_id);
    const portfolio = state.portfolios.find((item) => item.id === execution?.portfolio_id);
    if (!execution || !instrument || !portfolio) {
      toast("Transaction could not be loaded", true);
      return;
    }
    openDialog({
      kicker: `${portfolio.name} · Audited correction`,
      title: `Edit ${instrument.symbol} ${String(execution.side).toUpperCase()}`,
      submitLabel: "Save correction",
      danger: true,
      body: `<div class="warning-box">This corrects the confirmed record, then rebuilds this ticker's weighted-average cost, cash effect and realized P/L in chronological order.</div>
        <div class="field-row"><label class="field"><span>Quantity</span><input name="quantity" type="number" min="0.00000001" step="0.00000001" value="${esc(execution.quantity)}" required></label><label class="field"><span>Price per share</span><input name="price" type="number" min="0" step="0.0001" value="${esc(execution.price)}" required></label></div>
        <div class="field-row"><label class="field"><span>Fee</span><input name="fee" type="number" min="0" step="any" inputmode="decimal" value="${esc(execution.fee)}" required></label><label class="field"><span>Date and time</span><input name="executed" type="datetime-local" value="${localDateTime(execution.executed_at)}" required></label></div>
        <label class="field"><span>Reason for correction</span><textarea name="reason" maxlength="500" placeholder="Wrong quantity, price, fee or date..." required></textarea></label>`,
      onSubmit: async (form) => {
        await rpc("api_correct_execution", {
          p_execution_id: execution.id,
          p_quantity: num(form.get("quantity")),
          p_price: num(form.get("price")),
          p_fee: num(form.get("fee")),
          p_executed_at: new Date(form.get("executed")).toISOString(),
          p_reason: form.get("reason")
        });
        closeDialog();
        toast(`${instrument.symbol} history corrected`);
        await loadData({ quiet: true });
        openExecutionHistoryDialog();
      }
    });
  }

  function renderPortfolio() {
    const portfolio = currentPortfolio();
    const stats = portfolioStats(portfolio);
    const rows = portfolioRows(portfolio);
    const plan = allocationSummary(portfolio, rows);
    viewRoot.innerHTML = `
      ${pageHead(`${portfolio.name} · ${brokerProfile(portfolio).toUpperCase()} ledger`, portfolio.name, "Stocks and ETFs allocate by market value; options allocate by maximum loss. Each trade follows this portfolio's broker cost method.", `
        <button class="button button--ghost" type="button" data-action="cash-add">Add / withdraw money</button>
        <button class="button button--ghost" type="button" data-action="execution-history">History</button>
        <button class="button button--ghost" type="button" data-action="trade-sell">Sell</button>
        <button class="button button--ghost" type="button" data-action="trade-buy">Buy</button>
        <button class="button button--primary" type="button" data-action="asset-add">+ Add to plan</button>`)}
      <section class="kpi-strip" aria-label="Portfolio summary">
        <div class="kpi"><small>Total capital</small><strong>${money(stats.capital)}</strong></div>
        <div class="kpi"><small>Amount used</small><strong>${money(stats.deployed)}</strong></div>
        <div class="kpi"><small>Money remaining</small><strong class="gold">${money(stats.cash)}</strong></div>
      </section>
      <section class="plan-summary ${plan.isOver ? "is-risk" : plan.isComplete ? "is-complete" : ""}">
        <div><span class="section-index">ALLOCATION PLAN</span><strong>${percent(plan.planned)} / 100%</strong></div>
        <div class="meter" style="--meter:${clamp(plan.planned, 0, 100)}%"><i></i></div>
        <p>${plan.isOver ? `Plan is ${percent(plan.planned - 100)} over 100%. Reduce a target.` : plan.isComplete ? "Plan complete. Every dollar has a job." : `${percent(plan.unallocated)} is unallocated and stays as cash.`}</p>
      </section>
      <section class="section">
        <div class="section-head"><div><span class="section-index">01 / ASSETS</span><h2>Positions, P/L and allocation.</h2></div><p>${rows.length} assets · 25 rows per page</p></div>
        <div class="toolbar"><div class="toolbar__filters"><input id="holding-search" type="search" value="${esc(state.holdingsQuery)}" placeholder="Search ticker or company" aria-label="Search assets"></div><div class="price-sync"><span class="meta">${esc(priceFreshnessLabel())} · options use manual prices</span><button class="button button--small" type="button" data-action="price-refresh">Update stock prices</button></div></div>
        <div id="holdings-region">${holdingsTable(portfolio)}</div>
      </section>
      `;
    const search = $("#holding-search");
    search?.addEventListener("input", () => {
      state.holdingsQuery = search.value;
      state.holdingsPage = 1;
      $("#holdings-region").innerHTML = holdingsTable(portfolio);
    });
  }

  function researchTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Date unavailable";
    const minutes = Math.max(Math.floor((Date.now() - date.getTime()) / 60_000), 0);
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  const researchAnchorStopwords = new Set([
    "ABOUT", "AFTER", "AGAIN", "ALONG", "ANNOUNCED", "BEFORE", "BREAKING", "COMPANY",
    "COULD", "DESIGNED", "EARNINGS", "EVERYTHING", "FIRST", "FROM", "GUIDANCE",
    "HOLDINGS", "HTTPS", "INTO", "LAUNCHED", "MARKET", "MILLION", "MODEL", "MORE",
    "QUARTER", "REPORT", "REPORTED", "REPORTS", "REVENUE", "SHARES", "STOCK",
    "THROUGH", "TODAY", "UNDER", "USING", "WITH", "WOULD"
  ]);

  function researchNumericAnchors(value) {
    const text = String(value || "").replace(/https?:\/\/\S+/gi, " ").toUpperCase().replace(/,/g, "");
    const anchors = new Set();
    for (const match of text.matchAll(/\$?(\d+(?:\.\d+)?)\s*(TRILLION|BILLION|MILLION|[TBM])?\b/g)) {
      let amount = Number(match[1]);
      if (!Number.isFinite(amount)) continue;
      const suffix = match[2] || "";
      const decimalPlaces = (match[1].split(".")[1] || "").length;
      if (suffix === "TRILLION" || suffix === "T") amount *= 1e12;
      else if (suffix === "BILLION" || suffix === "B") amount *= 1e9;
      else if (suffix === "MILLION" || suffix === "M") amount *= 1e6;
      // Small, precise measurements such as 0.018 litres/kWh are often the
      // strongest fingerprint shared by bilingual reports of one event.
      // Keep those while still dropping noisy small integers and one-decimal values.
      if (amount < 3 && !suffix && decimalPlaces < 2) continue;
      if (!suffix && amount >= 1900 && amount <= 2100 && Number.isInteger(amount)) continue;
      anchors.add(amount >= 1e6 ? String(Math.round(amount / 1000) * 1000) : String(amount));
    }
    // Normalize Thai financial shorthand to the same anchor as English
    // headlines: "15,000 ล้านดอลลาร์" and "$15B" both become 15000000000.
    for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(ล้านล้าน|พันล้าน|ล้าน)\s*(?:ดอลลาร์|บาท)?/g)) {
      let amount = Number(match[1]);
      if (!Number.isFinite(amount)) continue;
      if (match[2] === "ล้านล้าน") amount *= 1e12;
      else if (match[2] === "พันล้าน") amount *= 1e9;
      else amount *= 1e6;
      anchors.add(String(Math.round(amount / 1000) * 1000));
    }
    // Capacity figures are strong bilingual event fingerprints. For example,
    // "1.6GW / $15B" can match the Thai report of the same event without
    // treating every story about the same ticker as one event.
    for (const match of text.matchAll(/\b(\d+(?:\.\d+)?)\s*(GW|MW|KW|GWH|MWH|TWH)\b/g)) {
      anchors.add(`${match[2]}:${Number(match[1])}`);
    }
    for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(กิกะวัตต์ชั่วโมง|เมกะวัตต์ชั่วโมง|เทราวัตต์ชั่วโมง|กิกะวัตต์|เมกะวัตต์|กิโลวัตต์)/g)) {
      const units = {
        "กิกะวัตต์": "GW",
        "เมกะวัตต์": "MW",
        "กิโลวัตต์": "KW",
        "กิกะวัตต์ชั่วโมง": "GWH",
        "เมกะวัตต์ชั่วโมง": "MWH",
        "เทราวัตต์ชั่วโมง": "TWH"
      };
      anchors.add(`${units[match[2]]}:${Number(match[1])}`);
    }
    return anchors;
  }

  function researchWordAnchors(value, excluded = new Set()) {
    const anchors = new Set();
    const text = String(value || "")
      .replace(/https?:\/\/\S+/gi, " ")
      // Treat compound forms as words so "liquid-cooled" can match
      // "Liquid Cooling" without weakening the event-level thresholds.
      .replace(/[-_/]+/g, " ");
    for (const token of text.toUpperCase().match(/[A-Z][A-Z0-9.-]{3,}/g) || []) {
      const clean = token.replace(/^[.$]+|[.$]+$/g, "");
      if (clean.length >= 4 && !researchAnchorStopwords.has(clean) && !excluded.has(clean)) anchors.add(clean);
    }
    return anchors;
  }

  function researchSetsOverlap(left, right) {
    let count = 0;
    for (const value of left) if (right.has(value)) count += 1;
    return count;
  }

  function researchPrimaryTicker(article) {
    const text = `${article.title || ""} ${article.description || ""}`;
    const firstExplicitTicker = text.match(/\$([A-Z][A-Z0-9.-]{0,9})\b/i)?.[1];
    return String(firstExplicitTicker || article.tickers?.[0] || "").toUpperCase();
  }

  function researchArticlesMatch(left, right) {
    if (left.source !== "x" || right.source !== "x") return false;
    const leftTime = new Date(left.published_at).getTime();
    const rightTime = new Date(right.published_at).getTime();
    const timeDelta = Math.abs(leftTime - rightTime);
    if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime) || timeDelta > 24 * 60 * 60 * 1000) return false;
    const leftTickers = new Set((left.tickers || []).map((ticker) => String(ticker).toUpperCase()));
    const rightTickers = new Set((right.tickers || []).map((ticker) => String(ticker).toUpperCase()));
    if (!researchSetsOverlap(leftTickers, rightTickers)) return false;
    const sharedTickers = new Set([...leftTickers].filter((ticker) => rightTickers.has(ticker)));
    const samePrimaryTicker = researchPrimaryTicker(left) === researchPrimaryTicker(right);
    const leftText = `${left.title || ""} ${left.description || ""}`;
    const rightText = `${right.title || ""} ${right.description || ""}`;
    const numberOverlap = researchSetsOverlap(researchNumericAnchors(leftText), researchNumericAnchors(rightText));
    const wordOverlap = researchSetsOverlap(
      researchWordAnchors(leftText, sharedTickers),
      researchWordAnchors(rightText, sharedTickers)
    );
    // Event fingerprints are discovered from each pair of posts rather than
    // from a fixed topic-keyword list. Two distinctive shared names in a
    // tight window (for example GEMINI + ROBOTICS) are enough, while older
    // pairs still need stronger numeric or textual evidence.
    const isTightWindow = timeDelta <= 6 * 60 * 60 * 1000;
    return (samePrimaryTicker && (
      numberOverlap >= 2
      || wordOverlap >= 3
      || (numberOverlap >= 1 && wordOverlap >= 1)
      || (isTightWindow && wordOverlap >= 2)
    ))
      // Different lead tickers can occasionally describe one multi-company
      // deal, but only merge those when three distinctive numbers agree.
      || numberOverlap >= 3;
  }

  function groupResearchEntries(entries) {
    const groups = [];
    for (const article of entries) {
      const group = groups.find((candidate) => candidate.members.every((member) => researchArticlesMatch(article, member)));
      if (group) group.members.push(article);
      else groups.push({ members: [article] });
    }
    return groups.map(({ members }) => ({
      ...members[0],
      members,
      is_read: members.every((article) => article.is_read),
      is_saved: members.some((article) => article.is_saved),
      is_portfolio: members.some((article) => article.is_portfolio),
      is_watchlist: members.some((article) => article.is_watchlist),
      tickers: [...new Set(members.flatMap((article) => article.tickers || []))],
      keywords: [...new Set(members.flatMap((article) => article.keywords || []))]
    }));
  }

  function researchArticleMarkup(article) {
    const members = article.members || [article];
    const articleIds = members.map((item) => item.id).join(",");
    const tickers = (article.tickers || []).slice(0, 5);
    const isTickerEvent = article.source === "x" && (article.keywords || []).includes("TICKER_EVENT");
    const isMacro = article.source === "x" && (article.keywords || []).includes("MARKET_MACRO");
    const publisher = article.publisher_name || "Source unavailable";
    const description = String(article.description || "").trim();
    const sourceLabel = article.source === "sec-8k" ? "SEC 8-K" : isTickerEvent ? "TICKER EVENT" : isMacro ? "MARKET / MACRO" : article.source === "x" ? "X POST" : "NEWS";
    const sources = [...new Map(members.map((item) => [item.publisher_name || item.canonical_url, item])).values()];
    return `<article class="news-item ${article.is_read ? "is-read" : "is-unread"}">
      <div class="news-item__rail"><span>${article.is_read ? "READ" : "NEW"}</span><i></i></div>
      <div class="news-item__body">
        <div class="news-item__meta">
          <b>${sourceLabel}</b>
          <span>${esc(publisher)}</span>
          <time datetime="${esc(article.published_at)}">${esc(researchTime(article.published_at))}</time>
          ${article.is_portfolio ? `<strong>IN PORTFOLIO</strong>` : ""}
        </div>
        <h2><a href="${esc(article.canonical_url)}" target="_blank" rel="noopener noreferrer" data-action="research-open" data-article-ids="${esc(articleIds)}">${esc(article.title)}</a></h2>
        ${description ? `<p>${esc(description)}</p>` : ""}
        ${sources.length > 1 ? `<div class="news-item__sources"><strong>${sources.length} SOURCES</strong>${sources.map((source) => `<a href="${esc(source.canonical_url)}" target="_blank" rel="noopener noreferrer" data-action="research-open" data-article-ids="${esc(articleIds)}">${esc(source.publisher_name || "Source")}</a>`).join("")}</div>` : ""}
        <div class="news-item__tickers">${tickers.map((ticker) => `<span>${esc(ticker)}</span>`).join("")}${(article.tickers || []).length > tickers.length ? `<small>+${article.tickers.length - tickers.length}</small>` : ""}${isMacro && !tickers.length ? `<span>MARKET / MACRO</span>` : ""}</div>
      </div>
      <div class="news-item__actions">
        <button class="button button--small" type="button" data-action="research-read" data-article-ids="${esc(articleIds)}" data-value="${article.is_read ? "false" : "true"}">${article.is_read ? "Mark unread" : "Mark read"}</button>
        <button class="button button--small ${article.is_saved ? "is-active" : ""}" type="button" data-action="research-save" data-article-ids="${esc(articleIds)}" data-value="${article.is_saved ? "false" : "true"}">${article.is_saved ? "Saved" : "Save"}</button>
        <button class="button button--small button--ghost" type="button" data-action="research-hide" data-article-ids="${esc(articleIds)}">Hide</button>
      </div>
    </article>`;
  }

  function renderResearch() {
    const pages = Math.max(Math.ceil(state.researchTotal / state.researchPageSize), 1);
    const researchGroups = groupResearchEntries(state.researchEntries);
    const unread = state.researchEntries.filter((item) => !item.is_read).length;
    const portfolio = state.researchEntries.filter((item) => item.is_portfolio).length;
    const saved = state.researchEntries.filter((item) => item.is_saved).length;
    const filters = [
      ["all", "All"],
      ["unread", "Unread"],
      ["portfolio", "Portfolio"],
      ["macro", "Market / Macro"],
      ["saved", "Saved"]
    ];

    viewRoot.innerHTML = `
      ${pageHead("Research desk · News + SEC 8-K + X", "A clean feed for what changed.", "Ticker-linked stories plus a focused Macro lane for FED, economic data, war, oil, gold and BTC. No AI usage.", `<button class="button button--primary" type="button" data-action="research-sync" ${state.researchSyncBusy || !state.researchReady ? "disabled" : ""}>${state.researchSyncBusy ? "Checking sources…" : "Check sources"}</button>`)}
      ${!state.researchReady ? `<div class="warning-box research-setup"><strong>News schema is not installed yet.</strong> Run <code>021_research_news.sql</code>, then deploy <code>sync-research-news</code>.</div>` : ""}
      <section class="news-ledger" aria-label="News summary">
        <div class="news-ledger__lead"><small>MATCHING STORIES</small><strong>${state.researchTotal}</strong><span>${esc(state.researchFilter.toUpperCase())} view</span></div>
        <div><small>UNREAD ON PAGE</small><strong>${unread}</strong><span>Open or mark read</span></div>
        <div><small>PORTFOLIO ON PAGE</small><strong>${portfolio}</strong><span>Current positions only</span></div>
        <div><small>SAVED ON PAGE</small><strong>${saved}</strong><span>Your reading shelf</span></div>
      </section>
      <section class="news-commandbar" aria-label="News controls">
        <nav class="news-filters" aria-label="News filters">${filters.map(([value, label], index) => `<button type="button" class="${state.researchFilter === value ? "is-active" : ""}" data-action="research-filter" data-filter="${value}"><span>0${index + 1}</span>${label}</button>`).join("")}</nav>
        <label class="news-search"><span>SEARCH TICKER</span><input type="search" data-research-search autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="20" placeholder="NVDA, BE, RKLB…" value="${esc(state.researchSearch)}"></label>
      </section>
      <section class="news-feed" aria-live="polite" aria-busy="${state.researchBusy}">
        <header class="section-head news-feed__head"><div><span class="section-index">01 / SOURCE TAPE</span><h2>Latest from the wire.</h2></div><p>${state.researchTotal ? `Page ${state.researchPage} of ${pages} · ${researchGroups.length} events from ${state.researchEntries.length} source posts` : "Waiting for the first matching story"}</p></header>
        ${state.researchBusy
          ? `<div class="news-empty"><span></span><p>Reading the latest source index…</p></div>`
          : researchGroups.length
            ? researchGroups.map(researchArticleMarkup).join("")
            : `<div class="news-empty"><strong>No stories in this view.</strong><p>${state.researchSearch ? `No news, SEC 8-K filings or tagged X posts matched ticker ${esc(state.researchSearch.trim().toUpperCase())}.` : state.researchFilter === "saved" ? "Save useful articles and they will stay here." : "Run the collector or choose another filter."}</p></div>`}
      </section>
      <div class="pagination news-pagination">
        <span>${state.researchTotal.toLocaleString()} matching stories · 25 at a time</span>
        <div><button class="button button--small" type="button" data-action="research-page-prev" ${state.researchPage <= 1 || state.researchBusy ? "disabled" : ""}>← Prev</button> <span class="pagination__page">Page ${state.researchPage} / ${pages}</span> <button class="button button--small" type="button" data-action="research-page-next" ${state.researchPage >= pages || state.researchBusy ? "disabled" : ""}>Next →</button></div>
      </div>`;
  }

  function calendarDate(value) {
    const date = new Date(`${value}T12:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function localDayKey(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function earningsMonthWeeks(reference = new Date()) {
    const year = reference.getFullYear();
    const month = reference.getMonth();
    const monthStart = new Date(year, month, 1, 12);
    const monthEnd = new Date(year, month + 1, 0, 12);
    const firstWeekday = new Date(monthStart);
    while ([0, 6].includes(firstWeekday.getDay())) firstWeekday.setDate(firstWeekday.getDate() + 1);
    const firstMonday = new Date(firstWeekday);
    firstMonday.setDate(firstMonday.getDate() - ((firstMonday.getDay() + 6) % 7));
    const weeks = [];
    for (let monday = firstMonday; monday <= monthEnd; monday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7, 12)) {
      const days = Array.from({ length: 5 }, (_, offset) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + offset, 12));
      if (days.some((day) => day.getMonth() === month)) weeks.push({ start: days[0], end: days[4], days });
    }
    return { year, month, monthStart, monthEnd, weeks };
  }

  function earningsMonthEntries(reference = new Date()) {
    const { year, month } = earningsMonthWeeks(reference);
    return state.earningsEntries
      .filter((event) => {
        const date = calendarDate(event.earnings_date);
        return date && date.getFullYear() === year && date.getMonth() === month;
      })
      .sort((a, b) => String(a.earnings_date).localeCompare(String(b.earnings_date)) || num(a.report_sort) - num(b.report_sort) || String(a.symbol).localeCompare(String(b.symbol)));
  }

  function earningsHourLabel(hour) {
    return ({ bmo: "Before open", amc: "After close", dmh: "During market", tbd: "Time TBD" })[String(hour || "tbd").toLowerCase()] || "Time TBD";
  }

  function earningsMetric(actual, estimate, label) {
    const hasActual = actual != null && Number.isFinite(Number(actual));
    const hasEstimate = estimate != null && Number.isFinite(Number(estimate));
    const format = label === "Revenue" ? compactMoney : (value) => money(value, 2);
    return `<div class="earnings-metric"><small>${esc(label)}</small><strong>${hasActual ? format(actual) : hasEstimate ? format(estimate) : "—"}</strong><span>${hasActual ? "ACTUAL" : hasEstimate ? "ESTIMATE" : "NOT PROVIDED"}</span></div>`;
  }

  function earningsTickerMarkup(event) {
    const instrument = state.instruments.find((item) => item.id === event.instrument_id) || event;
    const hasActual = event.eps_actual != null || event.revenue_actual != null;
    return `<button class="earnings-ticker ${hasActual ? "is-reported" : ""}" type="button" data-action="earnings-detail" data-earnings-id="${esc(event.id)}" aria-label="Open ${esc(event.symbol)} earnings details">
      ${assetMark(instrument, "small")}
      <strong>${esc(event.symbol)}</strong>
      <span aria-hidden="true">↗</span>
    </button>`;
  }

  function earningsSessionMarkup(events, hour, label) {
    const matching = hour === "tbd"
      ? events.filter((event) => !["bmo", "amc"].includes(String(event.report_hour || "tbd")))
      : events.filter((event) => String(event.report_hour || "tbd") === hour);
    const session = ({
      bmo: { icon: "☀", text: "Before open" },
      amc: { icon: "☾", text: "After close" },
      tbd: { icon: "?", text: "Time TBD" },
    })[hour] || { icon: "?", text: label };
    return `<section class="earnings-session earnings-session--${hour}">
      <header>
        <span class="earnings-session__label"><b aria-hidden="true">${session.icon}</b><em>${esc(session.text)}</em></span>
        <small>${matching.length || "—"}</small>
      </header>
      <div class="earnings-session__tickers">${matching.length ? matching.map(earningsTickerMarkup).join("") : `<p>No reports</p>`}</div>
    </section>`;
  }

  function openEarningsDetail(earningsId) {
    const event = state.earningsEntries.find((item) => String(item.id) === String(earningsId));
    if (!event) return toast("Earnings event was not found", true);
    const instrument = state.instruments.find((item) => item.id === event.instrument_id) || event;
    const hasActual = event.eps_actual != null || event.revenue_actual != null;
    const quarter = event.fiscal_year && event.fiscal_quarter ? `FY${event.fiscal_year} · Q${event.fiscal_quarter}` : "Fiscal period not supplied";
    const date = calendarDate(event.earnings_date);
    openDialog({
      kicker: `${date ? date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : event.earnings_date} · ${earningsHourLabel(event.report_hour)}`,
      title: `${event.symbol} earnings`,
      cancelLabel: "Done",
      body: `<article class="earnings-detail">
        <header>${assetIdentity(instrument)}<span class="earnings-time earnings-time--${esc(event.report_hour || "tbd")}">${esc(earningsHourLabel(event.report_hour))}</span></header>
        <div class="earnings-event__metrics">
          ${earningsMetric(event.eps_actual, event.eps_estimate, "EPS")}
          ${earningsMetric(event.revenue_actual, event.revenue_estimate, "Revenue")}
        </div>
        <dl><div><dt>Schedule status</dt><dd>${hasActual ? "Reported" : "Estimated"}</dd></div><div><dt>Fiscal period</dt><dd>${esc(quarter)}</dd></div><div><dt>Coverage</dt><dd>Watchlist only</dd></div><div><dt>Calendar sources</dt><dd>Finnhub + verified gaps</dd></div></dl>
        <p>Dates and market sessions can be revised by the company. Use this card as a calendar reminder, not an investment signal.</p>
      </article>`,
    });
  }

  function renderEarnings() {
    const calendar = earningsMonthWeeks();
    state.earningsWeekIndex = Math.max(0, Math.min(num(state.earningsWeekIndex), calendar.weeks.length - 1));
    const selectedWeek = calendar.weeks[state.earningsWeekIndex];
    const monthEntries = earningsMonthEntries();
    const entries = monthEntries.filter((event) => {
      const date = calendarDate(event.earnings_date);
      return date && date >= selectedWeek.start && date <= selectedWeek.end && ![0, 6].includes(date.getDay());
    });
    const groups = new Map(selectedWeek.days.map((day) => [localDayKey(day), []]));
    entries.forEach((event) => groups.get(event.earnings_date)?.push(event));
    const todayKey = localDayKey();
    const nextEvent = monthEntries
      .filter((event) => event.earnings_date >= todayKey)
      .sort((a, b) => String(a.earnings_date).localeCompare(String(b.earnings_date)))[0];
    const syncLabel = state.earningsLastSynced
      ? new Date(state.earningsLastSynced).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "Not synced yet";
    const monthLabel = calendar.monthStart.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    const weekLabel = `${selectedWeek.start.toLocaleDateString("en-US", { month: "short", day: "numeric" })}—${selectedWeek.end.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

    viewRoot.innerHTML = `
      ${pageHead("Watchlist intelligence · Earnings", "One month. Week by week.", `Only ${monthLabel} is on the board. Move week by week, then open a ticker only when you need its EPS and revenue context.`, `<button class="button button--primary" type="button" data-action="earnings-sync" ${state.earningsSyncBusy || !state.earningsReady ? "disabled" : ""}>${state.earningsSyncBusy ? "Checking sources…" : "Update calendar"}</button>`)}
      ${!state.earningsReady ? `<div class="warning-box earnings-setup"><strong>Earnings Calendar is not installed yet.</strong> Run <code>032_earnings_calendar.sql</code>, add the calendar provider secrets, then deploy <code>sync-earnings-calendar</code>.</div>` : ""}
      <section class="earnings-ledger" aria-label="Earnings calendar summary">
        <div class="earnings-ledger__lead"><small>MONTH ON DECK</small><strong>${esc(calendar.monthStart.toLocaleDateString("en-US", { month: "short" }).toUpperCase())}</strong><span>${monthEntries.length} watchlist events loaded</span></div>
        <div><small>THIS WEEK</small><strong>${entries.length}</strong><span>${esc(weekLabel)}</span></div>
        <div><small>WATCHLIST NAMES</small><strong>${state.earningsTrackedCount}</strong><span>Stocks and ETFs tracked</span></div>
        <div><small>NEXT REPORT</small><strong>${esc(nextEvent?.symbol || "—")}</strong><span>${nextEvent ? `${esc(nextEvent.earnings_date)} · ${esc(earningsHourLabel(nextEvent.report_hour))}` : `No remaining ${esc(monthLabel)} event`}</span></div>
      </section>
      <section class="earnings-commandbar" aria-label="Weeks in ${esc(monthLabel)}">
        <div><span>${esc(monthLabel.toUpperCase())} · WEEK</span><nav>${calendar.weeks.map((week, index) => `<button type="button" class="${state.earningsWeekIndex === index ? "is-active" : ""}" data-action="earnings-week" data-week="${index}" aria-label="Week ${index + 1}, ${week.start.toLocaleDateString("en-US", { month: "short", day: "numeric" })} to ${week.end.toLocaleDateString("en-US", { month: "short", day: "numeric" })}"><b>${String(index + 1).padStart(2, "0")}</b><small>${week.start.getDate()}—${week.end.getDate()}</small></button>`).join("")}</nav></div>
        <p>Monday—Friday · ☀ before open · ☾ after close · ${esc(syncLabel)}</p>
      </section>
      <section class="earnings-agenda" aria-live="polite" aria-busy="${state.earningsBusy}">
        <header class="section-head earnings-agenda__head"><div><span class="section-index">01 / WEEK ${String(state.earningsWeekIndex + 1).padStart(2, "0")}</span><h2>The week at a glance.</h2></div><p>${entries.length ? `${entries.length} watchlist events · tap a name for estimates` : "No watchlist earnings this week"}</p></header>
        ${state.earningsBusy
          ? `<div class="earnings-empty"><span></span><p>Reading the watchlist calendar…</p></div>`
          : `<div class="earnings-week-grid">${[...groups.entries()].map(([dateKey, events]) => {
              const date = calendarDate(dateKey);
              const isToday = dateKey === todayKey;
              const insideMonth = date.getMonth() === calendar.month;
              return `<section class="earnings-week-day ${isToday ? "is-today" : ""} ${insideMonth ? "" : "is-outside"}">
                <header><span>${isToday ? "TODAY" : esc(date.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase())}</span><strong>${esc(date.toLocaleDateString("en-US", { month: "short", day: "numeric" }))}</strong><small>${insideMonth ? `${events.length} REPORT${events.length === 1 ? "" : "S"}` : "OUTSIDE MONTH"}</small></header>
                ${insideMonth ? `${earningsSessionMarkup(events, "bmo", "BMO")}${earningsSessionMarkup(events, "amc", "AMC")}${events.some((event) => !["bmo", "amc"].includes(event.report_hour)) ? earningsSessionMarkup(events, "tbd", "TBD") : ""}` : ""}
              </section>`;
            }).join("")}</div>`}
      </section>
      <p class="earnings-disclaimer">Finnhub is the primary calendar. A missing ticker is added only when Alpha Vantage and Yahoo Finance agree on its exact date; this fallback can never move a Finnhub event. Unknown sessions stay TBD instead of being guessed. Dates can still be revised by the company.</p>`;
  }

  function macroDateParts(value, timeZone = "America/New_York") {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(date).map((part) => [part.type, part.value]));
  }

  function macroDayKey(value) {
    const parts = macroDateParts(value);
    return parts ? `${parts.year}-${parts.month}-${parts.day}` : "";
  }

  function macroTime(value, timeZone, hour12 = false) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleTimeString("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hour12 });
  }

  function macroNumber(value) {
    const text = String(value || "").replace(/,/g, "");
    const matches = text.match(/-?\d+(?:\.\d+)?/g);
    if (!matches?.length) return null;
    const multiplier = /M/i.test(text) ? 1_000_000 : /K/i.test(text) ? 1_000 : 1;
    const numbers = matches.map(Number).filter(Number.isFinite);
    if (!numbers.length) return null;
    return (numbers.reduce((total, item) => total + item, 0) / numbers.length) * multiplier;
  }

  function macroRead(event) {
    if (!event?.actual) return { label: "UPCOMING", tone: "upcoming" };
    const actual = macroNumber(event.actual);
    const previous = macroNumber(event.previous);
    if (actual == null || previous == null) return { label: "RELEASED", tone: "neutral" };
    if (Math.abs(actual - previous) < 0.000001) return { label: "UNCHANGED", tone: "neutral" };
    const higher = actual > previous;
    if (event.signal_family === "inflation") return { label: higher ? "HOTTER" : "COOLER", tone: higher ? "hot" : "cool" };
    if (event.signal_family === "labor_strength") return { label: higher ? "FIRMER" : "SOFTER", tone: higher ? "hot" : "cool" };
    if (event.signal_family === "labor_inverse") return { label: higher ? "WEAKER" : "FIRMER", tone: higher ? "hot" : "cool" };
    if (event.signal_family === "policy") return { label: higher ? "TIGHTER" : "EASIER", tone: higher ? "hot" : "cool" };
    return { label: higher ? "STRONGER" : "SOFTER", tone: higher ? "hot" : "cool" };
  }

  function macroCountdown(event) {
    if (!event?.scheduled_at) return { value: "—", unit: "DAYS", detail: "No scheduled FOMC meeting" };
    const date = new Date(event.scheduled_at);
    const diff = Math.max(date.getTime() - Date.now(), 0);
    const days = Math.ceil(diff / 86_400_000);
    const detail = `${date.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric" })} · ${macroTime(event.scheduled_at, "America/New_York", true)} ET`;
    if (days >= 1) return { value: days, unit: days === 1 ? "DAY" : "DAYS", detail };
    const hours = Math.max(1, Math.ceil(diff / 3_600_000));
    return { value: hours, unit: hours === 1 ? "HOUR" : "HOURS", detail };
  }

  function macroEventMarkup(event) {
    const read = macroRead(event);
    const sourceUrl = /^https:\/\//i.test(event.source_url || "") ? event.source_url : "";
    const consensus = event.forecast ? `<small>CONSENSUS ${esc(event.forecast)}</small>` : "";
    return `<article class="macro-event">
      <div class="macro-event__time">
        <span class="macro-impact" aria-label="High impact"><i></i><i></i><i></i></span>
        <strong>${esc(macroTime(event.scheduled_at, "America/New_York", true))}</strong>
        <small>${esc(macroTime(event.scheduled_at, "Asia/Bangkok"))} BKK</small>
      </div>
      <div class="macro-event__body">
        <span>${esc(String(event.event_group || "macro").toUpperCase())} · ${esc(event.reference_period || event.category || "US")}</span>
        <h3>${esc(event.event_name)}</h3>
        <p>${esc(event.source_name || "Official release")}</p>
      </div>
      <div class="macro-event__metrics">
        <div><small>ACTUAL</small><strong>${esc(event.actual || "—")}</strong>${consensus}</div>
        <div><small>PREVIOUS</small><strong>${esc(event.previous || "—")}</strong></div>
        <div class="macro-read macro-read--${read.tone}"><small>READ</small><strong>${esc(read.label)}</strong></div>
      </div>
      <div class="macro-event__source">${sourceUrl ? `<a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer">SOURCE ↗</a>` : `<span>SOURCE PENDING</span>`}</div>
    </article>`;
  }

  function renderMacro() {
    const now = Date.now();
    const tapeEnd = now + 35 * 86_400_000;
    const entries = [...state.macroEntries]
      .filter((event) => {
        const time = new Date(event.scheduled_at).getTime();
        return Number.isFinite(time) && time >= now - 2 * 86_400_000 && time <= tapeEnd;
      })
      .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at) || String(a.event_name).localeCompare(String(b.event_name)));
    const upcoming = entries.filter((event) => new Date(event.scheduled_at).getTime() >= now);
    const nextEvent = state.macroNextEvent || upcoming[0] || null;
    const nextFomc = state.macroNextFomc || state.macroEntries.find((event) => /^FOMC Rate Decision/i.test(event.event_name) && new Date(event.scheduled_at).getTime() >= now) || null;
    const countdown = macroCountdown(nextFomc);
    const sevenDays = upcoming.filter((event) => new Date(event.scheduled_at).getTime() <= now + 7 * 86_400_000).length;
    const released = entries.filter((event) => event.actual && new Date(event.scheduled_at).getTime() < now).length;
    const groups = new Map();
    entries.forEach((event) => {
      const key = macroDayKey(event.scheduled_at);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(event);
    });
    const syncLabel = state.macroLastSynced
      ? new Date(state.macroLastSynced).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "Not synced yet";
    const nextRead = nextEvent ? macroRead(nextEvent) : { label: "CLEAR", tone: "neutral" };

    viewRoot.innerHTML = `
      ${pageHead("US macro · High impact only", "The releases that move the tape.", "FOMC, inflation, labor, growth and activity — a deliberately narrow calendar built from official schedules and FRED observations.", `<button class="button button--primary" type="button" data-action="macro-sync" ${state.macroSyncBusy || !state.macroReady ? "disabled" : ""}>${state.macroSyncBusy ? "Reading sources…" : "Update sources"}</button>`)}
      ${!state.macroReady ? `<div class="warning-box macro-setup"><strong>Macro Calendar is not installed yet.</strong> Run <code>035_us_macro_calendar.sql</code>, add <code>FRED_API_KEY</code>, then deploy <code>sync-macro-calendar</code>.</div>` : ""}
      <section class="macro-hero" aria-label="Macro command summary">
        <article class="macro-fomc">
          <div><span>01 / NEXT POLICY GATE</span><small>${esc(nextFomc?.event_name || "FOMC schedule")}</small></div>
          <div class="macro-countdown"><strong>${esc(countdown.value)}</strong><span>${esc(countdown.unit)}</span></div>
          <footer><b>${esc(countdown.detail)}</b><small>${esc(nextFomc?.previous ? `Current target ${nextFomc.previous}` : "Federal Reserve calendar")}</small></footer>
        </article>
        <article class="macro-next">
          <span>02 / NEXT MARKET DRIVER</span>
          <strong>${esc(nextEvent?.event_name || "No event scheduled")}</strong>
          <p>${nextEvent ? `${esc(new Date(nextEvent.scheduled_at).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric" }))} · ${esc(macroTime(nextEvent.scheduled_at, "America/New_York", true))} ET` : "The 35-day tape is clear."}</p>
          <div class="macro-read macro-read--${nextRead.tone}">${esc(nextRead.label)}</div>
        </article>
      </section>
      <section class="macro-ledger" aria-label="Macro calendar status">
        <div><small>NEXT 7 DAYS</small><strong>${sevenDays}</strong><span>high-impact releases</span></div>
        <div><small>35-DAY TAPE</small><strong>${entries.length}</strong><span>curated events</span></div>
        <div><small>JUST REPORTED</small><strong>${released}</strong><span>actual values loaded</span></div>
        <div><small>LAST SOURCE READ</small><strong class="macro-ledger__time">${esc(syncLabel)}</strong><span>FRED + official calendars</span></div>
      </section>
      <section class="macro-tape" aria-live="polite" aria-busy="${state.macroBusy}">
        <header class="section-head macro-tape__head"><div><span class="section-index">03 / EVENT TAPE</span><h2>Thirty-five days. No filler.</h2></div><p>Times shown in New York and Bangkok.</p></header>
        ${state.macroBusy && !entries.length
          ? `<div class="macro-empty"><span></span><p>Reading official macro sources…</p></div>`
          : groups.size
            ? [...groups.entries()].map(([dayKey, events]) => {
                const date = new Date(`${dayKey}T12:00:00Z`);
                const isToday = dayKey === macroDayKey(new Date());
                return `<section class="macro-day">
                  <header><span>${isToday ? "TODAY" : esc(date.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long" }).toUpperCase())}</span><strong>${esc(date.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" }))}</strong><small>${events.length} EVENT${events.length === 1 ? "" : "S"}</small></header>
                  <div>${events.map(macroEventMarkup).join("")}</div>
                </section>`;
              }).join("")
            : `<div class="macro-empty"><strong>No high-impact events loaded.</strong><p>The official calendar has no entries in this 35-day window.</p></div>`}
      </section>
      <p class="macro-disclaimer">Actual and previous values come from FRED; release dates come from FRED, the Federal Reserve and ISM. Consensus forecasts are left blank unless a verified source is added. “Hotter”, “firmer” and related labels compare only with the previous reading — they are not trade signals.</p>`;
  }

  function smartMoneyCodeLabel(code) {
    return ({
      P: "Open-market purchase", S: "Open-market sale", A: "Grant / award",
      M: "Option exercise", F: "Tax withholding", G: "Gift", D: "Disposition to issuer"
    })[String(code || "").toUpperCase()] || "Ownership change";
  }

  function smartMoneyDate(value, withTime = false) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return esc(value);
    return date.toLocaleString("en-US", withTime
      ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "numeric", year: "numeric" });
  }

  function smartMoneyVisibleEvents() {
    const instruments = instrumentMap();
    const watchIds = new Set(state.watchlist.map((item) => item.instrument_id));
    const cutoff = Date.now() - state.smartMoneyWindow * 86_400_000;
    const queryText = state.smartMoneySearch.trim().toLowerCase();
    return state.smartMoneyEvents.map((event) => ({ ...event, instrument: instruments.get(event.instrument_id) }))
      .filter((event) => event.instrument && watchIds.has(event.instrument_id))
      .filter((event) => !event.filed_at || new Date(event.filed_at).getTime() >= cutoff)
      .filter((event) => state.smartMoneySide === "all" || event.side === state.smartMoneySide)
      .filter((event) => !queryText || [event.instrument.symbol, event.instrument.display_name, event.filer_name, event.filer_title, event.relationship]
        .some((value) => String(value || "").toLowerCase().includes(queryText)))
      .sort((a, b) => new Date(b.filed_at || 0) - new Date(a.filed_at || 0));
  }

  function smartMoneyEventMarkup(event) {
    const side = ["buy", "sell"].includes(event.side) ? event.side : "other";
    const shares = num(event.shares);
    const price = num(event.price);
    const value = num(event.transaction_value) || Math.abs(shares * price);
    const sourceUrl = /^https:\/\/www\.sec\.gov\//i.test(event.sec_url || "") ? event.sec_url : "";
    const role = [event.filer_title, event.relationship].filter(Boolean).join(" · ") || "Reporting owner";
    return `<article class="smart-event smart-event--${side}">
      <div class="smart-event__rail"><span>${side === "buy" ? "BUY" : side === "sell" ? "SELL" : esc(event.transaction_code || "OTHER")}</span><i></i></div>
      <div class="smart-event__body">
        <header class="smart-event__head">
          <div><span class="smart-event__ticker">${esc(event.instrument.symbol)}</span><strong>${esc(event.filer_name || "Unknown reporting owner")}</strong><small>${esc(role)}</small></div>
          <div class="smart-event__value"><strong>${value ? compactMoney(value) : "—"}</strong><small>${esc(smartMoneyCodeLabel(event.transaction_code))}</small></div>
        </header>
        <div class="smart-event__facts">
          <div><small>TRANSACTION</small><strong>${shares ? `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(shares)} shares` : "Not reported"}${price ? ` @ ${money(price, 2)}` : ""}</strong></div>
          <div><small>TRADED</small><strong>${smartMoneyDate(event.transaction_date)}</strong></div>
          <div><small>FILED</small><strong>${smartMoneyDate(event.filed_at, true)}</strong></div>
          <div><small>OWNED AFTER</small><strong>${event.post_transaction_shares == null ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(num(event.post_transaction_shares))}</strong></div>
        </div>
      </div>
      <div class="smart-event__source">${sourceUrl ? `<a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer">SEC filing ↗</a>` : `<span>SEC link pending</span>`}</div>
    </article>`;
  }

  function briefArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function briefDateLabel(value, options = {}) {
    const date = new Date(`${value}T12:00:00`);
    if (Number.isNaN(date.getTime())) return String(value || "");
    return date.toLocaleDateString("en-US", { month: options.short ? "short" : "long", day: "numeric", year: "numeric" });
  }

  function briefPublishedTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString("en-US", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function briefTone(value) {
    return ["positive", "neutral", "caution", "negative"].includes(value) ? value : "neutral";
  }

  function briefItemText(value) {
    if (typeof value === "string" || typeof value === "number") return String(value).trim();
    if (Array.isArray(value)) return value.map(briefItemText).filter(Boolean).join(" · ");
    return "";
  }

  function briefItemTone(item) {
    const value = String(item?.tone || item?.stance || item?.signal || "neutral").toLowerCase();
    if (["positive", "bullish", "supportive"].includes(value)) return "positive";
    if (["negative", "bearish"].includes(value)) return "negative";
    if (["caution", "risk", "watch", "warning"].includes(value)) return "caution";
    return "neutral";
  }

  function briefTextItems(value) {
    return briefArray(value).map((item) => {
      if (typeof item === "string") return `<li class="brief-note">${esc(item)}</li>`;
      if (!item || typeof item !== "object") return "";
      const ignoredKeys = new Set(["tone", "stance", "signal", "impact", "source_ids", "sources"]);
      const fallbackValues = Object.entries(item)
        .filter(([key]) => !ignoredKeys.has(key))
        .map(([, entry]) => briefItemText(entry))
        .filter(Boolean);
      const datedEvent = item?.event ? [briefItemText(item.when || item.date), briefItemText(item.event)].filter(Boolean).join(" — ") : "";
      const title = datedEvent || briefItemText(item.title || item.label || item.name || item.date || item.scope || item.event || item.category || item.type || item.point)
        || fallbackValues[0]
        || "Market update";
      const detail = briefItemText(item.detail || item.summary || item.note || item.value || item.text || item.description
        || item.rationale || item.interpretation || item.read_through || item.market_impact || item.portfolio_impact
        || item.why_it_matters || item.why || item.facts || item.action)
        || fallbackValues.find((entry) => entry !== title)
        || "";
      const tone = briefItemTone(item);
      return `<li class="brief-note brief-note--${tone}"><strong>${esc(title)}</strong>${detail ? `<p>${esc(detail)}</p>` : ""}</li>`;
    }).filter(Boolean).join("");
  }

  function briefSourceLink(source) {
    const url = String(source?.url || "").trim();
    const safeUrl = /^https:\/\//i.test(url) ? url : "";
    const title = source?.title || source?.publisher || source?.id || "Source";
    const publisher = source?.publisher && source.publisher !== title ? `<span>${esc(source.publisher)}</span>` : "";
    return safeUrl
      ? `<a href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer"><strong>${esc(title)}</strong>${publisher}<small>SOURCE ↗</small></a>`
      : `<div><strong>${esc(title)}</strong>${publisher}<small>SOURCE UNAVAILABLE</small></div>`;
  }

  function briefStoryMarkup(story, index, sourceMap) {
    const facts = briefArray(story?.facts || story?.confirmed || story?.evidence || story?.key_facts || (story?.fact ? [story.fact] : []));
    const interpretations = briefArray(story?.interpretation || story?.interpretations || story?.market_read || story?.read_through || story?.why_it_matters || story?.implications || []);
    const sourceIds = briefArray(story?.source_ids || story?.sources || []);
    const sources = sourceIds.map((id) => sourceMap.get(String(id))).filter(Boolean);
    return `<article class="brief-story">
      <div class="brief-story__index">${String(index + 1).padStart(2, "0")}</div>
      <div class="brief-story__body">
        <h3>${esc(story?.title || story?.headline || story?.theme || story?.topic || `Market driver ${index + 1}`)}</h3>
        ${facts.length ? `<div class="brief-story__facts"><span>CONFIRMED</span>${facts.map((fact) => `<p>${esc(briefItemText(typeof fact === "object" ? fact?.detail || fact?.text || fact?.fact || Object.values(fact || {}) : fact))}</p>`).join("")}</div>` : ""}
        ${interpretations.length ? `<div class="brief-story__read"><span>MARKET READ-THROUGH</span>${interpretations.map((read) => `<p>${esc(briefItemText(typeof read === "object" ? read?.detail || read?.text || read?.read || Object.values(read || {}) : read))}</p>`).join("")}</div>` : ""}
        ${story?.summary ? `<p>${esc(story.summary)}</p>` : ""}
        ${sources.length ? `<div class="brief-story__sources">${sources.map(briefSourceLink).join("")}</div>` : ""}
      </div>
    </article>`;
  }

  function briefContinuationMarkup(update) {
    const content = update?.content || {};
    return `<section class="brief-continuation" id="brief-update-${esc(update.id)}">
      <header>
        <div><span class="section-index">CONTINUATION / ${esc(briefPublishedTime(update.published_at))} BKK</span><h2>What changed after publication.</h2></div>
        <strong class="brief-thesis brief-thesis--${esc(update.thesis_status)}">THESIS ${esc(String(update.thesis_status || "unchanged").toUpperCase())}</strong>
      </header>
      <p class="brief-continuation__summary">${esc(update.summary || "")}</p>
      <div class="brief-continuation__grid">
        <section><span>01 / MATERIAL CHANGES</span><ul>${briefTextItems(content.changes)}</ul></section>
        <section><span>02 / MARKET IMPACT</span><ul>${briefTextItems(content.portfolio_impact)}</ul></section>
        <section><span>03 / WATCH NEXT</span><ul>${briefTextItems(content.watch_next)}</ul></section>
      </div>
      ${briefArray(content.sources).length ? `<div class="brief-update-sources">${briefArray(content.sources).map(briefSourceLink).join("")}</div>` : ""}
    </section>`;
  }

  function renderNotificationCenter() {
    const panel = $("#notification-panel");
    const badge = $("#notification-badge");
    const button = $("#notification-button");
    if (!panel || !badge || !button) return;
    const unread = state.notifications.filter((notice) => !notice.read_at).length;
    badge.hidden = unread === 0;
    badge.textContent = unread > 9 ? "9+" : String(unread);
    button.setAttribute("aria-expanded", String(state.notificationsOpen));
    panel.hidden = !state.notificationsOpen;
    panel.innerHTML = `<header><div><span>NOTIFICATIONS</span><strong>${unread ? `${unread} unread` : "All caught up"}</strong></div>${unread ? '<button type="button" data-action="notification-read-all">Mark all read</button>' : ""}</header>
      <div class="notification-list">
        ${state.notifications.length ? state.notifications.slice(0, 12).map((notice) => `<button type="button" class="notification-item${notice.read_at ? "" : " is-unread"}" data-action="notification-open" data-notification-id="${esc(notice.id)}" data-entity-id="${esc(notice.entity_id)}">
          <span>${notice.notification_type === "brief_continuation" ? "UPDATE" : "BRIEF"}</span><strong>${esc(notice.title)}</strong><p>${esc(notice.preview)}</p><small>${esc(briefPublishedTime(notice.created_at))} BKK</small>
        </button>`).join("") : '<div class="notification-empty"><strong>No brief notifications yet.</strong><p>Hermes publications will appear here.</p></div>'}
      </div><footer><button type="button" data-route="briefs">Open brief archive</button></footer>`;
  }

  function selectedBrief() {
    return state.briefs.find((brief) => brief.id === state.selectedBriefId) || state.briefs[0] || null;
  }

  function renderBriefs() {
    const brief = selectedBrief();
    if (!state.briefReady) {
      viewRoot.innerHTML = `${pageHead("Hermes · Canonical market intelligence", "Daily Market Brief", "One published view, continued only when the market meaningfully changes.")}<div class="warning-box"><strong>Daily Market Brief is not installed yet.</strong> Run <code>036_daily_market_briefs.sql</code>, then deploy the updated Portfolio Agent API.</div>`;
      return;
    }
    if (state.briefBusy && !brief) {
      viewRoot.innerHTML = `${pageHead("Hermes · Canonical market intelligence", "Daily Market Brief", "One published view, continued only when the market meaningfully changes.")}<div class="brief-empty"><span></span><p>Reading the brief archive…</p></div>`;
      return;
    }
    if (!brief) {
      viewRoot.innerHTML = `${pageHead("Hermes · Canonical market intelligence", "Daily Market Brief", "One published view, continued only when the market meaningfully changes.")}<section class="brief-empty"><span>20:00 BKK</span><h2>The first canonical brief has not been published.</h2><p>Hermes will write the full edition here; Telegram carries only the preview.</p></section>`;
      return;
    }
    const content = brief.content || {};
    const mood = content.market_mood || {};
    const sources = briefArray(content.sources);
    const sourceMap = new Map(sources.map((source) => [String(source.id), source]));
    const updates = briefArray(brief.updates);
    viewRoot.innerHTML = `<div class="brief-shell">
      <aside class="brief-archive" aria-label="Brief archive"><header><span>ARCHIVE / ${state.briefs.length}</span><strong>Daily editions</strong></header><div>${state.briefs.map((item) => `<button type="button" class="${item.id === brief.id ? "is-active" : ""}" data-action="brief-select" data-brief-id="${esc(item.id)}"><span>${esc(briefDateLabel(item.brief_date, { short: true }))}</span><strong>${esc(item.summary)}</strong><small>${briefArray(item.updates).length ? `${briefArray(item.updates).length} continuation` : "Canonical"}</small></button>`).join("")}</div></aside>
      <article class="brief-document">
        <header class="brief-masthead"><div><span>DAILY MARKET BRIEF / ${esc(briefDateLabel(brief.brief_date).toUpperCase())}</span><h1>The market,<br>without the reruns.</h1></div><div class="brief-masthead__meta"><span>PUBLISHED</span><strong>${esc(briefPublishedTime(brief.published_at))} BKK</strong><small>HERMES → SUPABASE</small></div></header>
        <section class="brief-mood brief-mood--${briefTone(mood.tone)}"><span>01 / MARKET MOOD</span><h2>${esc(mood.label || "Market read")}</h2><p>${esc(mood.summary || brief.summary)}</p></section>
        <section class="brief-section brief-snapshot"><header><span>02 / MARKET SNAPSHOT</span><h2>Numbers before narrative.</h2></header><div>${briefArray(content.market_snapshot).map((item) => `<div><span>${esc(item.label || item.name || item.symbol || "MARKET")}</span><strong>${esc(item.value ?? "—")}</strong><small class="brief-change brief-change--${briefTone(String(item.tone || "neutral").toLowerCase())}">${esc(item.change || item.note || "")}</small></div>`).join("")}</div></section>
        <section class="brief-section brief-stories"><header><span>03 / MARKET DRIVERS</span><h2>The forces moving the tape.</h2></header><div>${briefArray(content.top_stories).map((story, index) => briefStoryMarkup(story, index, sourceMap)).join("")}</div></section>
        <section class="brief-section brief-decision-grid"><div><header><span>04 / INVESTMENT IMPLICATIONS</span><h2>What changes for investors.</h2></header><ul>${briefTextItems(content.investment_implications)}</ul></div><div><header><span>05 / WATCH NEXT</span><h2>Events that can change the thesis.</h2></header><ul>${briefTextItems(content.watch_next)}</ul></div></section>
        <section class="brief-bottom-line"><span>06 / DECISION FRAME</span><h2>The setup, the trigger, the risk.</h2><ul>${briefTextItems(content.bottom_line)}</ul></section>
        ${updates.map(briefContinuationMarkup).join("")}
        <section class="brief-sources"><header><span>07 / SOURCES</span><h2>Open the evidence.</h2></header><div>${sources.map(briefSourceLink).join("")}</div></section>
      </article>
    </div>`;
  }

  function renderSmartMoney() {
    const events = smartMoneyVisibleEvents();
    const visibleEvents = events.slice(0, 50);
    const unfiltered = state.smartMoneyEvents.filter((event) => state.watchlist.some((item) => item.instrument_id === event.instrument_id));
    const dayCutoff = Date.now() - 86_400_000;
    const newToday = unfiltered.filter((event) => new Date(event.filed_at || 0).getTime() >= dayCutoff).length;
    const openBuys = unfiltered.filter((event) => event.side === "buy" && String(event.transaction_code).toUpperCase() === "P").length;
    const openSells = unfiltered.filter((event) => event.side === "sell" && String(event.transaction_code).toUpperCase() === "S").length;
    const activeSymbols = new Set(unfiltered.map((event) => event.instrument_id)).size;
    const symbolCounts = [...unfiltered.reduce((map, event) => map.set(event.instrument_id, (map.get(event.instrument_id) || 0) + 1), new Map()).entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 5);
    const instruments = instrumentMap();

    viewRoot.innerHTML = `
      ${pageHead("Watchlist intelligence · SEC Form 4", "Follow the people closest to the company.", "A filing-first tape of insider ownership changes across every name you watch. Transaction codes stay visible so grants, exercises and open-market trades never look the same.", `<span class="smart-status"><i></i>${localPreviewEnabled ? "SAMPLE DATA" : state.smartMoneyReady ? "COLLECTOR READY" : "SETUP REQUIRED"}</span>`) }
      ${!state.smartMoneyReady ? `<div class="warning-box smart-money-setup"><strong>Smart Money schema is not installed yet.</strong> Run <code>014_smart_money.sql</code> in Supabase. The page is ready; live filings begin after the Massive collector is deployed.</div>` : ""}
      <section class="smart-ledger" aria-label="Smart Money summary">
        <div class="smart-ledger__lead"><small>NEW FILINGS / 24H</small><strong>${newToday}</strong><span>Across ${state.watchlist.length} watched symbols</span></div>
        <div><small>OPEN-MARKET BUYS</small><strong class="positive">${openBuys}</strong><span>Transaction code P</span></div>
        <div><small>OPEN-MARKET SALES</small><strong class="negative">${openSells}</strong><span>Transaction code S</span></div>
        <div><small>WATCHLIST NAMES ACTIVE</small><strong>${activeSymbols}</strong><span>Inside the loaded filing window</span></div>
      </section>
      <section class="smart-commandbar" aria-label="Smart Money filters">
        <label><span>SEARCH WATCHLIST OR INSIDER</span><input type="search" data-smart-money-search value="${esc(state.smartMoneySearch)}" placeholder="Ticker, company or reporting owner"></label>
        <div><span>TRANSACTION</span><div class="smart-filter-group">${[["all", "All"], ["buy", "Buys"], ["sell", "Sales"], ["other", "Other"]].map(([value, label]) => `<button type="button" class="${state.smartMoneySide === value ? "is-active" : ""}" data-action="smart-money-side" data-side="${value}">${label}</button>`).join("")}</div></div>
        <div><span>WINDOW</span><div class="smart-filter-group">${[7, 30, 90].map((days) => `<button type="button" class="${state.smartMoneyWindow === days ? "is-active" : ""}" data-action="smart-money-window" data-days="${days}">${days}D</button>`).join("")}</div></div>
      </section>
      <section class="smart-money-layout">
        <div class="smart-feed">
          <div class="section-head smart-feed__head"><div><span class="section-index">01 / OWNERSHIP TAPE</span><h2>Who moved what.</h2></div><p>${events.length > 50 ? `Showing newest 50 of ${events.length}` : `${events.length} matching transactions`} · newest filing first</p></div>
          ${visibleEvents.length ? visibleEvents.map(smartMoneyEventMarkup).join("") : `<div class="smart-empty"><span>FORM 4 / 00</span><h2>No matching filings.</h2><p>${state.smartMoneyReady ? "Try a longer window or clear the filters. New public filings will appear here after the collector runs." : "Install the schema and connect the collector to begin scanning your Watchlist."}</p></div>`}
        </div>
        <aside class="smart-context" aria-label="Smart Money context">
          <div><span class="section-index">02 / SIGNAL HYGIENE</span><h2>Read the code, not just the color.</h2><p>A Form 4 reports ownership changes. It is evidence of an action, not automatically a trading signal.</p></div>
          <dl class="smart-code-list">
            <div><dt>P</dt><dd><strong>Purchase</strong><span>Open-market or private purchase</span></dd></div>
            <div><dt>S</dt><dd><strong>Sale</strong><span>Open-market or private sale</span></dd></div>
            <div><dt>M</dt><dd><strong>Exercise</strong><span>Option conversion, not a fresh buy</span></dd></div>
            <div><dt>A / F</dt><dd><strong>Award / tax</strong><span>Compensation or tax withholding</span></dd></div>
          </dl>
          <div class="smart-active-names"><small>MOST FILINGS IN WATCHLIST</small>${symbolCounts.length ? symbolCounts.map(([id, count]) => `<div><strong>${esc(instruments.get(id)?.symbol || "—")}</strong><span>${count} filing transaction${count === 1 ? "" : "s"}</span></div>`).join("") : `<p>Waiting for the first matched filing.</p>`}</div>
          <p class="smart-disclaimer">Form 4 can be filed after the transaction date. Always compare <strong>traded</strong> with <strong>filed</strong> before interpreting timing.</p>
        </aside>
      </section>`;
  }

  const watchlistChartOptions = {
    "1H": { apiTimespan: "M60", defaultRange: "5D", ranges: { "5D": 50, "10D": 100 } },
    "4H": { apiTimespan: "M240", defaultRange: "1M", ranges: { "1M": 50, "3M": 150 } },
    "1D": { apiTimespan: "D", defaultRange: "6M", ranges: { "1M": 32, "6M": 190, "1Y": 370, "2Y": 760 } }
  };

  function currentWatchlistChartOption() {
    return watchlistChartOptions[state.watchlistTimeframe] || watchlistChartOptions["1D"];
  }

  function watchlistRows() {
    const instruments = instrumentMap();
    const prices = latestPriceMap();
    return state.watchlist.map((item) => ({
      ...item,
      instrument: instruments.get(item.instrument_id),
      price: prices.get(item.instrument_id)
    })).filter((item) => item.instrument);
  }

  function rememberWatchlistInstrument(instrumentId) {
    state.watchlistRecentIds = [instrumentId, ...state.watchlistRecentIds.filter((id) => id !== instrumentId)].slice(0, 6);
  }

  function watchlistVisibleRows(rows) {
    const query = state.watchlistSearch.trim().toLowerCase();
    const matches = query ? rows.filter((item) => [item.instrument.symbol, item.instrument.display_name, item.instrument.asset_type].some((value) => String(value || "").toLowerCase().includes(query))) : rows;
    if (query) return { query, matchCount: matches.length, rows: matches };
    const byId = new Map(rows.map((item) => [item.instrument_id, item]));
    const quickIds = [state.selectedWatchlistInstrumentId, ...state.watchlistRecentIds].filter(Boolean);
    const quickRows = quickIds.map((id) => byId.get(id)).filter(Boolean);
    const ordered = [...quickRows, ...rows].filter((item, index, list) =>
      list.findIndex((candidate) => candidate.instrument_id === item.instrument_id) === index);
    return { query: "", matchCount: rows.length, rows: ordered };
  }

  function watchlistRowsMarkup(rows, selected) {
    const visible = watchlistVisibleRows(rows);
    const label = visible.query ? `${visible.matchCount} match${visible.matchCount === 1 ? "" : "es"}` : "Quick view";
    if (!visible.rows.length) return `<div class="watchlist-list-empty">No ticker matches “${esc(state.watchlistSearch)}”.</div>`;
    return `<div class="watchlist-list-meta"><span>${label}</span><small>${visible.query ? "Scroll matches" : "Recent first · scroll all"}</small></div><div class="watchlist-list">${visible.rows.map((item) => {
      const isSelected = item.instrument_id === selected?.instrument_id;
      return `<div class="watchlist-row ${isSelected ? "is-active" : ""}">
        <button type="button" class="watchlist-row__open" data-action="watchlist-chart" data-instrument-id="${item.instrument_id}">
          ${assetIdentity(item.instrument)}
          <span><strong class="mono">${item.price ? money(item.price.price, 4) : "—"}</strong><small>${item.price?.source === "webull" ? "WEBULL" : "WAITING FOR PRICE"}</small></span>
          <i aria-hidden="true">↗</i>
        </button>
        <button type="button" class="watchlist-row__remove" data-action="watchlist-remove" data-instrument-id="${item.instrument_id}" aria-label="Remove ${esc(item.instrument.symbol)} from watchlist">×</button>
      </div>`;
    }).join("")}</div>`;
  }

  function compactNumber(value) {
    return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(num(value));
  }

  function marketPulseTabs() {
    return `<nav class="research-tabs" aria-label="Watchlist research views">
      <button type="button" class="${state.watchlistView === "charts" ? "is-active" : ""}" data-action="watchlist-view" data-view="charts"><span>01</span>Charts</button>
      <button type="button" class="${state.watchlistView === "market" ? "is-active" : ""}" data-action="watchlist-view" data-view="market"><span>02</span>Market Pulse</button>
    </nav>`;
  }

  function marketPulseValue(row, window = state.marketPulseWindow) {
    const key = { "1D": "change_percent", "1W": "return_1w", "1M": "return_1m", "3M": "return_3m", "YTD": "return_ytd" }[window] || "change_percent";
    const value = Number(row?.[key]);
    return Number.isFinite(value) ? value : null;
  }

  function signedPercent(value, digits = 2) {
    if (!Number.isFinite(Number(value))) return "—";
    const parsed = Number(value);
    return `${parsed > 0 ? "+" : ""}${parsed.toFixed(digits)}%`;
  }

  function marketPulseFreshness(rows = state.marketPulse) {
    const latest = rows.map((row) => new Date(row.fetched_at).getTime()).filter(Number.isFinite);
    if (!latest.length) return "Waiting for first sync";
    const minutes = Math.max(Math.floor((Date.now() - Math.max(...latest)) / 60_000), 0);
    if (minutes < 1) return "Updated just now";
    if (minutes === 1) return "Updated 1 minute ago";
    return `Updated ${minutes} minutes ago`;
  }

  function pulseLeaderRow(row, metric = "change") {
    const change = Number(row.change_percent);
    const tone = change >= 0 ? "positive" : "negative";
    const instrument = instrumentMap().get(row.instrument_id) || row;
    return `<div class="pulse-leader-row">
      ${assetIdentity(instrument)}
      <div><strong class="mono">${money(row.price, Number(row.price) < 10 ? 4 : 2)}</strong><span>${metric === "volume" ? `${compactNumber(row.volume)} volume` : "Webull snapshot"}</span></div>
      <strong class="${tone} mono">${signedPercent(change)}</strong>
    </div>`;
  }

  function renderMarketPulse() {
    const rows = state.marketPulse;
    const watchRows = rows.filter((row) => row.is_watchlist);
    const benchmarks = rows.filter((row) => row.is_benchmark);
    const sectors = rows.filter((row) => row.is_sector)
      .map((row) => ({ ...row, windowValue: marketPulseValue(row) }))
      .sort((a, b) => (b.windowValue ?? -Infinity) - (a.windowValue ?? -Infinity));
    const gainers = [...watchRows].filter((row) => Number(row.change_percent) > 0).sort((a, b) => Number(b.change_percent) - Number(a.change_percent)).slice(0, 5);
    const losers = [...watchRows].filter((row) => Number(row.change_percent) < 0).sort((a, b) => Number(a.change_percent) - Number(b.change_percent)).slice(0, 5);
    const active = [...watchRows].filter((row) => Number(row.volume) > 0).sort((a, b) => Number(b.volume) - Number(a.volume)).slice(0, 5);
    const advancers = watchRows.filter((row) => Number(row.change_percent) > 0).length;
    const decliners = watchRows.filter((row) => Number(row.change_percent) < 0).length;
    const breadth = watchRows.length ? (advancers - decliners) / watchRows.length * 100 : 0;
    const values = sectors.map((row) => Math.abs(row.windowValue || 0));
    const sectorScale = Math.max(...values, 1);

    if (!rows.length) {
      return `<section class="pulse-empty"><span>WEBULL / 00</span><h2>Your market tape is ready to be measured.</h2><p>Refresh once to rank the names in your Watchlist and calculate sector context.</p><button class="button button--primary" type="button" data-action="market-pulse-refresh">Refresh Market Pulse</button></section>`;
    }

    return `
      <section class="pulse-ledger" aria-label="Watchlist market breadth">
        <div class="pulse-ledger__lead"><small>WATCHLIST NAMES</small><strong>${watchRows.length}</strong><span>Only your tracked universe</span></div>
        <div><small>ADVANCING</small><strong class="positive">${advancers}</strong><span>Above previous close</span></div>
        <div><small>DECLINING</small><strong class="negative">${decliners}</strong><span>Below previous close</span></div>
        <div><small>BREADTH</small><strong class="${breadth >= 0 ? "positive" : "negative"}">${signedPercent(breadth, 1)}</strong><span>Advance / decline balance</span></div>
      </section>

      <section class="pulse-section">
        <div class="section-head pulse-section__head"><div><span class="section-index">01 / MARKET PROXIES</span><h2>Context before conviction.</h2></div><p>${esc(marketPulseFreshness(rows))} · ETF proxies, not index levels</p></div>
        <div class="benchmark-tape">${benchmarks.map((row) => `<div class="benchmark-cell">
          <span>${esc(row.symbol)}</span><strong class="mono">${money(row.price, Number(row.price) < 10 ? 4 : 2)}</strong>
          <small class="${Number(row.change_percent) >= 0 ? "positive" : "negative"}">${signedPercent(row.change_percent)}</small>
          <em>${esc(row.display_name || "Market proxy")}</em>
        </div>`).join("")}</div>
      </section>

      <section class="pulse-section">
        <div class="section-head pulse-section__head"><div><span class="section-index">02 / WATCHLIST LEADERS</span><h2>The names moving now.</h2></div><p>Ranked across ${watchRows.length} watched stock${watchRows.length === 1 ? "" : "s"} and ETFs · never the whole market</p></div>
        <div class="pulse-leaders">
          <article><header><span class="positive">↗</span><div><small>UPSIDE</small><h3>Leaders</h3></div></header>${gainers.length ? gainers.map((row) => pulseLeaderRow(row)).join("") : `<p class="pulse-list-empty">No advancing names in the latest snapshot.</p>`}</article>
          <article><header><span class="negative">↘</span><div><small>PRESSURE</small><h3>Decliners</h3></div></header>${losers.length ? losers.map((row) => pulseLeaderRow(row)).join("") : `<p class="pulse-list-empty">No declining names in the latest snapshot.</p>`}</article>
          <article><header><span class="gold">◆</span><div><small>SHARE VOLUME</small><h3>Most active</h3></div></header>${active.length ? active.map((row) => pulseLeaderRow(row, "volume")).join("") : `<p class="pulse-list-empty">Volume is waiting for the next Webull snapshot.</p>`}</article>
        </div>
      </section>

      <section class="pulse-section pulse-sector-section">
        <div class="section-head pulse-section__head"><div><span class="section-index">03 / SECTORS + THEMES</span><h2>Where the tape is leaning.</h2></div>
          <div class="pulse-window" aria-label="Sector performance window">${["1D", "1W", "1M", "3M", "YTD"].map((window) => `<button type="button" class="${state.marketPulseWindow === window ? "is-active" : ""}" data-action="market-pulse-window" data-window="${window}">${window}</button>`).join("")}</div>
        </div>
        <div class="sector-rank">${sectors.map((row, index) => {
          const value = row.windowValue;
          const width = value == null ? 0 : Math.max(Math.abs(value) / sectorScale * 100, 2);
          return `<div class="sector-row ${value == null ? "is-missing" : value >= 0 ? "is-positive" : "is-negative"}">
            <span class="mono">${String(index + 1).padStart(2, "0")}</span>
            <div><strong>${esc(row.sector_name || row.display_name)}</strong><small>${esc(row.symbol)}</small></div>
            <div class="sector-track"><i style="--sector-width:${width}%"></i><b></b></div>
            <strong class="mono">${signedPercent(value)}</strong>
          </div>`;
        }).join("")}</div>
        <p class="pulse-method">${sectors.length} sector, theme and asset-proxy ETFs ranked from Webull daily bars. Government-bond ETFs are excluded.</p>
      </section>`;
  }

  function previewMarketPulseRows() {
    const now = new Date().toISOString();
    const fixed = [
      ["SPY", "S&P 500 proxy", 638.42, .58, 78300000, true, true, "S&P 500"],
      ["QQQ", "Nasdaq-100 proxy", 571.16, .94, 62100000, true, false, null],
      ["DIA", "Dow Jones proxy", 452.31, -.22, 5200000, true, false, null],
      ["IWM", "Russell 2000 proxy", 231.08, 1.17, 34800000, true, false, null],
      ["GLD", "Gold proxy", 301.44, -.41, 9100000, true, true, "Gold"],
      ["XLK", "Technology", 268.41, 1.18, 8800000, false, true, "Technology"],
      ["XLC", "Communication Services", 112.08, .63, 4600000, false, true, "Communication Services"],
      ["XLY", "Consumer Discretionary", 228.13, .37, 5100000, false, true, "Consumer Discretionary"],
      ["XLP", "Consumer Staples", 84.92, -.18, 7200000, false, true, "Consumer Staples"],
      ["XLE", "Energy", 91.57, -.82, 17600000, false, true, "Energy"],
      ["XLF", "Financials", 52.24, .21, 29800000, false, true, "Financials"],
      ["XLV", "Health Care", 146.91, -.32, 9400000, false, true, "Health Care"],
      ["XLI", "Industrials", 151.74, .54, 6900000, false, true, "Industrials"],
      ["XLB", "Materials", 94.18, -.66, 4300000, false, true, "Materials"],
      ["XLRE", "Real Estate", 42.87, -.27, 3900000, false, true, "Real Estate"],
      ["XLU", "Utilities", 79.36, -.73, 11900000, false, true, "Utilities"],
      ["XBI", "Biotech", 102.42, .74, 7800000, false, true, "Biotech"],
      ["NLR", "Nuclear Energy", 126.18, 1.34, 1200000, false, true, "Nuclear Energy"],
      ["SMH", "Semiconductors", 314.76, 1.92, 6900000, false, true, "Semiconductors"],
      ["TAN", "Solar Energy", 42.31, -1.18, 3400000, false, true, "Solar Energy"],
      ["IBIT", "Bitcoin", 71.84, 2.16, 21800000, false, true, "Bitcoin"],
      ["IGV", "Software", 111.27, .81, 1800000, false, true, "Software"],
      ["BUG", "Cybersecurity", 35.92, .56, 640000, false, true, "Cybersecurity"]
    ].map(([symbol, display_name, price, change_percent, volume, is_benchmark, is_sector, sector_name], index) => ({
      symbol, display_name, price, change_percent, volume, is_benchmark, is_sector, sector_name,
      asset_type: "etf", is_watchlist: false, return_1w: num(change_percent) * (1.4 + index % 3),
      return_1m: num(change_percent) * (2.1 + index % 4), return_3m: num(change_percent) * (3.2 + index % 5),
      return_ytd: num(change_percent) * (5.4 + index % 6), fetched_at: now
    }));
    const instruments = instrumentMap();
    const watched = state.watchlist.map((item, index) => {
      const instrument = instruments.get(item.instrument_id);
      const price = 24 + (index + 1) * 47.36;
      const change = [3.42, -2.18, 1.07, -4.12, .68][index % 5];
      return {
        symbol: instrument?.symbol || `WATCH${index + 1}`, display_name: instrument?.display_name || "Watched name",
        instrument_id: item.instrument_id, asset_type: instrument?.asset_type || "stock", is_watchlist: true,
        is_benchmark: false, is_sector: false, price, change_percent: change, volume: 1800000 + index * 7400000,
        fetched_at: now
      };
    });
    return [...fixed, ...watched];
  }

  function movingAverage(bars, period) {
    let sum = 0;
    return bars.map((bar, index) => {
      sum += num(bar.close);
      if (index >= period) sum -= num(bars[index - period].close);
      return index >= period - 1 ? sum / period : null;
    });
  }

  function drawWatchlistChart() {
    const container = $("#watchlist-chart");
    if (!container || !state.watchlistBars.length) return;
    destroyWatchlistChart();
    container.replaceChildren();

    const charts = window.LightweightCharts;
    if (!charts?.createChart) {
      container.innerHTML = '<p class="chart-load-error">Interactive chart library could not be loaded.</p>';
      return;
    }

    // Daily bars can share a date; intraday bars must retain their complete timestamp.
    // Using an epoch timestamp also gives Lightweight Charts an unambiguous UTC timeline.
    const bars = [...new Map(state.watchlistBars.map((bar) => {
      const stamp = new Date(bar.time).getTime();
      return [Number.isFinite(stamp) ? Math.floor(stamp / 1000) : String(bar.time), bar];
    })).entries()]
      .map(([time, bar]) => ({
        time,
        open: num(bar.open),
        high: num(bar.high),
        low: num(bar.low),
        close: num(bar.close),
        volume: num(bar.volume)
      }))
      .sort((a, b) => Number(a.time) - Number(b.time));

    watchlistChart = charts.createChart(container, {
      autoSize: true,
      layout: {
        background: { type: charts.ColorType.Solid, color: "#0b0b0b" },
        textColor: "#77746d",
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 10,
        attributionLogo: true
      },
      grid: {
        vertLines: { color: "rgba(245,245,245,.055)" },
        horzLines: { color: "rgba(245,245,245,.075)" }
      },
      rightPriceScale: {
        borderColor: "rgba(245,245,245,.16)",
        scaleMargins: { top: .07, bottom: .24 }
      },
      timeScale: {
        borderColor: "rgba(245,245,245,.16)",
        rightOffset: 4,
        barSpacing: 8,
        minBarSpacing: 2,
        timeVisible: state.watchlistTimeframe !== "1D",
        secondsVisible: false
      },
      crosshair: {
        mode: charts.CrosshairMode.Normal,
        vertLine: { color: "rgba(212,175,55,.55)", width: 1, labelBackgroundColor: "#a50000" },
        horzLine: { color: "rgba(212,175,55,.38)", width: 1, labelBackgroundColor: "#a50000" }
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false
      },
      handleScale: {
        axisPressedMouseMove: { time: true, price: true },
        mouseWheel: true,
        pinch: true
      },
      kineticScroll: { mouse: true, touch: true }
    });

    const candleSeries = watchlistChart.addSeries(charts.CandlestickSeries, {
      upColor: "#2b9e70",
      downColor: "#d32323",
      wickUpColor: "#55b98d",
      wickDownColor: "#ed3b3b",
      borderVisible: false,
      priceLineColor: "#d4af37",
      priceLineWidth: 1,
      lastValueVisible: true
    });
    candleSeries.setData(bars.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));

    const volumeSeries = watchlistChart.addSeries(charts.HistogramSeries, {
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false
    });
    volumeSeries.setData(bars.map((bar) => ({
      time: bar.time,
      value: bar.volume,
      color: bar.close >= bar.open ? "rgba(43,158,112,.44)" : "rgba(211,35,35,.42)"
    })));
    watchlistChart.priceScale("volume").applyOptions({ visible: false, scaleMargins: { top: .82, bottom: 0 } });

    [[20, "#d4af37", 2], [50, "#f5f5f5", 1], [200, "#a50000", 1]].forEach(([period, color, lineWidth]) => {
      const series = watchlistChart.addSeries(charts.LineSeries, {
        color,
        lineWidth,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false
      });
      const values = movingAverage(bars, period);
      series.setData(values.flatMap((value, index) => value == null ? [] : [{ time: bars[index].time, value }]));
    });

    watchlistChart.timeScale().fitContent();
  }

  function renderWatchlist() {
    const chartRenderId = ++watchlistChartRenderId;
    destroyWatchlistChart();
    if (state.watchlistView === "market") {
      viewRoot.innerHTML = `
        ${pageHead(
          "Watchlist intelligence · Webull snapshots",
          "Read the tape you chose.",
          "Movers are ranked only across your Watchlist. Sector ETFs provide context and never alter your portfolios.",
          `<button class="button" type="button" data-action="market-pulse-refresh" ${state.marketPulseBusy ? "disabled" : ""}>${state.marketPulseBusy ? "Refreshing…" : "Refresh pulse"}</button>`
        )}
        ${marketPulseTabs()}
        ${!state.marketPulseReady ? `<div class="warning-box watchlist-setup"><strong>One setup step remains.</strong> Run <code>015_market_pulse.sql</code> in Supabase, then refresh this page.</div>` : ""}
        ${state.marketPulseBusy && !state.marketPulse.length ? `<div class="pulse-loading"><span></span><p>Measuring your Watchlist through Webull…</p></div>` : renderMarketPulse()}`;
      return;
    }
    const chartOption = currentWatchlistChartOption();
    const timeframe = state.watchlistTimeframe;
    const rows = watchlistRows();
    const selected = rows.find((item) => item.instrument_id === state.selectedWatchlistInstrumentId) || rows[0] || null;
    const bars = state.watchlistBars;
    const first = bars[0];
    const last = bars[bars.length - 1];
    const displayPrice = num(state.watchlistLivePrice?.price) || num(last?.close) || num(selected?.price?.price);
    const rangeChange = first && last ? num(last.close) - num(first.close) : 0;
    const rangeChangePercent = first && num(first.close) ? rangeChange / num(first.close) * 100 : 0;
    const dailyChange = bars.length > 1 ? num(last?.close) - num(bars[bars.length - 2]?.close) : 0;
    const dailyChangePercent = bars.length > 1 && num(bars[bars.length - 2]?.close) ? dailyChange / num(bars[bars.length - 2]?.close) * 100 : 0;

    viewRoot.innerHTML = `
      ${pageHead("Webull market data · Stocks and ETFs", "Watch the names that matter.", "A separate research list. Nothing here changes portfolio cash, positions or allocation.", `<button class="button button--primary" type="button" data-action="watchlist-add">+ Add ticker</button>`)}
      ${marketPulseTabs()}
      ${!state.watchlistReady ? `<div class="warning-box watchlist-setup"><strong>One setup step remains.</strong> Run <code>011_watchlist.sql</code> in Supabase, then refresh this page.</div>` : ""}
      <section class="watchlist-workbench" aria-label="Watchlist and Webull chart">
        <aside class="watchlist-rail">
          <div class="watchlist-rail__head"><div><span class="section-index">01 / WATCHLIST</span><h2>Your market tape.</h2></div><span class="meta">${rows.length} symbols</span></div>
          ${rows.length ? `<label class="watchlist-search"><span>Search all ${rows.length} symbols</span><input type="search" autocomplete="off" data-watchlist-search placeholder="Ticker or company" value="${esc(state.watchlistSearch)}"></label><div id="watchlist-list-region">${watchlistRowsMarkup(rows, selected)}</div>` : `<div class="empty-state"><div><strong>Your watchlist is empty</strong>Add a US stock or ETF to open its Webull chart here.</div></div>`}
        </aside>
        <article class="market-chart-panel">
          ${selected ? `<header class="market-chart-head">
            <div><span class="section-index">02 / WEBULL ${timeframe} BARS</span><h2>${esc(selected.instrument.symbol)}</h2><p>${esc(selected.instrument.display_name || selected.instrument.asset_type)}</p></div>
            <div class="market-chart-quote"><strong>${displayPrice ? money(displayPrice, 4) : "—"}</strong><span class="${dailyChange >= 0 ? "positive" : "negative"}">${dailyChange > 0 ? "+" : ""}${dailyChange.toFixed(2)} · ${dailyChange > 0 ? "+" : ""}${dailyChangePercent.toFixed(2)}%</span></div>
          </header>
          <div class="market-chart-toolbar">
            <div class="chart-switches">
              <div class="range-switch" aria-label="Chart timeframe">${Object.keys(watchlistChartOptions).map((frame) => `<button type="button" class="${frame === timeframe ? "is-active" : ""}" data-action="watchlist-timeframe" data-timeframe="${frame}">${frame}</button>`).join("")}</div>
              <div class="range-switch range-switch--range" aria-label="Chart range">${Object.keys(chartOption.ranges).map((range) => `<button type="button" class="${range === state.watchlistRange ? "is-active" : ""}" data-action="watchlist-range" data-range="${range}">${range}</button>`).join("")}</div>
            </div>
            <div class="chart-toolbar-meta"><span class="chart-interaction-hint">Wheel/pinch to zoom · Drag to move</span><div class="chart-legend"><span class="ma20">MA20</span><span class="ma50">MA50</span><span class="ma200">MA200</span></div></div>
          </div>
          ${state.watchlistChartBusy ? `<div class="watchlist-chart-state"><span></span><p>Reading ${esc(selected.instrument.symbol)} ${timeframe} bars from Webull…</p></div>` : bars.length ? `<div id="watchlist-chart" role="img" tabindex="0" aria-label="${esc(selected.instrument.symbol)} interactive ${timeframe} candlestick chart with volume and moving averages"></div>` : `<div class="watchlist-chart-state"><p>Select a range to load Webull bars.</p></div>`}
          <footer class="market-chart-foot">
            <div><small>${state.watchlistRange} MOVE</small><strong class="${rangeChange >= 0 ? "positive" : "negative"}">${rangeChange > 0 ? "+" : ""}${rangeChangePercent.toFixed(2)}%</strong></div>
            <div><small>LATEST VOLUME</small><strong>${last ? compactNumber(last.volume) : "—"}</strong></div>
            <div><small>DATA SOURCE</small><strong>WEBULL · ${timeframe}</strong></div>
            <button class="button button--small button--remove" type="button" data-action="watchlist-remove" data-instrument-id="${selected.instrument_id}">Remove</button>
          </footer>` : `<div class="market-chart-empty"><span>WEBULL / 00</span><h2>Add a ticker to begin.</h2><p>The chart is independent from your four portfolios and excludes options.</p></div>`}
        </article>
      </section>`;
    requestAnimationFrame(() => {
      if (chartRenderId !== watchlistChartRenderId) return;
      if (state.route !== "watchlist" || state.watchlistView !== "charts") return;
      drawWatchlistChart();
    });
  }

  function previewBars(symbol, count, timeframe = state.watchlistTimeframe) {
    let seed = [...symbol].reduce((sum, char) => sum + char.charCodeAt(0), 0) || 100;
    let close = 80 + seed % 170;
    const rows = [];
    for (let index = count - 1; index >= 0; index -= 1) {
      seed = (seed * 9301 + 49297) % 233280;
      const change = (seed / 233280 - .47) * close * .035;
      const open = close;
      close = Math.max(open + change, 2);
      const date = new Date();
      if (timeframe === "1H") date.setUTCHours(date.getUTCHours() - index);
      else if (timeframe === "4H") date.setUTCHours(date.getUTCHours() - index * 4);
      else date.setUTCDate(date.getUTCDate() - index);
      rows.push({ time: date.toISOString(), open, close, high: Math.max(open, close) * 1.012, low: Math.min(open, close) * .988, volume: 800000 + seed * 70 });
    }
    return rows;
  }

  async function loadWatchlistBars(instrumentId = state.selectedWatchlistInstrumentId, range = state.watchlistRange, timeframe = state.watchlistTimeframe) {
    if (!instrumentId) return;
    const requestId = ++watchlistBarsRequestId;
    state.selectedWatchlistInstrumentId = instrumentId;
    rememberWatchlistInstrument(instrumentId);
    state.watchlistTimeframe = watchlistChartOptions[timeframe] ? timeframe : "1D";
    const chartOption = currentWatchlistChartOption();
    state.watchlistRange = chartOption.ranges[range] ? range : chartOption.defaultRange;
    const requestedTimeframe = state.watchlistTimeframe;
    const requestedRange = state.watchlistRange;
    state.watchlistChartBusy = true;
    state.watchlistBars = [];
    state.watchlistLivePrice = null;
    renderWatchlist();
    try {
      let nextBars = [];
      let nextLivePrice = null;
      if (localPreviewEnabled) {
        const symbol = instrumentMap().get(instrumentId)?.symbol || "DEMO";
        nextBars = previewBars(symbol, chartOption.ranges[requestedRange], requestedTimeframe);
      } else {
        const { data, error } = await db.functions.invoke("refresh-stock-prices", {
          body: { action: "chart", instrument_id: instrumentId, timespan: chartOption.apiTimespan, count: chartOption.ranges[requestedRange] }
        });
        if (error) {
          let detail = error.message;
          try { detail = (await error.context?.clone?.().json())?.error || detail; } catch (_) { /* Optional response body. */ }
          throw new Error(detail);
        }
        if (data?.error) throw new Error(data.error);
        nextBars = Array.isArray(data?.bars) ? data.bars : [];
        nextLivePrice = num(data?.live_price) > 0
          ? { price: num(data.live_price), marketTime: data.live_market_time || null }
          : null;
        if (!nextBars.length) {
          const responsePreview = data == null ? "empty response" : JSON.stringify(data).slice(0, 500);
          throw new Error(`Webull returned no chart bars · ${responsePreview}`);
        }
      }
      if (requestId !== watchlistBarsRequestId) return;
      state.watchlistBars = nextBars;
      state.watchlistLivePrice = nextLivePrice;
    } catch (error) {
      if (requestId === watchlistBarsRequestId) toast(`Webull chart: ${friendlyError(error)}`, true);
    } finally {
      if (requestId !== watchlistBarsRequestId) return;
      state.watchlistChartBusy = false;
      const requestIsCurrent = state.selectedWatchlistInstrumentId === instrumentId
        && state.watchlistTimeframe === requestedTimeframe
        && state.watchlistRange === requestedRange;
      if (state.route === "watchlist" && state.watchlistView === "charts" && requestIsCurrent) renderWatchlist();
    }
  }

  function openWatchlistDialog() {
    if (!state.watchlistReady) {
      toast("Run 011_watchlist.sql in Supabase first", true);
      return;
    }
    openDialog({
      kicker: "Watchlist · Webull market data", title: "Add a ticker to watch", submitLabel: "Add to watchlist",
      body: `<div class="field-row"><label class="field"><span>Ticker symbol</span><input name="symbol" maxlength="20" placeholder="AAPL" required></label><label class="field"><span>Display name (optional)</span><input name="display_name" maxlength="160" placeholder="Apple Inc."></label></div><label class="field"><span>Asset type</span><select name="asset_type"><option value="stock">Stock</option><option value="etf">ETF</option></select></label><label class="field"><span>Research note (optional)</span><textarea name="notes" maxlength="500" placeholder="What are you watching for?"></textarea></label><p class="form-hint">Watchlist items are separate from portfolio holdings. Options are intentionally excluded from Webull chart sync.</p>`,
      onSubmit: async (form) => {
        const instrumentId = await rpc("api_upsert_instrument", {
          p_asset_type: form.get("asset_type"), p_symbol: String(form.get("symbol")).toUpperCase().trim(),
          p_display_name: form.get("display_name") || null, p_exchange: null, p_currency: "USD",
          p_option_type: null, p_strike: null, p_expiry: null, p_multiplier: 1
        });
        await rpc("api_add_watchlist_item", { p_instrument_id: instrumentId, p_notes: form.get("notes") || null });
        closeDialog();
        await loadData({ quiet: true });
        state.selectedWatchlistInstrumentId = instrumentId;
        await refreshStockPrices({ force: true });
        await refreshMarketPulse();
        toast(`${String(form.get("symbol")).toUpperCase()} added to watchlist`);
        await loadWatchlistBars(instrumentId, state.watchlistRange);
      }
    });
  }

  function openRemoveWatchlistDialog(instrumentId) {
    const instrument = instrumentMap().get(instrumentId);
    openDialog({
      kicker: "Watchlist · Research only", title: `Remove ${instrument?.symbol || "ticker"}?`, submitLabel: "Remove", danger: true,
      body: `<div class="warning-box">This only removes the ticker from Watchlist. Portfolio positions, allocation plans, trades and journal history stay unchanged.</div>`,
      onSubmit: async () => {
        await rpc("api_remove_watchlist_item", { p_instrument_id: instrumentId });
        closeDialog(); state.watchlistBars = []; toast(`${instrument?.symbol || "Ticker"} removed from watchlist`); await loadData({ quiet: true });
        await refreshMarketPulse();
        if (state.selectedWatchlistInstrumentId) await loadWatchlistBars();
      }
    });
  }

  function journalEntries() {
    return state.journal.filter((item) => !item.is_void && (state.journalFilter === "all" || item.portfolio_id === state.journalFilter));
  }

  function journalStats(entries) {
    const wins = entries.filter((item) => num(item.manual_pnl) > 0);
    const losses = entries.filter((item) => num(item.manual_pnl) < 0);
    const grossWin = wins.reduce((sum, item) => sum + num(item.manual_pnl), 0);
    const grossLoss = Math.abs(losses.reduce((sum, item) => sum + num(item.manual_pnl), 0));
    return {
      pnl: entries.reduce((sum, item) => sum + num(item.manual_pnl), 0),
      winRate: entries.length ? wins.length / entries.length * 100 : 0,
      profitFactor: grossLoss ? grossWin / grossLoss : grossWin ? 99.99 : 0,
      avgWin: wins.length ? grossWin / wins.length : 0,
      avgLoss: losses.length ? -grossLoss / losses.length : 0
    };
  }

  function renderJournal() {
    const entries = journalEntries();
    const stats = journalStats(entries);
    const instruments = instrumentMap();
    const year = new Date().getFullYear();
    const months = Array.from({ length: 12 }, (_, month) => {
      const prefix = `${year}-${String(month + 1).padStart(2, "0")}`;
      const rows = entries.filter((item) => item.occurred_on?.startsWith(prefix));
      return { month, pnl: rows.reduce((sum, item) => sum + num(item.manual_pnl), 0), count: rows.length };
    });
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    viewRoot.innerHTML = `
      ${pageHead("Trading journal · Closed-trade performance", "P/L without the spreadsheet drift.", "Journal entries measure realized performance by portfolio. They do not edit cash, holdings or broker records.", '<button class="button button--primary" type="button" data-action="journal-add">+ Add P/L entry</button>')}
      <div class="toolbar"><div class="toolbar__filters"><select id="journal-filter" aria-label="Filter journal by portfolio"><option value="all">All portfolios</option>${state.portfolios.map((p) => `<option value="${p.id}" ${state.journalFilter === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div><span class="meta">${entries.length} active entries</span></div>
      <section class="kpi-strip" aria-label="Trading performance">
        <div class="kpi"><small>Net P/L</small><strong class="${stats.pnl > 0 ? "positive" : stats.pnl < 0 ? "negative" : ""}">${money(stats.pnl)}</strong></div>
        <div class="kpi"><small>Win rate</small><strong>${percent(stats.winRate, 0)}</strong></div>
        <div class="kpi"><small>Profit factor</small><strong>${stats.profitFactor ? stats.profitFactor.toFixed(2) : "—"}</strong></div>
        <div class="kpi"><small>Avg win / loss</small><strong>${compactMoney(stats.avgWin)} / ${compactMoney(stats.avgLoss)}</strong></div>
      </section>
      <section class="section journal-layout">
        <div>
          <div class="section-head"><div><span class="section-index">01 / EQUITY CURVE</span><h2>Cumulative closed P/L.</h2></div></div>
          <div class="chart-panel">${entries.length ? '<canvas id="equity-chart" role="img" aria-label="Cumulative profit and loss curve"></canvas>' : '<div class="empty-state"><div><strong>No P/L data yet</strong>Add a journal entry to start the curve.</div></div>'}</div>
        </div>
        <div>
          <div class="section-head"><div><span class="section-index">02 / ${year}</span><h2>Monthly tape.</h2></div></div>
          <div class="month-grid">${months.map((item) => `<div class="month-cell"><small>${monthNames[item.month]} · ${item.count}t</small><strong class="${item.pnl > 0 ? "positive" : item.pnl < 0 ? "negative" : ""}">${item.count ? money(item.pnl) : "—"}</strong></div>`).join("")}</div>
        </div>
      </section>
      <section class="section">
        <div class="section-head"><div><span class="section-index">03 / JOURNAL LEDGER</span><h2>Trade outcomes and notes.</h2></div><p>Voided entries stay in Supabase audit history and disappear from performance totals.</p></div>
        ${entries.length ? `<div class="table-shell"><table><thead><tr><th>Date</th><th>Portfolio</th><th>Asset / strategy</th><th>Outcome</th><th>P/L</th><th>Notes</th><th>Actions</th></tr></thead><tbody>${entries.map((entry) => {
          const portfolio = state.portfolios.find((item) => item.id === entry.portfolio_id);
          const instrument = instruments.get(entry.instrument_id);
          return `<tr><td class="mono">${esc(entry.occurred_on)}</td><td>${esc(portfolio?.name || "—")}</td><td><span class="cell-main">${esc(instrument?.symbol || entry.strategy_label || "Trade")}</span><span class="cell-sub">${esc(entry.strategy_label || "Manual entry")}</span></td><td><span class="status status--${entry.outcome === "win" ? "good" : entry.outcome === "loss" ? "risk" : "warn"}">${esc(entry.outcome)}</span></td><td><strong class="mono ${num(entry.manual_pnl) >= 0 ? "positive" : "negative"}">${money(entry.manual_pnl)}</strong></td><td><span title="${esc(entry.notes || "")}">${esc((entry.notes || "—").slice(0, 48))}${(entry.notes || "").length > 48 ? "…" : ""}</span></td><td><div class="row-actions"><button class="button button--small" type="button" data-action="journal-edit" data-entry-id="${entry.id}">Edit</button><button class="button button--small" type="button" data-action="journal-void" data-entry-id="${entry.id}">Void</button></div></td></tr>`;
        }).join("")}</tbody></table></div>` : `<div class="empty-state"><div><strong>No journal entries in this view</strong>Choose another portfolio or record a closed trade.</div></div>`}
      </section>`;
    $("#journal-filter")?.addEventListener("change", (event) => {
      state.journalFilter = event.target.value;
      renderJournal();
    });
    requestAnimationFrame(() => drawEquityCurve(entries));
  }

  function drawEquityCurve(entries) {
    const canvas = $("#equity-chart");
    if (!canvas || !entries.length) return;
    const sorted = [...entries].sort((a, b) => a.occurred_on.localeCompare(b.occurred_on) || a.created_at.localeCompare(b.created_at));
    const points = [0];
    sorted.forEach((entry) => points.push(points.at(-1) + num(entry.manual_pnl)));
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(rect.width, 280), height = 220, ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio; canvas.height = height * ratio;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    ctx.scale(ratio, ratio);
    const min = Math.min(...points, 0), max = Math.max(...points, 0), range = max - min || 1;
    const pad = { top: 18, right: 12, bottom: 28, left: 12 };
    const x = (index) => pad.left + index / Math.max(points.length - 1, 1) * (width - pad.left - pad.right);
    const y = (value) => pad.top + (max - value) / range * (height - pad.top - pad.bottom);
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = "rgba(245, 245, 245, .12)"; ctx.lineWidth = 1; ctx.setLineDash([4, 5]);
    ctx.beginPath(); ctx.moveTo(pad.left, y(0)); ctx.lineTo(width - pad.right, y(0)); ctx.stroke(); ctx.setLineDash([]);
    const final = points.at(-1), line = final >= 0 ? "#55b98d" : "#d32323";
    const gradient = ctx.createLinearGradient(0, pad.top, 0, height - pad.bottom);
    gradient.addColorStop(0, final >= 0 ? "rgba(215,170,75,.22)" : "rgba(255,102,91,.16)");
    gradient.addColorStop(1, "rgba(8,7,6,0)");
    ctx.beginPath(); ctx.moveTo(x(0), y(points[0]));
    points.slice(1).forEach((value, index) => ctx.lineTo(x(index + 1), y(value)));
    ctx.lineTo(x(points.length - 1), height - pad.bottom); ctx.lineTo(x(0), height - pad.bottom); ctx.closePath();
    ctx.fillStyle = gradient; ctx.fill();
    ctx.beginPath(); ctx.moveTo(x(0), y(points[0]));
    points.slice(1).forEach((value, index) => ctx.lineTo(x(index + 1), y(value)));
    ctx.strokeStyle = line; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = line; ctx.beginPath(); ctx.arc(x(points.length - 1), y(final), 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#6e655b"; ctx.font = "10px JetBrains Mono";
    ctx.textAlign = "left"; ctx.fillText(money(min, 0), pad.left, height - 6);
    ctx.textAlign = "right"; ctx.fillText(money(max, 0), width - pad.right, 11);
  }

  function renderJournalPaged() {
    const entries = state.journal;
    const stats = state.journalSummary || emptyJournalView().summary;
    const performanceCount = num(stats.performance_count);
    const winRate = performanceCount ? num(stats.win_count) / performanceCount * 100 : 0;
    const profitFactor = num(stats.gross_loss) ? num(stats.gross_win) / num(stats.gross_loss) : num(stats.gross_win) ? Infinity : 0;
    const year = new Date().getFullYear();
    const monthly = new Map(state.journalMonthly.map((item) => [String(item.month).slice(0, 7), item]));
    const months = Array.from({ length: 12 }, (_, month) => {
      const key = `${year}-${String(month + 1).padStart(2, "0")}`;
      const item = monthly.get(key);
      return { month, pnl: num(item?.pnl), count: num(item?.count) };
    });
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const pages = Math.max(Math.ceil(state.journalTotal / state.journalPageSize), 1);
    const start = state.journalTotal ? (state.journalPage - 1) * state.journalPageSize + 1 : 0;
    const end = Math.min(state.journalPage * state.journalPageSize, state.journalTotal);
    viewRoot.innerHTML = `
      ${pageHead("Trading journal · Closed-trade performance", "P/L without the spreadsheet drift.", "Journal entries measure realized performance by portfolio. They do not edit cash, holdings or broker records.", '<button class="button button--primary" type="button" data-action="journal-add">+ Add P/L entry</button>')}
      <div class="journal-commandbar">
        <label class="journal-primary-filter"><span>Portfolio</span><select id="journal-filter-primary" aria-label="Filter journal by portfolio"><option value="all">All portfolios</option>${state.portfolios.map((p) => `<option value="${p.id}" ${state.journalFilter === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
        <span class="journal-commandbar__count">${state.journalTotal.toLocaleString()} active ${state.journalTotal === 1 ? "entry" : "entries"}</span>
      </div>
      <section class="kpi-strip" aria-label="Trading performance">
        <div class="kpi"><small>Net P/L</small><strong class="${num(stats.net_pnl) > 0 ? "positive" : num(stats.net_pnl) < 0 ? "negative" : ""}">${money(stats.net_pnl)}</strong></div>
        <div class="kpi"><small>Win rate</small><strong>${percent(winRate, 0)}</strong></div>
        <div class="kpi"><small>Profit factor</small><strong>${profitFactor === Infinity ? "∞" : profitFactor ? profitFactor.toFixed(2) : "—"}</strong></div>
        <div class="kpi"><small>Avg win / loss</small><strong>${compactMoney(stats.avg_win)} / ${compactMoney(stats.avg_loss)}</strong></div>
      </section>
      <section class="section journal-layout">
        <div>
          <div class="section-head"><div><span class="section-index">01 / EQUITY CURVE</span><h2>Cumulative closed P/L.</h2></div></div>
          <div class="chart-panel">${state.journalDaily.length ? '<canvas id="equity-chart" role="img" aria-label="Cumulative profit and loss curve"></canvas>' : '<div class="empty-state"><div><strong>No P/L data in this view</strong>Choose another portfolio or add a journal entry.</div></div>'}</div>
        </div>
        <div>
          <div class="section-head"><div><span class="section-index">02 / ${year}</span><h2>Monthly tape.</h2></div></div>
          <div class="month-grid">${months.map((item) => `<div class="month-cell"><small>${monthNames[item.month]} · ${item.count}t</small><strong class="${item.pnl > 0 ? "positive" : item.pnl < 0 ? "negative" : ""}">${item.count ? money(item.pnl) : "—"}</strong></div>`).join("")}</div>
        </div>
      </section>
      <section class="section">
        <div class="section-head"><div><span class="section-index">03 / JOURNAL LEDGER</span><h2>Trade outcomes and notes.</h2></div><p>Voided entries stay in Supabase audit history and disappear from performance totals.</p></div>
        ${state.journalBusy ? `<div class="journal-loading" role="status"><span></span>Reading this page from Supabase…</div>` : entries.length ? `<div class="table-shell"><table><thead><tr><th>Date</th><th>Portfolio</th><th>Asset / strategy</th><th>Outcome</th><th>P/L</th><th>Notes</th><th>Actions</th></tr></thead><tbody>${entries.map((entry) => {
          const portfolio = state.portfolios.find((item) => item.id === entry.portfolio_id);
          return `<tr><td class="mono">${esc(entry.occurred_on)}</td><td>${esc(portfolio?.name || "—")}</td><td><span class="cell-main">${esc(entry.symbol || entry.strategy_label || "Trade")}</span><span class="cell-sub">${esc(entry.strategy_label || "Manual entry")}</span></td><td><span class="status status--${entry.outcome === "win" ? "good" : entry.outcome === "loss" ? "risk" : "warn"}">${esc(entry.outcome)}</span></td><td><strong class="mono ${num(entry.manual_pnl) >= 0 ? "positive" : "negative"}">${money(entry.manual_pnl)}</strong></td><td><span title="${esc(entry.notes || "")}">${esc((entry.notes || "—").slice(0, 48))}${(entry.notes || "").length > 48 ? "…" : ""}</span></td><td><div class="row-actions"><button class="button button--small" type="button" data-action="journal-edit" data-entry-id="${entry.id}">Edit</button><button class="button button--small" type="button" data-action="journal-void" data-entry-id="${entry.id}">Void</button></div></td></tr>`;
        }).join("")}</tbody></table></div><div class="pagination"><span>${start.toLocaleString()}–${end.toLocaleString()} of ${state.journalTotal.toLocaleString()}</span><div><button class="button button--small" type="button" data-action="journal-page-prev" ${state.journalPage <= 1 ? "disabled" : ""}>← Prev</button> <span class="pagination__page">Page ${state.journalPage} / ${pages}</span> <button class="button button--small" type="button" data-action="journal-page-next" ${state.journalPage >= pages ? "disabled" : ""}>Next →</button></div></div>` : `<div class="empty-state"><div><strong>No journal entries in this view</strong>Choose another portfolio or record a closed trade.</div></div>`}
      </section>`;
    $("#journal-filter-primary")?.addEventListener("change", async (event) => {
      state.journalFilter = event.target.value;
      state.journalPage = 1;
      await loadJournalPage();
    });
    if (!state.journalBusy) requestAnimationFrame(() => drawEquityCurvePaged(state.journalDaily));
  }

  function drawEquityCurvePaged(dailyRows) {
    const canvas = $("#equity-chart");
    if (!canvas || !dailyRows.length) return;
    const sorted = [...dailyRows].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const points = [0];
    sorted.forEach((item) => points.push(points.at(-1) + num(item.pnl)));
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(rect.width, 280), height = 220, ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio; canvas.height = height * ratio;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    ctx.scale(ratio, ratio);
    const min = Math.min(...points, 0), max = Math.max(...points, 0), range = max - min || 1;
    const pad = { top: 18, right: 12, bottom: 28, left: 12 };
    const x = (index) => pad.left + index / Math.max(points.length - 1, 1) * (width - pad.left - pad.right);
    const y = (value) => pad.top + (max - value) / range * (height - pad.top - pad.bottom);
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = "rgba(245, 245, 245, .12)"; ctx.lineWidth = 1; ctx.setLineDash([4, 5]);
    ctx.beginPath(); ctx.moveTo(pad.left, y(0)); ctx.lineTo(width - pad.right, y(0)); ctx.stroke(); ctx.setLineDash([]);
    const final = points.at(-1), line = final >= 0 ? "#55b98d" : "#d32323";
    const gradient = ctx.createLinearGradient(0, pad.top, 0, height - pad.bottom);
    gradient.addColorStop(0, final >= 0 ? "rgba(215,170,75,.22)" : "rgba(255,102,91,.16)");
    gradient.addColorStop(1, "rgba(8,7,6,0)");
    ctx.beginPath(); ctx.moveTo(x(0), y(points[0]));
    points.slice(1).forEach((value, index) => ctx.lineTo(x(index + 1), y(value)));
    ctx.lineTo(x(points.length - 1), height - pad.bottom); ctx.lineTo(x(0), height - pad.bottom); ctx.closePath();
    ctx.fillStyle = gradient; ctx.fill();
    ctx.beginPath(); ctx.moveTo(x(0), y(points[0]));
    points.slice(1).forEach((value, index) => ctx.lineTo(x(index + 1), y(value)));
    ctx.strokeStyle = line; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = line; ctx.beginPath(); ctx.arc(x(points.length - 1), y(final), 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#6e655b"; ctx.font = "10px JetBrains Mono";
    ctx.textAlign = "left"; ctx.fillText(money(min, 0), pad.left, height - 6);
    ctx.textAlign = "right"; ctx.fillText(money(max, 0), width - pad.right, 11);
  }

  function renderError(error) {
    viewRoot.innerHTML = `${pageHead("Connection issue", "The ledger could not be read.", friendlyError(error), '<button class="button button--primary" type="button" data-action="refresh">Try again</button>')}<div class="warning-box">No local financial copy was used. Fix the Supabase issue and refresh safely.</div>`;
  }

  function openDialog({ kicker = "Dashboard action", title, body, submitLabel = "Save", onSubmit, danger = false, cancelLabel = "Cancel", wide = false, variant = "" }) {
    dialog.classList.toggle("dialog--wide", wide);
    dialog.classList.toggle("dialog--history", variant === "history");
    $("#dialog-kicker").textContent = kicker;
    $("#dialog-title").textContent = title;
    $("#dialog-body").innerHTML = body;
    $("#dialog-error").textContent = "";
    $("#dialog-actions").innerHTML = `<button class="button button--ghost" type="button" data-action="close-dialog">${esc(cancelLabel)}</button>${onSubmit ? `<button class="button ${danger ? "button--danger" : "button--primary"}" type="submit">${esc(submitLabel)}</button>` : ""}`;
    dialogSubmit = onSubmit || null;
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => $("input:not([type=hidden]), select, textarea", $("#dialog-body"))?.focus());
  }

  function closeDialog() {
    dialogSubmit = null;
    dialog.classList.remove("dialog--wide", "dialog--history");
    if (dialog.open) dialog.close();
  }

  async function rpc(name, args) {
    const { data, error } = await db.rpc(name, args);
    if (error) throw error;
    return data;
  }

  function openCreatePortfolioDialog() {
    openDialog({
      kicker: "Portfolio workspace · New ledger",
      title: "Create a portfolio",
      submitLabel: "Create portfolio",
      body: `<div class="field-row"><label class="field"><span>Portfolio name</span><input name="name" maxlength="80" placeholder="Income, Momentum, Retirement…" required></label><label class="field"><span>Broker</span><select name="broker"><option value="webull">Webull · weighted average</option><option value="dime">Dime · FIFO</option></select></label></div><label class="field"><span>Fixed budget (USD)</span><input name="budget" type="number" min="0" step="0.01" value="0" required></label><div class="warning-box">One portfolio can hold stocks, ETFs and long options. Stocks and ETFs allocate by market value; options allocate by maximum loss. The broker method locks after the first transaction.</div>`,
      onSubmit: async (form) => {
        const created = await rpc("api_create_portfolio", {
          p_name: form.get("name"),
          p_portfolio_mode: "mixed",
          p_fixed_budget: num(form.get("budget")),
          p_broker_profile: form.get("broker")
        });
        closeDialog();
        await loadData({ quiet: true });
        if (created?.id) state.selectedPortfolioId = created.id;
        state.route = "portfolio";
        render();
        toast("Portfolio created · add its opening cash when ready");
      }
    });
  }

  function portfolioManagerMarkup() {
    return `<div class="portfolio-manager">${state.portfolios.map((portfolio, index) => {
      const stats = portfolioStats(portfolio);
      const mode = portfolioMode(portfolio);
      return `<article class="portfolio-manager__row">
        <div class="portfolio-manager__index">${String(index + 1).padStart(2, "0")}</div>
        <div class="portfolio-manager__identity"><strong>${esc(portfolio.name)}</strong><span>${mode === "mixed" ? "Stocks / ETFs / options" : "Legacy portfolio"} · ${brokerProfile(portfolio).toUpperCase()}</span></div>
        <div class="portfolio-manager__metric"><small>Total capital</small><strong>${money(stats.capital)}</strong></div>
        <div class="portfolio-manager__metric"><small>Open positions</small><strong>${stats.positions.length}</strong></div>
        <div class="row-actions"><button class="button button--small" type="button" data-action="portfolio-broker" data-portfolio-manage-id="${portfolio.id}">Broker</button><button class="button button--small" type="button" data-action="portfolio-rename" data-portfolio-manage-id="${portfolio.id}">Rename</button><button class="button button--small button--remove" type="button" data-action="portfolio-archive" data-portfolio-manage-id="${portfolio.id}">Archive</button></div>
      </article>`;
    }).join("")}</div><p class="form-hint">Archive preserves trade, journal and audit history. A portfolio must have no open positions, pending drafts or remaining cash first.</p>`;
  }

  function openPortfolioManagerDialog() {
    openDialog({
      kicker: "Portfolio workspace · Active ledgers",
      title: "Manage portfolios",
      cancelLabel: "Done",
      wide: true,
      body: portfolioManagerMarkup()
    });
  }

  function openRenamePortfolioDialog(portfolioId) {
    const portfolio = state.portfolios.find((item) => item.id === portfolioId);
    if (!portfolio) return;
    openDialog({
      kicker: `${portfolio.name} · Audited setting`,
      title: "Rename portfolio",
      submitLabel: "Save name",
      body: `<label class="field"><span>Portfolio name</span><input name="name" maxlength="80" value="${esc(portfolio.name)}" required></label><p class="form-hint">Only the display name changes. Cash, positions, targets and history stay attached to the same portfolio ID.</p>`,
      onSubmit: async (form) => {
        await rpc("api_rename_portfolio", { p_portfolio_id: portfolio.id, p_name: form.get("name") });
        closeDialog();
        await loadData({ quiet: true });
        openPortfolioManagerDialog();
        toast("Portfolio renamed");
      }
    });
  }

  function openPortfolioBrokerDialog(portfolioId) {
    const portfolio = state.portfolios.find((item) => item.id === portfolioId);
    if (!portfolio) return;
    const hasTransactions = state.executions.some((item) => item.portfolio_id === portfolio.id);
    openDialog({
      kicker: `${portfolio.name} · Cost method`,
      title: "Broker profile",
      submitLabel: "Save broker",
      body: `<label class="field"><span>Broker</span><select name="broker" ${hasTransactions ? "disabled" : ""}><option value="webull" ${brokerProfile(portfolio) === "webull" ? "selected" : ""}>Webull · weighted average · buy fees in cost</option><option value="dime" ${brokerProfile(portfolio) === "dime" ? "selected" : ""}>Dime · FIFO · cost display excludes buy fees</option></select></label><div class="warning-box">${hasTransactions ? "This portfolio already has transactions, so its broker profile is locked to preserve cost basis and realized P/L." : "The selected broker profile becomes permanent after the first transaction."}</div>`,
      onSubmit: async (form) => {
        if (hasTransactions) { closeDialog(); return; }
        await rpc("api_set_portfolio_broker", { p_portfolio_id: portfolio.id, p_broker_profile: form.get("broker") });
        closeDialog();
        await loadData({ quiet: true });
        openPortfolioManagerDialog();
        toast("Broker profile updated");
      }
    });
  }

  function openArchivePortfolioDialog(portfolioId) {
    const portfolio = state.portfolios.find((item) => item.id === portfolioId);
    if (!portfolio) return;
    const stats = portfolioStats(portfolio);
    openDialog({
      kicker: `${portfolio.name} · Safe archive`,
      title: `Archive ${portfolio.name}?`,
      submitLabel: "Archive portfolio",
      danger: true,
      body: `<div class="preview-grid"><div class="preview-cell"><small>Open positions</small><strong>${stats.positions.length}</strong></div><div class="preview-cell"><small>Cash remaining</small><strong>${money(stats.cash)}</strong></div></div><div class="warning-box">Archiving hides this portfolio from active dashboards but preserves every confirmed trade, P/L entry and audit record. The server will refuse while positions, pending drafts or cash remain.</div>`,
      onSubmit: async () => {
        await rpc("api_archive_portfolio", { p_portfolio_id: portfolio.id });
        closeDialog();
        await loadData({ quiet: true });
        state.route = "overview";
        render();
        toast(`${portfolio.name} archived`);
      }
    });
  }

  function openBudgetDialog() {
    const portfolio = currentPortfolio();
    openDialog({
      kicker: `${portfolio.name} · Audited setting`, title: "Change fixed budget", submitLabel: "Update budget",
      body: `<div class="field-row"><label class="field"><span>New fixed budget (USD)</span><input name="budget" type="number" min="0" step="0.01" value="${num(portfolio.fixed_budget)}" required></label><label class="field"><span>Current budget</span><input value="${money(portfolio.fixed_budget)}" disabled></label></div><label class="field"><span>Reason for change</span><textarea name="reason" maxlength="500" placeholder="Why is this fixed capital limit changing?" required></textarea></label><div class="warning-box">Deposits and withdrawals do not change this budget. Every edit is written to portfolio_budget_history and audit_log.</div>`,
      onSubmit: async (form) => {
        await rpc("api_change_fixed_budget", { p_portfolio_id: portfolio.id, p_new_budget: num(form.get("budget")), p_reason: form.get("reason") });
        closeDialog(); toast("Fixed budget updated"); await loadData({ quiet: true });
      }
    });
  }

  function previewCells(preview) {
    const labels = {
      movement_type: "Movement", amount: "Amount", cash_before: "Cash before", cash_effect: "Cash effect", cash_after: "Cash after",
      side: "Side", quantity: "Quantity", price: "Price", gross_amount: "Gross amount", fee: "Fees",
      deployed_before: "Deployed before", deployed_after: "Deployed after", allocation_limit_percent: "Allocation limit", notional_after: "Notional after"
    };
    const moneyKeys = new Set(["amount", "cash_before", "cash_effect", "cash_after", "price", "gross_amount", "fee", "deployed_before", "deployed_after", "notional_after"]);
    return Object.entries(preview).filter(([key, value]) => labels[key] && value != null).map(([key, value]) => `<div class="preview-cell"><small>${labels[key]}</small><strong>${moneyKeys.has(key) ? money(value, key === "price" ? 4 : 2) : key.includes("percent") ? percent(value) : esc(value)}</strong></div>`).join("");
  }

  function openDraftConfirmation(kind, draft, confirmFn) {
    const warningCode = draft.preview?.warning;
    const warningText = draft.clientWarning || (warningCode === "OVER_ALLOCATION_TARGET"
      ? "This trade is above the allocation target. It is allowed as a tactical overweight; trim guidance will appear in the portfolio after confirmation."
      : warningCode === "NO_ALLOCATION_TARGET"
        ? "This ticker has no active allocation target."
        : warningCode ? warningCode.replaceAll("_", " ") : "");
    openDialog({
      kicker: "Draft ready · Expires in 15 minutes", title: `Confirm ${kind}`, submitLabel: "Confirm and post",
      body: `<div class="preview-grid">${previewCells(draft.preview || {})}</div>${warningText ? `<div class="warning-box warning-box--allocation">${esc(warningText)}</div>` : ""}<p class="form-hint">The server will recalculate these values and apply the change atomically after confirmation.</p>`,
      onSubmit: async () => {
        await confirmFn(draft.draft_id, draft.confirmation_token);
        closeDialog(); toast(`${kind} confirmed`); await loadData({ quiet: true });
      }
    });
  }

  function openCashDialog() {
    const portfolio = currentPortfolio();
    openDialog({
      kicker: `${portfolio.name} · Draft → Confirm`, title: "Record cash movement", submitLabel: "Preview movement",
      body: `<div class="field-row"><label class="field"><span>Movement</span><select name="type"><option value="deposit">Deposit</option><option value="withdrawal">Withdrawal</option><option value="initial_funding">Initial funding</option><option value="dividend">Dividend</option><option value="interest">Interest</option><option value="tax">Tax</option></select></label><label class="field"><span>Amount (USD)</span><input name="amount" type="number" min="0.01" step="0.01" required></label></div><label class="field"><span>Date and time</span><input name="occurred" type="datetime-local" value="${localDateTime()}" required></label><label class="field"><span>Notes</span><textarea name="notes" maxlength="2000" placeholder="Broker transfer, funding source, or context"></textarea></label><p class="form-hint">Cash moves only inside ${esc(portfolio.name)} and never changes its fixed budget.</p>`,
      onSubmit: async (form) => {
        const draft = await rpc("api_create_cash_draft", {
          p_portfolio_id: portfolio.id, p_movement_type: form.get("type"), p_amount: num(form.get("amount")),
          p_idempotency_key: uid("web-cash"), p_occurred_at: new Date(form.get("occurred")).toISOString(), p_notes: form.get("notes") || null
        });
        openDraftConfirmation("cash movement", draft, (id, token) => rpc("api_confirm_cash_draft", { p_draft_id: id, p_confirmation_token: token }));
      }
    });
  }

  function optionFields() {
    return `<div id="option-fields"><div class="field-row field-row--3"><label class="field"><span>Option type</span><select name="option_type"><option value="call">Call</option><option value="put">Put</option></select></label><label class="field"><span>Strike</span><input name="strike" type="number" min="0" step="0.01" required></label><label class="field"><span>Expiry</span><input name="expiry" type="date" required></label></div><label class="field"><span>Multiplier</span><input name="multiplier" type="number" min="1" step="1" value="100" required></label></div>`;
  }

  function openAssetDialog() {
    const portfolio = currentPortfolio();
    openDialog({
      kicker: `${portfolio.name} · 100% plan`, title: "Add a ticker to the plan", submitLabel: "Add to plan",
      body: `<div class="field-row"><label class="field"><span>Ticker / underlying symbol</span><input name="symbol" maxlength="20" placeholder="NVDA" required></label><label class="field"><span>Display name</span><input name="display_name" maxlength="160" placeholder="NVIDIA Corporation"></label></div>
        <label class="field"><span>Asset type</span><select name="asset_type"><option value="stock">Stock</option><option value="etf">ETF</option><option value="option">Long option</option></select></label><div data-option-fields hidden>${optionFields()}</div>
        <div class="field-row"><label class="field"><span>Target % of this portfolio</span><input name="target" type="number" min="0.01" max="100" step="0.01" required></label><label class="field"><span>Split into how many buys?</span><input name="tranches" type="number" min="1" max="20" step="1" value="3" required></label></div>
        <label class="field"><span>Notes (optional)</span><input name="notes" maxlength="500" placeholder="Why this ticker belongs in the plan"></label>
        <p class="form-hint">This only creates a plan. Use Buy after an order has filled; cash and average cost will update from that transaction.</p>`,
      onSubmit: async (form) => {
        const assetType = form.get("asset_type");
        const instrumentId = await rpc("api_upsert_instrument", {
          p_asset_type: assetType, p_symbol: String(form.get("symbol")).toUpperCase().trim(), p_display_name: form.get("display_name") || null,
          p_exchange: null, p_currency: "USD", p_option_type: assetType === "option" ? form.get("option_type") : null,
          p_strike: assetType === "option" ? num(form.get("strike")) : null, p_expiry: assetType === "option" ? form.get("expiry") : null,
          p_multiplier: assetType === "option" ? num(form.get("multiplier")) : 1
        });
        await rpc("api_set_allocation_target", {
          p_portfolio_id: portfolio.id, p_instrument_id: instrumentId, p_target_percent: num(form.get("target")),
          p_maximum_percent: null,
          p_planned_tranches: form.get("tranches") === "" ? null : num(form.get("tranches")), p_notes: form.get("notes") || null
        });
        closeDialog(); toast("Ticker added to the plan"); await loadData({ quiet: true });
      }
    });
    const body = $("#dialog-body");
    const assetType = $('[name="asset_type"]', body);
    const optionFieldsNode = $("[data-option-fields]", body);
    const syncOptionFields = () => {
      const isOption = assetType.value === "option";
      optionFieldsNode.hidden = !isOption;
      $$("input, select", optionFieldsNode).forEach((input) => { input.disabled = !isOption; });
    };
    assetType.addEventListener("change", syncOptionFields);
    syncOptionFields();
  }

  function openTargetDialog(instrumentId) {
    const portfolio = currentPortfolio();
    const instrument = instrumentMap().get(instrumentId);
    const target = state.targets.find((item) => item.portfolio_id === portfolio.id && item.instrument_id === instrumentId);
    openDialog({
      kicker: `${portfolio.name} · ${instrument?.symbol || "Asset"}`, title: "Edit buying plan", submitLabel: "Update plan",
      body: `<div class="field-row"><label class="field"><span>Target %</span><input name="target" type="number" min="0" max="100" step="0.01" value="${num(target?.target_percent)}" required></label><label class="field"><span>Planned buys</span><input name="tranches" type="number" min="1" max="20" step="1" value="${target?.planned_tranches ?? 3}" required></label></div><label class="field"><span>Plan notes</span><textarea name="notes" maxlength="2000">${esc(target?.notes || "")}</textarea></label><p class="form-hint">Ticker targets should total 100%. Anything unallocated stays as cash automatically.</p>`,
      onSubmit: async (form) => {
        await rpc("api_set_allocation_target", { p_portfolio_id: portfolio.id, p_instrument_id: instrumentId, p_target_percent: num(form.get("target")), p_maximum_percent: null, p_planned_tranches: num(form.get("tranches")), p_notes: form.get("notes") || null });
        closeDialog(); toast("Buying plan updated"); await loadData({ quiet: true });
      }
    });
  }

  function openPriceDialog(instrumentId) {
    const instrument = instrumentMap().get(instrumentId);
    const latest = latestPriceMap().get(instrumentId);
    openDialog({
      kicker: `${instrument?.symbol || "Asset"} · Manual market data`, title: "Record current price", submitLabel: "Save price",
      body: `<div class="field-row"><label class="field"><span>Price (USD)</span><input name="price" type="number" min="0" step="0.0001" value="${latest?.price ?? ""}" required></label><label class="field"><span>Market time</span><input name="market_time" type="datetime-local" value="${localDateTime()}" required></label></div><p class="form-hint">Price history is append-only. The newest record is used for market-value display.</p>`,
      onSubmit: async (form) => {
        await rpc("api_record_instrument_price", { p_instrument_id: instrumentId, p_price: num(form.get("price")), p_market_time: new Date(form.get("market_time")).toISOString(), p_source: "manual" });
        closeDialog(); toast("Current price recorded"); await loadData({ quiet: true });
      }
    });
  }

  function openRemoveAssetDialog(instrumentId) {
    const portfolio = currentPortfolio();
    const instrument = instrumentMap().get(instrumentId);
    const position = state.positions.find((item) => item.portfolio_id === portfolio.id && item.instrument_id === instrumentId);
    if (num(position?.quantity) > 0) {
      toast(`Sell the remaining ${num(position.quantity).toLocaleString("en-US", { maximumFractionDigits: 8 })} share(s) before removing ${instrument?.symbol || "this asset"}`, true);
      return;
    }
    openDialog({
      kicker: `${portfolio.name} · Safe removal`, title: `Remove ${instrument?.symbol || "asset"} from this portfolio?`, submitLabel: "Remove from portfolio", danger: true,
      body: `<div class="warning-box">This removes the ticker from the active allocation plan. Trade history, journal entries and audit data remain in Supabase, and you can add the ticker again later.</div>`,
      onSubmit: async () => {
        await rpc("api_remove_asset_from_portfolio", { p_portfolio_id: portfolio.id, p_instrument_id: instrumentId });
        closeDialog(); toast(`${instrument?.symbol || "Asset"} removed from ${portfolio.name}`); await loadData({ quiet: true });
      }
    });
  }

  function portfolioInstrumentOptions(portfolio, positionsOnly = false) {
    const ids = new Set(portfolioRows(portfolio).filter((row) => !positionsOnly || num(row.position?.quantity) > 0).map((row) => row.id));
    return state.instruments.filter((item) => ids.has(item.id)).map((item) => `<option value="${item.id}">${esc(item.symbol)} · ${esc(item.display_name || item.asset_type)}</option>`).join("");
  }

  function openBuySimulator(instrumentId) {
    const portfolio = currentPortfolio();
    const row = portfolioRows(portfolio).find((item) => item.id === instrumentId);
    if (!row || !["stock", "etf"].includes(row.instrument.asset_type)) {
      toast("Buy simulator is available for stocks and ETFs", true);
      return;
    }
    const stats = portfolioStats(portfolio);
    const market = latestPriceMap().get(instrumentId);
    const defaultPrice = num(market?.price) || num(row.position?.average_cost);
    const trancheCount = Math.max(num(row.target?.planned_tranches) || 3, 1);
    const trancheAmount = row.quota > 0 ? row.quota / trancheCount : stats.cash / 3;
    const targetRoom = Math.max(row.quota - row.deployed, 0);
    const scenarios = [
      { label: "1 tranche", amount: trancheAmount },
      { label: "2 tranches", amount: trancheAmount * 2 },
      { label: "To target", amount: targetRoom },
      { label: "Custom", amount: Math.min(Math.max(trancheAmount, 0), Math.max(stats.cash, 0)) }
    ];
    openDialog({
      kicker: `${portfolio.name} · No data is saved`,
      title: `Plan a ${row.instrument.symbol} buy`,
      cancelLabel: "Close",
      wide: true,
      body: `<div class="buy-simulator" data-buy-simulator data-instrument-id="${row.id}">
        <div class="buy-simulator__position">
          <div><small>Current position</small><strong>${formatTradeQuantity(row.position?.quantity)} shares</strong></div>
          <div><small>Average cost</small><strong>${num(row.position?.quantity) > 0 ? money(row.position?.average_cost, 4) : "No position"}</strong></div>
          <div><small>Market value</small><strong>${money(row.deployed)}</strong></div>
          <div><small>Allocation</small><strong>${percent(row.currentPercent, 2)} <span>/ ${percent(row.targetPercent)} target</span></strong></div>
          <div><small>Cash available</small><strong class="gold">${money(stats.cash)}</strong></div>
        </div>
        <div class="buy-simulator__controls">
          <label class="field"><span>Planned buy price</span><input data-sim-price type="number" min="0.0001" step="0.0001" value="${defaultPrice || ""}" placeholder="Enter a planned price"></label>
          <label class="field"><span>Estimated fee</span><input data-sim-fee type="number" min="0" step="0.01" value="0"></label>
          <div class="buy-simulator__quote"><span>${market ? instrumentPriceFreshness(market) : "No Webull price · using average cost"}</span><small>The planned price stays editable.</small></div>
        </div>
        <div class="buy-simulator__table" role="table" aria-label="Forward average scenarios">
          <div class="buy-simulator__header" role="row"><span>Scenario / amount</span><span>Shares added</span><span>New average</span><span>Allocation after</span><span>Cash after</span><span></span></div>
          ${scenarios.map((scenario) => `<div class="buy-simulator__row" role="row" data-sim-row>
            <label><span>${scenario.label}</span><div class="money-input"><i>$</i><input data-sim-amount type="number" min="0" step="0.01" value="${num(scenario.amount).toFixed(2)}"></div></label>
            <div data-sim-shares>—</div>
            <div data-sim-average>—</div>
            <div class="buy-simulator__allocation"><strong data-sim-allocation>—</strong><div class="allocation-track"><i></i></div><small data-sim-status>Enter a price</small></div>
            <div data-sim-cash>—</div>
            <button class="button button--small button--primary" type="button" data-sim-use>Use in Buy</button>
          </div>`).join("")}
        </div>
        <p class="form-hint">Simulation only. Amount means stock value before fees. Nothing changes in Supabase until the normal Review → Confirm flow is completed.</p>
      </div>`
    });
    const body = $("#dialog-body");
    const priceInput = $("[data-sim-price]", body);
    const feeInput = $("[data-sim-fee]", body);
    const scenarioRows = $$("[data-sim-row]", body);
    const renderScenario = (scenarioRow) => {
      const amount = num($("[data-sim-amount]", scenarioRow)?.value);
      const projection = buyProjection(portfolio, row, amount, num(priceInput?.value), num(feeInput?.value));
      $("[data-sim-shares]", scenarioRow).textContent = projection.isValid ? `+${formatTradeQuantity(projection.addedShares)}` : "—";
      $("[data-sim-average]", scenarioRow).textContent = projection.isValid ? money(projection.averageAfter, 4) : "—";
      $("[data-sim-allocation]", scenarioRow).textContent = projection.isValid ? percent(projection.allocationAfter, 2) : "—";
      $("[data-sim-cash]", scenarioRow).textContent = projection.isValid ? money(projection.cashAfter) : "—";
      const track = $(".allocation-track", scenarioRow);
      track.className = `allocation-track is-${projection.tone} ${projection.isOver ? "is-over" : ""}`;
      track.style.setProperty("--current", `${clamp(projection.targetProgress, 0, 100)}%`);
      const status = $("[data-sim-status]", scenarioRow);
      status.textContent = !projection.isValid
        ? "Enter an amount and price"
        : !projection.hasCash
          ? `Cash short ${money(Math.abs(projection.cashAfter))}`
          : projection.isOver
            ? `${money(projection.overage)} over target`
            : `${money(projection.roomAfter)} room left`;
      scenarioRow.classList.toggle("is-over", projection.isOver);
      scenarioRow.classList.toggle("is-cash-short", !projection.hasCash);
      const useButton = $("[data-sim-use]", scenarioRow);
      useButton.disabled = !projection.isValid || !projection.hasCash;
      useButton.onclick = () => openTradeDialog("buy", {
        instrumentId: row.id,
        quantity: projection.addedShares,
        price: projection.price,
        fee: projection.fee
      });
    };
    const renderAll = () => scenarioRows.forEach(renderScenario);
    priceInput?.addEventListener("input", renderAll);
    feeInput?.addEventListener("input", renderAll);
    scenarioRows.forEach((scenarioRow) => $("[data-sim-amount]", scenarioRow)?.addEventListener("input", () => renderScenario(scenarioRow)));
    renderAll();
  }

  function openTradeDialog(sidePreset = "buy", prefills = null) {
    const portfolio = currentPortfolio();
    const options = portfolioInstrumentOptions(portfolio, sidePreset === "sell");
    if (!options) {
      toast(sidePreset === "sell" ? "There is no open position to sell" : "Add a ticker to the plan first", true);
      if (sidePreset === "buy") openAssetDialog();
      return;
    }
    openDialog({
      kicker: `${portfolio.name} · Saved to Supabase`, title: `Record a ${sidePreset}`, submitLabel: `Review ${sidePreset}`,
      body: `<p class="form-hint">Enter the completed broker transaction. This app records it but never places an order.</p><label class="field"><span>Asset</span><select name="instrument">${options}</select></label><input name="side" type="hidden" value="${sidePreset}"><div class="field-row"><label class="field"><span>Quantity</span><div class="trade-quantity-control"><input name="quantity" type="number" min="0.00000001" step="0.00000001" required>${sidePreset === "sell" ? '<button class="button button--primary button--sell-all" type="button" data-trade-sell-all>Sell all</button>' : ""}</div></label><label class="field"><span>Price per share</span><input name="price" type="number" min="0" step="0.0001" required></label></div><div class="field-row field-row--3"><label class="field"><span>Fee</span><input name="fee" type="number" min="0" step="any" inputmode="decimal" value="0"></label><label class="field"><span>Buy tranche #</span><input name="tranche" type="number" min="1" max="20" step="1" ${sidePreset === "sell" ? "disabled" : ""}></label><label class="field" data-underlying-field hidden><span>Underlying price</span><input name="underlying_price" type="number" min="0" step="0.01" disabled></label></div><div class="trade-projection" data-trade-projection></div><label class="field"><span>Date and time</span><input name="executed" type="datetime-local" value="${localDateTime()}" required></label>`,
      onSubmit: async (form) => {
        const instrumentId = form.get("instrument");
        const draft = await rpc("api_create_trade_draft", {
          p_portfolio_id: portfolio.id, p_instrument_id: instrumentId, p_side: form.get("side"),
          p_quantity: num(form.get("quantity")), p_price: num(form.get("price")), p_idempotency_key: uid("web-trade"),
          p_fee: num(form.get("fee")), p_executed_at: new Date(form.get("executed")).toISOString(),
          p_tranche_number: form.get("tranche") ? num(form.get("tranche")) : null,
          p_underlying_price: isOptionInstrument(instrumentId) && form.get("underlying_price") !== "" ? num(form.get("underlying_price")) : null, p_campaign_id: null
        });
        if (form.get("side") === "buy") {
          const row = portfolioRows(portfolio).find((item) => item.id === instrumentId);
          const deployedAfter = num(draft.preview?.deployed_after);
          if (row?.target && deployedAfter > row.quota + .005) {
            const newPercent = portfolioStats(portfolio).capital > 0 ? deployedAfter / portfolioStats(portfolio).capital * 100 : 0;
            draft.clientWarning = `${row.instrument.symbol} will be ${percent(newPercent)} of this portfolio, ${money(deployedAfter - row.quota)} above its ${percent(row.targetPercent)} target. This tactical overweight is allowed.`;
          }
        }
        openDraftConfirmation("trade fill", draft, (id, token) => rpc("api_confirm_trade_draft", { p_draft_id: id, p_confirmation_token: token }));
      }
    });
    const tradeBody = $("#dialog-body");
    const instrumentSelect = $('[name="instrument"]', tradeBody);
    const quantityInput = $('[name="quantity"]', tradeBody);
    const priceInput = $('[name="price"]', tradeBody);
    const feeInput = $('[name="fee"]', tradeBody);
    if (prefills?.instrumentId && [...instrumentSelect.options].some((option) => option.value === prefills.instrumentId)) instrumentSelect.value = prefills.instrumentId;
    if (prefills?.quantity) quantityInput.value = Number(prefills.quantity.toFixed(8));
    if (prefills?.price) priceInput.value = Number(prefills.price.toFixed(4));
    if (prefills?.fee != null) feeInput.value = num(prefills.fee);
    const projectionRegion = $("[data-trade-projection]", tradeBody);
    const underlyingField = $("[data-underlying-field]", tradeBody);
    const underlyingInput = $('[name="underlying_price"]', tradeBody);
    const renderTradeProjection = () => {
      const row = portfolioRows(portfolio).find((item) => item.id === instrumentSelect.value);
      const isOption = isOptionInstrument(instrumentSelect.value);
      underlyingField.hidden = !isOption;
      underlyingInput.disabled = !isOption;
      if (sidePreset !== "buy" || !row || isOption) { projectionRegion.innerHTML = ""; return; }
      const amount = num(quantityInput.value) * num(priceInput.value);
      projectionRegion.innerHTML = buyProjectionSummary(
        buyProjection(portfolio, row, amount, num(priceInput.value), num(feeInput.value)),
        row
      );
    };
    instrumentSelect.addEventListener("change", renderTradeProjection);
    if (sidePreset === "buy") {
      quantityInput.addEventListener("input", renderTradeProjection);
      priceInput.addEventListener("input", renderTradeProjection);
      feeInput.addEventListener("input", renderTradeProjection);
      renderTradeProjection();
    }
    if (sidePreset === "sell") {
      const body = tradeBody;
      const sellAllButton = $("[data-trade-sell-all]", body);
      const syncSellAll = () => {
        const position = state.positions.find((item) => item.portfolio_id === portfolio.id && item.instrument_id === instrumentSelect.value);
        const available = num(position?.quantity);
        sellAllButton.disabled = available <= 0;
        sellAllButton.textContent = "Sell all";
      };
      instrumentSelect.addEventListener("change", syncSellAll);
      sellAllButton.addEventListener("click", () => {
        const position = state.positions.find((item) => item.portfolio_id === portfolio.id && item.instrument_id === instrumentSelect.value);
        quantityInput.value = num(position?.quantity) || "";
        quantityInput.dispatchEvent(new Event("input", { bubbles: true }));
        $('[name="price"]', body)?.focus();
      });
      syncSellAll();
    }
  }

  function openJournalDialog(entry = null) {
    const portfolioId = entry?.portfolio_id || (state.route === "portfolio" ? currentPortfolio()?.id : state.journalFilter !== "all" ? state.journalFilter : state.portfolios[0]?.id);
    const instruments = state.instruments.filter((instrument) => state.positions.some((position) => position.instrument_id === instrument.id));
    openDialog({
      kicker: entry ? "Journal · Audited edit" : "Journal · Manual P/L", title: entry ? "Edit P/L entry" : "Add closed-trade P/L", submitLabel: entry ? "Update entry" : "Save entry",
      body: `<div class="field-row"><label class="field"><span>Portfolio</span><select name="portfolio" ${entry ? "disabled" : ""}>${state.portfolios.map((p) => `<option value="${p.id}" ${(entry?.portfolio_id || portfolioId) === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label><label class="field"><span>Date</span><input name="date" type="date" value="${entry?.occurred_on || today()}" required></label></div><div class="field-row"><label class="field"><span>P/L amount (USD)</span><input name="pnl" type="number" step="0.01" value="${entry?.manual_pnl ?? ""}" placeholder="Use minus for a loss" required></label><label class="field"><span>Asset (optional)</span><select name="instrument"><option value="">No linked asset</option>${instruments.map((item) => `<option value="${item.id}" ${entry?.instrument_id === item.id ? "selected" : ""}>${esc(item.symbol)} · ${esc(item.display_name || item.asset_type)}</option>`).join("")}</select></label></div><label class="field"><span>Strategy / setup</span><input name="strategy" maxlength="120" value="${esc(entry?.strategy_label || "")}" placeholder="Breakout, earnings, mean reversion…"></label><label class="field"><span>Notes</span><textarea name="notes" maxlength="4000" placeholder="What happened, what worked, what changes next time">${esc(entry?.notes || "")}</textarea></label><p class="form-hint">Positive amount = win · Negative amount = loss · Zero = breakeven. P/L entries never change cash or holdings.</p>`,
      onSubmit: async (form) => {
        const args = { p_occurred_on: form.get("date"), p_manual_pnl: num(form.get("pnl")), p_strategy_label: form.get("strategy") || null, p_notes: form.get("notes") || null, p_instrument_id: form.get("instrument") || null };
        if (entry) await rpc("api_update_journal_entry", { p_entry_id: entry.id, ...args });
        else await rpc("api_create_journal_entry", { p_portfolio_id: form.get("portfolio"), ...args });
        closeDialog(); toast(entry ? "Journal entry updated" : "P/L entry recorded"); await loadData({ quiet: true });
      }
    });
  }

  function openVoidJournalDialog(entry) {
    openDialog({
      kicker: "Journal · Audit-safe removal", title: "Void this P/L entry?", submitLabel: "Void entry", danger: true,
      body: `<div class="preview-grid"><div class="preview-cell"><small>Date</small><strong>${esc(entry.occurred_on)}</strong></div><div class="preview-cell"><small>P/L</small><strong class="${num(entry.manual_pnl) >= 0 ? "positive" : "negative"}">${money(entry.manual_pnl)}</strong></div></div><label class="field"><span>Reason</span><textarea name="reason" maxlength="500" required placeholder="Duplicate, wrong portfolio, data correction…"></textarea></label><div class="warning-box">This removes the entry from performance totals but preserves it and the reason in Supabase audit history.</div>`,
      onSubmit: async (form) => {
        await rpc("api_void_journal_entry", { p_entry_id: entry.id, p_reason: form.get("reason") });
        closeDialog(); toast("Journal entry voided"); await loadData({ quiet: true });
      }
    });
  }

  function agentTokenStatus(token) {
    if (token.revoked_at) return "Revoked";
    if (token.expires_at && new Date(token.expires_at) <= new Date()) return "Expired";
    return "Active";
  }

  async function openAccountDialog() {
    let agentReady = true;
    try {
      const [tokens, drafts] = await Promise.all([
        rpc("api_list_agent_tokens", {}),
        rpc("api_list_agent_drafts", {})
      ]);
      state.agentTokens = tokens || [];
      state.agentDrafts = drafts || [];
    } catch (error) {
      agentReady = false;
      state.agentTokens = [];
      state.agentDrafts = [];
      console.warn(error);
    }
    const tokens = state.agentTokens.map((token) => `
      <div class="agent-access-row">
        <div><strong>${esc(token.name)}</strong><small>${esc(agentTokenStatus(token))} · ${esc((token.scopes || []).join(", "))}</small></div>
        ${!token.revoked_at ? `<button class="button button--ghost button--small" type="button" data-action="agent-token-revoke" data-token-id="${esc(token.id)}">Revoke</button>` : ""}
      </div>`).join("");
    const drafts = state.agentDrafts.map((draft) => {
      const portfolio = state.portfolios.find((item) => item.id === draft.portfolio_id);
      return `<div class="agent-access-row">
        <div><strong>${esc(String(draft.operation_type || "operation").replaceAll("_", " "))}</strong><small>${esc(portfolio?.name || "Portfolio")} · expires ${esc(new Date(draft.expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</small></div>
        <button class="button button--primary button--small" type="button" data-action="agent-draft-review" data-draft-id="${esc(draft.id)}">Review</button>
      </div>`;
    }).join("");
    openDialog({
      kicker: "Authenticated session", title: "Account", submitLabel: "Sign out", danger: true,
      body: `<div class="preview-grid"><div class="preview-cell"><small>Signed in as</small><strong>${esc(state.user?.email || "Supabase user")}</strong></div><div class="preview-cell"><small>Data source</small><strong>Supabase / RLS</strong></div></div>
        <section class="agent-access">
          <div class="agent-access__head"><div><small>HERMES / MCP</small><h3>Agent access</h3></div>${agentReady ? '<button class="button button--primary button--small" type="button" data-action="agent-token-create">New token</button>' : ""}</div>
          ${agentReady ? `<p class="form-hint">Tokens are stored as hashes. The plaintext token appears once and belongs only in Hermes local secrets.</p>
            <div class="agent-access__list">${tokens || '<p class="empty-note">No agent tokens yet.</p>'}</div>
            <div class="agent-access__head agent-access__head--drafts"><div><small>HUMAN APPROVAL</small><h3>Agent drafts</h3></div><span>${state.agentDrafts.length} pending</span></div>
            <div class="agent-access__list">${drafts || '<p class="empty-note">No pending agent drafts.</p>'}</div>`
            : '<div class="warning-box">Hermes Agent API is not installed yet. Run 017_hermes_agent_api.sql in Supabase first.</div>'}
        </section>
        <p class="form-hint">Financial records are not cached in this app. Signing out clears the active Supabase session from this device.</p>`,
      onSubmit: async () => { await db.auth.signOut(); closeDialog(); showAuth(); }
    });
  }

  function openCreateAgentTokenDialog() {
    const expiry = new Date(Date.now() + 90 * 24 * 60 * 60_000).toISOString().slice(0, 10);
    openDialog({
      kicker: "Hermes · Scoped access", title: "Create agent token", submitLabel: "Create token",
      body: `<label class="field"><span>Token name</span><input name="name" maxlength="80" value="Hermes" required></label>
        <label class="field-check"><input name="no_expiry" type="checkbox" data-agent-token-no-expiry checked>Keep this token active until I revoke it</label>
        <label class="field" data-agent-token-expiry><span>Expires on (optional)</span><input name="expires" type="date" value="${expiry}" disabled></label>
        <div class="preview-grid"><div class="preview-cell"><small>Read</small><strong>All dashboard pages</strong></div><div class="preview-cell"><small>Write</small><strong>Drafts + Watchlist only</strong></div></div>
        <div class="warning-box">This token stays active until you revoke it from Account. Hermes cannot confirm drafts, run SQL, edit balances directly, delete history, or place broker orders.</div>`,
      onSubmit: async (form) => {
        const permanent = form.get("no_expiry") === "on";
        const expiryDate = String(form.get("expires") || "");
        if (!permanent && !expiryDate) throw new Error("Choose an expiry date or keep the token active until revoked.");
        const expires = permanent ? null : new Date(`${expiryDate}T23:59:59Z`).toISOString();
        const token = await rpc("api_create_agent_token", {
          p_name: form.get("name"),
          p_scopes: ["read", "drafts:write", "watchlist:write", "briefings:write"],
          p_expires_at: expires
        });
        openDialog({
          kicker: "Shown once · Store locally", title: "Hermes token created", cancelLabel: "Done",
          body: `<label class="field"><span>Agent token</span><textarea data-agent-token readonly rows="4">${esc(token.token)}</textarea></label>
            <button class="button button--primary" type="button" data-action="agent-token-copy">Copy token</button>
            <div class="warning-box">Paste this into Hermes as PCC_AGENT_TOKEN. Closing this window permanently hides the plaintext token.</div>`,
          onSubmit: null
        });
      }
    });
    const noExpiry = $("[data-agent-token-no-expiry]", $("#dialog-body"));
    const expiryField = $("[data-agent-token-expiry]", $("#dialog-body"));
    const expiryInput = $("input[name=expires]", expiryField);
    noExpiry?.addEventListener("change", () => {
      const permanent = noExpiry.checked;
      expiryInput.disabled = permanent;
      expiryField.classList.toggle("is-disabled", permanent);
    });
    expiryField?.classList.add("is-disabled");
  }

  async function openAgentDraftReview(draftId) {
    const draft = state.agentDrafts.find((item) => item.id === draftId);
    if (!draft) { toast("Agent draft was not found or has expired", true); return; }
    const portfolio = state.portfolios.find((item) => item.id === draft.portfolio_id);
    openDialog({
      kicker: `Hermes draft · ${esc(portfolio?.name || "Portfolio")}`,
      title: `Confirm ${String(draft.operation_type || "operation").replaceAll("_", " ")}`,
      submitLabel: "Confirm and post",
      body: `<div class="preview-grid">${previewCells(draft.server_preview || {})}</div>
        <div class="warning-box">Hermes prepared this draft but cannot post it. Supabase will recalculate every value atomically when you confirm.</div>`,
      onSubmit: async () => {
        const claim = await rpc("api_prepare_agent_draft_confirmation", { p_draft_id: draft.id });
        const fn = draft.operation_type === "cash" ? "api_confirm_cash_draft" : "api_confirm_trade_draft";
        await rpc(fn, { p_draft_id: draft.id, p_confirmation_token: claim.confirmation_token });
        closeDialog();
        toast("Agent draft confirmed");
        await loadData({ quiet: true });
      }
    });
  }

  async function handleClick(event) {
    if (state.notificationsOpen && !event.target.closest("#notification-panel, #notification-button")) {
      state.notificationsOpen = false;
      renderNotificationCenter();
    }
    if (state.mobileMoreOpen && !event.target.closest("#mobile-more-panel, #mobile-more-button")) {
      state.mobileMoreOpen = false;
      renderNav();
    }
    const routeButton = event.target.closest("[data-route]");
    if (routeButton) {
      const nextRoute = routeButton.dataset.route;
      if (state.route === "watchlist" && nextRoute !== "watchlist") invalidateWatchlistBarsRequest();
      state.route = nextRoute;
      state.notificationsOpen = false;
      state.mobileMoreOpen = false;
      if (!localPreviewEnabled) {
        const url = new URL(location.href);
        if (nextRoute === "overview") url.searchParams.delete("route");
        else url.searchParams.set("route", nextRoute);
        history.replaceState(null, "", url);
      }
      window.scrollTo(0, 0);
      renderNav();
      if (state.route === "journal") await loadJournalPage();
      else if (state.route === "research") await loadResearchPage();
      else if (state.route === "earnings") await loadEarningsPage();
      else if (state.route === "macro") await loadMacroPage();
      else if (state.route === "briefs") await loadBriefPage();
      else {
        render();
        if (state.route === "watchlist" && state.watchlistView === "charts" && state.selectedWatchlistInstrumentId && !state.watchlistBars.length) {
          await loadWatchlistBars();
        } else if (state.route === "watchlist" && state.watchlistView === "market" && !state.marketPulse.length) {
          await refreshMarketPulse();
        }
      }
      return;
    }
    const portfolioButton = event.target.closest("[data-portfolio-id]");
    if (portfolioButton) { if (state.route === "watchlist") invalidateWatchlistBarsRequest(); state.selectedPortfolioId = portfolioButton.dataset.portfolioId; state.route = "portfolio"; state.holdingsPage = 1; state.holdingsQuery = ""; window.scrollTo(0, 0); render(); return; }
    const openPortfolio = event.target.closest("[data-open-portfolio]");
    if (openPortfolio) { if (state.route === "watchlist") invalidateWatchlistBarsRequest(); state.selectedPortfolioId = openPortfolio.dataset.openPortfolio; state.route = "portfolio"; window.scrollTo(0, 0); render(); return; }
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (action === "close-dialog") closeDialog();
    else if (action === "notification-toggle") {
      state.notificationsOpen = !state.notificationsOpen;
      state.mobileMoreOpen = false;
      renderNotificationCenter();
      renderNav();
    }
    else if (action === "mobile-more-toggle") {
      state.mobileMoreOpen = !state.mobileMoreOpen;
      state.notificationsOpen = false;
      renderNotificationCenter();
      renderNav();
    }
    else if (action === "notification-read-all") {
      if (!localPreviewEnabled) await rpc("api_mark_notification_read", { p_notification_id: null });
      const readAt = new Date().toISOString();
      state.notifications.forEach((notice) => { if (!notice.read_at) notice.read_at = readAt; });
      renderNotificationCenter();
    }
    else if (action === "notification-open") {
      const entityId = target.dataset.entityId;
      const notice = state.notifications.find((item) => item.id === target.dataset.notificationId);
      const brief = state.briefs.find((item) => item.id === entityId || briefArray(item.updates).some((update) => update.id === entityId));
      if (brief) state.selectedBriefId = brief.id;
      state.route = "briefs";
      state.notificationsOpen = false;
      if (!localPreviewEnabled) {
        const url = new URL(location.href);
        url.searchParams.set("route", "briefs");
        history.replaceState(null, "", url);
      }
      if (notice && !notice.read_at) {
        if (!localPreviewEnabled) await rpc("api_mark_notification_read", { p_notification_id: notice.id });
        notice.read_at = new Date().toISOString();
      }
      window.scrollTo(0, 0);
      render();
      renderNotificationCenter();
      if (entityId && briefArray(brief?.updates).some((update) => update.id === entityId)) {
        requestAnimationFrame(() => $(`#brief-update-${CSS.escape(entityId)}`)?.scrollIntoView({ block: "start" }));
      }
    }
    else if (action === "brief-select") {
      state.selectedBriefId = target.dataset.briefId;
      window.scrollTo(0, 0);
      renderBriefs();
    }
    else if (action === "refresh") await loadData();
    else if (action === "price-refresh") await refreshStockPrices({ force: true, notify: true });
    else if (action === "watchlist-view") {
      state.watchlistView = target.dataset.view === "market" ? "market" : "charts";
      renderWatchlist();
      if (state.watchlistView === "market") {
        const latest = state.marketPulse.map((row) => new Date(row.fetched_at).getTime()).filter(Number.isFinite);
        const stale = !latest.length || Date.now() - Math.max(...latest) >= 15 * 60_000;
        if (stale) await refreshMarketPulse();
      } else if (state.selectedWatchlistInstrumentId && !state.watchlistBars.length) {
        await loadWatchlistBars();
      }
    }
    else if (action === "market-pulse-refresh") await refreshMarketPulse({ force: true, notify: true });
    else if (action === "market-pulse-window") {
      state.marketPulseWindow = ["1D", "1W", "1M", "3M", "YTD"].includes(target.dataset.window) ? target.dataset.window : "1D";
      renderWatchlist();
    }
    else if (action === "watchlist-add") openWatchlistDialog();
    else if (action === "watchlist-chart") await loadWatchlistBars(target.dataset.instrumentId, state.watchlistRange, state.watchlistTimeframe);
    else if (action === "watchlist-timeframe") {
      const nextTimeframe = target.dataset.timeframe;
      const nextOption = watchlistChartOptions[nextTimeframe] || watchlistChartOptions["1D"];
      await loadWatchlistBars(state.selectedWatchlistInstrumentId, nextOption.defaultRange, nextTimeframe);
    }
    else if (action === "watchlist-range") await loadWatchlistBars(state.selectedWatchlistInstrumentId, target.dataset.range, state.watchlistTimeframe);
    else if (action === "watchlist-remove") openRemoveWatchlistDialog(target.dataset.instrumentId);
    else if (action === "smart-money-side") { state.smartMoneySide = target.dataset.side || "all"; renderSmartMoney(); }
    else if (action === "smart-money-window") { state.smartMoneyWindow = num(target.dataset.days) || 30; renderSmartMoney(); }
    else if (action === "research-sync") await syncResearchNews({ notify: true });
    else if (action === "research-filter") {
      state.researchFilter = ["all", "unread", "portfolio", "macro", "saved"].includes(target.dataset.filter) ? target.dataset.filter : "all";
      state.researchPage = 1;
      await loadResearchPage();
    }
    else if (action === "research-open") {
      void setResearchGroupState(target.dataset.articleIds || target.dataset.articleId, "read", true).catch((error) => toast(friendlyError(error), true));
    }
    else if (action === "research-read") {
      await setResearchGroupState(target.dataset.articleIds || target.dataset.articleId, "read", target.dataset.value === "true");
    }
    else if (action === "research-save") {
      await setResearchGroupState(target.dataset.articleIds || target.dataset.articleId, "saved", target.dataset.value === "true");
    }
    else if (action === "research-hide") {
      await setResearchGroupState(target.dataset.articleIds || target.dataset.articleId, "hidden", true);
      toast("Event hidden from News");
    }
    else if (action === "research-page-prev" || action === "research-page-next") {
      state.researchPage += action === "research-page-next" ? 1 : -1;
      await loadResearchPage();
      $(".news-commandbar")?.scrollIntoView({ block: "start" });
    }
    else if (action === "earnings-sync") await syncEarningsCalendar({ notify: true });
    else if (action === "earnings-week") {
      state.earningsWeekIndex = Math.max(0, num(target.dataset.week));
      renderEarnings();
    }
    else if (action === "earnings-detail") openEarningsDetail(target.dataset.earningsId);
    else if (action === "macro-sync") await syncMacroCalendar({ notify: true });
    else if (action === "account") await openAccountDialog();
    else if (action === "portfolio-create") openCreatePortfolioDialog();
    else if (action === "portfolio-manage") openPortfolioManagerDialog();
    else if (action === "portfolio-broker") openPortfolioBrokerDialog(target.dataset.portfolioManageId);
    else if (action === "portfolio-rename") openRenamePortfolioDialog(target.dataset.portfolioManageId);
    else if (action === "portfolio-archive") openArchivePortfolioDialog(target.dataset.portfolioManageId);
    else if (action === "agent-token-create") openCreateAgentTokenDialog();
    else if (action === "agent-token-copy") {
      const token = $("[data-agent-token]")?.value || "";
      await navigator.clipboard.writeText(token);
      toast("Agent token copied");
    }
    else if (action === "agent-token-revoke") {
      await rpc("api_revoke_agent_token", { p_token_id: target.dataset.tokenId });
      toast("Agent token revoked");
      await openAccountDialog();
    }
    else if (action === "agent-draft-review") await openAgentDraftReview(target.dataset.draftId);
    else if (action === "budget-edit") openBudgetDialog();
    else if (action === "cash-add") openCashDialog();
    else if (action === "asset-add") openAssetDialog();
    else if (action === "trade-add" || action === "trade-buy") openTradeDialog("buy");
    else if (action === "trade-sell") openTradeDialog("sell");
    else if (action === "buy-simulate") openBuySimulator(target.dataset.instrumentId);
    else if (action === "execution-history") openExecutionHistoryDialog();
    else if (action === "trade-history-edit") openExecutionEditDialog(target.dataset.executionId);
    else if (action === "target-edit") openTargetDialog(target.dataset.instrumentId);
    else if (action === "price-record") openPriceDialog(target.dataset.instrumentId);
    else if (action === "asset-remove") openRemoveAssetDialog(target.dataset.instrumentId);
    else if (action === "journal-add") openJournalDialog();
    else if (action === "journal-edit") openJournalDialog(state.journal.find((item) => item.id === target.dataset.entryId));
    else if (action === "journal-void") openVoidJournalDialog(state.journal.find((item) => item.id === target.dataset.entryId));
    else if (action === "journal-page-prev" || action === "journal-page-next") {
      state.journalPage += action === "journal-page-next" ? 1 : -1;
      await loadJournalPage();
      $(".journal-commandbar")?.scrollIntoView({ block: "start" });
    }
    else if (action === "page-prev" || action === "page-next") {
      state.holdingsPage += action === "page-next" ? 1 : -1;
      $("#holdings-region").innerHTML = holdingsTable(currentPortfolio());
    }
    else if (action === "trade-history-prev" || action === "trade-history-next") {
      state.tradeHistoryPage += action === "trade-history-next" ? 1 : -1;
      const region = $("#trade-history-region", $("#dialog-body"));
      if (region) region.innerHTML = historyDialogMarkup(currentPortfolio());
    }
  }

  dialogForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!dialogSubmit) return;
    const submitButton = $('button[type="submit"]', dialogForm);
    const original = submitButton?.textContent;
    if (submitButton) { submitButton.disabled = true; submitButton.textContent = "Working…"; }
    $("#dialog-error").textContent = "";
    try {
      await dialogSubmit(new FormData(dialogForm));
    } catch (error) {
      console.error(error);
      $("#dialog-error").textContent = friendlyError(error);
    } finally {
      if (submitButton?.isConnected) { submitButton.disabled = false; submitButton.textContent = original; }
    }
  });

  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $('button[type="submit"]', event.currentTarget);
    const errorNode = $("#login-error");
    button.disabled = true; button.textContent = "Signing in…"; errorNode.textContent = "";
    const form = new FormData(event.currentTarget);
    const { data, error } = await db.auth.signInWithPassword({ email: form.get("email"), password: form.get("password") });
    if (error) { errorNode.textContent = error.message; button.disabled = false; button.textContent = "Enter dashboard"; return; }
    await showApp(data.user);
    button.disabled = false; button.textContent = "Enter dashboard";
  });

  document.addEventListener("click", handleClick);
  document.addEventListener("error", (event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.matches(".asset-mark img")) return;
    image.closest(".asset-mark")?.classList.add("is-fallback");
  }, true);
  document.addEventListener("input", (event) => {
    const smartSearch = event.target.closest("[data-smart-money-search]");
    if (smartSearch && state.route === "smart-money") {
      state.smartMoneySearch = smartSearch.value;
      renderSmartMoney();
      const nextSearch = $("[data-smart-money-search]");
      nextSearch?.focus();
      nextSearch?.setSelectionRange(state.smartMoneySearch.length, state.smartMoneySearch.length);
      return;
    }
    const researchSearch = event.target.closest("[data-research-search]");
    if (researchSearch && state.route === "research") {
      state.researchSearch = researchSearch.value;
      state.researchPage = 1;
      clearTimeout(researchSearchTimer);
      researchSearchTimer = setTimeout(() => { void loadResearchPage(); }, 350);
      return;
    }
    const search = event.target.closest("[data-watchlist-search]");
    if (!search || state.route !== "watchlist") return;
    state.watchlistSearch = search.value;
    const rows = watchlistRows();
    const selected = rows.find((item) => item.instrument_id === state.selectedWatchlistInstrumentId) || null;
    const region = $("#watchlist-list-region");
    if (region) region.innerHTML = watchlistRowsMarkup(rows, selected);
  });
  $("#refresh-button").addEventListener("click", refreshDashboard);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeDialog(); });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog();
    }
  });
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.route === "journal") drawEquityCurvePaged(state.journalDaily);
      if (state.route === "watchlist" && state.watchlistView === "charts") drawWatchlistChart();
    }, 120);
  });

  async function refreshVisibleWatchlistChart() {
    if (state.route !== "watchlist" || state.watchlistView !== "charts" || !state.selectedWatchlistInstrumentId || state.watchlistChartBusy) return;
    await loadWatchlistBars(state.selectedWatchlistInstrumentId, state.watchlistRange, state.watchlistTimeframe);
  }

  async function refreshMarketData() {
    await refreshStockPrices();
    if (state.route === "watchlist" && state.watchlistView === "market") await refreshMarketPulse();
    await refreshVisibleWatchlistChart();
  }

  window.setInterval(() => { void refreshMarketData(); }, 15 * 60_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshMarketData();
  });

  db.auth.onAuthStateChange((event, session) => {
    if (localPreviewEnabled) return;
    if (event === "SIGNED_OUT" || !session?.user) showAuth();
  });

  function loadLocalPreview() {
    const portfolios = [
      { id: "p-long", kind: "long_term", name: "Long Term", fixed_budget: 40000, allocation_basis: "cost_basis", portfolio_mode: "mixed", broker_profile: "dime", sort_order: 1, is_active: true },
      { id: "p-swing", kind: "swing_trade", name: "Swing Trade", fixed_budget: 18000, allocation_basis: "cost_basis", portfolio_mode: "mixed", broker_profile: "webull", sort_order: 2, is_active: true },
      { id: "p-spec", kind: "speculative", name: "Speculative", fixed_budget: 10000, allocation_basis: "cost_basis", portfolio_mode: "mixed", broker_profile: "webull", sort_order: 3, is_active: true },
      { id: "p-opt", kind: "options", name: "Options", fixed_budget: 8000, allocation_basis: "cost_basis", portfolio_mode: "mixed", broker_profile: "dime", sort_order: 4, is_active: true }
    ];
    const instruments = [
      ["i-googl", "GOOGL", "Alphabet Inc.", "stock", 1], ["i-meta", "META", "Meta Platforms", "stock", 1],
      ["i-nvda", "NVDA", "NVIDIA Corporation", "stock", 1], ["i-rklb", "RKLB", "Rocket Lab", "stock", 1],
      ["i-eose", "EOSE", "Eos Energy", "stock", 1], ["i-spy", "SPY", "SPDR S&P 500 ETF", "etf", 1],
      ["i-tsla-opt", "TSLA", "TSLA 300 Call", "option", 100]
    ].map(([id, symbol, display_name, asset_type, multiplier]) => ({ id, symbol, display_name, asset_type, multiplier }));
    const positions = [
      ["p-long", "i-googl", 30, 170, 5100, null, null], ["p-long", "i-meta", 18, 520, 9360, null, null],
      ["p-long", "i-nvda", 65, 125, 8125, null, null], ["p-long", "i-spy", 10, 590, 5900, null, null],
      ["p-swing", "i-nvda", 35, 132, 4620, null, null], ["p-swing", "i-googl", 20, 184, 3680, null, null],
      ["p-spec", "i-rklb", 160, 23, 3680, null, null], ["p-spec", "i-eose", 500, 6.4, 3200, null, null],
      ["p-opt", "i-tsla-opt", 2, 8.5, 1700, 1700, 60000]
    ].map(([portfolio_id, instrument_id, quantity, average_cost, cost_basis, maximum_loss, notional_value]) => ({ portfolio_id, instrument_id, quantity, average_cost, cost_basis, maximum_loss, notional_value }));
    const targets = [
      ["p-long", "i-googl", 20, 25, 3], ["p-long", "i-meta", 25, 28, 3], ["p-long", "i-nvda", 25, 28, 3], ["p-long", "i-spy", 20, 25, 2],
      ["p-swing", "i-nvda", 33.33, 34, 3], ["p-swing", "i-googl", 33.33, 34, 3],
      ["p-spec", "i-rklb", 40, 45, 3], ["p-spec", "i-eose", 30, 35, 3],
      ["p-opt", "i-tsla-opt", 25, 30, 2]
    ].map(([portfolio_id, instrument_id, target_percent, maximum_percent, planned_tranches]) => ({ portfolio_id, instrument_id, target_percent, maximum_percent, planned_tranches, is_active: true }));
    const cash = [{ portfolio_id: "p-long", cash_balance: 11515 }, { portfolio_id: "p-swing", cash_balance: 9700 }, { portfolio_id: "p-spec", cash_balance: 3120 }, { portfolio_id: "p-opt", cash_balance: 6300 }];
    const capacities = targets.map((target) => {
      const portfolio = portfolios.find((p) => p.id === target.portfolio_id);
      const position = positions.find((p) => p.portfolio_id === target.portfolio_id && p.instrument_id === target.instrument_id);
      const cashBalance = cash.find((c) => c.portfolio_id === target.portfolio_id).cash_balance;
      const deployed_amount = portfolio.allocation_basis === "maximum_loss" ? num(position?.maximum_loss) : num(position?.cost_basis);
      const targetBudget = portfolio.fixed_budget * target.target_percent / 100;
      return { ...target, deployed_amount, actionable_buy_amount: Math.min(Math.max(targetBudget - deployed_amount, 0), cashBalance) };
    });
    const journal = [
      ["j1", "p-swing", "i-nvda", "2026-07-15", 620, "Breakout", "Held plan through close"],
      ["j2", "p-spec", "i-rklb", "2026-07-13", -280, "Momentum", "Entry was late"],
      ["j3", "p-opt", "i-tsla-opt", "2026-07-10", 410, "Long call", "Scaled out at target"],
      ["j4", "p-swing", "i-googl", "2026-06-28", 355, "Pullback", "Clean support reaction"],
      ["j5", "p-spec", "i-eose", "2026-06-19", -190, "Catalyst", "Invalidated quickly"],
      ["j6", "p-swing", "i-nvda", "2026-05-22", 540, "Continuation", "Two tranches"],
      ["j7", "p-long", "i-meta", "2026-04-11", 220, "Trim", "Portfolio rebalance"]
    ].map(([id, portfolio_id, instrument_id, occurred_on, manual_pnl, strategy_label, notes]) => ({ id, portfolio_id, instrument_id, occurred_on, manual_pnl, strategy_label, notes, outcome: manual_pnl > 0 ? "win" : "loss", source: "manual", is_void: false, created_at: `${occurred_on}T12:00:00Z` }));
    if (localStressEnabled) {
      const portfolioIds = portfolios.map((item) => item.id);
      for (let index = 0; index < 10_000; index += 1) {
        const date = new Date(Date.UTC(2021, 0, 1 + (index % 1_825))).toISOString().slice(0, 10);
        const pnl = index % 3 === 0 ? -(40 + index % 260) : 60 + index % 540;
        const instrument = instruments[index % instruments.length];
        journal.push({
          id: `stress-${index}`,
          portfolio_id: portfolioIds[index % portfolioIds.length],
          instrument_id: instrument.id,
          occurred_on: date,
          manual_pnl: pnl,
          strategy_label: index % 2 ? "Stress breakout" : "Stress pullback",
          notes: `Generated local performance row ${index + 1}`,
          outcome: pnl > 0 ? "win" : "loss",
          source: "manual",
          is_void: false,
          created_at: `${date}T12:00:00Z`
        });
      }
    }
    const watchlist = [
      { id: "w-nvda", instrument_id: "i-nvda", notes: "AI infrastructure leader" },
      { id: "w-googl", instrument_id: "i-googl", notes: "Cloud and search" },
      { id: "w-rklb", instrument_id: "i-rklb", notes: "Space systems" }
    ];
    const smartMoneyEvents = [
      { id: "sm-1", instrument_id: "i-rklb", filer_name: "Alex Morgan", filer_title: "Chief Operating Officer", relationship: "Officer", transaction_code: "P", side: "buy", transaction_date: "2026-07-21", filed_at: "2026-07-22T01:45:00Z", shares: 18500, price: 24.12, transaction_value: 446220, post_transaction_shares: 142800, sec_url: "" },
      { id: "sm-2", instrument_id: "i-nvda", filer_name: "Jordan Lee", filer_title: "Director", relationship: "Director", transaction_code: "S", side: "sell", transaction_date: "2026-07-20", filed_at: "2026-07-21T20:16:00Z", shares: 3200, price: 203.46, transaction_value: 651072, post_transaction_shares: 78440, sec_url: "" },
      { id: "sm-3", instrument_id: "i-googl", filer_name: "Taylor Chen", filer_title: "Senior Vice President", relationship: "Officer", transaction_code: "M", side: "other", transaction_date: "2026-07-18", filed_at: "2026-07-21T15:09:00Z", shares: 12000, price: 78.4, transaction_value: 940800, post_transaction_shares: 96300, sec_url: "" },
      { id: "sm-4", instrument_id: "i-nvda", filer_name: "Morgan Reed", filer_title: "Chief Financial Officer", relationship: "Officer", transaction_code: "P", side: "buy", transaction_date: "2026-07-17", filed_at: "2026-07-18T22:41:00Z", shares: 750, price: 198.2, transaction_value: 148650, post_transaction_shares: 21850, sec_url: "" },
      { id: "sm-5", instrument_id: "i-rklb", filer_name: "Casey Patel", filer_title: "Director", relationship: "Director", transaction_code: "A", side: "other", transaction_date: "2026-07-16", filed_at: "2026-07-18T12:30:00Z", shares: 9000, price: 0, transaction_value: 0, post_transaction_shares: 54000, sec_url: "" },
      { id: "sm-6", instrument_id: "i-googl", filer_name: "Riley Brooks", filer_title: "10% Owner", relationship: "Ten percent owner", transaction_code: "S", side: "sell", transaction_date: "2026-07-14", filed_at: "2026-07-16T17:24:00Z", shares: 21000, price: 191.3, transaction_value: 4017300, post_transaction_shares: 528000, sec_url: "" }
    ];
    const researchPreviewSource = [
      { id: "news-1", source: "massive", canonical_url: "https://example.com/nvda-supply", title: "NVIDIA supplier network prepares for another capacity expansion", description: "Partners across the AI infrastructure chain are outlining new production capacity and delivery windows.", publisher_name: "Market Wire", published_at: "2026-07-29T00:42:00Z", tickers: ["NVDA"], is_portfolio: true, is_watchlist: true, is_read: false, is_saved: false },
      { id: "news-2", source: "massive", canonical_url: "https://example.com/rklb-launch", title: "Rocket Lab confirms the next Electron launch window", description: "The company published a new mission window and payload overview for its next scheduled flight.", publisher_name: "Space Desk", published_at: "2026-07-28T21:15:00Z", tickers: ["RKLB"], is_portfolio: true, is_watchlist: true, is_read: false, is_saved: true },
      { id: "news-3", source: "massive", canonical_url: "https://example.com/googl-cloud", title: "Alphabet expands a cloud partnership for enterprise AI workloads", description: "The agreement adds deployment and data-governance support for large enterprise customers.", publisher_name: "Technology Daily", published_at: "2026-07-28T17:05:00Z", tickers: ["GOOGL"], is_portfolio: true, is_watchlist: true, is_read: true, is_saved: false },
      { id: "news-4", source: "massive", canonical_url: "https://example.com/eose-project", title: "Eos Energy announces a new long-duration storage project milestone", description: "The latest project update covers commissioning work and the expected delivery sequence.", publisher_name: "Energy Journal", published_at: "2026-07-28T12:30:00Z", tickers: ["EOSE"], is_portfolio: true, is_watchlist: false, is_read: false, is_saved: false },
      { id: "news-5", source: "massive", canonical_url: "https://example.com/meta-policy", title: "Meta updates platform policy ahead of its next product rollout", description: "The policy change will roll out in stages across advertising and creator tools.", publisher_name: "Digital Media News", published_at: "2026-07-27T19:40:00Z", tickers: ["META"], is_portfolio: true, is_watchlist: false, is_read: true, is_saved: true }
    ];
    const previewEarningsDate = (days) => { const date = new Date(); date.setDate(date.getDate() + days); return localDayKey(date); };
    const earningsEntries = [
      { id: "er-1", instrument_id: "i-nvda", symbol: "NVDA", display_name: "NVIDIA", asset_type: "stock", earnings_date: previewEarningsDate(2), report_hour: "amc", report_sort: 3, fiscal_quarter: 3, fiscal_year: 2026, eps_estimate: 1.18, revenue_estimate: 45800000000 },
      { id: "er-2", instrument_id: "i-googl", symbol: "GOOGL", display_name: "Alphabet", asset_type: "stock", earnings_date: previewEarningsDate(5), report_hour: "amc", report_sort: 3, fiscal_quarter: 3, fiscal_year: 2026, eps_estimate: 2.21, revenue_estimate: 96700000000 },
      { id: "er-3", instrument_id: "i-rklb", symbol: "RKLB", display_name: "Rocket Lab", asset_type: "stock", earnings_date: previewEarningsDate(8), report_hour: "bmo", report_sort: 1, fiscal_quarter: 2, fiscal_year: 2026, eps_estimate: -0.08, revenue_estimate: 162000000 }
    ];
    const previewMacroAt = (days, hour = 19, minute = 30) => {
      const date = new Date();
      date.setDate(date.getDate() + days);
      date.setHours(hour, minute, 0, 0);
      return date.toISOString();
    };
    const macroEntries = [
      { id: "macro-1", external_id: "preview-nfp", event_group: "labor", signal_family: "labor_strength", event_name: "Nonfarm Payrolls", category: "Employment Situation", reference_period: "Jul 2026", scheduled_at: previewMacroAt(-1), actual: "73K", previous: "147K", source_name: "BLS via FRED", source_url: "https://www.bls.gov/news.release/empsit.nr0.htm" },
      { id: "macro-2", external_id: "preview-cpi", event_group: "inflation", signal_family: "inflation", event_name: "CPI Inflation (MoM)", category: "CPI", reference_period: "Jul 2026", scheduled_at: previewMacroAt(2), actual: null, previous: "0.3%", source_name: "BLS via FRED", source_url: "https://www.bls.gov/cpi/" },
      { id: "macro-3", external_id: "preview-core-cpi", event_group: "inflation", signal_family: "inflation", event_name: "Core CPI (MoM)", category: "Core CPI", reference_period: "Jul 2026", scheduled_at: previewMacroAt(2), actual: null, previous: "0.2%", source_name: "BLS via FRED", source_url: "https://www.bls.gov/cpi/" },
      { id: "macro-4", external_id: "preview-ppi", event_group: "inflation", signal_family: "inflation", event_name: "Producer Price Index (MoM)", category: "PPI", reference_period: "Jul 2026", scheduled_at: previewMacroAt(3), actual: null, previous: "0.0%", source_name: "BLS via FRED", source_url: "https://www.bls.gov/ppi/" },
      { id: "macro-5", external_id: "preview-claims", event_group: "labor", signal_family: "labor_inverse", event_name: "Initial Jobless Claims", category: "Weekly Claims", reference_period: "Aug 8, 2026", scheduled_at: previewMacroAt(5), actual: null, previous: "226K", source_name: "DOL via FRED", source_url: "https://www.dol.gov/ui/data.pdf" },
      { id: "macro-6", external_id: "preview-retail", event_group: "consumption", signal_family: "growth", event_name: "Retail Sales (MoM)", category: "Retail Sales", reference_period: "Jul 2026", scheduled_at: previewMacroAt(8), actual: null, previous: "0.6%", source_name: "Census via FRED", source_url: "https://www.census.gov/retail/index.html" },
      { id: "macro-7", external_id: "preview-fomc", event_group: "policy", signal_family: "policy", event_name: "FOMC Rate Decision + SEP", category: "FOMC", scheduled_at: previewMacroAt(25, 1, 0), actual: null, previous: "4.75–5.00%", source_name: "Federal Reserve", source_url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm" },
      { id: "macro-8", external_id: "preview-powell", event_group: "policy", signal_family: "policy", event_name: "Fed Chair Press Conference", category: "Fed Chair", scheduled_at: previewMacroAt(25, 1, 30), actual: null, previous: null, source_name: "Federal Reserve", source_url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm" }
    ];
    const previewBriefDate = localDayKey(new Date());
    const previewSources = [
      { id: "src-1", title: "US stocks close higher as yields ease", publisher: "Reuters", url: "https://www.reuters.com/markets/us/", published_at: new Date().toISOString() },
      { id: "src-2", title: "Employment Situation", publisher: "U.S. Bureau of Labor Statistics", url: "https://www.bls.gov/news.release/empsit.nr0.htm", published_at: new Date().toISOString() }
    ];
    const briefs = [{
      id: "brief-preview", brief_date: previewBriefDate, title: "Daily Market Brief",
      summary: "Risk appetite improved as yields eased, but the next inflation release remains the decision point.",
      published_at: new Date().toISOString(), content: {
        market_mood: { label: "Constructive, with CPI risk ahead", tone: "caution", summary: "Growth leadership is intact and volatility is contained. The setup remains constructive, but the next inflation print can change the rate narrative quickly." },
        market_snapshot: [
          { label: "S&P 500", value: "7,757.64", change: "+0.62%", tone: "positive" },
          { label: "NASDAQ", value: "26,690.62", change: "+1.30%", tone: "positive" },
          { label: "US 10Y", value: "4.64%", change: "Yield eased", tone: "positive" },
          { label: "VIX", value: "15.43", change: "Risk appetite improved", tone: "neutral" }
        ],
        top_stories: [
          { title: "Soft labor data lowered immediate rate pressure", facts: ["Payroll growth missed expectations while Treasury yields moved lower."], interpretation: ["The market treated weaker labor as support for duration-sensitive growth rather than an immediate recession signal."], source_ids: ["src-1", "src-2"] },
          { title: "Earnings breadth continues to support the tape", facts: ["Most large-cap reporters have delivered positive EPS surprises."], interpretation: ["Forward guidance remains more important than the headline beat."], source_ids: ["src-1"] },
          { title: "CPI is the next test of the rate narrative", facts: ["The next CPI release arrives before the market can fully settle the soft-labor interpretation."], interpretation: ["A hot print would reconnect inflation, Treasury yields and growth-stock valuation risk."], source_ids: ["src-1", "src-2"] }
        ],
        investment_implications: [
          { title: "AI and semiconductors", detail: "Lower yields remain supportive, but avoid chasing gap-ups into CPI.", tone: "positive" },
          { title: "US equities", detail: "The broad trend remains constructive while yields stay contained.", tone: "neutral" },
          { title: "Risk", detail: "A renewed yield spike would pressure the highest-duration names first.", tone: "caution" }
        ],
        watch_next: [
          { title: "Core CPI (MoM)", detail: "The next major test for yields and growth multiples.", tone: "caution" },
          { title: "Large-cap earnings", detail: "Read guidance before reacting to headline EPS beats.", tone: "neutral" }
        ],
        bottom_line: [
          { title: "Setup", detail: "The constructive trend remains intact while yields stay contained.", tone: "positive" },
          { title: "Main trigger", detail: "CPI decides whether the rate-relief rally can broaden.", tone: "neutral" },
          { title: "Invalidation", detail: "A hot print plus a renewed yield spike is the clearest near-term risk.", tone: "caution" }
        ],
        sources: previewSources
      },
      updates: [{
        id: "update-preview", thesis_status: "unchanged", summary: "Indexes softened after the open, but yields and volatility did not confirm a broader risk-off move.", published_at: new Date(Date.now() + 4 * 60 * 60_000).toISOString(), content: {
          changes: [{ title: "Selective rotation", detail: "Semiconductors held up better than software and financials.", tone: "neutral" }],
          portfolio_impact: [{ title: "No regime change", detail: "The broad-market thesis remains current.", tone: "neutral" }],
          watch_next: [{ title: "Closing breadth", detail: "Watch whether weakness broadens into the final hour.", tone: "caution" }],
          sources: [previewSources[0]]
        }
      }]
    }];
    const notifications = [
      { id: "notice-update", notification_type: "brief_continuation", title: "Daily Market Brief · Continuation", preview: "Indexes softened, but the original thesis remains current.", entity_id: "update-preview", created_at: new Date().toISOString(), read_at: null },
      { id: "notice-brief", notification_type: "daily_brief", title: "Daily Market Brief", preview: briefs[0].summary, entity_id: "brief-preview", created_at: new Date(Date.now() - 4 * 60 * 60_000).toISOString(), read_at: null }
    ];
    Object.assign(state, { user: { email: "preview@local" }, portfolios, instruments, positions, targets, cash, capacities, journalPreviewSource: journal, prices: [], watchlist, smartMoneyEvents, researchPreviewSource, earningsEntries, earningsTrackedCount: watchlist.length, earningsLastSynced: new Date().toISOString(), macroEntries, macroLastSynced: new Date().toISOString(), briefs, notifications, selectedBriefId: "brief-preview", selectedPortfolioId: "p-long", selectedWatchlistInstrumentId: "i-nvda" });
    const researchFeed = previewResearchFeed();
    state.researchEntries = researchFeed.entries;
    state.researchTotal = researchFeed.total_count;
    state.marketPulse = previewMarketPulseRows();
    state.journalOverview = localJournalView({ page: 1, pageSize: 6 });
    applyJournalView(localJournalView({ page: 1, pageSize: state.journalPageSize }));
    authShell.hidden = true;
    appShell.hidden = false;
    setSync(true, "Local preview");
    render();
    renderNotificationCenter();
  }

  (async () => {
    if (localPreviewEnabled) {
      loadLocalPreview();
      return;
    }
    const { data, error } = await db.auth.getSession();
    if (error || !data.session?.user) showAuth();
    else await showApp(data.session.user);
  })();
})();
