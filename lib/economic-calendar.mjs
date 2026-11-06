import { XMLParser, XMLValidator } from "fast-xml-parser";
import {
  CALENDAR_SOURCES,
  CALENDAR_REFRESH_MS,
  CALENDAR_MAX_CACHE_AGE_MS,
  CALENDAR_HORIZON_MS,
  CALENDAR_MAX_EVENTS,
  calendarSource,
  calendarText,
  safeCalendarUrl,
  eventImpact,
  normalizeCalendarEvidence,
} from "../modules/economic-calendar-evidence.mjs";

// Fixed public official schedules only. User questions/URLs/credentials are
// NEVER forwarded. Upcoming = future-dated entries on official sources.
const BLS_ICS_URL = "https://www.bls.gov/schedule/news_release/bls.ics";
const FED_SPEECHES_URL = "https://www.federalreserve.gov/feeds/speeches.xml";
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const MAX_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 4500;
const RETRY_MS = 60 * 1000;
const caches = new WeakMap();
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  trimValues: true,
  stopNodes: ["*.description", "*.content:encoded", "*.summary", "*.content"],
});
const asArray = (value) =>
  value == null ? [] : Array.isArray(value) ? value : [value];
const scalar = (value) =>
  typeof value === "string"
    ? value
    : typeof value?.["#text"] === "string"
      ? value["#text"]
      : "";
function entities(value) {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (all, name) => {
      if (name.startsWith("#")) {
        const code =
          name[1].toLowerCase() === "x"
            ? parseInt(name.slice(2), 16)
            : Number(name.slice(1));
        return code > 0 &&
          code <= 0x10ffff &&
          !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code)
          : " ";
      }
      return (
        { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[
          name.toLowerCase()
        ] || all
      );
    },
  );
}
function icsUnescape(value) {
  return value
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}
// US Eastern DST: from the second Sunday of March 02:00 to the first Sunday
// of November 02:00 local time (EDT, UTC-4); otherwise EST (UTC-5).
function nthSunday(year, monthIndex, n) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const offset = (7 - first.getUTCDay()) % 7;
  return 1 + offset + (n - 1) * 7;
}
function easternOffsetHours(year, monthIndex, day, hour) {
  const dstStartDay = nthSunday(year, 2, 2); // March
  const dstEndDay = nthSunday(year, 10, 1); // November
  const afterStart =
    monthIndex > 2 ||
    (monthIndex === 2 && (day > dstStartDay || (day === dstStartDay && hour >= 2)));
  const afterEnd =
    monthIndex > 10 ||
    (monthIndex === 10 && (day > dstEndDay || (day === dstEndDay && hour >= 2)));
  return afterStart && !afterEnd ? -4 : -5;
}
function parseIcsDateTime(raw, params, now) {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(
    raw.trim(),
  );
  if (!match) return null;
  const [, y, mo, d, h, mi, s, zulu] = match;
  const year = Number(y),
    month = Number(mo) - 1,
    day = Number(d);
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  const hour = h ? Number(h) : 0,
    minute = mi ? Number(mi) : 0,
    second = s ? Number(s) : 0;
  let utcMs;
  if (zulu || /^Z$/i.test(params?.tzid || "") || params?.utc) {
    utcMs = Date.UTC(year, month, day, hour, minute, second);
  } else {
    // BLS publishes with TZID=US-Eastern; treat bare local times as Eastern.
    const offset = easternOffsetHours(year, month, day, hour);
    utcMs = Date.UTC(year, month, day, hour - offset, minute, second);
  }
  if (!Number.isFinite(utcMs) || utcMs < Date.UTC(2000, 0, 1)) return null;
  if (utcMs > now + 400 * 86400000) return null; // far-future guard
  return new Date(utcMs).toISOString();
}
export function parseIcsCalendar(text, sourceId, now = Date.now()) {
  const source = calendarSource(sourceId);
  if (
    !source ||
    typeof text !== "string" ||
    new TextEncoder().encode(text).length > MAX_BYTES ||
    /\u0000/.test(text)
  )
    throw new Error("Invalid calendar feed.");
  if (!/^BEGIN:VCALENDAR[\s\S]*END:VCALENDAR\s*$/m.test(text.trim()))
    throw new Error("Not an iCalendar feed.");
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const events = [];
  for (const block of unfolded.split(/^BEGIN:VEVENT\s*$/m)) {
    if (!/^([\s\S]*?)END:VEVENT\s*$/m.test(block)) continue;
    const body = block.replace(/END:VEVENT\s*$/m, "");
    const props = {};
    for (const line of body.split(/\r?\n/)) {
      const match = /^([A-Z0-9-]+)((?:;[^:]*)?):(.*)$/.exec(line);
      if (!match) continue;
      const [, name, paramsRaw, rawValue] = match;
      const params = {};
      for (const part of paramsRaw.split(";").slice(1)) {
        const [key, value] = part.split("=");
        if (key && value) params[key.toUpperCase()] = value.replace(/^"|"$/g, "");
      }
      props[name.toUpperCase()] = { params, value: rawValue };
    }
    const summary = calendarText(icsUnescape(entities(scalar(props.SUMMARY?.value ?? ""))), 200);
    if (!summary) continue;
    const startsAt = parseIcsDateTime(
      props.DTSTART?.value ?? "",
      { tzid: props.DTSTART?.params?.TZID, utc: /Z$/i.test(props.DTSTART?.value ?? "") },
      now,
    );
    if (!startsAt) continue;
    const endsRaw = props.DTEND?.value;
    const endsAt = endsRaw
      ? parseIcsDateTime(
          endsRaw,
          { tzid: props.DTEND?.params?.TZID, utc: /Z$/i.test(endsRaw) },
          now,
        )
      : null;
    let url = safeCalendarUrl(
      entities(scalar(props.URL?.value ?? "")).trim() || source.homepage,
      sourceId,
    );
    if (!url) url = source.homepage;
    events.push({
      title: summary,
      url,
      sourceId,
      kind: "report",
      startsAt,
      endsAt,
      uid: calendarText(props.UID?.value ?? "", 120),
    });
  }
  return events;
}
// Fed monthly calendar pages are HTML; parse their text content, not markup.
const FED_SECTIONS = new Set([
  "Speeches",
  "FOMC Meetings",
  "Press Conferences",
  "Beige Book",
  "Statistical Releases",
]);
const FED_SECTION_KIND = {
  Speeches: "speech",
  "FOMC Meetings": "meeting",
  "Press Conferences": "meeting",
  "Beige Book": "release",
  "Statistical Releases": "release",
};
function htmlToLines(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<\/(p|div|li|tr|h[1-6]|td|th|ul|ol|section|article|header|footer|table|blockquote|dd|dt)>/gi,
      "\n",
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .split("\n")
    .map((line) => entities(line).replace(/\s+/g, " ").trim())
    .filter(Boolean);
}
export function parseFedCalendarPage(html, sourceId, year, monthName, now = Date.now()) {
  const source = calendarSource(sourceId);
  if (
    !source ||
    typeof html !== "string" ||
    new TextEncoder().encode(html).length > MAX_BYTES ||
    /\u0000/.test(html) ||
    !/<[a-z][\s\S]*>/i.test(html) ||
    html.trim().length < 40
  )
    throw new Error("Invalid calendar page.");
  const monthIndex = MONTHS.indexOf(monthName.toLowerCase());
  if (monthIndex < 0) throw new Error("Invalid calendar month.");
  const lines = htmlToLines(html);
  const events = [];
  let section = null;
  const timeRe = /^(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?\s*(.*)$/i;
  const dayRe = /^(\d{1,2})(?:\s*,\s*\d{1,2})*\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FED_SECTIONS.has(line)) {
      section = line;
      continue;
    }
    if (!section) continue;
    const time = timeRe.exec(line);
    if (!time) continue;
    // The title may share the time line (inline markup) or follow on the next line.
    let title = calendarText(time[4] || "", 200);
    let j = i + 1;
    while (j < lines.length) {
      const candidate = lines[j];
      if (timeRe.test(candidate) || dayRe.test(candidate) || FED_SECTIONS.has(candidate))
        break;
      if (!title && !/^(watch live|listen live|read more)$/i.test(candidate))
        title = calendarText(candidate, 200);
      j++;
    }
    // Day number(s) terminate the entry.
    while (j < lines.length && !dayRe.test(lines[j]) && !timeRe.test(lines[j]) && !FED_SECTIONS.has(lines[j])) j++;
    const dayLine = lines[j] && dayRe.test(lines[j]) ? lines[j] : null;
    if (!title || !dayLine) continue;
    const days = [...dayLine.matchAll(/\d{1,2}/g)].map((m) => Number(m[0]));
    let hour = Number(time[1]) % 12;
    if (time[3].toLowerCase() === "p") hour += 12;
    for (const day of days) {
      if (day < 1 || day > 31) continue;
      const offset = easternOffsetHours(year, monthIndex, day, hour);
      const utcMs = Date.UTC(year, monthIndex, day, hour - offset, Number(time[2]));
      if (!Number.isFinite(utcMs)) continue;
      events.push({
        title: calendarText(title, 200),
        url: source.homepage,
        sourceId,
        kind: FED_SECTION_KIND[section] || "release",
        startsAt: new Date(utcMs).toISOString(),
        endsAt: null,
      });
    }
    i = j;
  }
  return events;
}
// The Fed speeches feed lists delivered speeches; scheduled (future-dated)
// entries are surfaced as upcoming speeches when present.
export function parseFedSpeechesFeed(xml, sourceId, now = Date.now()) {
  const source = calendarSource(sourceId);
  if (
    !source ||
    typeof xml !== "string" ||
    new TextEncoder().encode(xml).length > MAX_BYTES ||
    /<!\s*(?:DOCTYPE|ENTITY)\b|\u0000/i.test(xml)
  )
    throw new Error("Invalid calendar feed.");
  if (XMLValidator.validate(xml) !== true)
    throw new Error("Invalid calendar feed.");
  const parsed = xmlParser.parse(xml);
  const channel = parsed?.rss?.channel;
  if (!channel) throw new Error("Not an RSS feed.");
  const events = [];
  for (const entry of asArray(channel.item).slice(0, 120)) {
    const title = calendarText(
      entities(scalar(entry?.title).replace(/<[^>]*>/g, " ")),
      200,
    );
    if (!title) continue;
    const rawDate = scalar(entry?.pubDate).trim().slice(0, 100);
    if (!/(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)$/i.test(rawDate)) continue;
    const time = Date.parse(rawDate);
    if (!Number.isFinite(time) || time < Date.UTC(2000, 0, 1)) continue;
    if (time <= now) continue; // upcoming only
    if (time > now + 400 * 86400000) continue;
    let url = safeCalendarUrl(
      entities(scalar(entry?.link).trim() || source.homepage),
      sourceId,
    );
    if (!url) url = source.homepage;
    events.push({
      title,
      url,
      sourceId,
      kind: "speech",
      startsAt: new Date(time).toISOString(),
      endsAt: null,
    });
  }
  return events;
}
function calendarFeeds(now = Date.now()) {
  const date = new Date(now);
  const current = {
    sourceId: "fed-calendar",
    url: `https://www.federalreserve.gov/newsevents/${date.getUTCFullYear()}-${MONTHS[date.getUTCMonth()]}.htm`,
    parser: (text) =>
      parseFedCalendarPage(
        text,
        "fed-calendar",
        date.getUTCFullYear(),
        MONTHS[date.getUTCMonth()],
        now,
      ),
  };
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  const nextFeed = {
    sourceId: "fed-calendar",
    url: `https://www.federalreserve.gov/newsevents/${next.getUTCFullYear()}-${MONTHS[next.getUTCMonth()]}.htm`,
    parser: (text) =>
      parseFedCalendarPage(
        text,
        "fed-calendar",
        next.getUTCFullYear(),
        MONTHS[next.getUTCMonth()],
        now,
      ),
  };
  return [
    {
      sourceId: "bls-schedule",
      url: BLS_ICS_URL,
      accept: "text/calendar",
      parser: (text) => parseIcsCalendar(text, "bls-schedule", now),
    },
    {
      sourceId: "fed-speeches",
      url: FED_SPEECHES_URL,
      accept: "application/rss+xml",
      parser: (text) => parseFedSpeechesFeed(text, "fed-speeches", now),
    },
    current,
    nextFeed,
  ];
}
async function limitedText(response, signal) {
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error("Calendar source is too large.");
  }
  if (!response.body?.getReader)
    throw new Error("Calendar source body is unavailable.");
  const reader = response.body.getReader();
  const abort = () => {
    reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  let bytes = 0,
    text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error("Calendar source is too large.");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function cacheFor(fetchImpl) {
  if (!caches.has(fetchImpl)) caches.set(fetchImpl, new Map());
  return caches.get(fetchImpl);
}
async function feedSnapshot(feed, fetchImpl, now) {
  const cache = cacheFor(fetchImpl);
  let slot = cache.get(feed.url);
  if (!slot) {
    slot = {
      items: null,
      fetchedAt: null,
      checkedAt: null,
      nextAttempt: 0,
      failed: false,
      inFlight: null,
    };
    cache.set(feed.url, slot);
  }
  let fromCache = true;
  if (slot.checkedAt && now() < slot.checkedAt - 5000) {
    slot.nextAttempt = 0;
    slot.items = null;
    slot.fetchedAt = null;
  }
  if (slot.inFlight) {
    await slot.inFlight;
    fromCache = false;
  } else if (now() >= slot.nextAttempt) {
    fromCache = false;
    slot.inFlight = (async () => {
      slot.checkedAt = now();
      const controller = new AbortController();
      let failureCode = "unavailable";
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await fetchImpl(feed.url, {
          redirect: "error",
          signal: controller.signal,
          headers: {
            Accept: `${feed.accept}, application/xml, text/xml, text/calendar, text/html`,
            "User-Agent": "AurumQuantAI-Calendar/1.0",
          },
        });
        if (!response.ok) {
          failureCode = `http_${response.status}`;
          await response.body?.cancel();
          throw new Error("Calendar source unavailable.");
        }
        const contentType = response.headers.get("content-type") || "";
        if (/application\/json/i.test(contentType)) {
          await response.body?.cancel();
          throw new Error("Calendar source unavailable.");
        }
        failureCode = "invalid_feed";
        const text = await limitedText(response, controller.signal);
        slot.items = feed.parser(text);
        slot.fetchedAt = now();
        slot.failed = false;
        slot.errorCode = null;
        slot.nextAttempt = now() + CALENDAR_REFRESH_MS;
      } catch {
        slot.failed = true;
        slot.errorCode = controller.signal.aborted ? "timeout" : failureCode;
        slot.nextAttempt = now() + RETRY_MS;
      } finally {
        clearTimeout(timer);
      }
    })();
    try {
      await slot.inFlight;
    } finally {
      slot.inFlight = null;
    }
  }
  const usable =
    slot.items !== null &&
    now() - slot.fetchedAt <= CALENDAR_MAX_CACHE_AGE_MS &&
    now() >= slot.fetchedAt - 5000;
  const source = calendarSource(feed.sourceId);
  return {
    source: {
      id: source.id,
      name: source.name,
      homepage: source.homepage,
      status: slot.failed ? (usable ? "stale" : "unavailable") : "ok",
      errorCode: slot.errorCode || null,
      checkedAt: new Date(slot.checkedAt ?? now()).toISOString(),
      fetchedAt:
        slot.fetchedAt === null ? null : new Date(slot.fetchedAt).toISOString(),
    },
    items: usable
      ? slot.items.map((item) => ({
          ...item,
          fetchedAt: new Date(slot.fetchedAt).toISOString(),
          cached: slot.failed,
        }))
      : [],
    fromCache,
  };
}
export function calendarConfiguration() {
  return {
    available: true,
    readOnly: true,
    refreshIntervalMs: CALENDAR_REFRESH_MS,
    horizonDays: Math.round(CALENDAR_HORIZON_MS / 86400000),
    maxEvents: CALENDAR_MAX_EVENTS,
    sourceCount: CALENDAR_SOURCES.length,
    paidApiKeyRequired: false,
  };
}
export async function getUpcomingEvents({
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const feeds = calendarFeeds(now());
  const results = await Promise.all(
    feeds.map((feed) => feedSnapshot(feed, fetchImpl, now)),
  );
  const windowStart = now() - 60 * 60 * 1000;
  const windowEnd = now() + CALENDAR_HORIZON_MS;
  const merged = new Map();
  for (const result of results) {
    for (const item of result.items) {
      const startsMs = Date.parse(item.startsAt);
      if (
        !Number.isFinite(startsMs) ||
        startsMs < windowStart ||
        startsMs > windowEnd
      )
        continue;
      const impact = eventImpact(item.kind, item.title);
      if (impact === "low") continue; // keep the desk focused on market-moving items
      const key =
        item.title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") +
        Math.floor(startsMs / 3600000);
      const existing = merged.get(key);
      if (!existing || item.sourceId === "fed-calendar") merged.set(key, { ...item, impact });
    }
  }
  const events = [...merged.values()]
    .sort(
      (a, b) =>
        Date.parse(a.startsAt) - Date.parse(b.startsAt) ||
        Number(b.impact === "high") - Number(a.impact === "high"),
    )
    .slice(0, CALENDAR_MAX_EVENTS)
    .map((item, index) => ({
      ...item,
      id: `${item.sourceId}-${index + 1}`,
      currency: "USD",
    }));
  const sourceResults = new Map();
  for (const result of results) {
    const existing = sourceResults.get(result.source.id);
    if (!existing) sourceResults.set(result.source.id, result.source);
    else if (result.source.status === "ok" && existing.status !== "ok")
      sourceResults.set(result.source.id, result.source);
  }
  const sources = [...sourceResults.values()];
  const good = sources.filter((source) => source.status === "ok").length;
  const status = !good && !events.length
    ? "unavailable"
    : events.length && !good
      ? "stale"
      : good < sources.length
        ? "partial"
        : events.length
          ? "available"
          : "empty";
  return normalizeCalendarEvidence({
    type: "economic_calendar",
    readOnly: true,
    status,
    checkedAt: new Date(
      Math.max(...sources.map((source) => Date.parse(source.checkedAt))),
    ).toISOString(),
    cached: results.every((result) => result.fromCache),
    horizonDays: Math.round(CALENDAR_HORIZON_MS / 86400000),
    events,
    sources,
  });
}
