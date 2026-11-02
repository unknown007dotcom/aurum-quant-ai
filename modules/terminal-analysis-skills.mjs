// Selected analytical workflows adapted from AGIPro's MIT-licensed trading skills.
// Copyright (c) 2026 AGIPro. License: /assets/licenses/claude-trading-skills-MIT.txt
// Pure, bounded arithmetic: no network, Python execution, orders, or account access.
export const SKILLS_SOURCE = Object.freeze({
  repository: "agiprolabs/claude-trading-skills",
  revision: "981e1d736cdc02bdc1c55c74ec9224e956414706",
  url: "https://github.com/agiprolabs/claude-trading-skills/tree/981e1d736cdc02bdc1c55c74ec9224e956414706",
});
export const SKILL_IDS = Object.freeze([
  "ohlcv-processing",
  "volatility-modeling",
  "position-sizing",
  "risk-management",
  "walk-forward-validation",
]);
export const MAX_SKILL_CANDLES = 256;
export const MAX_SKILL_PROMPT_CHARS = 2200;
const FRAMES = Object.freeze({
  "1min": 60000,
  "5min": 300000,
  "15min": 900000,
  "1h": 3600000,
  "4h": 14400000,
  "1day": 86400000,
  "1week": 604800000,
});
const VALIDATION_NOTE =
  "Not run: a candle snapshot is not a backtest. Strategy rules, sufficient history, spread/slippage assumptions and out-of-sample outcomes are required. No win rate or profitability estimate is available.";
const round = (value, digits = 6) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
function positive(value, max = 1e9) {
  if (
    !["number", "string"].includes(typeof value) ||
    (typeof value === "string" && (!value.trim() || value.length > 40))
  )
    return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= max ? number : null;
}
function timestamp(value) {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)
  )
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}
function symbol(value) {
  if (typeof value !== "string" || value.length > 30) return "";
  return value.toUpperCase().replace(/[\s/_-]/g, "");
}
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}
function unavailable(code = "unavailable") {
  return {
    version: 1,
    researchOnly: true,
    status: "unavailable",
    reason: code,
    source: SKILLS_SOURCE,
    skillIds: [...SKILL_IDS],
    usedInPrompt: false,
    quality: null,
    volatility: null,
    risk: null,
    sizing: null,
    validation: { status: "not_run", note: VALIDATION_NOTE },
  };
}

// Take a recent bounded window without changing the original feed or silently
// repairing/replacing its candles. Both ascending and descending APIs are supported.
export function buildTerminalSkillInput(analysis, mtfData, options = {}) {
  const entry = mtfData?.data?.find((item) => item?.id === "entry");
  const all = Array.isArray(entry?.values) ? entry.values : [];
  const first = timestamp(all[0]?.datetime || all[0]?.time);
  const last = timestamp(all.at(-1)?.datetime || all.at(-1)?.time);
  const window =
    first !== null && last !== null && first > last
      ? all.slice(0, MAX_SKILL_CANDLES)
      : all.slice(-MAX_SKILL_CANDLES);
  const scalar = (value) =>
    ["number", "string"].includes(typeof value) && String(value).length <= 64
      ? value
      : null;
  const decision = analysis?.decision || {};
  return {
    version: 1,
    enabled: true,
    instrument:
      typeof options.instrument === "string"
        ? options.instrument.slice(0, 30)
        : "XAU_USD",
    sourceInstrument:
      typeof entry?.symbolUsed === "string"
        ? entry.symbolUsed.slice(0, 30)
        : null,
    timeframe: options.timeframe || "15min",
    candles: window.map((row) => ({
      time: scalar(row?.datetime || row?.time),
      open: scalar(row?.open),
      high: scalar(row?.high),
      low: scalar(row?.low),
      close: scalar(row?.close),
      complete: typeof row?.complete === "boolean" ? row.complete : null,
    })),
    baseline: {
      direction: ["buy", "sell"].includes(
        String(decision.action || "").toLowerCase(),
      )
        ? String(decision.action).toLowerCase()
        : "flat",
      entry: positive(analysis?.price),
      stop: positive(decision.stopPrice),
      targets: [decision.tp1, decision.tp2]
        .filter(
          (value) => value !== undefined && value !== null && value !== "",
        )
        .map((value) => scalar(value)),
    },
    riskBudgetUsd: positive(options.riskBudgetUsd, 1e7),
  };
}

export function evaluateTerminalSkills(input, now = Date.now()) {
  try {
    if (!input || input.enabled !== true) return null;
    if (
      input.version !== 1 ||
      !Array.isArray(input.candles) ||
      input.candles.length > MAX_SKILL_CANDLES
    )
      return unavailable("invalid_or_oversized_context");
    if (
      symbol(input.instrument) !== "XAUUSD" ||
      (input.sourceInstrument && symbol(input.sourceInstrument) !== "XAUUSD")
    )
      return unavailable("unsupported_or_mismatched_instrument");
    if (!Object.hasOwn(FRAMES, input.timeframe) || !Number.isFinite(now))
      return unavailable("unsupported_timeframe");
    const quality = {
      submitted: input.candles.length,
      usable: 0,
      invalid: 0,
      incomplete: 0,
      duplicates: 0,
      future: 0,
      inputOrder: "unknown",
      gaps: 0,
      largestGapMinutes: 0,
      requestedTimeframe: input.timeframe,
      observedIntervalMinutes: null,
      timeframeMismatch: false,
      lastCandleAt: null,
      lastCloseAt: null,
      ageSeconds: null,
      freshness: "unknown",
      issues: [],
    };
    const rows = [];
    for (const row of input.candles) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        quality.invalid++;
        continue;
      }
      if (
        row.complete !== undefined &&
        row.complete !== null &&
        typeof row.complete !== "boolean"
      ) {
        quality.invalid++;
        continue;
      }
      if (row.complete === false) {
        quality.incomplete++;
        continue;
      }
      const time = timestamp(row.time);
      const open = positive(row.open),
        high = positive(row.high),
        low = positive(row.low),
        close = positive(row.close);
      if (
        time === null ||
        !open ||
        !high ||
        !low ||
        !close ||
        high < Math.max(open, close, low) ||
        low > Math.min(open, close, high)
      ) {
        quality.invalid++;
        continue;
      }
      if (time > now + 5000) {
        quality.future++;
        continue;
      }
      rows.push({ time, open, high, low, close });
    }
    let ascending = false,
      descending = false;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].time > rows[i - 1].time) ascending = true;
      if (rows[i].time < rows[i - 1].time) descending = true;
    }
    quality.inputOrder =
      ascending && descending
        ? "mixed"
        : ascending
          ? "ascending"
          : descending
            ? "descending"
            : "unknown";
    // Duplicate timestamps are excluded, not averaged into a fabricated bar.
    const counts = new Map();
    rows.forEach((row) =>
      counts.set(row.time, (counts.get(row.time) || 0) + 1),
    );
    const unique = rows
      .filter((row) => {
        if (counts.get(row.time) !== 1) {
          quality.duplicates++;
          return false;
        }
        return true;
      })
      .sort((a, b) => a.time - b.time);
    const deltas = unique.slice(1).map((row, i) => row.time - unique[i].time);
    const observed = deltas.length >= 5 ? median(deltas) : null;
    const expected = FRAMES[input.timeframe];
    // Infer only recognized fixed cadences; never infer a trading calendar.
    const cadence =
      observed &&
      Object.values(FRAMES).find(
        (value) => Math.abs(value - observed) < value * 0.05,
      );
    const interval = cadence || expected;
    quality.observedIntervalMinutes = observed
      ? round(observed / 60000, 2)
      : null;
    quality.timeframeMismatch = Boolean(
      observed && Math.abs(observed - expected) > expected * 0.1,
    );
    const completed = unique.filter((row) => {
      if (row.time + interval > now + 5000) {
        quality.incomplete++;
        return false;
      }
      return true;
    });
    quality.usable = completed.length;
    for (let i = 1; i < completed.length; i++) {
      const gap = completed[i].time - completed[i - 1].time;
      if (gap > interval * 1.5) {
        quality.gaps++;
        quality.largestGapMinutes = Math.max(
          quality.largestGapMinutes,
          round(gap / 60000, 2),
        );
      }
    }
    if (completed.length) {
      const last = completed.at(-1);
      quality.lastCandleAt = new Date(last.time).toISOString();
      quality.lastCloseAt = new Date(last.time + interval).toISOString();
      quality.ageSeconds = Math.max(
        0,
        Math.floor((now - last.time - interval) / 1000),
      );
      quality.freshness = quality.timeframeMismatch
        ? "unverified_timeframe"
        : quality.ageSeconds * 1000 > interval * 3
          ? "stale"
          : "recent_candles";
    }
    if (!input.sourceInstrument)
      quality.issues.push(
        "The feed did not tag its instrument; XAU/USD is only the request's declared instrument.",
      );
    if (!completed.length)
      quality.issues.push(
        "No usable completed candles in this submitted window.",
      );
    if (quality.invalid)
      quality.issues.push(
        "Invalid OHLC or missing/ambiguous timezone timestamps were excluded.",
      );
    if (quality.duplicates)
      quality.issues.push(
        "Duplicate timestamps were excluded rather than merged.",
      );
    if (quality.future)
      quality.issues.push("Future-dated candles were excluded.");
    if (quality.inputOrder === "mixed")
      quality.issues.push(
        "Mixed input order was sorted for calculations; source order needs review.",
      );
    if (quality.timeframeMismatch)
      quality.issues.push(
        "Observed candle cadence differs from the selected timeframe; verify the feed mapping.",
      );
    if (quality.gaps)
      quality.issues.push(
        "Time gaps exist; sessions/weekends may explain them. No candles were filled or resampled.",
      );
    if (quality.freshness === "stale")
      quality.issues.push(
        "Old candle snapshot: a closure or stale feed may explain it. This is not a live-quote check.",
      );

    const ranges = completed
      .slice(1)
      .map((row, i) =>
        Math.max(
          row.high - row.low,
          Math.abs(row.high - completed[i].close),
          Math.abs(row.low - completed[i].close),
        ),
      );
    let atr = null;
    if (ranges.length >= 14) {
      atr = ranges.slice(0, 14).reduce((sum, value) => sum + value, 0) / 14;
      for (const value of ranges.slice(14)) atr = (atr * 13 + value) / 14;
    }
    const recentRange =
      ranges.length >= 28
        ? ranges.slice(-14).reduce((sum, value) => sum + value, 0) / 14
        : null;
    const precedingRange =
      ranges.length >= 28
        ? ranges.slice(-28, -14).reduce((sum, value) => sum + value, 0) / 14
        : null;
    const volatility = {
      method: "Wilder ATR(14), completed bars",
      atr14: round(atr),
      atrPercent:
        atr !== null && completed.length
          ? round((atr / completed.at(-1).close) * 100, 4)
          : null,
      rangeExpansionRatio:
        precedingRange > 0 ? round(recentRange / precedingRange, 3) : null,
      note: "Descriptive volatility, not direction or a GARCH forecast. No crypto-style 365-day annualization.",
    };
    const baseline =
      input.baseline && typeof input.baseline === "object"
        ? input.baseline
        : {};
    const direction = ["buy", "sell"].includes(baseline.direction)
      ? baseline.direction
      : "flat";
    const entry = positive(baseline.entry),
      stop = positive(baseline.stop);
    const targets = Array.isArray(baseline.targets)
      ? baseline.targets.slice(0, 2).map((value) => positive(value))
      : [];
    const side = direction === "buy" ? 1 : -1;
    const riskPerUnit = entry && stop ? (entry - stop) * side : null;
    const validTargets =
      targets.length > 0 &&
      targets.every((target) => target && (target - entry) * side > 0);
    const riskValid =
      direction !== "flat" &&
      entry &&
      stop &&
      riskPerUnit >= 0.000001 &&
      validTargets;
    const risk = {
      basis: "Rule-engine reference levels, not the final AI plan",
      direction,
      entry,
      stop,
      targets,
      status:
        direction === "flat"
          ? "flat"
          : riskValid
            ? "arithmetic_only"
            : "invalid_reference_levels",
      perUnitUsd: riskValid ? round(riskPerUnit) : null,
      grossRewardRisk: riskValid
        ? targets.map((target) =>
            round(Math.abs(target - entry) / riskPerUnit, 3),
          )
        : [],
      note: "Gross R/R excludes spread, slippage, financing and execution constraints. It is not trade approval.",
    };
    const riskBudgetUsd = positive(input.riskBudgetUsd, 1e7);
    const rawSize =
      riskValid && riskBudgetUsd ? riskBudgetUsd / riskPerUnit : null;
    const sizeEstimate =
      rawSize > 0 && rawSize <= 1e9 ? Math.floor(rawSize * 1000) / 1000 : null;
    const sizing = {
      status: !riskValid
        ? "unavailable"
        : !riskBudgetUsd
          ? "needs_risk_budget"
          : sizeEstimate > 0
            ? "hypothetical"
            : "unavailable",
      riskBudgetUsd,
      ouncesEstimate: sizeEstimate > 0 ? sizeEstimate : null,
      note: "User-supplied USD risk budget only. No account equity, broker lot precision, margin, costs or order permission was verified.",
    };
    return {
      version: 1,
      researchOnly: true,
      status: quality.issues.length ? "caution" : "computed",
      source: SKILLS_SOURCE,
      skillIds: [...SKILL_IDS],
      evaluatedAt: new Date(now).toISOString(),
      usedInPrompt: false,
      quality,
      volatility,
      risk,
      sizing,
      validation: { status: "not_run", note: VALIDATION_NOTE },
    };
  } catch {
    return unavailable("checks_unavailable");
  }
}

export function terminalSkillsPrompt(review) {
  if (!review || review.status === "unavailable" || !review.quality?.usable)
    return "";
  const q = review.quality;
  const facts = {
    basis:
      "Bounded submitted XAU/USD candle window; not independent verification of its provider",
    timeframe: q.requestedTimeframe,
    observedMinutes: q.observedIntervalMinutes,
    bars: q.usable,
    excluded: q.invalid + q.duplicates + q.future + q.incomplete,
    mixedOrder: q.inputOrder === "mixed",
    timeframeMismatch: q.timeframeMismatch,
    gaps: q.gaps,
    candleCloseAt: q.lastCloseAt,
    freshness: q.freshness,
    atr14: review.volatility.atr14,
    atrPercent: review.volatility.atrPercent,
    rangeExpansion: review.volatility.rangeExpansionRatio,
    referencePlan: review.risk.status,
    riskUsdPerOunce: review.risk.perUnitUsd,
    grossRR: review.risk.grossRewardRisk,
    manualRiskBudgetUsd: review.sizing.riskBudgetUsd,
    hypotheticalOunces: review.sizing.ouncesEstimate,
    validation: "Backtest/walk-forward NOT RUN",
  };
  const text = [
    "TERMINAL ANALYSIS SKILLS — selected, adapted research checks (not trade approval).",
    JSON.stringify(facts),
    "Use these calculated checks alongside the primary evidence. Flag invalid/stale/mismatched data and missing costs. Session gaps may be legitimate; no gap filling was performed. ATR describes volatility, not a directional forecast. R/R is gross and uses the rule-engine reference plan. Sizing is hypothetical and only uses the supplied risk budget, never a broker balance or a default demo account. Do not claim a backtest, trained strategy, win rate or profitability from this snapshot. Keep the existing response JSON schema.",
  ].join("\n");
  return text.length <= MAX_SKILL_PROMPT_CHARS ? text : "";
}
