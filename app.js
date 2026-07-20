(() => {
  "use strict";

  const config = window.__APP_CONFIG__;
  const supabaseLib = window.supabase;
  if (!config?.supabaseUrl || !config?.supabasePublishableKey || !supabaseLib?.createClient) {
    document.body.innerHTML = '<main style="padding:40px;color:#fff;font-family:sans-serif">Dashboard configuration could not be loaded.</main>';
    return;
  }

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
  const localDateTime = () => {
    const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
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
  const localPreviewEnabled = (["127.0.0.1", "localhost"].includes(location.hostname) || location.protocol === "file:")
    && localPreviewParams.get("preview") === "1";
  const localStressEnabled = localPreviewEnabled && localPreviewParams.get("stress") === "1";

  const state = {
    user: null,
    portfolios: [], cash: [], positions: [], instruments: [], targets: [], capacities: [],
    journal: [], journalPreviewSource: [], journalOverview: null, journalSummary: null,
    journalDaily: [], journalMonthly: [], journalTotal: 0, journalPage: 1, journalPageSize: 50,
    journalFilter: "all", journalOutcome: "all", journalSearch: "", journalDateFrom: "", journalDateTo: "",
    journalBusy: false, prices: [], priceRefreshBusy: false, lastWebullRefresh: null,
    watchlist: [], watchlistReady: true, watchlistBars: [], watchlistChartBusy: false,
    selectedWatchlistInstrumentId: null, watchlistRange: "6M",
    route: "overview", selectedPortfolioId: null,
    holdingsQuery: "", holdingsPage: 1, holdingsPageSize: 25,
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

  function toast(message, isError = false) {
    const node = $("#toast");
    node.textContent = message;
    node.classList.toggle("is-error", isError);
    node.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("is-visible"), 3200);
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
    return message.replace(/^JSON object requested, multiple \(or no\) rows returned$/, "Expected portfolio data was not found.");
  }

  function currentPortfolio() {
    return state.portfolios.find((p) => p.id === state.selectedPortfolioId) || state.portfolios[0] || null;
  }

  function instrumentMap() {
    return new Map(state.instruments.map((item) => [item.id, item]));
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
    const deployed = positions.reduce((sum, item) => sum + (
      portfolio.allocation_basis === "maximum_loss" ? num(item.maximum_loss) : num(item.cost_basis)
    ), 0);
    const budget = num(portfolio.fixed_budget);
    const capital = Math.max(cash + deployed, 0);
    const remaining = Math.max(cash, 0);
    const utilization = capital > 0 ? deployed / capital * 100 : 0;
    const prices = latestPriceMap();
    const instruments = instrumentMap();
    const marketValue = positions.reduce((sum, item) => {
      const price = prices.get(item.instrument_id);
      const instrument = instruments.get(item.instrument_id);
      return sum + (price ? num(price.price) * num(item.quantity) * num(instrument?.multiplier || 1) : 0);
    }, 0);
    return { positions, cash, deployed, budget, capital, remaining, utilization, marketValue };
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

  function portfolioRows(portfolio) {
    const instruments = instrumentMap();
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
      const deployed = portfolio.allocation_basis === "maximum_loss"
        ? num(position?.maximum_loss)
        : num(position?.cost_basis);
      const stats = portfolioStats(portfolio);
      const currentPercent = stats.capital > 0 ? deployed / stats.capital * 100 : 0;
      const targetPercent = num(target?.target_percent);
      const quota = stats.capital * targetPercent / 100;
      const remaining = Math.max(Math.min(quota - deployed, stats.cash), 0);
      let status = "Unplanned", statusClass = "warn";
      if (target) {
        if (targetPercent > 0 && currentPercent > targetPercent + .001) { status = "Over target"; statusClass = "risk"; }
        else if (targetPercent > 0 && currentPercent < targetPercent * .98) { status = "Can add"; statusClass = "warn"; }
        else { status = "On target"; statusClass = "good"; }
      }
      return { id, instrument, position, target, capacity, deployed, currentPercent, targetPercent, quota, remaining, status, statusClass };
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
        state.prices = await query("Prices", db.from("instrument_prices").select("*").order("fetched_at", { ascending: false }).limit(2000));
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

  async function refreshDashboard() {
    await loadData();
    await refreshStockPrices({ force: true, notify: true });
  }

  async function loadData({ quiet = false } = {}) {
    if (!state.user || state.loading) return;
    if (!quiet) setLoading(true);
    setSync(true, "Syncing…");
    try {
      const [portfolios, cash, positions, instruments, targets, capacities, prices, journalOverview, watchlist] = await Promise.all([
        query("Portfolios", db.from("portfolios").select("*").eq("is_active", true).order("sort_order")),
        query("Cash balances", db.from("portfolio_cash_balances").select("*")),
        query("Positions", db.from("position_balances").select("*")),
        query("Instruments", db.from("instruments").select("*").order("symbol")),
        query("Allocation targets", db.from("allocation_targets").select("*").eq("is_active", true)),
        query("Position capacity", db.from("position_capacity").select("*")),
        query("Prices", db.from("instrument_prices").select("*").order("fetched_at", { ascending: false }).limit(2000)),
        fetchJournalView({ page: 1, pageSize: 6 }),
        optionalWatchlistQuery()
      ]);
      Object.assign(state, { portfolios, cash, positions, instruments, targets, capacities, prices, journalOverview, watchlist });
      if (!watchlist.some((item) => item.instrument_id === state.selectedWatchlistInstrumentId)) {
        state.selectedWatchlistInstrumentId = watchlist[0]?.instrument_id || null;
        state.watchlistBars = [];
      }
      if (!state.selectedPortfolioId || !portfolios.some((item) => item.id === state.selectedPortfolioId)) {
        state.selectedPortfolioId = portfolios[0]?.id || null;
      }
      if (state.route === "journal") await loadJournalPage({ renderAfter: false });
      state.lastSync = new Date();
      setSync(true, `Synced ${state.lastSync.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
      render();
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
    nav.innerHTML = state.portfolios.map((portfolio) => {
      const stats = portfolioStats(portfolio);
      return `<button type="button" class="${state.route === "portfolio" && portfolio.id === state.selectedPortfolioId ? "is-active" : ""}" data-portfolio-id="${portfolio.id}">
        <i></i><span>${esc(portfolio.name)}</span><small>${Math.round(stats.utilization)}%</small>
      </button>`;
    }).join("");
    switcher.innerHTML = state.portfolios.map((portfolio) => `<button type="button" class="${portfolio.id === state.selectedPortfolioId ? "is-active" : ""}" data-portfolio-id="${portfolio.id}">${esc(portfolio.name)}</button>`).join("");
    $$(".brand-button[data-route], .nav-item[data-route], .mobile-nav [data-route]").forEach((button) => button.classList.toggle("is-active", button.dataset.route === state.route));
  }

  function render() {
    renderNav();
    if (!state.portfolios.length) {
      viewRoot.innerHTML = `<div class="empty-state"><div><strong>No portfolios found</strong>Sign out and confirm that the four portfolio bootstrap rows exist for this Auth user.</div></div>`;
      return;
    }
    if (state.route === "portfolio") renderPortfolio();
    else if (state.route === "journal") renderJournalPaged();
    else if (state.route === "watchlist") renderWatchlist();
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
      ${pageHead("All portfolios · One clear view", "Know where every dollar is.", "Each portfolio keeps its own money and 100% allocation plan. This overview combines visibility, never the portfolio math.")}
      <section class="hero-ledger" aria-label="Combined summary">
        <div class="hero-metric hero-metric--lead"><small>Total capital<br>Across 4 portfolios</small><strong>${money(total.capital)}</strong></div>
        <div class="hero-metric"><small>Amount invested<br>Cost / max loss</small><strong>${money(total.deployed)}</strong></div>
        <div class="hero-metric"><small>Money remaining<br>Ready to allocate</small><strong>${money(total.cash)}</strong></div>
      </section>

      <section class="section">
        <div class="section-head"><div><span class="section-index">01 / PORTFOLIOS</span><h2>Four portfolios. Kept separate.</h2></div><p>Open one to record a buy or sell, adjust its targets, and see what remains.</p></div>
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
      const tranches = num(row.target?.planned_tranches);
      return `<div class="allocation-row">
        <div class="allocation-row__symbol"><strong>${esc(row.instrument.symbol)}</strong><small>${esc(row.instrument.display_name || row.instrument.asset_type)}</small></div>
        <div class="allocation-progress"><div class="allocation-track ${progress > 100 ? "is-risk" : ""}" style="--current:${clamp(progress, 0, 100)}%"><i></i></div><small>${money(row.deployed)} of ${money(row.quota)}${tranches ? ` · ${tranches} tranches at ~${money(row.quota / tranches)}` : ""}</small></div>
        <div class="allocation-row__number">${percent(row.targetPercent)}<small>target</small></div>
        <div class="allocation-row__number gold">${money(row.remaining)}<small>left to buy</small></div>
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
        const costBasis = row.deployed;
        const hasMarket = quantity > 0 && num(market?.price) > 0;
        const marketValue = hasMarket ? num(market.price) * quantity * multiplier : 0;
        const unrealized = hasMarket ? marketValue - costBasis : 0;
        const unrealizedPercent = hasMarket && costBasis > 0 ? unrealized / costBasis * 100 : 0;
        const pnlClass = unrealized >= 0 ? "positive" : "negative";
        const pnlSign = unrealized > 0 ? "+" : "";
        const allocationProgress = row.targetPercent > 0 ? row.currentPercent / row.targetPercent * 100 : 0;
        const tranches = num(row.target?.planned_tranches);
        return `<tr>
        <td><span class="cell-main">${esc(row.instrument.symbol)}</span><span class="cell-sub">${esc(row.instrument.display_name || row.instrument.asset_type)}</span></td>
        <td><span class="cell-main mono">${quantity.toLocaleString("en-US", { maximumFractionDigits: 8 })}</span><span class="cell-sub">AVG ${quantity > 0 ? money(row.position?.average_cost, 4) : "—"}</span><span class="cell-sub ${market?.source === "webull" ? "price-live" : ""}">${market ? `MKT ${money(market.price, 4)} · ${esc(market.source || "manual")}` : "MKT —"}</span></td>
        <td>${hasMarket ? `<strong class="mono">${money(marketValue)}</strong>` : `<span class="cell-main mono">—</span>`}<span class="cell-sub">COST ${money(costBasis)}</span>${portfolio.kind === "options" ? `<span class="cell-sub">NOTIONAL ${money(row.position?.notional_value)}</span>` : ""}</td>
        <td class="pnl-cell">${hasMarket ? `<strong class="mono ${pnlClass}">${pnlSign}${money(unrealized)}</strong><span class="cell-sub ${pnlClass}">${pnlSign}${percent(unrealizedPercent, 2)}</span>` : `<span class="cell-main mono">—</span><span class="cell-sub">${quantity > 0 ? "Waiting for price" : "No position"}</span>`}</td>
        <td class="allocation-cell"><div class="allocation-cell__top"><strong class="mono">${percent(row.currentPercent)}<small>current</small></strong><span class="mono">${percent(row.targetPercent)}<small>target</small></span></div><div class="allocation-track ${allocationProgress > 100 ? "is-risk" : ""}" style="--current:${clamp(allocationProgress, 0, 100)}%"><i></i></div><div class="allocation-cell__meta"><span class="gold">${money(row.remaining)} left</span><span>${tranches ? `${tranches} tranches · ~${money(row.quota / tranches)} each` : esc(row.status)}</span></div></td>
        <td><div class="row-actions"><button class="button button--small" type="button" data-action="target-edit" data-instrument-id="${row.id}">Edit plan</button><button class="button button--small" type="button" data-action="price-record" data-instrument-id="${row.id}">Price</button>${row.target ? `<button class="button button--small button--remove" type="button" data-action="asset-remove" data-instrument-id="${row.id}" ${num(row.position?.quantity) > 0 ? 'disabled title="Sell the remaining position before removing"' : ""}>Remove</button>` : ""}</div></td>
      </tr>`;
      }).join("")}</tbody>
    </table></div><div class="pagination"><span>${rows.length} assets · showing ${start + 1}–${Math.min(start + state.holdingsPageSize, rows.length)}</span><div><button class="button button--small" type="button" data-action="page-prev" ${state.holdingsPage <= 1 ? "disabled" : ""}>← Prev</button> <button class="button button--small" type="button" data-action="page-next" ${state.holdingsPage >= pages ? "disabled" : ""}>Next →</button></div></div>`;
  }

  function renderPortfolio() {
    const portfolio = currentPortfolio();
    const stats = portfolioStats(portfolio);
    const rows = portfolioRows(portfolio);
    const plan = allocationSummary(portfolio, rows);
    viewRoot.innerHTML = `
      ${pageHead(`${portfolio.name} · ${portfolio.allocation_basis === "maximum_loss" ? "Maximum loss basis" : "Cost basis"}`, portfolio.name, "Record what you bought or sold, then use the 100% plan to see how much room remains for each ticker.", `
        <button class="button button--ghost" type="button" data-action="cash-add">Add / withdraw money</button>
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
        <div class="toolbar"><div class="toolbar__filters"><input id="holding-search" type="search" value="${esc(state.holdingsQuery)}" placeholder="Search ticker or company" aria-label="Search assets"></div><div class="price-sync"><span class="meta">${portfolio.kind === "options" ? "Options use manual prices" : esc(priceFreshnessLabel())}</span><button class="button button--small" type="button" data-action="${portfolio.kind === "options" ? "refresh" : "price-refresh"}">${portfolio.kind === "options" ? "Refresh data" : "Update prices"}</button></div></div>
        <div id="holdings-region">${holdingsTable(portfolio)}</div>
      </section>`;
    const search = $("#holding-search");
    search?.addEventListener("input", () => {
      state.holdingsQuery = search.value;
      state.holdingsPage = 1;
      $("#holdings-region").innerHTML = holdingsTable(portfolio);
    });
  }

  const watchlistRangeCounts = { "1M": 32, "6M": 190, "1Y": 370, "2Y": 760 };

  function watchlistRows() {
    const instruments = instrumentMap();
    const prices = latestPriceMap();
    return state.watchlist.map((item) => ({
      ...item,
      instrument: instruments.get(item.instrument_id),
      price: prices.get(item.instrument_id)
    })).filter((item) => item.instrument);
  }

  function compactNumber(value) {
    return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(num(value));
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
    const canvas = $("#watchlist-chart");
    if (!canvas || !state.watchlistBars.length) return;
    const bars = state.watchlistBars;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const width = Math.max(canvas.clientWidth, 320);
    const height = Math.max(canvas.clientHeight, 360);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext("2d");
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, height);

    const plot = { left: 10, right: width - 68, top: 26, bottom: height - 112 };
    const volume = { top: height - 88, bottom: height - 30 };
    const lows = bars.map((bar) => num(bar.low));
    const highs = bars.map((bar) => num(bar.high));
    const minPrice = Math.min(...lows);
    const maxPrice = Math.max(...highs);
    const pricePad = Math.max((maxPrice - minPrice) * .06, maxPrice * .006);
    const low = minPrice - pricePad;
    const high = maxPrice + pricePad;
    const maxVolume = Math.max(...bars.map((bar) => num(bar.volume)), 1);
    const x = (index) => plot.left + (index + .5) / bars.length * (plot.right - plot.left);
    const y = (price) => plot.bottom - (price - low) / Math.max(high - low, .0001) * (plot.bottom - plot.top);
    const candleWidth = clamp((plot.right - plot.left) / bars.length * .62, 1, 11);

    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (let step = 0; step <= 5; step += 1) {
      const price = high - (high - low) * step / 5;
      const py = y(price);
      ctx.strokeStyle = "rgba(245,245,245,.09)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(plot.left, py); ctx.lineTo(plot.right, py); ctx.stroke();
      ctx.fillStyle = "#77746d";
      ctx.fillText(price.toFixed(price >= 100 ? 2 : 3), plot.right + 9, py);
    }

    bars.forEach((bar, index) => {
      const rising = num(bar.close) >= num(bar.open);
      const color = rising ? "#55b98d" : "#d32323";
      const cx = x(index);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, y(bar.high)); ctx.lineTo(cx, y(bar.low)); ctx.stroke();
      const bodyTop = Math.min(y(bar.open), y(bar.close));
      const bodyHeight = Math.max(Math.abs(y(bar.open) - y(bar.close)), 1);
      ctx.fillStyle = color;
      ctx.fillRect(cx - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
      const volumeHeight = num(bar.volume) / maxVolume * (volume.bottom - volume.top);
      ctx.globalAlpha = .45;
      ctx.fillRect(cx - candleWidth / 2, volume.bottom - volumeHeight, candleWidth, volumeHeight);
      ctx.globalAlpha = 1;
    });

    [[20, "#d4af37"], [50, "#f5f5f5"], [200, "#a50000"]].forEach(([period, color]) => {
      const values = movingAverage(bars, period);
      ctx.strokeStyle = color;
      ctx.lineWidth = period === 20 ? 1.6 : 1.2;
      ctx.beginPath();
      let started = false;
      values.forEach((value, index) => {
        if (value == null) return;
        if (!started) { ctx.moveTo(x(index), y(value)); started = true; }
        else ctx.lineTo(x(index), y(value));
      });
      if (started) ctx.stroke();
    });

    const labelIndexes = [0, Math.floor((bars.length - 1) / 2), bars.length - 1];
    ctx.fillStyle = "#77746d";
    ctx.textBaseline = "top";
    labelIndexes.forEach((index, labelIndex) => {
      const date = new Date(bars[index].time);
      ctx.textAlign = labelIndex === 0 ? "left" : labelIndex === 2 ? "right" : "center";
      ctx.fillText(date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: labelIndex === 2 ? "numeric" : undefined }), x(index), height - 19);
    });
  }

  function renderWatchlist() {
    const rows = watchlistRows();
    const selected = rows.find((item) => item.instrument_id === state.selectedWatchlistInstrumentId) || rows[0] || null;
    const bars = state.watchlistBars;
    const first = bars[0];
    const last = bars[bars.length - 1];
    const rangeChange = first && last ? num(last.close) - num(first.close) : 0;
    const rangeChangePercent = first && num(first.close) ? rangeChange / num(first.close) * 100 : 0;
    const dailyChange = bars.length > 1 ? num(last?.close) - num(bars[bars.length - 2]?.close) : 0;
    const dailyChangePercent = bars.length > 1 && num(bars[bars.length - 2]?.close) ? dailyChange / num(bars[bars.length - 2]?.close) * 100 : 0;

    viewRoot.innerHTML = `
      ${pageHead("Webull market data · Stocks and ETFs", "Watch the names that matter.", "A separate research list. Nothing here changes portfolio cash, positions or allocation.", `<button class="button button--primary" type="button" data-action="watchlist-add">+ Add ticker</button>`)}
      ${!state.watchlistReady ? `<div class="warning-box watchlist-setup"><strong>One setup step remains.</strong> Run <code>011_watchlist.sql</code> in Supabase, then refresh this page.</div>` : ""}
      <section class="watchlist-workbench" aria-label="Watchlist and Webull chart">
        <aside class="watchlist-rail">
          <div class="watchlist-rail__head"><div><span class="section-index">01 / WATCHLIST</span><h2>Your market tape.</h2></div><span class="meta">${rows.length} symbols</span></div>
          ${rows.length ? `<div class="watchlist-list">${rows.map((item) => {
            const isSelected = item.instrument_id === selected?.instrument_id;
            return `<button type="button" class="watchlist-row ${isSelected ? "is-active" : ""}" data-action="watchlist-chart" data-instrument-id="${item.instrument_id}">
              <span><strong>${esc(item.instrument.symbol)}</strong><small>${esc(item.instrument.display_name || item.instrument.asset_type)}</small></span>
              <span><strong class="mono">${item.price ? money(item.price.price, 4) : "—"}</strong><small>${item.price?.source === "webull" ? "WEBULL" : "WAITING FOR PRICE"}</small></span>
              <i aria-hidden="true">↗</i>
            </button>`;
          }).join("")}</div>` : `<div class="empty-state"><div><strong>Your watchlist is empty</strong>Add a US stock or ETF to open its Webull chart here.</div></div>`}
        </aside>
        <article class="market-chart-panel">
          ${selected ? `<header class="market-chart-head">
            <div><span class="section-index">02 / WEBULL DAILY BARS</span><h2>${esc(selected.instrument.symbol)}</h2><p>${esc(selected.instrument.display_name || selected.instrument.asset_type)}</p></div>
            <div class="market-chart-quote"><strong>${last ? money(last.close, 4) : selected.price ? money(selected.price.price, 4) : "—"}</strong><span class="${dailyChange >= 0 ? "positive" : "negative"}">${dailyChange > 0 ? "+" : ""}${dailyChange.toFixed(2)} · ${dailyChange > 0 ? "+" : ""}${dailyChangePercent.toFixed(2)}%</span></div>
          </header>
          <div class="market-chart-toolbar">
            <div class="range-switch" aria-label="Chart range">${Object.keys(watchlistRangeCounts).map((range) => `<button type="button" class="${range === state.watchlistRange ? "is-active" : ""}" data-action="watchlist-range" data-range="${range}">${range}</button>`).join("")}</div>
            <div class="chart-legend"><span class="ma20">MA20</span><span class="ma50">MA50</span><span class="ma200">MA200</span></div>
          </div>
          ${state.watchlistChartBusy ? `<div class="watchlist-chart-state"><span></span><p>Reading ${esc(selected.instrument.symbol)} bars from Webull…</p></div>` : bars.length ? `<canvas id="watchlist-chart" role="img" aria-label="${esc(selected.instrument.symbol)} daily candlestick chart with volume and moving averages"></canvas>` : `<div class="watchlist-chart-state"><p>Select a range to load Webull bars.</p></div>`}
          <footer class="market-chart-foot">
            <div><small>${state.watchlistRange} MOVE</small><strong class="${rangeChange >= 0 ? "positive" : "negative"}">${rangeChange > 0 ? "+" : ""}${rangeChangePercent.toFixed(2)}%</strong></div>
            <div><small>LATEST VOLUME</small><strong>${last ? compactNumber(last.volume) : "—"}</strong></div>
            <div><small>DATA SOURCE</small><strong>WEBULL · DAILY</strong></div>
            <button class="button button--small button--remove" type="button" data-action="watchlist-remove" data-instrument-id="${selected.instrument_id}">Remove</button>
          </footer>` : `<div class="market-chart-empty"><span>WEBULL / 00</span><h2>Add a ticker to begin.</h2><p>The chart is independent from your four portfolios and excludes options.</p></div>`}
        </article>
      </section>`;
    requestAnimationFrame(drawWatchlistChart);
  }

  function previewBars(symbol, count) {
    let seed = [...symbol].reduce((sum, char) => sum + char.charCodeAt(0), 0) || 100;
    let close = 80 + seed % 170;
    const rows = [];
    for (let index = count - 1; index >= 0; index -= 1) {
      seed = (seed * 9301 + 49297) % 233280;
      const change = (seed / 233280 - .47) * close * .035;
      const open = close;
      close = Math.max(open + change, 2);
      const date = new Date(); date.setUTCDate(date.getUTCDate() - index);
      rows.push({ time: date.toISOString(), open, close, high: Math.max(open, close) * 1.012, low: Math.min(open, close) * .988, volume: 800000 + seed * 70 });
    }
    return rows;
  }

  async function loadWatchlistBars(instrumentId = state.selectedWatchlistInstrumentId, range = state.watchlistRange) {
    if (!instrumentId || state.watchlistChartBusy) return;
    state.selectedWatchlistInstrumentId = instrumentId;
    state.watchlistRange = range;
    state.watchlistChartBusy = true;
    state.watchlistBars = [];
    renderWatchlist();
    try {
      if (localPreviewEnabled) {
        const symbol = instrumentMap().get(instrumentId)?.symbol || "DEMO";
        state.watchlistBars = previewBars(symbol, watchlistRangeCounts[range]);
      } else {
        const { data, error } = await db.functions.invoke("refresh-stock-prices", {
          body: { action: "chart", instrument_id: instrumentId, count: watchlistRangeCounts[range] }
        });
        if (error) {
          let detail = error.message;
          try { detail = (await error.context?.clone?.().json())?.error || detail; } catch (_) { /* Optional response body. */ }
          throw new Error(detail);
        }
        if (data?.error) throw new Error(data.error);
        state.watchlistBars = Array.isArray(data?.bars) ? data.bars : [];
        if (!state.watchlistBars.length) throw new Error("Webull returned no chart bars");
      }
    } catch (error) {
      toast(`Webull chart: ${friendlyError(error)}`, true);
    } finally {
      state.watchlistChartBusy = false;
      if (state.route === "watchlist") renderWatchlist();
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

  function openDialog({ kicker = "Dashboard action", title, body, submitLabel = "Save", onSubmit, danger = false, cancelLabel = "Cancel" }) {
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
    if (dialog.open) dialog.close();
  }

  async function rpc(name, args) {
    const { data, error } = await db.rpc(name, args);
    if (error) throw error;
    return data;
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
    openDialog({
      kicker: "Draft ready · Expires in 15 minutes", title: `Confirm ${kind}`, submitLabel: "Confirm and post",
      body: `<div class="preview-grid">${previewCells(draft.preview || {})}</div>${draft.preview?.warning ? `<div class="warning-box">${esc(draft.preview.warning.replaceAll("_", " "))}</div>` : ""}<p class="form-hint">The server will recalculate these values and apply the change atomically after confirmation.</p>`,
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
    const isOptions = portfolio.kind === "options";
    openDialog({
      kicker: `${portfolio.name} · 100% plan`, title: "Add a ticker to the plan", submitLabel: "Add to plan",
      body: `<div class="field-row"><label class="field"><span>${isOptions ? "Underlying symbol" : "Ticker symbol"}</span><input name="symbol" maxlength="20" placeholder="NVDA" required></label><label class="field"><span>Display name</span><input name="display_name" maxlength="160" placeholder="NVIDIA Corporation"></label></div>
        ${isOptions ? `<input name="asset_type" type="hidden" value="option">${optionFields()}` : `<label class="field"><span>Asset type</span><select name="asset_type"><option value="stock">Stock</option><option value="etf">ETF</option></select></label>`}
        <div class="field-row"><label class="field"><span>Target % of this portfolio</span><input name="target" type="number" min="0.01" max="100" step="0.01" required></label><label class="field"><span>Split into how many buys?</span><input name="tranches" type="number" min="1" max="20" step="1" value="3" required></label></div>
        <label class="field"><span>Notes (optional)</span><input name="notes" maxlength="500" placeholder="Why this ticker belongs in the plan"></label>
        <p class="form-hint">This only creates a plan. Use Buy after an order has filled; cash and average cost will update from that transaction.</p>`,
      onSubmit: async (form) => {
        const assetType = form.get("asset_type");
        const instrumentId = await rpc("api_upsert_instrument", {
          p_asset_type: assetType, p_symbol: String(form.get("symbol")).toUpperCase().trim(), p_display_name: form.get("display_name") || null,
          p_exchange: null, p_currency: "USD", p_option_type: isOptions ? form.get("option_type") : null,
          p_strike: isOptions ? num(form.get("strike")) : null, p_expiry: isOptions ? form.get("expiry") : null,
          p_multiplier: isOptions ? num(form.get("multiplier")) : 1
        });
        await rpc("api_set_allocation_target", {
          p_portfolio_id: portfolio.id, p_instrument_id: instrumentId, p_target_percent: num(form.get("target")),
          p_maximum_percent: null,
          p_planned_tranches: form.get("tranches") === "" ? null : num(form.get("tranches")), p_notes: form.get("notes") || null
        });
        closeDialog(); toast("Ticker added to the plan"); await loadData({ quiet: true });
      }
    });
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

  function openTradeDialog(sidePreset = "buy") {
    const portfolio = currentPortfolio();
    const options = portfolioInstrumentOptions(portfolio, sidePreset === "sell");
    if (!options) {
      toast(sidePreset === "sell" ? "There is no open position to sell" : "Add a ticker to the plan first", true);
      if (sidePreset === "buy") openAssetDialog();
      return;
    }
    const isOptions = portfolio.kind === "options";
    openDialog({
      kicker: `${portfolio.name} · Saved to Supabase`, title: `Record a ${sidePreset}`, submitLabel: `Review ${sidePreset}`,
      body: `<p class="form-hint">Enter the completed broker transaction. This app records it but never places an order.</p><label class="field"><span>Ticker</span><select name="instrument">${options}</select></label><input name="side" type="hidden" value="${sidePreset}"><div class="field-row"><label class="field"><span>Quantity</span><input name="quantity" type="number" min="0.00000001" step="0.00000001" required></label><label class="field"><span>Price per share</span><input name="price" type="number" min="0" step="0.0001" required></label></div><div class="field-row field-row--3"><label class="field"><span>Fee</span><input name="fee" type="number" min="0" step="0.01" value="0"></label><label class="field"><span>Buy tranche #</span><input name="tranche" type="number" min="1" max="20" step="1" ${sidePreset === "sell" ? "disabled" : ""}></label>${isOptions ? '<label class="field"><span>Underlying price</span><input name="underlying_price" type="number" min="0" step="0.01"></label>' : '<span></span>'}</div><label class="field"><span>Date and time</span><input name="executed" type="datetime-local" value="${localDateTime()}" required></label>`,
      onSubmit: async (form) => {
        const draft = await rpc("api_create_trade_draft", {
          p_portfolio_id: portfolio.id, p_instrument_id: form.get("instrument"), p_side: form.get("side"),
          p_quantity: num(form.get("quantity")), p_price: num(form.get("price")), p_idempotency_key: uid("web-trade"),
          p_fee: num(form.get("fee")), p_executed_at: new Date(form.get("executed")).toISOString(),
          p_tranche_number: form.get("tranche") ? num(form.get("tranche")) : null,
          p_underlying_price: isOptions && form.get("underlying_price") !== "" ? num(form.get("underlying_price")) : null, p_campaign_id: null
        });
        openDraftConfirmation("trade fill", draft, (id, token) => rpc("api_confirm_trade_draft", { p_draft_id: id, p_confirmation_token: token }));
      }
    });
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

  function openAccountDialog() {
    openDialog({
      kicker: "Authenticated session", title: "Account", submitLabel: "Sign out", danger: true,
      body: `<div class="preview-grid"><div class="preview-cell"><small>Signed in as</small><strong>${esc(state.user?.email || "Supabase user")}</strong></div><div class="preview-cell"><small>Data source</small><strong>Supabase / RLS</strong></div></div><p class="form-hint">Financial records are not cached in this app. Signing out clears the active Supabase session from this device.</p>`,
      onSubmit: async () => { await db.auth.signOut(); closeDialog(); showAuth(); }
    });
  }

  async function handleClick(event) {
    const routeButton = event.target.closest("[data-route]");
    if (routeButton) {
      state.route = routeButton.dataset.route;
      window.scrollTo(0, 0);
      renderNav();
      if (state.route === "journal") await loadJournalPage();
      else {
        render();
        if (state.route === "watchlist" && state.selectedWatchlistInstrumentId && !state.watchlistBars.length) {
          await loadWatchlistBars();
        }
      }
      return;
    }
    const portfolioButton = event.target.closest("[data-portfolio-id]");
    if (portfolioButton) { state.selectedPortfolioId = portfolioButton.dataset.portfolioId; state.route = "portfolio"; state.holdingsPage = 1; state.holdingsQuery = ""; window.scrollTo(0, 0); render(); return; }
    const openPortfolio = event.target.closest("[data-open-portfolio]");
    if (openPortfolio) { state.selectedPortfolioId = openPortfolio.dataset.openPortfolio; state.route = "portfolio"; window.scrollTo(0, 0); render(); return; }
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (action === "close-dialog") closeDialog();
    else if (action === "refresh") await loadData();
    else if (action === "price-refresh") await refreshStockPrices({ force: true, notify: true });
    else if (action === "watchlist-add") openWatchlistDialog();
    else if (action === "watchlist-chart") await loadWatchlistBars(target.dataset.instrumentId, state.watchlistRange);
    else if (action === "watchlist-range") await loadWatchlistBars(state.selectedWatchlistInstrumentId, target.dataset.range);
    else if (action === "watchlist-remove") openRemoveWatchlistDialog(target.dataset.instrumentId);
    else if (action === "account") openAccountDialog();
    else if (action === "budget-edit") openBudgetDialog();
    else if (action === "cash-add") openCashDialog();
    else if (action === "asset-add") openAssetDialog();
    else if (action === "trade-add" || action === "trade-buy") openTradeDialog("buy");
    else if (action === "trade-sell") openTradeDialog("sell");
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
      if (state.route === "watchlist") drawWatchlistChart();
    }, 120);
  });
  window.setInterval(() => refreshStockPrices(), 15 * 60_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshStockPrices();
  });

  db.auth.onAuthStateChange((event, session) => {
    if (localPreviewEnabled) return;
    if (event === "SIGNED_OUT" || !session?.user) showAuth();
  });

  function loadLocalPreview() {
    const portfolios = [
      { id: "p-long", kind: "long_term", name: "Long Term", fixed_budget: 40000, allocation_basis: "cost_basis", sort_order: 1, is_active: true },
      { id: "p-swing", kind: "swing_trade", name: "Swing Trade", fixed_budget: 18000, allocation_basis: "cost_basis", sort_order: 2, is_active: true },
      { id: "p-spec", kind: "speculative", name: "Speculative", fixed_budget: 10000, allocation_basis: "cost_basis", sort_order: 3, is_active: true },
      { id: "p-opt", kind: "options", name: "Options", fixed_budget: 8000, allocation_basis: "maximum_loss", sort_order: 4, is_active: true }
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
    Object.assign(state, { user: { email: "preview@local" }, portfolios, instruments, positions, targets, cash, capacities, journalPreviewSource: journal, prices: [], watchlist, selectedPortfolioId: "p-long", selectedWatchlistInstrumentId: "i-nvda" });
    state.journalOverview = localJournalView({ page: 1, pageSize: 6 });
    applyJournalView(localJournalView({ page: 1, pageSize: state.journalPageSize }));
    authShell.hidden = true;
    appShell.hidden = false;
    setSync(true, "Local preview");
    render();
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
