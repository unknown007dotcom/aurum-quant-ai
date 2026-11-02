const { FIVE, FIFTEEN, SESSION } = require("./point-in-time.cjs");
const round = (n) => (Number.isFinite(n) ? Number(n.toFixed(6)) : null);
const COSTS = Object.freeze([
  { id: "low_cost", spreadUsd: 0.5, slippagePerFillUsd: 0 },
  { id: "base", spreadUsd: 1.0, slippagePerFillUsd: 0.1 },
  { id: "stress", spreadUsd: 2.0, slippagePerFillUsd: 0.2 },
]);
function priceNumbers(text, reference) {
  if (typeof text !== "string" || !Number.isFinite(reference) || reference <= 0)
    return [];
  const matches =
    text
      .replace(/\bTP\s*\d+\b/gi, "target")
      .match(/(?<![\w.])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\w.])/g) || [];
  return [
    ...new Set(
      matches
        .map((value) => Number(value.replaceAll(",", "")))
        .filter(
          (value) =>
            Number.isFinite(value) &&
            value >= reference * 0.5 &&
            value <= reference * 1.5,
        ),
    ),
  ];
}
function classifyPlan(plan, ruleDirection, reference) {
  const direction = plan?.researcher?.direction;
  if (direction === "Stay Flat")
    return { category: "stay_flat", direction, reason: "AI chose Stay Flat" };
  if (!["Buy", "Sell"].includes(direction))
    return { category: "unexecutable", reason: "Invalid final AI direction" };
  if (["Buy", "Sell"].includes(ruleDirection) && direction !== ruleDirection)
    return {
      category: "conflict_flat",
      direction: "Stay Flat",
      aiDirection: direction,
      reason: "The current main-page rule/AI conflict guard forces Stay Flat",
    };
  const trader = plan.trader || {};
  const entryText = String(trader.entryZone || "").replace(/[*`]/g, "");
  const narrative = String(plan.researcher.summary || "").replace(
    /no (?:further )?confirmation (?:is )?required/gi,
    "",
  );
  const conditional =
    /\b(?:confirm\w*|bos|choch|rejection|reject(?:ed|s)?|breakout|breakdown|candle\s+close|closed?\s+(?:above|below)|hold(?:s|ing)?\s+(?:above|below))\b/i.test(
      entryText,
    ) ||
    /\b(?:wait|await|only enter|enter only)\b.{0,90}\b(?:confirm\w*|bos|choch|candle\s+close)\b/i.test(
      narrative,
    );
  if (conditional)
    return {
      category: "unexecutable",
      aiDirection: direction,
      reason:
        "Additional non-price entry confirmation is not machine-defined; no assumption of confirmation",
    };
  const entry = priceNumbers(entryText, reference),
    stops = priceNumbers(trader.stopLoss, reference),
    targets = priceNumbers(trader.takeProfitLevels, reference);
  if (
    entry.length < 1 ||
    entry.length > 2 ||
    stops.length !== 1 ||
    targets.length < 1
  )
    return {
      category: "unexecutable",
      aiDirection: direction,
      reason:
        "Entry/stop/target prices are missing, ambiguous or outside the declared parsing bounds",
    };
  const low = Math.min(...entry),
    high = Math.max(...entry),
    stop = stops[0];
  if (high - low > reference * 0.05)
    return {
      category: "unexecutable",
      aiDirection: direction,
      reason: "Entry range is too wide to interpret as an intraday zone",
    };
  const side = direction === "Buy" ? 1 : -1;
  if (
    (side === 1 && stop >= low) ||
    (side === -1 && stop <= high) ||
    targets.some((target) => (side === 1 ? target <= high : target >= low))
  )
    return {
      category: "unexecutable",
      aiDirection: direction,
      reason: "Directional stop/target geometry contradicts the entry zone",
    };
  if (targets.some((target, i) => i && (target - targets[i - 1]) * side <= 0))
    return {
      category: "unexecutable",
      aiDirection: direction,
      reason: "Targets are not unambiguously ordered from nearer to farther",
    };
  if (/±|approximately|around|roughly/i.test(entryText))
    return {
      category: "unexecutable",
      aiDirection: direction,
      reason:
        "Vague/arithmetic entry instructions require a separate execution definition",
    };
  return {
    category: "executable",
    direction,
    side,
    entryLow: low,
    entryHigh: high,
    stop,
    targets,
    reason:
      "Explicit price-level plan; fixed paper execution assumptions apply",
  };
}

function stats(trades, curve) {
  const net = trades.map((trade) => trade.netUsdPerOunce);
  const grossProfit = net.filter((n) => n > 0).reduce((sum, n) => sum + n, 0);
  const grossLoss = -net.filter((n) => n < 0).reduce((sum, n) => sum + n, 0);
  let peak = 0,
    drawdown = 0;
  for (const point of curve) {
    peak = Math.max(peak, point.netPnl);
    drawdown = Math.max(drawdown, peak - point.netPnl);
  }
  const wins = net.filter((n) => n > 0).length,
    losses = net.filter((n) => n < 0).length;
  return {
    closedTrades: trades.length,
    wins,
    losses,
    breakeven: trades.length - wins - losses,
    winRatePct: trades.length ? round((wins / trades.length) * 100) : null,
    netUsdPerOunce: round(net.reduce((sum, n) => sum + n, 0)),
    grossPricePnlUsdPerOunce: round(
      trades.reduce((sum, trade) => sum + trade.grossPricePnl, 0),
    ),
    assumedSlippageUsd: round(
      trades.reduce((sum, trade) => sum + trade.slippageCost, 0),
    ),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : null,
    profitFactorNote: !trades.length
      ? "No trades"
      : grossLoss === 0
        ? "No net losing trades; ratio not estimable from this sample"
        : null,
    expectancyUsdPerTrade: trades.length
      ? round(net.reduce((sum, n) => sum + n, 0) / trades.length)
      : null,
    sumNetR: trades.length
      ? round(trades.reduce((sum, trade) => sum + trade.netR, 0))
      : null,
    maxDrawdownUsdPerOunce: round(drawdown),
    drawdownBasis:
      "M5 close-to-close marked-to-market plus realized P/L; not intrabar maximum and not an account percentage",
    annualizedSharpe: null,
    accountReturnPct: null,
    ambiguousTrades: trades.filter((trade) => trade.ambiguous).length,
  };
}
function simulate(
  decisions,
  bars,
  cost = COSTS[1],
  session = SESSION,
  targetIndex = 0,
) {
  const start = Date.parse(session.start),
    end = Date.parse(session.end);
  const byTime = new Map(
    decisions.map((decision) => [Date.parse(decision.asOf), decision]),
  );
  const trades = [],
    curve = [],
    events = [];
  let position = null,
    pending = null,
    realized = 0;
  const half = cost.spreadUsd / 2;
  const quote = (bar, side, field, entry) =>
    bar[field] + (entry ? side : -side) * half;
  const close = (price, time, reason, ambiguous = false) => {
    const grossPricePnl = (price - position.entryPrice) * position.side;
    const slippageCost = 2 * cost.slippagePerFillUsd;
    const net = grossPricePnl - slippageCost;
    const trade = {
      id: `paper-${trades.length + 1}`,
      decisionIndex: position.decisionIndex,
      decisionAt: position.decisionAt,
      direction: position.side === 1 ? "Buy" : "Sell",
      entryTime: position.entryTime,
      entryPrice: round(position.entryPrice),
      stop: position.stop,
      target: position.target,
      exitTime: new Date(time).toISOString(),
      exitPrice: round(price),
      exitReason: reason,
      grossPricePnl: round(grossPricePnl),
      slippageCost: round(slippageCost),
      netUsdPerOunce: round(net),
      initialPriceRisk: round(position.initialPriceRisk),
      netR: round(net / position.initialPriceRisk),
      ambiguous: ambiguous || position.entryIntrabar,
      entryIntrabar: position.entryIntrabar,
      simulatedOunces: 1,
    };
    trades.push(trade);
    realized += net;
    position = null;
  };
  const sessionBars = bars
    .filter((bar) => bar.time >= start && bar.time + FIVE <= end)
    .sort((a, b) => a.time - b.time);
  for (const bar of sessionBars) {
    const signal = byTime.get(bar.time);
    if (signal) {
      if (pending)
        events.push({
          decisionIndex: pending.decisionIndex,
          event: "unfilled_plan_expired",
          at: new Date(bar.time).toISOString(),
        });
      pending = null;
      if (signal.execution?.category === "executable") {
        if (position)
          events.push({
            decisionIndex: signal.index,
            event: "ignored_while_position_open",
            at: signal.asOf,
          });
        else
          pending = {
            ...signal.execution,
            decisionIndex: signal.index,
            decisionAt: signal.asOf,
            eligible: bar.time + FIVE,
            expires: Math.min(bar.time + FIFTEEN, end),
            target:
              signal.execution.targets[
                Math.min(targetIndex, signal.execution.targets.length - 1)
              ],
          };
      }
    }
    if (pending && bar.time >= pending.expires) {
      events.push({
        decisionIndex: pending.decisionIndex,
        event: "unfilled_plan_expired",
        at: new Date(bar.time).toISOString(),
      });
      pending = null;
    }
    if (!position && pending && bar.time >= pending.eligible) {
      const p = pending,
        entryOpen = quote(bar, p.side, "open", true),
        exitOpen = quote(bar, p.side, "open", false);
      const stopInvalid =
        p.side === 1 ? exitOpen <= p.stop : exitOpen >= p.stop;
      const targetPassed =
        p.side === 1 ? exitOpen >= p.target : exitOpen <= p.target;
      if (stopInvalid || targetPassed) {
        events.push({
          decisionIndex: p.decisionIndex,
          event: "cancelled_before_entry",
          at: new Date(bar.time).toISOString(),
        });
        pending = null;
      } else {
        const low = quote(bar, p.side, "low", true),
          high = quote(bar, p.side, "high", true);
        const inZone = entryOpen >= p.entryLow && entryOpen <= p.entryHigh;
        const touched = high >= p.entryLow && low <= p.entryHigh;
        if (touched) {
          // Intrabar entry uses the adverse edge of the observed overlap.
          const price = inZone
            ? entryOpen
            : p.side === 1
              ? Math.min(p.entryHigh, high)
              : Math.max(p.entryLow, low);
          if (
            (price - p.stop) * p.side > 0 &&
            (p.target - price) * p.side > 0
          ) {
            position = {
              ...p,
              entryPrice: price,
              entryTime: new Date(bar.time).toISOString(),
              initialPriceRisk: Math.abs(price - p.stop),
              entryIntrabar: !inZone,
            };
            pending = null;
          }
        }
      }
    }
    if (position) {
      const p = position,
        open = quote(bar, p.side, "open", false),
        low = quote(bar, p.side, "low", false),
        high = quote(bar, p.side, "high", false);
      const sameEntryBar = p.entryTime === new Date(bar.time).toISOString();
      const stopHit = p.side === 1 ? low <= p.stop : high >= p.stop;
      const targetHit = p.side === 1 ? high >= p.target : low <= p.target;
      const gapStop =
        !sameEntryBar && (p.side === 1 ? open <= p.stop : open >= p.stop);
      if (gapStop) close(open, bar.time, "stop_gap");
      else if (stopHit)
        close(
          p.stop,
          bar.time + FIVE,
          "stop",
          targetHit || (sameEntryBar && p.entryIntrabar),
        );
      else if (targetHit && !(sameEntryBar && p.entryIntrabar))
        close(p.target, bar.time + FIVE, "target");
      // A target touch before an intrabar entry cannot be assumed to be a win.
      else if (bar.time + FIVE === end)
        close(quote(bar, p.side, "close", false), end, "session_end");
    }
    const unrealized = position
      ? (quote(bar, position.side, "close", false) - position.entryPrice) *
          position.side -
        2 * cost.slippagePerFillUsd
      : 0;
    curve.push({
      time: new Date(bar.time + FIVE).toISOString(),
      netPnl: round(realized + unrealized),
    });
  }
  if (pending)
    events.push({
      decisionIndex: pending.decisionIndex,
      event: "unfilled_plan_expired",
      at: session.end,
    });
  return {
    assumptions: {
      ...cost,
      target:
        targetIndex === 0
          ? "first supplied target, full position"
          : "last supplied target, full position",
      units: "one hypothetical ounce-equivalent",
      delayMinutes: 5,
      pendingExpiryMinutes: 15,
      singlePosition: true,
      bothBarriersInSameBar: "stop first",
      intrabarEntry:
        "adverse overlap price; no same-bar target credit; stop touches counted conservatively",
      commissionAndFinancing:
        "No separate commission; positions forcibly closed before the NY 17:00 rollover. Actual broker charges are not verified.",
    },
    ...stats(trades, curve),
    trades,
    curve,
    events,
    openPositionsAtEnd: position ? 1 : 0,
  };
}
module.exports = { COSTS, priceNumbers, classifyPlan, simulate };
