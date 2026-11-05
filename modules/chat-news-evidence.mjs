// Public, read-only news provenance. Shared by the server and browser.
// Never trust arbitrary feed URLs, source names, HTML, or extra stored fields.
export const NEWS_REFRESH_MS = 3 * 60 * 1000;
export const NEWS_RECENT_MS = 48 * 60 * 60 * 1000;
export const NEWS_MAX_CACHE_AGE_MS = 30 * 60 * 1000;
export const NEWS_SOURCES = Object.freeze([
  {
    id: "investing-commodities",
    name: "Investing.com",
    kind: "market_news",
    homepage: "https://www.investing.com/commodities/",
    hosts: ["www.investing.com", "investing.com"],
  },
  {
    id: "bbc-business",
    name: "BBC Business",
    kind: "market_news",
    homepage: "https://www.bbc.com/business",
    hosts: ["www.bbc.com", "bbc.com", "www.bbc.co.uk", "bbc.co.uk"],
  },
  {
    id: "fed-policy",
    name: "Federal Reserve · policy",
    kind: "official_release",
    homepage: "https://www.federalreserve.gov/newsevents/pressreleases.htm",
    hosts: ["www.federalreserve.gov", "federalreserve.gov"],
  },
  {
    id: "fed-speeches",
    name: "Federal Reserve · speeches",
    kind: "official_release",
    homepage: "https://www.federalreserve.gov/newsevents/speeches.htm",
    hosts: ["www.federalreserve.gov", "federalreserve.gov"],
  },
  {
    id: "bls-cpi",
    name: "BLS · inflation",
    kind: "official_release",
    homepage: "https://www.bls.gov/cpi/",
    hosts: ["www.bls.gov", "bls.gov"],
  },
  {
    id: "bls-jobs",
    name: "BLS · employment",
    kind: "official_release",
    homepage: "https://www.bls.gov/ces/",
    hosts: ["www.bls.gov", "bls.gov"],
  },
]);
export const NEWS_STATES = new Set([
  "available",
  "partial",
  "stale",
  "empty",
  "unavailable",
]);
const sourceById = new Map(NEWS_SOURCES.map((source) => [source.id, source]));
export function newsSource(id) {
  return sourceById.get(id) || null;
}
export function newsDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return null;
  return new Date(value).toISOString();
}
export function newsText(value, limit = 240) {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, limit)
    : "";
}
export function safeNewsUrl(value, sourceId) {
  const source = newsSource(sourceId);
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
export function newsItemAge(item, now = Date.now()) {
  const time = Date.parse(item.publishedAt || "");
  if (!Number.isFinite(time) || time > now + 5 * 60 * 1000) return "unknown";
  return now - time <= NEWS_RECENT_MS ? "recent" : "older";
}
export function normalizeNewsEvidence(value, { limit = 18 } = {}) {
  if (
    !value ||
    value.type !== "market_news" ||
    value.readOnly !== true ||
    !NEWS_STATES.has(value.status)
  )
    return null;
  const checkedAt = newsDate(value.checkedAt);
  if (!checkedAt) return null;
  const items = [],
    seen = new Set();
  for (const item of (Array.isArray(value.items) ? value.items : []).slice(
    0,
    60,
  )) {
    const source = newsSource(item?.sourceId);
    const url = safeNewsUrl(item?.url, source?.id);
    const title = newsText(item?.title);
    if (!source || !url || !title || seen.has(url)) continue;
    seen.add(url);
    items.push({
      id:
        typeof item.id === "string" && /^[a-z0-9-]{1,80}$/.test(item.id)
          ? item.id
          : `item-${items.length + 1}`,
      title,
      url,
      sourceId: source.id,
      source: source.name,
      kind: source.kind,
      topic: ["gold", "macro", "markets"].includes(item.topic)
        ? item.topic
        : "markets",
      publishedAt: newsDate(item.publishedAt),
      fetchedAt: newsDate(item.fetchedAt),
      freshness: newsItemAge(
        { publishedAt: newsDate(item.publishedAt) },
        Date.parse(checkedAt),
      ),
      cached: item.cached === true,
      ...(typeof item.citation === "string" && /^N[1-6]$/.test(item.citation)
        ? { citation: item.citation }
        : {}),
    });
    if (items.length >= Math.min(18, Math.max(1, limit))) break;
  }
  const sources = [];
  for (const entry of (Array.isArray(value.sources) ? value.sources : []).slice(
    0,
    12,
  )) {
    const source = newsSource(entry?.id);
    if (!source || sources.some((entry) => entry.id === source.id)) continue;
    sources.push({
      id: source.id,
      name: source.name,
      homepage: source.homepage,
      status: ["ok", "stale", "unavailable"].includes(entry.status)
        ? entry.status
        : "unavailable",
      checkedAt: newsDate(entry.checkedAt),
      fetchedAt: newsDate(entry.fetchedAt),
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
    type: "market_news",
    readOnly: true,
    status: value.status,
    checkedAt,
    cached: value.cached === true,
    refreshIntervalMs: NEWS_REFRESH_MS,
    recentWindowHours: 48,
    items,
    sources,
  };
}
export function newsStatusText(value, now = Date.now()) {
  const news = normalizeNewsEvidence(value);
  if (!news)
    return {
      state: "unavailable",
      label: "News unavailable",
      detail: "Headlines could not be checked. Chat can still continue.",
    };
  const oldSnapshot =
    now - Date.parse(news.checkedAt) > NEWS_MAX_CACHE_AGE_MS ||
    Date.parse(news.checkedAt) > now + 5 * 60 * 1000;
  const recent = news.items.some((item) => newsItemAge(item, now) === "recent");
  if (news.status === "unavailable")
    return {
      state: "unavailable",
      label: "News unavailable",
      detail:
        "The feeds could not be reached. No current headlines are being claimed.",
    };
  if (oldSnapshot || news.status === "stale" || (news.items.length && !recent))
    return {
      state: "stale",
      label: "Older or cached headlines",
      detail:
        "These are last-known items, not breaking news. Check publication dates.",
    };
  if (!news.items.length)
    return {
      state: news.status === "partial" ? "partial" : "empty",
      label: "No matching headlines",
      detail:
        news.status === "partial"
          ? "Some feeds are unavailable; the others returned no matching items."
          : "The checked feeds returned no matching gold or market headlines.",
    };
  if (news.status === "partial")
    return {
      state: "partial",
      label: "Some feeds unavailable",
      detail:
        "Available headlines are shown; coverage is incomplete. Cached items are labeled.",
    };
  return {
    state: "available",
    label: "Recent headlines",
    detail:
      "Public RSS snapshots, not an instant newswire. Publication times may lag events.",
  };
}
const markdownText = (value) => value.replace(/[\\`*_[\]<>|]/g, "\\$&");
export function newsEvidenceText(value) {
  const news = normalizeNewsEvidence(value, { limit: 6 });
  if (!news) return "";
  const heading = `News sources for this reply · snapshot checked ${news.checkedAt} (UTC). Historical evidence, not a continuously updated feed.`;
  return [
    heading,
    newsStatusText(news).detail,
    ...news.items.map(
      (item) =>
        `[${item.citation || item.id}] ${markdownText(item.title)} — ${item.source}. Published ${item.publishedAt || "time unavailable"}. ${item.url}`,
    ),
  ].join("\n");
}
