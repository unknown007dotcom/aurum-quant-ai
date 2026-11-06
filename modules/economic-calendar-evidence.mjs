// Public, read-only upcoming-event (economic calendar) provenance.
// Shared by the server and browser. Never trust arbitrary URLs, source names,
// HTML, or extra stored fields from a response or stored object.
export const CALENDAR_REFRESH_MS = 10 * 60 * 1000;
export const CALENDAR_MAX_CACHE_AGE_MS = 60 * 60 * 1000;
export const CALENDAR_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;
export const CALENDAR_MAX_EVENTS = 24;
export const CALENDAR_SOURCES = Object.freeze([
  {
    id: "bls-schedule",
    name: "BLS · release schedule",
    kind: "official_schedule",
    homepage: "https://www.bls.gov/schedule/news_release/",
    hosts: ["www.bls.gov", "bls.gov"],
  },
  {
    id: "fed-calendar",
    name: "Federal Reserve · calendar",
    kind: "official_schedule",
    homepage: "https://www.federalreserve.gov/newsevents/calendar.htm",
    hosts: ["www.federalreserve.gov", "federalreserve.gov"],
  },
  {
    id: "fed-speeches",
    name: "Federal Reserve · speeches",
    kind: "official_schedule",
    homepage: "https://www.federalreserve.gov/newsevents/speeches.htm",
    hosts: ["www.federalreserve.gov", "federalreserve.gov"],
  },
]);
export const CALENDAR_STATES = new Set([
  "available",
  "partial",
  "stale",
  "empty",
  "unavailable",
]);
export const EVENT_KINDS = new Set([
  "report",
  "meeting",
  "speech",
  "release",
]);
export const EVENT_IMPACTS = new Set(["high", "medium", "low"]);
const sourceById = new Map(CALENDAR_SOURCES.map((source) => [source.id, source]));
export function calendarSource(id) {
  return sourceById.get(id) || null;
}
export function calendarDate(value) {
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return null;
  return new Date(value).toISOString();
}
export function calendarText(value, limit = 200) {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, limit)
    : "";
}
export function safeCalendarUrl(value, sourceId) {
  const source = calendarSource(sourceId);
  if (!source || typeof value !== "string" || value.length > 2000) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !source.hosts.includes(url.hostname)
    )
      return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()])
      if (/^(utm_|fbclid$|gclid$|at_)/i.test(key)) url.searchParams.delete(key);
    return url.href.length <= 700 ? url.href : null;
  } catch {
    return null;
  }
}
// High-impact US events that commonly move gold / XAUUSD through the USD,
// real yields and risk sentiment. Classification is a label, not a signal.
const HIGH_IMPACT =
  /\b(fomc|federal open market committee|rate decision|interest rate decision|statement|press conference|minutes|cpi|consumer price index|employment situation|nonfarm payrolls?|nfp|producer price index|ppi|personal consumption expenditures|pce|core pce|gdp|gross domestic product|retail sales|ism|institute for supply management|jobless claims|initial claims|unemployment rate)\b/i;
const CHAIR_SPEAKER = /\b(chair|vice chair|jerome powell|philip jefferson|powell|jefferson)\b/i;
export function eventImpact(kind, title) {
  const text = `${kind} ${title}`;
  if (kind === "meeting") return "high";
  if (HIGH_IMPACT.test(text)) return "high";
  if (kind === "speech") return CHAIR_SPEAKER.test(title) ? "high" : "medium";
  if (kind === "report") return "medium";
  return "low";
}
export function normalizeCalendarEvidence(value, { limit = CALENDAR_MAX_EVENTS } = {}) {
  if (
    !value ||
    value.type !== "economic_calendar" ||
    value.readOnly !== true ||
    !CALENDAR_STATES.has(value.status)
  )
    return null;
  const checkedAt = calendarDate(value.checkedAt);
  if (!checkedAt) return null;
  const events = [],
    seen = new Set();
  for (const event of (Array.isArray(value.events) ? value.events : []).slice(
    0,
    60,
  )) {
    const source = calendarSource(event?.sourceId);
    const url = safeCalendarUrl(event?.url, source?.id);
    const title = calendarText(event?.title);
    const startsAt = calendarDate(event?.startsAt);
    if (!source || !url || !title || !startsAt || seen.has(url + startsAt))
      continue;
    seen.add(url + startsAt);
    const endsAt = calendarDate(event?.endsAt);
    events.push({
      id:
        typeof event.id === "string" && /^[a-z0-9-]{1,80}$/.test(event.id)
          ? event.id
          : `event-${events.length + 1}`,
      title,
      url,
      sourceId: source.id,
      source: source.name,
      kind: EVENT_KINDS.has(event.kind) ? event.kind : "release",
      impact: EVENT_IMPACTS.has(event.impact) ? event.impact : "low",
      currency: event.currency === "USD" ? "USD" : "USD",
      startsAt,
      endsAt: endsAt && Date.parse(endsAt) > Date.parse(startsAt) ? endsAt : null,
      cached: event.cached === true,
    });
    if (events.length >= Math.min(CALENDAR_MAX_EVENTS, Math.max(1, limit)))
      break;
  }
  const sources = [];
  for (const entry of (Array.isArray(value.sources) ? value.sources : []).slice(
    0,
    12,
  )) {
    const source = calendarSource(entry?.id);
    if (!source || sources.some((existing) => existing.id === source.id))
      continue;
    sources.push({
      id: source.id,
      name: source.name,
      homepage: source.homepage,
      status: ["ok", "stale", "unavailable"].includes(entry.status)
        ? entry.status
        : "unavailable",
      checkedAt: calendarDate(entry.checkedAt),
      fetchedAt: calendarDate(entry.fetchedAt),
      errorCode:
        typeof entry.errorCode === "string" &&
        /^(?:timeout|invalid_feed|unavailable|http_[1-5]\d\d)$/.test(
          entry.errorCode,
        )
          ? entry.errorCode
          : null,
    });
  }
  return {
    type: "economic_calendar",
    readOnly: true,
    status: value.status,
    checkedAt,
    cached: value.cached === true,
    refreshIntervalMs: CALENDAR_REFRESH_MS,
    horizonDays: Math.round(CALENDAR_HORIZON_MS / 86400000),
    events,
    sources,
  };
}
export function calendarStatusText(value, now = Date.now()) {
  const calendar = normalizeCalendarEvidence(value);
  if (!calendar)
    return {
      state: "unavailable",
      label: "Upcoming events unavailable",
      detail: "The official schedules could not be checked. Chat can still continue.",
    };
  const oldSnapshot =
    now - Date.parse(calendar.checkedAt) > CALENDAR_MAX_CACHE_AGE_MS ||
    Date.parse(calendar.checkedAt) > now + 5 * 60 * 1000;
  if (calendar.status === "unavailable")
    return {
      state: "unavailable",
      label: "Upcoming events unavailable",
      detail:
        "The official schedules could not be reached. No upcoming events are being claimed.",
    };
  if (oldSnapshot || calendar.status === "stale")
    return {
      state: "stale",
      label: "Cached upcoming events",
      detail: "Last-known schedule, not a fresh check. Event times may have changed.",
    };
  if (!calendar.events.length)
    return {
      state: calendar.status === "partial" ? "partial" : "empty",
      label: "No upcoming events found",
      detail:
        calendar.status === "partial"
          ? "Some schedules are unavailable; the others returned no upcoming USD events in the window."
          : "The checked official schedules returned no upcoming USD events in the next 30 days.",
    };
  if (calendar.status === "partial")
    return {
      state: "partial",
      label: "Some schedules unavailable",
      detail:
        "Available upcoming events are shown; coverage is incomplete. Cached items are labeled.",
    };
  return {
    state: "available",
    label: "Upcoming events checked",
    detail:
      "Official BLS and Federal Reserve schedules. Scheduled times can change; this is not a trading signal.",
  };
}
export function calendarCountdown(startsAt, now = Date.now()) {
  const delta = Date.parse(startsAt) - now;
  if (!Number.isFinite(delta)) return "";
  if (delta < 0) return "started";
  const minutes = Math.round(delta / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} h`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}
