import { createClient } from "npm:@supabase/supabase-js@2";
import {
  applyBlsPpiOverrides,
  buildAdpRows,
  BLS_PPI_SERIES,
  buildBlsPpiOverrides,
  buildFomcRows,
  buildFredRows,
  buildIsmRows,
  buildMichiganRows,
  buildMacroRiskSnapshot,
  dedupeMacroRows,
  FRED_EVENTS,
  parseFomcMeetings,
  parseAdpSnapshot,
  parseIsmSnapshot,
  parseMichiganSnapshot,
  RISK_SERIES,
  zonedIso,
} from "./macro-core.mjs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-sync-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const LONG_SENTIMENT_HISTORY = new Set(["SP500", "VIXCLS", "BAMLH0A0HYM2"]);
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
const FRED_BASE = "https://api.stlouisfed.org/fred";
const BLS_PUBLIC_API = "https://api.bls.gov/publicAPI/v2/timeseries/data/";
const FOMC_CALENDAR =
  "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
const MICHIGAN_SENTIMENT = "https://www.sca.isr.umich.edu/";
const ADP_REPORT = "https://adpemploymentreport.com/ner_production.json";
const ISM_REPORT_BASE =
  "https://www.ismworld.org/supply-management-news-and-reports/reports/ism-pmi-reports";
const ISM_CRAWLER_AGENT =
  "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)";

const dateOnly = (date: Date) => date.toISOString().slice(0, 10);
const shiftDays = (date: Date, days: number) =>
  new Date(date.getTime() + days * 86_400_000);

function result(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: jsonHeaders,
  });
}

async function fetchWithRetry(url: URL | string, init: RequestInit = {}) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          Accept: "application/json, text/html",
          ...(init.headers || {}),
        },
      });
      if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 700));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Upstream request failed");
}

function isPpiReleaseWindow(releaseDates: unknown[], now: Date) {
  return (releaseDates || []).some((item) => {
    const releaseDate = String((item as Record<string, unknown>)?.date || item || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) return false;
    const delta = now.getTime() - new Date(zonedIso(releaseDate, "08:30")).getTime();
    return delta >= -10 * 60_000 && delta <= 4 * 60 * 60_000;
  });
}

const MONTH_SLUGS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

async function fetchIsmSnapshots(rows: any[], now: Date) {
  const requests = new Map<string, { type: string; referenceDate: string; sourceUrl: string }>();
  for (const row of rows) {
    if (new Date(row.scheduled_at) > now) continue;
    const type = row.external_id.includes("services") ? "services" : "manufacturing";
    const [year, month] = String(row.reference_period).split("-").map(Number);
    const monthSlug = MONTH_SLUGS[month - 1];
    if (!year || !monthSlug) continue;
    const reportPath = type === "services" ? "services" : "pmi";
    const sourceUrl = `${ISM_REPORT_BASE}/${reportPath}/${monthSlug}/`;
    requests.set(`${type}:${row.reference_period}`, {
      type,
      referenceDate: row.reference_period,
      sourceUrl,
    });
  }
  const snapshots = [];
  const warnings = [];
  for (const request of requests.values()) {
    try {
      const html = await (await fetchWithRetry(request.sourceUrl, {
        headers: { "User-Agent": ISM_CRAWLER_AGENT },
      })).text();
      const snapshot = parseIsmSnapshot(html, request.type, request.sourceUrl);
      if (snapshot.referenceDate !== request.referenceDate || !Object.keys(snapshot.values).length) {
        throw new Error(`ISM ${request.type} report was not ready for ${request.referenceDate}`);
      }
      snapshots.push(snapshot);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { snapshots, warning: warnings.join("; ") || null };
}

async function blsPpiSeries(now: Date) {
  const response = await fetchWithRetry(BLS_PUBLIC_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      seriesid: BLS_PPI_SERIES.map((item) => item.blsSeriesId),
      startyear: String(now.getUTCFullYear() - 1),
      endyear: String(now.getUTCFullYear()),
    }),
  });
  const payload = await response.json() as Record<string, any>;
  if (payload.status !== "REQUEST_SUCCEEDED" || !Array.isArray(payload.Results?.series)) {
    throw new Error(`BLS Public Data API returned ${payload.status || "an invalid payload"}`);
  }
  return payload.Results.series;
}

async function fredJson(
  path: string,
  params: Record<string, string>,
  apiKey: string,
) {
  const url = new URL(`${FRED_BASE}/${path}`);
  Object.entries({ ...params, api_key: apiKey, file_type: "json" }).forEach((
    [key, value],
  ) => url.searchParams.set(key, value));
  const response = await fetchWithRetry(url);
  return await response.json() as Record<string, unknown>;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return result({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const fredApiKey = Deno.env.get("FRED_API_KEY") || "";
  const syncSecret = Deno.env.get("MACRO_SYNC_SECRET") ||
    Deno.env.get("SYNC_SECRET") || "";
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !fredApiKey) {
    return result({ error: "Macro collector secrets are incomplete" }, 500);
  }

  const authorization = request.headers.get("Authorization") || "";
  const suppliedSyncSecret = request.headers.get("x-sync-secret") || "";
  const service = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
  if (!syncSecret || suppliedSyncSecret !== syncSecret) {
    const auth = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    });
    const { data: { user }, error } = await auth.auth.getUser();
    if (error || !user) {
      return result({ error: "Authentication required" }, 401);
    }
  }

  const now = new Date();
  const fetchedAt = now.toISOString();
  const windowFrom = dateOnly(shiftDays(now, -2));
  const windowTo = dateOnly(shiftDays(now, 120));

  try {
    const releaseIds = [
      ...new Set(FRED_EVENTS.map((event) => event.releaseId)),
    ];
    const eventObservationRequests = [
      ...new Map(FRED_EVENTS.map((event) => [
        `${event.seriesId}:${event.units}`,
        { key: `${event.seriesId}:${event.units}`, seriesId: event.seriesId, units: event.units },
      ])).values(),
    ];
    const linearEventSeries = new Set(
      eventObservationRequests.filter((request) => request.units === "lin").map((request) => request.seriesId),
    );
    const rawObservationRequests = [...new Set([
      ...RISK_SERIES.map((series) => series.seriesId),
      "DFEDTARL",
      "DFEDTARU",
    ])]
      .filter((seriesId) => !linearEventSeries.has(seriesId))
      .map((seriesId) => ({ key: seriesId, seriesId, units: "lin" }));
    const releaseResponses = await Promise.all(
      releaseIds.map(async (releaseId) => {
        const payload = await fredJson("release/dates", {
          release_id: String(releaseId),
          include_release_dates_with_no_data: "true",
          sort_order: "desc",
          limit: "200",
        }, fredApiKey);
        return [
          releaseId,
          Array.isArray(payload.release_dates) ? payload.release_dates : [],
        ] as const;
      }),
    );
    const observationResponses = await Promise.all(
      [...eventObservationRequests, ...rawObservationRequests].map(async (request) => {
        const { key, seriesId, units } = request;
        const payload = await fredJson("series/observations", {
          series_id: seriesId,
          units,
          sort_order: "desc",
          limit: LONG_SENTIMENT_HISTORY.has(seriesId)
            ? "1800"
            : RISK_SERIES.some((series) => series.seriesId === seriesId) ? "500" : "80",
        }, fredApiKey);
        return [
          key,
          Array.isArray(payload.observations) ? payload.observations : [],
        ] as const;
      }),
    );
    const fomcHtml = await (await fetchWithRetry(FOMC_CALENDAR)).text();
    const meetings = parseFomcMeetings(fomcHtml);
    if (!meetings.length) {
      throw new Error(
        "The Federal Reserve calendar could not be read; existing data was preserved",
      );
    }
    let michiganSnapshot = null;
    let michiganWarning: string | null = null;
    try {
      const michiganHtml = await (await fetchWithRetry(MICHIGAN_SENTIMENT)).text();
      michiganSnapshot = parseMichiganSnapshot(michiganHtml);
      if (!michiganSnapshot.referenceDate) {
        throw new Error("University of Michigan release page could not be parsed");
      }
    } catch (error) {
      michiganWarning = error instanceof Error ? error.message : String(error);
    }
    let adpSnapshot = null;
    let adpWarning: string | null = null;
    try {
      adpSnapshot = parseAdpSnapshot(
        await (await fetchWithRetry(ADP_REPORT)).json(),
      );
      if (!adpSnapshot.referenceDate || !adpSnapshot.actual) {
        throw new Error("ADP National Employment Report could not be parsed");
      }
    } catch (error) {
      adpWarning = error instanceof Error ? error.message : String(error);
    }

    const releaseDatesById = Object.fromEntries(releaseResponses);
    const observationsBySeries = Object.fromEntries(observationResponses);
    for (const request of eventObservationRequests) {
      if (request.units === "lin" && !observationsBySeries[request.seriesId]) {
        observationsBySeries[request.seriesId] = observationsBySeries[request.key];
      }
    }
    let blsWarning: string | null = null;
    let blsOverrides = new Map();
    if (isPpiReleaseWindow(releaseDatesById[46] || [], now)) {
      try {
        blsOverrides = buildBlsPpiOverrides(await blsPpiSeries(now), fetchedAt);
      } catch (error) {
        blsWarning = error instanceof Error ? error.message : String(error);
      }
    }

    const fredRows = applyBlsPpiOverrides(buildFredRows({
        releaseDatesById,
        observationsBySeries,
        now: fetchedAt,
        fetchedAt,
        windowFrom,
        windowTo,
      }), blsOverrides, fetchedAt);
    const scheduledIsmRows = buildIsmRows({ fetchedAt, windowFrom, windowTo });
    const ismResult = await fetchIsmSnapshots(scheduledIsmRows, now);
    let rows = dedupeMacroRows([
      ...fredRows,
      ...buildFomcRows({
        meetings,
        lowerObservations: observationsBySeries.DFEDTARL,
        upperObservations: observationsBySeries.DFEDTARU,
        now: fetchedAt,
        fetchedAt,
        windowFrom,
        windowTo,
      }),
      ...buildIsmRows({
        fetchedAt,
        windowFrom,
        windowTo,
        snapshots: ismResult.snapshots,
      }),
      ...buildAdpRows({ fetchedAt, windowFrom, windowTo, snapshot: adpSnapshot }),
      ...buildMichiganRows({
        snapshot: michiganSnapshot,
        now: fetchedAt,
        fetchedAt,
        windowFrom,
        windowTo,
      }),
    ]);
    const durableSources = new Set(["ism", "adp", "university_michigan"]);
    const durableIds = rows
      .filter((row) => durableSources.has(row.source))
      .map((row) => row.external_id);
    if (durableIds.length) {
      const { data: existingDurable, error: durableError } = await service
        .from("macro_events")
        .select("source,external_id,actual,previous")
        .in("source", [...durableSources])
        .in("external_id", durableIds);
      if (durableError) throw durableError;
      const existingById = new Map(
        (existingDurable || []).map((row) => [`${row.source}:${row.external_id}`, row]),
      );
      rows = rows.map((row) => {
        if (!durableSources.has(row.source)) return row;
        const existingRow = existingById.get(`${row.source}:${row.external_id}`);
        return existingRow
          ? {
            ...row,
            actual: row.actual ?? existingRow.actual,
            previous: row.previous ?? existingRow.previous,
          }
          : row;
      });
    }
    if (!rows.length) {
      throw new Error(
        "No curated red or orange US macro events were returned; existing data was preserved",
      );
    }

    const riskSnapshots = [0, -7, -30, -365].map((days) =>
      buildMacroRiskSnapshot({
        observationsBySeries,
        targetDate: dateOnly(shiftDays(now, days)),
        fetchedAt,
      })
    );
    if (riskSnapshots.some((snapshot) => snapshot.risk_score === null || snapshot.fear_greed_score === null)) {
      throw new Error("Risk Monitor did not receive enough FRED observations; existing data was preserved");
    }

    for (let offset = 0; offset < rows.length; offset += 500) {
      const { error } = await service
        .from("macro_events")
        .upsert(rows.slice(offset, offset + 500), {
          onConflict: "source,external_id",
        });
      if (error) throw error;
    }

    const { error: riskError } = await service
      .from("macro_risk_snapshots")
      .upsert(riskSnapshots, { onConflict: "snapshot_date" });
    if (riskError) throw riskError;

    const { data: existing, error: existingError } = await service
      .from("macro_events")
      .select("id,source,external_id")
      .in("source", ["fred", "federal_reserve", "ism", "adp", "university_michigan"])
      .gte("scheduled_at", `${windowFrom}T00:00:00Z`)
      .lt(
        "scheduled_at",
        `${
          dateOnly(shiftDays(new Date(`${windowTo}T00:00:00Z`), 1))
        }T00:00:00Z`,
      );
    if (existingError) throw existingError;
    const currentIds = new Set(
      rows.map((row) => `${row.source}:${row.external_id}`),
    );
    const staleIds = (existing || [])
      .filter((row) => !currentIds.has(`${row.source}:${row.external_id}`))
      .map((row) => row.id);
    for (let offset = 0; offset < staleIds.length; offset += 500) {
      const { error } = await service
        .from("macro_events")
        .update({ is_active: false, updated_at: fetchedAt })
        .in("id", staleIds.slice(offset, offset + 500));
      if (error) throw error;
    }

    const fetchedCount = releaseResponses.reduce((total, [, values]) =>
      total + values.length, 0) +
      observationResponses.reduce(
        (total, [, values]) => total + values.length,
        0,
      );
    const { error: stateError } = await service.from("macro_sync_state").upsert(
      {
        source: "fred_official",
        last_checked_at: fetchedAt,
        last_success_at: fetchedAt,
        window_from: windowFrom,
        window_to: windowTo,
        fetched_count: fetchedCount,
        matched_count: rows.length,
        last_error: null,
        updated_at: fetchedAt,
      },
    );
    if (stateError) throw stateError;
    return result({
      updated: rows.length,
      risk_snapshots: riskSnapshots.length,
      sources: ["ADP", "BLS Public Data API", "FRED", "Federal Reserve", "ISM", "University of Michigan"],
      source_warning: [blsWarning, ismResult.warning, adpWarning, michiganWarning]
        .filter(Boolean).join("; ") || null,
      window_from: windowFrom,
      window_to: windowTo,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await service.from("macro_sync_state").upsert({
      source: "fred_official",
      last_checked_at: fetchedAt,
      last_error: message.slice(0, 1000),
      updated_at: fetchedAt,
    });
    return result({ error: message }, 502);
  }
});
