import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseIcsCalendar,
  parseFedCalendarPage,
  parseFedSpeechesFeed,
  getUpcomingEvents,
  calendarConfiguration,
} from "../lib/economic-calendar.mjs";
import {
  normalizeCalendarEvidence,
  calendarStatusText,
  calendarCountdown,
  eventImpact,
  safeCalendarUrl,
  CALENDAR_SOURCES,
} from "../modules/economic-calendar-evidence.mjs";
import handler from "../api-handlers/economic-calendar.js";

const NOW = Date.parse("2026-11-06T12:00:00Z"); // Friday, Nov 6 2026 12:00 UTC

const ICS = `BEGIN:VCALENDAR
PRODID:-//Department of Labor//Bureau of Labor Statistics//EN
VERSION:2.0
CALSCALE:GREGORIAN
X-WR-TIMEZONE:US-Eastern
BEGIN:VEVENT
UID:aaa-1
DTSTART;TZID=US-Eastern:20261106T083000
SUMMARY:Employment Situation
LOCATION:Washington\\, DC
CATEGORIES:IMPORTANT, BLS
END:VEVENT
BEGIN:VEVENT
UID:bbb-2
DTSTART;TZID=US-Eastern:20261210T083000
SUMMARY:Consumer Price Index
CATEGORIES:IMPORTANT, BLS
END:VEVENT
BEGIN:VEVENT
UID:ccc-3
DTSTART:20260701T120000Z
SUMMARY:UTC form event
END:VEVENT
BEGIN:VEVENT
UID:ddd-4
DTSTART;TZID=US-Eastern:20260701T120000
SUMMARY:Summer EDT event
END:VEVENT
BEGIN:VEVENT
UID:eee-5
DTSTART;VALUE=DATE:20261120
SUMMARY:All-day event
END:VEVENT
END:VCALENDAR
`;

const FED_PAGE = `<html><body>
<h2>Calendar</h2>
<h3>November 2026</h3>
<h3>Speeches</h3>
<ul>
<li><span>10:50 a.m.</span><p>Speech - Governor Michael S. Barr</p><p><em>Economic Outlook</em></p><p>At a conference, Washington, D.C.</p><span>13</span></li>
<li><span>4:00 a.m.</span><p>Speech - Governor Christopher J. Waller</p><p>At a conference, London</p><span>10</span></li>
</ul>
<h3>FOMC Meetings</h3>
<ul>
<li><span>2:00 p.m.</span><p>FOMC Meeting</p><p>Two-day meeting, December 8 - 9</p><span>9</span></li>
</ul>
<h3>Statistical Releases</h3>
<ul>
<li><span>4:15 p.m.</span><p>G.5 - Foreign Exchange Rates</p><span>2</span></li>
<li><span>1:00 p.m.</span><p>H.6 - Money Stock Measures</p><span>6, 13, 20, 27</span></li>
</ul>
<h3>Other</h3>
<ul>
<li><p>Holiday - Veterans Day</p><span>11</span></li>
</ul>
</body></html>`;

const FED_SPEECHES = `<?xml version="1.0"?><rss version="2.0"><channel><title>FRB: Speeches</title>
<item><title>Powell: The Economic Outlook</title><link>https://www.federalreserve.gov/newsevents/speeches/powell20261112a.htm</link><pubDate>Thu, 12 Nov 2026 14:00:00 GMT</pubDate></item>
<item><title>Waller: Payments</title><link>https://www.federalreserve.gov/newsevents/speeches/waller20261001a.htm</link><pubDate>Thu, 01 Oct 2026 14:00:00 GMT</pubDate></item>
<item><title>Bad date entry</title><link>https://www.federalreserve.gov/newsevents/speeches/x.htm</link><pubDate>not a date</pubDate></item>
</channel></rss>`;

test("iCal parsing converts US-Eastern times with DST and supports UTC/all-day forms", () => {
  const events = parseIcsCalendar(ICS, "bls-schedule", NOW);
  const bySummary = Object.fromEntries(events.map((e) => [e.title, e]));
  // Nov 6 2026 is EST (UTC-5): 08:30 ET -> 13:30 UTC
  assert.equal(bySummary["Employment Situation"].startsAt, "2026-11-06T13:30:00.000Z");
  // Dec 10 2026 is EST: 08:30 ET -> 13:30 UTC
  assert.equal(bySummary["Consumer Price Index"].startsAt, "2026-12-10T13:30:00.000Z");
  // Zulu form stays UTC
  assert.equal(bySummary["UTC form event"].startsAt, "2026-07-01T12:00:00.000Z");
  // Jul 1 2026 is EDT (UTC-4): 12:00 ET -> 16:00 UTC
  assert.equal(bySummary["Summer EDT event"].startsAt, "2026-07-01T16:00:00.000Z");
  // All-day date -> midnight ET (EST in November) -> 05:00 UTC
  assert.equal(bySummary["All-day event"].startsAt, "2026-11-20T05:00:00.000Z");
  assert.equal(bySummary["Employment Situation"].kind, "report");
  assert.ok(events.every((e) => e.sourceId === "bls-schedule"));
});

test("iCal rejects malformed or oversized input", () => {
  assert.throws(() => parseIcsCalendar("not a calendar", "bls-schedule", NOW));
  assert.throws(() => parseIcsCalendar("x".repeat(300000), "bls-schedule", NOW));
  assert.throws(() => parseIcsCalendar(ICS, "unknown-source", NOW));
  assert.throws(() => parseIcsCalendar(ICS.replace("BEGIN:VCALENDAR", "BEGIN:WHATEVER"), "bls-schedule", NOW));
});

test("Fed calendar pages parse speeches, FOMC meetings and multi-day releases from HTML text", () => {
  const events = parseFedCalendarPage(FED_PAGE, "fed-calendar", 2026, "november", NOW);
  const byTitle = Object.fromEntries(events.map((e) => [e.title, e]));
  // Nov 13 2026 10:50 a.m. EST -> 15:50 UTC
  assert.equal(byTitle["Speech - Governor Michael S. Barr"].startsAt, "2026-11-13T15:50:00.000Z");
  assert.equal(byTitle["Speech - Governor Michael S. Barr"].kind, "speech");
  // Nov 10 4:00 a.m. EST -> 09:00 UTC
  assert.equal(byTitle["Speech - Governor Christopher J. Waller"].startsAt, "2026-11-10T09:00:00.000Z");
  // FOMC meeting entry on day 9 at 2:00 p.m. EST -> 19:00 UTC
  assert.equal(byTitle["FOMC Meeting"].startsAt, "2026-11-09T19:00:00.000Z");
  assert.equal(byTitle["FOMC Meeting"].kind, "meeting");
  // Weekly release expands to four day entries
  const money = events.filter((e) => e.title === "H.6 - Money Stock Measures");
  assert.equal(money.length, 4);
  assert.equal(money[0].startsAt, "2026-11-06T18:00:00.000Z"); // 1:00 p.m. EST
  // "Other"/holiday section is ignored
  assert.ok(!events.some((e) => /Holiday/.test(e.title)));
});

test("Fed speeches feed keeps only future-dated, valid entries", () => {
  const events = parseFedSpeechesFeed(FED_SPEECHES, "fed-speeches", NOW);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "Powell: The Economic Outlook");
  assert.equal(events[0].startsAt, "2026-11-12T14:00:00.000Z");
  assert.equal(events[0].kind, "speech");
});

test("impact classification marks FOMC, key reports and chair speeches as high", () => {
  assert.equal(eventImpact("meeting", "FOMC Meeting"), "high");
  assert.equal(eventImpact("report", "Consumer Price Index"), "high");
  assert.equal(eventImpact("report", "Employment Situation"), "high");
  assert.equal(eventImpact("speech", "Speech - Chair Jerome H. Powell"), "high");
  assert.equal(eventImpact("speech", "Speech - Governor Lisa D. Cook"), "medium");
  assert.equal(eventImpact("release", "G.5 - Foreign Exchange Rates"), "low");
});

function calendarMock({ fail = new Set(), onRequest } = {}) {
  const calls = [];
  const fetch = async (url, options) => {
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    assert.equal(options.headers.Authorization, undefined);
    calls.push(url);
    if (onRequest) {
      const res = onRequest(url);
      if (res) return res;
    }
    if (url.endsWith("bls.ics"))
      return new Response(fail.has("bls-schedule") ? "err" : ICS, {
        headers: { "Content-Type": "text/calendar" },
      });
    if (url.endsWith("speeches.xml"))
      return new Response(FED_SPEECHES, {
        headers: { "Content-Type": "application/rss+xml" },
      });
    if (url.includes("2026-november.htm") || url.includes("2026-december.htm"))
      return new Response(fail.has("fed-calendar") ? "err" : FED_PAGE, {
        headers: { "Content-Type": "text/html" },
      });
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { fetch, calls };
}

test("getUpcomingEvents merges official sources, keeps upcoming USD events, sorts and caps", async () => {
  const { fetch, calls } = calendarMock();
  const result = await getUpcomingEvents({ fetchImpl: fetch, now: () => NOW });
  assert.ok(result);
  assert.equal(result.type, "economic_calendar");
  assert.equal(result.readOnly, true);
  assert.equal(result.status, "available");
  // Only fixed official URLs were requested
  assert.ok(calls.every((url) => /^https:\/\/(www\.bls\.gov|www\.federalreserve\.gov)\//.test(url)));
  assert.equal(new Set(calls.map((u) => new URL(u).origin)).size, 2);
  // Low-impact Fed statistical releases are filtered out
  assert.ok(!result.events.some((e) => e.impact === "low"));
  // Sorted ascending by start time
  const times = result.events.map((e) => Date.parse(e.startsAt));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  // All events are within the horizon and not long past
  for (const event of result.events) {
    const t = Date.parse(event.startsAt);
    assert.ok(t > NOW - 3600000 && t <= NOW + 30 * 86400000 + 1);
    assert.equal(event.currency, "USD");
    assert.ok(["report", "meeting", "speech", "release"].includes(event.kind));
  }
  // Past speech from the feed is excluded
  assert.ok(!result.events.some((e) => e.title === "Waller: Payments"));
  // Key upcoming items are present with impact labels
  const jobs = result.events.find((e) => e.title === "Employment Situation");
  assert.equal(jobs.impact, "high");
  assert.equal(jobs.sourceId, "bls-schedule");
  const fomc = result.events.find((e) => e.title === "FOMC Meeting");
  assert.equal(fomc.impact, "high");
  assert.equal(fomc.sourceId, "fed-calendar");
  const powell = result.events.find((e) => e.title === "Powell: The Economic Outlook");
  assert.equal(powell.impact, "high");
  assert.equal(powell.kind, "speech");
});

test("getUpcomingEvents degrades to partial/stale/unavailable instead of failing", async () => {
  const partial = await getUpcomingEvents({
    fetchImpl: calendarMock({ fail: new Set(["fed-calendar"]) }).fetch,
    now: () => NOW,
  });
  assert.equal(partial.status, "partial");
  assert.ok(partial.events.length > 0);
  const unavailable = await getUpcomingEvents({
    fetchImpl: calendarMock({ fail: new Set(["bls-schedule", "fed-calendar"]) }).fetch,
    now: () => NOW,
  });
  // fed-speeches still has one future item, so partial with that item
  assert.ok(["partial", "available"].includes(unavailable.status));
});

test("normalizeCalendarEvidence validates shape and rebuilds source identity from the registry", () => {
  const good = normalizeCalendarEvidence({
    type: "economic_calendar",
    readOnly: true,
    status: "available",
    checkedAt: "2026-11-06T12:00:00Z",
    events: [
      {
        id: "bls-schedule-1",
        title: "Consumer Price Index",
        url: "https://www.bls.gov/schedule/news_release/cpi.htm?utm_source=x",
        sourceId: "bls-schedule",
        kind: "report",
        impact: "high",
        currency: "USD",
        startsAt: "2026-12-10T13:30:00Z",
      },
    ],
    sources: [{ id: "bls-schedule", status: "ok", checkedAt: "2026-11-06T12:00:00Z" }],
  });
  assert.equal(good.events.length, 1);
  assert.equal(good.events[0].source, "BLS · release schedule");
  assert.equal(good.events[0].url, "https://www.bls.gov/schedule/news_release/cpi.htm");
  assert.equal(good.sources[0].name, "BLS · release schedule");
  // Wrong type / status / readOnly are rejected
  assert.equal(normalizeCalendarEvidence({ type: "market_news", readOnly: true, status: "available", checkedAt: "2026-11-06T12:00:00Z" }), null);
  assert.equal(normalizeCalendarEvidence({ type: "economic_calendar", readOnly: true, status: "weird", checkedAt: "2026-11-06T12:00:00Z" }), null);
  assert.equal(normalizeCalendarEvidence({ type: "economic_calendar", readOnly: true, status: "available", checkedAt: "nope" }), null);
  // Cross-host URL is rejected even if the source is known
  const evil = normalizeCalendarEvidence({
    type: "economic_calendar",
    readOnly: true,
    status: "available",
    checkedAt: "2026-11-06T12:00:00Z",
    events: [
      { title: "x", url: "https://evil.example.com/x", sourceId: "bls-schedule", kind: "report", impact: "high", startsAt: "2026-12-10T13:30:00Z" },
    ],
    sources: [],
  });
  assert.equal(evil.events.length, 0);
});

test("calendarStatusText and countdown label upcoming events plainly", () => {
  const status = calendarStatusText(
    {
      type: "economic_calendar",
      readOnly: true,
      status: "available",
      checkedAt: new Date(NOW).toISOString(),
      events: [],
      sources: [],
    },
    NOW,
  );
  assert.equal(status.state, "empty");
  assert.match(status.label, /No upcoming events/);
  assert.equal(calendarCountdown(new Date(NOW + 30 * 60000).toISOString(), NOW), "in 30 min");
  assert.equal(calendarCountdown(new Date(NOW + 50 * 3600000).toISOString(), NOW), "in 2 days");
  assert.equal(calendarCountdown(new Date(NOW - 60000).toISOString(), NOW), "started");
  assert.equal(safeCalendarUrl("https://www.federalreserve.gov/newsevents/calendar.htm", "fed-calendar"), "https://www.federalreserve.gov/newsevents/calendar.htm");
  assert.equal(safeCalendarUrl("http://www.bls.gov/x", "bls-schedule"), null);
  assert.equal(calendarConfiguration().paidApiKeyRequired, false);
  assert.equal(CALENDAR_SOURCES.length, 3);
});

test("economic-calendar handler is GET-only and rejects query parameters", async () => {
  const makeRes = () => {
    const res = {
      headers: {},
      statusCode: 200,
      body: null,
      setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    return res;
  };
  const res405 = makeRes();
  await handler({ method: "POST", query: {} }, res405);
  assert.equal(res405.statusCode, 405);
  const res400 = makeRes();
  await handler({ method: "GET", query: { url: "https://evil.example.com" } }, res400);
  assert.equal(res400.statusCode, 400);
});
