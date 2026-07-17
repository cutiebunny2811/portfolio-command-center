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
  const localPreviewEnabled = ["127.0.0.1", "localhost"].includes(location.hostname)
    && localPreviewParams.get("preview") === "1";
  const localStressEnabled = localPreviewEnabled && localPreviewParams.get("stress") === "1";

  const state = {
    user: null,
    portfolios: [], cash: [], positions: [], instruments: [], targets: [], capacities: [],
    journal: [], journalPreviewSource: [], journalOverview: null, journalSummary: null,
    journalDaily: [], journalMonthly: [], journalTotal: 0, journalPage: 1, journalPageSize: 50,
    journalFilter: "all", journalOutcome: "all", journalSearch: "", journalDateFrom: "", journalDateTo: "",
    journalFiltersOpen: false,
    journalBusy: false, prices: [], route: "overview", selectedPortfolioId: null,
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

  function portfolioStats(portfolio) {
    const positions = state.positions.filter((item) => item.portfolio_id === portfolio.id && num(item.quantity) > 0);
    const cash = num(state.cash.find((item) => item.portfolio_id === portfolio.id)?.cash_balance);
    const deployed = positions.reduce((sum, item) => sum + (
      portfolio.allocation_basis === "maximum_loss" ? num(item.maximum_loss) : num(item.cost_basis)
    ), 0);
    const budget = num(portfolio.fixed_budget);
    const remaining = Math.max(budget - deployed, 0);
    const utilization = budget > 0 ? deployed / budget * 100 : 0;
    const prices = latestPriceMap();
    const instruments = instrumentMap();
    const marketValue = positions.reduce((sum, item) => {
      const price = prices.get(item.instrument_id);
      const instrument = instruments.get(item.instrument_id);
      return sum + (price ? num(price.price) * num(item.quantity) * num(instrument?.multiplier || 1) : 0);
    }, 0);
    return { positions, cash, deployed, budget, remaining, utilization, marketValue };
  }

  function combinedStats() {
    const stats = state.portfolios.map(portfolioStats);
    return {
      budget: stats.reduce((sum, item) => sum + item.budget, 0),
      cash: stats.reduce((sum, item) => sum + item.cash, 0),
      deployed: stats.reduce((sum, item) => sum + item.deployed, 0),
      pnl: num(state.journalOverview?.summary?.net_pnl)
    };
  }

  function portfolioRows(portfolio) {
    const instruments = instrumentMap();
    const positions = new Map(
      state.positions.filter((item) => item.portfolio_id === portfolio.id).map((item) => [item.instrument_id, item])
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
      const deployed = portfolio.allocation_basis === "maximum_loss"
        ? num(position?.maximum_loss)
        : num(position?.cost_basis);
      const currentPercent = num(portfolio.fixed_budget) > 0 ? deployed / num(portfolio.fixed_budget) * 100 : 0;
      const targetPercent = num(target?.target_percent);
      const maximumPercent = target?.maximum_percent == null ? targetPercent : num(target.maximum_percent);
      const remaining = capacity ? num(capacity.actionable_buy_amount) : Math.max(num(portfolio.fixed_budget) * targetPercent / 100 - deployed, 0);
      let status = "Unplanned", statusClass = "warn";
      if (target) {
        if (maximumPercent > 0 && currentPercent > maximumPercent + .001) { status = "Over limit"; statusClass = "risk"; }
        else if (targetPercent > 0 && currentPercent < targetPercent * .9) { status = "Capacity"; statusClass = "warn"; }
        else { status = "On plan"; statusClass = "good"; }
      }
      return { id, instrument, position, target, capacity, deployed, currentPercent, targetPercent, maximumPercent, remaining, status, statusClass };
    }).sort((a, b) => b.deployed - a.deployed || a.instrument.symbol.localeCompare(b.instrument.symbol));
  }

  async function query(label, promise) {
    const { data, error } = await promise;
    if (error) throw new Error(`${label}: ${error.message}`);
    return data || [];
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

  async function loadData({ quiet = false } = {}) {
    if (!state.user || state.loading) return;
    if (!quiet) setLoading(true);
    setSync(true, "Syncing…");
    try {
      const [portfolios, cash, positions, instruments, targets, capacities, prices, journalOverview] = await Promise.all([
        query("Portfolios", db.from("portfolios").select("*").eq("is_active", true).order("sort_order")),
        query("Cash balances", db.from("portfolio_cash_balances").select("*")),
        query("Positions", db.from("position_balances").select("*")),
        query("Instruments", db.from("instruments").select("*").order("symbol")),
        query("Allocation targets", db.from("allocation_targets").select("*").eq("is_active", true)),
        query("Position capacity", db.from("position_capacity").select("*")),
        query("Prices", db.from("instrument_prices").select("*").order("fetched_at", { ascending: false }).limit(2000)),
        fetchJournalView({ page: 1, pageSize: 6 })
      ]);
      Object.assign(state, { portfolios, cash, positions, instruments, targets, capacities, prices, journalOverview });
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
  }

  function renderNav() {
    const nav = $("#portfolio-nav");
    const switcher = $("#portfolio-switcher");
    nav.innerHTML = state.portfolios.map((portfolio) => {
      const stats = portfolioStats(portfolio);
      return `<button type="button" class="${portfolio.id === state.selectedPortfolioId ? "is-active" : ""}" data-portfolio-id="${portfolio.id}">
        <i></i><span>${esc(portfolio.name)}</span><small>${Math.round(stats.utilization)}%</small>
      </button>`;
    }).join("");
    switcher.innerHTML = state.portfolios.map((portfolio) => `<button type="button" class="${portfolio.id === state.selectedPortfolioId ? "is-active" : ""}" data-portfolio-id="${portfolio.id}">${esc(portfolio.name)}</button>`).join("");
    $$('[data-route]').forEach((button) => button.classList.toggle("is-active", button.dataset.route === state.route));
    $$(".mobile-nav button").forEach((button) => button.classList.toggle("is-active", button.dataset.route === state.route));
  }

  function render() {
    renderNav();
    if (!state.portfolios.length) {
      viewRoot.innerHTML = `<div class="empty-state"><div><strong>No portfolios found</strong>Sign out and confirm that the four portfolio bootstrap rows exist for this Auth user.</div></div>`;
      return;
    }
    if (state.route === "portfolio") renderPortfolio();
    else if (state.route === "journal") renderJournalPaged();
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
    const capacityItems = state.capacities.map((capacity) => {
      const portfolio = state.portfolios.find((item) => item.id === capacity.portfolio_id);
      return { ...capacity, portfolio, instrument: instruments.get(capacity.instrument_id) };
    }).filter((item) => item.portfolio && item.instrument).sort((a, b) => num(b.actionable_buy_amount) - num(a.actionable_buy_amount)).slice(0, 8);

    viewRoot.innerHTML = `
      ${pageHead("All portfolios · Independent capital pools", "Capital discipline at a glance.", "Combined visibility without combining allocation math. Every limit, cash balance and remaining buy capacity stays inside its own portfolio.", '<button class="button button--primary" type="button" data-action="journal-add">+ Add P/L entry</button>')}
      <section class="hero-ledger" aria-label="Combined summary">
        <div class="hero-metric hero-metric--lead"><small>Total fixed capital<br>4 isolated budgets</small><strong>${money(total.budget)}</strong></div>
        <div class="hero-metric"><small>Capital deployed<br>Cost / max loss</small><strong>${money(total.deployed)}</strong></div>
        <div class="hero-metric"><small>Available cash<br>Across all portfolios</small><strong>${money(total.cash)}</strong></div>
        <div class="hero-metric"><small>Journal net P/L<br>Manual closed trades</small><strong class="${total.pnl > 0 ? "positive" : total.pnl < 0 ? "negative" : ""}">${money(total.pnl)}</strong></div>
      </section>

      <section class="section">
        <div class="section-head"><div><span class="section-index">01 / PORTFOLIOS</span><h2>Four mandates. Four limits.</h2></div><p>Select a portfolio to see its positions, target capacity and cash workflow.</p></div>
        <div class="portfolio-grid">
          ${state.portfolios.map((portfolio, index) => {
            const stats = portfolioStats(portfolio);
            return `<button class="portfolio-card" type="button" data-open-portfolio="${portfolio.id}">
              <div class="portfolio-card__title"><span>0${index + 1}</span><h3>${esc(portfolio.name)}</h3></div>
              <div class="portfolio-card__numbers">
                <div><small>Fixed budget</small><strong>${money(stats.budget)}</strong></div>
                <div><small>Deployed</small><strong>${money(stats.deployed)}</strong></div>
                <div><small>Cash</small><strong>${money(stats.cash)}</strong></div>
              </div>
              <div><div class="meter ${stats.utilization > 100 ? "is-risk" : ""}" style="--meter:${clamp(stats.utilization, 0, 100)}%"><i></i></div><p class="meta">${percent(stats.utilization)} utilized · ${stats.positions.length} active position${stats.positions.length === 1 ? "" : "s"}</p></div>
            </button>`;
          }).join("")}
        </div>
      </section>

      <section class="section split-grid">
        <div>
          <div class="section-head"><div><span class="section-index">02 / CAPACITY</span><h2>Next capital available.</h2></div></div>
          ${capacityItems.length ? `<div class="ledger-list">${capacityItems.map((item) => `<div class="ledger-row">
            <div class="ledger-row__main"><strong>${esc(item.instrument.symbol)} · ${esc(item.portfolio.name)}</strong><small>Target ${percent(item.target_percent)} · Deployed ${money(item.deployed_amount)}</small></div>
            <div class="ledger-row__value gold">${money(item.actionable_buy_amount)}<small>buy capacity</small></div>
          </div>`).join("")}</div>` : `<div class="empty-state"><div><strong>No allocation targets yet</strong>Add an asset and target inside a portfolio to calculate buy capacity.</div></div>`}
        </div>
        <div>
          <div class="section-head"><div><span class="section-index">03 / JOURNAL</span><h2>Latest P/L.</h2></div><button class="button button--small" type="button" data-route="journal">View all</button></div>
          ${recent.length ? `<div class="ledger-list">${recent.map((entry) => {
            const portfolio = state.portfolios.find((item) => item.id === entry.portfolio_id);
            const instrument = instruments.get(entry.instrument_id);
            return `<div class="ledger-row"><div class="ledger-row__main"><strong>${esc(instrument?.symbol || entry.strategy_label || "Trade")}</strong><small>${esc(portfolio?.name || "Portfolio")} · ${esc(entry.occurred_on)}</small></div><div class="ledger-row__value ${num(entry.manual_pnl) >= 0 ? "positive" : "negative"}">${money(entry.manual_pnl)}</div></div>`;
          }).join("")}</div>` : `<div class="empty-state"><div><strong>No P/L entries yet</strong>Record a closed trade without changing cash or position balances.</div></div>`}
        </div>
      </section>`;
  }

  function allocationMap(portfolio, rows) {
    const top = [...rows].sort((a, b) => Math.max(b.currentPercent, b.targetPercent) - Math.max(a.currentPercent, a.targetPercent)).slice(0, 8);
    if (!top.length) return `<div class="empty-state"><div><strong>No assets planned</strong>Add an asset to start this portfolio's allocation map.</div></div>`;
    return `<div class="allocation-map">${top.map((row) => {
      const scale = Math.max(row.maximumPercent || row.targetPercent || 1, row.currentPercent, 1);
      return `<div class="allocation-row">
        <div class="allocation-row__symbol"><strong>${esc(row.instrument.symbol)}</strong><small>${esc(row.instrument.display_name || row.instrument.asset_type)}</small></div>
        <div class="allocation-track" style="--current:${clamp(row.currentPercent / scale * 100, 0, 100)}%;--target:${clamp(row.targetPercent / scale * 100, 0, 100)}%"><i></i><b></b></div>
        <div class="allocation-row__number">${percent(row.currentPercent)}<small>current</small></div>
        <div class="allocation-row__number gold">${money(row.remaining)}<small>can add</small></div>
      </div>`;
    }).join("")}</div>`;
  }

  function holdingsTable(portfolio) {
    let rows = portfolioRows(portfolio);
    const queryText = state.holdingsQuery.trim().toLowerCase();
    if (queryText) rows = rows.filter((row) => `${row.instrument.symbol} ${row.instrument.display_name || ""}`.toLowerCase().includes(queryText));
    const pages = Math.max(1, Math.ceil(rows.length / state.holdingsPageSize));
    state.holdingsPage = clamp(state.holdingsPage, 1, pages);
    const start = (state.holdingsPage - 1) * state.holdingsPageSize;
    const slice = rows.slice(start, start + state.holdingsPageSize);
    if (!slice.length) return `<div class="empty-state"><div><strong>${queryText ? "No matching assets" : "No holdings yet"}</strong>${queryText ? "Try another symbol or company name." : "Use Add asset to create a target or opening position."}</div></div>`;
    return `<div class="table-shell"><table>
      <thead><tr><th>Asset</th><th>Quantity / avg</th><th>Deployed</th><th>Current</th><th>Target / max</th><th>Can add now</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${slice.map((row) => `<tr>
        <td><span class="cell-main">${esc(row.instrument.symbol)}</span><span class="cell-sub">${esc(row.instrument.display_name || row.instrument.asset_type)}</span></td>
        <td><span class="cell-main mono">${num(row.position?.quantity).toLocaleString("en-US", { maximumFractionDigits: 8 })}</span><span class="cell-sub">AVG ${money(row.position?.average_cost, 4)}</span></td>
        <td><strong class="mono">${money(row.deployed)}</strong>${portfolio.kind === "options" ? `<span class="cell-sub">NOTIONAL ${money(row.position?.notional_value)}</span>` : ""}</td>
        <td class="mono">${percent(row.currentPercent)}</td>
        <td><span class="cell-main mono">${percent(row.targetPercent)} / ${percent(row.maximumPercent)}</span><span class="cell-sub">${row.target?.planned_tranches ? `${row.target.planned_tranches} planned tranches` : "No tranche plan"}</span></td>
        <td><strong class="mono gold">${money(row.remaining)}</strong></td>
        <td><span class="status status--${row.statusClass}">${esc(row.status)}</span></td>
        <td><div class="row-actions"><button class="button button--small" type="button" data-action="target-edit" data-instrument-id="${row.id}">Target</button><button class="button button--small" type="button" data-action="price-record" data-instrument-id="${row.id}">Price</button></div></td>
      </tr>`).join("")}</tbody>
    </table></div><div class="pagination"><span>${rows.length} assets · showing ${start + 1}–${Math.min(start + state.holdingsPageSize, rows.length)}</span><div><button class="button button--small" type="button" data-action="page-prev" ${state.holdingsPage <= 1 ? "disabled" : ""}>← Prev</button> <button class="button button--small" type="button" data-action="page-next" ${state.holdingsPage >= pages ? "disabled" : ""}>Next →</button></div></div>`;
  }

  function renderPortfolio() {
    const portfolio = currentPortfolio();
    const stats = portfolioStats(portfolio);
    const rows = portfolioRows(portfolio);
    viewRoot.innerHTML = `
      ${pageHead(`${portfolio.name} · ${portfolio.allocation_basis === "maximum_loss" ? "Maximum loss basis" : "Cost basis"}`, portfolio.name, "Allocation, cash and trade fills below apply only to this portfolio. Recording a fill never places a broker order.", `
        <button class="button button--ghost" type="button" data-action="budget-edit">Edit budget</button>
        <button class="button button--ghost" type="button" data-action="cash-add">Cash movement</button>
        <button class="button button--ghost" type="button" data-action="trade-add">Record fill</button>
        <button class="button button--primary" type="button" data-action="asset-add">+ Add asset</button>`)}
      <section class="kpi-strip" aria-label="Portfolio summary">
        <div class="kpi"><small>Fixed portfolio budget</small><strong>${money(stats.budget)}</strong></div>
        <div class="kpi"><small>${portfolio.kind === "options" ? "Maximum loss deployed" : "Cost deployed"}</small><strong>${money(stats.deployed)}</strong></div>
        <div class="kpi"><small>Cash available</small><strong>${money(stats.cash)}</strong></div>
        <div class="kpi"><small>Budget capacity left</small><strong class="gold">${money(stats.remaining)}</strong></div>
      </section>
      <section class="section">
        <div class="section-head"><div><span class="section-index">01 / ALLOCATION MAP</span><h2>Planned versus deployed.</h2></div><p>Top eight assets are visualized here. The full searchable ledger below scales to hundreds.</p></div>
        ${allocationMap(portfolio, rows)}
      </section>
      <section class="section">
        <div class="section-head"><div><span class="section-index">02 / ASSET LEDGER</span><h2>Every position and target.</h2></div><p>${rows.length} assets in this portfolio · 25 rows per page</p></div>
        <div class="toolbar"><div class="toolbar__filters"><input id="holding-search" type="search" value="${esc(state.holdingsQuery)}" placeholder="Search symbol or company" aria-label="Search assets"></div><button class="button button--small" type="button" data-action="refresh">Refresh from Supabase</button></div>
        <div id="holdings-region">${holdingsTable(portfolio)}</div>
      </section>`;
    const search = $("#holding-search");
    search?.addEventListener("input", () => {
      state.holdingsQuery = search.value;
      state.holdingsPage = 1;
      $("#holdings-region").innerHTML = holdingsTable(portfolio);
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
    ctx.strokeStyle = "#2f2922"; ctx.lineWidth = 1; ctx.setLineDash([4, 5]);
    ctx.beginPath(); ctx.moveTo(pad.left, y(0)); ctx.lineTo(width - pad.right, y(0)); ctx.stroke(); ctx.setLineDash([]);
    const final = points.at(-1), line = final >= 0 ? "#d7aa4b" : "#ff665b";
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
    const refinedFilterCount = [state.journalOutcome !== "all", state.journalDateFrom, state.journalDateTo, state.journalSearch].filter(Boolean).length;

    viewRoot.innerHTML = `
      ${pageHead("Trading journal · Closed-trade performance", "P/L without the spreadsheet drift.", "Journal entries measure realized performance by portfolio. They do not edit cash, holdings or broker records.", '<button class="button button--primary" type="button" data-action="journal-add">+ Add P/L entry</button>')}
      <div class="journal-commandbar">
        <div class="journal-commandbar__controls">
          <label class="journal-primary-filter"><span>Portfolio</span><select id="journal-filter-primary" aria-label="Filter journal by portfolio"><option value="all">All portfolios</option>${state.portfolios.map((p) => `<option value="${p.id}" ${state.journalFilter === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
          <button class="button button--small journal-refine-button" type="button" data-action="journal-filter-toggle" aria-expanded="${state.journalFiltersOpen}">Refine${refinedFilterCount ? `<b>${refinedFilterCount}</b>` : ""}</button>
        </div>
        <span class="journal-commandbar__count">${state.journalTotal.toLocaleString()} active ${state.journalTotal === 1 ? "entry" : "entries"}</span>
      </div>
      <form class="journal-filters" id="journal-filter-form" ${state.journalFiltersOpen ? "" : "hidden"}>
        <label><span>Outcome</span><select name="outcome"><option value="all">All outcomes</option><option value="win" ${state.journalOutcome === "win" ? "selected" : ""}>Win</option><option value="loss" ${state.journalOutcome === "loss" ? "selected" : ""}>Loss</option><option value="breakeven" ${state.journalOutcome === "breakeven" ? "selected" : ""}>Breakeven</option></select></label>
        <label><span>From</span><input name="date_from" type="date" value="${esc(state.journalDateFrom)}"></label>
        <label><span>To</span><input name="date_to" type="date" value="${esc(state.journalDateTo)}"></label>
        <label class="journal-filters__search"><span>Search ledger</span><input name="search" type="search" maxlength="100" value="${esc(state.journalSearch)}" placeholder="Symbol, strategy or notes"></label>
        <div class="journal-filters__actions"><button class="button button--primary button--small" type="submit">Apply filters</button><button class="button button--ghost button--small" type="button" data-action="journal-filter-clear">Clear</button></div>
      </form>
      <section class="kpi-strip" aria-label="Trading performance">
        <div class="kpi"><small>Net P/L</small><strong class="${num(stats.net_pnl) > 0 ? "positive" : num(stats.net_pnl) < 0 ? "negative" : ""}">${money(stats.net_pnl)}</strong></div>
        <div class="kpi"><small>Win rate</small><strong>${percent(winRate, 0)}</strong></div>
        <div class="kpi"><small>Profit factor</small><strong>${profitFactor === Infinity ? "∞" : profitFactor ? profitFactor.toFixed(2) : "—"}</strong></div>
        <div class="kpi"><small>Avg win / loss</small><strong>${compactMoney(stats.avg_win)} / ${compactMoney(stats.avg_loss)}</strong></div>
      </section>
      <section class="section journal-layout">
        <div>
          <div class="section-head"><div><span class="section-index">01 / EQUITY CURVE</span><h2>Cumulative closed P/L.</h2></div></div>
          <div class="chart-panel">${state.journalDaily.length ? '<canvas id="equity-chart" role="img" aria-label="Cumulative profit and loss curve"></canvas>' : '<div class="empty-state"><div><strong>No P/L data in this view</strong>Adjust the filters or add a journal entry.</div></div>'}</div>
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
        }).join("")}</tbody></table></div><div class="pagination"><span>${start.toLocaleString()}–${end.toLocaleString()} of ${state.journalTotal.toLocaleString()}</span><div><button class="button button--small" type="button" data-action="journal-page-prev" ${state.journalPage <= 1 ? "disabled" : ""}>← Prev</button> <span class="pagination__page">Page ${state.journalPage} / ${pages}</span> <button class="button button--small" type="button" data-action="journal-page-next" ${state.journalPage >= pages ? "disabled" : ""}>Next →</button></div></div>` : `<div class="empty-state"><div><strong>No journal entries in this view</strong>Adjust the filters or record a closed trade.</div></div>`}
      </section>`;

    $("#journal-filter-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const from = form.get("date_from") || "";
      const to = form.get("date_to") || "";
      if (from && to && from > to) { toast("Start date must be on or before end date", true); return; }
      state.journalOutcome = form.get("outcome");
      state.journalDateFrom = from;
      state.journalDateTo = to;
      state.journalSearch = String(form.get("search") || "").trim();
      state.journalPage = 1;
      state.journalFiltersOpen = false;
      await loadJournalPage();
    });
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
    ctx.strokeStyle = "#2f2922"; ctx.lineWidth = 1; ctx.setLineDash([4, 5]);
    ctx.beginPath(); ctx.moveTo(pad.left, y(0)); ctx.lineTo(width - pad.right, y(0)); ctx.stroke(); ctx.setLineDash([]);
    const final = points.at(-1), line = final >= 0 ? "#d7aa4b" : "#ff665b";
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
    return `<div id="option-fields"><div class="field-row field-row--3"><label class="field"><span>Option type</span><select name="option_type"><option value="call">Call</option><option value="put">Put</option></select></label><label class="field"><span>Strike</span><input name="strike" type="number" min="0" step="0.01" required></label><label class="field"><span>Expiry</span><input name="expiry" type="date" required></label></div><div class="field-row field-row--3"><label class="field"><span>Multiplier</span><input name="multiplier" type="number" min="1" step="1" value="100" required></label><label class="field"><span>Maximum loss</span><input name="maximum_loss" type="number" min="0" step="0.01" placeholder="Defaults to premium"></label><label class="field"><span>Notional value</span><input name="notional" type="number" min="0" step="0.01" placeholder="Exposure only"></label></div></div>`;
  }

  function openAssetDialog() {
    const portfolio = currentPortfolio();
    const isOptions = portfolio.kind === "options";
    openDialog({
      kicker: `${portfolio.name} · Opening state`, title: "Add asset or target", submitLabel: "Save asset",
      body: `<div class="field-row"><label class="field"><span>${isOptions ? "Underlying symbol" : "Ticker symbol"}</span><input name="symbol" maxlength="20" placeholder="NVDA" required></label><label class="field"><span>Display name</span><input name="display_name" maxlength="160" placeholder="NVIDIA Corporation"></label></div>
        ${isOptions ? `<input name="asset_type" type="hidden" value="option">${optionFields()}` : `<div class="field-row"><label class="field"><span>Asset type</span><select name="asset_type"><option value="stock">Stock</option><option value="etf">ETF</option></select></label><label class="field"><span>Exchange</span><input name="exchange" maxlength="30" placeholder="NASDAQ"></label></div>`}
        <div class="field-row field-row--3"><label class="field"><span>Current quantity</span><input name="quantity" type="number" min="0" step="0.00000001" value="0" required></label><label class="field"><span>Average cost</span><input name="average_cost" type="number" min="0" step="0.0001" value="0" required></label><label class="field"><span>As of date</span><input name="as_of" type="date" value="${today()}" required></label></div>
        <div class="field-row field-row--3"><label class="field"><span>Target %</span><input name="target" type="number" min="0" max="100" step="0.01" required></label><label class="field"><span>Maximum %</span><input name="maximum" type="number" min="0" max="100" step="0.01"></label><label class="field"><span>Planned tranches</span><input name="tranches" type="number" min="1" max="20" step="1"></label></div>
        <div class="field-row"><label class="field"><span>Current market price (optional)</span><input name="current_price" type="number" min="0" step="0.0001"></label><label class="field"><span>Notes</span><input name="notes" maxlength="500"></label></div>
        <div class="warning-box">Quantity 0 creates a planning target only. A positive quantity creates the current opening position; this snapshot locks once trade executions exist.</div>`,
      onSubmit: async (form) => {
        const assetType = form.get("asset_type");
        const instrumentId = await rpc("api_upsert_instrument", {
          p_asset_type: assetType, p_symbol: String(form.get("symbol")).toUpperCase().trim(), p_display_name: form.get("display_name") || null,
          p_exchange: form.get("exchange") || null, p_currency: "USD", p_option_type: isOptions ? form.get("option_type") : null,
          p_strike: isOptions ? num(form.get("strike")) : null, p_expiry: isOptions ? form.get("expiry") : null,
          p_multiplier: isOptions ? num(form.get("multiplier")) : 1
        });
        const quantity = num(form.get("quantity"));
        if (quantity > 0) await rpc("api_set_opening_position", {
          p_portfolio_id: portfolio.id, p_instrument_id: instrumentId, p_quantity: quantity, p_average_cost: num(form.get("average_cost")),
          p_as_of_date: form.get("as_of"), p_maximum_loss: isOptions && form.get("maximum_loss") !== "" ? num(form.get("maximum_loss")) : null,
          p_notional_value: isOptions && form.get("notional") !== "" ? num(form.get("notional")) : null, p_notes: form.get("notes") || null
        });
        await rpc("api_set_allocation_target", {
          p_portfolio_id: portfolio.id, p_instrument_id: instrumentId, p_target_percent: num(form.get("target")),
          p_maximum_percent: form.get("maximum") === "" ? null : num(form.get("maximum")),
          p_planned_tranches: form.get("tranches") === "" ? null : num(form.get("tranches")), p_notes: form.get("notes") || null
        });
        if (form.get("current_price") !== "") await rpc("api_record_instrument_price", {
          p_instrument_id: instrumentId, p_price: num(form.get("current_price")), p_market_time: new Date().toISOString(), p_source: "manual"
        });
        closeDialog(); toast("Asset and allocation saved"); await loadData({ quiet: true });
      }
    });
  }

  function openTargetDialog(instrumentId) {
    const portfolio = currentPortfolio();
    const instrument = instrumentMap().get(instrumentId);
    const target = state.targets.find((item) => item.portfolio_id === portfolio.id && item.instrument_id === instrumentId);
    openDialog({
      kicker: `${portfolio.name} · ${instrument?.symbol || "Asset"}`, title: "Edit allocation target", submitLabel: "Update target",
      body: `<div class="field-row field-row--3"><label class="field"><span>Target %</span><input name="target" type="number" min="0" max="100" step="0.01" value="${num(target?.target_percent)}" required></label><label class="field"><span>Maximum %</span><input name="maximum" type="number" min="0" max="100" step="0.01" value="${target?.maximum_percent ?? ""}"></label><label class="field"><span>Planned tranches</span><input name="tranches" type="number" min="1" max="20" step="1" value="${target?.planned_tranches ?? ""}"></label></div><label class="field"><span>Plan notes</span><textarea name="notes" maxlength="2000">${esc(target?.notes || "")}</textarea></label><p class="form-hint">All active targets in this portfolio must total 100% or less.</p>`,
      onSubmit: async (form) => {
        await rpc("api_set_allocation_target", { p_portfolio_id: portfolio.id, p_instrument_id: instrumentId, p_target_percent: num(form.get("target")), p_maximum_percent: form.get("maximum") === "" ? null : num(form.get("maximum")), p_planned_tranches: form.get("tranches") === "" ? null : num(form.get("tranches")), p_notes: form.get("notes") || null });
        closeDialog(); toast("Allocation target updated"); await loadData({ quiet: true });
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

  function portfolioInstrumentOptions(portfolio) {
    const ids = new Set(portfolioRows(portfolio).map((row) => row.id));
    return state.instruments.filter((item) => ids.has(item.id)).map((item) => `<option value="${item.id}">${esc(item.symbol)} · ${esc(item.display_name || item.asset_type)}</option>`).join("");
  }

  function openTradeDialog() {
    const portfolio = currentPortfolio();
    const options = portfolioInstrumentOptions(portfolio);
    if (!options) { toast("Add an asset to this portfolio before recording a fill", true); openAssetDialog(); return; }
    const isOptions = portfolio.kind === "options";
    openDialog({
      kicker: `${portfolio.name} · Draft → Confirm`, title: "Record a broker fill", submitLabel: "Preview fill",
      body: `<div class="warning-box">This records a completed broker fill. It does not connect to a broker and cannot place a live order.</div><label class="field"><span>Asset</span><select name="instrument">${options}</select></label><div class="field-row field-row--3"><label class="field"><span>Side</span><select name="side"><option value="buy">Buy</option><option value="sell">Sell</option></select></label><label class="field"><span>Quantity</span><input name="quantity" type="number" min="0.00000001" step="0.00000001" required></label><label class="field"><span>Fill price</span><input name="price" type="number" min="0" step="0.0001" required></label></div><div class="field-row field-row--3"><label class="field"><span>Fee</span><input name="fee" type="number" min="0" step="0.01" value="0"></label><label class="field"><span>Tranche #</span><input name="tranche" type="number" min="1" max="20" step="1"></label>${isOptions ? '<label class="field"><span>Underlying price</span><input name="underlying_price" type="number" min="0" step="0.01"></label>' : '<span></span>'}</div><label class="field"><span>Executed at</span><input name="executed" type="datetime-local" value="${localDateTime()}" required></label>`,
      onSubmit: async (form) => {
        const draft = await rpc("api_create_trade_draft", {
          p_portfolio_id: portfolio.id, p_instrument_id: form.get("instrument"), p_side: form.get("side"),
          p_quantity: num(form.get("quantity")), p_price: num(form.get("price")), p_idempotency_key: uid("web-trade"),
          p_fee: num(form.get("fee")), p_executed_at: new Date(form.get("executed")).toISOString(),
          p_tranche_number: form.get("tranche") === "" ? null : num(form.get("tranche")),
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
      if (state.route === "journal") await loadJournalPage();
      else render();
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
    else if (action === "account") openAccountDialog();
    else if (action === "budget-edit") openBudgetDialog();
    else if (action === "cash-add") openCashDialog();
    else if (action === "asset-add") openAssetDialog();
    else if (action === "trade-add") openTradeDialog();
    else if (action === "target-edit") openTargetDialog(target.dataset.instrumentId);
    else if (action === "price-record") openPriceDialog(target.dataset.instrumentId);
    else if (action === "journal-add") openJournalDialog();
    else if (action === "journal-edit") openJournalDialog(state.journal.find((item) => item.id === target.dataset.entryId));
    else if (action === "journal-void") openVoidJournalDialog(state.journal.find((item) => item.id === target.dataset.entryId));
    else if (action === "journal-filter-toggle") {
      state.journalFiltersOpen = !state.journalFiltersOpen;
      renderJournalPaged();
    }
    else if (action === "journal-filter-clear") {
      Object.assign(state, { journalFilter: "all", journalOutcome: "all", journalSearch: "", journalDateFrom: "", journalDateTo: "", journalPage: 1, journalFiltersOpen: false });
      await loadJournalPage();
    }
    else if (action === "journal-page-prev" || action === "journal-page-next") {
      state.journalPage += action === "journal-page-next" ? 1 : -1;
      await loadJournalPage();
      $("#journal-filter-form")?.scrollIntoView({ block: "start" });
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
  $("#refresh-button").addEventListener("click", () => loadData());
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
    resizeTimer = setTimeout(() => { if (state.route === "journal") drawEquityCurvePaged(state.journalDaily); }, 120);
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
    Object.assign(state, { user: { email: "preview@local" }, portfolios, instruments, positions, targets, cash, capacities, journalPreviewSource: journal, prices: [], selectedPortfolioId: "p-long" });
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
