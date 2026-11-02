// Compact, safe provenance persisted with an assistant message. No credentials,
// arbitrary URLs, broker response bodies or full candle arrays enter chat storage.
const STATES = new Set(["live", "stale", "market_closed", "unavailable"]);
const ERROR_TEXT = {
  not_configured: "The server's OANDA connection is not configured.",
  invalid_configuration: "The server's OANDA environment needs attention.",
  unauthorized: "OANDA rejected the server connection.",
  rate_limited: "OANDA temporarily limited this lookup.",
  timeout: "The market-data lookup timed out; chat can still continue.",
  unavailable: "No OANDA market snapshot was available for this answer.",
  invalid_data: "A valid timestamped OANDA quote was not available.",
};
function date(value) {
  return typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT/.test(value) &&
    Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}
function number(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export function normalizeMarketEvidence(value) {
  if (
    !value ||
    typeof value !== "object" ||
    value.provider !== "OANDA" ||
    value.instrument !== "XAU_USD" ||
    value.readOnly !== true ||
    !STATES.has(value.status)
  )
    return null;
  const checkedAt = date(value.checkedAt);
  if (!checkedAt) return null;
  const bid = number(value.quote?.bid),
    ask = number(value.quote?.ask),
    time = date(value.quote?.time);
  const quote =
    bid && ask && ask >= bid && time
      ? {
          bid,
          ask,
          mid: Number(((bid + ask) / 2).toFixed(5)),
          time,
          tradeable:
            typeof value.quote.tradeable === "boolean"
              ? value.quote.tradeable
              : null,
        }
      : null;
  const status =
    quote && value.status !== "unavailable" ? value.status : "unavailable";
  const candidateCode = value.error?.code || value.errorCode;
  const errorCode =
    typeof candidateCode === "string" &&
    Object.hasOwn(ERROR_TEXT, candidateCode)
      ? candidateCode
      : "unavailable";
  return {
    provider: "OANDA",
    instrument: "XAU_USD",
    readOnly: true,
    status,
    checkedAt,
    environment: ["practice", "live"].includes(value.environment)
      ? value.environment
      : null,
    cached: value.cached === true,
    quote: status === "unavailable" ? null : quote,
    errorCode: status === "unavailable" ? errorCode : null,
  };
}

export function marketEvidenceText(value, now = Date.now()) {
  const market = normalizeMarketEvidence(value);
  if (!market) return null;
  const environment = market.environment ? ` · ${market.environment} feed` : "";
  const heading = `OANDA · XAU/USD · read-only${environment}`;
  if (!market.quote)
    return {
      heading,
      status: "unavailable",
      stateLabel: "Market data unavailable",
      detail: ERROR_TEXT[market.errorCode],
      timeLabel: `Lookup attempted ${market.checkedAt} (UTC)`,
    };
  const future = Date.parse(market.quote.time) > now + 5000;
  const old = now - Date.parse(market.quote.time) > 90_000 || future;
  const stateLabel = future
    ? "Unverified timestamp · not a live price"
    : market.status === "market_closed"
      ? "Not tradeable when checked · last-known quote"
      : market.status === "stale"
        ? "Stale quote · not live"
        : old
          ? "Historical snapshot · not a live price"
          : "Fresh quote snapshot";
  const money = (number) =>
    number.toLocaleString("en-US", {
      minimumFractionDigits: 3,
      maximumFractionDigits: 5,
    });
  return {
    heading,
    status: market.status === "live" && old ? "stale" : market.status,
    stateLabel,
    detail: `Bid $${money(market.quote.bid)} · Ask $${money(market.quote.ask)} · Mid $${money(market.quote.mid)} / troy oz`,
    timeLabel: `Quote ${market.quote.time} (UTC). Checked ${market.checkedAt}${market.cached ? " · cached snapshot" : ""}. Not streaming.`,
  };
}
