import {
  normalizeNewsEvidence,
  newsStatusText,
  newsItemAge,
  newsHighlights,
  newsTimeText,
  NEWS_REFRESH_MS,
  NEWS_MAX_CACHE_AGE_MS,
} from "./chat-news-evidence.mjs";
import {
  normalizeCalendarEvidence,
  calendarStatusText,
  calendarCountdown,
  CALENDAR_MAX_CACHE_AGE_MS,
} from "./economic-calendar-evidence.mjs";

const node = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};
const timeLabel = (value) =>
  value
    ? new Date(value).toLocaleString([], {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      })
    : "time unavailable";
function sourceLink(item, citation = false) {
  const row = node("li", "news-item");
  const link = node(
    "a",
    "news-headline",
    `${citation && item.citation ? `[${item.citation}] ` : ""}${item.title}`,
  );
  link.href = item.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.referrerPolicy = "no-referrer";
  row.append(link);
  const meta = node("div", "news-meta");
  meta.append(node("span", "news-publisher", item.source));
  const time = node(
    "time",
    "",
    item.publishedAt
      ? `Published ${timeLabel(item.publishedAt)}`
      : item.updatedAt
        ? `Updated ${timeLabel(item.updatedAt)} · publication time unavailable`
        : newsTimeText(item),
  );
  if (item.publishedAt || item.updatedAt)
    time.dateTime = item.publishedAt || item.updatedAt;
  meta.append(time);
  if (item.category === "commentary")
    meta.append(node("span", "news-age", "Analysis / commentary"));
  const age = newsItemAge(item);
  if (age !== "recent")
    meta.append(
      node(
        "span",
        "news-age",
        age === "older"
          ? "Older item · not breaking"
          : "Publication time unverified",
      ),
    );
  if (item.cached)
    meta.append(node("span", "news-age", "Cached · feed unavailable"));
  row.append(meta);
  return row;
}
export function newsEvidenceNode(value) {
  const news = normalizeNewsEvidence(value, { limit: 6 });
  if (!news) return null;
  const card = node("details", "news-evidence");
  card.setAttribute("aria-label", "News sources supplied for this answer");
  const summary = node(
    "summary",
    "",
    `News sources for this reply${news.items.length ? ` · ${news.items.length}` : ""}`,
  );
  card.append(
    summary,
    node(
      "p",
      "news-snapshot-note",
      `Historical snapshot checked ${timeLabel(news.checkedAt)}. These links are not continuously updated with the conversation.`,
    ),
  );
  const status = newsStatusText(news);
  card.dataset.status = status.state;
  if (status.state !== "available") summary.textContent += ` · ${status.label}`;
  card.append(node("p", "news-snapshot-note", status.detail));
  const list = node("ol", "news-list");
  news.items.forEach((item) => list.append(sourceLink(item, true)));
  card.append(list);
  return card;
}

export function createNewsPanel({
  panel,
  list,
  status,
  updated,
  coverage,
  sources,
  refreshButton,
  askButton,
  fetchImpl = globalThis.fetch,
}) {
  let enabled = null,
    snapshot = null,
    controller = null,
    timer,
    generation = 0,
    nextCheckAt = 0,
    listSignature = "";
  function render() {
    if (!enabled) {
      panel.dataset.status = "off";
      status.textContent = "News context is off for this conversation.";
      updated.textContent = "Automatic news lookups and refresh are paused.";
      refreshButton.disabled = true;
      askButton.disabled = true;
      list.replaceChildren();
      sources.replaceChildren();
      coverage.textContent = "Public RSS sources";
      listSignature = "";
      return;
    }
    const description = snapshot
      ? newsStatusText(snapshot)
      : { state: "loading", label: "Checking public feeds…", detail: "" };
    panel.dataset.status = description.state;
    status.textContent = `${description.label}${description.detail ? `. ${description.detail}` : ""}`;
    updated.textContent = snapshot
      ? `Feed check: ${timeLabel(snapshot.checkedAt)}${snapshot.cached ? " · cached result" : ""}`
      : "No current headlines have been checked yet.";
    refreshButton.disabled = Boolean(controller);
    askButton.disabled = false;
    if (!snapshot) return;
    const signature = JSON.stringify(
      snapshot.items.map((item) => [
        item.id,
        item.title,
        item.url,
        item.publishedAt,
        item.updatedAt,
        item.publishedTimeText,
        item.category,
        item.cached,
        newsItemAge(item),
      ]),
    );
    if (signature !== listSignature) {
      const focused = list.contains(document.activeElement)
        ? document.activeElement?.href
        : null;
      list.replaceChildren(
        ...newsHighlights(snapshot.items, 8).map((item) => sourceLink(item)),
      );
      if (focused)
        [...list.querySelectorAll("a")]
          .find((link) => link.href === focused)
          ?.focus({ preventScroll: true });
      listSignature = signature;
    }
    const healthy = snapshot.sources.filter(
      (source) => source.status === "ok",
    ).length;
    coverage.textContent = snapshot.sources.length
      ? `Sources at last check · ${healthy}/${snapshot.sources.length} available`
      : "Source details unavailable";
    sources.replaceChildren(
      ...snapshot.sources.map((source) => {
        const row = node("li", "");
        const link = node("a", "", source.name);
        link.href = source.homepage;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.referrerPolicy = "no-referrer";
        row.append(
          link,
          node(
            "span",
            "",
            source.status === "ok"
              ? "Available"
              : source.status === "stale"
                ? "Cached"
                : "Unavailable",
          ),
        );
        return row;
      }),
    );
    if (eventsList && eventsStatus) {
      const calendarDescription = calendar
        ? calendarStatusText(calendar)
        : { state: "loading", label: "Checking upcoming events…", detail: "" };
      eventsStatus.textContent = `${calendarDescription.label}${calendarDescription.detail ? `. ${calendarDescription.detail}` : ""}`;
      const signature = calendar
        ? JSON.stringify(
            calendar.events.map((event) => [
              event.id,
              event.title,
              event.startsAt,
              event.impact,
              event.kind,
              event.cached,
            ]),
          )
        : "";
      if (signature !== eventsSignature) {
        eventsList.replaceChildren(
          ...(calendar?.events || []).map((event) => eventLink(event)),
        );
        eventsSignature = signature;
      }
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (enabled && document.visibilityState !== "hidden")
      timer = setTimeout(
        () => load(),
        Math.max(1000, nextCheckAt - Date.now()),
      );
  }
  async function load(manual = false) {
    if (!enabled || controller || document.visibilityState === "hidden") return;
    if (!manual && Date.now() < nextCheckAt) return schedule();
    const requestGeneration = generation;
    controller = new AbortController();
    const active = controller;
    const timeout = setTimeout(() => active.abort(), 10000);
    refreshButton.disabled = true;
    panel.setAttribute("aria-busy", "true");
    status.textContent = "Checking public feeds…";
    const loadNews = async () => {
      try {
        const response = await fetchImpl("/api/market-news", {
          headers: { Accept: "application/json" },
          signal: active.signal,
        });
        const value = normalizeNewsEvidence(await response.json());
        if (!response.ok || !value) throw new Error("News unavailable.");
        if (!enabled || generation !== requestGeneration) return;
        snapshot = value;
      } catch {
        if (!enabled || generation !== requestGeneration) return;
        snapshot =
          snapshot &&
          Date.now() - Date.parse(snapshot.checkedAt) <= NEWS_MAX_CACHE_AGE_MS
            ? {
                ...snapshot,
                status: "stale",
                cached: true,
                items: snapshot.items.map((item) => ({ ...item, cached: true })),
              }
            : {
                type: "market_news",
                readOnly: true,
                status: "unavailable",
                checkedAt: new Date().toISOString(),
                items: [],
                sources: [],
              };
      }
    };
    const loadCalendar = async () => {
      try {
        const response = await fetchImpl("/api/economic-calendar", {
          headers: { Accept: "application/json" },
          signal: active.signal,
        });
        const value = normalizeCalendarEvidence(await response.json());
        if (!response.ok || !value) throw new Error("Events unavailable.");
        if (!enabled || generation !== requestGeneration) return;
        calendar = value;
      } catch {
        if (!enabled || generation !== requestGeneration) return;
        calendar =
          calendar &&
          Date.now() - Date.parse(calendar.checkedAt) <= CALENDAR_MAX_CACHE_AGE_MS
            ? {
                ...calendar,
                status: "stale",
                cached: true,
                events: calendar.events.map((event) => ({
                  ...event,
                  cached: true,
                })),
              }
            : {
                type: "economic_calendar",
                readOnly: true,
                status: "unavailable",
                checkedAt: new Date().toISOString(),
                events: [],
                sources: [],
              };
      }
    };
    try {
      await Promise.all([loadNews(), loadCalendar()]);
    } finally {
      clearTimeout(timeout);
      if (controller === active) controller = null;
      if (generation === requestGeneration) {
        nextCheckAt = Date.now() + NEWS_REFRESH_MS;
        panel.removeAttribute("aria-busy");
        render();
        schedule();
      }
    }
  }
  const refresh = () => load(true);
  const visible = () => {
    if (document.visibilityState === "hidden") clearTimeout(timer);
    else load();
  };
  refreshButton.addEventListener("click", refresh);
  document.addEventListener("visibilitychange", visible);
  return {
    setEnabled(value) {
      if (enabled === value) return;
      enabled = value;
      generation++;
      clearTimeout(timer);
      controller?.abort();
      controller = null;
      panel.removeAttribute("aria-busy");
      render();
      if (enabled) load();
    },
    pause() {
      generation++;
      clearTimeout(timer);
      controller?.abort();
      controller = null;
      panel.removeAttribute("aria-busy");
    },
    resume() {
      if (enabled) load();
    },
    dispose() {
      enabled = false;
      generation++;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", visible);
      refreshButton.removeEventListener("click", refresh);
    },
  };
}
