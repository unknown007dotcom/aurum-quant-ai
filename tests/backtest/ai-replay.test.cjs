const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  SESSION,
  FIVE,
  FIFTEEN,
  sha256,
  normalizeDataset,
  snapshotAt,
  validateSessionCoverage,
  createStrategyReplay,
} = require("../../tools/backtest/point-in-time.cjs");
const {
  classifyPlan,
  priceNumbers,
  simulate,
  COSTS,
} = require("../../tools/backtest/paper-execution.cjs");
const { csvCell } = require("../../tools/backtest/report.cjs");
const start = Date.parse(SESSION.start);
const iso = (n) => new Date(n).toISOString();
const row = (time, price = 4000) => ({
  datetime: iso(time),
  open: price,
  high: price + 1,
  low: price - 1,
  close: price + 0.2,
  volume: 20,
  complete: true,
});
function datasetFixture() {
  const from = Date.parse("2026-09-30T00:00:00Z"),
    to = Date.parse("2026-10-26T12:00:00Z");
  const specs = [
    ["5min", FIVE],
    ["15min", FIFTEEN],
    ["h1", 3600000],
    ["4h", 14400000],
    ["1day", 86400000],
  ];
  const data = specs.map(([id, step]) => ({
    id,
    symbolUsed: "XAU_USD",
    values: Array.from({ length: Math.floor((to - from) / step) }, (_, i) =>
      row(from + i * step, 4000 + Math.sin(i * 0.19) * 4),
    ),
  }));
  data.push({
    id: "1week",
    symbolUsed: "XAU_USD",
    values: [
      "2026-10-02T00:00:00Z",
      "2026-10-09T00:00:00Z",
      "2026-10-16T00:00:00Z",
      "2026-10-23T00:00:00Z",
      "2026-10-30T00:00:00Z",
    ].map((t) => row(Date.parse(t))),
  });
  data.push({
    id: "1month",
    symbolUsed: "XAU_USD",
    values: [
      "2026-06-01T00:00:00Z",
      "2026-07-01T00:00:00Z",
      "2026-08-01T00:00:00Z",
      "2026-09-01T00:00:00Z",
      "2026-10-01T00:00:00Z",
      "2026-11-01T00:00:00Z",
    ].map((t) => row(Date.parse(t))),
  });
  return { provider: "oanda", status: "ok", data };
}
const plan = (overrides = {}) => ({
  researcher: {
    direction: "Buy",
    summary: "Price-level analysis with defined entry and risk.",
  },
  trader: {
    entryZone: "4,000–4,001",
    stopLoss: "3998",
    takeProfitLevels: "TP1: 4004; TP2: 4007",
    ...overrides,
  },
});
const miniSession = { ...SESSION, end: iso(start + 6 * FIVE) };
const bars = (list) =>
  list.map((v, i) => ({
    time: start + i * FIVE,
    open: v[0],
    high: v[1],
    low: v[2],
    close: v[3],
  }));
const signal = (asOf = start, p = plan(), rule = "Buy", index = 1) => ({
  index,
  asOf: iso(asOf),
  status: "answered",
  execution: classifyPlan(p, rule, 4000),
});
const safeBars = () =>
  bars([
    [4000.5, 4007, 3990, 4001],
    [4000.5, 4002, 4000, 4001],
    [4001, 4005, 4000, 4004],
    [4004, 4004.5, 4003, 4004],
    [4004, 4004.5, 4003, 4004],
    [4004, 4004.5, 4003, 4004],
  ]);
const zeroSpread = { id: "test", spreadUsd: 0, slippagePerFillUsd: 0.1 };

test("the approved session is 34 M15 checkpoints, with correct NY daylight-saving conversion", () => {
  assert.equal((Date.parse(SESSION.end) - start) / FIFTEEN, 34);
  assert.equal(
    new Intl.DateTimeFormat("en-US", {
      timeZone: SESSION.timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(start)),
    "08:00",
  );
});

test("point-in-time snapshots only contain closed M15 entry candles and past-reconstructed forming parents", () => {
  const data = normalizeDataset(datasetFixture());
  const point = snapshotAt(data, start + FIFTEEN);
  const entry = point.market.data.find((frame) => frame.id === "entry").values;
  assert.equal(Date.parse(entry.at(-1).datetime) + FIFTEEN, start + FIFTEEN);
  assert.ok(entry.every((candle) => candle.complete === true));
  assert.equal(
    point.audit.h1.formingReconstructed.lastSourceBarClose,
    iso(start + FIFTEEN),
  );
  assert.equal(
    point.market.data.find((frame) => frame.id === "h1").values.at(-1).complete,
    false,
  );
  assert.ok(
    point.market.data.find((frame) => frame.id === "1month").values.at(-1)
      .high < 5000,
  );
});

test("changing all later OHLC values, including unclosed higher-timeframe highs, cannot change a past snapshot", () => {
  const raw = datasetFixture();
  const first = snapshotAt(normalizeDataset(raw), start + FIFTEEN);
  for (const frame of raw.data) {
    const step =
      frame.id === "5min"
        ? FIVE
        : frame.id === "15min"
          ? FIFTEEN
          : frame.id === "h1"
            ? 3600000
            : frame.id === "4h"
              ? 14400000
              : frame.id === "1day"
                ? 86400000
                : frame.id === "1week"
                  ? 604800000
                  : Infinity;
    for (let i = 0; i < frame.values.length; i++) {
      const candle = frame.values[i];
      const end =
        frame.id === "1month"
          ? frame.values[i + 1]
            ? Date.parse(frame.values[i + 1].datetime)
            : Infinity
          : Date.parse(candle.datetime) + step;
      if (end > start + FIFTEEN)
        for (const name of ["open", "high", "low", "close"])
          candle[name] += 100000;
    }
  }
  const second = snapshotAt(normalizeDataset(raw), start + FIFTEEN);
  assert.deepEqual(second, first);
});

test("a session with missing execution bars or insufficient entry warmup is rejected before AI usage", () => {
  const good = normalizeDataset(datasetFixture());
  assert.equal(validateSessionCoverage(good).executionBars, 102);
  const bad = structuredClone(good);
  bad.frames["5min"] = bad.frames["5min"].filter(
    (row) => row.time !== start + FIVE,
  );
  assert.throws(() => validateSessionCoverage(bad), /Missing M5/);
  const short = structuredClone(good);
  short.frames["15min"] = short.frames["15min"].filter(
    (row) => row.time >= start - 20 * FIFTEEN,
  );
  assert.throws(() => snapshotAt(short, start), /warmup/);
});

test("forming higher frames cannot be fabricated when their beginning is outside the M5 archive", () => {
  const data = normalizeDataset(datasetFixture());
  data.frames["5min"] = data.frames["5min"].filter(
    (row) => row.time >= start - 86400000,
  );
  assert.throws(() => snapshotAt(data, start), /does not cover/);
});

test("duplicate, wrong-instrument, impossible and timezone-ambiguous candles are rejected", () => {
  for (const mutate of [
    (data) => data.data[0].values.push(data.data[0].values[0]),
    (data) => {
      data.data[0].symbolUsed = "BTC_USD";
    },
    (data) => {
      data.data[0].values[0].high = 0;
    },
    (data) => {
      data.data[0].values[0].datetime = "2026-09-30 00:00:00";
    },
  ]) {
    const raw = datasetFixture();
    mutate(raw);
    assert.throws(() => normalizeDataset(raw));
  }
});

test("the replay uses the actual main-page engine and prompt source, not the separate bot strategy", () => {
  process.env.TZ = "Asia/Kolkata";
  const data = normalizeDataset(datasetFixture()),
    snap = snapshotAt(data, start + FIFTEEN);
  const a = createStrategyReplay(path.resolve(__dirname, "../.."));
  const b = createStrategyReplay(path.resolve(__dirname, "../.."));
  const result = a.evaluate(snap.market, start + FIFTEEN);
  assert.equal(
    result.analysis.price,
    snap.market.data.find((frame) => frame.id === "entry").values.at(-1).close,
  );
  assert.match(result.prompt, /Analyze this XAUUSD market data/);
  assert.match(result.prompt, /Liquidity Pools:/);
  assert.match(result.prompt, /Session Levels:/);
  assert.ok(["Buy", "Sell"].includes(result.analysis.decision.action));
  assert.equal(a.strategySha256.length, 64);
  assert.equal(
    sha256(result),
    sha256(b.evaluate(snap.market, start + FIFTEEN)),
  );
});

test("TP numbering, commas and percent labels do not become fake price levels", () => {
  assert.deepEqual(
    priceNumbers("TP1: $4,004.00 (80%); TP2: $4,007.00 (20%)", 4000),
    [4004, 4007],
  );
  const result = classifyPlan(plan(), "Buy", 4000);
  assert.equal(result.category, "executable");
  assert.equal(result.entryLow, 4000);
  assert.equal(result.entryHigh, 4001);
  assert.deepEqual(result.targets, [4004, 4007]);
});

test("AI flats and the actual main-page conflict guard do not become trades", () => {
  assert.equal(
    classifyPlan(
      { researcher: { direction: "Stay Flat" }, trader: {} },
      "Buy",
      4000,
    ).category,
    "stay_flat",
  );
  const sell = plan();
  sell.researcher.direction = "Sell";
  assert.equal(classifyPlan(sell, "Buy", 4000).category, "conflict_flat");
});

test("non-price confirmations, vague entries and contradictory stops/targets are not guessed", () => {
  for (const overrides of [
    { entryZone: "4000–4001 after a confirmed CHoCH" },
    { entryZone: "Around 4000" },
    { stopLoss: "4001" },
    { takeProfitLevels: "TP1 3990; TP2 3980" },
    { takeProfitLevels: "TP1 4007; TP2 4004" },
    { entryZone: "N/A" },
  ])
    assert.equal(
      classifyPlan(plan(overrides), "Buy", 4000).category,
      "unexecutable",
    );
});

test("execution waits until a later M5 bar, includes costs and never uses the signal bar extremes", () => {
  const result = simulate([signal()], safeBars(), zeroSpread, miniSession);
  assert.equal(result.closedTrades, 1);
  const trade = result.trades[0];
  assert.equal(trade.entryTime, iso(start + FIVE));
  assert.equal(trade.entryPrice, 4000.5);
  assert.equal(trade.exitReason, "target");
  assert.equal(trade.netUsdPerOunce, 3.3);
  assert.equal(result.accountReturnPct, null);
  assert.equal(result.annualizedSharpe, null);
});

test("same-bar stop/target ambiguity is charged stop-first, not an optimistic win", () => {
  const data = safeBars();
  data[2].low = 3996;
  data[2].high = 4006;
  const trade = simulate([signal()], data, zeroSpread, miniSession).trades[0];
  assert.equal(trade.exitReason, "stop");
  assert.equal(trade.exitPrice, 3998);
  assert.equal(trade.netUsdPerOunce, -2.7);
  assert.equal(trade.ambiguous, true);
});

test("a gap through the stop fills at the worse open, not at the stale stop price", () => {
  const data = safeBars();
  Object.assign(data[2], { open: 3994, high: 3996, low: 3993, close: 3995 });
  const trade = simulate([signal()], data, zeroSpread, miniSession).trades[0];
  assert.equal(trade.exitReason, "stop_gap");
  assert.equal(trade.exitPrice, 3994);
  assert.equal(trade.netUsdPerOunce, -6.7);
});

test("an intrabar entry receives no same-bar take-profit credit", () => {
  const data = safeBars();
  Object.assign(data[1], { open: 4003, high: 4005, low: 4000, close: 4001 });
  for (const bar of data.slice(2))
    Object.assign(bar, { open: 4001, high: 4002, low: 4000, close: 4001 });
  const trade = simulate([signal()], data, zeroSpread, miniSession).trades[0];
  assert.equal(trade.entryIntrabar, true);
  assert.equal(trade.exitReason, "session_end");
  assert.equal(trade.netUsdPerOunce, -0.2);
});

test("short positions sell bid and exit ask under the assumed spread", () => {
  const p = plan({ stopLoss: "4003", takeProfitLevels: "3996" });
  p.researcher.direction = "Sell";
  const data = bars([
    [4000, 4001, 3999, 4000],
    [4001, 4001.5, 4000, 4000],
    [3996, 3997, 3995, 3995.5],
    [3996, 3997, 3995, 3996],
    [3996, 3997, 3995, 3996],
    [3996, 3997, 3995, 3996],
  ]);
  const trade = simulate(
    [signal(start, p, "Sell")],
    data,
    COSTS[1],
    miniSession,
  ).trades[0];
  assert.equal(trade.entryPrice, 4000.5);
  assert.equal(trade.exitPrice, 3996);
  assert.equal(trade.netUsdPerOunce, 4.3);
});

test("unfilled plans expire and a stopped/invalidated zone is not assumed filled", () => {
  const data = safeBars();
  for (const bar of data.slice(1))
    Object.assign(bar, { open: 3995, high: 3997, low: 3993, close: 3996 });
  const result = simulate([signal()], data, zeroSpread, miniSession);
  assert.equal(result.closedTrades, 0);
  assert.equal(result.events[0].event, "cancelled_before_entry");
  assert.equal(result.winRatePct, null);
  assert.equal(result.profitFactor, null);
});

test("one-position constraint and higher slippage are explicit, without resizing an account", () => {
  const data = safeBars();
  for (const bar of data.slice(2))
    Object.assign(bar, { open: 4001, high: 4002, low: 4000, close: 4001 });
  const decisions = [signal(), signal(start + FIFTEEN, plan(), "Buy", 2)];
  const first = simulate(
    decisions,
    data,
    { id: "one", spreadUsd: 0, slippagePerFillUsd: 0 },
    miniSession,
  );
  const second = simulate(
    decisions,
    data,
    { id: "two", spreadUsd: 0, slippagePerFillUsd: 0.2 },
    miniSession,
  );
  assert.equal(first.closedTrades, 1);
  assert.equal(
    first.events.some((row) => row.event === "ignored_while_position_open"),
    true,
  );
  assert.equal(
    Number((first.netUsdPerOunce - second.netUsdPerOunce).toFixed(6)),
    0.4,
  );
  assert.equal(second.trades[0].simulatedOunces, 1);
  assert.equal(second.openPositionsAtEnd, 0);
});

test("CSV exports neutralize formula-like AI text without corrupting numeric losses", () => {
  assert.equal(csvCell(-2.5), "-2.5");
  assert.match(csvCell('=HYPERLINK("x")'), /^"'/);
  assert.match(csvCell("@SUM(A1)"), /^"'/);
});
