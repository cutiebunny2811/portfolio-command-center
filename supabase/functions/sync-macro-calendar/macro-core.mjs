const FED_TIME_ZONE = "America/New_York";

export const FRED_EVENTS = [
  {
    releaseId: 10,
    seriesId: "CPIAUCSL",
    eventName: "CPI Inflation (MoM)",
    eventGroup: "inflation",
    signalFamily: "inflation",
    category: "CPI",
    units: "pch",
    valueKind: "percent",
    lagMonths: 1,
    time: "08:30",
    agency: "BLS",
    sourceUrl: "https://www.bls.gov/cpi/",
  },
  {
    releaseId: 10,
    seriesId: "CPILFESL",
    eventName: "Core CPI (MoM)",
    eventGroup: "inflation",
    signalFamily: "inflation",
    category: "Core CPI",
    units: "pch",
    valueKind: "percent",
    lagMonths: 1,
    time: "08:30",
    agency: "BLS",
    sourceUrl: "https://www.bls.gov/cpi/",
  },
  {
    releaseId: 54,
    seriesId: "PCEPI",
    eventName: "PCE Inflation (MoM)",
    eventGroup: "inflation",
    signalFamily: "inflation",
    category: "PCE",
    units: "pch",
    valueKind: "percent",
    lagMonths: 1,
    time: "08:30",
    agency: "BEA",
    sourceUrl:
      "https://www.bea.gov/data/personal-consumption-expenditures-price-index",
  },
  {
    releaseId: 54,
    seriesId: "PCEPILFE",
    eventName: "Core PCE (MoM)",
    eventGroup: "inflation",
    signalFamily: "inflation",
    category: "Core PCE",
    units: "pch",
    valueKind: "percent",
    lagMonths: 1,
    time: "08:30",
    agency: "BEA",
    sourceUrl:
      "https://www.bea.gov/data/personal-consumption-expenditures-price-index",
  },
  {
    releaseId: 50,
    seriesId: "PAYEMS",
    eventName: "Nonfarm Payrolls",
    eventGroup: "labor",
    signalFamily: "labor_strength",
    category: "Employment Situation",
    units: "chg",
    valueKind: "thousands_change",
    lagMonths: 1,
    time: "08:30",
    agency: "BLS",
    sourceUrl: "https://www.bls.gov/news.release/empsit.nr0.htm",
  },
  {
    releaseId: 50,
    seriesId: "UNRATE",
    eventName: "Unemployment Rate",
    eventGroup: "labor",
    signalFamily: "labor_inverse",
    category: "Employment Situation",
    units: "lin",
    valueKind: "percent",
    lagMonths: 1,
    time: "08:30",
    agency: "BLS",
    sourceUrl: "https://www.bls.gov/news.release/empsit.nr0.htm",
  },
  {
    releaseId: 50,
    seriesId: "CES0500000003",
    eventName: "Average Hourly Earnings (MoM)",
    eventGroup: "labor",
    signalFamily: "inflation",
    category: "Employment Situation",
    units: "pch",
    valueKind: "percent",
    lagMonths: 1,
    time: "08:30",
    agency: "BLS",
    sourceUrl: "https://www.bls.gov/news.release/empsit.nr0.htm",
  },
  {
    releaseId: 46,
    seriesId: "PPIFIS",
    eventName: "Producer Price Index (MoM)",
    eventGroup: "inflation",
    signalFamily: "inflation",
    category: "PPI",
    units: "pch",
    valueKind: "percent",
    lagMonths: 1,
    time: "08:30",
    agency: "BLS",
    sourceUrl: "https://www.bls.gov/ppi/",
  },
  {
    releaseId: 46,
    seriesId: "PPIFES",
    eventName: "Core PPI (MoM)",
    eventGroup: "inflation",
    signalFamily: "inflation",
    category: "Core PPI",
    units: "pch",
    valueKind: "percent",
    lagMonths: 1,
    time: "08:30",
    agency: "BLS",
    sourceUrl: "https://www.bls.gov/ppi/",
  },
  {
    releaseId: 53,
    seriesId: "A191RL1Q225SBEA",
    eventName: "GDP Growth — Advance",
    eventGroup: "growth",
    signalFamily: "growth",
    category: "GDP",
    units: "lin",
    valueKind: "percent",
    quarterly: true,
    advanceOnly: true,
    time: "08:30",
    agency: "BEA",
    sourceUrl: "https://www.bea.gov/data/gdp/gross-domestic-product",
  },
  {
    releaseId: 9,
    seriesId: "RSAFS",
    eventName: "Retail Sales (MoM)",
    eventGroup: "consumption",
    signalFamily: "growth",
    category: "Retail Sales",
    units: "pch",
    valueKind: "percent",
    lagMonths: 1,
    time: "08:30",
    agency: "Census",
    sourceUrl: "https://www.census.gov/retail/index.html",
  },
  {
    releaseId: 192,
    seriesId: "JTSJOL",
    eventName: "JOLTS Job Openings",
    eventGroup: "labor",
    signalFamily: "labor_strength",
    category: "JOLTS",
    units: "lin",
    valueKind: "millions_from_thousands",
    lagMonths: 2,
    variableJoltsLag: true,
    time: "10:00",
    agency: "BLS",
    sourceUrl: "https://www.bls.gov/jlt/",
  },
  {
    releaseId: 180,
    seriesId: "ICSA",
    eventName: "Initial Jobless Claims",
    eventGroup: "labor",
    signalFamily: "labor_inverse",
    category: "Weekly Claims",
    units: "lin",
    valueKind: "persons_to_thousands",
    weekly: true,
    time: "08:30",
    agency: "DOL",
    sourceUrl: "https://www.dol.gov/ui/data.pdf",
  },
];

const pad = (value) => String(value).padStart(2, "0");
const dateOnly = (date) => date.toISOString().slice(0, 10);
const shiftDays = (date, days) => new Date(date.getTime() + days * 86_400_000);

export function zonedIso(dateText, timeText, timeZone = FED_TIME_ZONE) {
  const [year, month, day] = String(dateText).split("-").map(Number);
  const [hour, minute] = String(timeText).split(":").map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let guess = desired;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(guess)).map((
        part,
      ) => [part.type, part.value]),
    );
    const rendered = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
    );
    guess += desired - rendered;
  }
  return new Date(guess).toISOString();
}

export function parseFredNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function tidy(value, digits = 1) {
  const rounded = Number(Number(value).toFixed(digits));
  return (Object.is(rounded, -0) ? 0 : rounded).toFixed(digits).replace(
    /\.0$/,
    "",
  );
}

export function formatFredValue(value, kind) {
  const number = parseFredNumber(value);
  if (number === null) return null;
  if (kind === "percent") return `${tidy(number, 1)}%`;
  if (kind === "thousands_change") return `${Math.round(number)}K`;
  if (kind === "millions_from_thousands") return `${tidy(number / 1000, 2)}M`;
  if (kind === "persons_to_thousands") return `${Math.round(number / 1000)}K`;
  if (kind === "thousands") return `${Math.round(number)}K`;
  return tidy(number, 2);
}

function shiftMonthStart(dateText, deltaMonths) {
  const [year, month] = String(dateText).split("-").map(Number);
  return dateOnly(new Date(Date.UTC(year, month - 1 + deltaMonths, 1)));
}

export function expectedPeriodDate(config, releaseDate) {
  if (config.weekly) return null;
  if (config.quarterly) {
    const [year, month] = String(releaseDate).split("-").map(Number);
    const currentQuarterStart = Math.floor((month - 1) / 3) * 3;
    return dateOnly(new Date(Date.UTC(year, currentQuarterStart - 3, 1)));
  }
  const releaseDay = Number(String(releaseDate).slice(8, 10));
  const lagMonths = config.variableJoltsLag && releaseDay > 7
    ? 1
    : Number(config.lagMonths || 1);
  return shiftMonthStart(releaseDate, -lagMonths);
}

function referenceLabel(config, observationDate) {
  if (!observationDate) return null;
  const date = new Date(`${observationDate}T00:00:00Z`);
  if (config.quarterly) {
    return `Q${
      Math.floor(date.getUTCMonth() / 3) + 1
    } ${date.getUTCFullYear()}`;
  }
  if (config.weekly) {
    return date.toLocaleDateString("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
  return date.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    year: "numeric",
  });
}

function inWindow(dateText, from, to) {
  return dateText >= from && dateText <= to;
}

function eligibleReleaseDate(config, dateText) {
  if (!config.advanceOnly) return true;
  const month = Number(String(dateText).slice(5, 7));
  return [1, 4, 7, 10].includes(month);
}

function sortedObservations(observations) {
  return [...(observations || [])]
    .filter((item) => item?.date && parseFredNumber(item.value) !== null)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

export function buildFredRows(
  {
    releaseDatesById,
    observationsBySeries,
    now,
    fetchedAt,
    windowFrom,
    windowTo,
  },
) {
  const current = new Date(now);
  const rows = [];
  for (const config of FRED_EVENTS) {
    const observations = sortedObservations(
      observationsBySeries[config.seriesId],
    );
    const allDates = [
      ...new Set(
        (releaseDatesById[config.releaseId] || []).map((item) =>
          String(item.date || item)
        ).filter(Boolean),
      ),
    ]
      .filter((date) => eligibleReleaseDate(config, date))
      .sort((a, b) => b.localeCompare(a));
    const pastDates = allDates.filter((date) =>
      new Date(zonedIso(date, config.time)) <= current
    );

    for (
      const releaseDate of allDates.filter((date) =>
        inWindow(date, windowFrom, windowTo)
      )
    ) {
      const scheduledAt = zonedIso(releaseDate, config.time);
      const released = new Date(scheduledAt) <= current;
      let observationIndex = -1;
      if (released && config.weekly) {
        observationIndex = pastDates.indexOf(releaseDate);
      }
      if (released && !config.weekly) {
        const expected = expectedPeriodDate(config, releaseDate);
        observationIndex = observations.findIndex((item) =>
          item.date === expected
        );
      }
      const actualObservation = observationIndex >= 0
        ? observations[observationIndex]
        : null;
      const previousObservation = released && actualObservation
        ? observations[observationIndex + 1]
        : observations[0];
      const expected = expectedPeriodDate(config, releaseDate);
      const referenceDate = actualObservation?.date || expected ||
        previousObservation?.date || null;
      rows.push({
        source: "fred",
        external_id: `${config.seriesId}:${releaseDate}:${config.units}`,
        series_id: config.seriesId,
        event_group: config.eventGroup,
        signal_family: config.signalFamily,
        event_name: config.eventName,
        category: config.category,
        reference_period: referenceLabel(config, referenceDate),
        scheduled_at: scheduledAt,
        actual: actualObservation
          ? formatFredValue(actualObservation.value, config.valueKind)
          : null,
        previous: previousObservation
          ? formatFredValue(previousObservation.value, config.valueKind)
          : null,
        revised: null,
        importance: 3,
        currency: "USD",
        unit: config.valueKind,
        source_name: `${config.agency} via FRED`,
        source_url: config.sourceUrl,
        is_active: true,
        raw_payload: {
          release_id: config.releaseId,
          series_id: config.seriesId,
          fred_url: `https://fred.stlouisfed.org/series/${config.seriesId}`,
          observation_date: actualObservation?.date || null,
          observation_value: actualObservation?.value || null,
        },
        fetched_at: fetchedAt,
        updated_at: fetchedAt,
      });
    }
  }
  return rows;
}

const MONTHS = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

export function parseFomcMeetings(html) {
  const markers = [...String(html || "").matchAll(/(20\d{2}) FOMC Meetings/g)];
  const meetings = [];
  const seen = new Set();
  for (let markerIndex = 0; markerIndex < markers.length; markerIndex += 1) {
    const marker = markers[markerIndex];
    const year = Number(marker[1]);
    const section = String(html).slice(
      marker.index,
      markers[markerIndex + 1]?.index || undefined,
    );
    const rowPattern =
      /fomc-meeting__month[^>]*><strong>([^<]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]+)<\/div>/g;
    for (const match of section.matchAll(rowPattern)) {
      const monthParts = match[1].trim().toLowerCase().split("/");
      const dateText = match[2].trim();
      const dayParts = dateText.replace(/\*/g, "").split("-");
      const month = MONTHS[monthParts.at(-1)];
      const day = Number(dayParts.at(-1));
      if (!month || !day) continue;
      const decisionDate = `${year}-${pad(month)}-${pad(day)}`;
      if (seen.has(decisionDate)) continue;
      seen.add(decisionDate);
      meetings.push({ decisionDate, hasProjections: dateText.includes("*") });
    }
  }
  return meetings.sort((a, b) => a.decisionDate.localeCompare(b.decisionDate));
}

function latestAtOrBefore(observations, dateText, strictlyBefore = false) {
  return sortedObservations(observations).find((item) =>
    strictlyBefore ? item.date < dateText : item.date <= dateText
  ) || null;
}

function formatTargetRange(lower, upper) {
  const low = parseFredNumber(lower?.value);
  const high = parseFredNumber(upper?.value);
  if (low === null || high === null) return null;
  return `${low.toFixed(2)}–${high.toFixed(2)}%`;
}

function policyRow(
  {
    externalId,
    eventName,
    scheduledAt,
    actual,
    previous,
    category,
    sourceUrl,
    fetchedAt,
  },
) {
  return {
    source: "federal_reserve",
    external_id: externalId,
    series_id: null,
    event_group: "policy",
    signal_family: "policy",
    event_name: eventName,
    category,
    reference_period: null,
    scheduled_at: scheduledAt,
    actual,
    previous,
    revised: null,
    importance: 3,
    currency: "USD",
    unit: category === "FOMC" ? "target_range" : null,
    source_name: "Federal Reserve",
    source_url: sourceUrl,
    is_active: true,
    raw_payload: {},
    fetched_at: fetchedAt,
    updated_at: fetchedAt,
  };
}

export function buildFomcRows(
  {
    meetings,
    lowerObservations,
    upperObservations,
    now,
    fetchedAt,
    windowFrom,
    windowTo,
  },
) {
  const current = new Date(now);
  const rows = [];
  const sourceUrl =
    "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
  for (const meeting of meetings || []) {
    const decisionAt = zonedIso(meeting.decisionDate, "14:00");
    const decisionReleased = new Date(decisionAt) <= current;
    const lowerActual = decisionReleased
      ? latestAtOrBefore(lowerObservations, meeting.decisionDate)
      : null;
    const upperActual = decisionReleased
      ? latestAtOrBefore(upperObservations, meeting.decisionDate)
      : null;
    const lowerPrevious = latestAtOrBefore(
      lowerObservations,
      meeting.decisionDate,
      decisionReleased,
    );
    const upperPrevious = latestAtOrBefore(
      upperObservations,
      meeting.decisionDate,
      decisionReleased,
    );
    if (inWindow(meeting.decisionDate, windowFrom, windowTo)) {
      rows.push(policyRow({
        externalId: `fomc-decision:${meeting.decisionDate}`,
        eventName: `FOMC Rate Decision${
          meeting.hasProjections ? " + SEP" : ""
        }`,
        scheduledAt: decisionAt,
        actual: decisionReleased
          ? formatTargetRange(lowerActual, upperActual)
          : null,
        previous: formatTargetRange(lowerPrevious, upperPrevious),
        category: "FOMC",
        sourceUrl,
        fetchedAt,
      }));
      const pressAt = zonedIso(meeting.decisionDate, "14:30");
      rows.push(policyRow({
        externalId: `fomc-press-conference:${meeting.decisionDate}`,
        eventName: "Fed Chair Press Conference",
        scheduledAt: pressAt,
        actual: new Date(pressAt) <= current ? "Completed" : null,
        previous: null,
        category: "Fed Chair",
        sourceUrl,
        fetchedAt,
      }));
    }
    const minutesDate = dateOnly(
      shiftDays(new Date(`${meeting.decisionDate}T00:00:00Z`), 21),
    );
    if (inWindow(minutesDate, windowFrom, windowTo)) {
      const minutesAt = zonedIso(minutesDate, "14:00");
      rows.push(policyRow({
        externalId: `fomc-minutes:${meeting.decisionDate}`,
        eventName: "FOMC Minutes",
        scheduledAt: minutesAt,
        actual: new Date(minutesAt) <= current ? "Released" : null,
        previous: null,
        category: "FOMC Minutes",
        sourceUrl,
        fetchedAt,
      }));
    }
  }
  return rows;
}

function observedFixedHoliday(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay();
  if (weekday === 6) return dateOnly(shiftDays(date, -1));
  if (weekday === 0) return dateOnly(shiftDays(date, 1));
  return dateOnly(date);
}

function firstBusinessDays(year, month, count) {
  const holidays = new Set([
    observedFixedHoliday(year, 1, 1),
    observedFixedHoliday(year, 7, 4),
    observedFixedHoliday(year, 12, 25),
  ]);
  const dates = [];
  for (let day = 1; dates.length < count && day <= 10; day += 1) {
    const date = new Date(Date.UTC(year, month - 1, day));
    const key = dateOnly(date);
    if (![0, 6].includes(date.getUTCDay()) && !holidays.has(key)) {
      dates.push(key);
    }
  }
  return dates;
}

export function buildIsmRows({ fetchedAt, windowFrom, windowTo }) {
  const [fromYear, fromMonth] = windowFrom.split("-").map(Number);
  const [toYear, toMonth] = windowTo.split("-").map(Number);
  const cursor = new Date(Date.UTC(fromYear, fromMonth - 1, 1));
  const end = new Date(Date.UTC(toYear, toMonth - 1, 1));
  const rows = [];
  while (cursor <= end) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;
    const businessDays = firstBusinessDays(year, month, 3);
    if (year === 2026 && month === 1) businessDays[0] = "2026-01-05";
    const events = [
      {
        date: businessDays[0],
        slug: "manufacturing",
        name: "ISM Manufacturing PMI",
      },
      { date: businessDays[2], slug: "services", name: "ISM Services PMI" },
    ];
    for (const event of events) {
      if (!event.date || !inWindow(event.date, windowFrom, windowTo)) continue;
      rows.push({
        source: "ism",
        external_id: `ism-${event.slug}:${event.date}`,
        series_id: null,
        event_group: "activity",
        signal_family: "growth",
        event_name: event.name,
        category: "ISM PMI",
        reference_period: shiftMonthStart(event.date, -1),
        scheduled_at: zonedIso(event.date, "10:00"),
        actual: null,
        previous: null,
        revised: null,
        importance: 3,
        currency: "USD",
        unit: "index",
        source_name: "Institute for Supply Management",
        source_url:
          "https://www.ismworld.org/supply-management-news-and-reports/reports/rob-report-calendar/",
        is_active: true,
        raw_payload: {
          schedule_rule: event.slug === "manufacturing"
            ? "first business day"
            : "third business day",
        },
        fetched_at: fetchedAt,
        updated_at: fetchedAt,
      });
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return rows;
}

export function dedupeMacroRows(rows) {
  return [
    ...new Map(
      (rows || []).map((row) => [`${row.source}:${row.external_id}`, row]),
    ).values(),
  ]
    .sort((a, b) =>
      String(a.scheduled_at).localeCompare(String(b.scheduled_at)) ||
      String(a.event_name).localeCompare(String(b.event_name))
    );
}
