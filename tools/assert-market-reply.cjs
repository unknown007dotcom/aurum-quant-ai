const assert = require("node:assert/strict");

// Shared by the packaged release gate and real public/browser verification.
// Neither a configured flag nor a model saying "I have access" is sufficient.
module.exports = function assertMarketReply(payload) {
  const market = payload?.market;
  assert.equal(
    market?.provider,
    "OANDA",
    "No OANDA evidence attached to the reply",
  );
  assert.equal(market.instrument, "XAU_USD");
  assert.equal(market.readOnly, true);
  assert.ok(
    ["live", "stale", "market_closed"].includes(market.status),
    `Market lookup failed: ${market.error?.code || market.status}`,
  );
  assert.ok(Number.isFinite(market.quote?.mid) && market.quote.mid > 0);
  assert.ok(Number.isFinite(Date.parse(market.quote.time)));
  assert.ok(Number.isFinite(Date.parse(market.checkedAt)));
  for (const timeframe of ["M15", "H1"]) {
    assert.ok(
      market.candles?.[timeframe]?.samples > 0,
      `${timeframe} candles were not retrieved`,
    );
    assert.ok(Number.isFinite(Date.parse(market.candles[timeframe].asOf)));
  }
  const content = payload.content;
  assert.ok(
    typeof content === "string" && content.trim().length > 30,
    "No substantive assistant answer",
  );
  assert.match(content, /OANDA/i, "The assistant must attribute the quote");
  const numbers = (
    content.replaceAll(",", "").match(/\b\d{3,6}(?:\.\d{1,6})?\b/g) || []
  ).map(Number);
  assert.ok(
    numbers.some((number) =>
      [market.quote.mid, market.quote.bid, market.quote.ask].some(
        (price) => Math.abs(price - number) < 0.011,
      ),
    ),
    "The assistant did not use the actual supplied quote",
  );
  if (market.status !== "live")
    assert.match(
      content,
      /last|closed|stale|not.{0,15}live|non.?trad[ae]able/i,
      "A closed/stale quote must not be presented as live",
    );
  const evidence = JSON.stringify(market);
  assert.ok(
    !/apiKey|accountId|Authorization|Bearer |oandaApiToken|server-oanda-token/.test(
      evidence,
    ),
    "Private connection metadata leaked",
  );
  return market;
};

module.exports.QUESTION =
  "Fetch the latest available OANDA XAU/USD quote. In two short sentences give the bid, ask, midpoint and quote timestamp in UTC, and say whether it is live, stale or not tradeable. Use the attached data, even when the market is closed. Do not place an order.";
