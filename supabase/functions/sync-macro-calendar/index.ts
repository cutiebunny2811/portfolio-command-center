import { createClient } from "npm:@supabase/supabase-js@2";
import {
  buildFomcRows,
  buildFredRows,
  buildIsmRows,
  buildMacroRiskSnapshot,
  dedupeMacroRows,
  FRED_EVENTS,
  parseFomcMeetings,
  RISK_SERIES,
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
const FOMC_CALENDAR =
  "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";

const dateOnly = (date: Date) => date.toISOString().slice(0, 10);
const shiftDays = (date: Date, days: number) =>
  new Date(date.getTime() + days * 86_400_000);

function result(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: jsonHeaders,
  });
}

async function fetchWithRetry(url: URL | string) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json, text/html" },
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
    const seriesIds = [...new Set([
      ...FRED_EVENTS.map((event) => event.seriesId),
      ...RISK_SERIES.map((series) => series.seriesId),
    ])];
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
      [...seriesIds, "DFEDTARL", "DFEDTARU"].map(async (seriesId) => {
        const config = FRED_EVENTS.find((event) => event.seriesId === seriesId);
        const payload = await fredJson("series/observations", {
          series_id: seriesId,
          units: config?.units || "lin",
          sort_order: "desc",
          limit: LONG_SENTIMENT_HISTORY.has(seriesId)
            ? "1800"
            : RISK_SERIES.some((series) => series.seriesId === seriesId) ? "500" : "80",
        }, fredApiKey);
        return [
          seriesId,
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

    const releaseDatesById = Object.fromEntries(releaseResponses);
    const observationsBySeries = Object.fromEntries(observationResponses);
    const rows = dedupeMacroRows([
      ...buildFredRows({
        releaseDatesById,
        observationsBySeries,
        now: fetchedAt,
        fetchedAt,
        windowFrom,
        windowTo,
      }),
      ...buildFomcRows({
        meetings,
        lowerObservations: observationsBySeries.DFEDTARL,
        upperObservations: observationsBySeries.DFEDTARU,
        now: fetchedAt,
        fetchedAt,
        windowFrom,
        windowTo,
      }),
      ...buildIsmRows({ fetchedAt, windowFrom, windowTo }),
    ]);
    if (!rows.length) {
      throw new Error(
        "No curated US high-impact events were returned; existing data was preserved",
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
      .in("source", ["fred", "federal_reserve", "ism"])
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
      sources: ["FRED", "Federal Reserve", "ISM"],
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
