const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parsedDateKey(dateKey) {
  const value = String(dateKey || "").trim();
  if (!DATE_KEY_PATTERN.test(value)) throw new Error("brief date must be YYYY-MM-DD");
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error("brief date is invalid");
  return date;
}

export function briefModeForDate(dateKey) {
  const weekday = parsedDateKey(dateKey).getUTCDay();
  return weekday === 0 || weekday === 6 ? "weekend_outlook" : "daily_market_brief";
}

export function buildBriefEditorialPolicy(dateKey) {
  const mode = briefModeForDate(dateKey);
  if (mode === "weekend_outlook") {
    return {
      mode,
      display_title: "Daily Market Brief",
      internal_label: "Weekend Outlook",
      windows: {
        retrospective_days: 7,
        fresh_news_hours: 48,
        catalyst_days: 7,
      },
      editorial_contract: [
        "Build a weekly synthesis around one central market thesis, then test it with fresh weekend reporting and the coming week's catalysts.",
        "Use the previous seven days to explain what moved the market, fresh 48-hour reporting for weekend changes, and the next seven calendar days for decision points.",
        "Never use market closed or no new data as filler. If fresh reporting is thin, deepen the verified weekly synthesis and scenario map instead of inventing Top Stories.",
      ].join(" "),
    };
  }

  return {
    mode,
    display_title: "Daily Market Brief",
    internal_label: "Daily Market Brief",
    windows: {
      retrospective_days: 1,
      fresh_news_hours: 30,
      catalyst_days: 7,
    },
    editorial_contract: [
      "Explain the current US market session or latest completed session through current external reporting and verified market reactions.",
      "Rank today's broad market drivers and map each one to rates, inflation, oil, FX, credit, sectors or market style.",
      "Use the next seven calendar days only for catalysts that can confirm or invalidate the current thesis.",
    ].join(" "),
  };
}
