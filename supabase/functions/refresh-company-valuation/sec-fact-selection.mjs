function periodDays(row) {
  if (!row?.start || !row?.end) return 0;
  return Math.round((new Date(row.end).getTime() - new Date(row.start).getTime()) / 86_400_000);
}

export function preferDurationFact(candidate, current) {
  if (!current) return true;
  const candidateEnd = String(candidate?.end || "");
  const currentEnd = String(current?.end || "");
  if (candidateEnd !== currentEnd) return candidateEnd > currentEnd;

  const candidateDuration = periodDays(candidate);
  const currentDuration = periodDays(current);
  if (candidateDuration !== currentDuration) return candidateDuration > currentDuration;

  return String(candidate?.filed || "") > String(current?.filed || "");
}
